"""Unit tests for the interactive RCA LangGraph nodes.

Each node is tested in isolation with mocked LLM calls, mocked MCP tools,
and mocked database operations.  No real Postgres connection is required.
"""

import json
from typing import Any
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from app.agent.rca_state import Hypothesis, RCAState


# ---------------------------------------------------------------------------
# hypothesis_generation_node
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_hypothesis_generation_produces_hypothesis(rca_initial_state: RCAState):
    """hypothesis_generation_node should append a new Hypothesis and confidence score."""
    from app.agent.rca_graph import hypothesis_generation_node

    fake_response = json.dumps({
        "text": "The checkout service is experiencing elevated error rates due to a database connection pool exhaustion.",
        "high_confidence_areas": ["error rate", "database connections"],
        "uncertain_areas": ["root trigger"],
        "confidence_score": 0.72,
        "suggested_questions": ["When was the last deployment?", "Are there any DB alerts?"],
    })

    mock_message = MagicMock()
    mock_message.content = fake_response
    mock_message.tool_calls = []

    with patch("app.agent.rca_graph._llm_main") as mock_llm:
        mock_llm.ainvoke = AsyncMock(return_value=mock_message)

        result = await hypothesis_generation_node(rca_initial_state)

    assert "hypotheses" in result
    assert len(result["hypotheses"]) == 1
    hypothesis: Hypothesis = result["hypotheses"][0]
    assert "database connection pool" in hypothesis["text"]
    assert result["confidence_scores"] == [0.72]
    assert len(hypothesis["suggested_questions"]) == 2


@pytest.mark.asyncio
async def test_hypothesis_generation_handles_malformed_json(rca_initial_state: RCAState):
    """hypothesis_generation_node should not crash on malformed LLM output."""
    from app.agent.rca_graph import hypothesis_generation_node

    mock_message = MagicMock()
    mock_message.content = "Not valid JSON at all."
    mock_message.tool_calls = []

    with patch("app.agent.rca_graph._llm_main") as mock_llm:
        mock_llm.ainvoke = AsyncMock(return_value=mock_message)

        result = await hypothesis_generation_node(rca_initial_state)

    # Should fall back gracefully
    assert len(result["hypotheses"]) == 1
    assert result["confidence_scores"][0] == 0.3  # fallback confidence


# ---------------------------------------------------------------------------
# historical_context_node
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_historical_context_node_returns_past_rcas(rca_initial_state: RCAState):
    """historical_context_node should inject past_rcas from gather_historical_context."""
    from app.agent.rca_graph import historical_context_node

    fake_past_rcas = [
        {
            "alert_type": "HighErrorRate",
            "service": "checkout-service",
            "final_hypothesis": "DB connection exhaustion caused by a memory leak",
            "final_confidence": 0.85,
            "accepted_at": "2024-01-10T10:00:00",
            "similarity": 0.92,
        }
    ]

    with patch("app.agent.rca_graph.gather_historical_context", new_callable=AsyncMock) as mock_gather:
        # historical_context imports locally, so patch in the node's namespace
        with patch(
            "app.agent.historical_context.gather_historical_context",
            new_callable=AsyncMock,
            return_value=fake_past_rcas,
        ):
            mock_gather.return_value = fake_past_rcas
            # patch the import inside the node
            with patch("app.agent.rca_graph.historical_context_node.__globals__", {}):
                pass

        # Patch at module level where it's imported
        with patch("app.agent.historical_context.AsyncSessionLocal"):
            with patch("app.agent.historical_context.embed_text", new_callable=AsyncMock, return_value=[0.1] * 1536):
                with patch("app.agent.rca_graph.gather_historical_context", new_callable=AsyncMock, return_value=fake_past_rcas):
                    result = await historical_context_node(rca_initial_state)

    assert result["past_rcas"] == fake_past_rcas


@pytest.mark.asyncio
async def test_historical_context_node_tolerates_failure(rca_initial_state: RCAState):
    """historical_context_node should return empty list if gather fails (non-fatal)."""
    from app.agent.rca_graph import historical_context_node

    with patch("app.agent.rca_graph.gather_historical_context", new_callable=AsyncMock, side_effect=Exception("DB unavailable")):
        result = await historical_context_node(rca_initial_state)

    assert result["past_rcas"] == []


# ---------------------------------------------------------------------------
# should_continue routing
# ---------------------------------------------------------------------------


def test_should_continue_routes_to_finalize_when_accepted(rca_initial_state: RCAState):
    """should_continue should return 'finalize' when developer_accepted=True."""
    from app.agent.rca_graph import should_continue

    state = dict(rca_initial_state)
    state["developer_accepted"] = True

    assert should_continue(state) == "finalize"  # type: ignore[arg-type]


def test_should_continue_routes_to_force_finalize_at_max_rounds(rca_initial_state: RCAState):
    """should_continue should return 'force_finalize' at max rounds."""
    from app.agent.rca_graph import should_continue

    state = dict(rca_initial_state)
    state["round"] = 5
    state["max_rounds"] = 5
    state["developer_accepted"] = False

    assert should_continue(state) == "force_finalize"  # type: ignore[arg-type]


def test_should_continue_routes_to_refine_otherwise(rca_initial_state: RCAState):
    """should_continue should return 'refine' when not accepted and not at max rounds."""
    from app.agent.rca_graph import should_continue

    state = dict(rca_initial_state)
    state["round"] = 2
    state["max_rounds"] = 5
    state["developer_accepted"] = False

    assert should_continue(state) == "refine"  # type: ignore[arg-type]


# ---------------------------------------------------------------------------
# await_input_node (interrupt behaviour)
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_await_input_node_processes_developer_message():
    """await_input_node should add developer message to messages on resume."""
    from app.agent.rca_graph import await_input_node

    hypothesis: Hypothesis = {
        "text": "Connection pool exhaustion",
        "high_confidence_areas": ["error rate"],
        "uncertain_areas": ["root trigger"],
        "suggested_questions": [],
    }

    state: dict[str, Any] = {
        "hypotheses": [hypothesis],
        "confidence_scores": [0.72],
        "round": 0,
        "messages": [],
    }

    resume_value = {"message": "What was the deployment time?"}

    with patch("app.agent.rca_graph.interrupt", return_value=resume_value):
        result = await await_input_node(state)  # type: ignore[arg-type]

    from langchain_core.messages import HumanMessage
    assert len(result["messages"]) == 1
    assert isinstance(result["messages"][0], HumanMessage)
    assert result["round"] == 1
    assert result["pending_question"] == "What was the deployment time?"


@pytest.mark.asyncio
async def test_await_input_node_sets_developer_accepted():
    """await_input_node should set developer_accepted=True on accept resume."""
    from app.agent.rca_graph import await_input_node

    hypothesis: Hypothesis = {
        "text": "Connection pool exhaustion",
        "high_confidence_areas": [],
        "uncertain_areas": [],
        "suggested_questions": [],
    }

    state: dict[str, Any] = {
        "hypotheses": [hypothesis],
        "confidence_scores": [0.72],
        "round": 1,
        "messages": [],
    }

    resume_value = {"developer_accepted": True}

    with patch("app.agent.rca_graph.interrupt", return_value=resume_value):
        result = await await_input_node(state)  # type: ignore[arg-type]

    assert result["developer_accepted"] is True
