"""Unit tests for SQLAlchemy ORM models."""

import uuid
from datetime import datetime, timezone

import pytest

from app.models.alert import Alert
from app.models.rca import RCA
from app.models.agent_step import AgentStep


class TestAlertModel:
    """Tests for the Alert ORM model."""

    def test_alert_with_explicit_values(self) -> None:
        """Alert should accept all fields with explicit values."""
        alert = Alert(
            id=uuid.uuid4(),
            alert_name="TestAlert",
            raw_payload={"status": "firing"},
            labels={},
            status="firing",
            severity="unknown",
        )
        assert alert.status == "firing"
        assert alert.severity == "unknown"
        assert alert.service_name is None

    def test_alert_uuid_set_explicitly(self) -> None:
        """Alert should store an explicitly provided UUID."""
        alert_id = uuid.uuid4()
        alert = Alert(id=alert_id, alert_name="Test", raw_payload={}, labels={})
        assert alert.id == alert_id
        assert isinstance(alert.id, uuid.UUID)

    def test_alert_with_all_label_fields(self) -> None:
        """Alert should accept all 8 denormalised label fields."""
        alert = Alert(
            alert_name="TestAlert",
            raw_payload={},
            labels={},
            service_name="checkout-service",
            deployment_environment_name="production",
            domain="commerce",
            legal_company="acme",
            sub_domain="checkout",
            system_id="sys-001",
            team="checkout-team",
            version="1.0.0",
        )
        assert alert.service_name == "checkout-service"
        assert alert.deployment_environment_name == "production"
        assert alert.team == "checkout-team"

    def test_alert_repr(self) -> None:
        """Alert repr should include id, alert_name, and status."""
        alert = Alert(alert_name="HighLatency", raw_payload={}, labels={}, status="firing")
        repr_str = repr(alert)
        assert "HighLatency" in repr_str
        assert "firing" in repr_str


class TestRCAModel:
    """Tests for the RCA ORM model."""

    def test_rca_with_explicit_status(self) -> None:
        """RCA should store the provided status value."""
        rca = RCA(id=uuid.uuid4(), alert_name="TestAlert", status="triggered")
        assert rca.status == "triggered"
        assert rca.report_markdown is None
        assert rca.root_cause is None
        assert rca.confidence_level is None

    def test_rca_uuid_set_explicitly(self) -> None:
        """RCA should store an explicitly provided UUID."""
        rca_id = uuid.uuid4()
        rca = RCA(id=rca_id, alert_name="Test", status="triggered")
        assert rca.id == rca_id
        assert isinstance(rca.id, uuid.UUID)

    def test_rca_with_analysis_fields(self) -> None:
        """RCA should accept all analysis output fields."""
        rca = RCA(
            alert_name="HighLatency",
            status="complete",
            root_cause="Memory leak in checkout service",
            confidence_level="high",
            confidence_reasoning="Clear metric correlation with deployment",
            total_steps=8,
            total_tokens=15000,
        )
        assert rca.root_cause == "Memory leak in checkout service"
        assert rca.confidence_level == "high"
        assert rca.total_steps == 8

    def test_rca_repr(self) -> None:
        """RCA repr should include id, alert_name, and status."""
        rca = RCA(alert_name="HighLatency", status="complete")
        repr_str = repr(rca)
        assert "HighLatency" in repr_str
        assert "complete" in repr_str


class TestAgentStepModel:
    """Tests for the AgentStep ORM model."""

    def test_agent_step_creation(self) -> None:
        """AgentStep should accept all required fields."""
        step = AgentStep(
            rca_id=uuid.uuid4(),
            step_number=1,
            node_name="triage",
            action="label_validation",
            input="test input",
            output="test output",
            tokens_used=100,
            duration_seconds=0.5,
        )
        assert step.step_number == 1
        assert step.node_name == "triage"
        assert step.tokens_used == 100

    def test_agent_step_uuid_set_explicitly(self) -> None:
        """AgentStep should store an explicitly provided UUID."""
        step_id = uuid.uuid4()
        step = AgentStep(
            id=step_id,
            rca_id=uuid.uuid4(),
            step_number=1,
            node_name="triage",
            action="test",
        )
        assert step.id == step_id
        assert isinstance(step.id, uuid.UUID)

    def test_agent_step_repr(self) -> None:
        """AgentStep repr should include rca_id, step number, node, and action."""
        rca_id = uuid.uuid4()
        step = AgentStep(
            rca_id=rca_id,
            step_number=3,
            node_name="investigate",
            action="tool:query_prometheus",
        )
        repr_str = repr(step)
        assert "3" in repr_str
        assert "investigate" in repr_str
        assert "query_prometheus" in repr_str

