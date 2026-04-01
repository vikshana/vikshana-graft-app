"""Investigate node — ReAct loop using Claude Sonnet with MCP tools."""

import json
import time
import uuid
from pathlib import Path
from typing import Any

import structlog
from langchain_anthropic import ChatAnthropic
from langchain_core.messages import AIMessage, HumanMessage, SystemMessage, ToolMessage
from langchain_mcp_adapters.client import MultiServerMCPClient

from app.agent.mcp.grafana_client import GRAFANA_ALLOWED_TOOLS, get_grafana_mcp_config
from app.agent.mcp.postgres_client import get_postgres_mcp_config
from app.agent.state import OrcaState
from app.config import settings
from app.db import AsyncSessionLocal
from app.models.agent_step import AgentStep

logger = structlog.get_logger()

_PROMPT_PATH = Path(__file__).parent.parent / "prompts" / "investigate.md"
_SYSTEM_PROMPT_TEMPLATE = _PROMPT_PATH.read_text(encoding="utf-8")


async def run_investigate(state: OrcaState) -> OrcaState:
    """Run the investigation ReAct loop using Claude Sonnet with MCP tools.

    Executes a multi-step investigation where the agent decides what to query,
    calls MCP tools (Grafana or Postgres), evaluates results, and repeats until
    it has sufficient evidence or the budget is exhausted.

    Args:
        state: Current agent state with alert context and triage results.

    Returns:
        Updated state with investigation_steps, evidence, and historical context.
    """
    rca_id = state["rca_id"]
    log = logger.bind(rca_id=rca_id, node="investigate")
    log.info("investigation_started")

    max_steps = settings.ORCA_MAX_INVESTIGATION_STEPS
    max_tokens = settings.ORCA_MAX_INVESTIGATION_TOKENS

    labels = state.get("alert_labels", {})
    system_prompt = (
        _SYSTEM_PROMPT_TEMPLATE
        .replace("{max_steps}", str(max_steps))
        .replace("{max_tokens}", str(max_tokens))
    )

    investigation_steps: list[dict[str, Any]] = list(state.get("investigation_steps", []))
    evidence: list[dict[str, Any]] = list(state.get("evidence", []))
    step_count = state.get("step_count", 1)
    total_tokens = state.get("total_tokens_used", 0)
    similar_past_alerts: list[dict[str, Any]] = []
    related_rcas: list[dict[str, Any]] = []

    # Build combined MCP config
    mcp_config = {**get_grafana_mcp_config(), **get_postgres_mcp_config()}

    try:
        # langchain-mcp-adapters 0.1.0: MultiServerMCPClient is no longer an
        # async context manager.  Instantiate directly and await get_tools().
        mcp_client = MultiServerMCPClient(mcp_config)
        all_tools = await mcp_client.get_tools()
        # Filter Grafana tools to allow-list; keep all Postgres tools
        tools = [
            t for t in all_tools
            if t.name in GRAFANA_ALLOWED_TOOLS or "postgres" in t.name.lower() or "query" in t.name.lower()
        ]

        llm = ChatAnthropic(
            model="claude-sonnet-4-5",
            api_key=settings.ANTHROPIC_API_KEY,
            max_tokens=4096,
        ).bind_tools(tools)

        # Initial investigation prompt
        initial_message = HumanMessage(
            content=_build_investigation_prompt(state)
        )
        messages: list[Any] = [SystemMessage(content=system_prompt), initial_message]

        # ReAct loop
        while step_count <= max_steps and total_tokens < max_tokens:
            step_start = time.monotonic()

            response = await llm.ainvoke(messages)
            step_tokens = response.usage_metadata.get("total_tokens", 0) if response.usage_metadata else 0
            total_tokens += step_tokens
            messages.append(response)

            response_text = str(response.content) if response.content else ""

            # Check if investigation is complete (no tool calls)
            if not response.tool_calls:
                log.info(
                    "investigation_complete_agent_decision",
                    step=step_count,
                    tokens=total_tokens,
                )
                # Extract evidence summary from final response
                evidence.append({
                    "type": "analysis",
                    "content": response_text,
                    "step": step_count,
                })
                await _write_step(
                    rca_id=rca_id,
                    step_number=step_count,
                    action="investigation_complete",
                    input_text="Agent decision: sufficient evidence gathered",
                    output_text=response_text,
                    tokens_used=step_tokens,
                    duration=time.monotonic() - step_start,
                )
                step_count += 1
                break

            # Execute tool calls
            for tool_call in response.tool_calls:
                tool_name = tool_call["name"]
                tool_args = tool_call["args"]
                tool_call_id = tool_call["id"]

                log.info(
                    "investigation_tool_call",
                    step=step_count,
                    tool=tool_name,
                    tokens_so_far=total_tokens,
                )

                tool_start = time.monotonic()
                tool_result_text = ""

                # Find and call the tool
                tool_fn = next((t for t in tools if t.name == tool_name), None)
                if tool_fn is not None:
                    try:
                        tool_result = await tool_fn.ainvoke(tool_args)
                        tool_result_text = (
                            tool_result if isinstance(tool_result, str)
                            else json.dumps(tool_result, default=str)
                        )
                    except Exception as tool_exc:
                        tool_result_text = f"Tool error: {tool_exc}"
                        log.warning("tool_call_failed", tool=tool_name, error=str(tool_exc))
                else:
                    tool_result_text = f"Tool {tool_name!r} not available"

                tool_duration = time.monotonic() - tool_start

                # Add tool result to messages
                messages.append(
                    ToolMessage(
                        content=tool_result_text,
                        tool_call_id=tool_call_id,
                    )
                )

                # Record investigation step
                step_record = {
                    "step": step_count,
                    "tool": tool_name,
                    "args": tool_args,
                    "result": tool_result_text[:2000],  # truncate for storage
                }
                investigation_steps.append(step_record)
                evidence.append({
                    "type": "tool_call",
                    "tool": tool_name,
                    "query": json.dumps(tool_args),
                    "result": tool_result_text[:2000],
                    "step": step_count,
                })

                # Extract historical context from Postgres queries
                if "alerts" in tool_result_text.lower() and "service_name" in str(tool_args):
                    _extract_historical_context(
                        tool_result_text, similar_past_alerts, related_rcas
                    )

                await _write_step(
                    rca_id=rca_id,
                    step_number=step_count,
                    action=f"tool:{tool_name}",
                    input_text=json.dumps(tool_args),
                    output_text=tool_result_text[:4000],
                    tokens_used=step_tokens,
                    duration=tool_duration,
                )

                step_count += 1

                if step_count > max_steps or total_tokens >= max_tokens:
                    log.warning(
                        "investigation_budget_exhausted",
                        step=step_count,
                        tokens=total_tokens,
                    )
                    break

    except Exception as exc:
        log.error("investigation_failed", error=str(exc), exc_info=True)
        # Continue to analysis with whatever evidence was gathered
        investigation_steps.append({
            "step": step_count,
            "error": str(exc),
            "type": "mcp_connection_failed",
        })

    log.info(
        "investigation_finished",
        total_steps=step_count,
        total_tokens=total_tokens,
        evidence_count=len(evidence),
    )

    return {
        **state,
        "investigation_steps": investigation_steps,
        "evidence": evidence,
        "step_count": step_count,
        "total_tokens_used": total_tokens,
        "similar_past_alerts": similar_past_alerts,
        "related_rcas": related_rcas,
    }


def _build_investigation_prompt(state: OrcaState) -> str:
    """Build the initial investigation prompt from the alert context.

    Args:
        state: Current agent state.

    Returns:
        Formatted investigation prompt string.
    """
    labels = state.get("alert_labels", {})
    return f"""A Grafana alert has fired. Please investigate the root cause.

## Alert Details
- **Alert Name:** {state.get("alert_name", "unknown")}
- **Severity:** {state.get("severity", "unknown")}
- **Service:** {labels.get("service_name", "unknown")}
- **Environment:** {labels.get("deployment_environment_name", "unknown")}
- **Team:** {labels.get("team", "unknown")}
- **Domain:** {labels.get("domain", "unknown")}
- **Version:** {labels.get("version", "unknown")}

## Alert Payload
```json
{json.dumps(state.get("alert_payload", {}), indent=2, default=str)}
```

Begin your investigation. Start by checking metrics around the alert time, then look at logs, and finally search for similar historical incidents in the Orca database."""


def _extract_historical_context(
    tool_result: str,
    similar_past_alerts: list[dict[str, Any]],
    related_rcas: list[dict[str, Any]],
) -> None:
    """Attempt to parse historical alert/RCA data from a Postgres query result.

    Args:
        tool_result: Raw query result text from the Postgres MCP tool.
        similar_past_alerts: List to append found past alerts to.
        related_rcas: List to append found related RCAs to.
    """
    try:
        data = json.loads(tool_result)
        if isinstance(data, list):
            for row in data[:10]:
                if isinstance(row, dict):
                    if "root_cause" in row:
                        related_rcas.append(row)
                    else:
                        similar_past_alerts.append(row)
    except (json.JSONDecodeError, TypeError):
        pass


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
        input_text: Input sent to the tool.
        output_text: Result received from the tool.
        tokens_used: Token count for this step.
        duration: Wall-clock duration in seconds.
    """
    async with AsyncSessionLocal() as session:
        step = AgentStep(
            id=uuid.uuid4(),
            rca_id=uuid.UUID(rca_id),
            step_number=step_number,
            node_name="investigate",
            action=action,
            input=input_text[:4000],
            output=output_text[:8000],
            tokens_used=tokens_used,
            duration_seconds=round(duration, 3),
        )
        session.add(step)
        await session.commit()

