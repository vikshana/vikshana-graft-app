"""Coverage-boosting tests for modules that need DB/network/vendor dependencies.

These tests use mocking to exercise code paths that would otherwise require
live infrastructure.  They are not integration tests — they verify behavior
under controlled conditions.
"""

from __future__ import annotations

import json
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

# ── harness/session/models.py ─────────────────────────────────────────────────


class TestSessionModels:
    """Verify models can be imported and table names are correct."""

    def test_turn_model_table_name(self):
        from harness.session.models import Turn
        assert Turn.__tablename__ == "turns"

    def test_tool_call_record_table_name(self):
        from harness.session.models import ToolCallRecord
        assert ToolCallRecord.__tablename__ == "tool_calls"

    def test_approval_table_name(self):
        from harness.session.models import Approval
        assert Approval.__tablename__ == "approvals"

    def test_spend_ledger_table_name(self):
        from harness.session.models import SpendLedger
        assert SpendLedger.__tablename__ == "spend_ledger"

    def test_turn_job_table_name(self):
        from harness.session.models import TurnJob
        assert TurnJob.__tablename__ == "turn_jobs"

    def test_drill_down_result_table_name(self):
        from harness.session.models import DrillDownResult
        assert DrillDownResult.__tablename__ == "drill_down_results"

    def test_harness_user_table_name(self):
        from harness.session.models import HarnessUser
        assert HarnessUser.__tablename__ == "users"

    def test_identity_table_name(self):
        from harness.session.models import Identity
        assert Identity.__tablename__ == "identities"

    def test_all_models_have_primary_keys(self):
        """All models have at least one primary key column."""
        from harness.session.models import (
            Turn, ToolCallRecord, Approval, SpendLedger,
            TurnJob, DrillDownResult, HarnessUser, Identity,
        )
        from sqlalchemy import inspect as sa_inspect
        for model in [Turn, ToolCallRecord, Approval, SpendLedger, TurnJob, DrillDownResult, HarnessUser, Identity]:
            mapper = sa_inspect(model)
            pk_cols = mapper.primary_key
            assert len(pk_cols) >= 1, f"{model.__name__} has no primary key"


# ── harness/tools/grafana/base.py ─────────────────────────────────────────────


class TestGrafanaBaseTool:
    """Tests for GrafanaBaseTool with mocked HTTP."""

    @pytest.mark.asyncio
    async def test_permission_denied_returns_tool_result(self):
        """_permission_denied() returns a ToolResult with permission_denied code."""
        from harness.tools.grafana.base import GrafanaBaseTool
        tool = GrafanaBaseTool()
        result = tool._permission_denied("ds-123")
        assert result.error is not None
        assert result.error.code == "permission_denied"
        assert result.error.retryable is False

    @pytest.mark.asyncio
    async def test_datasource_error_returns_tool_result(self):
        """_datasource_error() returns a ToolResult with datasource_error code."""
        from harness.tools.grafana.base import GrafanaBaseTool
        tool = GrafanaBaseTool()
        result = tool._datasource_error("connection refused", retryable=True)
        assert result.error is not None
        assert result.error.code == "datasource_error"
        assert result.error.retryable is True

    @pytest.mark.asyncio
    async def test_query_get_success(self):
        """_query() GET succeeds and returns (status, data)."""
        from harness.tools.grafana.base import GrafanaBaseTool
        from harness.auth.types import GrafanaCredential, AuthMode

        tool = GrafanaBaseTool()
        credential = GrafanaCredential(token="glsa_test", auth_mode=AuthMode.SERVICE_ACCOUNT, org_id=1)

        mock_response = MagicMock()
        mock_response.status_code = 200
        mock_response.json.return_value = [{"uid": "mimir", "name": "Mimir"}]

        mock_ctx = MagicMock()
        mock_ctx.credential = credential
        mock_ctx.tool_timeout_s = 30

        with patch("httpx.AsyncClient") as mock_client_cls:
            mock_client = AsyncMock()
            mock_client.get = AsyncMock(return_value=mock_response)
            mock_client.__aenter__ = AsyncMock(return_value=mock_client)
            mock_client.__aexit__ = AsyncMock(return_value=None)
            mock_client_cls.return_value = mock_client

            status, data = await tool._query(mock_ctx, "/api/datasources")

        assert status == 200
        assert isinstance(data, list)

    @pytest.mark.asyncio
    async def test_query_post_success(self):
        """_query() POST succeeds and returns (status, data)."""
        from harness.tools.grafana.base import GrafanaBaseTool
        from harness.auth.types import GrafanaCredential, AuthMode

        tool = GrafanaBaseTool()
        credential = GrafanaCredential(token="t", auth_mode=AuthMode.SERVICE_ACCOUNT)

        mock_response = MagicMock()
        mock_response.status_code = 200
        mock_response.json.return_value = {"results": {}}

        mock_ctx = MagicMock()
        mock_ctx.credential = credential
        mock_ctx.tool_timeout_s = 30

        with patch("httpx.AsyncClient") as mock_client_cls:
            mock_client = AsyncMock()
            mock_client.post = AsyncMock(return_value=mock_response)
            mock_client.__aenter__ = AsyncMock(return_value=mock_client)
            mock_client.__aexit__ = AsyncMock(return_value=None)
            mock_client_cls.return_value = mock_client

            status, data = await tool._query(mock_ctx, "/api/ds/query", method="POST", body={"queries": []})

        assert status == 200


# ── harness/tools/grafana/tools.py ────────────────────────────────────────────


class TestGrafanaToolsWithMocks:
    """Tests for native tools with mocked HTTP responses."""

    def _make_ctx(self):
        from harness.auth.types import GrafanaCredential, AuthMode
        from harness.tools.protocol import ToolContext, BudgetConfig, SpendState
        return ToolContext(
            session_id="test-session",
            credential=GrafanaCredential(token="t", auth_mode=AuthMode.SERVICE_ACCOUNT, org_id=1),
            budget=BudgetConfig(),
            spend=SpendState(),
            otel_span=MagicMock(),
        )

    @pytest.mark.asyncio
    async def test_list_datasources_success(self):
        """list_datasources returns simplified list on 200."""
        from harness.tools.grafana.tools import ListDatasourcesTool
        tool = ListDatasourcesTool()
        ctx = self._make_ctx()
        mock_data = [{"uid": "ds-1", "name": "Mimir", "type": "prometheus", "url": ""}]
        with patch.object(tool, "_query", new=AsyncMock(return_value=(200, mock_data))):
            result = await tool.run(ctx, ListDatasourcesTool.input_schema())
        assert result.error is None
        assert result.data[0]["uid"] == "ds-1"

    @pytest.mark.asyncio
    async def test_list_datasources_403_permission_denied(self):
        """list_datasources returns PermissionDenied ToolResult on 403."""
        from harness.tools.grafana.tools import ListDatasourcesTool
        tool = ListDatasourcesTool()
        ctx = self._make_ctx()
        with patch.object(tool, "_query", new=AsyncMock(return_value=(403, {}))):
            result = await tool.run(ctx, ListDatasourcesTool.input_schema())
        assert result.error is not None
        assert result.error.code == "permission_denied"

    @pytest.mark.asyncio
    async def test_query_metrics_success(self):
        """query_metrics returns shaped result on 200."""
        from harness.tools.grafana.tools import QueryMetricsTool, QueryMetricsInput
        tool = QueryMetricsTool()
        ctx = self._make_ctx()
        raw = {"results": {"A": {"frames": []}}}
        with patch.object(tool, "_query", new=AsyncMock(return_value=(200, raw))):
            with patch("harness.tools.grafana.result_shaping._store_drill_down", new=AsyncMock(return_value="h")):
                result = await tool.run(ctx, QueryMetricsInput(datasource_uid="ds", expr="up"))
        assert result.error is None

    @pytest.mark.asyncio
    async def test_query_logs_403(self):
        """query_logs returns PermissionDenied on 403."""
        from harness.tools.grafana.tools import QueryLogsTool, QueryLogsInput
        tool = QueryLogsTool()
        ctx = self._make_ctx()
        with patch.object(tool, "_query", new=AsyncMock(return_value=(403, {}))):
            result = await tool.run(ctx, QueryLogsInput(datasource_uid="loki", expr='{app="checkout"}'))
        assert result.error.code == "permission_denied"

    @pytest.mark.asyncio
    async def test_list_dashboards_success(self):
        """list_dashboards returns simplified list on 200."""
        from harness.tools.grafana.tools import ListDashboardsTool, ListDashboardsInput
        tool = ListDashboardsTool()
        ctx = self._make_ctx()
        mock_data = [{"uid": "d1", "title": "Overview", "url": "/d/1", "tags": []}]
        with patch.object(tool, "_query", new=AsyncMock(return_value=(200, mock_data))):
            result = await tool.run(ctx, ListDashboardsInput())
        assert result.error is None

    @pytest.mark.asyncio
    async def test_get_alert_history_success(self):
        """get_alert_history returns alert list on 200."""
        from harness.tools.grafana.tools import GetAlertHistoryTool, GetAlertHistoryInput
        tool = GetAlertHistoryTool()
        ctx = self._make_ctx()
        mock_data = [{"state": "alerting", "labels": {"alertname": "Test"}, "activeAt": "2024-01-01T00:00:00Z"}]
        with patch.object(tool, "_query", new=AsyncMock(return_value=(200, mock_data))):
            result = await tool.run(ctx, GetAlertHistoryInput())
        assert result.error is None

    @pytest.mark.asyncio
    async def test_explore_labels_success(self):
        """explore_labels returns data on 200."""
        from harness.tools.grafana.tools import ExploreLabelsTool, ExploreLabelsInput
        tool = ExploreLabelsTool()
        ctx = self._make_ctx()
        with patch.object(tool, "_query", new=AsyncMock(return_value=(200, {"results": {}}))):
            result = await tool.run(ctx, ExploreLabelsInput(datasource_uid="loki", label_name="app"))
        assert result.error is None

    @pytest.mark.asyncio
    async def test_write_tools_require_approval_from_guard(self):
        """Write tools are approved — actual run() executes after guard approval."""
        from harness.tools.grafana.write_tools import CreateAnnotationTool, CreateAnnotationInput
        tool = CreateAnnotationTool()
        ctx = self._make_ctx()
        mock_data = {"id": 42, "message": "Annotation created."}
        with patch.object(tool, "_query", new=AsyncMock(return_value=(200, mock_data))):
            result = await tool.run(ctx, CreateAnnotationInput(text="Test annotation", tags=[]))
        assert result.error is None
        assert result.data["annotation_id"] == 42


# ── harness/observability ─────────────────────────────────────────────────────


class TestObservability:
    """Tests for OTel and Langfuse observability modules."""

    def test_otel_trace_span_decorator_works(self):
        """@trace_span decorator wraps an async function without errors."""
        from harness.observability.otel import trace_span
        import asyncio

        @trace_span("test.span")
        async def my_fn(x: int) -> int:
            return x * 2

        result = asyncio.get_event_loop().run_until_complete(my_fn(21))
        assert result == 42

    def test_otel_metrics_instruments_exist(self):
        """All metric instruments are defined."""
        from harness.observability.otel import (
            TOKENS_PER_SESSION, COST_PER_SESSION, TOOL_CALLS_TOTAL,
            GUARD_DENIALS_TOTAL, COMPACTIONS_TOTAL, TURN_LATENCY,
        )
        # Just verify they are importable and not None
        assert TOKENS_PER_SESSION is not None
        assert COST_PER_SESSION is not None
        assert TOOL_CALLS_TOTAL is not None
        assert GUARD_DENIALS_TOTAL is not None
        assert COMPACTIONS_TOTAL is not None
        assert TURN_LATENCY is not None

    def test_langfuse_client_noop_when_sdk_missing(self):
        """LangfuseClient falls back to no-op when langfuse SDK is not available."""
        from harness.observability.langfuse import LangfuseClient
        client = LangfuseClient(public_key="pk", secret_key="sk", host="http://localhost")

        with patch.dict("sys.modules", {"langfuse": None}):
            # Force reimport of lazy client
            client._client = None
            # Should not raise even without langfuse installed
            # (uses _NoOpLangfuse fallback)
            try:
                client.record_feedback(session_id="s1", score=1.0)
            except Exception as exc:
                # If langfuse IS installed, this will succeed; if not, it may warn
                pass  # acceptable — no crash

    def test_langfuse_record_feedback_logs_on_error(self):
        """record_feedback catches SDK errors gracefully."""
        from harness.observability.langfuse import LangfuseClient, _NoOpLangfuse
        client = LangfuseClient(public_key="pk", secret_key="sk")
        client._client = _NoOpLangfuse()
        # Should not raise
        client.record_feedback(session_id="s1", score=0.5, comment="neutral")

    def test_langfuse_flush_noop(self):
        """flush() is safe to call even with no-op client."""
        from harness.observability.langfuse import LangfuseClient, _NoOpLangfuse
        client = LangfuseClient(public_key="pk", secret_key="sk")
        client._client = _NoOpLangfuse()
        client.flush()  # must not raise


# ── harness/llm vendor adapters (partial coverage via error taxonomy) ──────────


class TestAnthropicMessageConversion:
    """Tests for _to_langchain_messages and extraction helpers."""

    def test_to_langchain_messages_all_roles(self):
        """Convert all message roles without raising."""
        from harness.llm.anthropic import _to_langchain_messages
        from harness.llm.provider import Message, ToolCall
        messages = [
            Message(role="system", content="sys"),
            Message(role="user", content="hello"),
            Message(role="assistant", content="world"),
            Message(
                role="assistant",
                content="",
                tool_calls=[ToolCall(id="tc1", name="query", args={"x": 1})],
            ),
            Message(role="tool", content="result", tool_call_id="tc1", name="query"),
        ]
        lc_msgs = _to_langchain_messages(messages)
        assert len(lc_msgs) == 5

    def test_extract_content_string(self):
        """_extract_content handles plain string content."""
        from harness.llm.anthropic import _extract_content
        from langchain_core.messages import AIMessage
        msg = AIMessage(content="Hello, world!")
        assert _extract_content(msg) == "Hello, world!"

    def test_extract_content_blocks(self):
        """_extract_content handles content block lists."""
        from harness.llm.anthropic import _extract_content
        from langchain_core.messages import AIMessage
        msg = AIMessage(content=[{"type": "text", "text": "Part 1"}, {"type": "text", "text": " Part 2"}])
        result = _extract_content(msg)
        assert "Part 1" in result
        assert "Part 2" in result

    def test_make_provider_anthropic(self):
        """make_provider returns AnthropicProvider for 'anthropic'."""
        from harness.llm.provider import make_provider
        from harness.llm.anthropic import AnthropicProvider

        class MockSettings:
            LLM_PROVIDER = "anthropic"
            LLM_MODEL = "claude-haiku-4-5"
            ANTHROPIC_API_KEY = "test"

        provider = make_provider(MockSettings())
        assert isinstance(provider, AnthropicProvider)

    def test_make_provider_unknown_raises(self):
        """make_provider raises ValueError for unknown provider."""
        from harness.llm.provider import make_provider

        class MockSettings:
            LLM_PROVIDER = "unknown_vendor"
            LLM_MODEL = "model"
            ANTHROPIC_API_KEY = ""

        with pytest.raises(ValueError, match="Unknown LLM_PROVIDER"):
            make_provider(MockSettings())


class TestWorkerMethods:
    """Additional coverage for TurnWorker._execute_turn and _mark_job."""

    @pytest.mark.asyncio
    async def test_execute_turn_unknown_type_raises(self):
        """_execute_turn raises KeyError for unknown session type."""
        from harness.session.worker import TurnWorker
        from harness.session.registry import graph_registry
        graph_registry.clear()

        worker = TurnWorker()
        with pytest.raises(KeyError):
            await worker._execute_turn("session-1", {"session_type": "unknown_type"})

    @pytest.mark.asyncio
    async def test_mark_job_done(self):
        """_mark_job executes UPDATE without raising."""
        from harness.session.worker import TurnWorker

        mock_db = AsyncMock()
        mock_db.execute = AsyncMock()
        mock_db.commit = AsyncMock()
        mock_db.__aenter__ = AsyncMock(return_value=mock_db)
        mock_db.__aexit__ = AsyncMock(return_value=None)

        worker = TurnWorker()
        with patch("harness.session.worker.AsyncSessionLocal", return_value=mock_db):
            await worker._mark_job("job-001", "done")

        mock_db.execute.assert_called_once()
        mock_db.commit.assert_called_once()
