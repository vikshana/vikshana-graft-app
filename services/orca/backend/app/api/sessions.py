"""Session API endpoints.

Serves the harness session layer:

  GET   /api/sessions                     — list sessions
  GET   /api/sessions/search              — semantic similarity search
  GET   /api/sessions/drill-down/{handle} — retrieve stored tool result
  POST  /api/sessions/{session_id}/feedback — record user feedback

All endpoints are scoped to the caller's org via ``X-Grafana-Org-Id``.
"""

from __future__ import annotations

import json
from typing import Any

import structlog
from fastapi import APIRouter, Header, HTTPException, Query, status
from sqlalchemy import text

from app.db import AsyncSessionLocal
from harness.observability.langfuse import make_langfuse_client
from harness.search.embeddings import embed_text
from pydantic import BaseModel

logger = structlog.get_logger()

router = APIRouter()


def _parse_org_id(x_grafana_org_id: str | None) -> int | None:
    """Parse X-Grafana-Org-Id header into an int, ignoring malformed values."""
    if x_grafana_org_id:
        try:
            return int(x_grafana_org_id)
        except ValueError:
            pass
    return None


# ---------------------------------------------------------------------------
# GET /api/sessions
# ---------------------------------------------------------------------------


@router.get("/sessions", summary="List harness sessions for the current organisation")
async def list_sessions(
    status_filter: str | None = Query(None, alias="status"),
    session_type: str | None = Query(None, alias="type"),
    limit: int = Query(20, ge=1, le=100),
    x_grafana_org_id: str | None = Header(None),
) -> dict[str, Any]:
    """List rca_sessions rows, optionally filtered by status and type.

    Args:
        status_filter: Optional status filter (active, paused, completed …).
        session_type: Optional type filter (investigation, chat …).
        limit: Maximum rows to return (1–100, default 20).
        x_grafana_org_id: Grafana org ID injected by the Go proxy.

    Returns:
        Dict with ``sessions`` list and ``total`` count. An empty list is a
        valid, successful response (no sessions match the filters).

    Raises:
        HTTPException: 503 if the database query itself fails (infra
            failure) — never conflated with a legitimate empty result.
    """
    org_id = _parse_org_id(x_grafana_org_id)
    log = logger.bind(org_id=org_id)

    where_clauses: list[str] = []
    params: dict[str, Any] = {"limit": limit}

    if org_id is not None:
        where_clauses.append("org_id = :org_id")
        params["org_id"] = org_id
    if status_filter:
        where_clauses.append("status = :status")
        params["status"] = status_filter
    if session_type:
        where_clauses.append("type = :type")
        params["type"] = session_type

    where_sql = ("WHERE " + " AND ".join(where_clauses)) if where_clauses else ""

    sql = text(f"""
        SELECT id, type, status, alert_type, service, initiator_user_id,
               initiator_channel, auth_mode, created_at, updated_at
        FROM rca_sessions
        {where_sql}
        ORDER BY created_at DESC
        LIMIT :limit
    """)
    count_sql = text(f"SELECT COUNT(*) FROM rca_sessions {where_sql}")
    count_params = {k: v for k, v in params.items() if k != "limit"}

    try:
        async with AsyncSessionLocal() as db:
            rows = (await db.execute(sql, params)).fetchall()
            total = (await db.execute(count_sql, count_params)).scalar() or 0

    except Exception as exc:
        # A genuinely empty result set never reaches this branch — the
        # query above returns `[]`/`0` for "no sessions" without raising.
        # Getting here means the DB/query itself failed (down, unreachable,
        # bad SQL, etc). Masking that as an empty list is operationally
        # blind — surface a safe 5xx instead, with the real error logged
        # server-side (harness-risk-review.md, F16).
        log.error(
            "sessions_list_failed",
            error=str(exc),
            error_type=type(exc).__name__,
        )
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Failed to list sessions due to an internal error.",
        ) from exc

    sessions = [
        {
            "id": row.id,
            "type": row.type or "investigation",
            "status": row.status or "active",
            "alert_type": row.alert_type,
            "service": row.service,
            "initiator_user_id": row.initiator_user_id,
            "initiator_channel": row.initiator_channel or "grafana",
            "auth_mode": row.auth_mode or "service_account",
            "created_at": row.created_at.isoformat() if row.created_at else None,
            "updated_at": row.updated_at.isoformat() if row.updated_at else None,
        }
        for row in rows
    ]
    log.info("sessions_listed", count=len(sessions), total=total)
    return {"sessions": sessions, "total": total}


# ---------------------------------------------------------------------------
# GET /api/sessions/search
# ---------------------------------------------------------------------------


class SessionSearchResult(BaseModel):
    """A single result from the session similarity search."""

    rca_session_id: str
    alert_type: str | None
    service: str | None
    final_hypothesis: str | None
    final_confidence: float | None
    accepted_at: str | None
    similarity: float


class SessionSearchResponse(BaseModel):
    """Response envelope for the session search endpoint."""

    query: str
    results: list[SessionSearchResult]


@router.get(
    "/sessions/search",
    response_model=SessionSearchResponse,
    summary="Semantic similarity search over historical RCA sessions",
)
async def search_sessions(
    q: str = Query(..., description="Free-text search query"),
    service: str | None = Query(None, description="Filter by service"),
    alert_type: str | None = Query(None, description="Filter by alert type"),
    limit: int = Query(10, ge=1, le=50, description="Maximum results to return"),
    x_grafana_org_id: str | None = Header(None),
) -> SessionSearchResponse:
    """Search historical RCA sessions using pgvector semantic similarity.

    Embeds the query text and finds the most similar past RCA hypotheses in
    the ``rca_embeddings`` table.  Results are scoped to the caller's org.

    Args:
        q: Free-text search query.
        service: Optional service filter.
        alert_type: Optional alert type filter.
        limit: Maximum number of results (1–50, default 10).
        x_grafana_org_id: Grafana org ID injected by the Go proxy.

    Returns:
        Ranked list of similar past RCA sessions. An empty ``results`` list
        is a valid, successful response (no similar sessions found).

    Raises:
        HTTPException: 503 if the embedding call or the database query
            fails (infra failure) — never conflated with a legitimate
            empty result.
    """
    org_id = _parse_org_id(x_grafana_org_id)
    log = logger.bind(org_id=org_id, query=q[:80])
    log.info("session_search_requested")

    try:
        query_embedding = await embed_text(q)
    except Exception as exc:
        log.error(
            "session_search_embed_failed",
            error=str(exc),
            error_type=type(exc).__name__,
        )
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Failed to search sessions: embedding service unavailable.",
        ) from exc

    where_clauses = [
        "e.chunk_type = 'hypothesis'",
        "r.final_hypothesis IS NOT NULL",
    ]
    params: dict[str, Any] = {"query_embedding": str(query_embedding), "limit": limit}

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
            rows = (await db.execute(sql, params)).fetchall()

    except Exception as exc:
        # A genuinely empty result set never reaches this branch (the query
        # above returns `[]` for "no similar sessions" without raising).
        # Getting here means the DB/query itself failed — surface a safe
        # 5xx instead of a silently-empty result (harness-risk-review.md, F16).
        log.error(
            "session_search_query_failed",
            error=str(exc),
            error_type=type(exc).__name__,
        )
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Failed to search sessions due to an internal error.",
        ) from exc

    results = [
        SessionSearchResult(
            rca_session_id=str(row.rca_session_id),
            alert_type=row.alert_type,
            service=row.service,
            final_hypothesis=row.final_hypothesis,
            final_confidence=row.final_confidence,
            accepted_at=row.accepted_at.isoformat() if row.accepted_at else None,
            similarity=max(0.0, min(1.0, 1.0 - float(row.distance))),
        )
        for row in rows
    ]

    log.info("session_search_complete", result_count=len(results))
    return SessionSearchResponse(query=q, results=results)


# ---------------------------------------------------------------------------
# GET /api/sessions/drill-down/{handle}
# ---------------------------------------------------------------------------


@router.get(
    "/sessions/drill-down/{handle}",
    summary="Retrieve a stored tool result by drill-down handle",
)
async def get_drill_down(
    handle: str,
    x_grafana_org_id: str | None = Header(None),
) -> dict[str, Any]:
    """Return the full tool result stored for a drill-down handle.

    The frontend EvidencePanel calls this endpoint to retrieve the original
    Grafana query parameters so it can re-execute the query as the viewing user.

    Access is scoped to the caller's org: the drill-down row is joined to its
    owning ``rca_sessions`` row and only returned when the session's ``org_id``
    matches the caller. A missing/mismatched org yields 404 (not 403) so a
    leaked handle cannot be used to confirm existence across orgs.

    Args:
        handle: Opaque 64-character SHA-256 handle from a truncated ToolResult.
        x_grafana_org_id: Grafana org ID injected by the Go proxy.

    Returns:
        Dict with handle, tool_name, full_result, expires_at.

    Raises:
        HTTPException: 400 if the org header is missing/invalid.
        HTTPException: 404 if handle not found, expired, or not owned by the org.
    """
    org_id = _parse_org_id(x_grafana_org_id)
    if org_id is None:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Missing or invalid X-Grafana-Org-Id header.",
        )

    log = logger.bind(handle=handle[:16], org_id=org_id)

    async with AsyncSessionLocal() as db:
        result = await db.execute(
            text(
                "SELECT d.tool_name, d.full_result, d.expires_at "
                "FROM drill_down_results d "
                "JOIN rca_sessions s ON s.id = d.session_id "
                "WHERE d.handle = :handle "
                "  AND d.expires_at > now() "
                "  AND s.org_id = :org_id"
            ),
            {"handle": handle, "org_id": org_id},
        )
        row = result.fetchone()

    if row is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Drill-down handle not found or expired: {handle[:16]}...",
        )

    full_result = row.full_result
    if isinstance(full_result, str):
        try:
            full_result = json.loads(full_result)
        except Exception:
            pass

    log.info("drill_down_retrieved", tool_name=row.tool_name)
    return {
        "handle": handle,
        "tool_name": row.tool_name,
        "full_result": full_result,
        "expires_at": (
            row.expires_at.isoformat()
            if hasattr(row.expires_at, "isoformat")
            else str(row.expires_at)
        ),
    }


# ---------------------------------------------------------------------------
# POST /api/sessions/{session_id}/feedback
# ---------------------------------------------------------------------------


class FeedbackRequest(BaseModel):
    """Feedback payload for a session."""

    score: float  # 1.0 = thumbs-up, 0.0 = thumbs-down
    comment: str = ""


@router.post(
    "/sessions/{session_id}/feedback",
    summary="Record user feedback for a session",
    status_code=200,
)
async def post_session_feedback(
    session_id: str,
    body: FeedbackRequest,
    x_grafana_org_id: str | None = Header(None),
) -> dict[str, str]:
    """Record thumbs-up/down feedback for a session and forward to Langfuse.

    Verifies the session belongs to the caller's org before recording, so
    feedback cannot be written against another org's sessions.

    Args:
        session_id: Session or thread ID.
        body: Feedback score and optional comment.
        x_grafana_org_id: Grafana org ID injected by the Go proxy.

    Returns:
        Confirmation dict with status and session_id.

    Raises:
        HTTPException: 400 if the org header is missing/invalid.
        HTTPException: 404 if the session is not owned by the caller's org.
    """
    org_id = _parse_org_id(x_grafana_org_id)
    if org_id is None:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Missing or invalid X-Grafana-Org-Id header.",
        )

    log = logger.bind(session_id=session_id, score=body.score, org_id=org_id)

    async with AsyncSessionLocal() as db:
        owned = (
            await db.execute(
                text("SELECT 1 FROM rca_sessions WHERE id = :id AND org_id = :org_id"),
                {"id": session_id, "org_id": org_id},
            )
        ).fetchone()

    if owned is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Session {session_id} not found.",
        )

    log.info("session_feedback_received")

    try:
        client = make_langfuse_client()
        client.record_feedback(
            session_id=session_id,
            score=body.score,
            comment=body.comment,
            trace_id=session_id,
        )
    except Exception as exc:
        log.warning("feedback_langfuse_failed", error=str(exc))

    return {"status": "ok", "session_id": session_id}
