"""Pydantic schemas for Grafana webhook payload validation."""

from pydantic import BaseModel, field_validator, model_validator

# Required label keys that every Grafana alert must carry
REQUIRED_LABELS: list[str] = [
    "service_name",
    "deployment_environment_name",
    "domain",
    "legal_company",
    "sub_domain",
    "system_id",
    "team",
    "version",
]


class GrafanaAlert(BaseModel):
    """A single alert entry within a Grafana webhook payload.

    Attributes:
        status: Alert status — "firing" or "resolved".
        labels: Key/value label map attached to the alert rule.
        annotations: Key/value annotation map (summary, description, etc.).
        startsAt: ISO 8601 timestamp when the alert started firing.
        endsAt: ISO 8601 timestamp when the alert resolved (or zero-value).
        generatorURL: URL back to the Grafana alert rule.
        fingerprint: Unique fingerprint for this alert instance.
    """

    status: str
    labels: dict[str, str] = {}
    annotations: dict[str, str] = {}
    startsAt: str = ""
    endsAt: str = ""
    generatorURL: str = ""
    fingerprint: str = ""

    @field_validator("status")
    @classmethod
    def validate_status(cls, v: str) -> str:
        """Ensure status is one of the known Grafana alert states."""
        allowed = {"firing", "resolved", "pending", "inactive"}
        if v not in allowed:
            raise ValueError(f"status must be one of {allowed}, got {v!r}")
        return v

    @model_validator(mode="after")
    def check_required_labels(self) -> "GrafanaAlert":
        """Validate that all required labels are present on the alert.

        Raises:
            ValueError: If any required labels are missing.
        """
        missing = [key for key in REQUIRED_LABELS if key not in self.labels]
        if missing:
            raise ValueError(
                f"Alert is missing required labels: {', '.join(missing)}. "
                f"Alert fingerprint: {self.fingerprint!r}"
            )
        return self


class GrafanaWebhookPayload(BaseModel):
    """Top-level Grafana webhook payload containing one or more alerts.

    Attributes:
        version: Webhook payload version (Grafana sends "1").
        groupKey: Key identifying the alert group.
        truncatedAlerts: Number of alerts truncated due to size limits.
        status: Overall group status.
        receiver: The contact point name that received this notification.
        groupLabels: Labels shared by all alerts in this group.
        commonLabels: Labels common across all alerts.
        commonAnnotations: Annotations common across all alerts.
        externalURL: URL to Grafana instance.
        alerts: List of individual alert instances.
    """

    version: str = "1"
    groupKey: str = ""
    truncatedAlerts: int = 0
    status: str = ""
    receiver: str = ""
    groupLabels: dict[str, str] = {}
    commonLabels: dict[str, str] = {}
    commonAnnotations: dict[str, str] = {}
    externalURL: str = ""
    alerts: list[GrafanaAlert] = []


class WebhookResponse(BaseModel):
    """Response returned after a webhook is accepted.

    Attributes:
        rca_id: UUID of the RCA record (new or existing canonical).
        alert_id: UUID of the alert record created.
        status: Current RCA status.
        deduplicated: True if this alert was suppressed into an existing RCA.
    """

    rca_id: str
    alert_id: str
    status: str
    deduplicated: bool = False

