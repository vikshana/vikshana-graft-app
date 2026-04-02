"""Interactive RCA session API endpoints.

New routes that drive the interrupt/resume LangGraph flow:

  POST  /api/rca/start              — start investigation (SSE stream)
  POST  /api/rca/{thread_id}/refine — developer Q&A turn (SSE stream)
  POST  /api/rca/{thread_id}/accept — accept hypothesis, write rca_sessions
  GET   /api/rca/{thread_id}/history — hypothesis trail + Q&A transcript
  GET   /api/rca/search             — semantic similarity search

SSE endpoints use FastAPI ``StreamingResponse`` with ``text/event-stream``.
The Go proxy must be configured with ``FlushInterval: -1`` to pass SSE
chunks through without buffering.

Multi-org isolation
-------------------
All endpoints read ``X-Grafana-Org-Id`` from the request headers and pass
``org_id`` into the LangGraph state.  The Go plugin backend injects this
header from ``req.PluginContext.OrgID`` (not spoofable by clients).
"""

import uuid
from typing import Any, AsyncGenerator

import structlog
from fastapi import APIRouter, Header, HTTPException, Query, Request, status
from fastapi.responses import StreamingResponse
from langchain_core.messages import AIMessage, HumanMessage
from langgraph.types import Command
from sqlalchemy import select, text

from app.agent.rca_graph import get_rca_graph
from app.agent.rca_state import AlertContext, RCAState
from app.agent.streaming import stream_rca_refine, stream_rca_start
from app.config import settings
from app.db import AsyncSessionLocal
from app.models.rca import RCA
from app.schemas.rca_session import (
    AlertContextInput,
    HypothesisOut,
    QATurn,
    RCAAcceptResponse,
    RCAHistoryResponse,
    RCARefineRequest,
    RCASearchResponse,
    RCASearchResult,
    RCAStartRequest,
)

logger = structlog.get_logger()

router = APIRouter()


def _parse_org_id(x_grafana_org_id: str | None) -> int | None:
    """Parse the X-Grafana-Org-Id header into an int, ignoring bad values."""
    if x_grafana_org_id:
        try:
            return int(x_grafana_org_id)
        except ValueError:
            pass
    return None


def _build_alert_context(
    req: RCAStartRequest,
    org_id: int | None,
) -> AlertContext:
    """Construct an AlertContext TypedDict from the API request body."""
    ctx = req.alert_context
    return AlertContext(
        alert_id=req.alert_id,
        alert_name=ctx.alert_name,
        description=ctx.description,
        service=ctx.service,
        environment=ctx.environment,
        labels=ctx.labels,
        org_id=org_id,
    )


# ---------------------------------------------------------------------------
# POST /api/rca/start  (SSE stream)
# ---------------------------------------------------------------------------


@router.post(
    "/rca/start",
    summary="Start a new interactive RCA investigation (SSE stream)",
    description=(
        "Kicks off a new LangGraph RCA investigation and streams agent progress "
        "as Server-Sent Events until the first interrupt (await_input).  "
        "The client should consume the SSE stream and look for the "
        "'session_created' event (thread_id) and the 'interrupt' event "
        "(hypothesis + suggested_questions)."
    ),
)
async def start_rca(
    body: RCAStartRequest,
    x_grafana_org_id: str | None = Header(None),
) -> StreamingResponse:
    """Start an RCA investigation and stream agent steps as SSE.

    Args:
        body: Alert context and optional alert_id.
        x_grafana_org_id: Grafana org ID injected by the Go proxy.

    Returns:
        StreamingResponse with ``text/event-stream`` content type.
    """
    org_id = _parse_org_id(x_grafana_org_id)
    thread_id = str(uuid.uuid4())
    log = logger.bind(thread_id=thread_id, org_id=org_id)
    log.info("rca_start_requested", alert_name=body.alert_context.alert_name)

    alert_context = _build_alert_context(body, org_id)

    initial_state: dict[str, Any] = {
        "alert_context": alert_context,
        "org_id": org_id,
        "gathered_data": [],
        "past_rcas": [],
        "hypotheses": [],
        "confidence_scores": [],
        "round": 0,
        "developer_accepted": False,
        "max_rounds": settings.ORCA_MAX_ROUNDS,
        "messages": [],
        "pending_question": None,
        "final_report": None,
        "rca_session_id": None,
        "error_message": None,
        "force_finalized": False,
    }

    graph = await get_rca_graph()

    async def _generate() -> AsyncGenerator[str, None]:
        async for chunk in stream_rca_start(graph, initial_state, thread_id):
            yield chunk

    return StreamingResponse(
        _generate(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",  # disable nginx buffering
        },
    )


# ---------------------------------------------------------------------------
# POST /api/rca/{thread_id}/refine  (SSE stream)
# ---------------------------------------------------------------------------


@router.post(
    "/rca/{thread_id}/refine",
    summary="Send a follow-up question and stream agent response (SSE)",
    description=(
        "Resumes the paused LangGraph thread with the developer's message "
        "and streams the refine + hypothesis_generation steps as SSE until "
        "the next interrupt.  Emits 'step', 'tool_call', 'tool_result', "
        "'hypothesis', 'interrupt', and 'done' events."
    ),
)
async def refine_rca(
    thread_id: str,
    body: RCARefineRequest,
    x_grafana_org_id: str | None = Header(None),
) -> StreamingResponse:
    """Resume an RCA session with a developer question and stream events.

    Args:
        thread_id: LangGraph thread ID for the existing session.
        body: Developer follow-up message.
        x_grafana_org_id: Grafana org ID injected by the Go proxy.

    Returns:
        StreamingResponse with ``text/event-stream`` content type.
    """
    log = logger.bind(thread_id=thread_id, org_id=_parse_org_id(x_grafana_org_id))
    log.info("rca_refine_requested", message_preview=body.message[:80])

    graph = await get_rca_graph()

    async def _generate() -> AsyncGenerator[str, None]:
        async for chunk in stream_rca_refine(graph, thread_id, body.message):
            yield chunk

    return StreamingResponse(
        _generate(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",
        },
    )


# ---------------------------------------------------------------------------
# POST /api/rca/{thread_id}/accept  (JSON)
# ---------------------------------------------------------------------------


@router.post(
    "/rca/{thread_id}/accept",
    response_model=RCAAcceptResponse,
    summary="Accept the current hypothesis and generate the final RCA report",
)
async def accept_rca(
    thread_id: str,
    x_grafana_org_id: str | None = Header(None),
) -> RCAAcceptResponse:
    """Accept the current hypothesis and run the finalize node.

    Resumes the graph with ``developer_accepted=True``, which routes to the
    ``finalize`` node.  Waits for the graph to complete and returns the final
    RCA report and session ID.

    Args:
        thread_id: LangGraph thread ID.
        x_grafana_org_id: Grafana org ID injected by the Go proxy.

    Returns:
        Final RCA session ID and report.

    Raises:
        HTTPException: 404 if the thread does not exist.
        HTTPException: 500 if finalisation fails.
    """
    org_id = _parse_org_id(x_grafana_org_id)
    log = logger.bind(thread_id=thread_id, org_id=org_id)
    log.info("rca_accept_requested")

    graph = await get_rca_graph()
    config = {"configurable": {"thread_id": thread_id}}

    # Verify the thread exists by reading current state
    try:
        current_state = await graph.aget_state(config)
    except Exception as exc:
        log.warning("rca_accept_state_read_failed", error=str(exc))
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Thread {thread_id} not found",
        ) from exc

    if current_state is None or not current_state.values:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Thread {thread_id} not found",
        )

    # Resume the graph with developer_accepted=True → routes to finalize
    try:
        final_state = await graph.ainvoke(
            Command(resume={"developer_accepted": True}),
            config=config,
        )
    except Exception as exc:
        log.error("rca_finalize_failed", error=str(exc))
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Finalisation failed: {exc}",
        ) from exc

    rca_session_id = final_state.get("rca_session_id")
    final_report = final_state.get("final_report")
    developer_override = final_state.get("force_finalized", False) or (
        final_state.get("confidence_scores", [0.5])[-1] < 0.6
        and final_state.get("developer_accepted", False)
    )

    log.info(
        "rca_accepted",
        rca_session_id=rca_session_id,
        developer_override=developer_override,
    )

    return RCAAcceptResponse(
        thread_id=thread_id,
        rca_session_id=rca_session_id,
        final_report=final_report,
        developer_override=developer_override,
    )


# ---------------------------------------------------------------------------
# GET /api/rca/{thread_id}/history  (JSON)
# ---------------------------------------------------------------------------


@router.get(
    "/rca/{thread_id}/history",
    response_model=RCAHistoryResponse,
    summary="Retrieve full hypothesis trail and Q&A transcript",
)
async def get_rca_history(
    thread_id: str,
    x_grafana_org_id: str | None = Header(None),
) -> RCAHistoryResponse:
    """Return the complete hypothesis trail and Q&A transcript for a thread.

    Reads the LangGraph checkpoint state for the given thread and returns all
    hypotheses, confidence scores, messages (Q&A), and final report if available.

    Args:
        thread_id: LangGraph thread ID.
        x_grafana_org_id: Grafana org ID injected by the Go proxy.

    Returns:
        Full hypothesis trail and Q&A transcript.

    Raises:
        HTTPException: 404 if the thread does not exist.
    """
    log = logger.bind(thread_id=thread_id)

    graph = await get_rca_graph()
    config = {"configurable": {"thread_id": thread_id}}

    try:
        state = await graph.aget_state(config)
    except Exception as exc:
        log.warning("rca_history_read_failed", error=str(exc))
        state = None

    if state is not None and state.values:
        values = state.values
        raw_hypotheses = values.get("hypotheses", [])
        confidence_scores = values.get("confidence_scores", [])
        messages = values.get("messages", [])

        hypotheses_out = [
            HypothesisOut(
                text=h["text"],
                high_confidence_areas=h.get("high_confidence_areas", []),
                uncertain_areas=h.get("uncertain_areas", []),
                suggested_questions=h.get("suggested_questions", []),
            )
            for h in raw_hypotheses
        ]

        qa_transcript = [
            QATurn(
                role="developer" if isinstance(m, HumanMessage) else "agent",
                content=m.content if isinstance(m.content, str) else str(m.content),
            )
            for m in messages
        ]

        return RCAHistoryResponse(
            thread_id=thread_id,
            round=values.get("round", 0),
            hypotheses=hypotheses_out,
            confidence_scores=confidence_scores,
            qa_transcript=qa_transcript,
            final_report=values.get("final_report"),
            rca_session_id=values.get("rca_session_id"),
            developer_accepted=values.get("developer_accepted", False),
            force_finalized=values.get("force_finalized", False),
        )

    # No LangGraph checkpoint — fall back to the rcas table (automated / seed RCAs).
    try:
        rca_uuid = uuid.UUID(thread_id)
    except ValueError:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Thread {thread_id} not found",
        )

    async with AsyncSessionLocal() as db:
        result = await db.execute(select(RCA).where(RCA.id == rca_uuid))
        rca = result.scalar_one_or_none()

    if rca is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Thread {thread_id} not found",
        )

    hypotheses_out = []
    if rca.root_cause:
        hypotheses_out = [
            HypothesisOut(
                text=rca.root_cause,
                high_confidence_areas=[],
                uncertain_areas=[],
                suggested_questions=[],
            )
        ]

    confidence_map = {"high": 0.9, "medium": 0.6, "low": 0.3}
    confidence_score = confidence_map.get(rca.confidence_level or "", 0.0)

    final_report: dict[str, Any] | None = None
    if rca.report_markdown or rca.root_cause:
        final_report = {
            "report_markdown": rca.report_markdown or "",
            "root_cause": rca.root_cause or "",
            "confidence_level": rca.confidence_level or "",
            "confidence_reasoning": rca.confidence_reasoning or "",
        }

    log.info("rca_history_from_rcas_table", rca_id=str(rca_uuid), status=rca.status)
    return RCAHistoryResponse(
        thread_id=thread_id,
        round=0,
        hypotheses=hypotheses_out,
        confidence_scores=[confidence_score] if hypotheses_out else [],
        qa_transcript=[],
        final_report=final_report,
        developer_accepted=rca.status == "complete",
    )


# ---------------------------------------------------------------------------
# GET /api/rca/search  (JSON)
# ---------------------------------------------------------------------------


@router.get(
    "/rca/search",
    response_model=RCASearchResponse,
    summary="Semantic similarity search over historical RCA sessions",
)
async def search_rcas(
    q: str = Query(..., description="Search query text"),
    service: str | None = Query(None, description="Filter by service"),
    alert_type: str | None = Query(None, description="Filter by alert type"),
    limit: int = Query(10, ge=1, le=50, description="Maximum results to return"),
    x_grafana_org_id: str | None = Header(None),
) -> RCASearchResponse:
    """Search historical RCA sessions using pgvector semantic similarity.

    Embeds the query text and finds the most similar past RCA hypotheses in
    the ``rca_embeddings`` table.  Results are scoped to the caller's org.

    Args:
        q: Free-text search query.
        service: Optional service filter.
        alert_type: Optional alert type filter.
        limit: Maximum number of results.
        x_grafana_org_id: Grafana org ID injected by the Go proxy.

    Returns:
        Ranked list of similar past RCA sessions.
    """
    from app.agent.historical_context import embed_text

    org_id = _parse_org_id(x_grafana_org_id)
    log = logger.bind(org_id=org_id, query=q[:80])
    log.info("rca_search_requested")

    try:
        query_embedding = await embed_text(q)
    except Exception as exc:
        log.warning("rca_search_embed_failed", error=str(exc))
        return RCASearchResponse(query=q, results=[])

    # Build WHERE clause for optional filters
    where_clauses = ["e.chunk_type = 'hypothesis'", "r.final_hypothesis IS NOT NULL"]
    params: dict[str, Any] = {
        "query_embedding": str(query_embedding),
        "limit": limit,
    }
    if org_id is not None:
        where_clauses.append("r.org_id = :org_id")
        params["org_id"] = org_id
    if service:
        where_clauses.append("r.service = :service")
        params["service"] = service
    if alert_type:
        where_clauses.append("r.alert_type = :alert_type")
        params["alert_type"] = alert_type

    where_sql = " AND ".join(where_clauses)

    sql = text(f"""
        SELECT
            r.id            AS rca_session_id,
            r.alert_type,
            r.service,
            r.final_hypothesis,
            r.final_confidence,
            r.accepted_at,
            e.embedding <=> :query_embedding AS distance
        FROM rca_embeddings e
        JOIN rca_sessions r ON r.id = e.rca_id
        WHERE {where_sql}
        ORDER BY distance ASC
        LIMIT :limit
    """)

    try:
        async with AsyncSessionLocal() as db:
            result = await db.execute(sql, params)
            rows = result.fetchall()

        results = [
            RCASearchResult(
                rca_session_id=row.rca_session_id,
                alert_type=row.alert_type,
                service=row.service,
                final_hypothesis=row.final_hypothesis,
                final_confidence=row.final_confidence,
                accepted_at=row.accepted_at.isoformat() if row.accepted_at else None,
                similarity=max(0.0, min(1.0, 1.0 - float(row.distance))),
            )
            for row in rows
        ]

        log.info("rca_search_complete", result_count=len(results))
        return RCASearchResponse(query=q, results=results)

    except Exception as exc:
        log.warning("rca_search_query_failed", error=str(exc))
        return RCASearchResponse(query=q, results=[])
