"""TurnWorker — stateless Postgres-backed turn job queue.

Each FastAPI worker process runs one ``TurnWorker`` instance in the background
(started as an ``asyncio.Task`` in the app lifespan).  Any worker replica can
claim and execute any pending turn job, making the system horizontally scalable
without session affinity.

Claim protocol:
  1. ``SELECT ... FOR UPDATE SKIP LOCKED`` on ``turn_jobs`` (status=pending),
     on a pooled connection that is committed immediately so the claim is
     durable regardless of how long the turn itself takes.
  2. ``pg_try_advisory_xact_lock(hashtext(session_id))`` — a *non-blocking*,
     *transaction-scoped* advisory lock, acquired on a dedicated execution
     session (never the pooled claim connection above) — serialises
     concurrent turns within the same session (at most one active turn per
     session). Because it is non-blocking, a contended session never stalls
     the poll loop or ties up a pooled connection waiting; because it is
     transaction-scoped, it is released purely by ending that one
     transaction (commit *or* rollback), so a slow, failing, crashed, or
     cancelled turn can never leave the session's lock permanently held —
     there is no separate "unlock" statement that itself has to
     successfully round-trip to Postgres. If the lock is unavailable
     (another worker/replica is already executing a turn for this session),
     the job is safely returned to ``pending`` (see ``_requeue_busy_job``)
     rather than blocked on.
  3. Execute the turn via ``GraphRegistry``, while a background heartbeat
     periodically refreshes ``claimed_at`` so the orphan reaper (see below)
     never mistakes a live, long-running turn for a crashed one.
  4. Mark job ``done`` or ``failed``.

Concurrency model:
  - Multiple turn requests for the same session are queued as separate
    ``TurnJob`` rows.  The first is claimed and executed; subsequent ones
    are requeued to ``pending`` until the lock is released.
  - Callers that hit an already-active session receive an ``agent_busy``
    event immediately without blocking.

Orphan reaping:
  - A job stuck in ``claimed`` because its worker crashed is detected via a
    stale ``claimed_at`` (older than ``TURN_JOB_LEASE_TTL_S``) and reset to
    ``pending`` (or ``failed`` past ``TURN_JOB_MAX_ATTEMPTS``).
  - A *live* turn's heartbeat keeps renewing ``claimed_at`` throughout
    execution, so a legitimately long-running turn is never requeued out
    from under the worker that is actively (and safely, per the advisory
    lock above) still executing it.

Configuration:
  ``TURN_WORKER_POLL_MS``            — poll interval when queue is empty
                                        (default 200ms).
  ``TURN_WORKER_ID``                 — optional worker identifier for
                                        observability.
  ``TURN_JOB_LEASE_TTL_S``           — staleness threshold for orphan
                                        reaping (default 600s).
  ``TURN_JOB_MAX_ATTEMPTS``          — crash-retry budget before a job is
                                        given up on (default 5).
  ``TURN_JOB_HEARTBEAT_INTERVAL_S``  — how often a live turn renews its
                                        lease (default 60s).
"""

from __future__ import annotations

import asyncio
import contextlib
import os
import socket
import uuid
from datetime import datetime, timedelta, timezone
from typing import Any
import structlog
from sqlalchemy import text

from app.db import AsyncSessionLocal
from harness.session.registry import graph_registry

logger = structlog.get_logger()

# Default poll interval when the queue is empty
_DEFAULT_POLL_MS = int(os.environ.get("TURN_WORKER_POLL_MS", "200"))

# Lease TTL: a claimed job whose claimed_at is older than this is considered
# orphaned (the claiming worker crashed) and is reset to pending by the reaper.
_CLAIM_LEASE_TTL_S = int(os.environ.get("TURN_JOB_LEASE_TTL_S", "600"))

# Maximum times a job may be reclaimed after an orphaned lease before it is
# marked failed to prevent an infinite crash-retry loop.
_MAX_JOB_ATTEMPTS = int(os.environ.get("TURN_JOB_MAX_ATTEMPTS", "5"))

# How often a live turn renews its claim lease (`claimed_at`) while
# executing, so the orphan reaper never requeues a turn that is still
# legitimately running just because it has been running for a while.
_HEARTBEAT_INTERVAL_S = float(os.environ.get("TURN_JOB_HEARTBEAT_INTERVAL_S", "60"))

# Worker identifier (defaults to hostname + pid)
_WORKER_ID = os.environ.get(
    "TURN_WORKER_ID",
    f"{socket.gethostname()}-{os.getpid()}",
)


class TurnWorker:
    """Stateless background worker that processes turn jobs from the queue.

    Args:
        poll_ms: Polling interval in milliseconds when the queue is empty.
        worker_id: Identifier for this worker instance (for observability).
        stop_event: Optional asyncio.Event; set it to stop the loop gracefully.
        heartbeat_interval_s: Seconds between claim-lease renewals while a
            turn is executing (see ``_heartbeat_loop``).
    """

    def __init__(
        self,
        poll_ms: int = _DEFAULT_POLL_MS,
        worker_id: str = _WORKER_ID,
        stop_event: asyncio.Event | None = None,
        heartbeat_interval_s: float = _HEARTBEAT_INTERVAL_S,
    ) -> None:
        self._poll_ms = poll_ms
        self._worker_id = worker_id
        self._stop_event = stop_event or asyncio.Event()
        self._heartbeat_interval_s = heartbeat_interval_s
        self._processed = 0
        self._slack_notifier: Any | None = None  # lazily initialised, reused across turns

    async def run_loop(self) -> None:
        """Main poll loop — runs until the stop event is set.

        Logs each processed job and any unexpected exceptions.
        Sleeps between empty polls to avoid hammering the DB.
        """
        log = logger.bind(worker_id=self._worker_id)
        log.info("turn_worker_started", poll_ms=self._poll_ms)

        while not self._stop_event.is_set():
            try:
                await self._reap_orphaned_jobs()
                processed = await self._poll_once()
                if not processed:
                    await asyncio.sleep(self._poll_ms / 1000)
            except asyncio.CancelledError:
                log.info("turn_worker_cancelled")
                break
            except Exception as exc:
                log.error("turn_worker_unexpected_error", error=str(exc), exc_info=True)
                await asyncio.sleep(1)

        log.info("turn_worker_stopped", total_processed=self._processed)

    async def _reap_orphaned_jobs(self) -> int:
        """Recover jobs orphaned by a crashed worker.

        A job left in ``claimed`` state with a ``claimed_at`` older than the
        lease TTL means the worker that claimed it died before marking it
        done/failed. Such jobs are reset to ``pending`` so another worker can
        retry them, unless they have already been attempted ``_MAX_JOB_ATTEMPTS``
        times, in which case they are marked ``failed`` to stop a crash-retry
        loop.

        Returns:
            Number of jobs transitioned (requeued + failed).
        """
        cutoff = datetime.now(timezone.utc) - timedelta(seconds=_CLAIM_LEASE_TTL_S)

        async with AsyncSessionLocal() as db:
            # Give up on jobs that have exhausted their attempt budget.
            failed_result = await db.execute(
                text("""
                    UPDATE turn_jobs
                    SET status = 'failed'
                    WHERE status = 'claimed'
                      AND claimed_at < :cutoff
                      AND attempts >= :max_attempts
                    RETURNING id
                """),
                {"cutoff": cutoff, "max_attempts": _MAX_JOB_ATTEMPTS},
            )
            failed_ids = [str(r.id) for r in failed_result.fetchall()]

            # Requeue the rest for another attempt.
            requeue_result = await db.execute(
                text("""
                    UPDATE turn_jobs
                    SET status = 'pending',
                        worker_id = NULL,
                        claimed_at = NULL
                    WHERE status = 'claimed'
                      AND claimed_at < :cutoff
                      AND attempts < :max_attempts
                    RETURNING id
                """),
                {"cutoff": cutoff, "max_attempts": _MAX_JOB_ATTEMPTS},
            )
            requeued_ids = [str(r.id) for r in requeue_result.fetchall()]
            await db.commit()

        if failed_ids or requeued_ids:
            logger.warning(
                "turn_jobs_reaped",
                worker_id=self._worker_id,
                requeued=len(requeued_ids),
                failed=len(failed_ids),
                lease_ttl_s=_CLAIM_LEASE_TTL_S,
            )
        return len(failed_ids) + len(requeued_ids)

    async def _poll_once(self) -> bool:
        """Attempt to claim and execute one pending turn job.

        Returns:
            True if a turn was actually executed. False if the queue was
            empty *or* the only claimable job's session is currently busy
            (another worker/replica holds its advisory lock) — both cases
            are treated the same way by the caller (back off for one poll
            interval), so a busy session can never turn into a tight,
            DB-hammering retry loop.
        """
        async with AsyncSessionLocal() as db:
            # Claim one pending job with SKIP LOCKED
            claim_result = await db.execute(
                text("""
                    UPDATE turn_jobs
                    SET status = 'claimed',
                        claimed_at = :now,
                        worker_id = :worker_id,
                        attempts = attempts + 1
                    WHERE id = (
                        SELECT id FROM turn_jobs
                        WHERE status = 'pending'
                        ORDER BY created_at
                        LIMIT 1
                        FOR UPDATE SKIP LOCKED
                    )
                    RETURNING id, session_id, payload
                """),
                {
                    "now": datetime.now(timezone.utc),
                    "worker_id": self._worker_id,
                },
            )
            row = claim_result.fetchone()
            if row is None:
                return False

            job_id: str = str(row.id)
            session_id: str = str(row.session_id)
            payload: dict[str, Any] = dict(row.payload)

            # Commit the claim immediately so it is durable and visible to
            # other workers/observability (e.g. the orphan reaper),
            # regardless of how long the turn itself takes to run below.
            await db.commit()

        log = logger.bind(
            worker_id=self._worker_id,
            job_id=job_id,
            session_id=session_id,
        )
        log.info("turn_job_claimed")

        # Session serialisation: at most one active turn per session, using
        # a *non-blocking*, *transaction-scoped* advisory lock
        # (pg_try_advisory_xact_lock) acquired on a dedicated execution
        # session — never the pooled `db` connection above, which was
        # already committed and returned to the pool.
        #
        # Why try + xact-scoped, instead of the blocking session-level
        # pg_advisory_lock/pg_advisory_unlock pair this replaces:
        #   - `pg_try_advisory_xact_lock` returns immediately (true/false)
        #     rather than blocking the calling connection for however long
        #     an in-flight turn takes. A blocking acquire on a pooled
        #     connection is exactly the head-of-line-blocking /
        #     permanent-pooled-connection hazard this must avoid — it can
        #     tie up a connection-pool slot for the full duration of
        #     someone else's turn, starving unrelated sessions and jobs.
        #   - Because the lock is transaction-scoped, it is released
        #     purely by ending the transaction (commit *or* rollback) —
        #     there is no separate "unlock" statement that must itself
        #     round-trip successfully to Postgres. If this turn is
        #     cancelled, raises, or the process is killed, closing/rolling
        #     back `exec_db` (done automatically on any exit from the
        #     `async with` block below) releases the lock. A session-level
        #     lock instead requires an explicit `pg_advisory_unlock` to run
        #     to completion, which is fragile under cancellation and
        #     actively dangerous behind a transaction-pooling connection
        #     pooler (e.g. PgBouncer), where the Postgres "session" a lock
        #     is attached to can be silently handed to an unrelated client.
        async with AsyncSessionLocal() as exec_db:
            lock_result = await exec_db.execute(
                text("SELECT pg_try_advisory_xact_lock(hashtext(:sid)) AS acquired"),
                {"sid": session_id},
            )
            acquired = bool(lock_result.scalar())

            if not acquired:
                # Another worker (possibly another replica) is already
                # executing a turn for this session. Never block waiting
                # for it — safely return this job to the queue instead.
                log.info("turn_job_session_busy_requeued")
                await self._requeue_busy_job(job_id)
                return False

            log.info("turn_session_lock_acquired")

            # Renew the claim lease periodically while the turn actually
            # executes, so the orphan reaper (`_reap_orphaned_jobs`) never
            # mistakes a live, still-running turn for a crashed one and
            # requeues it out from under us. Cancelled unconditionally in
            # `finally` once the turn finishes (success, failure, or the
            # cancellation of this coroutine itself).
            heartbeat_task = asyncio.create_task(self._heartbeat_loop(job_id))
            try:
                await self._execute_turn(session_id, payload)
                await self._mark_job(job_id, "done")
                self._processed += 1
                log.info("turn_job_done")
            except Exception as exc:
                log.error("turn_job_failed", error=str(exc), exc_info=True)
                await self._mark_job(job_id, "failed")
            finally:
                heartbeat_task.cancel()
                with contextlib.suppress(asyncio.CancelledError):
                    await heartbeat_task
                # Ending this transaction releases the
                # pg_try_advisory_xact_lock acquired above. Even if this
                # commit is itself interrupted (e.g. cancellation), exiting
                # the `async with` block below rolls back any still-open
                # transaction on `exec_db` and releases the lock all the
                # same — there is no code path (crash, cancellation, or
                # otherwise) that can leave this lock permanently held.
                await exec_db.commit()

        return True

    async def _requeue_busy_job(self, job_id: str) -> None:
        """Return a just-claimed job to ``pending`` because its session's
        advisory lock is currently held by another in-flight turn.

        This is healthy contention (another worker/replica is actively
        executing a turn for the same session), not a crash, so the
        ``attempts`` increment applied by the claim step in ``_poll_once``
        is reversed here — this contention must never count toward the
        crash-retry budget enforced by ``_reap_orphaned_jobs``.

        Args:
            job_id: UUID of the turn_jobs row to requeue.
        """
        async with AsyncSessionLocal() as db:
            await db.execute(
                text("""
                    UPDATE turn_jobs
                    SET status = 'pending',
                        worker_id = NULL,
                        claimed_at = NULL,
                        attempts = GREATEST(attempts - 1, 0)
                    WHERE id = :id
                """),
                {"id": job_id},
            )
            await db.commit()

    async def _heartbeat_loop(self, job_id: str) -> None:
        """Periodically refresh ``claimed_at`` for a claimed job while its
        turn is executing.

        The orphan reaper treats any job whose ``claimed_at`` is older than
        the lease TTL as abandoned and resets it to ``pending``. Without a
        heartbeat, a legitimately long-running turn (LLM + tool-call loops
        can easily exceed a fixed lease TTL) would eventually be requeued
        and picked up by a second worker while the first is still executing
        it — exactly the concurrent-execution hazard the advisory lock in
        ``_poll_once`` exists to prevent. Renewing ``claimed_at`` here keeps
        a *live* turn's lease fresh regardless of total duration; only a
        worker that has actually stopped heartbeating (crashed or killed)
        goes stale and is reaped.

        Runs until cancelled by the caller in a ``finally`` block once the
        turn finishes, by any means (success, failure, or cancellation).
        """
        while True:
            await asyncio.sleep(self._heartbeat_interval_s)
            await self._send_heartbeat(job_id)

    async def _send_heartbeat(self, job_id: str) -> None:
        """Refresh ``claimed_at`` for one job to the current time.

        Best-effort: failures are logged, never raised, so a transient DB
        hiccup on the heartbeat can't crash the turn it is protecting.

        Args:
            job_id: UUID of the turn_jobs row to renew.
        """
        try:
            async with AsyncSessionLocal() as db:
                await db.execute(
                    text("""
                        UPDATE turn_jobs
                        SET claimed_at = :now
                        WHERE id = :id AND status = 'claimed'
                    """),
                    {"now": datetime.now(timezone.utc), "id": job_id},
                )
                await db.commit()
        except Exception as exc:
            logger.warning(
                "turn_job_heartbeat_failed",
                worker_id=self._worker_id,
                job_id=job_id,
                error=str(exc),
            )

    async def _execute_turn(self, session_id: str, payload: dict[str, Any]) -> None:
        """Execute a turn using the appropriate graph from the registry.

        The session type is read from the payload (default: ``investigation``).
        The LangGraph thread ID is either the session_id or an explicit
        ``thread_id`` in the payload.

        Args:
            session_id: Session identifier.
            payload: Job payload containing turn input and optional config.
        """
        session_type = payload.get("session_type", "investigation")
        thread_id = payload.get("thread_id", session_id)
        turn_input = payload.get("input", {})
        resume_command = payload.get("resume_command")

        log = logger.bind(session_id=session_id, session_type=session_type)

        try:
            # aget() awaits the graph factory when it is async (the
            # production factory, `app.agent.rca_graph.get_rca_graph`, is
            # async — it lazily opens a Postgres checkpointer connection
            # pool on first call). Using the sync `get()` here would cache
            # the un-awaited coroutine instead of the compiled graph (see
            # docs/harness-risk-review.md, F1).
            graph = await graph_registry.aget(session_type)
        except KeyError as exc:
            log.error("unknown_session_type", error=str(exc))
            raise

        config = {"configurable": {"thread_id": thread_id}}

        if resume_command is not None:
            # Resuming an interrupted graph (e.g. after await_input)
            from langgraph.types import Command
            command = Command(resume=resume_command)
            turn_result = await graph.ainvoke(command, config=config)
        else:
            # Fresh invocation
            turn_result = await graph.ainvoke(turn_input, config=config)

        log.info("turn_executed")

        # Best-effort Slack notification — failures are swallowed inside the notifier.
        # Notifier is cached on self to avoid creating a new AsyncWebClient each turn.
        try:
            from app.config import settings
            if settings.SLACK_BOT_TOKEN:
                if self._slack_notifier is None:
                    from harness.slack.notifier import SlackNotifier
                    self._slack_notifier = SlackNotifier()
                await self._slack_notifier.post_turn_result(session_id, payload, turn_result=turn_result)
        except Exception as _slack_exc:
            log.debug("slack_notifier_skipped", error=str(_slack_exc))

    async def _mark_job(self, job_id: str, status: str) -> None:
        """Update a job's status to ``done`` or ``failed``.

        Args:
            job_id: UUID of the turn_jobs row.
            status: New status (``"done"`` or ``"failed"``).
        """
        async with AsyncSessionLocal() as db:
            await db.execute(
                text(
                    "UPDATE turn_jobs SET status = :status WHERE id = :id"
                ),
                {"status": status, "id": job_id},
            )
            await db.commit()

    def stop(self) -> None:
        """Signal the worker loop to stop after the current job completes."""
        self._stop_event.set()

    @property
    def processed_count(self) -> int:
        """Number of jobs successfully processed by this worker instance."""
        return self._processed


async def enqueue_turn(
    session_id: str,
    session_type: str,
    turn_input: dict[str, Any] | None = None,
    resume_command: dict[str, Any] | None = None,
    thread_id: str | None = None,
) -> tuple[str, bool]:
    """Insert a turn job into the queue and report whether the session is busy.

    Args:
        session_id: Session identifier.
        session_type: Graph type to dispatch to.
        turn_input: Initial state for a fresh invocation.
        resume_command: Resume payload for interrupt/resume flows.
        thread_id: LangGraph thread ID (defaults to session_id).

    Returns:
        Tuple of (job_id, is_busy) where ``is_busy=True`` means another turn
        is currently claimed for this session (caller should emit ``agent_busy``).
    """
    job_id = str(uuid.uuid4())
    payload: dict[str, Any] = {
        "session_type": session_type,
        "thread_id": thread_id or session_id,
    }
    if turn_input is not None:
        payload["input"] = turn_input
    if resume_command is not None:
        payload["resume_command"] = resume_command

    async with AsyncSessionLocal() as db:
        # Check if there's already a claimed job for this session
        busy_result = await db.execute(
            text(
                "SELECT COUNT(*) FROM turn_jobs "
                "WHERE session_id = :sid AND status = 'claimed'"
            ),
            {"sid": session_id},
        )
        claimed_count: int = busy_result.scalar() or 0

        # Insert the new job
        await db.execute(
            text("""
                INSERT INTO turn_jobs (id, session_id, payload, status, created_at)
                VALUES (:id, :session_id, :payload::jsonb, 'pending', :now)
            """),
            {
                "id": job_id,
                "session_id": session_id,
                "payload": __import__("json").dumps(payload),
                "now": datetime.now(timezone.utc),
            },
        )
        await db.commit()

    return job_id, claimed_count > 0
