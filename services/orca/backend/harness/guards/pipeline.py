"""Guard pipeline — runs all guards in order for each tool call."""

from __future__ import annotations

import time
from typing import Any

import structlog
from pydantic import BaseModel

from harness.guards.types import (
    Allow,
    Deny,
    Guard,
    GuardDecision,
    GuardVerdict,
)
from harness.tools.protocol import ToolContext

logger = structlog.get_logger()


class GuardPipeline:
    """Runs a sequence of guards against each tool call.

    Each guard is tried in order.  The first non-Allow verdict short-circuits
    the pipeline and is returned immediately.  If all guards return Allow, the
    tool call is permitted.

    Every decision is:
    - Emitted as an OTel span event on ``ctx.otel_span``
    - Written to ``tool_calls.guard_verdict`` by the caller
    - Logged via structlog with session_id and tool_name

    Args:
        guards: Ordered list of Guard instances.
    """

    def __init__(self, guards: list[Guard]) -> None:
        self._guards = guards

    async def run(
        self,
        tool: Any,
        input: BaseModel,
        ctx: ToolContext,
    ) -> tuple[GuardVerdict, list[GuardDecision]]:
        """Evaluate all guards for a tool call.

        Args:
            tool: Tool instance.
            input: Validated tool input (may be replaced by a Transform verdict).
            ctx: Tool context.

        Returns:
            Tuple of (final_verdict, list_of_all_decisions).
            If a Transform is returned, the caller should use the ``new_input``
            from the verdict and retry from the next guard in sequence.
            For all other non-Allow verdicts, execution stops.
        """
        decisions: list[GuardDecision] = []
        current_input = input
        log = logger.bind(session_id=ctx.session_id, tool=tool.name)

        for guard in self._guards:
            start = time.monotonic()
            try:
                verdict = await guard.evaluate(tool, current_input, ctx)
            except Exception as exc:
                log.error("guard_exception", guard=guard.name, error=str(exc))
                verdict = Deny(reason=f"Guard error: {exc}", code="guard_error")

            duration_ms = (time.monotonic() - start) * 1000
            decision = GuardDecision(
                guard_name=guard.name,
                verdict=verdict,
                duration_ms=duration_ms,
            )
            decisions.append(decision)

            # Emit OTel span event
            try:
                ctx.otel_span.add_event(
                    "guard_decision",
                    attributes={
                        "guard.name": guard.name,
                        "guard.verdict": type(verdict).__name__,
                        "guard.duration_ms": duration_ms,
                    },
                )
            except Exception:
                pass  # span may be a no-op

            if isinstance(verdict, Allow):
                log.debug("guard_allow", guard=guard.name)
                continue

            from harness.guards.types import Transform
            if isinstance(verdict, Transform):
                log.info(
                    "guard_transform",
                    guard=guard.name,
                    annotation=verdict.annotation,
                )
                current_input = verdict.new_input
                continue

            # Deny or ApprovalRequired — short-circuit
            log.info(
                "guard_deny",
                guard=guard.name,
                verdict=type(verdict).__name__,
                code=getattr(verdict, "code", ""),
                reason=getattr(verdict, "reason", ""),
            )
            return verdict, decisions

        return Allow(), decisions
