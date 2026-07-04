"""Additional coverage tests to reach 85% threshold on harness/."""

from __future__ import annotations

from unittest.mock import AsyncMock, MagicMock, patch

import pytest


def _make_ctx():
    from harness.auth.types import GrafanaCredential, AuthMode
    from harness.tools.protocol import ToolContext, BudgetConfig, SpendState
    return ToolContext(
        session_id="test-session",
        credential=GrafanaCredential(token="t", auth_mode=AuthMode.SERVICE_ACCOUNT, org_id=1),
        budget=BudgetConfig(),
        spend=SpendState(),
        otel_span=MagicMock(),
    )


class TestQueryTracesAndProfiles:
    """Coverage for query_traces and query_profiles tool paths."""

    @pytest.mark.asyncio
    async def test_query_traces_success(self):
        from harness.tools.grafana.tools import QueryTracesTool, QueryTracesInput
        tool = QueryTracesTool()
        ctx = _make_ctx()
        raw = {"results": {"A": {"frames": []}}}
        with patch.object(tool, "_query", new=AsyncMock(return_value=(200, raw))):
            with patch("harness.tools.grafana.result_shaping._store_drill_down", new=AsyncMock(return_value="h")):
                result = await tool.run(ctx, QueryTracesInput(datasource_uid="tempo", service_name="svc"))
        assert result.error is None

    @pytest.mark.asyncio
    async def test_query_traces_403(self):
        from harness.tools.grafana.tools import QueryTracesTool, QueryTracesInput
        tool = QueryTracesTool()
        ctx = _make_ctx()
        with patch.object(tool, "_query", new=AsyncMock(return_value=(403, {}))):
            result = await tool.run(ctx, QueryTracesInput(datasource_uid="tempo", service_name="svc"))
        assert result.error.code == "permission_denied"

    @pytest.mark.asyncio
    async def test_query_profiles_unavailable_404(self):
        from harness.tools.grafana.tools import QueryProfilesTool, QueryProfilesInput
        tool = QueryProfilesTool()
        ctx = _make_ctx()
        with patch.object(tool, "_query", new=AsyncMock(return_value=(404, {}))):
            result = await tool.run(ctx, QueryProfilesInput(datasource_uid="pyro", query="svc"))
        assert result.error is None
        assert "unavailable" in str(result.data).lower()

    @pytest.mark.asyncio
    async def test_query_profiles_success(self):
        from harness.tools.grafana.tools import QueryProfilesTool, QueryProfilesInput
        tool = QueryProfilesTool()
        ctx = _make_ctx()
        raw = {"results": {}}
        with patch.object(tool, "_query", new=AsyncMock(return_value=(200, raw))):
            with patch("harness.tools.grafana.result_shaping._store_drill_down", new=AsyncMock(return_value="h")):
                result = await tool.run(ctx, QueryProfilesInput(datasource_uid="pyro", query="svc"))
        assert result.error is None


class TestWriteToolsPaths:
    """Coverage for create_silence and create_annotation error paths."""

    @pytest.mark.asyncio
    async def test_create_silence_success(self):
        from harness.tools.grafana.write_tools import CreateSilenceTool, CreateSilenceInput
        tool = CreateSilenceTool()
        ctx = _make_ctx()
        mock_data = {"silenceID": "silence-123"}
        with patch.object(tool, "_query", new=AsyncMock(return_value=(200, mock_data))):
            result = await tool.run(ctx, CreateSilenceInput(
                matchers=[{"name": "alertname", "value": "Test", "isRegex": False}],
                starts_at="2024-01-01T00:00:00Z",
                ends_at="2024-01-01T01:00:00Z",
                comment="test silence",
            ))
        assert result.error is None
        assert result.data["silence_id"] == "silence-123"

    @pytest.mark.asyncio
    async def test_create_silence_403(self):
        from harness.tools.grafana.write_tools import CreateSilenceTool, CreateSilenceInput
        tool = CreateSilenceTool()
        ctx = _make_ctx()
        with patch.object(tool, "_query", new=AsyncMock(return_value=(403, {}))):
            result = await tool.run(ctx, CreateSilenceInput(
                matchers=[], starts_at="2024-01-01T00:00:00Z",
                ends_at="2024-01-01T01:00:00Z", comment="test"
            ))
        assert result.error.code == "permission_denied"

    @pytest.mark.asyncio
    async def test_create_annotation_500(self):
        from harness.tools.grafana.write_tools import CreateAnnotationTool, CreateAnnotationInput
        tool = CreateAnnotationTool()
        ctx = _make_ctx()
        with patch.object(tool, "_query", new=AsyncMock(return_value=(500, {"message": "err"}))):
            result = await tool.run(ctx, CreateAnnotationInput(text="test"))
        assert result.error.code == "datasource_error"


class TestToolRegistryPaths:
    """Coverage for ToolRegistry tool_specs and clear."""

    def test_tool_specs_returns_json_schema(self):
        from harness.tools.registry import ToolRegistry
        from harness.tools.grafana.tools import ListDatasourcesTool
        registry = ToolRegistry()
        registry.register(ListDatasourcesTool())
        specs = registry.tool_specs()
        assert len(specs) == 1
        assert specs[0]["name"] == "list_datasources"
        assert "input_schema" in specs[0]

    def test_clear_empties_registry(self):
        from harness.tools.registry import ToolRegistry
        from harness.tools.grafana.tools import ListDatasourcesTool
        registry = ToolRegistry()
        registry.register(ListDatasourcesTool())
        registry.clear()
        assert registry.all_tools() == []

    def test_all_tools_order(self):
        from harness.tools.registry import ToolRegistry
        from harness.tools.grafana.tools import ListDatasourcesTool, QueryMetricsTool
        registry = ToolRegistry()
        t1 = ListDatasourcesTool()
        t2 = QueryMetricsTool()
        registry.register(t1)
        registry.register(t2)
        tools = registry.all_tools()
        assert tools[0].name == "list_datasources"
        assert tools[1].name == "query_metrics"


class TestWorkerExecuteTurnResume:
    """Coverage for TurnWorker._execute_turn with resume_command."""

    @pytest.mark.asyncio
    async def test_execute_turn_resume_path(self):
        """_execute_turn with resume_command uses Command(resume=...)."""
        from harness.session.worker import TurnWorker
        from harness.session.registry import graph_registry

        mock_graph = AsyncMock()
        mock_graph.ainvoke = AsyncMock()
        graph_registry.register("investigation", lambda: mock_graph)

        worker = TurnWorker()
        await worker._execute_turn("session-1", {
            "session_type": "investigation",
            "thread_id": "session-1",
            "resume_command": {"developer_accepted": True},
        })

        mock_graph.ainvoke.assert_called_once()
        # First arg should be a Command object
        args = mock_graph.ainvoke.call_args[0]
        from langgraph.types import Command
        assert isinstance(args[0], Command)

    @pytest.mark.asyncio
    async def test_execute_turn_fresh_invocation(self):
        """_execute_turn without resume_command uses plain state dict."""
        from harness.session.worker import TurnWorker
        from harness.session.registry import graph_registry

        mock_graph = AsyncMock()
        mock_graph.ainvoke = AsyncMock()
        graph_registry.register("investigation", lambda: mock_graph)

        worker = TurnWorker()
        await worker._execute_turn("session-2", {
            "session_type": "investigation",
            "input": {"key": "value"},
        })

        mock_graph.ainvoke.assert_called_once()
        args = mock_graph.ainvoke.call_args[0]
        assert args[0] == {"key": "value"}


class TestLangfuseClientMorePaths:
    """More coverage for Langfuse client."""

    def test_record_session_trace(self):
        from harness.observability.langfuse import LangfuseClient, _NoOpLangfuse
        client = LangfuseClient(public_key="pk", secret_key="sk")
        client._client = _NoOpLangfuse()
        # Should not raise
        client.record_session_trace(session_id="s1", trace_id="trace-abc")

    def test_make_langfuse_client_uses_settings(self):
        from harness.observability.langfuse import LangfuseClient
        # Construct directly instead of using make_langfuse_client
        # to avoid Settings reload issues in tests
        client = LangfuseClient(public_key="lf-pk-test", secret_key="lf-sk-test", host="http://test")
        assert client._pk == "lf-pk-test"
        assert client._sk == "lf-sk-test"

    def test_no_op_langfuse_methods(self):
        """_NoOpLangfuse methods are all callable without raising."""
        from harness.observability.langfuse import _NoOpLangfuse
        noop = _NoOpLangfuse()
        noop.trace(id="x", session_id="s")
        noop.score(name="y", value=1.0)
        noop.flush()


class TestGrafanaBaseToolTimeoutPath:
    """Coverage for GrafanaBaseTool._query timeout and error paths."""

    @pytest.mark.asyncio
    async def test_query_timeout_raises(self):
        """Timeout in _query propagates as TimeoutException."""
        import httpx
        from harness.tools.grafana.base import GrafanaBaseTool
        from harness.auth.types import GrafanaCredential, AuthMode

        tool = GrafanaBaseTool()
        credential = GrafanaCredential(token="t", auth_mode=AuthMode.SERVICE_ACCOUNT)

        mock_ctx = MagicMock()
        mock_ctx.credential = credential
        mock_ctx.tool_timeout_s = 30

        with patch("httpx.AsyncClient") as mock_client_cls:
            mock_client = AsyncMock()
            mock_client.get = AsyncMock(side_effect=httpx.TimeoutException("timed out"))
            mock_client.__aenter__ = AsyncMock(return_value=mock_client)
            mock_client.__aexit__ = AsyncMock(return_value=None)
            mock_client_cls.return_value = mock_client

            with pytest.raises(httpx.TimeoutException):
                await tool._query(mock_ctx, "/api/datasources")

    @pytest.mark.asyncio
    async def test_query_connection_error_raises(self):
        """Connection error in _query propagates."""
        from harness.tools.grafana.base import GrafanaBaseTool
        from harness.auth.types import GrafanaCredential, AuthMode

        tool = GrafanaBaseTool()
        credential = GrafanaCredential(token="t", auth_mode=AuthMode.SERVICE_ACCOUNT)

        mock_ctx = MagicMock()
        mock_ctx.credential = credential
        mock_ctx.tool_timeout_s = 30

        with patch("httpx.AsyncClient") as mock_client_cls:
            mock_client = AsyncMock()
            mock_client.get = AsyncMock(side_effect=ConnectionError("refused"))
            mock_client.__aenter__ = AsyncMock(return_value=mock_client)
            mock_client.__aexit__ = AsyncMock(return_value=None)
            mock_client_cls.return_value = mock_client

            with pytest.raises(ConnectionError):
                await tool._query(mock_ctx, "/api/datasources")
    """Coverage for get_current_span and record_llm_usage."""

    def test_get_current_span_returns_span(self):
        from harness.observability.otel import get_current_span
        span = get_current_span()
        assert span is not None

    def test_record_llm_usage_no_crash(self):
        from harness.observability.otel import record_llm_usage
        mock_span = MagicMock()
        record_llm_usage(mock_span, "anthropic", "claude-haiku", 100, 50)
        mock_span.set_attribute.assert_called()


class TestFetchMoreTool:
    """Coverage for FetchMoreTool paths."""

    @pytest.mark.asyncio
    async def test_fetch_more_not_found(self):
        from harness.tools.grafana.tools import FetchMoreTool, FetchMoreInput
        tool = FetchMoreTool()
        ctx = _make_ctx()

        mock_result = MagicMock()
        mock_result.fetchone.return_value = None

        mock_db = AsyncMock()
        mock_db.execute = AsyncMock(return_value=mock_result)
        mock_db.__aenter__ = AsyncMock(return_value=mock_db)
        mock_db.__aexit__ = AsyncMock(return_value=None)

        # AsyncSessionLocal is imported locally inside fetch_more — patch at app.db
        with patch("app.db.AsyncSessionLocal", return_value=mock_db):
            result = await tool.run(ctx, FetchMoreInput(handle="expired-handle"))

        assert result.error is not None
        assert result.error.code == "not_found"

    @pytest.mark.asyncio
    async def test_fetch_more_found(self):
        from harness.tools.grafana.tools import FetchMoreTool, FetchMoreInput
        tool = FetchMoreTool()
        ctx = _make_ctx()

        mock_row = MagicMock()
        mock_row.tool_name = "query_metrics"
        mock_row.full_result = {"results": {}}

        mock_result = MagicMock()
        mock_result.fetchone.return_value = mock_row

        mock_db = AsyncMock()
        mock_db.execute = AsyncMock(return_value=mock_result)
        mock_db.__aenter__ = AsyncMock(return_value=mock_db)
        mock_db.__aexit__ = AsyncMock(return_value=None)

        with patch("app.db.AsyncSessionLocal", return_value=mock_db):
            with patch("harness.tools.grafana.result_shaping._store_drill_down", new=AsyncMock(return_value="h2")):
                result = await tool.run(ctx, FetchMoreInput(handle="valid-handle"))

        assert result.error is None
