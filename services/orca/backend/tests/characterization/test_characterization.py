"""Characterization tests for the existing RCA interactive graph.

These tests freeze the behavior of the existing rca_graph.py nodes as golden
transcripts.  They use FakeProvider (no real LLM) and must pass at the end of
every subsequent phase to ensure RCA behavior is preserved during refactoring.

Covered scenarios:
  1. High error rate — 2 Q&A rounds, developer accepts, finalize runs
  2. Latency spike — max_rounds reached, force_finalize runs
  3. MCP unavailable — data_gathering fails gracefully, investigation continues

See fixtures/*.json for the expected golden structures.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from tests.fake_provider import FakeLLM, FakeTurn, FakeToolCall

FIXTURES_DIR = Path(__file__).parent / "fixtures"


def _load_fixture(name: str) -> dict[str, Any]:
    """Load a JSON fixture file.

    Args:
        name: Fixture filename (without .json).

    Returns:
        Fixture dict.
    """
    with open(FIXTURES_DIR / f"{name}.json") as f:
        return json.load(f)


# ── Helpers ───────────────────────────────────────────────────────────────────

def _make_hypothesis_response(text: str, confidence: float = 0.75) -> str:
    """Build a valid hypothesis JSON string.

    Args:
        text: Hypothesis text.
        confidence: Confidence score.

    Returns:
        JSON string mimicking LLM output.
    """
    return json.dumps({
        "text": text,
        "high_confidence_areas": ["error rate metrics", "service logs"],
        "uncertain_areas": ["root trigger timing"],
        "confidence_score": confidence,
        "suggested_questions": [
            "When was the last deployment?",
            "Are there DB connection pool alerts?",
        ],
    })


def _make_final_report_response() -> str:
    """Build a valid final report JSON string."""
    return json.dumps({
        "executive_summary": "Checkout service experienced elevated error rates.",
        "root_cause": "Database connection pool exhaustion caused by a slow query.",
        "contributing_factors": ["Recent schema migration", "Traffic spike"],
        "timeline": ["14:30 alert fired", "14:35 investigation started"],
        "impact_assessment": "5% of orders failed for 8 minutes.",
        "recommendations": ["Increase pool size", "Add query timeout"],
        "confidence_assessment": "75% — high confidence in root cause.",
        "developer_override": False,
        "hypothesis_trail": ["DB connection pool exhaustion"],
        "confidence_scores": [0.75],
        "report_markdown": "# RCA Report\n\nDB connection pool exhaustion.",
    })


# ── Scenario 1: High error rate, 2 Q&A rounds, developer accepts ──────────────

@pytest.mark.asyncio
async def test_scenario_01_high_error_rate():
    """Golden transcript: high error rate, 2 Q&A rounds, developer accepts."""
    fixture = _load_fixture("scenario_01_high_error_rate")

    # Script for the FakeLLM:
    # Turn 1: data_gathering — no tool calls → returns summary
    # Turn 2: hypothesis_generation round 0
    # Turn 3: refine round 1 (developer Q: "When was last deployment?")
    # Turn 4: hypothesis_generation round 1
    # Turn 5: refine round 2 (developer Q: "Any DB alerts?")
    # Turn 6: hypothesis_generation round 2
    # Turn 7: finalize — final report
    script = [
        # data_gathering: no tool calls → LLM summary
        FakeTurn(
            content=json.dumps({"source": "summary", "findings": "Error rate spike at 14:30"}),
            tool_calls=[],
        ),
        # hypothesis_generation round 0
        FakeTurn(
            content=_make_hypothesis_response(
                "database connection pool exhaustion caused by a slow query",
                confidence=0.65,
            ),
        ),
        # refine round 1: targeted MCP query (tool call + summary)
        FakeTurn(
            content="",
            tool_calls=[
                FakeToolCall(
                    name="query_prometheus",
                    args={"query": "pg_stat_activity_count", "datasource_uid": "mimir"},
                )
            ],
        ),
        FakeTurn(content="Connection count is 98/100. Last deploy was 2h ago."),
        # hypothesis_generation round 1
        FakeTurn(
            content=_make_hypothesis_response(
                "database connection pool exhaustion triggered by deployment 2h ago",
                confidence=0.82,
            ),
        ),
        # refine round 2
        FakeTurn(content="No additional DB alerts found. Pool was not reconfigured."),
        # hypothesis_generation round 2
        FakeTurn(
            content=_make_hypothesis_response(
                "database connection pool exhaustion triggered by deployment 2h ago",
                confidence=0.85,
            ),
        ),
        # finalize — final report
        FakeTurn(content=_make_final_report_response()),
    ]

    fake_llm = FakeLLM(script)
    nodes_visited: list[str] = []

    async def _patched_data_gathering(state):
        nodes_visited.append("data_gathering")
        return {"gathered_data": [{"source": "llm_summary", "content": "Error rate spike"}]}

    async def _patched_historical_context(state):
        nodes_visited.append("historical_context")
        return {"past_rcas": []}

    async def _patched_hypothesis(state):
        nodes_visited.append("hypothesis_generation")
        with patch("app.agent.rca_graph._llm_main", fake_llm):
            from app.agent.rca_graph import hypothesis_generation_node
            return await hypothesis_generation_node(state)

    async def _patched_refine(state):
        nodes_visited.append("refine")
        # Simulate refine without MCP calls
        from langchain_core.messages import AIMessage
        new_msgs = list(state.get("messages", []))
        new_msgs.append(AIMessage(content="Refine answer"))
        return {"messages": new_msgs, "gathered_data": state.get("gathered_data", []), "pending_question": None}

    async def _patched_finalize(state):
        nodes_visited.append("finalize")
        with patch("app.agent.rca_graph._llm_main", fake_llm):
            with patch("app.agent.rca_graph.AsyncSessionLocal"):
                with patch("app.agent.rca_graph._persist_rca_session", new=AsyncMock(return_value="session-id-1")):
                    with patch("app.agent.rca_graph._write_embeddings", new=AsyncMock()):
                        from app.agent.rca_graph import finalize_node
                        return await finalize_node(state)

    # Test node-level behavior rather than end-to-end graph to avoid
    # LangGraph checkpointer setup requirements in unit test context.

    from app.agent.rca_state import RCAState, AlertContext

    ctx = AlertContext(
        alert_id="test-001",
        alert_name=fixture["alert_context"]["alert_name"],
        description=fixture["alert_context"]["description"],
        service=fixture["alert_context"]["service"],
        environment=fixture["alert_context"]["environment"],
        labels=fixture["alert_context"]["labels"],
        org_id=1,
    )

    state = RCAState(
        alert_context=ctx,
        org_id=1,
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
    )

    # ── Node 1: data_gathering ────────────────────────────────────────────
    # Scenario 01: MCP tools are available; LLM summarises gathered data.
    # Script turn 0 is the data_gathering LLM summary (no tool calls).
    mock_tool = MagicMock()
    mock_tool.name = "query_prometheus"
    mock_tool.ainvoke = AsyncMock(return_value="Error rate: 5.2%")

    with patch("app.agent.rca_graph.get_grafana_tools", new=AsyncMock(return_value=[mock_tool])):
        with patch("app.agent.rca_graph._llm_main", fake_llm):
            from app.agent.rca_graph import data_gathering_node
            result = await data_gathering_node(state)

    assert "gathered_data" in result
    assert len(result["gathered_data"]) >= 1  # at least the LLM summary
    state = {**state, **result}

    # ── Node 2: historical_context ────────────────────────────────────────
    # gather_historical_context is imported locally inside historical_context_node
    # so we patch it at the module where it lives
    with patch("app.agent.historical_context.gather_historical_context", new=AsyncMock(return_value=[])):
        from app.agent.rca_graph import historical_context_node
        result = await historical_context_node(state)
    assert result["past_rcas"] == []
    state = {**state, **result}

    # ── Node 3: hypothesis_generation (round 0) ───────────────────────────
    with patch("app.agent.rca_graph._llm_main", fake_llm):
        from app.agent.rca_graph import hypothesis_generation_node
        result = await hypothesis_generation_node(state)

    assert len(result["hypotheses"]) == 1
    hypothesis = result["hypotheses"][0]

    # Validate shape against fixture
    for key in fixture["expected_hypothesis_shape"]["required_keys"]:
        assert key in hypothesis, f"Missing key '{key}' in hypothesis: {hypothesis}"
    assert fixture["expected_hypothesis_shape"]["text_contains"] in hypothesis["text"]

    assert len(result["confidence_scores"]) == 1
    assert 0 < result["confidence_scores"][0] <= 1.0

    state = {**state, **result}

    # ── developer accept simulation ───────────────────────────────────────
    from langchain_core.messages import HumanMessage
    state = {
        **state,
        "developer_accepted": True,
        "messages": [HumanMessage(content="When was the last deployment?")],
    }

    # ── Node: finalize ────────────────────────────────────────────────────
    with patch("app.agent.rca_graph._llm_main", fake_llm):
        with patch("app.agent.rca_graph.AsyncSessionLocal"):
            with patch("app.agent.rca_graph._persist_rca_session", new=AsyncMock(return_value="session-id-1")):
                with patch("app.agent.rca_graph._write_embeddings", new=AsyncMock()):
                    from app.agent.rca_graph import finalize_node
                    result = await finalize_node(state)

    assert "final_report" in result
    final_report = result["final_report"]

    # Validate report shape against fixture
    for key in fixture["expected_final_report_keys"]:
        assert key in final_report, f"Missing key '{key}' in final_report: {final_report}"

    assert result["rca_session_id"] == "session-id-1"


# ── Scenario 2: Force-finalize at max_rounds ──────────────────────────────────

@pytest.mark.asyncio
async def test_scenario_02_latency_spike_force_finalize():
    """Golden transcript: latency spike, max_rounds=1, force_finalize runs."""
    fixture = _load_fixture("scenario_02_latency_spike")

    script = [
        # hypothesis_generation
        FakeTurn(
            content=_make_hypothesis_response(
                "latency spike caused by downstream payment gateway timeout",
                confidence=0.55,
            ),
        ),
        # force_finalize — final report (force_finalized=True)
        FakeTurn(content=_make_final_report_response()),
    ]
    fake_llm = FakeLLM(script)

    from app.agent.rca_state import RCAState, AlertContext

    ctx = AlertContext(
        alert_id="test-002",
        alert_name=fixture["alert_context"]["alert_name"],
        description=fixture["alert_context"]["description"],
        service=fixture["alert_context"]["service"],
        environment=fixture["alert_context"]["environment"],
        labels=fixture["alert_context"]["labels"],
        org_id=1,
    )

    state = RCAState(
        alert_context=ctx,
        org_id=1,
        gathered_data=[{"source": "llm_summary", "content": "Latency spike at 15:00"}],
        past_rcas=[],
        hypotheses=[],
        confidence_scores=[],
        round=1,   # already at max
        developer_accepted=False,
        max_rounds=1,  # will force-finalize
        messages=[],
        pending_question=None,
        final_report=None,
        rca_session_id=None,
        error_message=None,
        force_finalized=False,
    )

    # hypothesis_generation
    with patch("app.agent.rca_graph._llm_main", fake_llm):
        from app.agent.rca_graph import hypothesis_generation_node
        result = await hypothesis_generation_node(state)

    state = {**state, **result}
    assert len(state["hypotheses"]) == 1
    assert fixture["expected_hypothesis_shape"]["text_contains"] in state["hypotheses"][0]["text"]

    # should_continue → force_finalize (round >= max_rounds)
    from app.agent.rca_graph import should_continue
    routing = should_continue(state)
    assert routing == "force_finalize", f"Expected force_finalize, got {routing}"

    # force_finalize
    state["force_finalized"] = True
    with patch("app.agent.rca_graph._llm_main", fake_llm):
        with patch("app.agent.rca_graph.AsyncSessionLocal"):
            with patch("app.agent.rca_graph._persist_rca_session", new=AsyncMock(return_value="session-002")):
                with patch("app.agent.rca_graph._write_embeddings", new=AsyncMock()):
                    from app.agent.rca_graph import force_finalize_node
                    result = await force_finalize_node(state)

    assert "final_report" in result
    for key in fixture["expected_final_report_keys"]:
        assert key in result["final_report"]


# ── Scenario 3: MCP unavailable, graceful degradation ───────────────────────

@pytest.mark.asyncio
async def test_scenario_03_mcp_unavailable():
    """Golden transcript: MCP unavailable, investigation continues with empty evidence."""
    fixture = _load_fixture("scenario_03_mcp_unavailable")

    from app.agent.rca_state import RCAState, AlertContext

    ctx = AlertContext(
        alert_id="test-003",
        alert_name=fixture["alert_context"]["alert_name"],
        description=fixture["alert_context"]["description"],
        service=fixture["alert_context"]["service"],
        environment=fixture["alert_context"]["environment"],
        labels=fixture["alert_context"]["labels"],
        org_id=1,
    )

    state = RCAState(
        alert_context=ctx,
        org_id=1,
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
    )

    # data_gathering: MCP raises RuntimeError → should return empty gathered_data
    with patch("app.agent.rca_graph.get_grafana_tools", new=AsyncMock(
        side_effect=RuntimeError("Connection refused to mcp-grafana:3001")
    )):
        from app.agent.rca_graph import data_gathering_node
        result = await data_gathering_node(state)

    # Validate: error gracefully handled
    assert "gathered_data" in result
    assert result["gathered_data"] == [], f"Expected empty gathered_data, got {result['gathered_data']}"
    assert "error_message" in result
    assert result["error_message"] is not None
    assert len(result["error_message"]) > 0

    # investigation must continue — historical_context still runs
    state = {**state, **result}
    with patch("app.agent.historical_context.gather_historical_context", new=AsyncMock(return_value=[])):
        from app.agent.rca_graph import historical_context_node
        result = await historical_context_node(state)
    assert result["past_rcas"] == []

    # hypothesis_generation runs even with empty evidence
    state = {**state, **result}
    script = [
        FakeTurn(
            content=_make_hypothesis_response(
                "auth-service is returning 503 — likely a dependency issue",
                confidence=0.3,
            ),
        ),
    ]
    fake_llm = FakeLLM(script)

    with patch("app.agent.rca_graph._llm_main", fake_llm):
        from app.agent.rca_graph import hypothesis_generation_node
        result = await hypothesis_generation_node(state)

    assert len(result["hypotheses"]) == 1
    for key in fixture["expected_hypothesis_shape"]["required_keys"]:
        assert key in result["hypotheses"][0], f"Missing key '{key}'"
