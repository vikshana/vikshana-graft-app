"""Write-class Grafana tools — always require approval before execution.

These tools mutate Grafana state.  The ``WriteGuard`` always returns
``ApprovalRequired`` for any tool with ``cost_class=WRITE``, regardless of
the tool's own logic.  Only the session initiator may approve (enforced
server-side at the ``POST /sessions/{id}/approve`` endpoint).
"""

from __future__ import annotations

from pydantic import BaseModel, Field

from harness.tools.grafana.base import GrafanaBaseTool
from harness.auth.session_passthrough import check_grafana_response
from harness.tools.protocol import CostClass, ToolContext, ToolResult


class CreateSilenceInput(BaseModel):
    """Input for create_silence."""

    matchers: list[dict] = Field(
        description=(
            "List of matchers for the silence. "
            'Each matcher has: {"name": "label", "value": "val", "isRegex": false}'
        )
    )
    starts_at: str = Field(description="ISO 8601 start time (e.g. '2024-01-15T14:47:00Z')")
    ends_at: str = Field(description="ISO 8601 end time")
    comment: str = Field(description="Reason for the silence")
    created_by: str = Field(default="graft-agent", description="Creator identifier")


class CreateSilenceTool(GrafanaBaseTool):
    """Create a Grafana Alertmanager silence.

    WRITE operation — always requires explicit approval from the session initiator.
    Suppresses matching alerts for the specified time window.
    """

    name = "create_silence"
    description = (
        "Create an Alertmanager silence to suppress matching alerts. "
        "REQUIRES APPROVAL — the session initiator must explicitly confirm. "
        "Use for planned maintenance windows or acknowledged known-bad states."
    )
    input_schema = CreateSilenceInput
    cost_class = CostClass.WRITE

    async def run(self, ctx: ToolContext, input: CreateSilenceInput) -> ToolResult:
        """Execute create_silence after approval has been granted.

        Args:
            ctx: Tool context.
            input: Validated CreateSilenceInput.

        Returns:
            ToolResult confirming the silence was created.
        """
        body = {
            "matchers": input.matchers,
            "startsAt": input.starts_at,
            "endsAt": input.ends_at,
            "comment": input.comment,
            "createdBy": input.created_by,
        }

        status, data = await self._query(
            ctx,
            "/api/alertmanager/grafana/api/v2/silences",
            method="POST",
            body=body,
        )

        if status == 403:
            return self._permission_denied()
        if status == 401:
            check_grafana_response(401, str(getattr(ctx.credential, "user_id", None)))
        if status >= 300:
            return self._datasource_error(
                f"Create silence returned HTTP {status}: {str(data)[:300]}",
                retryable=False,
            )

        return ToolResult(
            data={
                "silence_id": data.get("silenceID", data.get("id")),
                "message": "Silence created successfully.",
            },
            source="internal",
        )


class CreateAnnotationInput(BaseModel):
    """Input for create_annotation."""

    text: str = Field(description="Annotation text describing the event")
    tags: list[str] = Field(default_factory=list, description="Tags for the annotation")
    time: int | None = Field(
        default=None,
        description="Event time as Unix milliseconds. Defaults to current time.",
    )
    time_end: int | None = Field(
        default=None,
        description="End time for region annotations (optional)",
    )
    dashboard_uid: str | None = Field(
        default=None,
        description="Pin annotation to a specific dashboard UID (optional)",
    )


class CreateAnnotationTool(GrafanaBaseTool):
    """Create a Grafana annotation to mark a significant event.

    WRITE operation — always requires explicit approval from the session initiator.
    Useful for marking when an incident started, when a change was made,
    or when a finding was confirmed.
    """

    name = "create_annotation"
    description = (
        "Create a Grafana annotation to mark a significant event on dashboards. "
        "REQUIRES APPROVAL — the session initiator must explicitly confirm. "
        "Use to mark investigation findings, deployments, or incident timestamps."
    )
    input_schema = CreateAnnotationInput
    cost_class = CostClass.WRITE

    async def run(self, ctx: ToolContext, input: CreateAnnotationInput) -> ToolResult:
        """Execute create_annotation after approval has been granted.

        Args:
            ctx: Tool context.
            input: Validated CreateAnnotationInput.

        Returns:
            ToolResult confirming the annotation was created.
        """
        body: dict = {
            "text": input.text,
            "tags": input.tags,
        }
        if input.time is not None:
            body["time"] = input.time
        if input.time_end is not None:
            body["timeEnd"] = input.time_end
        if input.dashboard_uid:
            body["dashboardUID"] = input.dashboard_uid

        status, data = await self._query(ctx, "/api/annotations", method="POST", body=body)

        if status == 403:
            return self._permission_denied()
        if status == 401:
            check_grafana_response(401, str(getattr(ctx.credential, "user_id", None)))
        if status >= 300:
            return self._datasource_error(
                f"Create annotation returned HTTP {status}: {str(data)[:300]}",
                retryable=False,
            )

        return ToolResult(
            data={
                "annotation_id": data.get("id"),
                "message": data.get("message", "Annotation created."),
            },
            source="internal",
        )
