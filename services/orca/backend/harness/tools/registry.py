"""ToolRegistry — central registry for all harness tools.

Tools are registered at application startup and looked up by name during
guard evaluation and LLM tool-call dispatch.

Usage::

    from harness.tools.registry import tool_registry

    tool_registry.register(QueryMetricsTool())
    tool = tool_registry.get("query_metrics")
    result = await tool.run(ctx, tool.input_schema(**args))
"""

from __future__ import annotations

from harness.tools.protocol import CostClass, Tool


class ToolRegistry:
    """Maps tool names to ``Tool`` instances.

    All tools registered here are made available to the LLM via the guard
    pipeline and the ``ToolSpec`` list passed to ``LLMProvider.complete``.

    Raises:
        KeyError: On ``get()`` with an unknown tool name.
        ValueError: On ``register()`` with a duplicate tool name.
    """

    def __init__(self) -> None:
        self._tools: dict[str, Tool] = {}

    def register(self, tool: Tool, *, replace: bool = False) -> None:
        """Register a tool.

        Args:
            tool: Tool instance implementing the ``Tool`` protocol.
            replace: If True, silently replace an existing registration.
                If False (default), raises ValueError on duplicate names.

        Raises:
            ValueError: If the tool name is already registered and ``replace=False``.
        """
        if tool.name in self._tools and not replace:
            raise ValueError(
                f"Tool {tool.name!r} is already registered. "
                "Use replace=True to override."
            )
        self._tools[tool.name] = tool

    def get(self, name: str) -> Tool:
        """Return the tool with the given name.

        Args:
            name: Tool name string.

        Returns:
            Tool instance.

        Raises:
            KeyError: If no tool with that name is registered.
        """
        if name not in self._tools:
            registered = list(self._tools.keys())
            raise KeyError(
                f"No tool registered with name {name!r}. "
                f"Registered tools: {registered}"
            )
        return self._tools[name]

    def all_tools(self) -> list[Tool]:
        """Return all registered tools in registration order.

        Returns:
            List of Tool instances.
        """
        return list(self._tools.values())

    def tools_by_cost_class(self, cost_class: CostClass) -> list[Tool]:
        """Return all tools with the given cost class.

        Args:
            cost_class: CostClass enum value.

        Returns:
            Filtered list of Tool instances.
        """
        return [t for t in self._tools.values() if t.cost_class == cost_class]

    def tool_specs(self) -> list[dict]:
        """Return tool specifications formatted for LLM consumption.

        Returns:
            List of dicts with name, description, and input_schema (JSON Schema).
        """
        specs = []
        for tool in self._tools.values():
            schema = tool.input_schema.model_json_schema()
            specs.append({
                "name": tool.name,
                "description": tool.description,
                "input_schema": schema,
            })
        return specs

    def clear(self) -> None:
        """Remove all registered tools.  Primarily for testing."""
        self._tools.clear()


# Module-level singleton
tool_registry = ToolRegistry()
