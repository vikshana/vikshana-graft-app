"""Pydantic response schemas for the RCA API endpoints."""

import uuid
from datetime import datetime
from typing import Literal

from pydantic import BaseModel


class AgentStepResponse(BaseModel):
    """Represents a single agent step in the RCA timeline.

    Attributes:
        id: UUID of the step record.
        step_number: Sequential step number within the RCA run.
        node_name: Name of the graph node that produced this step.
        action: Tool name or decision description.
        input: Query or prompt sent to the tool / LLM.
        output: Result or response received.
        tokens_used: Token usage for this step.
        duration_seconds: Wall-clock duration for this step.
        created_at: When this step was recorded.
    """

    id: uuid.UUID
    step_number: int
    node_name: str
    action: str
    input: str | None = None
    output: str | None = None
    tokens_used: int | None = None
    duration_seconds: float | None = None
    created_at: datetime

    model_config = {"from_attributes": True}


class DuplicateAlertInfo(BaseModel):
    """Minimal info about a suppressed duplicate alert linked to an RCA.

    Attributes:
        id: UUID of the rca_duplicate_alerts row.
        alert_id: UUID of the suppressed Alert record.
        created_at: When the duplicate was recorded.
    """

    id: uuid.UUID
    alert_id: uuid.UUID
    created_at: datetime

    model_config = {"from_attributes": True}


class RCASummary(BaseModel):
    """Summary representation of an RCA for list views.

    Attributes:
        id: UUID of the RCA record.
        alert_name: Name of the triggering alert.
        status: Current RCA status.
        service_name: Affected service.
        deployment_environment_name: Deployment environment.
        domain: Business domain.
        legal_company: Legal entity.
        sub_domain: Sub-domain.
        system_id: System identifier.
        team: Owning team.
        version: Service version.
        confidence_level: Assessment confidence (high/medium/low).
        total_steps: Number of investigation steps executed.
        total_tokens: Total token usage.
        duration_seconds: Wall-clock duration of the agent run.
        started_at: When the agent started.
        completed_at: When the agent completed.
        created_at: When the RCA record was created.
        duplicate_count: Number of duplicate alerts absorbed by this RCA.
    """

    id: uuid.UUID
    alert_name: str
    status: str
    service_name: str | None = None
    deployment_environment_name: str | None = None
    domain: str | None = None
    legal_company: str | None = None
    sub_domain: str | None = None
    system_id: str | None = None
    team: str | None = None
    version: str | None = None
    confidence_level: str | None = None
    total_steps: int | None = None
    total_tokens: int | None = None
    duration_seconds: float | None = None
    started_at: datetime | None = None
    completed_at: datetime | None = None
    created_at: datetime
    duplicate_count: int = 0

    model_config = {"from_attributes": True}


class RCADetail(RCASummary):
    """Full RCA detail including report, root cause, agent steps, and duplicate alerts.

    Extends RCASummary with fields only returned on the detail endpoint to
    avoid transmitting large report bodies in list responses.

    Attributes:
        alert_id: UUID of the source alert.
        root_cause: Identified root cause (plain text).
        report_markdown: Full RCA report in markdown format.
        confidence_reasoning: Explanation of the confidence level.
        error_message: Error details if the RCA failed.
        steps: Ordered list of agent steps.
        duplicate_alerts: Chronological list of suppressed duplicate alerts.
    """

    alert_id: uuid.UUID | None = None
    root_cause: str | None = None
    report_markdown: str | None = None
    confidence_reasoning: str | None = None
    error_message: str | None = None
    # 1 = positive (thumbs up), 0 = negative (thumbs down), None = no feedback
    feedback_rating: int | None = None
    feedback_comment: str | None = None
    steps: list[AgentStepResponse] = []
    duplicate_alerts: list[DuplicateAlertInfo] = []

    model_config = {"from_attributes": True}


class FeedbackRequest(BaseModel):
    """Request body for submitting user feedback on an RCA.

    Attributes:
        rating: 1 for positive (thumbs up), 0 for negative (thumbs down).
        comment: Optional free-text comment.
    """

    rating: Literal[0, 1]
    comment: str | None = None


class RCAListResponse(BaseModel):
    """Paginated list of RCA summaries.

    Attributes:
        items: List of RCA summaries for the current page.
        total: Total number of RCAs matching the filter.
        page: Current page number (1-based).
        page_size: Number of items per page.
    """

    items: list[RCASummary]
    total: int
    page: int
    page_size: int


class ConfidenceBreakdown(BaseModel):
    """Counts of RCAs at each confidence level.

    Attributes:
        high: Number of RCAs with high confidence.
        medium: Number of RCAs with medium confidence.
        low: Number of RCAs with low confidence.
        unset: Number of RCAs with no confidence level assigned.
    """

    high: int = 0
    medium: int = 0
    low: int = 0
    unset: int = 0


class StatusBreakdown(BaseModel):
    """Counts of RCAs at each status.

    Attributes:
        triggered: Number of RCAs in triggered state.
        investigating: Number of RCAs currently investigating.
        complete: Number of completed RCAs.
        failed: Number of failed RCAs.
    """

    triggered: int = 0
    investigating: int = 0
    complete: int = 0
    failed: int = 0


class DashboardStats(BaseModel):
    """Aggregate dashboard statistics, optionally filtered by label dimensions.

    Attributes:
        total_runs: Total number of RCA runs matching the filter.
        completed_runs: Number of completed RCAs.
        failed_runs: Number of failed RCAs.
        investigating_runs: Number of currently active investigations.
        success_rate: Percentage of completed RCAs out of terminal runs (complete + failed).
        avg_duration_seconds: Average wall-clock duration of completed RCAs.
        confidence_breakdown: Counts per confidence level.
        status_breakdown: Counts per status.
        recent_anomalies: Most recent failed or low-confidence RCAs.
    """

    total_runs: int
    completed_runs: int
    failed_runs: int
    investigating_runs: int
    success_rate: float
    avg_duration_seconds: float | None = None
    confidence_breakdown: ConfidenceBreakdown
    status_breakdown: StatusBreakdown
    recent_anomalies: list[RCASummary]


class FilterValues(BaseModel):
    """Distinct values available for each filterable dimension.

    Used by the frontend to populate dropdown options.

    Attributes:
        teams: Distinct team values.
        services: Distinct service_name values.
        environments: Distinct deployment_environment_name values.
        domains: Distinct domain values.
        sub_domains: Distinct sub_domain values.
        statuses: Distinct status values.
    """

    teams: list[str]
    services: list[str]
    environments: list[str]
    domains: list[str]
    sub_domains: list[str]
    statuses: list[str]

