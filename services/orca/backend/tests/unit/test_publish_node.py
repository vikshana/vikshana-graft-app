"""Unit tests for the publish node."""

import uuid
from datetime import datetime, timezone
from typing import Any
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from app.agent.nodes.publish import run_publish
from app.agent.state import OrcaState
from app.models.rca import RCA

VALID_LABELS: dict[str, str] = {
    "alertname": "HighLatency",
    "service_name": "checkout-service",
    "deployment_environment_name": "production",
    "domain": "commerce",
    "legal_company": "acme-corp",
    "sub_domain": "checkout",
    "system_id": "sys-001",
    "team": "checkout-team",
    "version": "1.2.3",
}


def make_state(rca_id: str | None = None, **overrides: Any) -> OrcaState:
    """Create a fully-completed OrcaState ready for publishing."""
    _rca_id = rca_id or str(uuid.uuid4())
    base: OrcaState = OrcaState(
        rca_id=_rca_id,
        alert_payload={"status": "firing", "labels": VALID_LABELS},
        alert_labels=VALID_LABELS,
        alert_name="HighLatency",
        severity="critical",
        investigation_steps=[],
        step_count=10,
        total_tokens_used=25000,
        evidence=[],
        similar_past_alerts=[],
        related_rcas=[],
        root_cause="Memory leak in checkout-service",
        contributing_factors=["No memory limits"],
        timeline=[{"timestamp": "2024-01-15T14:47:00Z", "event": "Alert fired"}],
        impact_summary="~15 min outage, ~2000 users affected",
        confidence_level="high",
        confidence_reasoning="Clear correlation with deployment",
        report_markdown="# RCA: HighLatency\n\n## 1. Summary\n\nCheckout service experienced high latency.",
        status="investigating",
        error_message=None,
    )
    base.update(overrides)  # type: ignore[attr-defined]
    return base


def make_rca_record(rca_id: uuid.UUID) -> RCA:
    """Create a minimal RCA model instance for mocking."""
    rca = RCA(
        id=rca_id,
        alert_name="HighLatency",
        status="investigating",
        started_at=datetime.now(timezone.utc),
    )
    return rca


class TestPublishNode:
    """Tests for the publish node."""

    @pytest.mark.asyncio
    async def test_successful_publish_sets_complete_status(self) -> None:
        """Publish node should set status=complete when DB write succeeds."""
        rca_id = uuid.uuid4()
        state = make_state(rca_id=str(rca_id))
        mock_rca = make_rca_record(rca_id)

        mock_session = AsyncMock()
        mock_session.get = AsyncMock(return_value=mock_rca)
        mock_session.add = MagicMock()
        mock_session.commit = AsyncMock()

        mock_session_ctx = MagicMock()
        mock_session_ctx.__aenter__ = AsyncMock(return_value=mock_session)
        mock_session_ctx.__aexit__ = AsyncMock(return_value=None)

        with (
            patch("app.agent.nodes.publish.AsyncSessionLocal", return_value=mock_session_ctx),
            patch("app.agent.nodes.publish.send_slack_notification", new=AsyncMock()),
        ):
            result = await run_publish(state)

        assert result["status"] == "complete"

    @pytest.mark.asyncio
    async def test_publish_updates_rca_report_and_root_cause(self) -> None:
        """Publish node should write report_markdown and root_cause to the RCA record."""
        rca_id = uuid.uuid4()
        state = make_state(rca_id=str(rca_id))
        mock_rca = make_rca_record(rca_id)

        mock_session = AsyncMock()
        mock_session.get = AsyncMock(return_value=mock_rca)
        mock_session.add = MagicMock()
        mock_session.commit = AsyncMock()

        mock_session_ctx = MagicMock()
        mock_session_ctx.__aenter__ = AsyncMock(return_value=mock_session)
        mock_session_ctx.__aexit__ = AsyncMock(return_value=None)

        with (
            patch("app.agent.nodes.publish.AsyncSessionLocal", return_value=mock_session_ctx),
            patch("app.agent.nodes.publish.send_slack_notification", new=AsyncMock()),
        ):
            await run_publish(state)

        assert mock_rca.report_markdown is not None
        assert "HighLatency" in mock_rca.report_markdown
        assert mock_rca.root_cause == "Memory leak in checkout-service"
        assert mock_rca.confidence_level == "high"
        assert mock_rca.status == "complete"

    @pytest.mark.asyncio
    async def test_publish_calls_slack_when_configured(self) -> None:
        """Publish node should call Slack notification when SLACK_WEBHOOK_URL is set."""
        rca_id = uuid.uuid4()
        state = make_state(rca_id=str(rca_id))
        mock_rca = make_rca_record(rca_id)

        mock_session = AsyncMock()
        mock_session.get = AsyncMock(return_value=mock_rca)
        mock_session.add = MagicMock()
        mock_session.commit = AsyncMock()

        mock_session_ctx = MagicMock()
        mock_session_ctx.__aenter__ = AsyncMock(return_value=mock_session)
        mock_session_ctx.__aexit__ = AsyncMock(return_value=None)

        mock_slack = AsyncMock()

        with (
            patch("app.agent.nodes.publish.AsyncSessionLocal", return_value=mock_session_ctx),
            patch("app.agent.nodes.publish.send_slack_notification", new=mock_slack),
            patch("app.agent.nodes.publish.settings") as mock_settings,
        ):
            mock_settings.SLACK_WEBHOOK_URL = "https://hooks.slack.com/test"
            mock_settings.FRONTEND_URL = "http://localhost:3000"

            await run_publish(state)

        mock_slack.assert_called_once()

    @pytest.mark.asyncio
    async def test_publish_skips_slack_when_not_configured(self) -> None:
        """Publish node should not call Slack when SLACK_WEBHOOK_URL is empty."""
        rca_id = uuid.uuid4()
        state = make_state(rca_id=str(rca_id))
        mock_rca = make_rca_record(rca_id)

        mock_session = AsyncMock()
        mock_session.get = AsyncMock(return_value=mock_rca)
        mock_session.add = MagicMock()
        mock_session.commit = AsyncMock()

        mock_session_ctx = MagicMock()
        mock_session_ctx.__aenter__ = AsyncMock(return_value=mock_session)
        mock_session_ctx.__aexit__ = AsyncMock(return_value=None)

        mock_slack = AsyncMock()

        with (
            patch("app.agent.nodes.publish.AsyncSessionLocal", return_value=mock_session_ctx),
            patch("app.agent.nodes.publish.send_slack_notification", new=mock_slack),
            patch("app.agent.nodes.publish.settings") as mock_settings,
        ):
            mock_settings.SLACK_WEBHOOK_URL = ""  # Not configured
            mock_settings.FRONTEND_URL = "http://localhost:3000"

            await run_publish(state)

        mock_slack.assert_not_called()

    @pytest.mark.asyncio
    async def test_rca_not_found_returns_failed_status(self) -> None:
        """Publish node should return failed status when RCA record is not found."""
        rca_id = uuid.uuid4()
        state = make_state(rca_id=str(rca_id))

        mock_session = AsyncMock()
        mock_session.get = AsyncMock(return_value=None)  # RCA not found

        mock_session_ctx = MagicMock()
        mock_session_ctx.__aenter__ = AsyncMock(return_value=mock_session)
        mock_session_ctx.__aexit__ = AsyncMock(return_value=None)

        with patch("app.agent.nodes.publish.AsyncSessionLocal", return_value=mock_session_ctx):
            result = await run_publish(state)

        assert result["status"] == "failed"
        assert result["error_message"] is not None

    @pytest.mark.asyncio
    async def test_db_failure_sets_failed_status(self) -> None:
        """When the DB write fails, publish should return failed status gracefully."""
        rca_id = uuid.uuid4()
        state = make_state(rca_id=str(rca_id))
        mock_rca = make_rca_record(rca_id)

        # First session raises on commit, second session (for failure update) succeeds
        call_count = {"n": 0}

        mock_failing_session = AsyncMock()
        mock_failing_session.get = AsyncMock(return_value=mock_rca)
        mock_failing_session.add = MagicMock()
        mock_failing_session.commit = AsyncMock(side_effect=Exception("DB connection lost"))

        mock_recovery_session = AsyncMock()
        mock_recovery_session.get = AsyncMock(return_value=mock_rca)
        mock_recovery_session.commit = AsyncMock()

        def session_factory() -> MagicMock:
            call_count["n"] += 1
            ctx = MagicMock()
            session = mock_failing_session if call_count["n"] == 1 else mock_recovery_session
            ctx.__aenter__ = AsyncMock(return_value=session)
            ctx.__aexit__ = AsyncMock(return_value=None)
            return ctx

        with patch("app.agent.nodes.publish.AsyncSessionLocal", side_effect=session_factory):
            result = await run_publish(state)

        assert result["status"] == "failed"
        assert result["error_message"] is not None

