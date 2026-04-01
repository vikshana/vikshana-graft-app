"""Integration tests for the interactive RCA session API endpoints.

These tests use the FastAPI AsyncClient with an in-memory SQLite DB.
The LangGraph graph is mocked so no real LLM calls are made.
"""

import json
from typing import Any, AsyncGenerator
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from httpx import AsyncClient


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _sse_line(event_type: str, data: dict[str, Any]) -> bytes:
    payload = json.dumps({"type": event_type, **data})
    return f"data: {payload}\n\n".encode()


async def _fake_stream_start(*args: Any, **kwargs: Any) -> AsyncGenerator[str, None]:
    """Minimal SSE stream: session_created → step → interrupt → done."""
    yield f"data: {json.dumps({'type': 'session_created', 'thread_id': 'thread-abc'})}\n\n"
    yield f"data: {json.dumps({'type': 'step', 'node': 'data_gathering', 'status': 'started'})}\n\n"
    yield f"data: {json.dumps({'type': 'interrupt', 'thread_id': 'thread-abc', 'hypothesis': {'text': 'DB connection exhaustion', 'high_confidence_areas': [], 'uncertain_areas': [], 'suggested_questions': ['When last deployment?']}, 'confidence': 0.75, 'round': 0, 'suggested_questions': ['When last deployment?']})}\n\n"
    yield f"data: {json.dumps({'type': 'done', 'reason': 'awaiting_input'})}\n\n"


async def _fake_stream_refine(*args: Any, **kwargs: Any) -> AsyncGenerator[str, None]:
    """Minimal SSE refine stream: step → hypothesis → interrupt → done."""
    yield f"data: {json.dumps({'type': 'step', 'node': 'refine', 'status': 'started'})}\n\n"
    yield f"data: {json.dumps({'type': 'hypothesis', 'hypothesis': {'text': 'Refined: DB pool exhaustion', 'high_confidence_areas': ['error rate'], 'uncertain_areas': [], 'suggested_questions': []}, 'confidence': 0.85})}\n\n"
    yield f"data: {json.dumps({'type': 'interrupt', 'thread_id': 'thread-abc', 'hypothesis': {'text': 'Refined: DB pool exhaustion', 'high_confidence_areas': [], 'uncertain_areas': [], 'suggested_questions': []}, 'confidence': 0.85, 'round': 1, 'suggested_questions': []})}\n\n"
    yield f"data: {json.dumps({'type': 'done', 'reason': 'awaiting_input'})}\n\n"


# ---------------------------------------------------------------------------
# POST /api/rca/start
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_rca_start_returns_sse_stream(client: AsyncClient):
    """POST /api/rca/start should return an SSE stream with session_created event."""
    with patch("app.api.rca_sessions.get_rca_graph", new_callable=AsyncMock) as mock_graph_fn:
        with patch("app.api.rca_sessions.stream_rca_start", side_effect=_fake_stream_start):
            mock_graph_fn.return_value = MagicMock()

            response = await client.post(
                "/api/rca/start",
                json={
                    "alert_context": {
                        "alert_name": "HighErrorRate",
                        "description": "Error rate > 5%",
                        "labels": {},
                    }
                },
                headers={"X-Grafana-Org-Id": "1"},
            )

    assert response.status_code == 200
    assert "text/event-stream" in response.headers["content-type"]

    # Parse SSE events from body
    body = response.text
    events = [
        json.loads(line[len("data: "):])
        for line in body.split("\n")
        if line.startswith("data: ")
    ]

    assert any(e["type"] == "session_created" for e in events)
    assert any(e["type"] == "interrupt" for e in events)
    assert events[-1]["type"] == "done"


# ---------------------------------------------------------------------------
# POST /api/rca/{thread_id}/refine
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_rca_refine_returns_sse_stream(client: AsyncClient):
    """POST /api/rca/{tid}/refine should stream events."""
    with patch("app.api.rca_sessions.get_rca_graph", new_callable=AsyncMock) as mock_graph_fn:
        with patch("app.api.rca_sessions.stream_rca_refine", side_effect=_fake_stream_refine):
            mock_graph_fn.return_value = MagicMock()

            response = await client.post(
                "/api/rca/thread-abc/refine",
                json={"message": "When was the last deployment?"},
                headers={"X-Grafana-Org-Id": "1"},
            )

    assert response.status_code == 200
    assert "text/event-stream" in response.headers["content-type"]

    body = response.text
    events = [
        json.loads(line[len("data: "):])
        for line in body.split("\n")
        if line.startswith("data: ")
    ]

    assert any(e["type"] == "hypothesis" for e in events)
    assert any(e["type"] == "interrupt" for e in events)


# ---------------------------------------------------------------------------
# POST /api/rca/{thread_id}/accept
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_rca_accept_returns_final_report(client: AsyncClient):
    """POST /api/rca/{tid}/accept should finalise and return the RCA report."""
    mock_state = MagicMock()
    mock_state.values = {
        "hypotheses": [{"text": "DB exhaustion", "high_confidence_areas": [], "uncertain_areas": [], "suggested_questions": []}],
        "confidence_scores": [0.82],
        "round": 1,
    }

    final_state = {
        "rca_session_id": "session-xyz",
        "final_report": {"executive_summary": "DB pool issue", "root_cause": "Memory leak"},
        "force_finalized": False,
        "developer_accepted": True,
        "confidence_scores": [0.82],
    }

    mock_graph = MagicMock()
    mock_graph.aget_state = AsyncMock(return_value=mock_state)
    mock_graph.ainvoke = AsyncMock(return_value=final_state)

    with patch("app.api.rca_sessions.get_rca_graph", new_callable=AsyncMock, return_value=mock_graph):
        response = await client.post(
            "/api/rca/thread-abc/accept",
            headers={"X-Grafana-Org-Id": "1"},
        )

    assert response.status_code == 200
    data = response.json()
    assert data["thread_id"] == "thread-abc"
    assert data["rca_session_id"] == "session-xyz"
    assert data["final_report"]["root_cause"] == "Memory leak"


@pytest.mark.asyncio
async def test_rca_accept_404_on_missing_thread(client: AsyncClient):
    """POST /api/rca/{tid}/accept should return 404 for unknown thread."""
    mock_graph = MagicMock()
    mock_graph.aget_state = AsyncMock(side_effect=Exception("Thread not found"))

    with patch("app.api.rca_sessions.get_rca_graph", new_callable=AsyncMock, return_value=mock_graph):
        response = await client.post(
            "/api/rca/nonexistent-thread/accept",
            headers={"X-Grafana-Org-Id": "1"},
        )

    assert response.status_code == 404


# ---------------------------------------------------------------------------
# GET /api/rca/{thread_id}/history
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_rca_history_returns_transcript(client: AsyncClient):
    """GET /api/rca/{tid}/history should return hypothesis trail + Q&A."""
    from langchain_core.messages import AIMessage, HumanMessage

    mock_state = MagicMock()
    mock_state.values = {
        "round": 2,
        "hypotheses": [
            {
                "text": "DB pool exhaustion",
                "high_confidence_areas": ["error rate"],
                "uncertain_areas": ["root trigger"],
                "suggested_questions": [],
            }
        ],
        "confidence_scores": [0.75],
        "messages": [
            HumanMessage(content="When was last deployment?"),
            AIMessage(content="Last deployment was 3 hours ago."),
        ],
        "final_report": None,
        "rca_session_id": None,
        "developer_accepted": False,
        "force_finalized": False,
    }

    mock_graph = MagicMock()
    mock_graph.aget_state = AsyncMock(return_value=mock_state)

    with patch("app.api.rca_sessions.get_rca_graph", new_callable=AsyncMock, return_value=mock_graph):
        response = await client.get(
            "/api/rca/thread-abc/history",
            headers={"X-Grafana-Org-Id": "1"},
        )

    assert response.status_code == 200
    data = response.json()
    assert data["thread_id"] == "thread-abc"
    assert data["round"] == 2
    assert len(data["hypotheses"]) == 1
    assert len(data["qa_transcript"]) == 2
    assert data["qa_transcript"][0]["role"] == "developer"
    assert data["qa_transcript"][1]["role"] == "agent"


@pytest.mark.asyncio
async def test_rca_history_404_on_missing_thread(client: AsyncClient):
    """GET /api/rca/{tid}/history should return 404 for unknown thread."""
    mock_graph = MagicMock()
    mock_graph.aget_state = AsyncMock(return_value=None)

    with patch("app.api.rca_sessions.get_rca_graph", new_callable=AsyncMock, return_value=mock_graph):
        response = await client.get(
            "/api/rca/nonexistent/history",
            headers={"X-Grafana-Org-Id": "1"},
        )

    assert response.status_code == 404


# ---------------------------------------------------------------------------
# GET /api/rca/search
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_rca_search_returns_results(client: AsyncClient):
    """GET /api/rca/search should return semantically similar RCAs."""
    from app.schemas.rca_session import RCASearchResult

    mock_results = [
        {
            "rca_session_id": "session-001",
            "alert_type": "HighErrorRate",
            "service": "checkout-service",
            "final_hypothesis": "DB pool exhaustion",
            "final_confidence": 0.85,
            "accepted_at": "2024-01-10T10:00:00",
            "similarity": 0.92,
        }
    ]

    with patch("app.api.rca_sessions.embed_text", new_callable=AsyncMock, return_value=[0.1] * 1536):
        with patch("app.api.rca_sessions.AsyncSessionLocal") as mock_session_cls:
            mock_session = AsyncMock()
            mock_result = MagicMock()

            # Build row mock
            row = MagicMock()
            row.rca_session_id = "session-001"
            row.alert_type = "HighErrorRate"
            row.service = "checkout-service"
            row.final_hypothesis = "DB pool exhaustion"
            row.final_confidence = 0.85
            row.accepted_at = None
            row.distance = 0.08

            mock_result.fetchall.return_value = [row]
            mock_session.execute = AsyncMock(return_value=mock_result)

            mock_cm = MagicMock()
            mock_cm.__aenter__ = AsyncMock(return_value=mock_session)
            mock_cm.__aexit__ = AsyncMock(return_value=False)
            mock_session_cls.return_value = mock_cm

            response = await client.get(
                "/api/rca/search?q=high+error+rate+checkout",
                headers={"X-Grafana-Org-Id": "1"},
            )

    assert response.status_code == 200
    data = response.json()
    assert data["query"] == "high error rate checkout"
    assert len(data["results"]) == 1
    assert data["results"][0]["rca_session_id"] == "session-001"
    assert data["results"][0]["similarity"] == pytest.approx(1.0 - 0.08)
