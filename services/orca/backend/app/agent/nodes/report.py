"""Report node — generates the structured 11-section RCA markdown report."""

import json
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path

import structlog
from langchain_anthropic import ChatAnthropic
from langchain_core.messages import HumanMessage, SystemMessage

from app.agent.state import OrcaState
from app.config import settings
from app.db import AsyncSessionLocal
from app.models.agent_step import AgentStep

logger = structlog.get_logger()

_PROMPT_PATH = Path(__file__).parent.parent / "prompts" / "report.md"
_SYSTEM_PROMPT = _PROMPT_PATH.read_text(encoding="utf-8")


async def run_report(state: OrcaState) -> OrcaState:
    """Generate the full 11-section RCA markdown report using Claude Sonnet.

    Takes the completed analysis and formats it into the standard Orca RCA
    report template with all 11 required sections.

    Args:
        state: Current agent state with root cause analysis complete.

    Returns:
        Updated state with report_markdown populated.
    """
    rca_id = state["rca_id"]
    log = logger.bind(rca_id=rca_id, node="report")
    log.info("report_generation_started")

    start_time = time.monotonic()
    step_number = state.get("step_count", 1)

    llm = ChatAnthropic(
        model="claude-sonnet-4-5",
        api_key=settings.ANTHROPIC_API_KEY,
        max_tokens=8192,
    )

    report_prompt = _build_report_prompt(state)

    messages = [
        SystemMessage(content=_SYSTEM_PROMPT),
        HumanMessage(content=report_prompt),
    ]

    try:
        response = await llm.ainvoke(messages)
        report_markdown = str(response.content)
        tokens_used = response.usage_metadata.get("total_tokens", 0) if response.usage_metadata else 0

        log.info(
            "report_generated",
            length=len(report_markdown),
            tokens=tokens_used,
        )

        await _write_step(
            rca_id=rca_id,
            step_number=step_number,
            action="report_generation",
            input_text=report_prompt[:4000],
            output_text=report_markdown[:8000],
            tokens_used=tokens_used,
            duration=time.monotonic() - start_time,
        )

        return {
            **state,
            "report_markdown": report_markdown,
            "total_tokens_used": state.get("total_tokens_used", 0) + tokens_used,
            "step_count": step_number + 1,
        }

    except Exception as exc:
        log.error("report_generation_failed", error=str(exc), exc_info=True)

        # Generate a minimal fallback report
        fallback_report = _generate_fallback_report(state)

        await _write_step(
            rca_id=rca_id,
            step_number=step_number,
            action="report_generation_failed",
            input_text=report_prompt[:4000],
            output_text=f"Report generation failed: {exc}. Using fallback.",
            tokens_used=0,
            duration=time.monotonic() - start_time,
        )

        return {
            **state,
            "report_markdown": fallback_report,
            "step_count": step_number + 1,
        }


def _build_report_prompt(state: OrcaState) -> str:
    """Build the report generation prompt from the analysis results.

    Args:
        state: Current agent state with analysis complete.

    Returns:
        Formatted report prompt string.
    """
    labels = state.get("alert_labels", {})
    timeline_text = json.dumps(state.get("timeline", []), indent=2, default=str)
    factors_text = "\n".join(f"- {f}" for f in state.get("contributing_factors", []))
    related_rcas = state.get("related_rcas", [])

    return f"""Generate the full RCA report for the following incident.

## Metadata
- **RCA ID:** {state.get("rca_id", "")}
- **Alert Name:** {state.get("alert_name", "unknown")}
- **Severity:** {state.get("severity", "unknown")}
- **Service:** {labels.get("service_name", "unknown")}
- **Environment:** {labels.get("deployment_environment_name", "unknown")}
- **Team:** {labels.get("team", "unknown")}
- **Domain:** {labels.get("domain", "unknown")}
- **Sub-Domain:** {labels.get("sub_domain", "unknown")}
- **System ID:** {labels.get("system_id", "unknown")}
- **Version:** {labels.get("version", "unknown")}
- **Alert Fired At:** {state.get("alert_payload", {}).get("startsAt", "unknown")}
- **Started At:** {datetime.now(timezone.utc).isoformat()}

## Root Cause
{state.get("root_cause", "Could not be determined")}

## Contributing Factors
{factors_text if factors_text else "None identified"}

## Impact
{state.get("impact_summary", "Impact not determined")}

## Timeline
```json
{timeline_text}
```

## Confidence Assessment
- **Level:** {state.get("confidence_level", "low").upper()}
- **Reasoning:** {state.get("confidence_reasoning", "")}

## Evidence Gathered
{_format_evidence(state.get("evidence", []))}

## Related Past RCAs
{json.dumps(related_rcas[:3], indent=2, default=str) if related_rcas else "None found"}

---

Please generate the complete 11-section markdown RCA report following the template in the system prompt exactly."""


def _format_evidence(evidence: list[dict]) -> str:
    """Format evidence items for the report prompt.

    Args:
        evidence: List of evidence dictionaries.

    Returns:
        Formatted evidence text string.
    """
    if not evidence:
        return "No evidence gathered"

    parts = []
    for item in evidence[:20]:  # Limit to avoid prompt overflow
        if item.get("type") == "tool_call":
            parts.append(
                f"- **{item.get('tool', 'unknown')}**: `{str(item.get('query', ''))[:200]}` "
                f"→ {str(item.get('result', ''))[:300]}"
            )
        else:
            parts.append(f"- {str(item.get('content', ''))[:300]}")
    return "\n".join(parts)


def _generate_fallback_report(state: OrcaState) -> str:
    """Generate a minimal fallback report when the LLM call fails.

    Args:
        state: Current agent state.

    Returns:
        Minimal markdown report string.
    """
    labels = state.get("alert_labels", {})
    return f"""# RCA: {state.get("alert_name", "Unknown Alert")}

**⚠️ Note: This report was generated using fallback mode due to a report generation error.**

## 1. Summary

Alert **{state.get("alert_name", "unknown")}** fired for service **{labels.get("service_name", "unknown")}** in **{labels.get("deployment_environment_name", "unknown")}** environment.

## 2. Confidence Level

**{state.get("confidence_level", "low").upper()}**

{state.get("confidence_reasoning", "No confidence reasoning available.")}

## 3. Alert Details

- **Alert Name:** {state.get("alert_name", "unknown")}
- **Severity:** {state.get("severity", "unknown")}
- **Service:** {labels.get("service_name", "unknown")}
- **Environment:** {labels.get("deployment_environment_name", "unknown")}
- **Team:** {labels.get("team", "unknown")}

## 6. Root Cause

{state.get("root_cause", "Root cause could not be determined.")}

## 7. Contributing Factors

{chr(10).join(f"- {f}" for f in state.get("contributing_factors", [])) or "None identified."}

## 10. Actions

- [ ] P1: Manually review investigation evidence and complete this report
"""


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
            node_name="report",
            action=action,
            input=input_text,
            output=output_text,
            tokens_used=tokens_used,
            duration_seconds=round(duration, 3),
        )
        session.add(step)
        await session.commit()

