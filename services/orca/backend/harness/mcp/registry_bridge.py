"""OrgToolRegistry — per-org view of the global ToolRegistry.

Industry best practice: a filter wrapper (Decorator pattern) around the
global singleton.  Zero data duplication; org-scoped view returned on demand.

MCP tools are registered with a namespace tag ``_org_id`` stored on the
tool instance so the filter can isolate them by org.
"""

from __future__ import annotations

from harness.tools.protocol import CostClass, Tool
from harness.tools.registry import ToolRegistry, tool_registry


def _org_tag(tool: Tool) -> int | None:
    """Return the org_id tag on a tool, or None for native global tools."""
    return getattr(tool, "_org_id", None)


class OrgToolRegistry:
    """A read-only, org-scoped view of the global ``ToolRegistry``.

    Native (non-MCP) tools are always included (org_id=None).
    MCP tools are included only when their ``_org_id`` matches ``org_id``.

    Args:
        org_id: Grafana org ID to scope to.
        registry: Underlying ToolRegistry (defaults to module singleton).
    """

    def __init__(self, org_id: int, registry: ToolRegistry | None = None) -> None:
        self._org_id = org_id
        self._registry = registry or tool_registry

    def _visible(self, tool: Tool) -> bool:
        tag = _org_tag(tool)
        return tag is None or tag == self._org_id

    def all_tools(self) -> list[Tool]:
        """Return all tools visible to this org.

        Returns:
            Native tools + MCP tools owned by this org.
        """
        return [t for t in self._registry.all_tools() if self._visible(t)]

    def get(self, name: str) -> Tool:
        """Look up a tool by name, scoped to this org.

        Args:
            name: Tool name.

        Returns:
            Tool instance.

        Raises:
            KeyError: If no visible tool with that name.
        """
        tool = self._registry.get(name)
        if not self._visible(tool):
            raise KeyError(f"Tool {name!r} is not available for org {self._org_id}")
        return tool

    def tool_specs(self) -> list[dict]:
        """Return tool specifications for this org's visible tools.

        Returns:
            List of dicts with name, description, input_schema.
        """
        specs = []
        for tool in self.all_tools():
            schema = tool.input_schema.model_json_schema()
            specs.append({
                "name": tool.name,
                "description": tool.description,
                "input_schema": schema,
            })
        return specs

    def tools_by_cost_class(self, cost_class: CostClass) -> list[Tool]:
        """Return visible tools filtered by cost class.

        Args:
            cost_class: CostClass to filter by.

        Returns:
            Filtered list.
        """
        return [t for t in self.all_tools() if t.cost_class == cost_class]
