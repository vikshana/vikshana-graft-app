"""Integration-style tests proving the live RCA graph tool-execution path
invokes GuardPipeline and org-scopes tool resolution.

This is the direct test of the F1 fix described in
docs/harness-risk-review.md: `app/agent/rca_graph.py` previously called
`get_grafana_tools().bind_tools()` / `tool.ainvoke()` directly, bypassing
`GuardPipeline` entirely. These tests drive the real `data_gathering_node`
and `refine_node` functions (not a stand-in) with a scripted fake LLM and
assert that every LLM-issued tool call is observed by a Guard inside the
pipeline before the underlying tool executes, and that a hallucinated /
unregistered tool name is never executed.
"""

from __future__ import annotations

import json
from typing import Any
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from pydantic import BaseModel

from harness.guards.pipeline import GuardPipeline
from harness.guards.types import Allow, Guard
from harness.tools.registry import ToolRegistry
from tests.fake_provider import FakeLLM, FakeToolCall, FakeTurn


class _RecordingGuard(Guard):
    """Records every (tool_name, input) pair GuardPipeline evaluates it against."""

    name = "recording"

    def __init__(self) -> None:
        self.calls: list[tuple[str, dict]] = []

    async def evaluate(self, tool: Any, input: Any, ctx: Any) -> Any:
        self.calls.append((tool.name, input.model_dump()))
        return Allow()


def _make_state(org_id: int | None = 1) -> dict[str, Any]:
    from app.agent.rca_state import AlertContext, RCAState

    ctx = AlertContext(
        alert_id="alert-1",
        alert_name="HighErrorRate",
        description="Error rate spike on checkout-service",
        service="checkout-service",
        environment="production",
        labels={"severity": "critical"},
        org_id=org_id,
    )
    return RCAState(
        alert_context=ctx,
        org_id=org_id,
        gathered_data=[],
        past_rcas=[],
        hypotheses=[],
        confidence_scores=[],
        round=0,
        developer_accepted=False,
        max_rounds=5,
        messages=[],
        pending_question=None,
        final_report=None,
        rca_session_id=None,
        error_message=None,
        force_finalized=False,
        tool_call_count=0,
        investigation_started_at=None,
    )


def _mock_lc_tool(name: str, ainvoke_return: str = "42 errors/min") -> MagicMock:
    class _Schema(BaseModel):
        q: str = ""

    tool = MagicMock()
    tool.name = name
    tool.description = f"Mock LangChain tool {name}"
    tool.args_schema = _Schema  # real schema, like langchain_mcp_adapters produces
    tool.ainvoke = AsyncMock(return_value=ainvoke_return)
    return tool


class TestDataGatheringNodeInvokesGuardPipeline:
    """The core F1 assertion for the data_gathering node."""

    @pytest.mark.asyncio
    async def test_llm_tool_call_is_evaluated_by_the_guard_pipeline(self) -> None:
        lc_tool = _mock_lc_tool("query_prometheus")
        recording_guard = _RecordingGuard()

        script = [
            FakeTurn(
                content="",
                tool_calls=[FakeToolCall(name="query_prometheus", args={"q": "errors"})],
            ),
            FakeTurn(content=json.dumps({"source": "summary", "findings": "done"})),
        ]
        fake_llm = FakeLLM(script)

        with (
            patch("app.agent.rca_graph.get_grafana_tools", new=AsyncMock(return_value=[lc_tool])),
            patch("app.agent.rca_graph.tool_registry", new=ToolRegistry()),
            patch("app.agent.rca_graph._llm_main", fake_llm),
            patch(
                "app.agent.rca_graph.make_default_pipeline",
                new=lambda: GuardPipeline([recording_guard]),
            ),
        ):
            from app.agent.rca_graph import data_gathering_node
            result = await data_gathering_node(_make_state())

        # The guard actually saw the call before the tool executed.
        assert recording_guard.calls == [("query_prometheus", {"q": "errors"})]
        # And the underlying LangChain tool really ran (Allow → dispatched).
        lc_tool.ainvoke.assert_awaited_once()

        sources = [d["source"] for d in result["gathered_data"]]
        assert "query_prometheus" in sources
        assert "llm_summary" in sources
        # The rendered tool result is what the guarded executor produced,
        # not the raw untouched string — proves it went through the
        # ToolResultEnvelope rendering path, not a direct tool.ainvoke() call.
        tool_entry = next(d for d in result["gathered_data"] if d["source"] == "query_prometheus")
        assert "42 errors/min" in tool_entry["result"]

    @pytest.mark.asyncio
    async def test_guard_deny_prevents_the_underlying_tool_from_running(self) -> None:
        """A Deny verdict from the pipeline must stop the LangChain tool
        from ever being invoked — proves guards are load-bearing, not just
        observational, on the live path."""
        from harness.guards.types import Deny

        class _DenyGuard(Guard):
            name = "deny_all"

            async def evaluate(self, tool: Any, input: Any, ctx: Any) -> Any:
                return Deny(reason="blocked for test", code="test_block")

        lc_tool = _mock_lc_tool("query_prometheus")
        script = [
            FakeTurn(
                content="",
                tool_calls=[FakeToolCall(name="query_prometheus", args={"q": "errors"})],
            ),
            FakeTurn(content=json.dumps({"source": "summary", "findings": "done"})),
        ]
        fake_llm = FakeLLM(script)

        with (
            patch("app.agent.rca_graph.get_grafana_tools", new=AsyncMock(return_value=[lc_tool])),
            patch("app.agent.rca_graph.tool_registry", new=ToolRegistry()),
            patch("app.agent.rca_graph._llm_main", fake_llm),
            patch(
                "app.agent.rca_graph.make_default_pipeline",
                new=lambda: GuardPipeline([_DenyGuard()]),
            ),
        ):
            from app.agent.rca_graph import data_gathering_node
            result = await data_gathering_node(_make_state())

        lc_tool.ainvoke.assert_not_awaited()
        tool_entry = next(d for d in result["gathered_data"] if d["source"] == "query_prometheus")
        assert "denied" in tool_entry["result"].lower()

    @pytest.mark.asyncio
    async def test_hallucinated_tool_name_is_never_executed(self) -> None:
        """An LLM-requested tool name that isn't registered must not be
        callable — it is surfaced as an error string, never executed."""
        lc_tool = _mock_lc_tool("query_prometheus")
        script = [
            FakeTurn(
                content="",
                tool_calls=[FakeToolCall(name="delete_everything", args={})],
            ),
            FakeTurn(content=json.dumps({"source": "summary", "findings": "done"})),
        ]
        fake_llm = FakeLLM(script)

        with (
            patch("app.agent.rca_graph.get_grafana_tools", new=AsyncMock(return_value=[lc_tool])),
            patch("app.agent.rca_graph.tool_registry", new=ToolRegistry()),
            patch("app.agent.rca_graph._llm_main", fake_llm),
        ):
            from app.agent.rca_graph import data_gathering_node
            result = await data_gathering_node(_make_state())

        lc_tool.ainvoke.assert_not_awaited()
        tool_entry = next(d for d in result["gathered_data"] if d["source"] == "delete_everything")
        assert "not registered" in tool_entry["result"].lower()

    @pytest.mark.asyncio
    async def test_org_configured_mcp_tool_is_reachable_via_org_tool_registry(self) -> None:
        """A user-configured MCP tool (registered by harness.mcp.client_manager
        into the shared ToolRegistry) must be reachable by the live agent for
        the alert's org — this was the "MCP tools never callable" half of F1."""
        from harness.mcp.tool_adapter import MCPTool

        mcp_client = AsyncMock(return_value="42 issues found")
        mcp_tool = MCPTool(
            qualified_name="mcp:1:github:search_issues",
            description="Search GitHub issues",
            input_schema_dict={"properties": {"q": {"type": "string"}}},
            mcp_client=mcp_client,
            bare_tool_name="search_issues",
        )
        mcp_tool._org_id = 1  # type: ignore[attr-defined]

        shared_registry = ToolRegistry()
        shared_registry.register(mcp_tool)

        script = [
            FakeTurn(
                content="",
                tool_calls=[FakeToolCall(name="mcp:1:github:search_issues", args={"q": "bug"})],
            ),
            FakeTurn(content=json.dumps({"source": "summary", "findings": "done"})),
        ]
        fake_llm = FakeLLM(script)

        with (
            patch("app.agent.rca_graph.get_grafana_tools", new=AsyncMock(return_value=[])),
            patch("app.agent.rca_graph.tool_registry", new=shared_registry),
            patch("app.agent.rca_graph._llm_main", fake_llm),
        ):
            from app.agent.rca_graph import data_gathering_node
            result = await data_gathering_node(_make_state(org_id=1))

        mcp_client.assert_awaited_once()
        tool_entry = next(
            d for d in result["gathered_data"] if d["source"] == "mcp:1:github:search_issues"
        )
        assert "42 issues found" in tool_entry["result"]

    @pytest.mark.asyncio
    async def test_org_configured_mcp_tool_from_another_org_is_not_reachable(self) -> None:
        """The same MCP tool registered for a *different* org must not be
        callable from this alert's investigation."""
        from harness.mcp.tool_adapter import MCPTool

        mcp_client = AsyncMock(return_value="should not be reached")
        mcp_tool = MCPTool(
            qualified_name="mcp:2:github:search_issues",
            description="Search GitHub issues (org 2)",
            input_schema_dict={"properties": {"q": {"type": "string"}}},
            mcp_client=mcp_client,
            bare_tool_name="search_issues",
        )
        mcp_tool._org_id = 2  # type: ignore[attr-defined]

        shared_registry = ToolRegistry()
        shared_registry.register(mcp_tool)

        script = [
            FakeTurn(
                content="",
                tool_calls=[FakeToolCall(name="mcp:2:github:search_issues", args={"q": "bug"})],
            ),
            FakeTurn(content=json.dumps({"source": "summary", "findings": "done"})),
        ]
        fake_llm = FakeLLM(script)

        with (
            patch("app.agent.rca_graph.get_grafana_tools", new=AsyncMock(return_value=[])),
            patch("app.agent.rca_graph.tool_registry", new=shared_registry),
            patch("app.agent.rca_graph._llm_main", fake_llm),
        ):
            from app.agent.rca_graph import data_gathering_node
            # org_id=1 investigation, tool is registered for org 2.
            result = await data_gathering_node(_make_state(org_id=1))

        mcp_client.assert_not_awaited()
        tool_entry = next(
            d for d in result["gathered_data"] if d["source"] == "mcp:2:github:search_issues"
        )
        assert "not registered" in tool_entry["result"].lower()


class TestRefineNodeInvokesGuardPipeline:
    @pytest.mark.asyncio
    async def test_refine_tool_call_is_evaluated_by_the_guard_pipeline(self) -> None:
        lc_tool = _mock_lc_tool("query_prometheus", ainvoke_return="98/100 connections")
        recording_guard = _RecordingGuard()

        script = [
            FakeTurn(
                content="",
                tool_calls=[FakeToolCall(name="query_prometheus", args={"q": "conns"})],
            ),
            FakeTurn(content="Connection count is 98/100."),
        ]
        fake_llm = FakeLLM(script)

        state = _make_state()
        state = {
            **state,
            "hypotheses": [{
                "text": "DB pool exhaustion",
                "high_confidence_areas": [],
                "uncertain_areas": [],
                "suggested_questions": [],
            }],
            "confidence_scores": [0.6],
            "pending_question": "How many DB connections are active?",
        }

        with (
            patch("app.agent.rca_graph.get_grafana_tools", new=AsyncMock(return_value=[lc_tool])),
            patch("app.agent.rca_graph.tool_registry", new=ToolRegistry()),
            patch("app.agent.rca_graph._llm_main", fake_llm),
            patch(
                "app.agent.rca_graph.make_default_pipeline",
                new=lambda: GuardPipeline([recording_guard]),
            ),
        ):
            from app.agent.rca_graph import refine_node
            result = await refine_node(state)

        assert recording_guard.calls == [("query_prometheus", {"q": "conns"})]
        lc_tool.ainvoke.assert_awaited_once()
        assert any(
            "98/100" in d.get("result", "") for d in result["gathered_data"]
        )


# ---------------------------------------------------------------------------
# Guard state threaded through RCAState across nodes/rounds (F1)
#
# `data_gathering_node` and `refine_node` each independently built a fresh,
# zeroed `ToolContext` and a `GuardPipeline` whose `TimeoutGuard.start_turn()`
# was never called at all — so `LoopGuard`'s per-turn call budget silently
# reset to zero on every node call, and the per-turn/per-session timeout
# ceilings were permanently inert (`_turn_started_at`/`_session_started_at`
# stayed `None` forever). These tests prove `tool_call_count` and
# `investigation_started_at` are read from and written back to `RCAState`
# so guard state survives across the whole investigation instead of being
# reinitialised per node call.
# ---------------------------------------------------------------------------


class TestGuardStateThreadedThroughRCAState:
    @pytest.mark.asyncio
    async def test_data_gathering_node_returns_tool_call_count_and_investigation_started_at(
        self,
    ) -> None:
        lc_tool = _mock_lc_tool("query_prometheus")
        script = [
            FakeTurn(
                content="",
                tool_calls=[FakeToolCall(name="query_prometheus", args={"q": "errors"})],
            ),
            FakeTurn(content=json.dumps({"source": "summary", "findings": "done"})),
        ]
        fake_llm = FakeLLM(script)

        with (
            patch("app.agent.rca_graph.get_grafana_tools", new=AsyncMock(return_value=[lc_tool])),
            patch("app.agent.rca_graph.tool_registry", new=ToolRegistry()),
            patch("app.agent.rca_graph._llm_main", fake_llm),
        ):
            from app.agent.rca_graph import data_gathering_node
            result = await data_gathering_node(_make_state())

        assert result["tool_call_count"] == 1
        assert isinstance(result["investigation_started_at"], float)

    @pytest.mark.asyncio
    async def test_tool_call_count_accumulates_across_rounds_instead_of_resetting(self) -> None:
        """Simulates two rounds of the interactive RCA investigation:
        `data_gathering_node` runs first (round 0), then `refine_node` runs
        in a later round using the state `data_gathering_node` returned.
        `tool_call_count` must accumulate across both, not reset to just
        the second round's own calls."""
        lc_tool_1 = _mock_lc_tool("query_prometheus")
        script_1 = [
            FakeTurn(
                content="",
                tool_calls=[FakeToolCall(name="query_prometheus", args={"q": "errors"})],
            ),
            FakeTurn(content=json.dumps({"source": "summary", "findings": "done"})),
        ]

        with (
            patch("app.agent.rca_graph.get_grafana_tools", new=AsyncMock(return_value=[lc_tool_1])),
            patch("app.agent.rca_graph.tool_registry", new=ToolRegistry()),
            patch("app.agent.rca_graph._llm_main", FakeLLM(script_1)),
        ):
            from app.agent.rca_graph import data_gathering_node
            round0_result = await data_gathering_node(_make_state())

        assert round0_result["tool_call_count"] == 1
        first_investigation_started_at = round0_result["investigation_started_at"]

        # Round 1: refine_node runs with the state round 0 returned merged in
        # (this is exactly what LangGraph does between node calls).
        state_after_round0 = {
            **_make_state(),
            **round0_result,
            "hypotheses": [{
                "text": "some hypothesis",
                "high_confidence_areas": [],
                "uncertain_areas": [],
                "suggested_questions": [],
            }],
            "confidence_scores": [0.5],
            "pending_question": "follow-up question",
        }

        lc_tool_2 = _mock_lc_tool("query_prometheus")
        script_2 = [
            FakeTurn(
                content="",
                tool_calls=[FakeToolCall(name="query_prometheus", args={"q": "follow-up"})],
            ),
            FakeTurn(content="answer"),
        ]

        with (
            patch("app.agent.rca_graph.get_grafana_tools", new=AsyncMock(return_value=[lc_tool_2])),
            patch("app.agent.rca_graph.tool_registry", new=ToolRegistry()),
            patch("app.agent.rca_graph._llm_main", FakeLLM(script_2)),
        ):
            from app.agent.rca_graph import refine_node
            round1_result = await refine_node(state_after_round0)

        # Accumulated across both rounds (1 from round 0 + 1 from round 1),
        # never reset to just round 1's own single call.
        assert round1_result["tool_call_count"] == 2
        # The investigation's session origin is threaded forward unchanged
        # — not reset to "now" on the second round — so SESSION_TIMEOUT_S
        # bounds the whole investigation's real duration.
        assert round1_result["investigation_started_at"] == first_investigation_started_at

    @pytest.mark.asyncio
    async def test_loop_guard_enforces_the_ceiling_across_accumulated_calls(self) -> None:
        """LoopGuard must see the *carried-forward* call count, not a
        zeroed one — a state that already recorded
        MAX_TOOL_CALLS_PER_TURN calls in earlier rounds must have its next
        tool call denied immediately, proving the budget is genuinely
        cumulative across the investigation rather than per-node."""
        from app.config import settings

        lc_tool = _mock_lc_tool("query_prometheus")
        script = [
            FakeTurn(
                content="",
                tool_calls=[FakeToolCall(name="query_prometheus", args={"q": "errors"})],
            ),
            FakeTurn(content=json.dumps({"source": "summary", "findings": "done"})),
        ]
        fake_llm = FakeLLM(script)

        state = {
            **_make_state(),
            "tool_call_count": settings.MAX_TOOL_CALLS_PER_TURN,
        }

        with (
            patch("app.agent.rca_graph.get_grafana_tools", new=AsyncMock(return_value=[lc_tool])),
            patch("app.agent.rca_graph.tool_registry", new=ToolRegistry()),
            patch("app.agent.rca_graph._llm_main", fake_llm),
        ):
            from app.agent.rca_graph import data_gathering_node
            result = await data_gathering_node(state)

        lc_tool.ainvoke.assert_not_awaited()
        tool_entry = next(d for d in result["gathered_data"] if d["source"] == "query_prometheus")
        assert "denied" in tool_entry["result"].lower()
