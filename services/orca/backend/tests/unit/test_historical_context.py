"""Unit tests for historical_context.py — pgvector semantic search."""

from typing import Any
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from app.agent.rca_state import AlertContext


@pytest.fixture
def sample_alert() -> AlertContext:
    return AlertContext(
        alert_id="test-001",
        alert_name="HighErrorRate",
        description="Error rate exceeded 5% on checkout service",
        service="checkout-service",
        environment="production",
        labels={"severity": "critical"},
        org_id=1,
    )


def _make_db_row(**kwargs: Any) -> MagicMock:
    """Build a mock DB row with attribute access."""
    row = MagicMock()
    for k, v in kwargs.items():
        setattr(row, k, v)
    return row


@pytest.mark.asyncio
async def test_gather_historical_context_returns_top_results(sample_alert: AlertContext):
    """Should return list of similar past RCAs from pgvector query."""
    from app.agent.historical_context import gather_historical_context

    from datetime import datetime, timezone
    fake_dt = datetime(2024, 1, 10, tzinfo=timezone.utc)
    fake_row = _make_db_row(
        alert_type="HighErrorRate",
        service="checkout-service",
        final_hypothesis="DB connection pool exhaustion",
        final_confidence=0.85,
        accepted_at=fake_dt,
        distance=0.12,
    )

    mock_result = MagicMock()
    mock_result.fetchall.return_value = [fake_row]

    mock_session = AsyncMock()
    mock_session.execute = AsyncMock(return_value=mock_result)

    mock_ctx_manager = MagicMock()
    mock_ctx_manager.__aenter__ = AsyncMock(return_value=mock_session)
    mock_ctx_manager.__aexit__ = AsyncMock(return_value=False)

    with patch("app.agent.historical_context.embed_text", new_callable=AsyncMock, return_value=[0.1] * 1536):
        with patch("app.agent.historical_context.AsyncSessionLocal", return_value=mock_ctx_manager):
            results = await gather_historical_context(sample_alert, limit=5)

    assert len(results) == 1
    assert results[0]["alert_type"] == "HighErrorRate"
    assert results[0]["final_hypothesis"] == "DB connection pool exhaustion"
    assert results[0]["similarity"] == pytest.approx(1.0 - 0.12)


@pytest.mark.asyncio
async def test_gather_historical_context_returns_empty_on_db_failure(sample_alert: AlertContext):
    """Should return empty list (not raise) if DB query fails."""
    from app.agent.historical_context import gather_historical_context

    with patch("app.agent.historical_context.embed_text", new_callable=AsyncMock, return_value=[0.1] * 1536):
        with patch("app.agent.historical_context.AsyncSessionLocal", side_effect=Exception("DB down")):
            results = await gather_historical_context(sample_alert)

    assert results == []


@pytest.mark.asyncio
async def test_gather_historical_context_returns_empty_on_embed_failure(sample_alert: AlertContext):
    """Should return empty list (not raise) if embedding fails."""
    from app.agent.historical_context import gather_historical_context

    with patch("app.agent.historical_context.embed_text", new_callable=AsyncMock, side_effect=ValueError("embed fail")):
        results = await gather_historical_context(sample_alert)

    assert results == []


@pytest.mark.asyncio
async def test_embed_text_returns_unit_vector():
    """embed_text should return a 1536-dimensional unit vector."""
    import math
    from app.agent.historical_context import embed_text

    vec = await embed_text("test alert description")

    assert len(vec) == 1536
    magnitude = math.sqrt(sum(v * v for v in vec))
    assert magnitude == pytest.approx(1.0, abs=1e-6)
