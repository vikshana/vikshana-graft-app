"""Unit tests for the analyze node."""

import json
import uuid
from typing import Any
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from app.agent.nodes.analyze import run_analyze, _parse_analysis_response, _build_analysis_prompt
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

SAMPLE_EVIDENCE: list[dict[str, Any]] = [
    {
        "type": "tool_call",
        "tool": "query_prometheus",
        "query": 'rate(http_requests_total[5m])',
        "result": '{"data": {"result": [{"metric": {"job": "checkout"}, "value": [1705329600, "0.85"]}]}}',
        "step": 2,
    },
    {
        "type": "tool_call",
        "tool": "query_loki",
        "query": '{service="checkout"} |= "error"',
        "result": "2024-01-15T14:45:00Z WARN Memory pressure detected: heap at 95%",
        "step": 3,
    },
]


def make_state(**overrides: Any) -> OrcaState:
    """Create a minimal OrcaState for analyze node testing."""
    base: OrcaState = OrcaState(
        rca_id=str(uuid.uuid4()),
        alert_payload={"status": "firing", "labels": VALID_LABELS, "annotations": {}},
        alert_labels=VALID_LABELS,
        alert_name="HighLatency",
        severity="critical",
        investigation_steps=[],
        step_count=8,
        total_tokens_used=12000,
        evidence=SAMPLE_EVIDENCE,
        similar_past_alerts=[],
        related_rcas=[
            {
                "id": str(uuid.uuid4()),
                "alert_name": "HighLatency",
                "root_cause": "Memory leak in checkout v1.2.0",
                "confidence_level": "high",
                "created_at": "2024-01-10T10:00:00Z",
            }
        ],
        root_cause="",
        contributing_factors=[],
        timeline=[],
        impact_summary="",
        confidence_level="low",
        confidence_reasoning="",
        report_markdown="",
        status="investigating",
        error_message=None,
    )
    base.update(overrides)  # type: ignore[attr-defined]
    return base


class TestAnalyzeNode:
    """Tests for the analyze node."""

    @pytest.mark.asyncio
    async def test_successful_analysis_populates_state(self) -> None:
        """Analysis node should populate all analysis fields in the state."""
        state = make_state()

        mock_response = MagicMock()
        mock_response.content = json.dumps({
            "root_cause": "Memory leak in checkout-service v1.2.3 causing heap exhaustion",
            "contributing_factors": ["No circuit breaker", "High traffic during sale event"],
            "timeline": [
                {"timestamp": "2024-01-15T14:30:00Z", "event": "Deployment of v1.2.3"},
                {"timestamp": "2024-01-15T14:45:00Z", "event": "Memory usage spiked to 95%"},
                {"timestamp": "2024-01-15T14:47:00Z", "event": "Alert fired"},
            ],
            "impact_summary": "Checkout service unavailable for ~15 minutes affecting ~2000 users",
            "confidence_level": "high",
            "confidence_reasoning": "Logs clearly show memory pressure, correlates with deployment timing",
        })
        mock_response.usage_metadata = {"total_tokens": 2500}

        with (
            patch("app.agent.nodes.analyze.ChatAnthropic") as mock_llm_class,
            patch("app.agent.nodes.analyze._write_step", new=AsyncMock()),
        ):
            mock_llm = AsyncMock()
            mock_llm.ainvoke = AsyncMock(return_value=mock_response)
            mock_llm_class.return_value = mock_llm

            result = await run_analyze(state)

        assert result["root_cause"] == "Memory leak in checkout-service v1.2.3 causing heap exhaustion"
        assert len(result["contributing_factors"]) == 2
        assert len(result["timeline"]) == 3
        assert result["confidence_level"] == "high"
        assert result["impact_summary"] != ""

    @pytest.mark.asyncio
    async def test_tokens_accumulated_from_analysis(self) -> None:
        """Token usage from analysis should be added to the running total."""
        state = make_state()
        initial_tokens = state["total_tokens_used"]

        mock_response = MagicMock()
        mock_response.content = json.dumps({
            "root_cause": "Disk I/O bottleneck",
            "contributing_factors": [],
            "timeline": [],
            "impact_summary": "Some services degraded",
            "confidence_level": "medium",
            "confidence_reasoning": "Limited evidence",
        })
        mock_response.usage_metadata = {"total_tokens": 3000}

        with (
            patch("app.agent.nodes.analyze.ChatAnthropic") as mock_llm_class,
            patch("app.agent.nodes.analyze._write_step", new=AsyncMock()),
        ):
            mock_llm = AsyncMock()
            mock_llm.ainvoke = AsyncMock(return_value=mock_response)
            mock_llm_class.return_value = mock_llm

            result = await run_analyze(state)

        assert result["total_tokens_used"] == initial_tokens + 3000

    @pytest.mark.asyncio
    async def test_llm_failure_returns_low_confidence_result(self) -> None:
        """When LLM fails, analysis should return a degraded result with low confidence."""
        state = make_state()

        with (
            patch("app.agent.nodes.analyze.ChatAnthropic") as mock_llm_class,
            patch("app.agent.nodes.analyze._write_step", new=AsyncMock()),
        ):
            mock_llm = AsyncMock()
            mock_llm.ainvoke = AsyncMock(side_effect=Exception("API rate limit exceeded"))
            mock_llm_class.return_value = mock_llm

            result = await run_analyze(state)

        # Should not raise — graceful degradation
        assert result["confidence_level"] == "low"
        assert "error" in result["root_cause"].lower() or "failed" in result["root_cause"].lower()

    @pytest.mark.asyncio
    async def test_step_count_incremented(self) -> None:
        """Step count should increment after the analysis node runs."""
        state = make_state(step_count=8)

        mock_response = MagicMock()
        mock_response.content = json.dumps({
            "root_cause": "Network partition",
            "contributing_factors": [],
            "timeline": [],
            "impact_summary": "Partial outage",
            "confidence_level": "medium",
            "confidence_reasoning": "Partial data",
        })
        mock_response.usage_metadata = {"total_tokens": 1000}

        with (
            patch("app.agent.nodes.analyze.ChatAnthropic") as mock_llm_class,
            patch("app.agent.nodes.analyze._write_step", new=AsyncMock()),
        ):
            mock_llm = AsyncMock()
            mock_llm.ainvoke = AsyncMock(return_value=mock_response)
            mock_llm_class.return_value = mock_llm

            result = await run_analyze(state)

        assert result["step_count"] == 9


class TestParseAnalysisResponse:
    """Tests for the _parse_analysis_response helper."""

    def test_parses_valid_json_response(self) -> None:
        """Should parse a clean JSON response into a dict."""
        response = json.dumps({
            "root_cause": "OOM kill",
            "contributing_factors": ["No memory limits"],
            "timeline": [],
            "impact_summary": "Service restarted",
            "confidence_level": "high",
            "confidence_reasoning": "Clear OOM event in logs",
        })
        result = _parse_analysis_response(response)
        assert result["root_cause"] == "OOM kill"
        assert result["confidence_level"] == "high"

    def test_parses_json_in_code_block(self) -> None:
        """Should extract JSON from a markdown ```json code block."""
        response = '```json\n{"root_cause": "CPU throttling", "confidence_level": "medium"}\n```'
        result = _parse_analysis_response(response)
        assert result["root_cause"] == "CPU throttling"

    def test_handles_invalid_json_with_fallback(self) -> None:
        """Should return a low-confidence fallback when JSON is invalid."""
        result = _parse_analysis_response("This is not JSON at all.")
        assert result["confidence_level"] == "low"
        assert "root_cause" in result


class TestBuildAnalysisPrompt:
    """Tests for the _build_analysis_prompt helper."""

    def test_includes_evidence_count(self) -> None:
        """Prompt should mention the number of evidence items."""
        state = make_state()
        prompt = _build_analysis_prompt(state)
        assert str(len(SAMPLE_EVIDENCE)) in prompt

    def test_includes_historical_rca_context(self) -> None:
        """Prompt should include related past RCAs."""
        state = make_state()
        prompt = _build_analysis_prompt(state)
        assert "Memory leak" in prompt or "Related Past RCAs" in prompt

    def test_includes_service_context(self) -> None:
        """Prompt should include the service name and environment."""
        state = make_state()
        prompt = _build_analysis_prompt(state)
        assert "checkout-service" in prompt
        assert "production" in prompt

