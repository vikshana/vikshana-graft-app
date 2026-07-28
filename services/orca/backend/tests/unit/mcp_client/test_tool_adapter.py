"""Unit tests for MCPTool adapter."""

from __future__ import annotations

import asyncio
from unittest.mock import AsyncMock

import httpx
import pytest

from harness.mcp.tool_adapter import MCPTool, _build_input_model, _classify_error
from harness.tools.protocol import CostClass, ToolContext, ToolResult


class _FakeCtx:
    session_id = "sess-1"
    tool_timeout_s = 30


class TestBuildInputModel:
    def test_string_fields(self) -> None:
        schema = {"properties": {"q": {"type": "string"}}, "required": ["q"]}
        Model = _build_input_model("search", schema)
        inst = Model(q="hello")
        assert inst.q == "hello"

    def test_empty_schema_has_params_field(self) -> None:
        Model = _build_input_model("noop", {})
        inst = Model()
        assert hasattr(inst, "params")

    def test_integer_field(self) -> None:
        schema = {"properties": {"limit": {"type": "integer"}}, "required": ["limit"]}
        Model = _build_input_model("paginated", schema)
        inst = Model(limit=10)
        assert inst.limit == 10


class TestMCPTool:
    async def test_run_returns_tool_result(self) -> None:
        mock_client = AsyncMock(return_value="result text")
        tool = MCPTool(
            qualified_name="mcp:srv:search",
            description="Search tool",
            input_schema_dict={"properties": {"q": {"type": "string"}}},
            mcp_client=mock_client,
            bare_tool_name="search",
        )
        inp = tool.input_schema(q="test")
        result = await tool.run(_FakeCtx(), inp)
        assert isinstance(result, ToolResult)
        assert result.data == "result text"
        assert not result.truncated

    async def test_run_handles_dict_result(self) -> None:
        mock_client = AsyncMock(return_value={"data": [1, 2, 3]})
        tool = MCPTool(
            qualified_name="mcp:srv:data",
            description="Data tool",
            input_schema_dict={},
            mcp_client=mock_client,
            bare_tool_name="data",
        )
        inp = tool.input_schema()
        result = await tool.run(_FakeCtx(), inp)
        assert '{"data"' in result.data

    async def test_run_error_returns_error_result(self) -> None:
        mock_client = AsyncMock(side_effect=RuntimeError("server down"))
        tool = MCPTool(
            qualified_name="mcp:srv:fail",
            description="Failing tool",
            input_schema_dict={},
            mcp_client=mock_client,
            bare_tool_name="fail",
        )
        inp = tool.input_schema()
        result = await tool.run(_FakeCtx(), inp)
        assert "error" in result.data.lower()
        assert result.error is not None

    def test_cost_class_is_query(self) -> None:
        tool = MCPTool("x", "d", {}, AsyncMock(), "x")
        assert tool.cost_class == CostClass.QUERY


# ---------------------------------------------------------------------------
# Error classification (harness-risk-review.md, F16)
#
# Retryable must reflect the actual error type, not a blanket True — a 4xx
# or protocol-level rejection will fail identically on retry and can cause
# retry storms; only genuinely transient infra failures should be retryable.
# ---------------------------------------------------------------------------


class TestClassifyError:
    def test_timeout_is_retryable(self) -> None:
        code, retryable = _classify_error(httpx.ConnectTimeout("timed out"))
        assert retryable is True
        assert code == "mcp_timeout"

    def test_asyncio_timeout_is_retryable(self) -> None:
        code, retryable = _classify_error(asyncio.TimeoutError())
        assert retryable is True
        assert code == "mcp_timeout"

    def test_connect_error_is_retryable(self) -> None:
        code, retryable = _classify_error(httpx.ConnectError("connection refused"))
        assert retryable is True
        assert code == "mcp_connection_error"

    def test_http_5xx_is_retryable(self) -> None:
        request = httpx.Request("POST", "http://mcp.local/tools/call")
        response = httpx.Response(502, request=request)
        exc = httpx.HTTPStatusError("bad gateway", request=request, response=response)
        code, retryable = _classify_error(exc)
        assert retryable is True
        assert code == "mcp_upstream_error"

    def test_http_4xx_is_not_retryable(self) -> None:
        request = httpx.Request("POST", "http://mcp.local/tools/call")
        response = httpx.Response(404, request=request)
        exc = httpx.HTTPStatusError("not found", request=request, response=response)
        code, retryable = _classify_error(exc)
        assert retryable is False
        assert code == "mcp_client_error"

    def test_protocol_runtime_error_is_not_retryable(self) -> None:
        code, retryable = _classify_error(RuntimeError("MCP tool call error: unknown tool"))
        assert retryable is False
        assert code == "mcp_protocol_error"

    def test_unexpected_error_is_not_retryable(self) -> None:
        code, retryable = _classify_error(ValueError("weird"))
        assert retryable is False
        assert code == "mcp_error"


class TestMCPToolRunRetryClassification:
    async def test_run_timeout_sets_retryable_true(self) -> None:
        mock_client = AsyncMock(side_effect=httpx.ConnectTimeout("timed out"))
        tool = MCPTool(
            qualified_name="mcp:srv:slow",
            description="Slow tool",
            input_schema_dict={},
            mcp_client=mock_client,
            bare_tool_name="slow",
        )
        result = await tool.run(_FakeCtx(), tool.input_schema())
        assert result.error is not None
        assert result.error.retryable is True
        assert result.error.code == "mcp_timeout"

    async def test_run_http_404_sets_retryable_false(self) -> None:
        request = httpx.Request("POST", "http://mcp.local/tools/call")
        response = httpx.Response(404, request=request)
        exc = httpx.HTTPStatusError("not found", request=request, response=response)
        mock_client = AsyncMock(side_effect=exc)
        tool = MCPTool(
            qualified_name="mcp:srv:missing",
            description="Missing tool",
            input_schema_dict={},
            mcp_client=mock_client,
            bare_tool_name="missing",
        )
        result = await tool.run(_FakeCtx(), tool.input_schema())
        assert result.error is not None
        assert result.error.retryable is False
        assert result.error.code == "mcp_client_error"

    async def test_run_protocol_error_sets_retryable_false(self) -> None:
        mock_client = AsyncMock(side_effect=RuntimeError("MCP tool call error: bad args"))
        tool = MCPTool(
            qualified_name="mcp:srv:badargs",
            description="Bad args tool",
            input_schema_dict={},
            mcp_client=mock_client,
            bare_tool_name="badargs",
        )
        result = await tool.run(_FakeCtx(), tool.input_schema())
        assert result.error is not None
        assert result.error.retryable is False
        assert result.error.code == "mcp_protocol_error"
