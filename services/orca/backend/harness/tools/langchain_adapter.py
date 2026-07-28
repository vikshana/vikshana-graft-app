"""Adapts a LangChain ``BaseTool`` to the harness ``Tool`` protocol.

Complements ``harness.mcp.tool_adapter.MCPTool``, which performs the
equivalent wrapping for tools discovered from the user-configurable MCP
server registry (``harness.mcp.client_manager``). This adapter exists for
tool *sources* that are already LangChain-native — most notably the
built-in Grafana MCP sidecar tools returned by
``app.agent.mcp.grafana_client.get_grafana_tools`` — so they can be
registered into a ``harness.tools.registry.ToolRegistry`` and dispatched
through ``GuardPipeline`` exactly like every other harness tool, instead of
being bound to the LLM and invoked directly (see
docs/harness-risk-review.md, F1).

Read-only by construction: ``cost_class`` is always ``CostClass.QUERY``,
matching the existing ``MCPTool`` convention. This adapter must never be
used to wrap a write-capable LangChain tool — the product's built-in MCP
tool sources (``grafana/mcp-grafana``, ``modelcontextprotocol/server-postgres``)
are read-only per the project's architecture (see CLAUDE.md).
"""

from __future__ import annotations

from typing import Any

from pydantic import BaseModel, create_model

from harness.tools.error_classification import classify_exception
from harness.tools.protocol import CostClass, ToolContext, ToolError, ToolResult


def _schema_from_langchain_tool(lc_tool: Any) -> type[BaseModel]:
    """Return a Pydantic input schema for a LangChain tool.

    Real LangChain MCP-adapter tools carry a proper ``args_schema`` (a
    Pydantic model generated from the MCP server's JSON Schema). Falls back
    to a permissive single-field schema for tools that don't expose one
    (e.g. hand-built test doubles), so wrapping never raises.

    Args:
        lc_tool: LangChain ``BaseTool`` instance.

    Returns:
        Pydantic BaseModel subclass suitable for ``Tool.input_schema``.
    """
    schema = getattr(lc_tool, "args_schema", None)
    if isinstance(schema, type) and issubclass(schema, BaseModel):
        return schema

    name = getattr(lc_tool, "name", "tool")
    model_name = "".join(w.capitalize() for w in str(name).replace("-", "_").split("_")) + "Input"
    return create_model(model_name, params=(dict | None, None))


class LangChainToolAdapter:
    """Wraps a LangChain ``BaseTool`` so it satisfies the harness ``Tool`` protocol.

    Args:
        lc_tool: LangChain tool instance (must support ``async ainvoke(args)``).
        org_id: Grafana organisation ID this tool instance is scoped to
            (e.g. the MCP sidecar connection was opened with this org's
            ``X-Grafana-Org-Id`` header). Tagged as ``_org_id`` so
            ``harness.mcp.registry_bridge.OrgToolRegistry`` can filter it
            per org exactly like MCP-configured tools. ``None`` marks the
            tool as globally visible (no org scoping applied).
    """

    cost_class: CostClass = CostClass.QUERY

    def __init__(self, lc_tool: Any, *, org_id: int | None = None) -> None:
        self.name: str = lc_tool.name
        description = getattr(lc_tool, "description", None)
        self.description: str = description if isinstance(description, str) else str(description or "")
        self.input_schema: type[BaseModel] = _schema_from_langchain_tool(lc_tool)
        self._lc_tool = lc_tool
        if org_id is not None:
            self._org_id = org_id

    async def run(self, ctx: ToolContext, input: BaseModel) -> ToolResult:
        """Execute the wrapped LangChain tool via its ``ainvoke``.

        Args:
            ctx: Harness tool context (unused by the wrapped LangChain
                tool itself; required to satisfy the ``Tool`` protocol).
            input: Validated Pydantic input (round-tripped back to a plain
                dict before being passed to the LangChain tool).

        Returns:
            ToolResult wrapping the LangChain tool's raw output, or a
            structured ``ToolError`` if the call raised. Never raises.
        """
        try:
            args = input.model_dump(exclude_none=True)
            result = await self._lc_tool.ainvoke(args)
            return ToolResult(data=result, truncated=False)
        except Exception as exc:
            # Classify by the actual exception type instead of a blanket
            # `retryable=True` for every failure (see
            # docs/harness-risk-review.md, F16) — a 4xx-equivalent or
            # protocol-level rejection will fail identically on retry and
            # can cause retry storms; only genuinely transient
            # infrastructure failures should be retryable.
            code, retryable = classify_exception(exc)
            return ToolResult(
                data=f"Tool error: {exc}",
                truncated=False,
                error=ToolError(code=code, message=str(exc), retryable=retryable),
            )
