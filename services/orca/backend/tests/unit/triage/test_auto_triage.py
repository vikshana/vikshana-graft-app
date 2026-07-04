"""Tests for harness/triage/auto_triage.py — AutoTriageService."""

from __future__ import annotations

import asyncio
import uuid
from typing import Any
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from harness.triage.auto_triage import AutoTriageResult, AutoTriageService, ConcurrencyLimitError
from harness.triage.circuit_breaker import CircuitBreaker, CircuitBreakerOpenError


# ---------------------------------------------------------------------------
# Fake DedupPort
# ---------------------------------------------------------------------------


class FakeDedup:
    """Controllable fake DedupPort for testing."""

    def __init__(
        self,
        fingerprint: str = "fp-001",
        canonical_id: str | None = None,
    ) -> None:
        self._fingerprint = fingerprint
        self._canonical_id = canonical_id
        self.record_duplicate_calls: list[tuple[str, Any]] = []

    async def compute_fingerprint(self, alert_name: str, labels: dict[str, str]) -> str:
        return self._fingerprint

    async def find_canonical(self, fingerprint: str, db: Any) -> str | None:
        return self._canonical_id

    async def record_duplicate(self, canonical_rca_id: str, alert_id: Any, db: Any) -> None:
        self.record_duplicate_calls.append((canonical_rca_id, alert_id))


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _make_service(
    dedup: FakeDedup | None = None,
    max_concurrent: int = 10,
    threshold: int = 5,
) -> AutoTriageService:
    breaker = CircuitBreaker(threshold=threshold, timeout_s=60)
    return AutoTriageService(
        dedup=dedup or FakeDedup(),
        max_concurrent=max_concurrent,
        breaker=breaker,
    )


def _mock_db() -> AsyncMock:
    db = AsyncMock()
    db.execute = AsyncMock(return_value=MagicMock(fetchone=MagicMock(return_value=None)))
    db.commit = AsyncMock()
    return db


# ---------------------------------------------------------------------------
# Happy path
# ---------------------------------------------------------------------------


class TestAutoTriageHappyPath:
    async def test_new_alert_creates_session_and_enqueues(self):
        """A novel alert creates an rca_sessions row and enqueues a turn."""
        svc = _make_service()
        db = _mock_db()

        with patch("harness.triage.auto_triage.enqueue_turn", new_callable=AsyncMock) as mock_enqueue:
            result = await svc.handle_alert(
                alert_name="HighLatency",
                labels={"service": "checkout"},
                alert_id=uuid.uuid4(),
                db=db,
                org_id=1,
            )

        assert result.deduplicated is False
        assert result.session_id is not None
        mock_enqueue.assert_awaited_once()
        # Assert enqueue called with the session_id
        call_kwargs = mock_enqueue.call_args.kwargs
        assert call_kwargs["session_id"] == result.session_id
        assert call_kwargs["session_type"] == "investigation"

    async def test_new_session_tagged_service_account(self):
        """The INSERT into rca_sessions includes auth_mode=service_account."""
        svc = _make_service()
        db = _mock_db()

        with patch("harness.triage.auto_triage.enqueue_turn", new_callable=AsyncMock):
            await svc.handle_alert("Alert", {}, uuid.uuid4(), db)

        # Check that execute was called with a statement containing 'service_account'
        insert_calls = [
            str(call.args[0]) for call in db.execute.call_args_list
        ]
        assert any("service_account" in stmt for stmt in insert_calls)


class TestAutoTriageDedup:
    async def test_duplicate_alert_is_recorded_not_new_session(self):
        """When a canonical investigation exists, record_duplicate is called and
        no new session is created."""
        canonical_id = str(uuid.uuid4())
        dedup = FakeDedup(canonical_id=canonical_id)
        svc = _make_service(dedup=dedup)
        db = _mock_db()

        with patch("harness.triage.auto_triage.enqueue_turn", new_callable=AsyncMock) as mock_enqueue:
            result = await svc.handle_alert("Alert", {}, uuid.uuid4(), db)

        assert result.deduplicated is True
        assert result.canonical_session_id == canonical_id
        assert result.session_id is None
        mock_enqueue.assert_not_awaited()
        assert len(dedup.record_duplicate_calls) == 1

    async def test_duplicate_result_carries_alert_id(self):
        """The deduplicated result includes the alert_id."""
        alert_id = uuid.uuid4()
        dedup = FakeDedup(canonical_id="canonical-123")
        svc = _make_service(dedup=dedup)
        db = _mock_db()

        result = await svc.handle_alert("Alert", {}, alert_id, db)
        assert result.alert_id == str(alert_id)


# ---------------------------------------------------------------------------
# Concurrency cap
# ---------------------------------------------------------------------------


class TestAutoTriageConcurrencyCap:
    async def test_concurrent_cap_raises_concurrency_limit_error(self):
        """When the active count equals max_concurrent, ConcurrencyLimitError is raised."""
        svc = _make_service(max_concurrent=1)
        db = _mock_db()

        # Simulate one in-flight operation by setting _active directly
        svc._active = 1

        with pytest.raises(ConcurrencyLimitError):
            await svc.handle_alert("Alert", {}, uuid.uuid4(), db)

        svc._active = 0


# ---------------------------------------------------------------------------
# Circuit breaker integration
# ---------------------------------------------------------------------------


class TestAutoTriageCircuitBreaker:
    async def test_open_circuit_raises_circuit_breaker_open_error(self):
        """When the circuit is OPEN, handle_alert raises CircuitBreakerOpenError."""
        breaker = CircuitBreaker(threshold=1, timeout_s=60)
        dedup = FakeDedup()
        svc = AutoTriageService(dedup=dedup, max_concurrent=10, breaker=breaker)

        # Force circuit open by triggering a failure
        db = _mock_db()
        db.execute = AsyncMock(side_effect=RuntimeError("db down"))

        with pytest.raises(RuntimeError):
            await svc.handle_alert("Alert", {}, uuid.uuid4(), db)

        # Now the circuit is open
        db2 = _mock_db()
        with pytest.raises(CircuitBreakerOpenError):
            await svc.handle_alert("Alert2", {}, uuid.uuid4(), db2)

    async def test_successful_triage_does_not_open_circuit(self):
        """Successful triage calls do not increment the failure count."""
        svc = _make_service(threshold=3)
        db = _mock_db()

        with patch("harness.triage.auto_triage.enqueue_turn", new_callable=AsyncMock):
            for _ in range(5):
                await svc.handle_alert("Alert", {}, uuid.uuid4(), db)

        from harness.triage.circuit_breaker import CircuitState
        assert svc._breaker.state == CircuitState.CLOSED
        assert svc._breaker.failure_count == 0
