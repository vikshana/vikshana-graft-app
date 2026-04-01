"""One-shot backfill script: retroactively deduplicate pre-existing RCAs.

Run once after deploying the deduplication feature against a database that
already contains duplicate RCA records created before deduplication was active.

What it does
------------
1. Backfills ``alerts.dedup_fingerprint`` for any alert row that doesn't
   have one yet (SHA-256 of alert_name + sorted labels).
2. For each fingerprint group, processes RCAs in chronological order and
   applies the same 30-minute window logic used by ``find_canonical_rca``.
   The oldest qualifying RCA in each window becomes the canonical; every
   subsequent one within the window is marked ``status='deduplicated'``.
3. For each deduplicated RCA: links its underlying alert to the canonical
   RCA via ``rca_duplicate_alerts`` and increments ``canonical.duplicate_count``.

Safe to re-run: already-deduplicated rows are skipped.

Usage
-----
    # From repo root, with the Orca Postgres container running:
    DATABASE_URL=postgresql+asyncpg://orca:orca@localhost:5432/orca \
        python backend/scripts/backfill_dedup.py

    # Or inside the backend container:
    python scripts/backfill_dedup.py
"""

import asyncio
import hashlib
import json
import os
import sys
import uuid
from collections import defaultdict
from datetime import timedelta

import structlog
from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

# ---------------------------------------------------------------------------
# Bootstrap: make sure app.* is importable when run as a standalone script
# ---------------------------------------------------------------------------
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from app.models.alert import Alert  # noqa: E402
from app.models.rca import RCA  # noqa: E402
from app.models.rca_duplicate_alert import RCADuplicateAlert  # noqa: E402
import app.models.agent_step  # noqa: E402, F401 — needed for FK resolution

logger = structlog.get_logger()

DATABASE_URL = os.environ.get(
    "DATABASE_URL",
    "postgresql+asyncpg://orca:orca@localhost:5432/orca",
)
DEDUP_WINDOW_MINUTES = int(os.environ.get("ORCA_DEDUP_WINDOW_MINUTES", "30"))


def _compute_fingerprint(alert_name: str, labels: dict) -> str:
    payload = json.dumps(
        {"alert_name": alert_name, "labels": labels},
        sort_keys=True,
        separators=(",", ":"),
    )
    return hashlib.sha256(payload.encode()).hexdigest()


async def backfill(session: AsyncSession) -> None:
    log = logger.bind(script="backfill_dedup")

    # ------------------------------------------------------------------
    # Step 1 — backfill dedup_fingerprint on alerts that lack one
    # ------------------------------------------------------------------
    result = await session.execute(
        select(Alert).where(Alert.dedup_fingerprint.is_(None))
    )
    alerts_without_fp = result.scalars().all()
    log.info("alerts_without_fingerprint", count=len(alerts_without_fp))

    for alert in alerts_without_fp:
        fp = _compute_fingerprint(alert.alert_name, alert.labels or {})
        alert.dedup_fingerprint = fp

    await session.flush()
    log.info("fingerprints_backfilled", count=len(alerts_without_fp))

    # ------------------------------------------------------------------
    # Step 2 — load all RCAs that are NOT already deduplicated
    # ------------------------------------------------------------------
    result = await session.execute(
        select(RCA)
        .where(RCA.status != "deduplicated")
        .order_by(RCA.created_at.asc())
    )
    all_rcas: list[RCA] = list(result.scalars().all())
    log.info("rcas_to_process", count=len(all_rcas))

    # Load their associated alerts so we can read fingerprints
    alert_ids = [r.alert_id for r in all_rcas if r.alert_id is not None]
    alert_result = await session.execute(
        select(Alert).where(Alert.id.in_(alert_ids))
    )
    alerts_by_id: dict[uuid.UUID, Alert] = {a.id: a for a in alert_result.scalars().all()}

    # ------------------------------------------------------------------
    # Step 3 — group RCAs by fingerprint, then apply window logic
    # ------------------------------------------------------------------
    # Map fingerprint → list of RCAs (already sorted ASC by created_at)
    groups: dict[str, list[RCA]] = defaultdict(list)
    for rca in all_rcas:
        if rca.alert_id is None:
            continue
        alert = alerts_by_id.get(rca.alert_id)
        if alert is None or alert.dedup_fingerprint is None:
            continue
        groups[alert.dedup_fingerprint].append(rca)

    total_deduplicated = 0
    window = timedelta(minutes=DEDUP_WINDOW_MINUTES)

    for fp, rcas in groups.items():
        # rcas is sorted ASC; process in order to assign canonicals
        canonical: RCA | None = None

        for rca in rcas:
            if canonical is None:
                # First RCA in this fingerprint group is always canonical
                canonical = rca
                log.debug("canonical_set", rca_id=str(rca.id), alert_name=rca.alert_name)
                continue

            # Check: is the canonical within the dedup window relative to this RCA?
            assert canonical.created_at is not None
            assert rca.created_at is not None
            window_cutoff = rca.created_at - window

            if canonical.created_at >= window_cutoff:
                # This RCA is a duplicate of the current canonical
                log.info(
                    "marking_deduplicated",
                    rca_id=str(rca.id),
                    canonical_rca_id=str(canonical.id),
                    alert_name=rca.alert_name,
                    delta_minutes=round(
                        (rca.created_at - canonical.created_at).total_seconds() / 60, 1
                    ),
                )

                # Mark status
                rca.status = "deduplicated"

                # Link the alert to the canonical RCA (skip if already linked)
                if rca.alert_id is not None:
                    existing = await session.execute(
                        select(RCADuplicateAlert).where(
                            RCADuplicateAlert.rca_id == canonical.id,
                            RCADuplicateAlert.alert_id == rca.alert_id,
                        )
                    )
                    if existing.scalar_one_or_none() is None:
                        session.add(
                            RCADuplicateAlert(
                                id=uuid.uuid4(),
                                rca_id=canonical.id,
                                alert_id=rca.alert_id,
                            )
                        )
                        canonical.duplicate_count = (canonical.duplicate_count or 0) + 1

                total_deduplicated += 1

            else:
                # Outside the window — this RCA starts a new canonical period
                log.debug(
                    "new_canonical",
                    rca_id=str(rca.id),
                    alert_name=rca.alert_name,
                    delta_minutes=round(
                        (rca.created_at - canonical.created_at).total_seconds() / 60, 1
                    ),
                )
                canonical = rca

    await session.flush()
    log.info("backfill_complete", total_deduplicated=total_deduplicated)
    print(f"\n✓ Backfill complete — {total_deduplicated} RCAs marked as deduplicated.\n")


async def main() -> None:
    engine = create_async_engine(DATABASE_URL, echo=False)
    factory = async_sessionmaker(bind=engine, class_=AsyncSession, expire_on_commit=False)

    async with factory() as session:
        async with session.begin():
            await backfill(session)

    await engine.dispose()


if __name__ == "__main__":
    asyncio.run(main())

