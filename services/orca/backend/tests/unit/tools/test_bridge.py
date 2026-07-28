"""Unit tests for harness.tools.bridge — the LangChain guard-checked executor.

Proves the F1 fix at the component level: every tool call dispatched
through `GuardedToolExecutor` invokes `GuardPipeline.run` (so RBAC, PII
redaction, cost, budget, timeout, write-approval, and loop guards are never
bypassed), tools not present in the caller-supplied registry are never
executed, and a write-class tool (ApprovalRequired) is never invoked since
this executor has no approval consumer wired in.
"""

from __future__ import annotations

import asyncio
from typing import Any

import pytest
from pydantic import BaseModel

from harness.auth.types import AuthMode, GrafanaCredential
from harness.guards.guards import make_default_pipeline
from harness.guards.pipeline import GuardPipeline
from harness.guards.types import Allow, Deny, Guard
from harness.tools.bridge import (
    GuardedToolExecutor,
    ToolNotRegisteredError,
    bind_tools_from_registry,
)
from harness.tools.protocol import (
    BudgetConfig,
    CostClass,
    SpendState,
    ToolContext,
    ToolError,
    ToolResult,
)
from harness.tools.registry import ToolRegistry


# ---------------------------------------------------------------------------
# Fixtures / fakes
# ---------------------------------------------------------------------------


class _EchoInput(BaseModel):
    q: str = ""


class _EchoTool:
    """Minimal read-only harness Tool used across these tests."""

    name = "echo"
    description = "Echoes its input"
    input_schema = _EchoInput
    cost_class = CostClass.QUERY

    def __init__(self) -> None:
        self.calls: list[dict[str, Any]] = []

    async def run(self, ctx: ToolContext, input: _EchoInput) -> ToolResult:
        self.calls.append({"q": input.q})
        return ToolResult(data={"echoed": input.q}, source="internal")


class _WriteInput(BaseModel):
    pass


class _WriteTool:
    """A WRITE-cost-class tool — must never actually execute via the bridge
    since no approval consumer is wired into GuardedToolExecutor."""

    name = "create_silence"
    description = "Creates a silence"
    input_schema = _WriteInput
    cost_class = CostClass.WRITE

    def __init__(self) -> None:
        self.executed = False

    async def run(self, ctx: ToolContext, input: _WriteInput) -> ToolResult:
        self.executed = True  # pragma: no cover — must never be reached
        return ToolResult(data={"ok": True})


class _NoOpSpan:
    def add_event(self, *args: Any, **kwargs: Any) -> None:
        pass


def _make_ctx(session_id: str = "sess-1", org_id: int | None = 1) -> ToolContext:
    return ToolContext(
        session_id=session_id,
        credential=GrafanaCredential(token="", auth_mode=AuthMode.SERVICE_ACCOUNT, org_id=org_id),
        budget=BudgetConfig(),
        spend=SpendState(),
        otel_span=_NoOpSpan(),
    )


class _CountingGuard(Guard):
    """A Guard that records every call it receives — used to prove the
    executor actually routes calls through GuardPipeline.run rather than
    calling tool.run() directly."""

    name = "counting"

    def __init__(self) -> None:
        self.evaluations: list[tuple[str, dict]] = []

    async def evaluate(self, tool: Any, input: BaseModel, ctx: ToolContext) -> Any:
        self.evaluations.append((tool.name, input.model_dump()))
        return Allow()


# ---------------------------------------------------------------------------
# GuardedToolExecutor — core routing behaviour
# ---------------------------------------------------------------------------


class TestGuardedToolExecutorInvokesGuardPipeline:
    """The central F1 assertion: the live tool-execution path invokes
    GuardPipeline for every call — it is not possible to reach `tool.run()`
    without passing through the pipeline first."""

    async def test_execute_routes_through_guard_pipeline_run(self) -> None:
        """Patch GuardPipeline.run itself and assert it was awaited with
        the exact tool and input the executor was asked to dispatch."""
        registry = ToolRegistry()
        tool = _EchoTool()
        registry.register(tool)

        pipeline = make_default_pipeline()
        ctx = _make_ctx()
        executor = GuardedToolExecutor(registry=registry, pipeline=pipeline, ctx=ctx)

        original_run = GuardPipeline.run
        calls: list[tuple[Any, Any]] = []

        async def _spy_run(self_pipeline, tool_arg, input_arg, ctx_arg):
            calls.append((tool_arg, input_arg))
            return await original_run(self_pipeline, tool_arg, input_arg, ctx_arg)

        pipeline.run = _spy_run.__get__(pipeline, GuardPipeline)  # bind as method

        result = await executor.execute("echo", {"q": "hello"})

        assert len(calls) == 1
        called_tool, called_input = calls[0]
        assert called_tool is tool
        assert called_input.q == "hello"
        # The tool itself actually ran (Allow → tool.run called).
        assert tool.calls == [{"q": "hello"}]
        assert "hello" in result

    async def test_guard_evaluate_is_called_with_the_tool_and_input(self) -> None:
        """A custom Guard inside the pipeline observes every dispatched call —
        confirms guards are not bypassable from this executor."""
        registry = ToolRegistry()
        tool = _EchoTool()
        registry.register(tool)

        counting_guard = _CountingGuard()
        pipeline = GuardPipeline([counting_guard])
        executor = GuardedToolExecutor(registry=registry, pipeline=pipeline, ctx=_make_ctx())

        await executor.execute("echo", {"q": "first"})
        await executor.execute("echo", {"q": "second"})

        assert counting_guard.evaluations == [
            ("echo", {"q": "first"}),
            ("echo", {"q": "second"}),
        ]
        assert tool.calls == [{"q": "first"}, {"q": "second"}]

    async def test_deny_verdict_prevents_tool_execution(self) -> None:
        """A Deny verdict must stop the call before tool.run() executes."""

        class _DenyGuard(Guard):
            name = "deny_all"

            async def evaluate(self, tool: Any, input: BaseModel, ctx: ToolContext) -> Any:
                return Deny(reason="nope", code="test_deny")

        registry = ToolRegistry()
        tool = _EchoTool()
        registry.register(tool)

        pipeline = GuardPipeline([_DenyGuard()])
        executor = GuardedToolExecutor(registry=registry, pipeline=pipeline, ctx=_make_ctx())

        result = await executor.execute("echo", {"q": "should not run"})

        assert tool.calls == []  # never executed
        assert "denied" in result.lower()
        assert "test_deny" in result

    async def test_call_count_incremented_only_on_allow(self) -> None:
        """LoopGuard relies on ctx.spend.call_count being incremented after
        each successfully allowed call."""
        registry = ToolRegistry()
        registry.register(_EchoTool())
        pipeline = make_default_pipeline()
        ctx = _make_ctx()
        executor = GuardedToolExecutor(registry=registry, pipeline=pipeline, ctx=ctx)

        assert ctx.spend.call_count == 0
        await executor.execute("echo", {"q": "x"})
        assert ctx.spend.call_count == 1
        await executor.execute("echo", {"q": "y"})
        assert ctx.spend.call_count == 2


# ---------------------------------------------------------------------------
# Unregistered tools are never callable
# ---------------------------------------------------------------------------


class TestUnregisteredToolsNeverExecute:
    async def test_unregistered_tool_raises_and_does_not_execute_anything(self) -> None:
        registry = ToolRegistry()  # empty — nothing registered
        pipeline = make_default_pipeline()
        executor = GuardedToolExecutor(registry=registry, pipeline=pipeline, ctx=_make_ctx())

        with pytest.raises(ToolNotRegisteredError):
            await executor.execute("some_hallucinated_tool", {"anything": 1})

    async def test_org_scoped_registry_denies_other_orgs_tool(self) -> None:
        """OrgToolRegistry-backed executors must not resolve a tool tagged
        for a different org."""
        from harness.mcp.registry_bridge import OrgToolRegistry

        shared = ToolRegistry()
        tool = _EchoTool()
        tool._org_id = 1  # type: ignore[attr-defined]
        shared.register(tool)

        org2_view = OrgToolRegistry(org_id=2, registry=shared)
        pipeline = make_default_pipeline()
        executor = GuardedToolExecutor(
            registry=org2_view, pipeline=pipeline, ctx=_make_ctx(org_id=2)
        )

        with pytest.raises(ToolNotRegisteredError):
            await executor.execute("echo", {"q": "leak?"})
        assert tool.calls == []  # org1's tool was never invoked by org2


# ---------------------------------------------------------------------------
# Write-class tools — no approval consumer, so never executed
# ---------------------------------------------------------------------------


class TestWriteToolsNeverExecuteWithoutApprovalConsumer:
    async def test_write_tool_approval_required_does_not_execute(self) -> None:
        registry = ToolRegistry()
        write_tool = _WriteTool()
        registry.register(write_tool)

        pipeline = make_default_pipeline()  # includes WriteGuard
        executor = GuardedToolExecutor(registry=registry, pipeline=pipeline, ctx=_make_ctx())

        result = await executor.execute("create_silence", {})

        assert write_tool.executed is False
        assert "approval" in result.lower()
        assert "not executed" in result.lower() or "not support" in result.lower()


# ---------------------------------------------------------------------------
# bind_tools_from_registry — LangChain bridging
# ---------------------------------------------------------------------------


class TestBindToolsFromRegistry:
    async def test_bound_tools_delegate_to_executor_not_tool_run_directly(self) -> None:
        """The LangChain tool bound to the LLM must call executor.execute —
        never a direct reference to tool.run — so guard evaluation cannot be
        bypassed even if the LLM layer changes."""
        registry = ToolRegistry()
        tool = _EchoTool()
        registry.register(tool)

        pipeline = make_default_pipeline()
        executor = GuardedToolExecutor(registry=registry, pipeline=pipeline, ctx=_make_ctx())

        captured: dict[str, Any] = {}

        class _FakeLLM:
            def bind_tools(self, tools: list[Any]) -> "_FakeLLM":
                captured["tools"] = tools
                return self

        bind_tools_from_registry(_FakeLLM(), registry, executor)

        bound = captured["tools"]
        assert len(bound) == 1
        assert bound[0].name == "echo"

        # Invoking the LangChain tool must go through the executor (and
        # therefore through GuardPipeline), not tool.run() directly.
        result = await bound[0].ainvoke({"q": "via-langchain"})
        assert tool.calls == [{"q": "via-langchain"}]
        assert "via-langchain" in result

    async def test_tool_with_colon_qualified_name_gets_an_llm_safe_wire_name(self) -> None:
        """A tool whose real registry name contains characters LLM
        function-calling APIs reject (e.g. an MCP-qualified name like
        `mcp:1:github:search_issues`) must be exposed to the LLM under a
        sanitised, <=64-char alias — never its raw name (F1)."""
        import re

        from harness.mcp.tool_adapter import MCPTool
        from unittest.mock import AsyncMock

        mcp_tool = MCPTool(
            qualified_name="mcp:1:github:search_issues",
            description="Search GitHub issues",
            input_schema_dict={"properties": {"q": {"type": "string"}}},
            mcp_client=AsyncMock(return_value="ok"),
            bare_tool_name="search_issues",
        )
        registry = ToolRegistry()
        registry.register(mcp_tool)

        pipeline = make_default_pipeline()
        executor = GuardedToolExecutor(registry=registry, pipeline=pipeline, ctx=_make_ctx())

        captured: dict[str, Any] = {}

        class _FakeLLM:
            def bind_tools(self, tools: list[Any]) -> "_FakeLLM":
                captured["tools"] = tools
                return self

        bind_tools_from_registry(_FakeLLM(), registry, executor)

        bound_name = captured["tools"][0].name
        assert re.match(r"^[a-zA-Z0-9_-]{1,64}$", bound_name)
        assert bound_name != "mcp:1:github:search_issues"

    async def test_execute_resolves_the_wire_alias_back_to_the_real_tool(self) -> None:
        """Calling `executor.execute()` with the alias that was actually
        bound to the LLM must dispatch to the same real tool, through the
        same org-scoped registry lookup, as calling by the real name
        would."""
        from harness.mcp.tool_adapter import MCPTool
        from unittest.mock import AsyncMock

        mcp_client = AsyncMock(return_value="42 issues found")
        mcp_tool = MCPTool(
            qualified_name="mcp:1:github:search_issues",
            description="Search GitHub issues",
            input_schema_dict={"properties": {"q": {"type": "string"}}},
            mcp_client=mcp_client,
            bare_tool_name="search_issues",
        )
        registry = ToolRegistry()
        registry.register(mcp_tool)

        pipeline = make_default_pipeline()
        executor = GuardedToolExecutor(registry=registry, pipeline=pipeline, ctx=_make_ctx())

        alias = executor.alias_for("mcp:1:github:search_issues")
        result = await executor.execute(alias, {"q": "bug"})

        mcp_client.assert_awaited_once()
        assert "42 issues found" in result

    async def test_alias_resolution_never_crosses_org_boundaries(self) -> None:
        """Two different orgs' tools that share a server/tool name (and
        therefore alias to visually similar wire names) must never let one
        org's alias resolve to another org's tool — org isolation must
        survive alias resolution."""
        from harness.mcp.registry_bridge import OrgToolRegistry
        from harness.mcp.tool_adapter import MCPTool
        from unittest.mock import AsyncMock

        org1_client = AsyncMock(return_value="org1 result")
        org2_client = AsyncMock(return_value="org2 result")

        org1_tool = MCPTool(
            qualified_name="mcp:1:github:search_issues",
            description="org1",
            input_schema_dict={"properties": {"q": {"type": "string"}}},
            mcp_client=org1_client,
            bare_tool_name="search_issues",
        )
        org1_tool._org_id = 1  # type: ignore[attr-defined]
        org2_tool = MCPTool(
            qualified_name="mcp:2:github:search_issues",
            description="org2",
            input_schema_dict={"properties": {"q": {"type": "string"}}},
            mcp_client=org2_client,
            bare_tool_name="search_issues",
        )
        org2_tool._org_id = 2  # type: ignore[attr-defined]

        shared = ToolRegistry()
        shared.register(org1_tool)
        shared.register(org2_tool)

        org1_view = OrgToolRegistry(org_id=1, registry=shared)
        org1_executor = GuardedToolExecutor(
            registry=org1_view, pipeline=make_default_pipeline(), ctx=_make_ctx(org_id=1)
        )

        # org1's executor only ever knows about org1's alias — its alias
        # map is built solely from its own org-scoped `all_tools()`.
        org1_alias = org1_executor.alias_for("mcp:1:github:search_issues")
        result = await org1_executor.execute(org1_alias, {"q": "bug"})

        org1_client.assert_awaited_once()
        org2_client.assert_not_awaited()
        assert "org1 result" in result

        # org1's executor was never even told org2's real name exists, so
        # asking it to resolve org2's real name directly falls through to
        # "not a known alias, try as literal" — which correctly still
        # fails the org-scoped lookup rather than ever reaching org2's tool.
        with pytest.raises(ToolNotRegisteredError):
            await org1_executor.execute("mcp:2:github:search_issues", {"q": "bug"})
        org2_client.assert_not_awaited()


# ---------------------------------------------------------------------------
# GuardedToolExecutor — per-tool timeout enforcement (F1)
# ---------------------------------------------------------------------------


class _SlowTool:
    """A tool whose `run()` never completes within any reasonable test timeout."""

    name = "slow_tool"
    description = "Hangs forever"
    input_schema = _EchoInput
    cost_class = CostClass.QUERY

    async def run(self, ctx: ToolContext, input: _EchoInput) -> ToolResult:
        await asyncio.sleep(3600)
        return ToolResult(data="unreachable")  # pragma: no cover


class _RaisingTool:
    """A tool whose `run()` raises instead of returning a ToolResult(error=...)
    — exercises GuardedToolExecutor's own defence-in-depth classification."""

    name = "raising_tool"
    description = "Always raises"
    input_schema = _EchoInput
    cost_class = CostClass.QUERY

    def __init__(self, exc: BaseException) -> None:
        self._exc = exc

    async def run(self, ctx: ToolContext, input: _EchoInput) -> ToolResult:
        raise self._exc


class TestGuardedToolExecutorTimeoutAndErrorClassification:
    async def test_tool_exceeding_ctx_tool_timeout_s_is_cut_off(self) -> None:
        """A tool that hangs past `ctx.tool_timeout_s` must be cut off via
        `asyncio.wait_for`, not allowed to block the turn indefinitely."""
        registry = ToolRegistry()
        registry.register(_SlowTool())

        ctx = _make_ctx()
        ctx.tool_timeout_s = 0.05
        executor = GuardedToolExecutor(
            registry=registry, pipeline=GuardPipeline([]), ctx=ctx
        )

        result = await executor.execute("slow_tool", {"q": "x"})

        assert "tool_timeout" in result
        assert "exceeded" in result.lower()
        # A timeout still counts as a completed (allowed) call for LoopGuard
        # bookkeeping — it was allowed to run, it just didn't finish in time.
        assert ctx.spend.call_count == 1

    async def test_timeout_error_is_marked_retryable(self) -> None:
        registry = ToolRegistry()
        registry.register(_SlowTool())
        ctx = _make_ctx()
        ctx.tool_timeout_s = 0.05
        executor = GuardedToolExecutor(registry=registry, pipeline=GuardPipeline([]), ctx=ctx)

        # Drive through the same path _run_tool_safely uses, but assert on
        # the structured ToolResult directly (execute() only returns the
        # rendered string).
        tool = registry.get("slow_tool")
        result = await executor._run_tool_safely(tool, _EchoInput(q="x"), __import__("structlog").get_logger())
        assert result.error is not None
        assert result.error.code == "tool_timeout"
        assert result.error.retryable is True

    async def test_client_error_style_exception_is_not_retryable(self) -> None:
        """`tool.run()` raising something that classifies as a client/
        protocol-level error must NOT be marked retryable=True — only
        genuinely transient failures should be (F16)."""
        registry = ToolRegistry()
        registry.register(_RaisingTool(RuntimeError("unknown tool requested")))
        ctx = _make_ctx()
        executor = GuardedToolExecutor(registry=registry, pipeline=GuardPipeline([]), ctx=ctx)

        tool = registry.get("raising_tool")
        result = await executor._run_tool_safely(tool, _EchoInput(q="x"), __import__("structlog").get_logger())

        assert result.error is not None
        assert result.error.retryable is False

    async def test_connection_error_style_exception_is_retryable(self) -> None:
        import httpx

        registry = ToolRegistry()
        registry.register(_RaisingTool(httpx.ConnectError("connection refused")))
        ctx = _make_ctx()
        executor = GuardedToolExecutor(registry=registry, pipeline=GuardPipeline([]), ctx=ctx)

        tool = registry.get("raising_tool")
        result = await executor._run_tool_safely(tool, _EchoInput(q="x"), __import__("structlog").get_logger())

        assert result.error is not None
        assert result.error.retryable is True

    async def test_raised_exception_never_propagates_out_of_execute(self) -> None:
        """`execute()` must never raise for a registered tool, even when
        `tool.run()` itself raises — the caller (rca_graph node loop)
        always gets a renderable string back."""
        registry = ToolRegistry()
        registry.register(_RaisingTool(ValueError("boom")))
        ctx = _make_ctx()
        executor = GuardedToolExecutor(registry=registry, pipeline=GuardPipeline([]), ctx=ctx)

        result = await executor.execute("raising_tool", {"q": "x"})
        assert isinstance(result, str)
        assert "boom" in result
