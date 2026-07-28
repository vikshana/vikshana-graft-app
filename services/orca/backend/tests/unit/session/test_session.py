"""Unit tests for harness/session/registry.py and harness/session/worker.py."""

from __future__ import annotations

import asyncio
from datetime import datetime, timedelta, timezone
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
import sqlalchemy as sa
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine
from sqlalchemy.pool import StaticPool

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

    # ── F1 fix: async graph factories must never be cached un-awaited ──────

    def test_get_on_async_factory_raises_type_error_not_silent_corruption(self):
        """`get()` on an async factory raises TypeError instead of silently
        caching the un-awaited coroutine object.

        This is the exact bug in docs/harness-risk-review.md F1: the only
        production graph factory (`app.agent.rca_graph.get_rca_graph`) is
        `async def`, so `factory()` returns a coroutine, not the compiled
        graph. Before the fix, `get()` cached that coroutine directly and
        the failure only surfaced later (and confusingly) when the caller
        tried `coroutine.ainvoke(...)`.
        """
        registry = GraphRegistry()

        async def async_factory():
            return MagicMock(name="compiled_graph")

        registry.register("investigation", async_factory)

        with pytest.raises(TypeError, match="async"):
            registry.get("investigation")

        # The failed get() must not have cached anything — a subsequent
        # aget() must still work correctly.

    @pytest.mark.asyncio
    async def test_aget_awaits_async_factory_and_caches_result(self):
        """`aget()` awaits an async factory and caches the resolved graph."""
        registry = GraphRegistry()
        mock_graph = MagicMock(name="compiled_graph")
        call_count = 0

        async def async_factory():
            nonlocal call_count
            call_count += 1
            return mock_graph

        registry.register("investigation", async_factory)

        result1 = await registry.aget("investigation")
        result2 = await registry.aget("investigation")

        assert result1 is mock_graph
        assert result2 is mock_graph
        assert call_count == 1  # factory awaited exactly once, then cached

    @pytest.mark.asyncio
    async def test_aget_supports_sync_factories_too(self):
        """`aget()` also works transparently with plain sync factories."""
        registry = GraphRegistry()
        mock_graph = MagicMock(name="compiled_graph")
        registry.register("investigation", lambda: mock_graph)

        result = await registry.aget("investigation")
        assert result is mock_graph

    @pytest.mark.asyncio
    async def test_aget_unknown_type_raises_key_error(self):
        """aget() with an unregistered type raises KeyError, like get()."""
        registry = GraphRegistry()
        with pytest.raises(KeyError, match="No graph registered"):
            await registry.aget("unknown_type")


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


# ============================================================================
# TurnWorker — session serialization lock lifecycle (F2: at most one turn
# per session executes concurrently, without ever blocking the poll loop or
# holding a pooled connection for the duration of another session's turn).
#
# The lock must be:
#   - acquired with the *non-blocking*, *transaction-scoped*
#     `pg_try_advisory_xact_lock`, never the old blocking, session-level
#     `pg_advisory_lock`/`pg_advisory_unlock` pair;
#   - acquired on a dedicated execution session, separate from the (already
#     committed and returned to the pool) claim session;
#   - held for the full `_execute_turn` call and released purely by ending
#     that transaction (commit), with no separate "unlock" statement
#     required — so cancellation, crashes, and raised exceptions can never
#     leave it permanently held;
#   - safe to skip: when unavailable, the job is requeued to `pending` (with
#     its claim `attempts` increment reversed) and `_execute_turn` is never
#     called, rather than the poll loop blocking on it.
# ============================================================================


class TestTurnWorkerSessionLock:
    """Tests for the non-blocking, transaction-scoped serialization lock."""

    @staticmethod
    def _make_claim_result(job_id: str, session_id: str, payload: dict) -> MagicMock:
        claim_row = MagicMock()
        claim_row.id = job_id
        claim_row.session_id = session_id
        claim_row.payload = payload
        claim_result = MagicMock()
        claim_result.fetchone.return_value = claim_row
        return claim_result

    @staticmethod
    def _make_lock_result(acquired: bool) -> MagicMock:
        lock_result = MagicMock()
        lock_result.scalar.return_value = acquired
        return lock_result

    @staticmethod
    def _make_mock_db(execute_fn) -> AsyncMock:
        mock_db = AsyncMock()
        mock_db.execute = execute_fn
        mock_db.commit = AsyncMock()
        mock_db.__aenter__ = AsyncMock(return_value=mock_db)
        mock_db.__aexit__ = AsyncMock(return_value=None)
        return mock_db

    @pytest.mark.asyncio
    async def test_lock_uses_try_advisory_xact_lock_not_blocking_session_lock(self):
        """Serialization must use the non-blocking, transaction-scoped
        pg_try_advisory_xact_lock -- never the old blocking, session-level
        pg_advisory_lock/pg_advisory_unlock pair, which could tie up a
        pooled connection for the full duration of someone else's turn."""
        from harness.session.worker import TurnWorker

        worker = TurnWorker()
        claim_result = self._make_claim_result(
            "job-lock-1",
            "session-lock-1",
            {"session_type": "investigation", "input": {}},
        )
        queries: list[str] = []

        async def mock_execute(query, params=None):
            q = str(query)
            queries.append(q)
            if "UPDATE turn_jobs" in q and "claimed" in q:
                return claim_result
            if "pg_try_advisory_xact_lock" in q:
                return self._make_lock_result(True)
            return MagicMock()

        mock_db = self._make_mock_db(mock_execute)

        with patch("harness.session.worker.AsyncSessionLocal", return_value=mock_db):
            with patch.object(worker, "_execute_turn", new=AsyncMock()):
                with patch.object(worker, "_mark_job", new=AsyncMock()):
                    result = await worker._poll_once()

        assert result is True
        assert any("pg_try_advisory_xact_lock" in q for q in queries)
        assert not any("pg_advisory_unlock" in q for q in queries)
        # The old blocking call was literally `pg_advisory_lock(...)` with
        # no `try_`/`xact` qualifiers -- make sure it's gone too.
        assert not any("pg_advisory_lock(" in q for q in queries)

    @pytest.mark.asyncio
    async def test_lock_unavailable_requeues_job_and_never_executes_turn(self):
        """When pg_try_advisory_xact_lock can't be acquired (another
        worker/replica already holds it for this session), the job is
        requeued to pending -- not executed, and the poll loop is never
        blocked waiting for the lock to free up."""
        from harness.session.worker import TurnWorker

        worker = TurnWorker()
        claim_result = self._make_claim_result(
            "job-lock-2",
            "session-lock-2",
            {"session_type": "investigation", "input": {}},
        )
        queries: list[str] = []

        async def mock_execute(query, params=None):
            q = str(query)
            queries.append(q)
            if "UPDATE turn_jobs" in q and "claimed" in q:
                return claim_result
            if "pg_try_advisory_xact_lock" in q:
                return self._make_lock_result(False)  # session busy
            return MagicMock()

        mock_db = self._make_mock_db(mock_execute)
        execute_turn_mock = AsyncMock()

        with patch("harness.session.worker.AsyncSessionLocal", return_value=mock_db):
            with patch.object(worker, "_execute_turn", new=execute_turn_mock):
                result = await worker._poll_once()

        assert result is False
        execute_turn_mock.assert_not_called()
        assert worker.processed_count == 0

        requeue_queries = [q for q in queries if "SET status = 'pending'" in q]
        assert len(requeue_queries) == 1
        assert "GREATEST(attempts - 1, 0)" in requeue_queries[0]

    @pytest.mark.asyncio
    async def test_lock_released_by_ending_transaction_after_success(self):
        """The advisory lock is transaction-scoped: it is released purely
        by committing the dedicated execution session after the turn
        completes -- no separate unlock statement is issued."""
        from harness.session.worker import TurnWorker

        worker = TurnWorker()
        claim_result = self._make_claim_result(
            "job-lock-3",
            "session-lock-3",
            {"session_type": "investigation", "input": {}},
        )
        order: list[str] = []

        async def mock_execute(query, params=None):
            q = str(query)
            if "UPDATE turn_jobs" in q and "claimed" in q:
                return claim_result
            if "pg_try_advisory_xact_lock" in q:
                return self._make_lock_result(True)
            return MagicMock()

        mock_db = self._make_mock_db(mock_execute)
        mock_db.commit = AsyncMock(side_effect=lambda: order.append("commit"))

        async def fake_execute_turn(session_id: str, payload: dict) -> None:
            order.append("execute_turn")

        with patch("harness.session.worker.AsyncSessionLocal", return_value=mock_db):
            with patch.object(worker, "_execute_turn", new=fake_execute_turn):
                with patch.object(worker, "_mark_job", new=AsyncMock()):
                    result = await worker._poll_once()

        assert result is True
        # [claim commit, execute_turn, exec_db commit releasing the lock]
        assert order == ["commit", "execute_turn", "commit"]

    @pytest.mark.asyncio
    async def test_lock_released_by_ending_transaction_after_execute_turn_raises(self):
        """Even when _execute_turn raises, the execution transaction is
        still committed in `finally` (ending it and releasing the lock)
        instead of relying on a separate unlock call that could itself be
        skipped or fail."""
        from harness.session.worker import TurnWorker

        worker = TurnWorker()
        claim_result = self._make_claim_result(
            "job-lock-4",
            "session-lock-4",
            {"session_type": "investigation", "input": {}},
        )

        async def mock_execute(query, params=None):
            q = str(query)
            if "UPDATE turn_jobs" in q and "claimed" in q:
                return claim_result
            if "pg_try_advisory_xact_lock" in q:
                return self._make_lock_result(True)
            return MagicMock()

        mock_db = self._make_mock_db(mock_execute)

        async def boom(session_id: str, payload: dict) -> None:
            raise RuntimeError("agent crashed mid-turn")

        mark_job_calls: list[str] = []

        async def fake_mark_job(job_id: str, status: str) -> None:
            mark_job_calls.append(status)

        with patch("harness.session.worker.AsyncSessionLocal", return_value=mock_db):
            with patch.object(worker, "_execute_turn", new=boom):
                with patch.object(worker, "_mark_job", new=fake_mark_job):
                    result = await worker._poll_once()

        # A failed turn still counts as "processed" (not an empty queue).
        assert result is True
        assert mark_job_calls == ["failed"]
        # Two commits: the claim commit, and the exec_db commit in
        # `finally` that ends the transaction and releases the lock.
        assert mock_db.commit.await_count == 2

    @pytest.mark.asyncio
    async def test_cancellation_during_execute_turn_still_ends_transaction_and_propagates(self):
        """If the task running _poll_once is cancelled while _execute_turn
        is in flight, the `finally` block still runs -- ending the
        execution transaction and releasing the advisory lock
        automatically -- and the CancelledError propagates rather than
        being swallowed."""
        from harness.session.worker import TurnWorker

        worker = TurnWorker()
        claim_result = self._make_claim_result(
            "job-lock-5",
            "session-lock-5",
            {"session_type": "investigation", "input": {}},
        )

        async def mock_execute(query, params=None):
            q = str(query)
            if "UPDATE turn_jobs" in q and "claimed" in q:
                return claim_result
            if "pg_try_advisory_xact_lock" in q:
                return self._make_lock_result(True)
            return MagicMock()

        mock_db = self._make_mock_db(mock_execute)
        started = asyncio.Event()

        async def hang_forever(session_id: str, payload: dict) -> None:
            started.set()
            await asyncio.sleep(3600)

        with patch("harness.session.worker.AsyncSessionLocal", return_value=mock_db):
            with patch.object(worker, "_execute_turn", new=hang_forever):
                with patch.object(worker, "_mark_job", new=AsyncMock()):
                    task = asyncio.create_task(worker._poll_once())
                    await asyncio.wait_for(started.wait(), timeout=1)
                    task.cancel()
                    with pytest.raises(asyncio.CancelledError):
                        await task

        # claim commit + exec_db commit in `finally`, despite cancellation.
        assert mock_db.commit.await_count == 2

    @pytest.mark.asyncio
    async def test_heartbeat_task_started_while_executing_and_cancelled_after(self):
        """A heartbeat task is started once the lock is acquired and is
        always cancelled once the turn finishes -- it must never be left
        running past `_poll_once` returning."""
        from harness.session.worker import TurnWorker

        worker = TurnWorker()
        claim_result = self._make_claim_result(
            "job-hb-1",
            "session-hb-1",
            {"session_type": "investigation", "input": {}},
        )

        async def mock_execute(query, params=None):
            q = str(query)
            if "UPDATE turn_jobs" in q and "claimed" in q:
                return claim_result
            if "pg_try_advisory_xact_lock" in q:
                return self._make_lock_result(True)
            return MagicMock()

        mock_db = self._make_mock_db(mock_execute)

        heartbeat_started = asyncio.Event()
        heartbeat_cancelled = asyncio.Event()

        async def fake_heartbeat_loop(job_id: str) -> None:
            heartbeat_started.set()
            try:
                await asyncio.sleep(3600)  # would hang forever if not cancelled
            except asyncio.CancelledError:
                heartbeat_cancelled.set()
                raise

        async def fake_execute_turn(session_id: str, payload: dict) -> None:
            await asyncio.wait_for(heartbeat_started.wait(), timeout=1)

        with patch("harness.session.worker.AsyncSessionLocal", return_value=mock_db):
            with patch.object(worker, "_heartbeat_loop", new=fake_heartbeat_loop):
                with patch.object(worker, "_execute_turn", new=fake_execute_turn):
                    with patch.object(worker, "_mark_job", new=AsyncMock()):
                        result = await worker._poll_once()

        assert result is True
        assert heartbeat_started.is_set()
        assert heartbeat_cancelled.is_set()


# ============================================================================
# TurnWorker — heartbeat + busy-requeue helpers, tested directly
# ============================================================================


class TestTurnWorkerHeartbeatAndRequeueHelpers:
    """Focused tests for `_send_heartbeat` and `_requeue_busy_job`."""

    @staticmethod
    def _make_mock_db(execute_fn) -> AsyncMock:
        mock_db = AsyncMock()
        mock_db.execute = execute_fn
        mock_db.commit = AsyncMock()
        mock_db.__aenter__ = AsyncMock(return_value=mock_db)
        mock_db.__aexit__ = AsyncMock(return_value=None)
        return mock_db

    @pytest.mark.asyncio
    async def test_send_heartbeat_updates_claimed_at_for_claimed_job(self):
        from harness.session.worker import TurnWorker

        worker = TurnWorker()
        captured: dict = {}

        async def mock_execute(query, params=None):
            captured["query"] = str(query)
            captured["params"] = params
            return MagicMock()

        mock_db = self._make_mock_db(mock_execute)

        with patch("harness.session.worker.AsyncSessionLocal", return_value=mock_db):
            await worker._send_heartbeat("job-hb-2")

        assert "SET claimed_at" in captured["query"]
        assert "status = 'claimed'" in captured["query"]
        assert captured["params"]["id"] == "job-hb-2"
        mock_db.commit.assert_awaited()

    @pytest.mark.asyncio
    async def test_send_heartbeat_swallows_and_logs_errors(self):
        """A transient DB error on the heartbeat must never propagate and
        crash the turn it is protecting."""
        from harness.session.worker import TurnWorker

        worker = TurnWorker()

        async def boom_execute(query, params=None):
            raise RuntimeError("connection dropped")

        mock_db = self._make_mock_db(boom_execute)

        with patch("harness.session.worker.AsyncSessionLocal", return_value=mock_db):
            await worker._send_heartbeat("job-hb-3")  # must not raise

    @pytest.mark.asyncio
    async def test_requeue_busy_job_resets_status_and_decrements_attempts(self):
        from harness.session.worker import TurnWorker

        worker = TurnWorker()
        captured: dict = {}

        async def mock_execute(query, params=None):
            captured["query"] = str(query)
            captured["params"] = params
            return MagicMock()

        mock_db = self._make_mock_db(mock_execute)

        with patch("harness.session.worker.AsyncSessionLocal", return_value=mock_db):
            await worker._requeue_busy_job("job-busy-1")

        q = captured["query"]
        assert "status = 'pending'" in q
        assert "worker_id = NULL" in q
        assert "claimed_at = NULL" in q
        assert "GREATEST(attempts - 1, 0)" in q
        assert captured["params"]["id"] == "job-busy-1"
        mock_db.commit.assert_awaited()


# ============================================================================
# Orphan reaper + heartbeat compatibility (real SQLite, no mocking of the
# actual WHERE-clause semantics) -- proves that a live turn whose heartbeat
# keeps renewing `claimed_at` is never requeued out from under it, no
# matter how long it has been running in total, while a genuinely crashed
# worker's job (no heartbeat) is still correctly reaped.
# ============================================================================


class TestOrphanReaperHeartbeatCompatibility:
    """DB-light (in-memory SQLite) tests for `_reap_orphaned_jobs`."""

    @staticmethod
    async def _sqlite_session_factory():
        engine = create_async_engine(
            "sqlite+aiosqlite:///:memory:",
            poolclass=StaticPool,
            connect_args={"check_same_thread": False},
        )
        async with engine.begin() as conn:
            await conn.execute(sa.text("""
                CREATE TABLE turn_jobs (
                    id TEXT PRIMARY KEY,
                    session_id TEXT,
                    payload TEXT,
                    status TEXT,
                    created_at TIMESTAMP,
                    claimed_at TIMESTAMP,
                    worker_id TEXT,
                    attempts INTEGER DEFAULT 0
                )
            """))
        session_local = async_sessionmaker(bind=engine, class_=AsyncSession, expire_on_commit=False)
        return engine, session_local

    @staticmethod
    async def _insert_job(session_local, **kwargs) -> None:
        async with session_local() as s:
            await s.execute(sa.text("""
                INSERT INTO turn_jobs
                    (id, session_id, payload, status, created_at, claimed_at, worker_id, attempts)
                VALUES
                    (:id, :session_id, :payload, :status, :created_at, :claimed_at, :worker_id, :attempts)
            """), kwargs)
            await s.commit()

    @staticmethod
    async def _fetch_status(session_local, job_id: str) -> str | None:
        async with session_local() as s:
            result = await s.execute(
                sa.text("SELECT status FROM turn_jobs WHERE id = :id"), {"id": job_id}
            )
            row = result.fetchone()
            return row.status if row else None

    @pytest.mark.asyncio
    async def test_heartbeat_keeps_long_running_turn_from_being_reaped(self):
        """A turn claimed 2 hours ago (far past the default lease TTL) but
        whose heartbeat renewed `claimed_at` moments ago must NOT be
        reaped -- total turn duration is irrelevant as long as the
        heartbeat keeps landing."""
        from harness.session.worker import TurnWorker

        engine, session_local = await self._sqlite_session_factory()
        try:
            now = datetime.now(timezone.utc)
            long_ago = now - timedelta(seconds=7200)

            await self._insert_job(
                session_local,
                id="job-live", session_id="s-live", payload="{}", status="claimed",
                created_at=long_ago, claimed_at=long_ago, worker_id="w1", attempts=1,
            )

            worker = TurnWorker()
            with patch("harness.session.worker.AsyncSessionLocal", session_local):
                # Heartbeat renews claimed_at, simulating a still-live turn.
                await worker._send_heartbeat("job-live")
                reaped = await worker._reap_orphaned_jobs()

            assert reaped == 0
            assert await self._fetch_status(session_local, "job-live") == "claimed"
        finally:
            await engine.dispose()
    @pytest.mark.asyncio
    async def test_crashed_worker_without_heartbeat_is_still_reaped(self):
        """Baseline: a stale claimed job that never heartbeats (crashed
        worker) is still correctly requeued to pending -- the heartbeat
        only protects genuinely live turns, not dead ones."""
        from harness.session.worker import TurnWorker

        engine, session_local = await self._sqlite_session_factory()
        try:
            now = datetime.now(timezone.utc)
            long_ago = now - timedelta(seconds=7200)

            await self._insert_job(
                session_local,
                id="job-dead", session_id="s-dead", payload="{}", status="claimed",
                created_at=long_ago, claimed_at=long_ago, worker_id="w-crashed", attempts=1,
            )

            worker = TurnWorker()
            with patch("harness.session.worker.AsyncSessionLocal", session_local):
                reaped = await worker._reap_orphaned_jobs()

            assert reaped == 1
            assert await self._fetch_status(session_local, "job-dead") == "pending"
        finally:
            await engine.dispose()
    @pytest.mark.asyncio
    async def test_attempt_exhausted_stale_job_marked_failed_not_requeued(self):
        """A stale claimed job that has exhausted its crash-retry budget
        is marked failed rather than requeued forever."""
        from harness.session.worker import TurnWorker

        engine, session_local = await self._sqlite_session_factory()
        try:
            now = datetime.now(timezone.utc)
            long_ago = now - timedelta(seconds=7200)

            await self._insert_job(
                session_local,
                id="job-exhausted", session_id="s-x", payload="{}", status="claimed",
                created_at=long_ago, claimed_at=long_ago, worker_id="w-crashed", attempts=5,
            )

            worker = TurnWorker()
            with patch("harness.session.worker.AsyncSessionLocal", session_local):
                reaped = await worker._reap_orphaned_jobs()

            assert reaped == 1
            assert await self._fetch_status(session_local, "job-exhausted") == "failed"
        finally:
            await engine.dispose()
