"""RCAState TypedDict — shared state for the new interactive RCA LangGraph.

This replaces the one-shot OrcaState with a stateful, interrupt/resume design.
The graph pauses at ``await_input``, surfaces a hypothesis to the developer,
and resumes with their follow-up question or an explicit acceptance signal.

Key design decisions (from rca-architecture-brief.md):
- ``developer_accepted`` is the ONLY real exit gate — confidence is never used in routing.
- ``hypotheses`` and ``confidence_scores`` are append-only; every round is preserved.
- ``messages`` holds the full Q&A transcript (LangChain BaseMessage format).
- ``org_id`` scopes all MCP tool calls to the correct Grafana organisation.
"""

from typing import Any, TypedDict

from langchain_core.messages import BaseMessage


class AlertContext(TypedDict):
    """Minimal context describing the triggering alert."""

    alert_id: str | None
    """UUID string of the Alert record (may be None for manually started RCAs)."""

    alert_name: str
    """Alert rule name, e.g. 'HighErrorRate'."""

    description: str
    """Human-readable description of the alert condition."""

    service: str | None
    """Service name label, if present."""

    environment: str | None
    """Deployment environment label, if present."""

    labels: dict[str, str]
    """Full label map from the Grafana alert."""

    org_id: int | None
    """Grafana organisation ID — used to scope MCP tool calls."""


class Hypothesis(TypedDict):
    """A single hypothesis produced by the agent in one round."""

    text: str
    """Plain-text hypothesis statement."""

    high_confidence_areas: list[str]
    """Areas the agent is confident about."""

    uncertain_areas: list[str]
    """Areas where evidence is insufficient or ambiguous."""

    suggested_questions: list[str]
    """Questions the agent suggests the developer investigate next."""


class RCAState(TypedDict):
    """Agent state for the interactive RCA graph.

    All fields are populated progressively.  Required fields (``alert_context``,
    ``org_id``, ``round``, ``developer_accepted``, ``max_rounds``) are set
    before the graph starts; others default to empty/None.
    """

    # --- Alert context (set at start) ---
    alert_context: AlertContext
    """The triggering alert's context."""

    org_id: int | None
    """Grafana org ID — threaded through from the HTTP request, never None in production."""

    # --- Investigation state ---
    gathered_data: list[dict[str, Any]]
    """Raw data points collected by the data_gathering node (MCP tool outputs)."""

    past_rcas: list[dict[str, Any]]
    """Top-5 similar past RCAs from the historical_context node (pgvector)."""

    # --- Hypothesis trail (append-only) ---
    hypotheses: list[Hypothesis]
    """All hypotheses generated so far — one per round.  Never mutated, only appended."""

    confidence_scores: list[float]
    """Numeric confidence score per hypothesis (0.0–1.0).  Parallel to hypotheses."""

    # --- Loop control ---
    round: int
    """Current refinement round number (starts at 0)."""

    developer_accepted: bool
    """True when the developer explicitly accepts the current hypothesis.
    This is the ONLY real exit condition — max_rounds is a safety ceiling only."""

    max_rounds: int
    """Safety ceiling — graph force-finalises after this many rounds."""

    # --- Conversation transcript ---
    messages: list[BaseMessage]
    """Full Q&A transcript between developer and agent (LangChain BaseMessage format)."""

    pending_question: str | None
    """Developer's question injected at the current breakpoint, or None."""

    # --- Output (set by finalize node) ---
    final_report: dict[str, Any] | None
    """The finalised RCA report dict — None until finalise node runs."""

    rca_session_id: str | None
    """UUID of the rca_sessions record written on finalise — None until then."""

    # --- Error state ---
    error_message: str | None
    """Error description if the agent fails; None otherwise."""

    force_finalized: bool
    """True if the graph hit max_rounds and force-finalised without developer acceptance."""
