"""Test fixtures for unit and integration tests."""

import subprocess
import uuid
from collections.abc import AsyncGenerator
from datetime import datetime, timezone
from typing import Any
from unittest.mock import AsyncMock, MagicMock

import pytest
import pytest_asyncio
from httpx import ASGITransport, AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine
from testcontainers.postgres import PostgresContainer

from app.agent.rca_state import AlertContext, RCAState
from app.agent.state import OrcaState
from app.db import get_session
from app.main import app

# ---------------------------------------------------------------------------
# Database fixtures — real PostgreSQL via Testcontainers
# ---------------------------------------------------------------------------

@pytest.fixture(scope="session")
def pg_container():
    """Start a PostgreSQL 16 container for the entire test session."""
    with PostgresContainer("postgres:16-alpine", driver="asyncpg") as pg:
        yield pg


@pytest_asyncio.fixture(scope="session")
async def test_engine(pg_container):
    """Create an async engine connected to the test Postgres container.

    Runs the full Alembic migration chain so the schema is always in sync
    with migrations rather than reflecting from SQLAlchemy metadata.
    """
    async_url = pg_container.get_connection_url()  # postgresql+asyncpg://...
    # Alembic uses a sync engine internally — strip the async driver for it
    sync_url = async_url.replace("+asyncpg", "")

    # Run alembic upgrade head synchronously (it manages its own engine)
    result = subprocess.run(
        ["alembic", "upgrade", "head"],
        env={**__import__("os").environ, "DATABASE_URL": sync_url},
        capture_output=True,
        text=True,
        cwd="/Users/av/Repositories/vikshana/vikshana-graft-app/.claude/worktrees/awesome-boyd/services/orca/backend",
    )
    if result.returncode != 0:
        raise RuntimeError(f"Alembic upgrade failed:\n{result.stderr}")

    engine = create_async_engine(async_url, echo=False)
    yield engine
    await engine.dispose()


@pytest_asyncio.fixture
async def test_session(test_engine) -> AsyncGenerator[AsyncSession, None]:
    """Provide an async test database session that rolls back after each test."""
    TestSessionLocal = async_sessionmaker(
        bind=test_engine,
        class_=AsyncSession,
        expire_on_commit=False,
        autocommit=False,
        autoflush=False,
    )
    async with TestSessionLocal() as session:
        yield session
        await session.rollback()


@pytest_asyncio.fixture
async def client(test_session: AsyncSession) -> AsyncGenerator[AsyncClient, None]:
    """Provide an httpx AsyncClient pointing at the FastAPI test app."""

    async def override_get_session() -> AsyncGenerator[AsyncSession, None]:
        yield test_session

    app.dependency_overrides[get_session] = override_get_session

    async with AsyncClient(
        transport=ASGITransport(app=app),
        base_url="http://test",
    ) as ac:
        yield ac

    app.dependency_overrides.clear()


# ---------------------------------------------------------------------------
# State fixtures
# ---------------------------------------------------------------------------

@pytest.fixture
def valid_labels() -> dict[str, str]:
    """Return a complete set of valid alert labels."""
    return {
        "alertname": "HighLatency",
        "service_name": "checkout-service",
        "deployment_environment_name": "production",
        "domain": "commerce",
        "legal_company": "acme-corp",
        "sub_domain": "checkout",
        "system_id": "sys-001",
        "team": "checkout-team",
        "version": "1.2.3",
        "severity": "critical",
    }


@pytest.fixture
def valid_grafana_alert_payload(valid_labels: dict[str, str]) -> dict[str, Any]:
    """Return a minimal valid Grafana alert payload."""
    return {
        "status": "firing",
        "labels": valid_labels,
        "annotations": {
            "summary": "Checkout service latency > 500ms",
            "description": "P95 latency has exceeded 500ms for more than 5 minutes.",
        },
        "startsAt": "2024-01-15T14:47:00Z",
        "endsAt": "0001-01-01T00:00:00Z",
        "generatorURL": "http://grafana:3000/alerting/...",
        "fingerprint": "abc123",
    }


@pytest.fixture
def valid_webhook_payload(valid_grafana_alert_payload: dict[str, Any]) -> dict[str, Any]:
    """Return a complete valid Grafana webhook payload."""
    return {
        "version": "1",
        "groupKey": "test-group",
        "status": "firing",
        "receiver": "orca-webhook",
        "groupLabels": {"alertname": "HighLatency"},
        "commonLabels": {},
        "commonAnnotations": {},
        "externalURL": "http://grafana:3000",
        "alerts": [valid_grafana_alert_payload],
    }


@pytest.fixture
def valid_orca_state(valid_labels: dict[str, str], valid_grafana_alert_payload: dict[str, Any]) -> OrcaState:
    """Return a minimal valid OrcaState for testing."""
    return OrcaState(
        rca_id=str(uuid.uuid4()),
        alert_payload=valid_grafana_alert_payload,
        alert_labels=valid_labels,
        alert_name="HighLatency",
        severity="critical",
        investigation_steps=[],
        step_count=0,
        total_tokens_used=0,
        evidence=[],
        similar_past_alerts=[],
        related_rcas=[],
        root_cause="",
        contributing_factors=[],
        timeline=[],
        impact_summary="",
        confidence_level="low",
        confidence_reasoning="",
        report_markdown="",
        status="triggered",
        error_message=None,
    )


# ---------------------------------------------------------------------------
# Mock MCP fixtures
# ---------------------------------------------------------------------------

@pytest.fixture
def mock_grafana_tools() -> list[Any]:
    """Return a list of mock Grafana MCP tools."""
    tools = []
    for tool_name in ["search_dashboards", "query_prometheus", "query_loki", "get_alerts"]:
        mock_tool = MagicMock()
        mock_tool.name = tool_name
        mock_tool.ainvoke = AsyncMock(return_value=f"Mock result from {tool_name}")
        tools.append(mock_tool)
    return tools


@pytest.fixture
def mock_llm_response() -> MagicMock:
    """Return a mock LLM response object."""
    mock = MagicMock()
    mock.content = '{"severity": "critical", "valid": true, "reasoning": "Production service", "missing_labels": []}'
    mock.usage_metadata = {"total_tokens": 150}
    mock.tool_calls = []
    return mock


# ---------------------------------------------------------------------------
# RCA session fixtures (new interactive flow)
# ---------------------------------------------------------------------------

@pytest.fixture
def rca_alert_context() -> AlertContext:
    """Minimal AlertContext for RCA session tests."""
    return AlertContext(
        alert_id="test-alert-001",
        alert_name="HighErrorRate",
        description="Error rate > 5% on checkout-service",
        service="checkout-service",
        environment="production",
        labels={"severity": "critical", "team": "checkout"},
        org_id=1,
    )


@pytest.fixture
def rca_initial_state(rca_alert_context: AlertContext) -> RCAState:
    """Minimal valid RCAState for testing nodes in isolation."""
    from langchain_core.messages import HumanMessage
    return RCAState(
        alert_context=rca_alert_context,
        org_id=1,
        gathered_data=[],
        past_rcas=[],
        hypotheses=[],
        confidence_scores=[],
        round=0,
        developer_accepted=False,
        max_rounds=5,
        messages=[],
        pending_question=None,
        final_report=None,
        rca_session_id=None,
        error_message=None,
        force_finalized=False,
    )

