"""Unit tests for app.agent.dedup — fingerprint computation and dedup logic."""

import uuid
from datetime import datetime, timedelta, timezone
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
import pytest_asyncio
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from app.agent.dedup import compute_fingerprint, find_canonical_rca, record_duplicate
from app.db import Base
from app.models.alert import Alert
from app.models.rca import RCA
from app.models.rca_duplicate_alert import RCADuplicateAlert

# ---------------------------------------------------------------------------
# In-memory SQLite engine for dedup unit tests
# ---------------------------------------------------------------------------

_TEST_DB_URL = "sqlite+aiosqlite:///:memory:"


@pytest_asyncio.fixture(scope="module")
async def dedup_engine():
    """Shared in-memory SQLite engine for this module."""
    engine = create_async_engine(_TEST_DB_URL, echo=False)
    async with engine.begin() as conn:
        import app.models.alert  # noqa: F401
        import app.models.rca  # noqa: F401
        import app.models.agent_step  # noqa: F401
        import app.models.rca_duplicate_alert  # noqa: F401
        await conn.run_sync(Base.metadata.create_all)
    yield engine
    await engine.dispose()


@pytest_asyncio.fixture
async def dedup_session(dedup_engine) -> AsyncSession:
    """Fresh session per test — rolled back after each test."""
    factory = async_sessionmaker(bind=dedup_engine, class_=AsyncSession, expire_on_commit=False)
    async with factory() as session:
        yield session
        await session.rollback()


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

_BASE_LABELS: dict[str, str] = {
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


def _make_alert(fingerprint: str, labels: dict[str, str] | None = None) -> Alert:
    return Alert(
        id=uuid.uuid4(),
        raw_payload={},
        alert_name="HighLatency",
        status="firing",
        severity="critical",
        labels=labels or _BASE_LABELS,
        dedup_fingerprint=fingerprint,
    )


def _make_rca(alert_id: uuid.UUID, status: str = "investigating", minutes_ago: int = 5) -> RCA:
    created = datetime.now(timezone.utc) - timedelta(minutes=minutes_ago)
    return RCA(
        id=uuid.uuid4(),
        alert_id=alert_id,
        alert_name="HighLatency",
        status=status,
        started_at=created,
        created_at=created,
    )


# ---------------------------------------------------------------------------
# compute_fingerprint
# ---------------------------------------------------------------------------

class TestComputeFingerprint:
    """Tests for the fingerprint computation utility."""

    def test_same_name_and_labels_produce_same_fingerprint(self) -> None:
        """Identical inputs must produce identical fingerprints."""
        fp1 = compute_fingerprint("HighLatency", dict(_BASE_LABELS))
        fp2 = compute_fingerprint("HighLatency", dict(_BASE_LABELS))
        assert fp1 == fp2

    def test_different_alert_name_produces_different_fingerprint(self) -> None:
        """A different alert name must produce a different fingerprint."""
        fp1 = compute_fingerprint("HighLatency", dict(_BASE_LABELS))
        fp2 = compute_fingerprint("HighErrorRate", dict(_BASE_LABELS))
        assert fp1 != fp2

    def test_different_labels_produce_different_fingerprint(self) -> None:
        """A different label value must produce a different fingerprint."""
        fp1 = compute_fingerprint("HighLatency", {**_BASE_LABELS, "service_name": "checkout-service"})
        fp2 = compute_fingerprint("HighLatency", {**_BASE_LABELS, "service_name": "payment-service"})
        assert fp1 != fp2

    def test_label_order_does_not_affect_fingerprint(self) -> None:
        """Fingerprint must be stable regardless of dict insertion order."""
        labels_a = {"a": "1", "b": "2", "c": "3"}
        labels_b = {"c": "3", "a": "1", "b": "2"}
        assert compute_fingerprint("Alert", labels_a) == compute_fingerprint("Alert", labels_b)

    def test_fingerprint_is_64_char_hex(self) -> None:
        """Fingerprint should be a 64-character lowercase hex string (SHA-256)."""
        fp = compute_fingerprint("Alert", _BASE_LABELS)
        assert len(fp) == 64
        assert all(c in "0123456789abcdef" for c in fp)


# ---------------------------------------------------------------------------
# find_canonical_rca
# ---------------------------------------------------------------------------

class TestFindCanonicalRca:
    """Tests for the find_canonical_rca database query."""

    @pytest.mark.asyncio
    async def test_returns_none_when_no_matching_rca(self, dedup_session: AsyncSession) -> None:
        """Should return None when no RCA with that fingerprint exists."""
        fp = compute_fingerprint("SomeAlert", {"service_name": "svc"})
        result = await find_canonical_rca(dedup_session, fp)
        assert result is None

    @pytest.mark.asyncio
    async def test_finds_active_rca_within_window(self, dedup_session: AsyncSession) -> None:
        """Active RCA with matching fingerprint should be returned."""
        fp = compute_fingerprint("HighLatency", dict(_BASE_LABELS))
        alert = _make_alert(fp)
        rca = _make_rca(alert.id, status="investigating", minutes_ago=10)
        dedup_session.add(alert)
        dedup_session.add(rca)
        await dedup_session.flush()

        result = await find_canonical_rca(dedup_session, fp)
        assert result is not None
        assert result.id == rca.id

    @pytest.mark.asyncio
    async def test_finds_completed_rca_within_dedup_window(self, dedup_session: AsyncSession) -> None:
        """A completed RCA created within the window should still be returned."""
        fp = compute_fingerprint("HighLatency", {**_BASE_LABELS, "service_name": "svc-window"})
        alert = _make_alert(fp, labels={**_BASE_LABELS, "service_name": "svc-window"})
        # Use minutes_ago=10 which is inside the default 30-minute window
        rca = _make_rca(alert.id, status="complete", minutes_ago=10)
        dedup_session.add(alert)
        dedup_session.add(rca)
        await dedup_session.flush()

        result = await find_canonical_rca(dedup_session, fp)
        assert result is not None
        assert result.id == rca.id

    @pytest.mark.asyncio
    async def test_ignores_completed_rca_outside_window(self, dedup_session: AsyncSession) -> None:
        """A completed RCA created outside the window should NOT match."""
        fp = compute_fingerprint("HighLatency", {**_BASE_LABELS, "service_name": "svc-old"})
        alert = _make_alert(fp, labels={**_BASE_LABELS, "service_name": "svc-old"})
        # 60 minutes ago — outside the default 30-minute window
        rca = _make_rca(alert.id, status="complete", minutes_ago=60)
        dedup_session.add(alert)
        dedup_session.add(rca)
        await dedup_session.flush()

        with patch("app.agent.dedup.settings") as mock_settings:
            mock_settings.ORCA_DEDUP_WINDOW_MINUTES = 30
            result = await find_canonical_rca(dedup_session, fp)

        assert result is None

    @pytest.mark.asyncio
    async def test_does_not_match_different_fingerprint(self, dedup_session: AsyncSession) -> None:
        """An RCA with a different fingerprint must not be returned."""
        fp_a = compute_fingerprint("HighLatency", {**_BASE_LABELS, "service_name": "svc-a"})
        fp_b = compute_fingerprint("HighLatency", {**_BASE_LABELS, "service_name": "svc-b"})
        alert = _make_alert(fp_a, labels={**_BASE_LABELS, "service_name": "svc-a"})
        rca = _make_rca(alert.id, status="investigating", minutes_ago=1)
        dedup_session.add(alert)
        dedup_session.add(rca)
        await dedup_session.flush()

        result = await find_canonical_rca(dedup_session, fp_b)
        assert result is None

    @pytest.mark.asyncio
    async def test_active_rca_matched_regardless_of_age(self, dedup_session: AsyncSession) -> None:
        """Active (triggered/investigating) RCA should match even if older than window."""
        fp = compute_fingerprint("HighLatency", {**_BASE_LABELS, "service_name": "svc-long"})
        alert = _make_alert(fp, labels={**_BASE_LABELS, "service_name": "svc-long"})
        # 120 minutes ago — well outside window, but status=investigating
        rca = _make_rca(alert.id, status="investigating", minutes_ago=120)
        dedup_session.add(alert)
        dedup_session.add(rca)
        await dedup_session.flush()

        with patch("app.agent.dedup.settings") as mock_settings:
            mock_settings.ORCA_DEDUP_WINDOW_MINUTES = 30
            result = await find_canonical_rca(dedup_session, fp)

        assert result is not None
        assert result.id == rca.id


# ---------------------------------------------------------------------------
# record_duplicate
# ---------------------------------------------------------------------------

class TestRecordDuplicate:
    """Tests for the record_duplicate helper."""

    @pytest.mark.asyncio
    async def test_increments_duplicate_count(self, dedup_session: AsyncSession) -> None:
        """record_duplicate should increment the canonical RCA's duplicate_count."""
        fp = compute_fingerprint("HighLatency", {**_BASE_LABELS, "service_name": "svc-inc"})
        alert = _make_alert(fp, labels={**_BASE_LABELS, "service_name": "svc-inc"})
        duplicate_alert = _make_alert(fp, labels={**_BASE_LABELS, "service_name": "svc-inc"})
        rca = _make_rca(alert.id, status="investigating", minutes_ago=2)
        dedup_session.add(alert)
        dedup_session.add(duplicate_alert)
        dedup_session.add(rca)
        await dedup_session.flush()

        assert rca.duplicate_count == 0

        await record_duplicate(dedup_session, rca.id, duplicate_alert.id)
        await dedup_session.flush()

        assert rca.duplicate_count == 1

    @pytest.mark.asyncio
    async def test_creates_rca_duplicate_alert_row(self, dedup_session: AsyncSession) -> None:
        """record_duplicate should insert a row into rca_duplicate_alerts."""
        fp = compute_fingerprint("HighLatency", {**_BASE_LABELS, "service_name": "svc-row"})
        alert = _make_alert(fp, labels={**_BASE_LABELS, "service_name": "svc-row"})
        dup_alert = _make_alert(fp, labels={**_BASE_LABELS, "service_name": "svc-row"})
        rca = _make_rca(alert.id, status="investigating", minutes_ago=1)
        dedup_session.add(alert)
        dedup_session.add(dup_alert)
        dedup_session.add(rca)
        await dedup_session.flush()

        await record_duplicate(dedup_session, rca.id, dup_alert.id)
        await dedup_session.flush()

        from sqlalchemy import select
        result = await dedup_session.execute(
            select(RCADuplicateAlert).where(RCADuplicateAlert.rca_id == rca.id)
        )
        rows = result.scalars().all()
        assert len(rows) == 1
        assert rows[0].alert_id == dup_alert.id

    @pytest.mark.asyncio
    async def test_multiple_duplicates_accumulate(self, dedup_session: AsyncSession) -> None:
        """Calling record_duplicate multiple times increments the counter correctly."""
        fp = compute_fingerprint("HighLatency", {**_BASE_LABELS, "service_name": "svc-multi"})
        alert = _make_alert(fp, labels={**_BASE_LABELS, "service_name": "svc-multi"})
        rca = _make_rca(alert.id, status="investigating", minutes_ago=1)
        dedup_session.add(alert)
        dedup_session.add(rca)
        await dedup_session.flush()

        for _ in range(3):
            dup = _make_alert(fp, labels={**_BASE_LABELS, "service_name": "svc-multi"})
            dedup_session.add(dup)
            await dedup_session.flush()
            await record_duplicate(dedup_session, rca.id, dup.id)
            await dedup_session.flush()

        assert rca.duplicate_count == 3

