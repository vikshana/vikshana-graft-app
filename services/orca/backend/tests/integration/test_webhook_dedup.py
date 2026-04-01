"""Integration tests for webhook alert deduplication.

Verifies that:
- A second identical webhook within the window reuses the existing RCA.
- A second webhook with different labels creates a new RCA.
- The duplicate_count is incremented correctly.
- The rca_duplicate_alerts table is populated.
- An active investigation absorbs duplicates regardless of time.
"""

import uuid
from datetime import datetime, timedelta, timezone
from typing import Any
from unittest.mock import AsyncMock, patch

import pytest
from httpx import AsyncClient
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.agent.dedup import compute_fingerprint
from app.models.alert import Alert
from app.models.rca import RCA
from app.models.rca_duplicate_alert import RCADuplicateAlert

# ---------------------------------------------------------------------------
# Shared payload factory
# ---------------------------------------------------------------------------

_BASE_LABELS: dict[str, str] = {
    "alertname": "DedupTestAlert",
    "service_name": "inventory-service",
    "deployment_environment_name": "production",
    "domain": "logistics",
    "legal_company": "acme-corp",
    "sub_domain": "warehouse",
    "system_id": "sys-inv-001",
    "team": "inventory-team",
    "version": "3.0.1",
    "severity": "critical",
}


def _make_webhook(labels: dict[str, str] | None = None) -> dict[str, Any]:
    """Build a minimal valid webhook payload with the given labels."""
    return {
        "version": "1",
        "groupKey": "dedup-test-group",
        "status": "firing",
        "receiver": "orca-webhook",
        "groupLabels": {},
        "commonLabels": {},
        "commonAnnotations": {},
        "externalURL": "http://grafana:3000",
        "alerts": [
            {
                "status": "firing",
                "labels": labels or dict(_BASE_LABELS),
                "annotations": {"summary": "Dedup integration test"},
                "startsAt": "2024-01-15T14:47:00Z",
                "endsAt": "0001-01-01T00:00:00Z",
                "generatorURL": "http://grafana:3000/alerting/...",
                "fingerprint": "dedup-integration-test",
            }
        ],
    }


@pytest.mark.integration
class TestWebhookDeduplication:
    """Integration tests for alert deduplication in the webhook handler."""

    @pytest.mark.asyncio
    async def test_second_identical_alert_is_deduplicated(
        self, client: AsyncClient, test_session: AsyncSession
    ) -> None:
        """Two identical webhooks should result in one RCA with duplicate_count=1."""
        payload = _make_webhook()

        with patch("app.api.webhooks._run_agent_task", new=AsyncMock()) as mock_task:
            r1 = await client.post("/webhook/grafana", json=payload)
            r2 = await client.post("/webhook/grafana", json=payload)

        assert r1.status_code == 202
        assert r2.status_code == 202

        d1 = r1.json()[0]
        d2 = r2.json()[0]

        # Both responses should reference the same RCA
        assert d1["rca_id"] == d2["rca_id"]

        # First is new, second is a duplicate
        assert d1["deduplicated"] is False
        assert d2["deduplicated"] is True

        # Agent should only have been triggered once
        assert mock_task.call_count == 1

        # Verify database state
        rca_id = uuid.UUID(d1["rca_id"])
        rca = await test_session.get(RCA, rca_id)
        assert rca is not None
        assert rca.duplicate_count == 1

    @pytest.mark.asyncio
    async def test_different_labels_creates_new_rca(
        self, client: AsyncClient, test_session: AsyncSession
    ) -> None:
        """An alert with different labels must create a separate RCA."""
        payload_a = _make_webhook({**_BASE_LABELS, "service_name": "service-alpha"})
        payload_b = _make_webhook({**_BASE_LABELS, "service_name": "service-beta"})

        with patch("app.api.webhooks._run_agent_task", new=AsyncMock()) as mock_task:
            r1 = await client.post("/webhook/grafana", json=payload_a)
            r2 = await client.post("/webhook/grafana", json=payload_b)

        assert r1.status_code == 202
        assert r2.status_code == 202

        d1 = r1.json()[0]
        d2 = r2.json()[0]

        # Different RCAs
        assert d1["rca_id"] != d2["rca_id"]
        assert d1["deduplicated"] is False
        assert d2["deduplicated"] is False

        # Both should have triggered agent tasks
        assert mock_task.call_count == 2

    @pytest.mark.asyncio
    async def test_duplicate_alert_is_linked_in_join_table(
        self, client: AsyncClient, test_session: AsyncSession
    ) -> None:
        """The rca_duplicate_alerts table should have one row after dedup."""
        labels = {**_BASE_LABELS, "service_name": "join-table-svc"}
        payload = _make_webhook(labels)

        with patch("app.api.webhooks._run_agent_task", new=AsyncMock()):
            r1 = await client.post("/webhook/grafana", json=payload)
            r2 = await client.post("/webhook/grafana", json=payload)

        rca_id = uuid.UUID(r1.json()[0]["rca_id"])
        dup_alert_id = uuid.UUID(r2.json()[0]["alert_id"])

        result = await test_session.execute(
            select(RCADuplicateAlert).where(RCADuplicateAlert.rca_id == rca_id)
        )
        rows = result.scalars().all()
        assert len(rows) == 1
        assert rows[0].alert_id == dup_alert_id

    @pytest.mark.asyncio
    async def test_multiple_duplicates_increment_count_correctly(
        self, client: AsyncClient, test_session: AsyncSession
    ) -> None:
        """Three identical webhooks should leave duplicate_count=2."""
        labels = {**_BASE_LABELS, "service_name": "multi-dup-svc"}
        payload = _make_webhook(labels)

        with patch("app.api.webhooks._run_agent_task", new=AsyncMock()):
            for _ in range(3):
                await client.post("/webhook/grafana", json=payload)

        # Find the canonical RCA
        fp = compute_fingerprint("DedupTestAlert", labels)
        result = await test_session.execute(
            select(RCA)
            .join(Alert, RCA.alert_id == Alert.id)
            .where(Alert.dedup_fingerprint == fp)
            .order_by(RCA.created_at.asc())
            .limit(1)
        )
        rca = result.scalar_one_or_none()
        assert rca is not None
        assert rca.duplicate_count == 2

    @pytest.mark.asyncio
    async def test_active_rca_absorbs_duplicate_regardless_of_window(
        self, client: AsyncClient, test_session: AsyncSession
    ) -> None:
        """An active (investigating) RCA should absorb duplicates even if a large
        ORCA_DEDUP_WINDOW_MINUTES wouldn't catch it by time alone."""
        labels = {**_BASE_LABELS, "service_name": "active-window-svc"}
        payload = _make_webhook(labels)

        # Use a window of 0 minutes so time-based dedup never triggers;
        # only status-based dedup should match.
        with patch("app.api.webhooks._run_agent_task", new=AsyncMock()):
            r1 = await client.post("/webhook/grafana", json=payload)

            # Manually set RCA to "investigating" to simulate active investigation
            rca_id = uuid.UUID(r1.json()[0]["rca_id"])
            rca = await test_session.get(RCA, rca_id)
            assert rca is not None
            rca.status = "investigating"
            await test_session.commit()

            with patch("app.agent.dedup.settings") as mock_settings:
                mock_settings.ORCA_DEDUP_WINDOW_MINUTES = 0
                r2 = await client.post("/webhook/grafana", json=payload)

        d2 = r2.json()[0]
        assert d2["deduplicated"] is True
        assert d2["rca_id"] == str(rca_id)

    @pytest.mark.asyncio
    async def test_dedup_response_contains_existing_rca_status(
        self, client: AsyncClient, test_session: AsyncSession
    ) -> None:
        """The deduplicated response status should reflect the canonical RCA's current status."""
        labels = {**_BASE_LABELS, "service_name": "status-reflect-svc"}
        payload = _make_webhook(labels)

        with patch("app.api.webhooks._run_agent_task", new=AsyncMock()):
            r1 = await client.post("/webhook/grafana", json=payload)
            r2 = await client.post("/webhook/grafana", json=payload)

        assert r1.json()[0]["status"] == "triggered"
        # Duplicate should reflect the live RCA status at dedup time
        assert r2.json()[0]["status"] == "triggered"
        assert r2.json()[0]["deduplicated"] is True

    @pytest.mark.asyncio
    async def test_alert_fingerprint_stored_on_alert_record(
        self, client: AsyncClient, test_session: AsyncSession
    ) -> None:
        """The Alert record should have dedup_fingerprint populated."""
        labels = {**_BASE_LABELS, "service_name": "fingerprint-check-svc"}
        payload = _make_webhook(labels)
        expected_fp = compute_fingerprint("DedupTestAlert", labels)

        with patch("app.api.webhooks._run_agent_task", new=AsyncMock()):
            r = await client.post("/webhook/grafana", json=payload)

        alert_id = uuid.UUID(r.json()[0]["alert_id"])
        alert = await test_session.get(Alert, alert_id)
        assert alert is not None
        assert alert.dedup_fingerprint == expected_fp

    @pytest.mark.asyncio
    async def test_get_rca_detail_includes_duplicate_alerts(
        self, client: AsyncClient, test_session: AsyncSession
    ) -> None:
        """The GET /api/rca/{id} endpoint should include duplicate_alerts and duplicate_count."""
        labels = {**_BASE_LABELS, "service_name": "api-detail-svc"}
        payload = _make_webhook(labels)

        with patch("app.api.webhooks._run_agent_task", new=AsyncMock()):
            r1 = await client.post("/webhook/grafana", json=payload)
            r2 = await client.post("/webhook/grafana", json=payload)

        rca_id = r1.json()[0]["rca_id"]
        dup_alert_id = r2.json()[0]["alert_id"]

        detail_response = await client.get(f"/api/rca/{rca_id}")
        assert detail_response.status_code == 200
        detail = detail_response.json()

        assert detail["duplicate_count"] == 1
        assert len(detail["duplicate_alerts"]) == 1
        assert detail["duplicate_alerts"][0]["alert_id"] == dup_alert_id

    @pytest.mark.asyncio
    async def test_get_rca_list_includes_duplicate_count(
        self, client: AsyncClient, test_session: AsyncSession
    ) -> None:
        """The GET /api/rca list should include duplicate_count in each summary."""
        labels = {**_BASE_LABELS, "service_name": "list-dedup-svc"}
        payload = _make_webhook(labels)

        with patch("app.api.webhooks._run_agent_task", new=AsyncMock()):
            r1 = await client.post("/webhook/grafana", json=payload)
            await client.post("/webhook/grafana", json=payload)

        rca_id = r1.json()[0]["rca_id"]

        list_response = await client.get("/api/rca")
        assert list_response.status_code == 200
        items = list_response.json()["items"]
        matched = [i for i in items if i["id"] == rca_id]
        assert len(matched) == 1
        assert matched[0]["duplicate_count"] == 1

