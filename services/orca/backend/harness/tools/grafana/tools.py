"""Native Grafana tools — all 8 implementations.

Each tool is a fully-implemented class with:
- Pydantic input schema
- ``async run(ctx, input)`` that calls Grafana via ``GrafanaBaseTool._query``
- Result shaping via ``harness.tools.grafana.result_shaping``
- 403 → ``PermissionDenied`` ToolResult (never raises)
- 401 → ``ReauthRequiredError`` (surfaces as session pause)

Tools exported from this module:
  list_datasources, query_metrics, query_logs, query_traces,
  query_profiles, explore_labels, list_dashboards, get_alert_history,
  fetch_more
"""

from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, Field

from harness.auth.session_passthrough import check_grafana_response
from harness.tools.grafana.base import GrafanaBaseTool
from harness.tools.grafana.result_shaping import shape_and_store
from harness.tools.protocol import CostClass, ToolContext, ToolError, ToolResult


# ---------------------------------------------------------------------------
# list_datasources
# ---------------------------------------------------------------------------


class ListDatasourcesInput(BaseModel):
    """Input for list_datasources — no required parameters."""

    pass


class ListDatasourcesTool(GrafanaBaseTool):
    """List all available Grafana datasources for this organisation."""

    name = "list_datasources"
    description = (
        "List all available Grafana datasources for the current organisation. "
        "Returns name, UID, type, and URL for each datasource. "
        "Use this to discover datasource UIDs before querying metrics/logs/traces."
    )
    input_schema = ListDatasourcesInput
    cost_class = CostClass.CHEAP

    async def run(self, ctx: ToolContext, input: ListDatasourcesInput) -> ToolResult:
        """Execute list_datasources.

        Args:
            ctx: Tool context.
            input: Empty input schema.

        Returns:
            ToolResult with list of datasources.
        """
        status, data = await self._query(ctx, "/api/datasources")

        if status == 403:
            return self._permission_denied()
        if status == 401:
            check_grafana_response(401, str(getattr(ctx.credential, "user_id", None)))

        if status >= 300:
            return self._datasource_error(
                f"Grafana returned HTTP {status} for /api/datasources"
            )

        # Return lightweight summary, not full config (tokens)
        simplified = [
            {
                "uid": ds.get("uid"),
                "name": ds.get("name"),
                "type": ds.get("type"),
                "url": ds.get("url"),
            }
            for ds in (data if isinstance(data, list) else [])
        ]
        return ToolResult(data=simplified, source="internal")


# ---------------------------------------------------------------------------
# query_metrics
# ---------------------------------------------------------------------------


class QueryMetricsInput(BaseModel):
    """Input for query_metrics (Prometheus/Mimir)."""

    datasource_uid: str = Field(description="Grafana datasource UID for Prometheus/Mimir")
    expr: str = Field(description="PromQL expression")
    from_: str = Field(default="now-1h", alias="from", description="Start time (Grafana time format)")
    to: str = Field(default="now", description="End time")
    max_data_points: int = Field(default=200, ge=1, le=1000, description="Maximum data points per series")

    model_config = {"populate_by_name": True}


class QueryMetricsTool(GrafanaBaseTool):
    """Query Prometheus-compatible metrics via a Grafana Mimir datasource."""

    name = "query_metrics"
    description = (
        "Query Prometheus/Mimir metrics. Use PromQL expressions to investigate "
        "error rates, latency, saturation, and traffic. "
        "Time range defaults to the last hour."
    )
    input_schema = QueryMetricsInput
    cost_class = CostClass.QUERY

    async def run(self, ctx: ToolContext, input: QueryMetricsInput) -> ToolResult:
        """Execute query_metrics.

        Args:
            ctx: Tool context.
            input: Validated QueryMetricsInput.

        Returns:
            ToolResult with shaped metrics data.
        """
        body = {
            "queries": [
                {
                    "refId": "A",
                    "datasource": {"uid": input.datasource_uid},
                    "expr": input.expr,
                    "maxDataPoints": input.max_data_points,
                }
            ],
            "from": input.from_,
            "to": input.to,
        }

        status, data = await self._query(ctx, "/api/ds/query", method="POST", body=body)

        if status == 403:
            return self._permission_denied(input.datasource_uid)
        if status == 401:
            check_grafana_response(401, str(getattr(ctx.credential, "user_id", None)))
        if status >= 300:
            return self._datasource_error(
                f"Metrics query returned HTTP {status}: {str(data)[:300]}"
            )

        return await shape_and_store(ctx.session_id, self.name, data, shaper_type="metrics")


# ---------------------------------------------------------------------------
# query_logs
# ---------------------------------------------------------------------------


class QueryLogsInput(BaseModel):
    """Input for query_logs (Loki)."""

    datasource_uid: str = Field(description="Grafana datasource UID for Loki")
    expr: str = Field(description="LogQL expression (e.g. '{app=\"checkout\"} |= \"error\"')")
    from_: str = Field(default="now-1h", alias="from", description="Start time")
    to: str = Field(default="now", description="End time")
    limit: int = Field(default=100, ge=1, le=5000, description="Maximum log lines to return")

    model_config = {"populate_by_name": True}


class QueryLogsTool(GrafanaBaseTool):
    """Query Loki logs via Grafana datasource."""

    name = "query_logs"
    description = (
        "Query Loki logs using LogQL. Use to find error messages, stack traces, "
        "and events correlated with alert firing. "
        "Results are head+tail sampled to stay within token limits."
    )
    input_schema = QueryLogsInput
    cost_class = CostClass.QUERY

    async def run(self, ctx: ToolContext, input: QueryLogsInput) -> ToolResult:
        """Execute query_logs.

        Args:
            ctx: Tool context.
            input: Validated QueryLogsInput.

        Returns:
            ToolResult with shaped log data.
        """
        body = {
            "queries": [
                {
                    "refId": "A",
                    "datasource": {"uid": input.datasource_uid},
                    "expr": input.expr,
                    "maxLines": input.limit,
                    "queryType": "range",
                }
            ],
            "from": input.from_,
            "to": input.to,
        }

        status, data = await self._query(ctx, "/api/ds/query", method="POST", body=body)

        if status == 403:
            return self._permission_denied(input.datasource_uid)
        if status == 401:
            check_grafana_response(401, str(getattr(ctx.credential, "user_id", None)))
        if status >= 300:
            return self._datasource_error(f"Logs query returned HTTP {status}: {str(data)[:300]}")

        return await shape_and_store(ctx.session_id, self.name, data, shaper_type="logs")


# ---------------------------------------------------------------------------
# query_traces
# ---------------------------------------------------------------------------


class QueryTracesInput(BaseModel):
    """Input for query_traces (Tempo)."""

    datasource_uid: str = Field(description="Grafana datasource UID for Tempo")
    service_name: str = Field(description="Service name to filter traces for")
    from_: str = Field(default="now-1h", alias="from", description="Start time")
    to: str = Field(default="now", description="End time")
    min_duration_ms: int = Field(default=0, ge=0, description="Minimum span duration in ms")

    model_config = {"populate_by_name": True}


class QueryTracesTool(GrafanaBaseTool):
    """Query distributed traces from Tempo via Grafana datasource."""

    name = "query_traces"
    description = (
        "Query Tempo distributed traces for a service. "
        "Returns the slowest spans and a trace summary to identify latency sources."
    )
    input_schema = QueryTracesInput
    cost_class = CostClass.QUERY

    async def run(self, ctx: ToolContext, input: QueryTracesInput) -> ToolResult:
        """Execute query_traces.

        Args:
            ctx: Tool context.
            input: Validated QueryTracesInput.

        Returns:
            ToolResult with shaped trace summary.
        """
        body = {
            "queries": [
                {
                    "refId": "A",
                    "datasource": {"uid": input.datasource_uid},
                    "queryType": "traceql",
                    "query": f'{{resource.service.name="{input.service_name}"}}',
                    "limit": 100,
                }
            ],
            "from": input.from_,
            "to": input.to,
        }

        status, data = await self._query(ctx, "/api/ds/query", method="POST", body=body)

        if status == 403:
            return self._permission_denied(input.datasource_uid)
        if status == 401:
            check_grafana_response(401, str(getattr(ctx.credential, "user_id", None)))
        if status >= 300:
            return self._datasource_error(f"Trace query returned HTTP {status}: {str(data)[:300]}")

        return await shape_and_store(ctx.session_id, self.name, data, shaper_type="traces")


# ---------------------------------------------------------------------------
# query_profiles
# ---------------------------------------------------------------------------


class QueryProfilesInput(BaseModel):
    """Input for query_profiles (Pyroscope)."""

    datasource_uid: str = Field(description="Grafana datasource UID for Pyroscope")
    query: str = Field(description="Profile query (service name or label selector)")
    from_: str = Field(default="now-1h", alias="from", description="Start time")
    to: str = Field(default="now", description="End time")
    profile_type: str = Field(default="cpu", description="Profile type (cpu, memory, goroutine)")

    model_config = {"populate_by_name": True}


class QueryProfilesTool(GrafanaBaseTool):
    """Query Pyroscope continuous profiling data via Grafana datasource."""

    name = "query_profiles"
    description = (
        "Query Pyroscope CPU/memory profiles for a service. "
        "Returns a flamegraph summary to identify hot paths. "
        "If the datasource is not available, returns an empty result."
    )
    input_schema = QueryProfilesInput
    cost_class = CostClass.QUERY

    async def run(self, ctx: ToolContext, input: QueryProfilesInput) -> ToolResult:
        """Execute query_profiles.

        Args:
            ctx: Tool context.
            input: Validated QueryProfilesInput.

        Returns:
            ToolResult with profile summary, or empty result if unavailable.
        """
        body = {
            "queries": [
                {
                    "refId": "A",
                    "datasource": {"uid": input.datasource_uid},
                    "queryType": "profile",
                    "labelSelector": f"{{service_name=~\"{input.query}\"}}",
                    "profileTypeId": input.profile_type,
                }
            ],
            "from": input.from_,
            "to": input.to,
        }

        status, data = await self._query(ctx, "/api/ds/query", method="POST", body=body)

        if status == 403:
            return self._permission_denied(input.datasource_uid)
        if status == 401:
            check_grafana_response(401, str(getattr(ctx.credential, "user_id", None)))
        if status in (404, 400):
            # Profiling datasource may not exist — return graceful empty result
            return ToolResult(
                data={"profiles": [], "_note": "Profiling datasource unavailable or no data"},
                source="internal",
            )
        if status >= 300:
            return self._datasource_error(f"Profile query returned HTTP {status}: {str(data)[:300]}")

        return await shape_and_store(ctx.session_id, self.name, data, shaper_type="metrics")


# ---------------------------------------------------------------------------
# explore_labels
# ---------------------------------------------------------------------------


class ExploreLabelsInput(BaseModel):
    """Input for explore_labels (Loki label discovery)."""

    datasource_uid: str = Field(description="Grafana datasource UID for Loki")
    label_name: str = Field(description="Label name to get values for (e.g. 'app', 'job')")
    from_: str = Field(default="now-1h", alias="from", description="Start time")
    to: str = Field(default="now", description="End time")

    model_config = {"populate_by_name": True}


class ExploreLabelsTool(GrafanaBaseTool):
    """Discover Loki label values for a given label name."""

    name = "explore_labels"
    description = (
        "Discover available label values in Loki for a specific label name. "
        "Use to find valid values for 'app', 'job', 'namespace', etc. before "
        "constructing a LogQL query."
    )
    input_schema = ExploreLabelsInput
    cost_class = CostClass.CHEAP

    async def run(self, ctx: ToolContext, input: ExploreLabelsInput) -> ToolResult:
        """Execute explore_labels.

        Args:
            ctx: Tool context.
            input: Validated ExploreLabelsInput.

        Returns:
            ToolResult with list of label values.
        """
        body = {
            "queries": [
                {
                    "refId": "A",
                    "datasource": {"uid": input.datasource_uid},
                    "queryType": "labels",
                    "labelName": input.label_name,
                }
            ],
            "from": input.from_,
            "to": input.to,
        }

        status, data = await self._query(ctx, "/api/ds/query", method="POST", body=body)

        if status == 403:
            return self._permission_denied(input.datasource_uid)
        if status == 401:
            check_grafana_response(401, str(getattr(ctx.credential, "user_id", None)))
        if status >= 300:
            return self._datasource_error(f"Label explore returned HTTP {status}")

        return ToolResult(data=data, source="untrusted_telemetry")


# ---------------------------------------------------------------------------
# list_dashboards
# ---------------------------------------------------------------------------


class ListDashboardsInput(BaseModel):
    """Input for list_dashboards."""

    query: str = Field(default="", description="Search string to filter dashboards by title")
    tag: str = Field(default="", description="Optional tag filter")
    limit: int = Field(default=20, ge=1, le=100, description="Maximum results to return")


class ListDashboardsTool(GrafanaBaseTool):
    """Search for Grafana dashboards by title or tag."""

    name = "list_dashboards"
    description = (
        "Search Grafana dashboards by title or tag. "
        "Returns dashboard titles, UIDs, and URLs. "
        "Use to find relevant dashboards for the service under investigation."
    )
    input_schema = ListDashboardsInput
    cost_class = CostClass.CHEAP

    async def run(self, ctx: ToolContext, input: ListDashboardsInput) -> ToolResult:
        """Execute list_dashboards.

        Args:
            ctx: Tool context.
            input: Validated ListDashboardsInput.

        Returns:
            ToolResult with list of matching dashboards.
        """
        params = f"?type=dash-db&limit={input.limit}"
        if input.query:
            params += f"&query={input.query}"
        if input.tag:
            params += f"&tag={input.tag}"

        status, data = await self._query(ctx, f"/api/search{params}")

        if status == 403:
            return self._permission_denied()
        if status == 401:
            check_grafana_response(401, str(getattr(ctx.credential, "user_id", None)))
        if status >= 300:
            return self._datasource_error(f"Dashboard search returned HTTP {status}")

        # Return lightweight summary
        simplified = [
            {
                "uid": d.get("uid"),
                "title": d.get("title"),
                "url": d.get("url"),
                "tags": d.get("tags", []),
            }
            for d in (data if isinstance(data, list) else [])
        ]
        return ToolResult(data=simplified, source="internal")


# ---------------------------------------------------------------------------
# get_alert_history
# ---------------------------------------------------------------------------


class GetAlertHistoryInput(BaseModel):
    """Input for get_alert_history."""

    from_: str = Field(default="now-24h", alias="from", description="Start time")
    to: str = Field(default="now", description="End time")
    state: str = Field(
        default="",
        description="Filter by alert state: 'alerting', 'ok', 'pending', or '' for all",
    )
    limit: int = Field(default=50, ge=1, le=200, description="Maximum results")

    model_config = {"populate_by_name": True}


class GetAlertHistoryTool(GrafanaBaseTool):
    """Retrieve recent Grafana alert history."""

    name = "get_alert_history"
    description = (
        "Retrieve the history of Grafana alerts. "
        "Shows which alerts have fired, resolved, or are pending. "
        "Useful for correlating alert timing with other signals."
    )
    input_schema = GetAlertHistoryInput
    cost_class = CostClass.CHEAP

    async def run(self, ctx: ToolContext, input: GetAlertHistoryInput) -> ToolResult:
        """Execute get_alert_history.

        Args:
            ctx: Tool context.
            input: Validated GetAlertHistoryInput.

        Returns:
            ToolResult with alert history list.
        """
        params = f"?limit={input.limit}"
        if input.state:
            params += f"&state={input.state}"

        status, data = await self._query(ctx, f"/api/alerting/alerts{params}")

        if status == 403:
            return self._permission_denied()
        if status == 401:
            check_grafana_response(401, str(getattr(ctx.credential, "user_id", None)))
        if status >= 300:
            return self._datasource_error(f"Alert history returned HTTP {status}")

        alerts = data if isinstance(data, list) else []
        # Cap response
        simplified = [
            {
                "name": a.get("name", a.get("labels", {}).get("alertname", "unknown")),
                "state": a.get("state"),
                "labels": a.get("labels", {}),
                "activeAt": a.get("activeAt"),
                "value": a.get("value"),
            }
            for a in alerts[: input.limit]
        ]
        return ToolResult(data=simplified, source="untrusted_telemetry")


# ---------------------------------------------------------------------------
# fetch_more (drill-down retrieval)
# ---------------------------------------------------------------------------


class FetchMoreInput(BaseModel):
    """Input for fetch_more."""

    handle: str = Field(description="Drill-down handle returned by a truncated tool result")
    slice_start: int = Field(default=0, ge=0, description="Start index for slicing (for logs)")
    slice_end: int = Field(default=100, ge=1, le=1000, description="End index for slicing")
    shaper_type: str = Field(
        default="metrics",
        description="Shaper type for re-applying caps: 'metrics', 'logs', or 'traces'",
    )


class FetchMoreTool(GrafanaBaseTool):
    """Retrieve a slice of a previously truncated tool result."""

    name = "fetch_more"
    description = (
        "Retrieve more data from a previously truncated tool result. "
        "Use the drill_down_handle returned by a tool that was truncated. "
        "Results are still subject to the same caps as the original tool."
    )
    input_schema = FetchMoreInput
    cost_class = CostClass.CHEAP

    async def run(self, ctx: ToolContext, input: FetchMoreInput) -> ToolResult:
        """Execute fetch_more — retrieve a slice from drill_down_results.

        Args:
            ctx: Tool context.
            input: Validated FetchMoreInput.

        Returns:
            ToolResult with the requested slice.
        """
        from app.db import AsyncSessionLocal
        from sqlalchemy import text
        import json

        async with AsyncSessionLocal() as db:
            row = await db.execute(
                text(
                    "SELECT tool_name, full_result FROM drill_down_results "
                    "WHERE handle = :handle AND expires_at > now()"
                ),
                {"handle": input.handle},
            )
            record = row.fetchone()

        if record is None:
            return ToolResult(
                data=None,
                error=ToolError(
                    code="not_found",
                    message=f"Drill-down handle {input.handle!r} not found or expired.",
                    retryable=False,
                ),
            )

        full_data = record.full_result if isinstance(record.full_result, dict) else json.loads(record.full_result)

        # Re-apply shaper to get a bounded slice
        return await shape_and_store(
            ctx.session_id,
            f"fetch_more:{record.tool_name}",
            full_data,
            shaper_type=input.shaper_type,
        )
