"""Tests for harness/slack/idempotency.py — Slack event deduplication."""

from __future__ import annotations

import pytest
import pytest_asyncio
from datetime import datetime, timezone, timedelta
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from harness.slack.idempotency import SlackEventDedup


_DDL = """
CREATE TABLE IF NOT EXISTS slack_events (
    event_id TEXT PRIMARY KEY,
    created_at TEXT NOT NULL
);
"""


@pytest_asyncio.fixture(scope="module")
async def dedup_engine():
    engine = create_async_engine("sqlite+aiosqlite:///:memory:", echo=False)
    async with engine.begin() as conn:
        await conn.execute(text(_DDL))
    yield engine
    await engine.dispose()


@pytest_asyncio.fixture
async def dedup_db(dedup_engine) -> AsyncSession:
    Session = async_sessionmaker(bind=dedup_engine, class_=AsyncSession, expire_on_commit=False)
    async with Session() as session:
        yield session
        # Clean up between tests
        await session.execute(text("DELETE FROM slack_events"))
        await session.commit()


class TestSlackEventDedup:
    async def test_new_event_is_not_duplicate(self, dedup_db: AsyncSession):
        """A fresh event ID returns is_duplicate=False."""
        dedup = SlackEventDedup()
        result = await dedup.is_duplicate("evt-001", dedup_db)
        assert result is False

    async def test_after_mark_seen_is_duplicate(self, dedup_db: AsyncSession):
        """After mark_seen, the same event ID returns is_duplicate=True."""
        dedup = SlackEventDedup()
        await dedup.mark_seen("evt-002", dedup_db)
        result = await dedup.is_duplicate("evt-002", dedup_db)
        assert result is True

    async def test_different_event_ids_are_independent(self, dedup_db: AsyncSession):
        """Marking event A does not affect event B."""
        dedup = SlackEventDedup()
        await dedup.mark_seen("evt-003", dedup_db)
        result = await dedup.is_duplicate("evt-004", dedup_db)
        assert result is False

    async def test_mark_seen_twice_does_not_raise(self, dedup_db: AsyncSession):
        """mark_seen is idempotent — calling twice does not raise."""
        dedup = SlackEventDedup()
        await dedup.mark_seen("evt-005", dedup_db)
        await dedup.mark_seen("evt-005", dedup_db)  # second call — should not raise

    async def test_ttl_pruning_removes_old_rows(self, dedup_db: AsyncSession):
        """Rows older than ttl_days are deleted on mark_seen."""
        dedup = SlackEventDedup(ttl_days=0)  # TTL of 0 days — all existing rows are old

        # Pre-seed an old event
        old_time = (datetime.now(timezone.utc) - timedelta(days=10)).isoformat()
        await dedup_db.execute(
            text("INSERT INTO slack_events (event_id, created_at) VALUES ('evt-old', :ts)"),
            {"ts": old_time},
        )
        await dedup_db.flush()

        # mark_seen should prune the old row
        await dedup.mark_seen("evt-new-for-ttl", dedup_db)

        old_row = (
            await dedup_db.execute(
                text("SELECT 1 FROM slack_events WHERE event_id = 'evt-old'")
            )
        ).fetchone()
        assert old_row is None
