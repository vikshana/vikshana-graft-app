"""Integration tests for the full webhook → RCA flow.

Tests that a valid webhook payload results in a persisted Alert and RCA,
with the agent being triggered (mocked to avoid actual LLM calls).
"""

import uuid
from datetime import datetime, timezone
from typing import Any
from unittest.mock import AsyncMock, patch

import pytest
from httpx import AsyncClient
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.alert import Alert
from app.models.rca import RCA

VALID_WEBHOOK_PAYLOAD: dict[str, Any] = {
    "version": "1",
    "groupKey": "integration-test-group",
    "status": "firing",
    "receiver": "orca-webhook",
    "groupLabels": {"alertname": "IntegrationTestAlert"},
    "commonLabels": {},
    "commonAnnotations": {},
    "externalURL": "http://grafana:3000",
    "alerts": [
        {
            "status": "firing",
            "labels": {
                "alertname": "IntegrationTestAlert",
                "service_name": "payment-service",
                "deployment_environment_name": "production",
                "domain": "payments",
                "legal_company": "acme-corp",
                "sub_domain": "checkout",
                "system_id": "sys-payment-001",
                "team": "payments-team",
                "version": "2.1.0",
                "severity": "critical",
            },
            "annotations": {
                "summary": "Payment service error rate above 5%",
                "description": "Error rate: 8.2%",
            },
            "startsAt": "2024-01-15T14:47:00Z",
            "endsAt": "0001-01-01T00:00:00Z",
            "generatorURL": "http://grafana:3000/alerting/...",
            "fingerprint": "integration-test-fingerprint",
        }
    ],
}


@pytest.mark.integration
class TestWebhookToRCAFlow:
    """Integration tests for POST /webhook/grafana → RCA creation."""

    @pytest.mark.asyncio
    async def test_valid_webhook_returns_202(self, client: AsyncClient) -> None:
        """A valid webhook should return HTTP 202 Accepted."""
        with patch("app.api.webhooks._run_agent_task", new=AsyncMock()):
            response = await client.post("/webhook/grafana", json=VALID_WEBHOOK_PAYLOAD)

        assert response.status_code == 202

    @pytest.mark.asyncio
    async def test_valid_webhook_creates_alert_record(
        self, client: AsyncClient, test_session: AsyncSession
    ) -> None:
        """A valid webhook should persist an Alert record with correct fields."""
        with patch("app.api.webhooks._run_agent_task", new=AsyncMock()):
            response = await client.post("/webhook/grafana", json=VALID_WEBHOOK_PAYLOAD)

        assert response.status_code == 202
        data = response.json()
        assert len(data) == 1

        # Check Alert record was persisted
        alert_id = uuid.UUID(data[0]["alert_id"])
        result = await test_session.execute(select(Alert).where(Alert.id == alert_id))
        alert = result.scalar_one_or_none()

        assert alert is not None
        assert alert.alert_name == "IntegrationTestAlert"
        assert alert.service_name == "payment-service"
        assert alert.deployment_environment_name == "production"
        assert alert.status == "firing"
        assert alert.severity == "critical"

    @pytest.mark.asyncio
    async def test_valid_webhook_creates_rca_record(
        self, client: AsyncClient, test_session: AsyncSession
    ) -> None:
        """A valid webhook should persist an RCA record with status=triggered."""
        with patch("app.api.webhooks._run_agent_task", new=AsyncMock()):
            response = await client.post("/webhook/grafana", json=VALID_WEBHOOK_PAYLOAD)

        assert response.status_code == 202
        data = response.json()
        rca_id = uuid.UUID(data[0]["rca_id"])

        result = await test_session.execute(select(RCA).where(RCA.id == rca_id))
        rca = result.scalar_one_or_none()

        assert rca is not None
        assert rca.status == "triggered"
        assert rca.alert_name == "IntegrationTestAlert"
        assert rca.service_name == "payment-service"
        assert rca.team == "payments-team"

    @pytest.mark.asyncio
    async def test_webhook_response_contains_rca_and_alert_ids(self, client: AsyncClient) -> None:
        """Webhook response should contain rca_id, alert_id, and initial status."""
        with patch("app.api.webhooks._run_agent_task", new=AsyncMock()):
            response = await client.post("/webhook/grafana", json=VALID_WEBHOOK_PAYLOAD)

        data = response.json()
        assert len(data) == 1
        assert "rca_id" in data[0]
        assert "alert_id" in data[0]
        assert data[0]["status"] == "triggered"

        # Validate UUIDs
        uuid.UUID(data[0]["rca_id"])  # raises ValueError if invalid
        uuid.UUID(data[0]["alert_id"])

    @pytest.mark.asyncio
    async def test_resolved_alerts_are_ignored(self, client: AsyncClient) -> None:
        """Resolved alerts should not create RCAs."""
        payload = {
            **VALID_WEBHOOK_PAYLOAD,
            "alerts": [
                {**VALID_WEBHOOK_PAYLOAD["alerts"][0], "status": "resolved"}
            ],
        }
        with patch("app.api.webhooks._run_agent_task", new=AsyncMock()):
            response = await client.post("/webhook/grafana", json=payload)

        assert response.status_code == 202
        data = response.json()
        assert data == []  # No RCAs created for resolved alerts

    @pytest.mark.asyncio
    async def test_multiple_alerts_create_multiple_rcas(self, client: AsyncClient) -> None:
        """A payload with multiple firing alerts should create one RCA per alert."""
        second_alert = {
            **VALID_WEBHOOK_PAYLOAD["alerts"][0],
            "labels": {
                **VALID_WEBHOOK_PAYLOAD["alerts"][0]["labels"],
                "service_name": "cart-service",
                "alertname": "CartServiceDown",
            },
            "fingerprint": "another-fingerprint",
        }
        payload = {
            **VALID_WEBHOOK_PAYLOAD,
            "alerts": [VALID_WEBHOOK_PAYLOAD["alerts"][0], second_alert],
        }

        with patch("app.api.webhooks._run_agent_task", new=AsyncMock()):
            response = await client.post("/webhook/grafana", json=payload)

        assert response.status_code == 202
        data = response.json()
        assert len(data) == 2
        rca_ids = {item["rca_id"] for item in data}
        assert len(rca_ids) == 2  # Two distinct RCA IDs

    @pytest.mark.asyncio
    async def test_webhook_with_missing_labels_returns_422(self, client: AsyncClient) -> None:
        """Alerts missing required labels should be rejected with 422."""
        payload = {
            **VALID_WEBHOOK_PAYLOAD,
            "alerts": [
                {
                    "status": "firing",
                    "labels": {"alertname": "TestAlert", "service_name": "svc"},  # Missing most labels
                    "annotations": {},
                    "startsAt": "2024-01-15T14:47:00Z",
                }
            ],
        }
        response = await client.post("/webhook/grafana", json=payload)
        assert response.status_code == 422

    @pytest.mark.asyncio
    async def test_rca_retrievable_after_webhook(
        self, client: AsyncClient, test_session: AsyncSession
    ) -> None:
        """After a webhook, the created RCA should be retrievable via GET /api/rca/{id}."""
        with patch("app.api.webhooks._run_agent_task", new=AsyncMock()):
            webhook_response = await client.post("/webhook/grafana", json=VALID_WEBHOOK_PAYLOAD)

        assert webhook_response.status_code == 202
        rca_id = webhook_response.json()[0]["rca_id"]

        # Retrieve via the RCA API
        get_response = await client.get(f"/api/rca/{rca_id}")
        assert get_response.status_code == 200
        rca_data = get_response.json()
        assert rca_data["id"] == rca_id
        assert rca_data["status"] == "triggered"
        assert rca_data["alert_name"] == "IntegrationTestAlert"

