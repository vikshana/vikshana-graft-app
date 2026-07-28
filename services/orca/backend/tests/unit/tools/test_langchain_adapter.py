"""Unit tests for harness.tools.langchain_adapter — LangChainToolAdapter.

Focused on the F16 fix: a wrapped LangChain tool's `ainvoke()` failure must
be classified by the actual exception type (via
`harness.tools.error_classification.classify_exception`) instead of a
blanket `retryable=True` for every failure, which risks retry storms
against a tool rejecting a call for a non-transient reason (bad
arguments, permission denied, unknown tool).
"""

from __future__ import annotations

from unittest.mock import AsyncMock, MagicMock

import httpx
import pytest
from pydantic import BaseModel

from harness.tools.langchain_adapter import LangChainToolAdapter
from harness.tools.protocol import CostClass, ToolContext


class _Schema(BaseModel):
    q: str = ""


def _mock_lc_tool(name: str = "some_tool") -> MagicMock:
    tool = MagicMock()
    tool.name = name
    tool.description = f"Mock {name}"
    tool.args_schema = _Schema
    return tool


class _FakeCtx:
    session_id = "sess-1"
    tool_timeout_s = 30


class TestLangChainToolAdapterRun:
    async def test_successful_call_returns_tool_result(self) -> None:
        lc_tool = _mock_lc_tool()
        lc_tool.ainvoke = AsyncMock(return_value="42 errors/min")
        adapter = LangChainToolAdapter(lc_tool)

        result = await adapter.run(_FakeCtx(), _Schema(q="errors"))

        assert result.data == "42 errors/min"
        assert result.error is None

    async def test_cost_class_is_query(self) -> None:
        adapter = LangChainToolAdapter(_mock_lc_tool())
        assert adapter.cost_class == CostClass.QUERY

    async def test_connection_error_is_classified_retryable(self) -> None:
        lc_tool = _mock_lc_tool()
        lc_tool.ainvoke = AsyncMock(side_effect=httpx.ConnectError("connection refused"))
        adapter = LangChainToolAdapter(lc_tool)

        result = await adapter.run(_FakeCtx(), _Schema(q="x"))

        assert result.error is not None
        assert result.error.retryable is True

    async def test_http_4xx_is_classified_not_retryable(self) -> None:
        lc_tool = _mock_lc_tool()
        request = httpx.Request("POST", "http://mcp.local/tools/call")
        response = httpx.Response(404, request=request)
        exc = httpx.HTTPStatusError("not found", request=request, response=response)
        lc_tool.ainvoke = AsyncMock(side_effect=exc)
        adapter = LangChainToolAdapter(lc_tool)

        result = await adapter.run(_FakeCtx(), _Schema(q="x"))

        assert result.error is not None
        assert result.error.retryable is False

    async def test_unexpected_error_is_not_retryable_by_default(self) -> None:
        """F16: a generic/unclassified failure must NOT default to
        retryable=True — only genuinely transient infra failures should."""
        lc_tool = _mock_lc_tool()
        lc_tool.ainvoke = AsyncMock(side_effect=ValueError("bad arguments"))
        adapter = LangChainToolAdapter(lc_tool)

        result = await adapter.run(_FakeCtx(), _Schema(q="x"))

        assert result.error is not None
        assert result.error.retryable is False

    async def test_run_never_raises(self) -> None:
        lc_tool = _mock_lc_tool()
        lc_tool.ainvoke = AsyncMock(side_effect=RuntimeError("boom"))
        adapter = LangChainToolAdapter(lc_tool)

        result = await adapter.run(_FakeCtx(), _Schema(q="x"))
        assert result.error is not None
        assert "boom" in result.data
