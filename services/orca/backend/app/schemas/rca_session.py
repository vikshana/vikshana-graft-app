"""Pydantic schemas for the interactive RCA session endpoints.

These schemas cover the new interrupt/resume flow:
  POST /api/rca/start         — kick off a new investigation (SSE stream)
  POST /api/rca/{tid}/refine  — send a developer question (SSE stream)
  POST /api/rca/{tid}/accept  — accept the current hypothesis as final
  GET  /api/rca/{tid}/history — full hypothesis trail + Q&A transcript
  GET  /api/rca/search        — semantic similarity search over past RCAs
"""

from typing import Any

from pydantic import BaseModel, Field


# ---------------------------------------------------------------------------
# Shared sub-models
# ---------------------------------------------------------------------------


class AlertContextInput(BaseModel):
    """Alert metadata provided by the caller when starting an RCA."""

    alert_name: str = Field(..., description="Human-readable alert name")
    description: str = Field(..., description="Alert description or summary")
    service: str | None = Field(None, description="Originating service name")
    environment: str | None = Field(None, description="Deployment environment")
    labels: dict[str, str] = Field(
        default_factory=dict,
        description="Raw Grafana alert labels for context",
    )


class HypothesisOut(BaseModel):
    """Serialisable form of the internal Hypothesis TypedDict."""

    text: str
    high_confidence_areas: list[str]
    uncertain_areas: list[str]
    suggested_questions: list[str]


class QATurn(BaseModel):
    """A single turn in the developer / agent Q&A transcript."""

    role: str = Field(..., description="'developer' or 'agent'")
    content: str


# ---------------------------------------------------------------------------
# POST /api/rca/start
# ---------------------------------------------------------------------------


class RCAStartRequest(BaseModel):
    """Body for POST /api/rca/start."""

    alert_id: str | None = Field(None, description="Optional alert UUID (for correlation)")
    alert_context: AlertContextInput


# /start is a streaming endpoint — see rca_sessions.py for the SSE response.
# The stream emits: session_created, step*, tool_call*, tool_result*, interrupt, done


# ---------------------------------------------------------------------------
# POST /api/rca/{thread_id}/refine
# ---------------------------------------------------------------------------


class RCARefineRequest(BaseModel):
    """Body for POST /api/rca/{thread_id}/refine."""

    message: str = Field(..., description="Developer follow-up question or observation")


# /refine is a streaming endpoint — emits: step*, tool_call*, tool_result*, interrupt, done


# ---------------------------------------------------------------------------
# POST /api/rca/{thread_id}/accept
# ---------------------------------------------------------------------------


class RCAAcceptResponse(BaseModel):
    """Response from POST /api/rca/{thread_id}/accept."""

    thread_id: str
    rca_session_id: str | None = None
    final_report: dict[str, Any] | None = None
    developer_override: bool = False


# ---------------------------------------------------------------------------
# GET /api/rca/{thread_id}/history
# ---------------------------------------------------------------------------


class RCAHistoryResponse(BaseModel):
    """Full hypothesis trail and Q&A transcript for a given thread."""

    thread_id: str
    round: int
    hypotheses: list[HypothesisOut]
    confidence_scores: list[float]
    qa_transcript: list[QATurn]
    final_report: dict[str, Any] | None = None
    rca_session_id: str | None = None
    developer_accepted: bool = False
    force_finalized: bool = False


# ---------------------------------------------------------------------------
# GET /api/rca/search
# ---------------------------------------------------------------------------


class RCASearchResult(BaseModel):
    """A single semantic-search match from rca_embeddings / rca_sessions."""

    rca_session_id: str
    alert_type: str | None = None
    service: str | None = None
    final_hypothesis: str | None = None
    final_confidence: float | None = None
    accepted_at: str | None = None
    similarity: float = Field(..., ge=0.0, le=1.0)


class RCASearchResponse(BaseModel):
    """Response from GET /api/rca/search."""

    query: str
    results: list[RCASearchResult]
