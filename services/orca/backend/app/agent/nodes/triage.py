"""Triage node — validates alert labels and classifies severity using Claude Haiku."""

import json
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import structlog
from langchain_anthropic import ChatAnthropic
from langchain_core.messages import HumanMessage, SystemMessage
from sqlalchemy import select

from app.agent.state import OrcaState
from app.config import settings
from app.db import AsyncSessionLocal
from app.models.agent_step import AgentStep
from app.models.rca import RCA

logger = structlog.get_logger()

_PROMPT_PATH = Path(__file__).parent.parent / "prompts" / "triage.md"
_SYSTEM_PROMPT = _PROMPT_PATH.read_text(encoding="utf-8")

# Required label keys for all alerts
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


async def run_triage(state: OrcaState) -> OrcaState:
    """Validate alert labels and classify severity using Claude Haiku.

    Checks that all required labels are present, classifies the alert severity,
    and writes a triage AgentStep to the database. On failure, sets status=failed.

    Args:
        state: Current agent state with alert_payload and alert_labels populated.

    Returns:
        Updated state with severity set and status=investigating (or failed).
    """
    rca_id = state["rca_id"]
    log = logger.bind(rca_id=rca_id, node="triage")
    log.info("triage_started")

    start_time = time.monotonic()

    # --- Check for missing required labels ---
    labels = state.get("alert_labels", {})
    missing = [key for key in REQUIRED_LABELS if key not in labels or not labels[key]]

    if missing:
        log.warning("triage_missing_labels", missing=missing)
        error_msg = f"Missing required labels: {', '.join(missing)}"

        await _write_step(
            rca_id=rca_id,
            step_number=1,
            action="label_validation",
            input_text=json.dumps(labels),
            output_text=error_msg,
            tokens_used=0,
            duration=time.monotonic() - start_time,
        )

        return {
            **state,
            "status": "failed",
            "error_message": error_msg,
            "severity": "unknown",
        }

    # --- Use Claude Haiku to classify severity ---
    llm = ChatAnthropic(
        model="claude-haiku-4-5",
        api_key=settings.ANTHROPIC_API_KEY,
        max_tokens=512,
    )

    alert_context = json.dumps(
        {
            "alert_name": state.get("alert_name", ""),
            "labels": labels,
            "annotations": state.get("alert_payload", {}).get("annotations", {}),
            "status": state.get("alert_payload", {}).get("status", "firing"),
        },
        indent=2,
    )

    messages = [
        SystemMessage(content=_SYSTEM_PROMPT),
        HumanMessage(content=f"Classify this alert:\n\n```json\n{alert_context}\n```"),
    ]

    try:
        response = await llm.ainvoke(messages)
        response_text = str(response.content)
        tokens_used = response.usage_metadata.get("total_tokens", 0) if response.usage_metadata else 0

        # Parse JSON response
        triage_result = _parse_triage_response(response_text)
        severity = triage_result.get("severity", "unknown")
        reasoning = triage_result.get("reasoning", "")

        log.info("triage_complete", severity=severity, reasoning=reasoning[:100])

        await _write_step(
            rca_id=rca_id,
            step_number=1,
            action="severity_classification",
            input_text=alert_context,
            output_text=response_text,
            tokens_used=tokens_used,
            duration=time.monotonic() - start_time,
        )

        return {
            **state,
            "severity": severity,
            "status": "investigating",
            "total_tokens_used": state.get("total_tokens_used", 0) + tokens_used,
            "step_count": state.get("step_count", 0) + 1,
        }

    except Exception as exc:
        log.error("triage_llm_failed", error=str(exc))
        # Fallback: use label-based severity if LLM fails
        severity = labels.get("severity", "unknown")

        await _write_step(
            rca_id=rca_id,
            step_number=1,
            action="severity_classification_fallback",
            input_text=alert_context,
            output_text=f"LLM failed: {exc}. Using label severity: {severity}",
            tokens_used=0,
            duration=time.monotonic() - start_time,
        )

        return {
            **state,
            "severity": severity,
            "status": "investigating",
        }


def _parse_triage_response(response_text: str) -> dict[str, Any]:
    """Parse the JSON response from the triage LLM call.

    Attempts to extract JSON from the response, handling markdown code blocks.

    Args:
        response_text: Raw LLM response text.

    Returns:
        Parsed triage result dict with 'severity', 'valid', and 'reasoning' keys.
    """
    # Strip markdown code blocks if present
    text = response_text.strip()
    if "```json" in text:
        text = text.split("```json")[1].split("```")[0].strip()
    elif "```" in text:
        text = text.split("```")[1].split("```")[0].strip()

    try:
        return dict(json.loads(text))
    except json.JSONDecodeError:
        # If parsing fails, try to extract severity from free text
        text_lower = text.lower()
        if "critical" in text_lower:
            return {"severity": "critical", "reasoning": text}
        elif "warning" in text_lower:
            return {"severity": "warning", "reasoning": text}
        return {"severity": "unknown", "reasoning": text}


async def _write_step(
    rca_id: str,
    step_number: int,
    action: str,
    input_text: str,
    output_text: str,
    tokens_used: int,
    duration: float,
) -> None:
    """Persist an AgentStep record to the database.

    Args:
        rca_id: UUID string of the parent RCA.
        step_number: Sequential step number.
        action: Description of the action taken.
        input_text: Input sent to the tool/LLM.
        output_text: Output received from the tool/LLM.
        tokens_used: Token count for this step.
        duration: Wall-clock duration in seconds.
    """
    async with AsyncSessionLocal() as session:
        step = AgentStep(
            id=uuid.uuid4(),
            rca_id=uuid.UUID(rca_id),
            step_number=step_number,
            node_name="triage",
            action=action,
            input=input_text,
            output=output_text,
            tokens_used=tokens_used,
            duration_seconds=round(duration, 3),
        )
        session.add(step)
        await session.commit()

