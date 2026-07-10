"""Unit tests for MCPTool adapter."""

from __future__ import annotations

from unittest.mock import AsyncMock

import pytest

from harness.mcp.tool_adapter import MCPTool, _build_input_model
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
