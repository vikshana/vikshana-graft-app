"""Shared exception -> (error_code, retryable) classification for tool calls.

Used anywhere a tool call's underlying transport/execution exception needs
to be turned into a structured ``harness.tools.protocol.ToolError`` instead
of a blanket ``retryable=True`` for every failure — which risks retry
storms against a server/tool that is rejecting a call for a non-transient
reason (bad arguments, permission denied, unknown tool). See
docs/harness-risk-review.md, F16.

``harness.mcp.tool_adapter._classify_error`` implements the equivalent
logic with ``mcp_``-prefixed codes for MCP-specific error reporting; this
module is the generic, adapter-agnostic version used by
``harness.tools.langchain_adapter.LangChainToolAdapter`` and
``harness.tools.bridge.GuardedToolExecutor`` (the executor's own
defence-in-depth catch around ``tool.run()``, alongside its
``asyncio.wait_for`` per-tool timeout).
"""

from __future__ import annotations

import asyncio

import httpx

_RETRYABLE_TRANSPORT_EXCEPTIONS: tuple[type[BaseException], ...] = (
    httpx.TimeoutException,
    httpx.ConnectError,
    httpx.ReadError,
    httpx.WriteError,
    httpx.NetworkError,
    httpx.RemoteProtocolError,
    asyncio.TimeoutError,
)


def classify_exception(exc: BaseException) -> tuple[str, bool]:
    """Classify a tool-call exception into ``(error_code, retryable)``.

    - Timeouts / connection / network transport errors -> transient
      infrastructure failure, retryable.
    - HTTP 5xx -> upstream server error, retryable.
    - HTTP 4xx -> client/request error, NOT retryable (the same arguments
      will fail identically on retry).
    - ``RuntimeError`` (e.g. a JSON-RPC ``error`` field, or another
      component's explicit "the server understood and rejected this
      call") -> NOT retryable.
    - Anything else -> NOT retryable by default; an unclassified failure
      should never be blindly retried.

    Args:
        exc: The exception raised while calling out to a tool/adapter.

    Returns:
        Tuple of ``(error_code, retryable)``.
    """
    if isinstance(exc, httpx.HTTPStatusError):
        if exc.response.status_code >= 500:
            return "upstream_error", True
        return "client_error", False
    if isinstance(exc, (httpx.TimeoutException, asyncio.TimeoutError)):
        return "timeout", True
    if isinstance(exc, _RETRYABLE_TRANSPORT_EXCEPTIONS):
        return "connection_error", True
    if isinstance(exc, RuntimeError):
        return "protocol_error", False
    return "tool_error", False
