"""DedupPort — thin interface adapter over ``app.agent.dedup``.

The ``app.agent.dedup`` module contains the production deduplication logic
for Alertmanager alerts.  Rather than reimplementing or monkey-patching it,
Phase 3 wraps it behind a ``DedupPort`` protocol so:

  1. ``AutoTriageService`` depends on the protocol, not the concrete module
     (Dependency Inversion — easier testing).
  2. The existing ``webhooks.py`` inline calls remain untouched and can be
     migrated incrementally.
  3. The adapter is a trivial pass-through — no logic lives here.

Usage::

    from harness.triage.dedup_adapter import OrcaDedupAdapter
    dedup = OrcaDedupAdapter()
    fingerprint = await dedup.compute_fingerprint("HighLatency", {"service": "checkout"})
"""

from __future__ import annotations

from typing import Any, Protocol, runtime_checkable

from sqlalchemy.ext.asyncio import AsyncSession


@runtime_checkable
class DedupPort(Protocol):
    """Protocol for alert deduplication operations.

    Any object that implements these three async methods can be used as a
    dedup backend by ``AutoTriageService``.
    """

    async def compute_fingerprint(
        self,
        alert_name: str,
        labels: dict[str, str],
    ) -> str:
        """Return a stable SHA-256 fingerprint for the alert.

        Args:
            alert_name: Value of the ``alertname`` label.
            labels: Full label set for the alert.

        Returns:
            64-character lowercase hex digest.
        """
        ...

    async def find_canonical(
        self,
        fingerprint: str,
        db: AsyncSession,
    ) -> str | None:
        """Return the RCA ID of an existing canonical investigation, or None.

        Args:
            fingerprint: SHA-256 fingerprint from ``compute_fingerprint``.
            db: Async database session.

        Returns:
            RCA UUID string if a canonical investigation exists, else ``None``.
        """
        ...

    async def record_duplicate(
        self,
        canonical_rca_id: str,
        alert_id: Any,
        db: AsyncSession,
    ) -> None:
        """Record a duplicate alert against the canonical RCA.

        Args:
            canonical_rca_id: UUID of the canonical RCA.
            alert_id: UUID of the duplicate alert.
            db: Async database session.
        """
        ...


class OrcaDedupAdapter:
    """Adapter wrapping ``app.agent.dedup`` behind the ``DedupPort`` interface.

    Imports the dedup module lazily to avoid import-time side-effects in tests.
    All methods are thin delegations — no logic is added here.
    """

    async def compute_fingerprint(
        self,
        alert_name: str,
        labels: dict[str, str],
    ) -> str:
        """Delegate to ``app.agent.dedup.compute_fingerprint``.

        Args:
            alert_name: Alert name.
            labels: Full label dict.

        Returns:
            64-char hex fingerprint string.
        """
        from app.agent.dedup import compute_fingerprint  # lazy import

        return compute_fingerprint(alert_name, labels)

    async def find_canonical(
        self,
        fingerprint: str,
        db: AsyncSession,
    ) -> str | None:
        """Delegate to ``app.agent.dedup.find_canonical_rca``.

        Args:
            fingerprint: SHA-256 alert fingerprint.
            db: Async database session.

        Returns:
            RCA ID string if a canonical RCA exists, else ``None``.
        """
        from app.agent.dedup import find_canonical_rca  # lazy import

        rca = await find_canonical_rca(db, fingerprint)
        return str(rca.id) if rca is not None else None

    async def record_duplicate(
        self,
        canonical_rca_id: str,
        alert_id: Any,
        db: AsyncSession,
    ) -> None:
        """Delegate to ``app.agent.dedup.record_duplicate``.

        Args:
            canonical_rca_id: UUID of the canonical RCA.
            alert_id: UUID of the duplicate alert.
            db: Async database session.
        """
        import uuid as uuid_module
        from app.agent.dedup import record_duplicate  # lazy import

        canonical_uuid = uuid_module.UUID(canonical_rca_id) if isinstance(canonical_rca_id, str) else canonical_rca_id
        await record_duplicate(
            session=db,
            canonical_rca_id=canonical_uuid,
            duplicate_alert_id=alert_id,
        )
