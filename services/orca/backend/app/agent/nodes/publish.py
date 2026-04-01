"""Publish node — persists the completed RCA and sends Slack notification."""

import time
import uuid
from datetime import datetime, timezone

import structlog

from app.agent.state import OrcaState
from app.config import settings
from app.db import AsyncSessionLocal
from app.integrations.slack import send_slack_notification
from app.models.agent_step import AgentStep
from app.models.rca import RCA

logger = structlog.get_logger()


async def run_publish(state: OrcaState) -> OrcaState:
    """Persist the completed RCA report and send a Slack notification.

    No LLM calls — this node is purely deterministic. Writes the final
    report, root cause, and metadata to the RCA database record, then
    posts a summary to Slack.

    Args:
        state: Current agent state with report_markdown and analysis complete.

    Returns:
        Updated state with status=complete (or failed on error).
    """
    rca_id = state["rca_id"]
    log = logger.bind(rca_id=rca_id, node="publish")
    log.info("publish_started")

    start_time = time.monotonic()
    step_number = state.get("step_count", 1)
    completed_at = datetime.now(timezone.utc)

    try:
        async with AsyncSessionLocal() as session:
            # Load the RCA record
            rca = await session.get(RCA, uuid.UUID(rca_id))
            if rca is None:
                log.error("publish_rca_not_found")
                return {**state, "status": "failed", "error_message": f"RCA {rca_id} not found"}

            # Calculate duration
            duration_seconds: float | None = None
            if rca.started_at:
                duration_seconds = (completed_at - rca.started_at).total_seconds()

            # Update RCA record with final results
            rca.status = "complete"
            rca.report_markdown = state.get("report_markdown")
            rca.root_cause = state.get("root_cause")
            rca.confidence_level = state.get("confidence_level")
            rca.confidence_reasoning = state.get("confidence_reasoning")
            rca.total_steps = state.get("step_count", 0)
            rca.total_tokens = state.get("total_tokens_used", 0)
            rca.duration_seconds = duration_seconds
            rca.completed_at = completed_at

            # Write publish AgentStep
            step = AgentStep(
                id=uuid.uuid4(),
                rca_id=uuid.UUID(rca_id),
                step_number=step_number,
                node_name="publish",
                action="persist_rca",
                input=f"Saving RCA with {rca.total_steps} steps, {rca.total_tokens} tokens",
                output=f"RCA saved. Status=complete. Duration={duration_seconds:.1f}s"
                if duration_seconds
                else "RCA saved. Status=complete.",
                tokens_used=0,
                duration_seconds=round(time.monotonic() - start_time, 3),
            )
            session.add(step)
            await session.commit()

            log.info(
                "rca_persisted",
                status="complete",
                confidence=rca.confidence_level,
                steps=rca.total_steps,
                tokens=rca.total_tokens,
                duration_seconds=duration_seconds,
            )

        # Send Slack notification (non-fatal if it fails)
        await _notify_slack(state, rca_id)

        return {
            **state,
            "status": "complete",
            "step_count": step_number + 1,
        }

    except Exception as exc:
        log.error("publish_failed", error=str(exc), exc_info=True)

        # Try to mark the RCA as failed in the database
        try:
            async with AsyncSessionLocal() as session:
                rca = await session.get(RCA, uuid.UUID(rca_id))
                if rca is not None:
                    rca.status = "failed"
                    rca.error_message = str(exc)
                    rca.completed_at = completed_at
                    await session.commit()
        except Exception as db_exc:
            log.error("publish_failed_db_update_failed", error=str(db_exc))

        return {
            **state,
            "status": "failed",
            "error_message": str(exc),
        }


async def _notify_slack(state: OrcaState, rca_id: str) -> None:
    """Send a Slack notification for the completed RCA.

    Non-fatal — logs a warning if the notification fails.

    Args:
        state: Current agent state.
        rca_id: UUID string of the RCA.
    """
    if not settings.SLACK_WEBHOOK_URL:
        return

    labels = state.get("alert_labels", {})
    log = logger.bind(rca_id=rca_id)

    try:
        await send_slack_notification(
            rca_id=rca_id,
            alert_name=state.get("alert_name", "unknown"),
            service_name=labels.get("service_name", "unknown"),
            environment=labels.get("deployment_environment_name", "unknown"),
            severity=state.get("severity", "unknown"),
            confidence_level=state.get("confidence_level", "low"),
            root_cause=state.get("root_cause", "Could not be determined"),
            frontend_url=settings.FRONTEND_URL,
        )
        log.info("slack_notification_sent")
    except Exception as exc:
        log.warning("slack_notification_failed", error=str(exc))

