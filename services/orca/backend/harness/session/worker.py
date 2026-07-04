"""TurnWorker — stateless Postgres-backed turn job queue.

Each FastAPI worker process runs one ``TurnWorker`` instance in the background
(started as an ``asyncio.Task`` in the app lifespan).  Any worker replica can
claim and execute any pending turn job, making the system horizontally scalable
without session affinity.

Claim protocol:
  1. ``SELECT ... FOR UPDATE SKIP LOCKED`` on ``turn_jobs`` (status=pending).
  2. ``pg_advisory_xact_lock(hashtext(session_id))`` serialises concurrent
     turns within the same session (at most one active turn per session).
  3. Execute the turn via ``GraphRegistry``.
  4. Mark job ``done`` or ``failed``.

Concurrency model:
  - Multiple turn requests for the same session are queued as separate
    ``TurnJob`` rows.  The first is claimed and executed; subsequent ones
    remain ``pending`` until the lock is released.
  - Callers that hit an already-active session receive an ``agent_busy``
    event immediately without blocking.

Configuration:
  ``TURN_WORKER_POLL_MS``  — poll interval when queue is empty (default 200ms).
  ``TURN_WORKER_ID``       — optional worker identifier for observability.
"""

from __future__ import annotations

import asyncio
import os
import socket
import uuid
from datetime import datetime, timezone
from typing import Any

import structlog
from sqlalchemy import text

from app.db import AsyncSessionLocal
from harness.session.registry import graph_registry

logger = structlog.get_logger()

# Default poll interval when the queue is empty
_DEFAULT_POLL_MS = int(os.environ.get("TURN_WORKER_POLL_MS", "200"))

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
    """

    def __init__(
        self,
        poll_ms: int = _DEFAULT_POLL_MS,
        worker_id: str = _WORKER_ID,
        stop_event: asyncio.Event | None = None,
    ) -> None:
        self._poll_ms = poll_ms
        self._worker_id = worker_id
        self._stop_event = stop_event or asyncio.Event()
        self._processed = 0

    async def run_loop(self) -> None:
        """Main poll loop — runs until the stop event is set.

        Logs each processed job and any unexpected exceptions.
        Sleeps between empty polls to avoid hammering the DB.
        """
        log = logger.bind(worker_id=self._worker_id)
        log.info("turn_worker_started", poll_ms=self._poll_ms)

        while not self._stop_event.is_set():
            try:
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

    async def _poll_once(self) -> bool:
        """Attempt to claim and execute one pending turn job.

        Returns:
            True if a job was processed, False if the queue was empty.
        """
        async with AsyncSessionLocal() as db:
            # Claim one pending job with SKIP LOCKED
            claim_result = await db.execute(
                text("""
                    UPDATE turn_jobs
                    SET status = 'claimed',
                        claimed_at = :now,
                        worker_id = :worker_id
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

            # Advisory lock: one active turn per session (hash to int)
            await db.execute(
                text("SELECT pg_advisory_xact_lock(hashtext(:sid))"),
                {"sid": session_id},
            )
            await db.commit()

        # Execute the turn outside the claiming transaction
        log = logger.bind(
            worker_id=self._worker_id,
            job_id=job_id,
            session_id=session_id,
        )
        log.info("turn_job_claimed")

        try:
            await self._execute_turn(session_id, payload)
            await self._mark_job(job_id, "done")
            self._processed += 1
            log.info("turn_job_done")
            return True
        except Exception as exc:
            log.error("turn_job_failed", error=str(exc), exc_info=True)
            await self._mark_job(job_id, "failed")
            return True  # Still counts as "processed" (not an empty queue)

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
            graph = graph_registry.get(session_type)
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

        # Best-effort Slack notification — failures are swallowed inside the notifier
        try:
            from harness.slack.notifier import SlackNotifier
            from app.config import settings
            if settings.SLACK_BOT_TOKEN:
                notifier = SlackNotifier()
                await notifier.post_turn_result(session_id, payload, turn_result=turn_result)
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
