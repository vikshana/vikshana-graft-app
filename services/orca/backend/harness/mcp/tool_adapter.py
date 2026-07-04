"""Adapts MCP tool responses to the harness ToolResult protocol.

An MCPTool wraps a discovered MCP server tool and satisfies the harness
``Tool`` protocol so it can be registered in ``ToolRegistry`` and evaluated
by the guard pipeline.
"""

from __future__ import annotations

import json
from typing import Any

import structlog
from pydantic import BaseModel, create_model

from harness.tools.protocol import CostClass, ToolContext, ToolError, ToolResult

logger = structlog.get_logger()


def _build_input_model(tool_name: str, schema: dict) -> type[BaseModel]:
    """Build a Pydantic model from a JSON Schema dict.

    Creates a dynamic Pydantic model with typed fields matching the schema's
    ``properties``.  Falls back to a single ``params`` field if the schema
    cannot be parsed.

    Args:
        tool_name: Tool name (used as the model class name).
        schema: JSON Schema dict from the MCP server.

    Returns:
        Pydantic BaseModel subclass.
    """
    props = schema.get("properties", {})
    required = set(schema.get("required", []))

    field_definitions: dict[str, Any] = {}
    for prop_name, prop_schema in props.items():
        python_type: type = str
        json_type = prop_schema.get("type", "string")
        if json_type == "integer":
            python_type = int
        elif json_type == "number":
            python_type = float
        elif json_type == "boolean":
            python_type = bool
        elif json_type == "array":
            python_type = list

        if prop_name in required:
            field_definitions[prop_name] = (python_type, ...)
        else:
            field_definitions[prop_name] = (python_type | None, None)

    if not field_definitions:
        field_definitions = {"params": (str | None, None)}

    model_name = "".join(w.capitalize() for w in tool_name.replace("-", "_").split("_")) + "Input"
    return create_model(model_name, **field_definitions)


class MCPTool:
    """Harness-compatible wrapper for a tool discovered from an MCP server.

    Satisfies the ``Tool`` protocol so it can be registered in
    ``ToolRegistry`` and dispatched through the guard pipeline.

    Args:
        qualified_name: Namespaced tool name ``mcp:{server}:{tool}``.
        description: Tool description from the MCP server.
        input_schema_dict: JSON Schema dict from the MCP server.
        mcp_client: Callable ``async (tool_name, args) -> str`` that
            actually calls the MCP server.
        bare_tool_name: Original tool name on the MCP server.
    """

    cost_class: CostClass = CostClass.QUERY

    def __init__(
        self,
        qualified_name: str,
        description: str,
        input_schema_dict: dict,
        mcp_client: Any,
        bare_tool_name: str,
    ) -> None:
        self.name = qualified_name
        self.description = description
        self.input_schema: type[BaseModel] = _build_input_model(
            bare_tool_name, input_schema_dict
        )
        self._mcp_client = mcp_client
        self._bare_tool_name = bare_tool_name

    async def run(self, ctx: ToolContext, input: BaseModel) -> ToolResult:
        """Execute the MCP tool and return a ToolResult.

        Args:
            ctx: Tool execution context.
            input: Pydantic model instance with tool arguments.

        Returns:
            ToolResult with the MCP server's response.
        """
        log = logger.bind(tool=self.name)
        try:
            args = {k: v for k, v in input.model_dump().items() if v is not None}
            result = await self._mcp_client(self._bare_tool_name, args)
            text = result if isinstance(result, str) else json.dumps(result)
            log.debug("mcp_tool_success", result_len=len(text))
            return ToolResult(data=text, truncated=False)
        except Exception as exc:
            log.error("mcp_tool_failed", error=str(exc))
            return ToolResult(
                data=f"MCP tool error: {exc}",
                truncated=False,
                error=ToolError(code="mcp_error", message=str(exc), retryable=True),
            )
