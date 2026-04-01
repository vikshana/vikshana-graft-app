"""Integration tests for the RCA API endpoints."""

import uuid
from datetime import datetime, timezone

import pytest
import pytest_asyncio
from httpx import AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.rca import RCA
from app.models.agent_step import AgentStep


def make_rca(**kwargs) -> RCA:
    """Create an RCA with test defaults."""
    defaults = {
        "id": uuid.uuid4(),
        "alert_name": "TestAlert",
        "status": "complete",
        "service_name": "checkout-service",
        "deployment_environment_name": "production",
        "domain": "commerce",
        "team": "checkout-team",
        "confidence_level": "high",
        "root_cause": "Memory leak",
        "report_markdown": "# RCA Report\n\nTest report.",
        "created_at": datetime.now(timezone.utc),
    }
    defaults.update(kwargs)
    return RCA(**defaults)


@pytest.mark.integration
class TestRCAListEndpoint:
    """Tests for GET /api/rca."""

    @pytest.mark.asyncio
    async def test_empty_list_returns_empty_response(self, client: AsyncClient) -> None:
        """GET /api/rca on an empty DB should return an empty list."""
        response = await client.get("/api/rca")
        assert response.status_code == 200
        data = response.json()
        assert data["items"] == []
        assert data["total"] == 0
        assert data["page"] == 1

    @pytest.mark.asyncio
    async def test_lists_rcas_from_database(
        self, client: AsyncClient, test_session: AsyncSession
    ) -> None:
        """GET /api/rca should return RCAs stored in the database."""
        rca = make_rca()
        test_session.add(rca)
        await test_session.commit()

        response = await client.get("/api/rca")
        assert response.status_code == 200
        data = response.json()
        assert data["total"] >= 1
        alert_names = [item["alert_name"] for item in data["items"]]
        assert "TestAlert" in alert_names

    @pytest.mark.asyncio
    async def test_filter_by_service_name(
        self, client: AsyncClient, test_session: AsyncSession
    ) -> None:
        """GET /api/rca?service_name=X should filter by service."""
        rca1 = make_rca(alert_name="Alert1", service_name="checkout-service")
        rca2 = make_rca(alert_name="Alert2", service_name="payment-service")
        test_session.add(rca1)
        test_session.add(rca2)
        await test_session.commit()

        response = await client.get("/api/rca?service_name=payment-service")
        assert response.status_code == 200
        data = response.json()
        services = [item["service_name"] for item in data["items"]]
        assert all(s == "payment-service" for s in services)

    @pytest.mark.asyncio
    async def test_filter_by_status(
        self, client: AsyncClient, test_session: AsyncSession
    ) -> None:
        """GET /api/rca?status=failed should return only failed RCAs."""
        rca = make_rca(alert_name="FailedAlert", status="failed")
        test_session.add(rca)
        await test_session.commit()

        response = await client.get("/api/rca?status=failed")
        assert response.status_code == 200
        data = response.json()
        statuses = [item["status"] for item in data["items"]]
        assert all(s == "failed" for s in statuses)

    @pytest.mark.asyncio
    async def test_alert_name_free_text_search(
        self, client: AsyncClient, test_session: AsyncSession
    ) -> None:
        """GET /api/rca?alert_name=latency should do ILIKE search."""
        rca = make_rca(alert_name="HighLatencyWarning")
        test_session.add(rca)
        await test_session.commit()

        response = await client.get("/api/rca?alert_name=latency")
        assert response.status_code == 200
        data = response.json()
        alert_names = [item["alert_name"] for item in data["items"]]
        assert any("latency" in name.lower() for name in alert_names)

    @pytest.mark.asyncio
    async def test_pagination(
        self, client: AsyncClient, test_session: AsyncSession
    ) -> None:
        """Pagination parameters should limit and offset results."""
        for i in range(5):
            test_session.add(make_rca(alert_name=f"Alert{i}", team="page-test-team"))
        await test_session.commit()

        response = await client.get("/api/rca?team=page-test-team&page=1&page_size=3")
        assert response.status_code == 200
        data = response.json()
        assert data["page"] == 1
        assert data["page_size"] == 3
        assert len(data["items"]) <= 3


@pytest.mark.integration
class TestRCADetailEndpoint:
    """Tests for GET /api/rca/{id}."""

    @pytest.mark.asyncio
    async def test_returns_rca_by_id(
        self, client: AsyncClient, test_session: AsyncSession
    ) -> None:
        """GET /api/rca/{id} should return the full RCA detail."""
        rca = make_rca()
        test_session.add(rca)
        await test_session.commit()

        response = await client.get(f"/api/rca/{rca.id}")
        assert response.status_code == 200
        data = response.json()
        assert data["id"] == str(rca.id)
        assert data["alert_name"] == "TestAlert"
        assert data["report_markdown"] == "# RCA Report\n\nTest report."

    @pytest.mark.asyncio
    async def test_returns_404_for_unknown_id(self, client: AsyncClient) -> None:
        """GET /api/rca/{unknown-id} should return 404."""
        unknown_id = uuid.uuid4()
        response = await client.get(f"/api/rca/{unknown_id}")
        assert response.status_code == 404

    @pytest.mark.asyncio
    async def test_includes_agent_steps(
        self, client: AsyncClient, test_session: AsyncSession
    ) -> None:
        """GET /api/rca/{id} should include the agent steps."""
        rca = make_rca()
        test_session.add(rca)
        await test_session.flush()

        step = AgentStep(
            id=uuid.uuid4(),
            rca_id=rca.id,
            step_number=1,
            node_name="triage",
            action="label_validation",
            input="test input",
            output="valid",
            tokens_used=50,
            duration_seconds=0.1,
        )
        test_session.add(step)
        await test_session.commit()

        response = await client.get(f"/api/rca/{rca.id}")
        assert response.status_code == 200
        data = response.json()
        assert len(data["steps"]) == 1
        assert data["steps"][0]["node_name"] == "triage"
        assert data["steps"][0]["action"] == "label_validation"

