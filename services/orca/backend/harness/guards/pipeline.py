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

    def start_turn(self, started_at: float | None = None) -> None:
        """Mark the beginning of a new turn for every guard that tracks it.

        Forwards to ``guard.start_turn(started_at)`` on every guard in this
        pipeline that implements it (currently ``TimeoutGuard`` — see
        ``harness.guards.guards.TimeoutGuard.start_turn``); guards that
        don't track turn-scoped state are unaffected. Must be called once
        per turn — a pipeline whose ``TimeoutGuard`` never has this called
        never enforces its per-turn wall-clock ceiling (it stays permanently
        "not started", see docs/harness-risk-review.md, F1).

        Args:
            started_at: Optional explicit start time to seed every guard
                with (forwarded as-is; each guard interprets it using
                whatever clock it uses internally). Defaults to "now" per
                guard when omitted.
        """
        for guard in self._guards:
            start_turn = getattr(guard, "start_turn", None)
            if callable(start_turn):
                start_turn(started_at)

    def start_session(self, started_at: float | None = None) -> None:
        """Mark the beginning of a new session for every guard that tracks it.

        Forwards to ``guard.start_session(started_at)`` on every guard that
        implements it. Unlike ``start_turn`` — which is meant to be called
        fresh at the start of every turn — ``started_at`` should normally be
        threaded through from persisted state after the first call, so a
        session that spans multiple turns (e.g. an interactive RCA
        investigation's several interrupt/resume rounds) is bounded by its
        true start, not reset every round (see
        docs/harness-risk-review.md, F1).

        Args:
            started_at: Optional explicit session start time. Defaults to
                "now" per guard when omitted (i.e. the first turn of a new
                session).
        """
        for guard in self._guards:
            start_session = getattr(guard, "start_session", None)
            if callable(start_session):
                start_session(started_at)

    async def run(
        self,
        tool: Any,
        input: BaseModel,
        ctx: ToolContext,
    ) -> tuple[GuardVerdict, BaseModel, list[GuardDecision]]:
        """Evaluate all guards for a tool call.

        Args:
            tool: Tool instance.
            input: Validated tool input (may be replaced by a Transform verdict).
            ctx: Tool context.

        Returns:
            Tuple of ``(final_verdict, effective_input, list_of_all_decisions)``.

            ``effective_input`` is the input as it stood after the last
            applied ``Transform`` (or the original ``input`` if no guard
            transformed it) — callers MUST execute the tool with this value,
            not the original ``input``, otherwise a guard's transformation
            (e.g. ``CostGuard`` clamping a time range) is silently discarded
            and the *original*, unclamped input would be the one that
            actually runs (see docs/harness-risk-review.md, F1).

            For a terminal ``Deny``/``ApprovalRequired`` verdict,
            ``effective_input`` reflects whatever transforms were applied by
            guards that ran *before* the short-circuit, which is useful for
            audit logging even though the call does not proceed.
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
            return verdict, current_input, decisions

        return Allow(), current_input, decisions
