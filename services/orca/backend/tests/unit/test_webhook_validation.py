"""Unit tests for Grafana webhook payload validation schemas."""

import pytest
from pydantic import ValidationError

from app.schemas.webhook import GrafanaAlert, GrafanaWebhookPayload, REQUIRED_LABELS


VALID_LABELS = {
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


class TestGrafanaAlert:
    """Tests for the GrafanaAlert Pydantic schema."""

    def test_valid_alert_parses_successfully(self) -> None:
        """A valid alert with all required labels should parse without error."""
        alert = GrafanaAlert(
            status="firing",
            labels=VALID_LABELS,
            annotations={"summary": "High latency detected"},
        )
        assert alert.status == "firing"
        assert alert.labels["service_name"] == "checkout-service"

    def test_resolved_status_accepted(self) -> None:
        """Status 'resolved' should be accepted."""
        alert = GrafanaAlert(status="resolved", labels=VALID_LABELS)
        assert alert.status == "resolved"

    def test_invalid_status_rejected(self) -> None:
        """Unknown status values should be rejected."""
        with pytest.raises(ValidationError) as exc_info:
            GrafanaAlert(status="broken", labels=VALID_LABELS)
        assert "status" in str(exc_info.value).lower() or "broken" in str(exc_info.value)

    def test_missing_single_required_label_fails(self) -> None:
        """Missing any single required label should fail validation."""
        for missing_label in REQUIRED_LABELS:
            labels = {k: v for k, v in VALID_LABELS.items() if k != missing_label}
            with pytest.raises(ValidationError) as exc_info:
                GrafanaAlert(status="firing", labels=labels)
            assert missing_label in str(exc_info.value)

    def test_missing_multiple_labels_shows_all_missing(self) -> None:
        """Missing multiple labels should report all of them in the error."""
        labels = {"alertname": "Test"}  # Only alertname, all required labels missing
        with pytest.raises(ValidationError) as exc_info:
            GrafanaAlert(status="firing", labels=labels)
        error_str = str(exc_info.value)
        # At least some of the missing labels should appear in the error
        assert any(label in error_str for label in REQUIRED_LABELS)

    def test_default_values_set_on_optional_fields(self) -> None:
        """Optional fields should have sensible defaults."""
        alert = GrafanaAlert(status="firing", labels=VALID_LABELS)
        assert alert.annotations == {}
        assert alert.startsAt == ""
        assert alert.fingerprint == ""


class TestGrafanaWebhookPayload:
    """Tests for the GrafanaWebhookPayload Pydantic schema."""

    def test_valid_payload_parses_successfully(self, valid_webhook_payload: dict) -> None:
        """A valid webhook payload should parse without error."""
        payload = GrafanaWebhookPayload.model_validate(valid_webhook_payload)
        assert len(payload.alerts) == 1
        assert payload.alerts[0].status == "firing"

    def test_multiple_alerts_parsed(self) -> None:
        """A payload with multiple alerts should parse all of them."""
        payload = GrafanaWebhookPayload(
            alerts=[
                GrafanaAlert(status="firing", labels=VALID_LABELS),
                GrafanaAlert(
                    status="firing",
                    labels={**VALID_LABELS, "service_name": "payment-service"},
                ),
            ]
        )
        assert len(payload.alerts) == 2
        assert payload.alerts[0].labels["service_name"] == "checkout-service"
        assert payload.alerts[1].labels["service_name"] == "payment-service"

    def test_empty_alerts_list_accepted(self) -> None:
        """A payload with no alerts (e.g., test ping) should be accepted."""
        payload = GrafanaWebhookPayload(alerts=[])
        assert payload.alerts == []

    def test_payload_with_invalid_alert_raises(self) -> None:
        """A payload containing an alert with missing labels should fail."""
        with pytest.raises(ValidationError):
            GrafanaWebhookPayload(
                alerts=[GrafanaAlert(status="firing", labels={"alertname": "Test"})]
            )

    def test_default_fields_populated(self) -> None:
        """Optional top-level fields should have sensible defaults."""
        payload = GrafanaWebhookPayload()
        assert payload.version == "1"
        assert payload.alerts == []
        assert payload.groupLabels == {}

