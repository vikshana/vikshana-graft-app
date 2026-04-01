"""Unit tests for the investigate node."""

import json
import uuid
from typing import Any
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from app.agent.nodes.investigate import run_investigate, _build_investigation_prompt, _extract_historical_context
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
    "severity": "critical",
}


def make_state(**overrides: Any) -> OrcaState:
    """Create a minimal OrcaState for investigation node testing."""
    base: OrcaState = OrcaState(
        rca_id=str(uuid.uuid4()),
        alert_payload={"status": "firing", "labels": VALID_LABELS, "annotations": {}},
        alert_labels=VALID_LABELS,
        alert_name="HighLatency",
        severity="critical",
        investigation_steps=[],
        step_count=1,
        total_tokens_used=0,
        evidence=[],
        similar_past_alerts=[],
        related_rcas=[],
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


class TestInvestigateNode:
    """Tests for the investigate node."""

    @pytest.mark.asyncio
    async def test_mcp_connection_failure_continues_gracefully(self) -> None:
        """When MCP connection fails, investigation should continue with empty evidence."""
        state = make_state()

        with patch(
            "app.agent.nodes.investigate.MultiServerMCPClient",
            side_effect=Exception("MCP server not available"),
        ):
            result = await run_investigate(state)

        # Should not raise — graceful degradation
        assert "investigation_steps" in result
        assert "evidence" in result
        # Error recorded in investigation steps
        assert any(
            "error" in str(step) or "mcp_connection_failed" in str(step)
            for step in result["investigation_steps"]
        )

    @pytest.mark.asyncio
    async def test_agent_exits_when_no_tool_calls(self) -> None:
        """When the LLM returns no tool calls, the loop should exit."""
        state = make_state()

        # Mock MCP client returning some tools
        mock_tool = MagicMock()
        mock_tool.name = "query_prometheus"
        mock_tool.ainvoke = AsyncMock(return_value="CPU: 45%")

        # Mock LLM returning a final answer without tool calls
        mock_response = MagicMock()
        mock_response.content = json.dumps({
            "investigation_complete": True,
            "evidence_summary": "CPU is normal, likely a transient spike",
            "suggested_root_cause": "Memory pressure under load",
        })
        mock_response.usage_metadata = {"total_tokens": 800}
        mock_response.tool_calls = []  # No tool calls → exit loop

        mock_llm = MagicMock()
        mock_llm.bind_tools = MagicMock(return_value=mock_llm)
        mock_llm.ainvoke = AsyncMock(return_value=mock_response)

        mock_mcp_context = MagicMock()
        mock_mcp_context.__aenter__ = AsyncMock(return_value=mock_mcp_context)
        mock_mcp_context.__aexit__ = AsyncMock(return_value=None)
        mock_mcp_context.get_tools = MagicMock(return_value=[mock_tool])

        with (
            patch("app.agent.nodes.investigate.MultiServerMCPClient", return_value=mock_mcp_context),
            patch("app.agent.nodes.investigate.ChatAnthropic", return_value=mock_llm),
        ):
            result = await run_investigate(state)

        assert result["total_tokens_used"] > 0
        # Evidence should have the completion record
        assert len(result["evidence"]) >= 1

    @pytest.mark.asyncio
    async def test_step_budget_enforced(self) -> None:
        """Investigation should stop when max steps is reached."""
        # Set step_count close to the limit
        state = make_state(step_count=14)  # 1 step away from default max of 15

        mock_tool = MagicMock()
        mock_tool.name = "query_prometheus"
        mock_tool.ainvoke = AsyncMock(return_value='{"data": []}')

        # LLM always wants to call tools (never exits on its own)
        mock_response = MagicMock()
        mock_response.content = "Investigating..."
        mock_response.usage_metadata = {"total_tokens": 100}
        mock_response.tool_calls = [{"id": "call_1", "name": "query_prometheus", "args": {"query": "up"}}]

        mock_llm = MagicMock()
        mock_llm.bind_tools = MagicMock(return_value=mock_llm)
        mock_llm.ainvoke = AsyncMock(return_value=mock_response)

        mock_mcp_context = MagicMock()
        mock_mcp_context.__aenter__ = AsyncMock(return_value=mock_mcp_context)
        mock_mcp_context.__aexit__ = AsyncMock(return_value=None)
        mock_mcp_context.get_tools = MagicMock(return_value=[mock_tool])

        with (
            patch("app.agent.nodes.investigate.MultiServerMCPClient", return_value=mock_mcp_context),
            patch("app.agent.nodes.investigate.ChatAnthropic", return_value=mock_llm),
            patch("app.agent.nodes.investigate._write_step", new=AsyncMock()),
        ):
            from app.config import settings
            original_max = settings.ORCA_MAX_INVESTIGATION_STEPS
            settings.ORCA_MAX_INVESTIGATION_STEPS = 15
            try:
                result = await run_investigate(state)
            finally:
                settings.ORCA_MAX_INVESTIGATION_STEPS = original_max

        # Should have stopped at or below the budget
        assert result["step_count"] <= 16  # started at 14, at most 2 more steps

    @pytest.mark.asyncio
    async def test_token_budget_enforced(self) -> None:
        """Investigation should stop when max tokens is reached."""
        state = make_state(total_tokens_used=99_500)  # Near the 100k token limit

        mock_tool = MagicMock()
        mock_tool.name = "query_prometheus"
        mock_tool.ainvoke = AsyncMock(return_value='{"data": []}')

        # Each LLM call uses 1000 tokens → will exceed 100k
        mock_response = MagicMock()
        mock_response.content = "Investigating..."
        mock_response.usage_metadata = {"total_tokens": 1000}
        mock_response.tool_calls = [{"id": "call_1", "name": "query_prometheus", "args": {"query": "up"}}]

        mock_llm = MagicMock()
        mock_llm.bind_tools = MagicMock(return_value=mock_llm)
        mock_llm.ainvoke = AsyncMock(return_value=mock_response)

        mock_mcp_context = MagicMock()
        mock_mcp_context.__aenter__ = AsyncMock(return_value=mock_mcp_context)
        mock_mcp_context.__aexit__ = AsyncMock(return_value=None)
        mock_mcp_context.get_tools = MagicMock(return_value=[mock_tool])

        with (
            patch("app.agent.nodes.investigate.MultiServerMCPClient", return_value=mock_mcp_context),
            patch("app.agent.nodes.investigate.ChatAnthropic", return_value=mock_llm),
            patch("app.agent.nodes.investigate._write_step", new=AsyncMock()),
        ):
            from app.config import settings
            original_max = settings.ORCA_MAX_INVESTIGATION_TOKENS
            settings.ORCA_MAX_INVESTIGATION_TOKENS = 100_000
            try:
                result = await run_investigate(state)
            finally:
                settings.ORCA_MAX_INVESTIGATION_TOKENS = original_max

        # Should stop quickly due to token budget
        assert result["total_tokens_used"] >= 99_500  # At least what we started with


class TestBuildInvestigationPrompt:
    """Tests for the _build_investigation_prompt helper."""

    def test_includes_alert_context(self) -> None:
        """Prompt should include service name, alert name, and environment."""
        state = make_state()
        prompt = _build_investigation_prompt(state)
        assert "HighLatency" in prompt
        assert "checkout-service" in prompt
        assert "production" in prompt

    def test_includes_alert_payload(self) -> None:
        """Prompt should include the serialised alert payload."""
        state = make_state()
        prompt = _build_investigation_prompt(state)
        assert "firing" in prompt


class TestExtractHistoricalContext:
    """Tests for _extract_historical_context helper."""

    def test_extracts_rcas_from_json_with_root_cause(self) -> None:
        """Rows with 'root_cause' should be appended to related_rcas."""
        tool_result = json.dumps([
            {"id": "uuid1", "alert_name": "HighLatency", "root_cause": "Memory leak", "created_at": "2024-01-01"},
        ])
        alerts: list[dict] = []
        rcas: list[dict] = []
        _extract_historical_context(tool_result, alerts, rcas)
        assert len(rcas) == 1
        assert rcas[0]["root_cause"] == "Memory leak"

    def test_extracts_alerts_from_json_without_root_cause(self) -> None:
        """Rows without 'root_cause' should be appended to similar_past_alerts."""
        tool_result = json.dumps([
            {"id": "uuid1", "alert_name": "HighLatency", "status": "firing"},
        ])
        alerts: list[dict] = []
        rcas: list[dict] = []
        _extract_historical_context(tool_result, alerts, rcas)
        assert len(alerts) == 1

    def test_handles_invalid_json_gracefully(self) -> None:
        """Invalid JSON should not raise an exception."""
        alerts: list[dict] = []
        rcas: list[dict] = []
        _extract_historical_context("not valid json", alerts, rcas)
        assert alerts == []
        assert rcas == []

