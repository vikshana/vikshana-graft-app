"""Analyze node — synthesises gathered evidence into root cause analysis."""

import json
import time
import uuid
from pathlib import Path
from typing import Any

import structlog
from langchain_anthropic import ChatAnthropic
from langchain_core.messages import HumanMessage, SystemMessage

from app.agent.state import OrcaState
from app.config import settings
from app.db import AsyncSessionLocal
from app.models.agent_step import AgentStep

logger = structlog.get_logger()

_PROMPT_PATH = Path(__file__).parent.parent / "prompts" / "analyze.md"
_SYSTEM_PROMPT = _PROMPT_PATH.read_text(encoding="utf-8")


async def run_analyze(state: OrcaState) -> OrcaState:
    """Synthesise investigation evidence into root cause analysis using Claude Sonnet.

    Takes all evidence gathered during investigation and uses Claude Sonnet to
    identify the root cause, contributing factors, timeline, and confidence level.

    Args:
        state: Current agent state with evidence from the investigate node.

    Returns:
        Updated state with root_cause, contributing_factors, timeline,
        impact_summary, confidence_level, and confidence_reasoning.
    """
    rca_id = state["rca_id"]
    log = logger.bind(rca_id=rca_id, node="analyze")
    log.info("analysis_started", evidence_count=len(state.get("evidence", [])))

    start_time = time.monotonic()
    step_number = state.get("step_count", 1)

    llm = ChatAnthropic(
        model="claude-sonnet-4-5",
        api_key=settings.ANTHROPIC_API_KEY,
        max_tokens=4096,
    )

    analysis_prompt = _build_analysis_prompt(state)

    messages = [
        SystemMessage(content=_SYSTEM_PROMPT),
        HumanMessage(content=analysis_prompt),
    ]

    try:
        response = await llm.ainvoke(messages)
        response_text = str(response.content)
        tokens_used = response.usage_metadata.get("total_tokens", 0) if response.usage_metadata else 0

        analysis = _parse_analysis_response(response_text)

        log.info(
            "analysis_complete",
            confidence=analysis.get("confidence_level", "unknown"),
            root_cause_preview=analysis.get("root_cause", "")[:100],
        )

        await _write_step(
            rca_id=rca_id,
            step_number=step_number,
            action="root_cause_analysis",
            input_text=analysis_prompt[:4000],
            output_text=response_text[:8000],
            tokens_used=tokens_used,
            duration=time.monotonic() - start_time,
        )

        return {
            **state,
            "root_cause": analysis.get("root_cause", "Root cause could not be determined"),
            "contributing_factors": analysis.get("contributing_factors", []),
            "timeline": analysis.get("timeline", []),
            "impact_summary": analysis.get("impact_summary", "Impact unknown"),
            "confidence_level": analysis.get("confidence_level", "low"),
            "confidence_reasoning": analysis.get("confidence_reasoning", ""),
            "total_tokens_used": state.get("total_tokens_used", 0) + tokens_used,
            "step_count": step_number + 1,
        }

    except Exception as exc:
        log.error("analysis_failed", error=str(exc), exc_info=True)

        await _write_step(
            rca_id=rca_id,
            step_number=step_number,
            action="root_cause_analysis_failed",
            input_text=analysis_prompt[:4000],
            output_text=f"Analysis failed: {exc}",
            tokens_used=0,
            duration=time.monotonic() - start_time,
        )

        return {
            **state,
            "root_cause": f"Analysis failed due to error: {exc}",
            "contributing_factors": [],
            "timeline": [],
            "impact_summary": "Impact could not be determined",
            "confidence_level": "low",
            "confidence_reasoning": f"Analysis node encountered an error: {exc}",
            "step_count": step_number + 1,
        }


def _build_analysis_prompt(state: OrcaState) -> str:
    """Build the analysis prompt from the investigation evidence.

    Args:
        state: Current agent state.

    Returns:
        Formatted analysis prompt string.
    """
    labels = state.get("alert_labels", {})
    evidence = state.get("evidence", [])
    similar_alerts = state.get("similar_past_alerts", [])
    related_rcas = state.get("related_rcas", [])

    evidence_text = "\n\n".join(
        f"**Step {e.get('step', '?')} — {e.get('tool', e.get('type', 'unknown'))}**\n"
        f"Query: {e.get('query', e.get('content', ''))[:500]}\n"
        f"Result: {e.get('result', e.get('content', ''))[:1000]}"
        for e in evidence
    )

    history_text = ""
    if similar_alerts:
        history_text += f"\n\n## Similar Past Alerts ({len(similar_alerts)} found)\n"
        history_text += json.dumps(similar_alerts[:5], indent=2, default=str)

    if related_rcas:
        history_text += f"\n\n## Related Past RCAs ({len(related_rcas)} found)\n"
        history_text += json.dumps(related_rcas[:3], indent=2, default=str)

    return f"""## Alert Context

- **Alert Name:** {state.get("alert_name", "unknown")}
- **Severity:** {state.get("severity", "unknown")}
- **Service:** {labels.get("service_name", "unknown")}
- **Environment:** {labels.get("deployment_environment_name", "unknown")}
- **Team:** {labels.get("team", "unknown")}
- **Version:** {labels.get("version", "unknown")}

## Investigation Evidence ({len(evidence)} items, {state.get("step_count", 0)} steps)

{evidence_text if evidence_text else "No evidence gathered — MCP tools may have been unavailable."}
{history_text}

## Instructions

Analyse the evidence above and provide your structured root cause analysis as a JSON object.
If evidence is limited, assign a lower confidence level and acknowledge data gaps."""


def _parse_analysis_response(response_text: str) -> dict[str, Any]:
    """Parse the JSON analysis response from the LLM.

    Args:
        response_text: Raw LLM response text.

    Returns:
        Parsed analysis dict with root_cause, contributing_factors, etc.
    """
    text = response_text.strip()

    # Strip markdown code blocks if present
    if "```json" in text:
        text = text.split("```json")[1].split("```")[0].strip()
    elif "```" in text:
        text = text.split("```")[1].split("```")[0].strip()

    try:
        parsed = json.loads(text)
        return dict(parsed) if isinstance(parsed, dict) else {}
    except json.JSONDecodeError:
        # Return a degraded result with the raw text as root_cause
        return {
            "root_cause": response_text[:1000],
            "contributing_factors": [],
            "timeline": [],
            "impact_summary": "Could not parse structured analysis",
            "confidence_level": "low",
            "confidence_reasoning": "Analysis output could not be parsed as JSON",
        }


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
        input_text: Input sent to the LLM.
        output_text: Output received from the LLM.
        tokens_used: Token count for this step.
        duration: Wall-clock duration in seconds.
    """
    async with AsyncSessionLocal() as session:
        step = AgentStep(
            id=uuid.uuid4(),
            rca_id=uuid.UUID(rca_id),
            step_number=step_number,
            node_name="analyze",
            action=action,
            input=input_text,
            output=output_text,
            tokens_used=tokens_used,
            duration_seconds=round(duration, 3),
        )
        session.add(step)
        await session.commit()

