"""AutoTriageService — creates and enqueues alert investigation sessions.

When Alertmanager fires an alert the ``AutoTriageService`` is called from
``app/api/webhooks.py`` to:

  1. Check the circuit breaker (reject if OPEN).
  2. Acquire a semaphore slot (reject if at concurrency cap).
  3. Compute the dedup fingerprint via ``DedupPort``.
  4. If a canonical investigation exists: record the alert as a duplicate and
     return without starting a new session.
  5. Otherwise: create an ``rca_sessions`` row tagged with
     ``auth_mode=service_account, initiator_user_id=NULL`` and enqueue the
     first turn via ``TurnWorker``.

The service is constructed once in ``app/main.py`` lifespan and injected into
the webhooks router.
"""

from __future__ import annotations

import uuid
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any

import structlog
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from harness.session.worker import enqueue_turn
from harness.triage.circuit_breaker import CircuitBreaker, CircuitBreakerOpenError
from harness.triage.dedup_adapter import DedupPort

logger = structlog.get_logger()


# ---------------------------------------------------------------------------
# Errors
# ---------------------------------------------------------------------------


class ConcurrencyLimitError(Exception):
    """Raised when the auto-triage concurrency cap is reached."""


def _build_initial_rca_state(
    alert_name: str,
    labels: dict[str, str],
    alert_id: Any,
    org_id: int | None,
) -> dict[str, Any]:
    """Build a complete ``RCAState``-shaped initial turn input for an alert.

    ``harness.session.worker.TurnWorker._execute_turn`` passes this dict
    straight to ``graph.ainvoke(turn_input, ...)`` for a fresh invocation.
    The interactive RCA graph's nodes index required keys directly (e.g.
    ``state["alert_context"]``, ``state["round"]``) rather than via
    ``.get(...)`` with a default, so a partial payload — as previously sent
    here (only ``alert_name``/``labels``/``alert_id``/``org_id`` at the
    top level, with no ``alert_context`` wrapper at all) — raises
    ``KeyError`` on the very first node (see docs/harness-risk-review.md,
    F1). This mirrors the shape ``tests/conftest.py::rca_initial_state``
    and ``app.agent.rca_state.RCAState`` define as the minimal valid state.

    Args:
        alert_name: Alert name (e.g. ``"HighErrorRate"``).
        labels: Full label set for the alert.
        alert_id: UUID of the persisted ``Alert`` row (may be None).
        org_id: Grafana organisation ID for MCP tool scoping.

    Returns:
        A dict matching every key of ``app.agent.rca_state.RCAState``.
    """
    from app.config import settings

    description = (
        labels.get("description")
        or labels.get("summary")
        or f"Alert {alert_name!r} is firing."
    )
    service = labels.get("service") or labels.get("service_name")
    environment = labels.get("environment") or labels.get("deployment_environment_name")

    alert_context: dict[str, Any] = {
        "alert_id": str(alert_id) if alert_id else None,
        "alert_name": alert_name,
        "description": description,
        "service": service,
        "environment": environment,
        "labels": labels,
        "org_id": org_id,
    }

    return {
        "alert_context": alert_context,
        "org_id": org_id,
        "gathered_data": [],
        "past_rcas": [],
        "hypotheses": [],
        "confidence_scores": [],
        "round": 0,
        "developer_accepted": False,
        "max_rounds": settings.ORCA_MAX_ROUNDS,
        "messages": [],
        "pending_question": None,
        "final_report": None,
        "rca_session_id": None,
        "error_message": None,
        "force_finalized": False,
        "tool_call_count": 0,
        "investigation_started_at": None,
    }


# ---------------------------------------------------------------------------
# Result types
# ---------------------------------------------------------------------------


@dataclass
class AutoTriageResult:
    """Result of ``AutoTriageService.handle_alert``.

    Attributes:
        session_id: New session UUID (only set when ``deduplicated=False``).
        canonical_session_id: Existing session UUID (only set when ``deduplicated=True``).
        deduplicated: True if the alert was absorbed by an existing investigation.
        alert_id: UUID of the persisted Alert row (caller may use for linking).
    """

    session_id: str | None = None
    canonical_session_id: str | None = None
    deduplicated: bool = False
    alert_id: str | None = None


# ---------------------------------------------------------------------------
# AutoTriageService
# ---------------------------------------------------------------------------


class AutoTriageService:
    """Orchestrates alert auto-triage with concurrency control and circuit breaking.

    Args:
        dedup: Deduplication port (``OrcaDedupAdapter`` in production).
        max_concurrent: Maximum simultaneous triage sessions (concurrency cap).
        breaker: Circuit breaker instance for datasource-query protection.
    """

    def __init__(
        self,
        dedup: DedupPort,
        max_concurrent: int,
        breaker: CircuitBreaker,
    ) -> None:
        self._dedup = dedup
        self._max_concurrent = max_concurrent
        self._active = 0  # count of in-flight triage operations
        self._breaker = breaker

    async def handle_alert(
        self,
        alert_name: str,
        labels: dict[str, str],
        alert_id: Any,
        db: AsyncSession,
        org_id: int | None = None,
    ) -> AutoTriageResult:
        """Process a firing alert: dedup check → new session → enqueue turn.

        Args:
            alert_name: Name of the alert (e.g. ``"HighErrorRate"``).
            labels: Full label set for the alert.
            alert_id: UUID of the already-persisted ``Alert`` row (passed in
                from the webhook handler which persists alerts unconditionally).
            db: Async database session.
            org_id: Grafana organisation ID (for MCP scoping).

        Returns:
            ``AutoTriageResult`` describing what happened.

        Raises:
            CircuitBreakerOpenError: If the circuit is OPEN.
            ConcurrencyLimitError: If the semaphore cap is reached.
        """
        log = logger.bind(alert_name=alert_name, org_id=org_id)

        # 1. Concurrency cap check — evaluated BEFORE the circuit breaker so that
        # hitting the cap is never counted as a downstream failure.
        if self._active >= self._max_concurrent:
            log.warning("auto_triage_concurrency_limit_reached", active=self._active)
            raise ConcurrencyLimitError(
                "Auto-triage concurrency limit reached; alert will be retried by Alertmanager."
            )

        # 2. Circuit breaker wraps only the actual downstream work.
        # Pass a factory so no coroutine is created until the circuit permits the call.
        return await self._breaker.check_and_call(
            lambda: self._triage_tracked(
                alert_name=alert_name,
                labels=labels,
                alert_id=alert_id,
                db=db,
                org_id=org_id,
                log=log,
            )
        )

    async def _triage_tracked(
        self,
        alert_name: str,
        labels: dict[str, str],
        alert_id: Any,
        db: AsyncSession,
        org_id: int | None,
        log: Any,
    ) -> AutoTriageResult:
        """Increment the active counter, run triage, then decrement in a finally block.

        Args:
            alert_name: Alert name.
            labels: Alert labels.
            alert_id: Persisted alert UUID.
            db: Async database session.
            org_id: Grafana org ID.
            log: Bound structlog logger.

        Returns:
            AutoTriageResult.
        """
        self._active += 1
        try:
            return await self._triage(
                alert_name=alert_name,
                labels=labels,
                alert_id=alert_id,
                db=db,
                org_id=org_id,
                log=log,
            )
        finally:
            self._active -= 1

    async def _triage(
        self,
        alert_name: str,
        labels: dict[str, str],
        alert_id: Any,
        db: AsyncSession,
        org_id: int | None,
        log: Any,
    ) -> AutoTriageResult:
        """Core triage logic: dedup → create session → enqueue turn.

        Args:
            alert_name: Alert name.
            labels: Alert labels.
            alert_id: Persisted alert UUID.
            db: Async database session.
            org_id: Grafana org ID.
            log: Bound structlog logger.

        Returns:
            AutoTriageResult.
        """
        # 2. Dedup check
        fingerprint = await self._dedup.compute_fingerprint(alert_name, labels)
        canonical_id = await self._dedup.find_canonical(fingerprint, db)

        if canonical_id is not None:
            await self._dedup.record_duplicate(
                canonical_rca_id=canonical_id,
                alert_id=alert_id,
                db=db,
            )
            log.info(
                "auto_triage_deduplicated",
                canonical_session_id=canonical_id,
                fingerprint=fingerprint,
            )
            return AutoTriageResult(
                canonical_session_id=canonical_id,
                deduplicated=True,
                alert_id=str(alert_id) if alert_id else None,
            )

        # 3. Create a new investigation session tagged as service-account-initiated
        session_id = str(uuid.uuid4())
        now = datetime.now(timezone.utc)

        await db.execute(
            text("""
                INSERT INTO rca_sessions
                    (id, type, status, auth_mode, initiator_channel,
                     initiator_user_id, created_at, updated_at)
                VALUES
                    (:id, 'investigation', 'pending', 'service_account',
                     'alertmanager', NULL, :now, :now)
            """),
            {"id": session_id, "now": now},
        )

        # Propagate org_id if the column exists (forward-compatible)
        try:
            await db.execute(
                text("UPDATE rca_sessions SET org_id = :oid WHERE id = :id"),
                {"oid": org_id, "id": session_id},
            )
        except Exception as exc:
            # org_id column may not yet exist in older schema versions — expected.
            # Log at debug so genuine DB failures are visible, not silently swallowed.
            log.debug("org_id_column_update_skipped", error=str(exc))

        await db.commit()

        # 4. Enqueue the first turn with a complete RCAState-shaped payload
        # (see _build_initial_rca_state docstring — F1).
        await enqueue_turn(
            session_id=session_id,
            session_type="investigation",
            turn_input=_build_initial_rca_state(
                alert_name=alert_name,
                labels=labels,
                alert_id=alert_id,
                org_id=org_id,
            ),
        )

        log.info(
            "auto_triage_session_created",
            session_id=session_id,
            fingerprint=fingerprint,
        )
        return AutoTriageResult(
            session_id=session_id,
            deduplicated=False,
            alert_id=str(alert_id) if alert_id else None,
        )
