"""All six guard implementations for Phase 1."""

from __future__ import annotations

import asyncio
import re
import time
from datetime import datetime, timezone
from typing import Any

import structlog
from pydantic import BaseModel

from harness.guards.types import (
    Allow,
    ApprovalRequired,
    Deny,
    Guard,
    GuardVerdict,
    Transform,
)
from harness.tools.protocol import CostClass, ToolContext

logger = structlog.get_logger()


# ── Guard 1: RBAC ────────────────────────────────────────────────────────────


class RBACGuard(Guard):
    """Plugin-level access guard — checks credential against allowed roles list.

    Defence-in-depth: the Go gateway enforces RBAC at the HTTP layer;
    this re-checks here at the tool-call level.

    Args:
        allowed_roles: Set of Grafana role names that are permitted to use the agent.
            Example: ``{"Admin", "Editor"}``.
    """

    name = "rbac"

    def __init__(self, allowed_roles: set[str] | None = None) -> None:
        if allowed_roles is None:
            from app.config import settings
            self._allowed = set(getattr(settings, "RBAC_ALLOWED_ROLES", ["Admin", "Editor"]))
        else:
            self._allowed = set(allowed_roles)

    async def evaluate(self, tool: Any, input: BaseModel, ctx: ToolContext) -> GuardVerdict:
        """Allow if the credential's role is in the allowed list.

        Args:
            tool: Tool being called.
            input: Tool input (unused).
            ctx: Tool context with credential.

        Returns:
            Allow or Deny.
        """
        role = getattr(ctx.credential, "role", None)
        auth_mode = getattr(ctx.credential, "auth_mode", None)

        # Service-account tokens are not user-attributed — allow through
        # (RBAC is enforced at gateway level for service accounts)
        from harness.auth.types import AuthMode
        if auth_mode == AuthMode.SERVICE_ACCOUNT:
            return Allow()

        if role is None:
            # No role info — deny (safe default)
            return Deny(reason="No Grafana role on credential", code="rbac")

        if role in self._allowed:
            return Allow()

        return Deny(
            reason=f"Grafana role {role!r} is not permitted to use the agent",
            code="rbac",
        )


# ── Guard 2: Cost ─────────────────────────────────────────────────────────────


class CostGuard(Guard):
    """Cost guard for native query tools — clamps time ranges and rejects unbounded matchers.

    Only applied to ``cost_class=QUERY`` tools; CHEAP and WRITE tools skip it.

    Args:
        max_range_hours: Maximum allowed query time range in hours (default 24).
    """

    name = "cost"
    _UNBOUNDED_MATCHER = re.compile(
        r'\{[^}]*=~"[.+*][^"]*"[^}]*\}', re.DOTALL
    )

    def __init__(self, max_range_hours: int | None = None) -> None:
        if max_range_hours is None:
            from app.config import settings
            self._max_hours = getattr(settings, "MAX_QUERY_RANGE_HOURS", 24)
        else:
            self._max_hours = max_range_hours

    async def evaluate(self, tool: Any, input: BaseModel, ctx: ToolContext) -> GuardVerdict:
        """Check time range and matcher patterns on QUERY tools.

        Args:
            tool: Tool being called.
            input: Tool input (may have from_, to, expr fields).
            ctx: Tool context (unused).

        Returns:
            Allow, Transform (clamped range), or Deny (unbounded matcher).
        """
        if tool.cost_class != CostClass.QUERY:
            return Allow()

        # Check for unbounded matchers in expr
        expr = getattr(input, "expr", None)
        if expr and self._UNBOUNDED_MATCHER.search(expr):
            return Deny(
                reason=f"Unbounded label matcher in expression: {expr[:100]!r}. "
                       "Use more specific label selectors.",
                code="cost",
            )

        # Check time range
        from_ = getattr(input, "from_", None)
        to = getattr(input, "to", None)
        if from_ and to:
            range_hours = self._estimate_range_hours(from_, to)
            if range_hours is not None and range_hours > self._max_hours:
                # Transform: clamp the range
                clamped_from = f"now-{self._max_hours}h"
                try:
                    new_input = input.model_copy(update={"from_": clamped_from})
                except Exception:
                    # Fallback if model_copy fails
                    return Deny(
                        reason=f"Time range {range_hours:.0f}h exceeds max {self._max_hours}h",
                        code="cost",
                    )
                return Transform(
                    new_input=new_input,
                    annotation=(
                        f"Time range clamped from ~{range_hours:.0f}h "
                        f"to {self._max_hours}h (max allowed)"
                    ),
                )

        return Allow()

    def _estimate_range_hours(self, from_: str, to: str) -> float | None:
        """Estimate query range in hours from Grafana time strings.

        Args:
            from_: Grafana relative or absolute time string.
            to: Grafana relative or absolute time string.

        Returns:
            Estimated range in hours, or None if not parseable.
        """
        # Handle relative times like "now-24h", "now-7d", "now-1h"
        def _relative_to_hours(s: str) -> float | None:
            if s == "now":
                return 0.0
            m = re.match(r"now-(\d+)([smhdw])", s)
            if not m:
                return None
            n, unit = int(m.group(1)), m.group(2)
            multipliers = {"s": 1/3600, "m": 1/60, "h": 1.0, "d": 24.0, "w": 168.0}
            return n * multipliers.get(unit, 1.0)

        to_hours = _relative_to_hours(to)
        from_hours = _relative_to_hours(from_)
        if to_hours is None or from_hours is None:
            return None
        return abs(to_hours - from_hours)


# ── Guard 3: Budget ───────────────────────────────────────────────────────────


class BudgetGuard(Guard):
    """Budget guard — checks per-session, per-user-daily, and global-daily limits.

    Does not write to the spend_ledger (the executor does that after a successful
    tool call).  This guard only reads current spend state from ``ctx.spend``.

    Args:
        session_tokens: Per-session token limit.
        user_daily_tokens: Per-user per-day token limit.
        global_daily_tokens: System-wide per-day token limit.
    """

    name = "budget"

    def __init__(
        self,
        session_tokens: int | None = None,
        user_daily_tokens: int | None = None,
        global_daily_tokens: int | None = None,
    ) -> None:
        from app.config import settings
        self._session_tokens = session_tokens or getattr(
            settings, "BUDGET_SESSION_TOKENS", 100_000
        )
        self._user_daily = user_daily_tokens or getattr(
            settings, "BUDGET_USER_DAILY_TOKENS", 500_000
        )
        self._global_daily = global_daily_tokens or getattr(
            settings, "BUDGET_GLOBAL_DAILY_TOKENS", 10_000_000
        )

    async def evaluate(self, tool: Any, input: BaseModel, ctx: ToolContext) -> GuardVerdict:
        """Check all budget dimensions.

        Args:
            tool: Tool being called.
            input: Tool input (unused).
            ctx: Tool context with spend state.

        Returns:
            Allow or Deny.
        """
        spend = ctx.spend

        if spend.session_tokens >= self._session_tokens:
            return Deny(
                reason=(
                    f"Session budget exhausted: {spend.session_tokens} / "
                    f"{self._session_tokens} tokens used"
                ),
                code="budget_session",
            )

        if spend.user_daily_tokens >= self._user_daily:
            return Deny(
                reason=(
                    f"User daily budget exhausted: {spend.user_daily_tokens} / "
                    f"{self._user_daily} tokens used today"
                ),
                code="budget_user_daily",
            )

        if spend.global_daily_tokens >= self._global_daily:
            return Deny(
                reason="Global daily token budget exhausted. Try again tomorrow.",
                code="budget_global",
            )

        return Allow()


# ── Guard 4: Timeout ─────────────────────────────────────────────────────────


class TimeoutGuard(Guard):
    """Timeout guard — enforces per-tool, per-turn, and per-session wall-clock ceilings.

    The per-tool timeout is enforced by wrapping ``tool.run()`` in
    ``asyncio.wait_for`` inside the executor.  This guard checks the per-turn
    and per-session ceilings before each tool call.

    Args:
        tool_timeout_s: Per-tool timeout in seconds.
        turn_timeout_s: Per-turn timeout in seconds.
        session_timeout_s: Per-session wall-clock timeout in seconds.
    """

    name = "timeout"

    def __init__(
        self,
        tool_timeout_s: int | None = None,
        turn_timeout_s: int | None = None,
        session_timeout_s: int | None = None,
    ) -> None:
        from app.config import settings
        self._tool_s = tool_timeout_s or getattr(settings, "TOOL_TIMEOUT_S", 30)
        self._turn_s = turn_timeout_s or getattr(settings, "TURN_TIMEOUT_S", 120)
        self._session_s = session_timeout_s or getattr(settings, "SESSION_TIMEOUT_S", 1800)
        # Turn start time — set at the beginning of each turn by the executor
        self._turn_started_at: float | None = None
        self._session_started_at: float | None = None

    def start_turn(self) -> None:
        """Record turn start time.  Call at the beginning of each turn."""
        self._turn_started_at = time.monotonic()

    def start_session(self) -> None:
        """Record session start time.  Call once at session creation."""
        self._session_started_at = time.monotonic()

    async def evaluate(self, tool: Any, input: BaseModel, ctx: ToolContext) -> GuardVerdict:
        """Check per-turn and per-session timeout ceilings.

        Also updates ``ctx.tool_timeout_s`` so the executor uses the
        correct per-tool timeout when wrapping ``tool.run()``.

        Args:
            tool: Tool being called.
            input: Tool input (unused).
            ctx: Tool context.

        Returns:
            Allow or Deny.
        """
        now = time.monotonic()
        ctx.tool_timeout_s = self._tool_s

        # Per-turn check
        if self._turn_started_at is not None:
            turn_elapsed = now - self._turn_started_at
            if turn_elapsed >= self._turn_s:
                return Deny(
                    reason=(
                        f"Turn timeout: {turn_elapsed:.0f}s elapsed, "
                        f"limit is {self._turn_s}s"
                    ),
                    code="turn_timeout",
                )

        # Per-session check
        if self._session_started_at is not None:
            session_elapsed = now - self._session_started_at
            if session_elapsed >= self._session_s:
                return Deny(
                    reason=(
                        f"Session timeout: {session_elapsed:.0f}s elapsed, "
                        f"limit is {self._session_s}s"
                    ),
                    code="session_timeout",
                )

        return Allow()


# ── Guard 5: Write ────────────────────────────────────────────────────────────


class WriteGuard(Guard):
    """Write guard — all WRITE-class tools always require approval.

    The approval authority check is:
    - Approval request created in ``approvals`` table by this guard.
    - API endpoint ``POST /sessions/{id}/approve`` verifies
      ``decided_by_user_id == sessions.initiator_user_id`` (server-side only).
    - Non-initiators receive 403 at the API level regardless of this guard.
    """

    name = "write"

    async def evaluate(self, tool: Any, input: BaseModel, ctx: ToolContext) -> GuardVerdict:
        """Return ApprovalRequired for all WRITE-class tools.

        Args:
            tool: Tool being called.
            input: Tool input (serialised into the approval payload).
            ctx: Tool context.

        Returns:
            Allow (non-write tools) or ApprovalRequired.
        """
        if tool.cost_class != CostClass.WRITE:
            return Allow()

        try:
            payload = input.model_dump()
        except Exception:
            payload = {}

        return ApprovalRequired(
            payload={
                "tool_name": tool.name,
                "tool_input": payload,
                "session_id": ctx.session_id,
            },
            reason=f"Tool {tool.name!r} is a write operation and requires approval from the session initiator.",
        )


# ── Guard 6: Loop ─────────────────────────────────────────────────────────────


class LoopGuard(Guard):
    """Loop guard — limits tool calls per turn to prevent runaway loops.

    Tracks the call count via ``ctx.spend.call_count``.  The executor is
    responsible for incrementing ``ctx.spend.call_count`` after each Allow.

    Args:
        max_calls_per_turn: Maximum tool calls in a single turn (default 25).
    """

    name = "loop"

    def __init__(self, max_calls_per_turn: int | None = None) -> None:
        from app.config import settings
        self._max_calls = max_calls_per_turn or getattr(
            settings, "MAX_TOOL_CALLS_PER_TURN", 25
        )

    async def evaluate(self, tool: Any, input: BaseModel, ctx: ToolContext) -> GuardVerdict:
        """Deny if the call count has reached the ceiling.

        Args:
            tool: Tool being called.
            input: Tool input (unused).
            ctx: Tool context with spend.call_count.

        Returns:
            Allow or Deny.
        """
        if ctx.spend.call_count >= self._max_calls:
            return Deny(
                reason=(
                    f"Tool call limit reached: {ctx.spend.call_count} / "
                    f"{self._max_calls} calls in this turn. "
                    "Session paused — resume to continue."
                ),
                code="loop",
            )
        return Allow()


# ── Factory ───────────────────────────────────────────────────────────────────


def make_default_pipeline() -> "GuardPipeline":
    """Construct the default GuardPipeline with all 6 guards in order.

    Returns:
        Configured GuardPipeline instance.
    """
    from harness.guards.pipeline import GuardPipeline
    return GuardPipeline([
        RBACGuard(),
        CostGuard(),
        BudgetGuard(),
        TimeoutGuard(),
        WriteGuard(),
        LoopGuard(),
    ])
