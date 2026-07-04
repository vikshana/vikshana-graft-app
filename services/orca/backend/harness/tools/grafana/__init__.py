"""harness.tools.grafana — native Grafana tool implementations."""

from harness.tools.grafana.tools import (
    ListDatasourcesTool,
    QueryMetricsTool,
    QueryLogsTool,
    QueryTracesTool,
    QueryProfilesTool,
    ExploreLabelsTool,
    ListDashboardsTool,
    GetAlertHistoryTool,
    FetchMoreTool,
)
from harness.tools.grafana.write_tools import (
    CreateSilenceTool,
    CreateAnnotationTool,
)

__all__ = [
    "ListDatasourcesTool",
    "QueryMetricsTool",
    "QueryLogsTool",
    "QueryTracesTool",
    "QueryProfilesTool",
    "ExploreLabelsTool",
    "ListDashboardsTool",
    "GetAlertHistoryTool",
    "FetchMoreTool",
    "CreateSilenceTool",
    "CreateAnnotationTool",
]


def register_all_grafana_tools(registry=None) -> None:
    """Register all native Grafana tools into the ToolRegistry.

    Args:
        registry: ToolRegistry instance. Defaults to the module-level singleton.
    """
    if registry is None:
        from harness.tools.registry import tool_registry
        registry = tool_registry

    for tool_cls in [
        ListDatasourcesTool,
        QueryMetricsTool,
        QueryLogsTool,
        QueryTracesTool,
        QueryProfilesTool,
        ExploreLabelsTool,
        ListDashboardsTool,
        GetAlertHistoryTool,
        FetchMoreTool,
        CreateSilenceTool,
        CreateAnnotationTool,
    ]:
        registry.register(tool_cls(), replace=True)
