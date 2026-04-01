"""LangGraph StateGraph definition for the Orca RCA agent.

Defines the five-node graph: triage → investigate → analyze → report → publish,
with a conditional edge from triage that routes invalid alerts to END.
"""

import asyncio
import uuid
from datetime import datetime, timezone
from typing import Literal

import structlog
from langgraph.graph import END, StateGraph

from app.agent.nodes.analyze import run_analyze
from app.agent.nodes.investigate import run_investigate
from app.agent.nodes.publish import run_publish
from app.agent.nodes.report import run_report
from app.agent.nodes.triage import run_triage
from app.agent.state import OrcaState
from app.config import settings
from app.db import AsyncSessionLocal
from app.models.rca import RCA

logger = structlog.get_logger()


def _route_after_triage(state: OrcaState) -> Literal["investigate", "__end__"]:
    """Conditional edge: route to investigate or end based on triage result.

    Args:
        state: Current agent state after the triage node has run.

    Returns:
        "investigate" if triage succeeded, "__end__" if labels were invalid.
    """
    if state.get("status") == "failed":
        return END  # type: ignore[return-value]
    return "investigate"


def build_graph() -> StateGraph:
    """Construct and compile the Orca LangGraph StateGraph.

    Returns:
        Compiled StateGraph ready for invocation.
    """
    graph = StateGraph(OrcaState)

    # Add nodes
    graph.add_node("triage", run_triage)
    graph.add_node("investigate", run_investigate)
    graph.add_node("analyze", run_analyze)
    graph.add_node("report", run_report)
    graph.add_node("publish", run_publish)

    # Set entry point
    graph.set_entry_point("triage")

    # Conditional edge from triage
    graph.add_conditional_edges(
        "triage",
        _route_after_triage,
        {
            "investigate": "investigate",
            END: END,
        },
    )

    # Linear edges for the rest of the pipeline
    graph.add_edge("investigate", "analyze")
    graph.add_edge("analyze", "report")
    graph.add_edge("report", "publish")
    graph.add_edge("publish", END)

    return graph.compile()


# Module-level compiled graph (built once at import time)
_graph = build_graph()


async def run_agent(rca_id: uuid.UUID, org_id: int | None = None) -> None:
    """Run the full Orca agent for a given RCA record.

    Loads the alert payload from the database, builds the initial agent state,
    and invokes the graph. Handles timeout and unexpected errors by marking
    the RCA as failed.

    Args:
        rca_id: UUID of the RCA record to investigate.
        org_id: Grafana organisation ID for MCP tool scoping (injected by webhook).
    """
    log = logger.bind(rca_id=str(rca_id), org_id=org_id)
    log.info("agent_starting")

    # Load initial state from the database
    initial_state = await _load_initial_state(rca_id)
    if initial_state is None:
        log.error("agent_rca_not_found")
        return

    # Mark RCA as investigating
    await _update_rca_status(rca_id, "investigating")

    try:
        await asyncio.wait_for(
            _graph.ainvoke(
                initial_state,
                config={"recursion_limit": 25},
            ),
            timeout=float(settings.ORCA_AGENT_TIMEOUT_SECONDS),
        )
        log.info("agent_completed")

    except asyncio.TimeoutError:
        log.error(
            "agent_timeout",
            timeout_seconds=settings.ORCA_AGENT_TIMEOUT_SECONDS,
        )
        await _mark_rca_failed(
            rca_id,
            f"Agent timed out after {settings.ORCA_AGENT_TIMEOUT_SECONDS}s",
        )

    except Exception as exc:
        log.error("agent_unexpected_error", error=str(exc), exc_info=True)
        await _mark_rca_failed(rca_id, str(exc))


async def _load_initial_state(rca_id: uuid.UUID) -> OrcaState | None:
    """Load the initial agent state from the RCA and Alert records.

    Args:
        rca_id: UUID of the RCA record.

    Returns:
        Populated OrcaState ready for graph invocation, or None if not found.
    """
    async with AsyncSessionLocal() as session:
        rca = await session.get(RCA, rca_id)
        if rca is None:
            return None

        # Load the associated alert
        alert_payload: dict = {}
        alert_labels: dict[str, str] = {}
        alert_name = rca.alert_name

        if rca.alert_id:
            from app.models.alert import Alert

            alert = await session.get(Alert, rca.alert_id)
            if alert is not None:
                alert_payload = dict(alert.raw_payload) if alert.raw_payload else {}
                alert_labels = {k: str(v) for k, v in (alert.labels or {}).items()}
                alert_name = alert.alert_name

        return OrcaState(
            rca_id=str(rca_id),
            alert_payload=alert_payload,
            alert_labels=alert_labels,
            alert_name=alert_name,
            severity=alert_payload.get("labels", {}).get("severity", "unknown"),
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
        )


async def _update_rca_status(rca_id: uuid.UUID, status: str) -> None:
    """Update the RCA status in the database.

    Args:
        rca_id: UUID of the RCA record.
        status: New status string.
    """
    async with AsyncSessionLocal() as session:
        rca = await session.get(RCA, rca_id)
        if rca is not None:
            rca.status = status
            await session.commit()


async def _mark_rca_failed(rca_id: uuid.UUID, error_message: str) -> None:
    """Mark an RCA as failed in the database.

    Args:
        rca_id: UUID of the RCA record.
        error_message: Description of the failure.
    """
    async with AsyncSessionLocal() as session:
        rca = await session.get(RCA, rca_id)
        if rca is not None:
            rca.status = "failed"
            rca.error_message = error_message
            rca.completed_at = datetime.now(timezone.utc)
            await session.commit()

