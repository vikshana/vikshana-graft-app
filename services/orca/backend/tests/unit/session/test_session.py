"""Unit tests for harness/session/registry.py and harness/session/worker.py."""

from __future__ import annotations

import asyncio
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from harness.session.registry import GraphRegistry


# ============================================================================
# GraphRegistry
# ============================================================================


class TestGraphRegistry:
    """Tests for the GraphRegistry session-type → graph factory map."""

    def test_register_and_get(self):
        """Registered factory is called on first get()."""
        registry = GraphRegistry()
        mock_graph = MagicMock()
        registry.register("investigation", lambda: mock_graph)
        result = registry.get("investigation")
        assert result is mock_graph

    def test_get_unknown_type_raises_key_error(self):
        """get() with an unregistered type raises KeyError."""
        registry = GraphRegistry()
        with pytest.raises(KeyError, match="No graph registered"):
            registry.get("unknown_type")

    def test_factory_called_once_then_cached(self):
        """Factory is called exactly once; subsequent gets use the cache."""
        registry = GraphRegistry()
        call_count = 0

        def factory():
            nonlocal call_count
            call_count += 1
            return MagicMock()

        registry.register("test", factory)
        registry.get("test")
        registry.get("test")
        registry.get("test")
        assert call_count == 1

    def test_re_register_clears_cache(self):
        """Re-registering a type invalidates the cache."""
        registry = GraphRegistry()
        graph_v1 = MagicMock(name="v1")
        graph_v2 = MagicMock(name="v2")

        registry.register("test", lambda: graph_v1)
        assert registry.get("test") is graph_v1

        registry.register("test", lambda: graph_v2)
        assert registry.get("test") is graph_v2

    def test_registered_types(self):
        """registered_types() returns all registered type names."""
        registry = GraphRegistry()
        registry.register("investigation", MagicMock)
        registry.register("chat", MagicMock)
        types = registry.registered_types()
        assert "investigation" in types
        assert "chat" in types

    def test_clear(self):
        """clear() removes all registrations and cache."""
        registry = GraphRegistry()
        registry.register("test", lambda: MagicMock())
        registry.get("test")  # prime the cache
        registry.clear()
        assert registry.registered_types() == []
        with pytest.raises(KeyError):
            registry.get("test")


# ============================================================================
# TurnWorker — unit tests using mock DB
# ============================================================================


class TestTurnWorker:
    """Tests for TurnWorker with mocked DB and graph execution."""

    @pytest.mark.asyncio
    async def test_poll_once_empty_queue_returns_false(self):
        """_poll_once returns False when the queue is empty."""
        from harness.session.worker import TurnWorker

        worker = TurnWorker()

        # Mock DB: no pending jobs
        mock_result = MagicMock()
        mock_result.fetchone.return_value = None

        mock_db = AsyncMock()
        mock_db.execute = AsyncMock(return_value=mock_result)
        mock_db.commit = AsyncMock()
        mock_db.__aenter__ = AsyncMock(return_value=mock_db)
        mock_db.__aexit__ = AsyncMock(return_value=None)

        with patch("harness.session.worker.AsyncSessionLocal", return_value=mock_db):
            result = await worker._poll_once()

        assert result is False

    @pytest.mark.asyncio
    async def test_poll_once_claims_and_executes_job(self):
        """_poll_once claims a job, executes it, and marks it done."""
        from harness.session.worker import TurnWorker

        worker = TurnWorker()

        # First DB call: claim returns a row
        claim_row = MagicMock()
        claim_row.id = "job-001"
        claim_row.session_id = "session-001"
        claim_row.payload = {
            "session_type": "investigation",
            "thread_id": "session-001",
            "input": {},
        }

        claim_result = MagicMock()
        claim_result.fetchone.return_value = claim_row

        advisory_result = MagicMock()
        advisory_result.fetchone.return_value = None

        call_count = 0

        async def mock_execute(query, params=None):
            nonlocal call_count
            call_count += 1
            if call_count == 1:
                return claim_result  # claim
            return advisory_result  # advisory lock

        mock_db = AsyncMock()
        mock_db.execute = mock_execute
        mock_db.commit = AsyncMock()
        mock_db.__aenter__ = AsyncMock(return_value=mock_db)
        mock_db.__aexit__ = AsyncMock(return_value=None)

        with patch("harness.session.worker.AsyncSessionLocal", return_value=mock_db):
            with patch.object(worker, "_execute_turn", new=AsyncMock()):
                with patch.object(worker, "_mark_job", new=AsyncMock()):
                    result = await worker._poll_once()

        assert result is True
        assert worker.processed_count == 1

    @pytest.mark.asyncio
    async def test_run_loop_stops_on_event(self):
        """run_loop exits cleanly when stop_event is set."""
        from harness.session.worker import TurnWorker

        stop = asyncio.Event()
        worker = TurnWorker(poll_ms=10, stop_event=stop)

        async def empty_poll():
            return False

        with patch.object(worker, "_poll_once", new=empty_poll):
            # Set the stop event after a brief delay
            async def set_stop():
                await asyncio.sleep(0.05)
                stop.set()

            await asyncio.gather(
                worker.run_loop(),
                set_stop(),
            )

        # Worker stopped cleanly
        assert stop.is_set()

    @pytest.mark.asyncio
    async def test_concurrent_turns_same_session_one_executes(self):
        """Five simultaneous turn insertions: one executes, others stay pending."""
        # This tests the queue insertion logic, not the DB advisory lock
        # (which requires real Postgres).  We mock enqueue_turn to check
        # the is_busy flag behaviour.
        from harness.session.worker import enqueue_turn

        session_id = "session-concurrent"

        # Simulate: first call finds no claimed jobs (empty), subsequent calls find 1
        claimed_counts = [0, 1, 1, 1, 1]
        insert_call = 0

        async def mock_execute(query, params=None):
            nonlocal insert_call
            result = MagicMock()
            q = str(query)
            if "COUNT" in q:
                result.scalar.return_value = claimed_counts[min(insert_call, 4)]
            elif "INSERT" in q:
                insert_call += 1
                result.rowcount = 1
            return result

        mock_db = AsyncMock()
        mock_db.execute = mock_execute
        mock_db.commit = AsyncMock()
        mock_db.__aenter__ = AsyncMock(return_value=mock_db)
        mock_db.__aexit__ = AsyncMock(return_value=None)

        results = []
        with patch("harness.session.worker.AsyncSessionLocal", return_value=mock_db):
            for _ in range(5):
                job_id, is_busy = await enqueue_turn(
                    session_id=session_id,
                    session_type="investigation",
                    turn_input={},
                )
                results.append((job_id, is_busy))

        is_busy_flags = [r[1] for r in results]
        # First call should not be busy (no claimed jobs), rest should be
        assert is_busy_flags[0] is False
        assert all(f is True for f in is_busy_flags[1:])
