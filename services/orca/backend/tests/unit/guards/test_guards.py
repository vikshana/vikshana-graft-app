"""Unit tests for all 6 guards — allow, deny, transform, and approval paths.

Every guard has negative tests (Rule 7 from the plan).
"""

from __future__ import annotations

import asyncio
from dataclasses import dataclass
from typing import Any
from unittest.mock import MagicMock

import pytest
from pydantic import BaseModel

from harness.guards import (
    Allow, ApprovalRequired, BudgetGuard, CostGuard, Deny,
    LoopGuard, RBACGuard, TimeoutGuard, Transform, WriteGuard,
    GuardPipeline, make_default_pipeline,
)
from harness.tools.protocol import BudgetConfig, CostClass, SpendState, ToolContext


# ── Fixtures ──────────────────────────────────────────────────────────────────


class EmptyInput(BaseModel):
    pass


class QueryInput(BaseModel):
    datasource_uid: str = "ds-1"
    expr: str = "rate(errors[5m])"
    from_: str = "now-1h"
    to: str = "now"

    model_config = {"populate_by_name": True}


@dataclass
class MockTool:
    name: str = "query_metrics"
    cost_class: CostClass = CostClass.QUERY


@dataclass
class MockWriteTool:
    name: str = "create_silence"
    cost_class: CostClass = CostClass.WRITE


@dataclass
class MockCheapTool:
    name: str = "list_datasources"
    cost_class: CostClass = CostClass.CHEAP


def _make_ctx(
    role: str | None = "Editor",
    auth_mode: Any = None,
    session_tokens: int = 0,
    user_daily_tokens: int = 0,
    global_daily_tokens: int = 0,
    call_count: int = 0,
    session_id: str = "test-session",
) -> ToolContext:
    from harness.auth.types import AuthMode, GrafanaCredential

    if auth_mode is None:
        auth_mode = AuthMode.USER_OBO

    credential = GrafanaCredential(
        token="glsa_test",
        auth_mode=auth_mode,
        user_id="user-1",
        org_id=1,
    )
    # Attach role to credential for RBAC guard inspection
    object.__setattr__(credential, "_role", role)

    # Monkey-patch a `role` attribute (frozen dataclass workaround)
    class CredWithRole:
        def __init__(self, cred, role):
            self.__dict__.update(cred.__dict__)
            self.role = role

    cred_with_role = CredWithRole(credential, role)

    return ToolContext(
        session_id=session_id,
        credential=cred_with_role,
        budget=BudgetConfig(
            session_tokens=100_000,
            user_daily_tokens=500_000,
            global_daily_tokens=10_000_000,
        ),
        spend=SpendState(
            session_tokens=session_tokens,
            user_daily_tokens=user_daily_tokens,
            global_daily_tokens=global_daily_tokens,
            call_count=call_count,
        ),
        otel_span=MagicMock(),
    )


# ============================================================================
# RBACGuard
# ============================================================================


class TestRBACGuard:
    """Tests for the RBAC guard."""

    @pytest.mark.asyncio
    async def test_allowed_role_permits(self):
        """Editor role in allowed list → Allow."""
        guard = RBACGuard(allowed_roles={"Admin", "Editor"})
        ctx = _make_ctx(role="Editor")
        result = await guard.evaluate(MockTool(), EmptyInput(), ctx)
        assert isinstance(result, Allow)

    @pytest.mark.asyncio
    async def test_denied_role_denies(self):
        """Viewer role not in allowed list → Deny."""
        guard = RBACGuard(allowed_roles={"Admin", "Editor"})
        ctx = _make_ctx(role="Viewer")
        result = await guard.evaluate(MockTool(), EmptyInput(), ctx)
        assert isinstance(result, Deny)
        assert result.code == "rbac"

    @pytest.mark.asyncio
    async def test_no_role_denies(self):
        """No role on credential → Deny (safe default)."""
        guard = RBACGuard(allowed_roles={"Admin", "Editor"})
        ctx = _make_ctx(role=None)
        result = await guard.evaluate(MockTool(), EmptyInput(), ctx)
        assert isinstance(result, Deny)
        assert result.code == "rbac"

    @pytest.mark.asyncio
    async def test_service_account_bypasses_rbac(self):
        """Service account auth mode always passes RBAC (not user-attributed)."""
        from harness.auth.types import AuthMode
        guard = RBACGuard(allowed_roles={"Admin"})
        ctx = _make_ctx(role=None, auth_mode=AuthMode.SERVICE_ACCOUNT)
        result = await guard.evaluate(MockTool(), EmptyInput(), ctx)
        assert isinstance(result, Allow)

    @pytest.mark.asyncio
    async def test_admin_role_permits(self):
        """Admin role in allowed list → Allow."""
        guard = RBACGuard(allowed_roles={"Admin", "Editor"})
        ctx = _make_ctx(role="Admin")
        result = await guard.evaluate(MockTool(), EmptyInput(), ctx)
        assert isinstance(result, Allow)


# ============================================================================
# CostGuard
# ============================================================================


class TestCostGuard:
    """Tests for the cost guard."""

    @pytest.mark.asyncio
    async def test_normal_query_allowed(self):
        """Valid PromQL, 1h range → Allow."""
        guard = CostGuard(max_range_hours=24)
        ctx = _make_ctx()
        result = await guard.evaluate(
            MockTool(),
            QueryInput(expr="rate(errors[5m])", from_="now-1h", to="now"),
            ctx,
        )
        assert isinstance(result, Allow)

    @pytest.mark.asyncio
    async def test_oversized_range_transforms(self):
        """25h range with 24h cap → Transform with clamped range."""
        guard = CostGuard(max_range_hours=24)
        ctx = _make_ctx()
        result = await guard.evaluate(
            MockTool(),
            QueryInput(from_="now-25h", to="now"),
            ctx,
        )
        assert isinstance(result, Transform)
        assert "clamped" in result.annotation.lower()
        assert result.new_input.from_ == "now-24h"

    @pytest.mark.asyncio
    async def test_unbounded_matcher_denies(self):
        """Unbounded .+ matcher → Deny."""
        guard = CostGuard(max_range_hours=24)
        ctx = _make_ctx()
        result = await guard.evaluate(
            MockTool(),
            QueryInput(expr='{job=~".+"}'),
            ctx,
        )
        assert isinstance(result, Deny)
        assert result.code == "cost"

    @pytest.mark.asyncio
    async def test_write_tool_skipped(self):
        """Write tools bypass the cost guard entirely."""
        guard = CostGuard(max_range_hours=1)
        ctx = _make_ctx()
        # Write tool with a huge range
        result = await guard.evaluate(MockWriteTool(), EmptyInput(), ctx)
        assert isinstance(result, Allow)

    @pytest.mark.asyncio
    async def test_cheap_tool_skipped(self):
        """Cheap tools bypass the cost guard entirely."""
        guard = CostGuard(max_range_hours=1)
        ctx = _make_ctx()
        result = await guard.evaluate(MockCheapTool(), EmptyInput(), ctx)
        assert isinstance(result, Allow)

    @pytest.mark.asyncio
    async def test_7d_range_transforms(self):
        """7-day range with 24h cap → Transform."""
        guard = CostGuard(max_range_hours=24)
        ctx = _make_ctx()
        result = await guard.evaluate(
            MockTool(),
            QueryInput(from_="now-7d", to="now"),
            ctx,
        )
        assert isinstance(result, Transform)


# ============================================================================
# BudgetGuard
# ============================================================================


class TestBudgetGuard:
    """Tests for the budget guard."""

    @pytest.mark.asyncio
    async def test_under_all_limits_allowed(self):
        """All dimensions under limit → Allow."""
        guard = BudgetGuard(session_tokens=1000, user_daily_tokens=5000, global_daily_tokens=100_000)
        ctx = _make_ctx(session_tokens=500, user_daily_tokens=1000, global_daily_tokens=50_000)
        result = await guard.evaluate(MockTool(), EmptyInput(), ctx)
        assert isinstance(result, Allow)

    @pytest.mark.asyncio
    async def test_session_budget_exhausted(self):
        """Session tokens at limit → Deny with budget_session code."""
        guard = BudgetGuard(session_tokens=1000, user_daily_tokens=5000, global_daily_tokens=100_000)
        ctx = _make_ctx(session_tokens=1000)
        result = await guard.evaluate(MockTool(), EmptyInput(), ctx)
        assert isinstance(result, Deny)
        assert result.code == "budget_session"

    @pytest.mark.asyncio
    async def test_user_daily_exhausted(self):
        """User daily tokens at limit → Deny with budget_user_daily code."""
        guard = BudgetGuard(session_tokens=100_000, user_daily_tokens=500, global_daily_tokens=100_000)
        ctx = _make_ctx(user_daily_tokens=500)
        result = await guard.evaluate(MockTool(), EmptyInput(), ctx)
        assert isinstance(result, Deny)
        assert result.code == "budget_user_daily"

    @pytest.mark.asyncio
    async def test_global_budget_exhausted(self):
        """Global tokens at limit → Deny with budget_global code."""
        guard = BudgetGuard(session_tokens=100_000, user_daily_tokens=500_000, global_daily_tokens=100)
        ctx = _make_ctx(global_daily_tokens=100)
        result = await guard.evaluate(MockTool(), EmptyInput(), ctx)
        assert isinstance(result, Deny)
        assert result.code == "budget_global"

    @pytest.mark.asyncio
    async def test_session_at_limit_boundary(self):
        """Session tokens exactly at limit → Deny (not under)."""
        guard = BudgetGuard(session_tokens=100, user_daily_tokens=999_999, global_daily_tokens=999_999)
        ctx = _make_ctx(session_tokens=100)
        result = await guard.evaluate(MockTool(), EmptyInput(), ctx)
        assert isinstance(result, Deny)

    @pytest.mark.asyncio
    async def test_one_below_limit_allowed(self):
        """Session tokens one below limit → Allow."""
        guard = BudgetGuard(session_tokens=100, user_daily_tokens=999_999, global_daily_tokens=999_999)
        ctx = _make_ctx(session_tokens=99)
        result = await guard.evaluate(MockTool(), EmptyInput(), ctx)
        assert isinstance(result, Allow)


# ============================================================================
# TimeoutGuard
# ============================================================================


class TestTimeoutGuard:
    """Tests for the timeout guard."""

    @pytest.mark.asyncio
    async def test_fresh_turn_allowed(self):
        """Turn just started → Allow."""
        guard = TimeoutGuard(tool_timeout_s=30, turn_timeout_s=120, session_timeout_s=1800)
        guard.start_turn()
        ctx = _make_ctx()
        result = await guard.evaluate(MockTool(), EmptyInput(), ctx)
        assert isinstance(result, Allow)

    @pytest.mark.asyncio
    async def test_expired_turn_denies(self):
        """Turn started 200s ago with 120s limit → Deny."""
        import time as _time
        guard = TimeoutGuard(tool_timeout_s=30, turn_timeout_s=120, session_timeout_s=1800)
        guard._turn_started_at = _time.monotonic() - 200
        ctx = _make_ctx()
        result = await guard.evaluate(MockTool(), EmptyInput(), ctx)
        assert isinstance(result, Deny)
        assert result.code == "turn_timeout"

    @pytest.mark.asyncio
    async def test_expired_session_denies(self):
        """Session started 2000s ago with 1800s limit → Deny."""
        import time as _time
        guard = TimeoutGuard(tool_timeout_s=30, turn_timeout_s=9999, session_timeout_s=1800)
        guard.start_turn()
        # Session dimension uses the wall clock (time.time()), not
        # time.monotonic() — see TimeoutGuard.start_session docstring: a
        # session can span turns executed by a different process, so its
        # origin must be a value comparable across process boundaries.
        guard._session_started_at = _time.time() - 2000
        ctx = _make_ctx()
        result = await guard.evaluate(MockTool(), EmptyInput(), ctx)
        assert isinstance(result, Deny)
        assert result.code == "session_timeout"

    @pytest.mark.asyncio
    async def test_start_turn_accepts_explicit_started_at(self):
        """start_turn(started_at=...) seeds the monotonic clock explicitly
        (used by GuardPipeline.start_turn to forward a caller-supplied
        value) rather than always capturing "now"."""
        import time as _time
        guard = TimeoutGuard(tool_timeout_s=30, turn_timeout_s=120, session_timeout_s=1800)
        guard.start_turn(started_at=_time.monotonic() - 200)
        ctx = _make_ctx()
        result = await guard.evaluate(MockTool(), EmptyInput(), ctx)
        assert isinstance(result, Deny)
        assert result.code == "turn_timeout"

    @pytest.mark.asyncio
    async def test_start_session_accepts_explicit_started_at(self):
        """start_session(started_at=...) seeds the wall clock explicitly —
        this is how a persisted investigation start survives across
        interrupt/resume rounds (see app.agent.rca_graph)."""
        import time as _time
        guard = TimeoutGuard(tool_timeout_s=30, turn_timeout_s=9999, session_timeout_s=1800)
        guard.start_session(started_at=_time.time() - 2000)
        ctx = _make_ctx()
        result = await guard.evaluate(MockTool(), EmptyInput(), ctx)
        assert isinstance(result, Deny)
        assert result.code == "session_timeout"

    @pytest.mark.asyncio
    async def test_no_timers_set_allowed(self):
        """No timers started → Allow (e.g. first call before start_turn)."""
        guard = TimeoutGuard(tool_timeout_s=30, turn_timeout_s=120, session_timeout_s=1800)
        ctx = _make_ctx()
        result = await guard.evaluate(MockTool(), EmptyInput(), ctx)
        assert isinstance(result, Allow)

    @pytest.mark.asyncio
    async def test_tool_timeout_propagated_to_ctx(self):
        """guard.evaluate sets ctx.tool_timeout_s."""
        guard = TimeoutGuard(tool_timeout_s=45, turn_timeout_s=120, session_timeout_s=1800)
        guard.start_turn()
        ctx = _make_ctx()
        ctx.tool_timeout_s = 0  # should be overwritten
        await guard.evaluate(MockTool(), EmptyInput(), ctx)
        assert ctx.tool_timeout_s == 45


# ============================================================================
# WriteGuard
# ============================================================================


class TestWriteGuard:
    """Tests for the write guard."""

    @pytest.mark.asyncio
    async def test_query_tool_passes(self):
        """Non-write tool → Allow."""
        guard = WriteGuard()
        ctx = _make_ctx()
        result = await guard.evaluate(MockTool(), EmptyInput(), ctx)
        assert isinstance(result, Allow)

    @pytest.mark.asyncio
    async def test_write_tool_requires_approval(self):
        """Write tool → ApprovalRequired with full payload."""
        guard = WriteGuard()
        ctx = _make_ctx()
        input_model = EmptyInput()
        result = await guard.evaluate(MockWriteTool(), input_model, ctx)
        assert isinstance(result, ApprovalRequired)
        assert result.payload["tool_name"] == "create_silence"
        assert result.payload["session_id"] == "test-session"

    @pytest.mark.asyncio
    async def test_create_annotation_requires_approval(self):
        """create_annotation is also a write tool → ApprovalRequired."""
        guard = WriteGuard()
        ctx = _make_ctx()

        @dataclass
        class MockAnnotationTool:
            name: str = "create_annotation"
            cost_class: CostClass = CostClass.WRITE

        result = await guard.evaluate(MockAnnotationTool(), EmptyInput(), ctx)
        assert isinstance(result, ApprovalRequired)

    @pytest.mark.asyncio
    async def test_cheap_tool_passes(self):
        """Cheap tool → Allow."""
        guard = WriteGuard()
        ctx = _make_ctx()
        result = await guard.evaluate(MockCheapTool(), EmptyInput(), ctx)
        assert isinstance(result, Allow)


# ============================================================================
# LoopGuard
# ============================================================================


class TestLoopGuard:
    """Tests for the loop guard."""

    @pytest.mark.asyncio
    async def test_under_limit_allowed(self):
        """Call count under limit → Allow."""
        guard = LoopGuard(max_calls_per_turn=25)
        ctx = _make_ctx(call_count=10)
        result = await guard.evaluate(MockTool(), EmptyInput(), ctx)
        assert isinstance(result, Allow)

    @pytest.mark.asyncio
    async def test_at_limit_denies(self):
        """Call count at limit → Deny."""
        guard = LoopGuard(max_calls_per_turn=25)
        ctx = _make_ctx(call_count=25)
        result = await guard.evaluate(MockTool(), EmptyInput(), ctx)
        assert isinstance(result, Deny)
        assert result.code == "loop"

    @pytest.mark.asyncio
    async def test_26th_call_denies(self):
        """26th call → Deny."""
        guard = LoopGuard(max_calls_per_turn=25)
        ctx = _make_ctx(call_count=26)
        result = await guard.evaluate(MockTool(), EmptyInput(), ctx)
        assert isinstance(result, Deny)

    @pytest.mark.asyncio
    async def test_24th_call_allowed(self):
        """24th call (one below limit) → Allow."""
        guard = LoopGuard(max_calls_per_turn=25)
        ctx = _make_ctx(call_count=24)
        result = await guard.evaluate(MockTool(), EmptyInput(), ctx)
        assert isinstance(result, Allow)

    @pytest.mark.asyncio
    async def test_zero_calls_allowed(self):
        """Zero calls → Allow."""
        guard = LoopGuard(max_calls_per_turn=25)
        ctx = _make_ctx(call_count=0)
        result = await guard.evaluate(MockTool(), EmptyInput(), ctx)
        assert isinstance(result, Allow)


# ============================================================================
# GuardPipeline
# ============================================================================


class TestGuardPipeline:
    """Tests for the full pipeline orchestration."""

    @pytest.mark.asyncio
    async def test_all_allow_returns_allow(self):
        """Pipeline with all-Allow guards returns Allow."""
        guard1 = RBACGuard(allowed_roles={"Editor"})
        guard2 = BudgetGuard(session_tokens=999_999, user_daily_tokens=999_999, global_daily_tokens=999_999)
        pipeline = GuardPipeline([guard1, guard2])
        ctx = _make_ctx(role="Editor")
        verdict, effective_input, decisions = await pipeline.run(MockTool(), EmptyInput(), ctx)
        assert isinstance(verdict, Allow)
        assert len(decisions) == 2
        assert effective_input is not None

    @pytest.mark.asyncio
    async def test_first_deny_short_circuits(self):
        """First Deny stops subsequent guards from running."""
        deny_guard = RBACGuard(allowed_roles={"Admin"})  # Viewer will be denied
        never_called_guard = BudgetGuard(session_tokens=0)  # would also deny
        pipeline = GuardPipeline([deny_guard, never_called_guard])
        ctx = _make_ctx(role="Viewer")
        verdict, effective_input, decisions = await pipeline.run(MockTool(), EmptyInput(), ctx)
        assert isinstance(verdict, Deny)
        assert len(decisions) == 1  # only first guard ran
        assert isinstance(effective_input, EmptyInput)  # no transform applied before short-circuit

    @pytest.mark.asyncio
    async def test_transform_continues_pipeline(self):
        """Transform does not stop the pipeline — subsequent guards see the new input."""
        cost_guard = CostGuard(max_range_hours=24)
        loop_guard = LoopGuard(max_calls_per_turn=25)
        pipeline = GuardPipeline([cost_guard, loop_guard])
        ctx = _make_ctx(call_count=5)
        # 25h range will be transformed, then loop guard should still run
        verdict, effective_input, decisions = await pipeline.run(
            MockTool(),
            QueryInput(from_="now-25h", to="now"),
            ctx,
        )
        # Cost guard transforms, loop guard allows → final Allow
        assert isinstance(verdict, Allow)
        assert len(decisions) == 2
        # effective_input must reflect the CostGuard's clamped transform,
        # not the original (unclamped) input
        assert effective_input.from_ == "now-24h"

    @pytest.mark.asyncio
    async def test_write_guard_stops_pipeline(self):
        """Write guard ApprovalRequired stops subsequent guards."""
        write_guard = WriteGuard()
        loop_guard = LoopGuard(max_calls_per_turn=0)  # would also deny
        pipeline = GuardPipeline([write_guard, loop_guard])
        ctx = _make_ctx()
        verdict, effective_input, decisions = await pipeline.run(MockWriteTool(), EmptyInput(), ctx)
        assert isinstance(verdict, ApprovalRequired)
        assert len(decisions) == 1
        assert isinstance(effective_input, EmptyInput)  # no transform applied before short-circuit

    @pytest.mark.asyncio
    async def test_guard_exception_produces_deny(self):
        """An exception in a guard is caught and returns Deny."""
        from harness.guards.types import Guard as GuardBase

        class BrokenGuard(GuardBase):
            name = "broken"
            async def evaluate(self, tool, input, ctx):
                raise RuntimeError("I broke!")

        pipeline = GuardPipeline([BrokenGuard()])
        ctx = _make_ctx()
        verdict, effective_input, decisions = await pipeline.run(MockTool(), EmptyInput(), ctx)
        assert isinstance(verdict, Deny)
        assert "Guard error" in verdict.reason
        assert isinstance(effective_input, EmptyInput)  # no transform applied before short-circuit

    def test_make_default_pipeline_has_7_guards(self):
        """make_default_pipeline returns a pipeline with all 7 guards (PII added in Phase 4)."""
        pipeline = make_default_pipeline()
        assert len(pipeline._guards) == 7
        names = {g.name for g in pipeline._guards}
        assert names == {"rbac", "pii_redaction", "cost", "budget", "timeout", "write", "loop"}
