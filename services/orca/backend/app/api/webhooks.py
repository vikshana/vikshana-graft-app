"""FastAPI route handler for Grafana alert webhooks.

Handles POST /webhook/grafana — validates the payload, persists the alert,
creates an RCA record, and spawns an async background agent task.

Duplicate suppression
---------------------
An alert is considered a duplicate if an existing RCA was opened for an
alert with the **same fingerprint** (SHA-256 of alert_name + sorted labels)
and either:
  - the RCA investigation is still active (status in triggered/investigating), OR
  - the original RCA was created within ``ORCA_DEDUP_WINDOW_MINUTES`` minutes.

In that case the alert is still persisted (for audit purposes) but linked to
the canonical RCA via ``rca_duplicate_alerts``; no new agent task is spawned.
"""

import uuid
from datetime import datetime, timezone

import structlog
from fastapi import APIRouter, BackgroundTasks, Depends, Header, HTTPException, status
from pydantic import ValidationError
from sqlalchemy.ext.asyncio import AsyncSession

from app.agent.dedup import compute_fingerprint, find_canonical_rca, record_duplicate
from app.db import get_session
from app.models.alert import Alert
from app.models.rca import RCA
from app.schemas.webhook import GrafanaWebhookPayload, WebhookResponse

logger = structlog.get_logger()

router = APIRouter()


@router.post(
    "/webhook/grafana",
    response_model=list[WebhookResponse],
    status_code=status.HTTP_202_ACCEPTED,
    summary="Receive Grafana alert webhook",
    description=(
        "Accepts a Grafana unified alerting webhook payload. "
        "Each alert in the payload creates an Alert record and either triggers "
        "a new async LangGraph investigation or is deduplicated into an existing one."
    ),
)
async def receive_grafana_webhook(
    payload: GrafanaWebhookPayload,
    background_tasks: BackgroundTasks,
    session: AsyncSession = Depends(get_session),
    x_grafana_org_id: str | None = Header(None),
) -> list[WebhookResponse]:
    """Receive and process a Grafana alert webhook.

    For each valid firing alert in the payload:
    1. Persist an Alert record (always).
    2. Compute a dedup fingerprint and check for a canonical RCA.
    3a. If a canonical RCA exists: link the alert as a duplicate and return
        the existing rca_id without spawning a new agent task.
    3b. Otherwise: create a new RCA record and spawn a background agent task.

    Args:
        payload: Validated Grafana webhook payload.
        background_tasks: FastAPI background task registry.
        session: Async database session.

    Returns:
        List of WebhookResponse objects, one per alert processed.
    """
    # Resolve org_id: prefer the header injected by the Go proxy (not spoofable),
    # fall back to the grafana_org_id label embedded in the alert payload.
    org_id: int | None = None
    if x_grafana_org_id:
        try:
            org_id = int(x_grafana_org_id)
        except ValueError:
            pass

    log = logger.bind(
        receiver=payload.receiver,
        alert_count=len(payload.alerts),
        org_id=org_id,
    )
    log.info("webhook_received")

    firing_alerts = [a for a in payload.alerts if a.status == "firing"]
    if not firing_alerts:
        log.info("webhook_no_firing_alerts", total=len(payload.alerts))
        return []

    responses: list[WebhookResponse] = []

    for grafana_alert in firing_alerts:
        labels = grafana_alert.labels
        alert_name = labels.get("alertname", "unknown")

        # Per-alert org_id fallback: use grafana_org_id label if header not set
        alert_org_id = org_id
        if alert_org_id is None:
            raw_label_org = labels.get("grafana_org_id", "")
            if raw_label_org:
                try:
                    alert_org_id = int(raw_label_org)
                except ValueError:
                    pass

        # Parse fired_at timestamp
        fired_at: datetime | None = None
        if grafana_alert.startsAt:
            try:
                fired_at = datetime.fromisoformat(
                    grafana_alert.startsAt.replace("Z", "+00:00")
                )
            except ValueError:
                pass

        # Compute dedup fingerprint before persisting
        fingerprint = compute_fingerprint(alert_name, dict(labels))

        # Persist Alert record (always — provides full audit trail)
        alert = Alert(
            id=uuid.uuid4(),
            raw_payload=grafana_alert.model_dump(),
            alert_name=alert_name,
            status=grafana_alert.status,
            severity=labels.get("severity", "unknown"),
            labels=dict(labels),
            dedup_fingerprint=fingerprint,
            service_name=labels.get("service_name"),
            deployment_environment_name=labels.get("deployment_environment_name"),
            domain=labels.get("domain"),
            legal_company=labels.get("legal_company"),
            sub_domain=labels.get("sub_domain"),
            system_id=labels.get("system_id"),
            team=labels.get("team"),
            version=labels.get("version"),
            fired_at=fired_at,
        )
        session.add(alert)
        await session.flush()  # Get alert.id

        alert_id = alert.id

        # --- Deduplication check ---
        canonical_rca = await find_canonical_rca(session, fingerprint)

        if canonical_rca is not None:
            # Suppress — link this alert to the existing RCA
            await record_duplicate(
                session=session,
                canonical_rca_id=canonical_rca.id,
                duplicate_alert_id=alert_id,
            )
            log.info(
                "webhook_alert_deduplicated",
                alert_name=alert_name,
                canonical_rca_id=str(canonical_rca.id),
                fingerprint=fingerprint,
            )
            responses.append(
                WebhookResponse(
                    rca_id=str(canonical_rca.id),
                    alert_id=str(alert_id),
                    status=canonical_rca.status,
                    deduplicated=True,
                )
            )
            continue  # Do NOT spawn a new agent task

        # --- New investigation ---
        rca = RCA(
            id=uuid.uuid4(),
            alert_id=alert_id,
            alert_name=alert_name,
            status="triggered",
            service_name=labels.get("service_name"),
            deployment_environment_name=labels.get("deployment_environment_name"),
            domain=labels.get("domain"),
            legal_company=labels.get("legal_company"),
            sub_domain=labels.get("sub_domain"),
            system_id=labels.get("system_id"),
            team=labels.get("team"),
            version=labels.get("version"),
            started_at=datetime.now(timezone.utc),
        )
        # org_id is a forward-compatible column added via migration (may be None)
        try:
            rca.org_id = alert_org_id  # type: ignore[attr-defined]
        except AttributeError:
            pass  # column not yet present in this schema version

        session.add(rca)
        await session.flush()

        rca_id = rca.id

        log.info(
            "rca_created",
            rca_id=str(rca_id),
            alert_id=str(alert_id),
            alert_name=alert_name,
            service=labels.get("service_name"),
            org_id=alert_org_id,
            fingerprint=fingerprint,
        )

        # Spawn background agent task (passes org_id for MCP header injection)
        background_tasks.add_task(_run_agent_task, rca_id=rca_id, org_id=alert_org_id)

        responses.append(
            WebhookResponse(
                rca_id=str(rca_id),
                alert_id=str(alert_id),
                status="triggered",
                deduplicated=False,
            )
        )

    await session.commit()
    return responses


async def _run_agent_task(rca_id: uuid.UUID, org_id: int | None = None) -> None:
    """Background task that runs the LangGraph agent for a given RCA.

    This function is intentionally decoupled from the request cycle —
    it creates its own DB session and calls the agent graph.

    Args:
        rca_id: UUID of the RCA record to investigate.
        org_id: Grafana organisation ID for MCP tool scoping.
    """
    from app.agent.graph import run_agent  # avoid circular import at module load

    log = logger.bind(rca_id=str(rca_id), org_id=org_id)
    log.info("agent_task_starting")
    try:
        await run_agent(rca_id=rca_id, org_id=org_id)
        log.info("agent_task_complete")
    except Exception as exc:
        log.error("agent_task_failed", error=str(exc), exc_info=True)

