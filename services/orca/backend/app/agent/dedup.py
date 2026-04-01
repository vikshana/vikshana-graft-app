"""Deduplication utilities for Orca alert processing.

Provides fingerprint computation and the canonical duplicate-check query
used by the webhook handler.
"""

import hashlib
import json
import uuid
from datetime import datetime, timedelta, timezone

import structlog
from sqlalchemy import and_, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import settings
from app.models.alert import Alert
from app.models.rca import RCA
from app.models.rca_duplicate_alert import RCADuplicateAlert

logger = structlog.get_logger()

# RCA statuses that mean an investigation is still active
_ACTIVE_STATUSES: frozenset[str] = frozenset({"triggered", "investigating"})


def compute_fingerprint(alert_name: str, labels: dict[str, str]) -> str:
    """Compute a stable SHA-256 fingerprint for an alert.

    The fingerprint is derived from the alert name and the full label set
    (keys sorted for stability). It is stored on the ``Alert`` row so that
    deduplication queries become a fast indexed equality check.

    Args:
        alert_name: The ``alertname`` label value.
        labels: Complete label dict from the Grafana alert.

    Returns:
        64-character lowercase hex SHA-256 digest.
    """
    # Sort labels by key for a stable representation regardless of insertion order
    payload = json.dumps({"alert_name": alert_name, "labels": labels}, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(payload.encode()).hexdigest()


async def find_canonical_rca(
    session: AsyncSession,
    fingerprint: str,
) -> RCA | None:
    """Find an existing RCA that should absorb a duplicate alert.

    An RCA qualifies if it was created from an alert with the same
    fingerprint AND either:
      (a) the RCA is still active (status in triggered/investigating), OR
      (b) the RCA was created within the configured dedup window.

    The most-recently-created qualifying RCA is returned.

    Args:
        session: Async database session.
        fingerprint: SHA-256 fingerprint of the incoming alert.

    Returns:
        The canonical ``RCA`` to link the duplicate to, or ``None`` if no
        match exists (i.e. a new investigation should be started).
    """
    window_cutoff = datetime.now(timezone.utc) - timedelta(minutes=settings.ORCA_DEDUP_WINDOW_MINUTES)

    # An active-status RCA is only considered "still running" if it was created
    # recently enough that the agent could still be executing.  Any older
    # investigating/triggered RCA was orphaned by a container kill and must not
    # permanently block new investigations.
    agent_active_cutoff = datetime.now(timezone.utc) - timedelta(
        seconds=settings.ORCA_AGENT_TIMEOUT_SECONDS + 60  # +60 s grace buffer
    )

    stmt = (
        select(RCA)
        .join(Alert, RCA.alert_id == Alert.id)
        .where(
            and_(
                Alert.dedup_fingerprint == fingerprint,
                or_(
                    and_(
                        RCA.status.in_(list(_ACTIVE_STATUSES)),
                        RCA.created_at >= agent_active_cutoff,
                    ),
                    RCA.created_at >= window_cutoff,
                ),
            )
        )
        .order_by(RCA.created_at.desc())
        .limit(1)
    )

    result = await session.execute(stmt)
    return result.scalar_one_or_none()


async def record_duplicate(
    session: AsyncSession,
    canonical_rca_id: uuid.UUID,
    duplicate_alert_id: uuid.UUID,
) -> None:
    """Link a duplicate alert to its canonical RCA and increment the counter.

    Inserts a row into ``rca_duplicate_alerts`` and atomically increments
    ``rcas.duplicate_count`` on the canonical RCA.

    Args:
        session: Async database session (caller is responsible for commit).
        canonical_rca_id: UUID of the RCA that absorbs the duplicate.
        duplicate_alert_id: UUID of the suppressed duplicate Alert.
    """
    log = logger.bind(rca_id=str(canonical_rca_id), duplicate_alert_id=str(duplicate_alert_id))

    # Insert association row
    duplicate_row = RCADuplicateAlert(
        id=uuid.uuid4(),
        rca_id=canonical_rca_id,
        alert_id=duplicate_alert_id,
    )
    session.add(duplicate_row)

    # Increment counter on the canonical RCA
    canonical_rca = await session.get(RCA, canonical_rca_id)
    if canonical_rca is not None:
        canonical_rca.duplicate_count = (canonical_rca.duplicate_count or 0) + 1

    log.info("duplicate_alert_recorded")

