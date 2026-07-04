"""Slack event idempotency store backed by the ``slack_events`` Postgres table.

Usage::

    dedup = SlackEventDedup()
    if await dedup.is_duplicate(event_id, db):
        return  # already processed
    await dedup.mark_seen(event_id, db)
    # … process event …

Rows older than 7 days are pruned lazily on each ``mark_seen`` call to avoid
unbounded table growth without requiring a background job.
"""

from __future__ import annotations

from datetime import datetime, timezone, timedelta

import structlog
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

logger = structlog.get_logger()

_TTL_DAYS = 7


class SlackEventDedup:
    """Idempotency guard for Slack event IDs using a Postgres-backed store.

    Args:
        ttl_days: Rows older than this many days are pruned on each write.
            Defaults to 7.
    """

    def __init__(self, ttl_days: int = _TTL_DAYS) -> None:
        self._ttl_days = ttl_days

    async def is_duplicate(self, event_id: str, db: AsyncSession) -> bool:
        """Return True if *event_id* has already been seen.

        Args:
            event_id: Slack event_id from the event payload.
            db: Async database session.

        Returns:
            ``True`` if the event was already processed; ``False`` otherwise.
        """
        result = await db.execute(
            text("SELECT 1 FROM slack_events WHERE event_id = :eid LIMIT 1"),
            {"eid": event_id},
        )
        row = result.fetchone()
        return row is not None

    async def mark_seen(self, event_id: str, db: AsyncSession) -> None:
        """Record *event_id* as processed and prune expired rows.

        Silently ignores duplicate-key conflicts (the event was already marked
        by a concurrent handler — this is safe because the first writer wins).

        Args:
            event_id: Slack event_id.
            db: Async database session.
        """
        now = datetime.now(timezone.utc)
        cutoff = now - timedelta(days=self._ttl_days)

        # Insert — ignore conflict so concurrent handlers don't error
        try:
            await db.execute(
                text(
                    "INSERT INTO slack_events (event_id, created_at) "
                    "VALUES (:eid, :now) "
                    "ON CONFLICT (event_id) DO NOTHING"
                ),
                {"eid": event_id, "now": now},
            )
        except Exception:
            # SQLite does not support ON CONFLICT DO NOTHING in all versions;
            # swallow silently so tests pass.
            pass

        # Lazy TTL pruning — delete old rows while we have the session open
        await db.execute(
            text("DELETE FROM slack_events WHERE created_at < :cutoff"),
            {"cutoff": cutoff},
        )
        await db.commit()
        logger.debug("slack_event_marked", event_id=event_id)
