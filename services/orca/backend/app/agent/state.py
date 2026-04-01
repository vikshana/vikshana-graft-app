"""OrcaState TypedDict — the shared state flowing through the LangGraph agent."""

from typing import Any, TypedDict


class OrcaState(TypedDict):
    """Agent state flowing through all LangGraph nodes.

    All fields are populated progressively as the agent moves through the
    graph. Required fields are set before the graph starts; optional fields
    are None until the relevant node runs.
    """

    # --- Alert context (populated before graph starts) ---
    rca_id: str
    """UUID string for this RCA run — used for DB writes and log correlation."""

    alert_payload: dict[str, Any]
    """Raw Grafana webhook alert payload (single alert dict)."""

    alert_labels: dict[str, str]
    """Extracted and validated label map from the alert."""

    alert_name: str
    """Alert rule name extracted from labels['alertname']."""

    severity: str
    """Classified severity: critical | warning | info | unknown."""

    # --- Investigation state (populated by investigate node) ---
    investigation_steps: list[dict[str, Any]]
    """Log of each MCP tool call and its result."""

    step_count: int
    """Current investigation step number."""

    total_tokens_used: int
    """Cumulative token count across all LLM calls."""

    evidence: list[dict[str, Any]]
    """Structured evidence items collected during investigation."""

    # --- Historical context (populated by investigate node via Postgres MCP) ---
    similar_past_alerts: list[dict[str, Any]]
    """Previous alerts matching the same service/labels."""

    related_rcas: list[dict[str, Any]]
    """Past RCAs for similar incidents."""

    # --- Analysis output (populated by analyze node) ---
    root_cause: str
    """Identified root cause in plain text."""

    contributing_factors: list[str]
    """Other conditions that enabled or worsened the incident."""

    timeline: list[dict[str, Any]]
    """Chronological event timeline with timestamps."""

    impact_summary: str
    """Description of what was affected and the blast radius."""

    confidence_level: str
    """Assessment confidence: high | medium | low."""

    confidence_reasoning: str
    """Explanation of why this confidence level was assigned."""

    # --- Final output (populated by report + publish nodes) ---
    report_markdown: str
    """The full 11-section RCA report in markdown format."""

    status: str
    """Current RCA status: triggered | investigating | complete | failed."""

    error_message: str | None
    """Error details if the agent failed; None otherwise."""

