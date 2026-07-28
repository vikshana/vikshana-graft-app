"""Adapts MCP tool responses to the harness ToolResult protocol.

An MCPTool wraps a discovered MCP server tool and satisfies the harness
``Tool`` protocol so it can be registered in ``ToolRegistry`` and evaluated
by the guard pipeline.
"""

from __future__ import annotations

import asyncio
import json
from typing import Any

import httpx
import structlog
from pydantic import BaseModel, create_model

from harness.tools.protocol import CostClass, ToolContext, ToolError, ToolResult

logger = structlog.get_logger()

# ---------------------------------------------------------------------------
# Error classification
# ---------------------------------------------------------------------------
#
# Exceptions that indicate a transient, infrastructure-level failure where
# retrying the *same* call has a reasonable chance of succeeding (the
# network blipped, the upstream MCP server timed out or returned a 5xx).
_RETRYABLE_EXCEPTIONS: tuple[type[BaseException], ...] = (
    httpx.TimeoutException,
    httpx.ConnectError,
    httpx.ReadError,
    httpx.WriteError,
    httpx.NetworkError,
    httpx.RemoteProtocolError,
    asyncio.TimeoutError,
)


def _classify_error(exc: Exception) -> tuple[str, bool]:
    """Classify an MCP tool-call exception into (error_code, retryable).

    Blanket ``retryable=True`` for every failure (the previous behaviour)
    risks retry storms against a server that is rejecting requests for a
    non-transient reason (bad arguments, permission denied, unknown tool).
    This classifies by the *actual* exception type instead:

    - Timeouts / connection / network errors → transient infra failure,
      retryable.
    - HTTP 5xx from the MCP server → upstream server error, retryable.
    - HTTP 4xx from the MCP server → client/request error, NOT retryable
      (the same arguments will fail the same way).
    - ``RuntimeError`` raised for a JSON-RPC ``error`` field in the MCP
      response → the server understood and rejected the call, NOT
      retryable.
    - Anything else (unexpected/unknown) → NOT retryable by default; an
      unclassified failure should not be blindly retried.

    Args:
        exc: The exception raised while calling the MCP server.

    Returns:
        Tuple of ``(error_code, retryable)``.
    """
    if isinstance(exc, httpx.HTTPStatusError):
        if exc.response.status_code >= 500:
            return "mcp_upstream_error", True
        return "mcp_client_error", False
    if isinstance(exc, (httpx.TimeoutException, asyncio.TimeoutError)):
        return "mcp_timeout", True
    if isinstance(exc, _RETRYABLE_EXCEPTIONS):
        return "mcp_connection_error", True
    if isinstance(exc, RuntimeError):
        # Raised by _call_mcp_tool for a JSON-RPC-level `error` field —
        # the server actively rejected the call (e.g. unknown tool,
        # invalid arguments). Retrying without changing the request would
        # fail identically.
        return "mcp_protocol_error", False
    return "mcp_error", False


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
            code, retryable = _classify_error(exc)
            log.error(
                "mcp_tool_failed",
                error=str(exc),
                error_type=type(exc).__name__,
                code=code,
                retryable=retryable,
            )
            return ToolResult(
                data=f"MCP tool error: {exc}",
                truncated=False,
                error=ToolError(code=code, message=str(exc), retryable=retryable),
            )
