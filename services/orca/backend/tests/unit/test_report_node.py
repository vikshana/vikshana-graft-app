"""Unit tests for the report node."""

import uuid
from typing import Any
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from app.agent.nodes.report import run_report, _generate_fallback_report, _format_evidence
from app.agent.state import OrcaState

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


def make_state(**overrides: Any) -> OrcaState:
    """Create a fully-analysed OrcaState ready for report generation."""
    base: OrcaState = OrcaState(
        rca_id=str(uuid.uuid4()),
        alert_payload={"status": "firing", "labels": VALID_LABELS, "startsAt": "2024-01-15T14:47:00Z"},
        alert_labels=VALID_LABELS,
        alert_name="HighLatency",
        severity="critical",
        investigation_steps=[],
        step_count=9,
        total_tokens_used=18000,
        evidence=[
            {"type": "tool_call", "tool": "query_prometheus", "query": "rate(http_requests_total[5m])", "result": "0.85", "step": 2},
        ],
        similar_past_alerts=[],
        related_rcas=[],
        root_cause="Memory leak in checkout-service v1.2.3 causing heap exhaustion under load",
        contributing_factors=["No memory limits configured", "High traffic during sale event"],
        timeline=[
            {"timestamp": "2024-01-15T14:30:00Z", "event": "Deployment of v1.2.3"},
            {"timestamp": "2024-01-15T14:47:00Z", "event": "Alert fired"},
        ],
        impact_summary="Checkout unavailable for ~15 min, ~2000 users affected",
        confidence_level="high",
        confidence_reasoning="Logs clearly show memory pressure correlating with deployment",
        report_markdown="",
        status="investigating",
        error_message=None,
    )
    base.update(overrides)  # type: ignore[attr-defined]
    return base


class TestReportNode:
    """Tests for the report node."""

    @pytest.mark.asyncio
    async def test_successful_report_populates_markdown(self) -> None:
        """Report node should write the generated markdown into the state."""
        state = make_state()
        expected_report = (
            "# RCA: HighLatency\n\n## 1. Summary\n\nCheckout service experienced high latency...\n"
            "## 2. Confidence Level\n\n**HIGH**\n\n## 6. Root Cause\n\nMemory leak..."
        )

        mock_response = MagicMock()
        mock_response.content = expected_report
        mock_response.usage_metadata = {"total_tokens": 4000}

        with (
            patch("app.agent.nodes.report.ChatAnthropic") as mock_llm_class,
            patch("app.agent.nodes.report._write_step", new=AsyncMock()),
        ):
            mock_llm = AsyncMock()
            mock_llm.ainvoke = AsyncMock(return_value=mock_response)
            mock_llm_class.return_value = mock_llm

            result = await run_report(state)

        assert result["report_markdown"] == expected_report
        assert result["total_tokens_used"] == 18000 + 4000

    @pytest.mark.asyncio
    async def test_llm_failure_uses_fallback_report(self) -> None:
        """When LLM fails, a minimal fallback report should be generated."""
        state = make_state()

        with (
            patch("app.agent.nodes.report.ChatAnthropic") as mock_llm_class,
            patch("app.agent.nodes.report._write_step", new=AsyncMock()),
        ):
            mock_llm = AsyncMock()
            mock_llm.ainvoke = AsyncMock(side_effect=Exception("Context window exceeded"))
            mock_llm_class.return_value = mock_llm

            result = await run_report(state)

        # Fallback report should still be generated
        assert result["report_markdown"] != ""
        assert "HighLatency" in result["report_markdown"]

    @pytest.mark.asyncio
    async def test_step_count_incremented(self) -> None:
        """Step count should increment after the report node runs."""
        state = make_state(step_count=9)

        mock_response = MagicMock()
        mock_response.content = "# Report\n\nContent here."
        mock_response.usage_metadata = {"total_tokens": 1000}

        with (
            patch("app.agent.nodes.report.ChatAnthropic") as mock_llm_class,
            patch("app.agent.nodes.report._write_step", new=AsyncMock()),
        ):
            mock_llm = AsyncMock()
            mock_llm.ainvoke = AsyncMock(return_value=mock_response)
            mock_llm_class.return_value = mock_llm

            result = await run_report(state)

        assert result["step_count"] == 10

    @pytest.mark.asyncio
    async def test_report_uses_sonnet_model(self) -> None:
        """Report node should use claude-sonnet model."""
        state = make_state()

        mock_response = MagicMock()
        mock_response.content = "# Report"
        mock_response.usage_metadata = {"total_tokens": 500}

        with (
            patch("app.agent.nodes.report.ChatAnthropic") as mock_llm_class,
            patch("app.agent.nodes.report._write_step", new=AsyncMock()),
        ):
            mock_llm = AsyncMock()
            mock_llm.ainvoke = AsyncMock(return_value=mock_response)
            mock_llm_class.return_value = mock_llm

            await run_report(state)

        # Verify Claude Sonnet was requested
        call_kwargs = mock_llm_class.call_args.kwargs
        assert "sonnet" in call_kwargs.get("model", "").lower()


class TestFallbackReport:
    """Tests for the _generate_fallback_report helper."""

    def test_fallback_contains_alert_name(self) -> None:
        """Fallback report should include the alert name in the title."""
        state = make_state()
        report = _generate_fallback_report(state)
        assert "HighLatency" in report

    def test_fallback_contains_service_name(self) -> None:
        """Fallback report should mention the service name."""
        state = make_state()
        report = _generate_fallback_report(state)
        assert "checkout-service" in report

    def test_fallback_contains_confidence_level(self) -> None:
        """Fallback report should include the confidence level."""
        state = make_state()
        report = _generate_fallback_report(state)
        assert "HIGH" in report.upper()

    def test_fallback_contains_root_cause(self) -> None:
        """Fallback report should include the root cause."""
        state = make_state()
        report = _generate_fallback_report(state)
        assert "Memory leak" in report

    def test_fallback_contains_contributing_factors(self) -> None:
        """Fallback report should list contributing factors."""
        state = make_state()
        report = _generate_fallback_report(state)
        assert "No memory limits configured" in report


class TestFormatEvidence:
    """Tests for the _format_evidence helper."""

    def test_formats_tool_call_evidence(self) -> None:
        """Should format tool call evidence as a bulleted list."""
        evidence = [
            {
                "type": "tool_call",
                "tool": "query_prometheus",
                "query": "rate(requests[5m])",
                "result": "0.85 req/s",
                "step": 1,
            }
        ]
        result = _format_evidence(evidence)
        assert "query_prometheus" in result
        assert "rate(requests[5m])" in result

    def test_returns_message_for_empty_evidence(self) -> None:
        """Should return 'No evidence gathered' for an empty list."""
        result = _format_evidence([])
        assert "No evidence" in result

    def test_limits_evidence_to_20_items(self) -> None:
        """Should cap evidence formatting at 20 items to avoid prompt overflow."""
        evidence = [
            {"type": "tool_call", "tool": f"tool_{i}", "query": f"q{i}", "result": f"r{i}", "step": i}
            for i in range(30)
        ]
        result = _format_evidence(evidence)
        # Should not include all 30 items
        assert "tool_20" not in result

