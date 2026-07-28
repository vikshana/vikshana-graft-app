"""LangChain bridge — routes live LLM tool calls through GuardPipeline.

This is the "minimal safe LangChain bridge/executor" identified as missing
by the F1 risk-review finding: the live RCA graph
(``app/agent/rca_graph.py``) previously called
``llm.bind_tools(get_grafana_tools())`` and then ``tool.ainvoke(args)``
directly on the LLM's requested tool call — never running
``GuardPipeline`` (RBAC, PII redaction, cost, budget, timeout,
write-approval, loop) and never consulting the org-scoped
``OrgToolRegistry`` populated by ``harness.mcp.client_manager`` for
user-configured MCP servers. See docs/harness-risk-review.md, F1.

``GuardedToolExecutor`` is the single chokepoint every live tool call must
pass through: it looks the tool up in the caller-supplied registry (never
falling back to calling arbitrary code), evaluates it against
``GuardPipeline``, and only invokes ``tool.run()`` on an ``Allow``
verdict. A tool name that is not registered/visible raises
``ToolNotRegisteredError`` — it is never silently executed. Every call is
wrapped in ``asyncio.wait_for`` honouring ``ctx.tool_timeout_s`` (set by
``TimeoutGuard``) so a hung tool can never stall a turn past its
configured ceiling, and any exception ``tool.run()`` raises is classified
via ``harness.tools.error_classification.classify_exception`` instead of
defaulting to ``retryable=True`` for every failure (see
docs/harness-risk-review.md, F1/F16).

Real registry tool names (e.g. MCP-qualified names like
``mcp:{org_id}:{server}:{tool}`` — see
``harness.mcp.models.DiscoveredTool.qualified_name``) are not guaranteed
to satisfy the character/length constraints LLM function-calling APIs
impose on tool names. ``GuardedToolExecutor`` and ``bind_tools_from_registry``
expose a collision-safe, ``<=64``-char *wire alias* to the LLM for every
tool (``harness.tools.naming.build_wire_aliases``) and transparently
resolve an LLM-issued alias back to the real, registry/org-scoped tool
name before dispatch — this never weakens org isolation since the alias
map is built from (and resolution still goes through) the caller-supplied,
already org-scoped registry.

``bind_tools_from_registry`` wraps each visible tool as a LangChain
``StructuredTool`` whose coroutine delegates to the executor, so the LLM
never receives a direct reference to ``tool.run``. every LLM-initiated
call is guaranteed to go through the executor by construction.
"""

from __future__ import annotations

import asyncio
from dataclasses import dataclass, field
from typing import Any

import structlog
from langchain_core.tools import StructuredTool

from harness.guards.pipeline import GuardPipeline
from harness.guards.types import Allow, ApprovalRequired, Deny
from harness.tools.error_classification import classify_exception
from harness.tools.naming import build_wire_aliases
from harness.tools.protocol import ToolContext, ToolError, ToolResult, ToolResultEnvelope

logger = structlog.get_logger()


class ToolNotRegisteredError(Exception):
    """Raised when a tool call targets a name that is not registered or not
    visible to the calling organisation.

    Callers should surface this back to the LLM as a tool-call error (e.g.
    a ``ToolMessage`` with the error text) rather than letting it propagate
    — it is a normal, expected outcome whenever the LLM hallucinates a tool
    name or attempts to reach a tool scoped to a different org.
    """


@dataclass
class GuardedToolExecutor:
    """Executes a named tool call through ``GuardPipeline`` against a registry.

    Args:
        registry: Tool registry view to resolve tool names against.
            Typically a per-turn ``harness.tools.registry.ToolRegistry`` or
            an org-scoped ``harness.mcp.registry_bridge.OrgToolRegistry`` —
            anything exposing ``get(name) -> Tool`` and ``all_tools() ->
            list[Tool]``.
        pipeline: ``GuardPipeline`` instance to evaluate every call against.
        ctx: ``ToolContext`` shared across all calls in this turn (its
            ``spend.call_count`` is incremented after every allowed call so
            ``LoopGuard`` can enforce a per-turn ceiling, and its
            ``tool_timeout_s`` — set by ``TimeoutGuard`` — bounds every
            ``tool.run()`` call via ``asyncio.wait_for``).
    """

    registry: Any
    pipeline: GuardPipeline
    ctx: ToolContext
    _alias_to_real: dict[str, str] = field(default_factory=dict, init=False, repr=False)
    _real_to_alias: dict[str, str] = field(default_factory=dict, init=False, repr=False)

    def __post_init__(self) -> None:
        """Precompute the LLM-safe wire-alias map from the registry's current tools.

        Snapshotted once at construction time — the same point at which
        ``bind_tools_from_registry`` (if used) snapshots ``registry.all_tools()``
        for LLM binding, so the alias exposed to the LLM and the alias this
        executor resolves back to a real tool always agree.
        """
        real_names = [t.name for t in self.registry.all_tools()]
        self._alias_to_real, self._real_to_alias = build_wire_aliases(real_names)

    def alias_for(self, real_name: str) -> str:
        """Return the LLM-safe wire alias for a real registry tool name.

        Args:
            real_name: Real tool name as registered (``tool.name``).

        Returns:
            The collision-safe, ``<=64``-char alias to expose to the LLM,
            or ``real_name`` itself if it was not part of this executor's
            registry snapshot (e.g. a tool registered after construction —
            falls back to the identity mapping rather than erroring).
        """
        return self._real_to_alias.get(real_name, real_name)

    async def execute(self, tool_name: str, args: dict[str, Any]) -> str:
        """Look up, guard-check, and run a tool call; return a rendered string.

        Args:
            tool_name: Name the LLM requested — either the wire alias this
                executor exposed via ``bind_tools_from_registry``/``alias_for``,
                or (for callers that dispatch by real name directly, e.g.
                existing tests) the real registry name itself. Resolved back
                to the real name via the alias map built in
                ``__post_init__``, falling back to treating it as already a
                real name when it is not a known alias.
            args: Raw tool-call arguments from the LLM.

        Returns:
            Prompt-safe rendered result string on success or guard denial —
            this method never raises for a *known* tool. Unknown tool names
            raise ``ToolNotRegisteredError`` so the caller decides how to
            surface that to the LLM without ever attempting to run
            unregistered code.

        Raises:
            ToolNotRegisteredError: If ``tool_name`` (after alias
                resolution) is not registered or not visible to the org
                this executor's registry is scoped to.
        """
        real_name = self._alias_to_real.get(tool_name, tool_name)
        log = logger.bind(session_id=self.ctx.session_id, tool=real_name)

        try:
            tool = self.registry.get(real_name)
        except KeyError as exc:
            log.warning("bridge_tool_not_registered")
            raise ToolNotRegisteredError(
                f"Tool {tool_name!r} is not registered or not visible to this "
                "session's organisation."
            ) from exc

        try:
            input_model = tool.input_schema(**args)
        except Exception as exc:
            log.warning("bridge_tool_invalid_args", error=str(exc))
            return f"Invalid arguments for tool {tool_name!r}: {exc}"

        verdict, effective_input, _decisions = await self.pipeline.run(
            tool, input_model, self.ctx
        )

        if isinstance(verdict, Allow):
            result = await self._run_tool_safely(tool, effective_input, log)
            self.ctx.spend.call_count += 1
            return ToolResultEnvelope.render(tool_name, result)

        if isinstance(verdict, Deny):
            log.info("bridge_tool_denied", code=verdict.code, reason=verdict.reason)
            return f"Tool call denied ({verdict.code}): {verdict.reason}"

        if isinstance(verdict, ApprovalRequired):
            # No approval consumer is wired into this executor — a write-class
            # tool must never execute from this path. This is defence in
            # depth: today no WRITE-cost-class tool is registered on the live
            # RCA path, so this branch should be unreachable in practice, but
            # if one ever were registered, the call must still not execute
            # silently (see docs/harness-risk-review.md, F1).
            log.warning("bridge_tool_approval_required_unsupported", reason=verdict.reason)
            return (
                f"Tool call to {tool_name!r} requires human approval, which this "
                "execution context does not support. The call was not executed."
            )

        # Transform never short-circuits GuardPipeline.run — Allow/Deny/
        # ApprovalRequired are the only possible terminal verdicts.
        return f"Tool call to {tool_name!r} could not be evaluated."  # pragma: no cover

    async def _run_tool_safely(
        self, tool: Any, effective_input: Any, log: Any
    ) -> ToolResult:
        """Run ``tool.run()`` under a wall-clock ceiling, never propagating a raw exception.

        Wraps the call in ``asyncio.wait_for(..., timeout=ctx.tool_timeout_s)``
        — ``TimeoutGuard.evaluate()`` only *checks* elapsed time before a
        call starts; this is what actually enforces the per-tool ceiling
        against a tool that hangs mid-call (see
        ``harness.guards.guards.TimeoutGuard`` and
        docs/harness-risk-review.md, F1). Any exception ``tool.run()``
        raises — timeout or otherwise — is classified via
        ``classify_exception`` instead of defaulting to ``retryable=True``
        for every failure (F16); the ``Tool`` protocol says ``run()``
        "never raises", but this is defence in depth for a tool
        implementation that doesn't hold to that contract.

        Args:
            tool: Resolved Tool instance.
            effective_input: Guard-transformed input to run with.
            log: Bound structlog logger.

        Returns:
            ToolResult — the tool's own result, or a synthesised
            ``ToolResult(error=...)`` on timeout/exception.
        """
        try:
            return await asyncio.wait_for(
                tool.run(self.ctx, effective_input), timeout=self.ctx.tool_timeout_s
            )
        except asyncio.TimeoutError:
            log.warning("bridge_tool_timeout", timeout_s=self.ctx.tool_timeout_s)
            return ToolResult(
                data=f"Tool {tool.name!r} timed out after {self.ctx.tool_timeout_s}s",
                error=ToolError(
                    code="tool_timeout",
                    message=f"Tool call exceeded the {self.ctx.tool_timeout_s}s timeout",
                    retryable=True,
                ),
            )
        except Exception as exc:
            code, retryable = classify_exception(exc)
            log.error(
                "bridge_tool_run_raised",
                error=str(exc),
                error_type=type(exc).__name__,
                code=code,
                retryable=retryable,
            )
            return ToolResult(
                data=f"Tool {tool.name!r} raised an unexpected error: {exc}",
                error=ToolError(code=code, message=str(exc), retryable=retryable),
            )


def _to_langchain_tool(tool: Any, executor: GuardedToolExecutor) -> StructuredTool:
    """Wrap a single harness ``Tool`` as a LangChain ``StructuredTool``.

    Args:
        tool: Harness ``Tool``-protocol instance (``name``, ``description``,
            ``input_schema``).
        executor: Shared ``GuardedToolExecutor`` — the wrapped tool's
            coroutine always delegates to ``executor.execute``, so the LLM
            never gets a direct reference to ``tool.run``.

    Returns:
        LangChain ``StructuredTool`` bindable via ``llm.bind_tools([...])``.
        Its exposed ``name`` is the LLM-safe wire alias for ``tool.name``
        (``executor.alias_for``), not necessarily the real registry name —
        see ``harness.tools.naming`` for why.
    """
    wire_name = executor.alias_for(tool.name)

    async def _coroutine(**kwargs: Any) -> str:
        return await executor.execute(wire_name, kwargs)

    return StructuredTool.from_function(
        name=wire_name,
        description=tool.description or tool.name,
        args_schema=tool.input_schema,
        coroutine=_coroutine,
    )


def bind_tools_from_registry(llm: Any, registry: Any, executor: GuardedToolExecutor) -> Any:
    """Convert a tool registry view into LangChain tools and bind them to an LLM.

    Args:
        llm: A LangChain chat model supporting ``.bind_tools(...)``.
        registry: Tool registry view exposing ``all_tools() -> list[Tool]``
            (a ``ToolRegistry`` or an org-scoped ``OrgToolRegistry``).
        executor: ``GuardedToolExecutor`` wired to the same registry/ctx —
            every bound tool's execution routes through it, and therefore
            through ``GuardPipeline``.

    Returns:
        The result of ``llm.bind_tools(...)`` with guard-checked tools.
    """
    langchain_tools = [_to_langchain_tool(t, executor) for t in registry.all_tools()]
    return llm.bind_tools(langchain_tools)
