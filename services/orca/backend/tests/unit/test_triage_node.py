"""Unit tests for the triage node."""

import uuid
from typing import Any
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from app.agent.nodes.triage import run_triage, REQUIRED_LABELS, _parse_triage_response
from app.agent.state import OrcaState


VALID_LABELS: dict[str, str] = {
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


def make_state(labels: dict[str, str] | None = None, **kwargs: Any) -> OrcaState:
    """Create a test OrcaState with the given labels."""
    return OrcaState(
        rca_id=str(uuid.uuid4()),
        alert_payload={"status": "firing", "labels": labels or VALID_LABELS, "annotations": {}},
        alert_labels=labels if labels is not None else VALID_LABELS,
        alert_name="HighLatency",
        severity="unknown",
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
        **kwargs,
    )


class TestTriageNode:
    """Tests for the triage node."""

    @pytest.mark.asyncio
    async def test_missing_labels_sets_failed_status(self) -> None:
        """Triage should set status=failed when required labels are missing."""
        incomplete_labels = {"alertname": "Test", "service_name": "checkout"}
        state = make_state(labels=incomplete_labels)

        with patch("app.agent.nodes.triage._write_step", new=AsyncMock()):
            result = await run_triage(state)

        assert result["status"] == "failed"
        assert result["error_message"] is not None
        assert "Missing required labels" in result["error_message"]

    @pytest.mark.asyncio
    async def test_missing_labels_error_lists_missing_keys(self) -> None:
        """Error message should name the missing labels."""
        labels = {k: v for k, v in VALID_LABELS.items() if k not in ("team", "domain")}
        state = make_state(labels=labels)

        with patch("app.agent.nodes.triage._write_step", new=AsyncMock()):
            result = await run_triage(state)

        assert result["status"] == "failed"
        assert "team" in result["error_message"]
        assert "domain" in result["error_message"]

    @pytest.mark.asyncio
    async def test_valid_labels_calls_llm_and_sets_investigating(self) -> None:
        """Valid labels should trigger LLM call and set status=investigating."""
        state = make_state()

        mock_response = MagicMock()
        mock_response.content = '{"severity": "critical", "valid": true, "reasoning": "Production service", "missing_labels": []}'
        mock_response.usage_metadata = {"total_tokens": 150}

        with (
            patch("app.agent.nodes.triage.ChatAnthropic") as mock_llm_class,
            patch("app.agent.nodes.triage._write_step", new=AsyncMock()),
        ):
            mock_llm = AsyncMock()
            mock_llm.ainvoke = AsyncMock(return_value=mock_response)
            mock_llm_class.return_value = mock_llm

            result = await run_triage(state)

        assert result["status"] == "investigating"
        assert result["severity"] == "critical"

    @pytest.mark.asyncio
    async def test_llm_failure_uses_label_severity_fallback(self) -> None:
        """When the LLM fails, triage should fall back to the severity label."""
        state = make_state()

        with (
            patch("app.agent.nodes.triage.ChatAnthropic") as mock_llm_class,
            patch("app.agent.nodes.triage._write_step", new=AsyncMock()),
        ):
            mock_llm = AsyncMock()
            mock_llm.ainvoke = AsyncMock(side_effect=Exception("API unavailable"))
            mock_llm_class.return_value = mock_llm

            result = await run_triage(state)

        # Should not fail — should fall back to label severity
        assert result["status"] == "investigating"
        assert result["severity"] == "critical"  # from VALID_LABELS["severity"]

    @pytest.mark.asyncio
    async def test_tokens_accumulated_in_state(self) -> None:
        """Token usage should be accumulated in the state."""
        state = make_state()
        state["total_tokens_used"] = 500  # Pre-existing tokens

        mock_response = MagicMock()
        mock_response.content = '{"severity": "warning", "valid": true, "reasoning": "ok", "missing_labels": []}'
        mock_response.usage_metadata = {"total_tokens": 200}

        with (
            patch("app.agent.nodes.triage.ChatAnthropic") as mock_llm_class,
            patch("app.agent.nodes.triage._write_step", new=AsyncMock()),
        ):
            mock_llm = AsyncMock()
            mock_llm.ainvoke = AsyncMock(return_value=mock_response)
            mock_llm_class.return_value = mock_llm

            result = await run_triage(state)

        assert result["total_tokens_used"] == 700  # 500 + 200


class TestParseTriageResponse:
    """Tests for the _parse_triage_response helper function."""

    def test_parses_clean_json(self) -> None:
        """Should parse a clean JSON response."""
        response = '{"severity": "critical", "valid": true, "reasoning": "test"}'
        result = _parse_triage_response(response)
        assert result["severity"] == "critical"

    def test_parses_json_in_markdown_code_block(self) -> None:
        """Should extract JSON from a markdown ```json code block."""
        response = '```json\n{"severity": "warning", "valid": true}\n```'
        result = _parse_triage_response(response)
        assert result["severity"] == "warning"

    def test_extracts_severity_from_free_text_critical(self) -> None:
        """Should extract 'critical' from free-form text response."""
        result = _parse_triage_response("This is a critical production alert")
        assert result["severity"] == "critical"

    def test_extracts_severity_from_free_text_warning(self) -> None:
        """Should extract 'warning' from free-form text response."""
        result = _parse_triage_response("This appears to be a warning level issue")
        assert result["severity"] == "warning"

    def test_returns_unknown_for_unrecognised_text(self) -> None:
        """Should return 'unknown' when severity cannot be determined."""
        result = _parse_triage_response("Some completely unrelated text")
        assert result["severity"] == "unknown"

