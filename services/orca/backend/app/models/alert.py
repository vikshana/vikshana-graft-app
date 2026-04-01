"""SQLAlchemy ORM model for the alerts table."""

import uuid
from datetime import datetime, timezone

from sqlalchemy import DateTime, Index, String, func
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db import Base
from app.models.types import JsonType, UUIDType


class Alert(Base):
    """Represents a raw Grafana alert received via webhook."""

    __tablename__ = "alerts"

    id: Mapped[uuid.UUID] = mapped_column(UUIDType(), primary_key=True, default=uuid.uuid4)
    raw_payload: Mapped[dict] = mapped_column(JsonType, nullable=False, comment="Full Grafana webhook payload")
    alert_name: Mapped[str] = mapped_column(String(255), nullable=False, index=True)
    status: Mapped[str] = mapped_column(String(50), nullable=False, default="firing", comment="firing | resolved")

    # SHA-256 hex digest of (alert_name + sorted labels JSON) — used for
    # fast indexed deduplication without JSON deep-comparisons.
    dedup_fingerprint: Mapped[str | None] = mapped_column(
        String(64), nullable=True, index=True, comment="SHA-256(alert_name + sorted labels)"
    )
    severity: Mapped[str] = mapped_column(String(50), nullable=False, default="unknown")
    labels: Mapped[dict] = mapped_column(JsonType, nullable=False, default=dict, comment="All alert labels as JSON")

    # Denormalised label fields for fast filtering/indexing
    service_name: Mapped[str | None] = mapped_column(String(255), nullable=True, index=True)
    deployment_environment_name: Mapped[str | None] = mapped_column(String(255), nullable=True, index=True)
    domain: Mapped[str | None] = mapped_column(String(255), nullable=True, index=True)
    legal_company: Mapped[str | None] = mapped_column(String(255), nullable=True, index=True)
    sub_domain: Mapped[str | None] = mapped_column(String(255), nullable=True, index=True)
    system_id: Mapped[str | None] = mapped_column(String(255), nullable=True, index=True)
    team: Mapped[str | None] = mapped_column(String(255), nullable=True, index=True)
    version: Mapped[str | None] = mapped_column(String(255), nullable=True, index=True)

    fired_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        server_default=func.now(),
        default=lambda: datetime.now(timezone.utc),
    )

    rcas: Mapped[list["RCA"]] = relationship("RCA", back_populates="alert", lazy="select")  # type: ignore[name-defined]  # noqa: F821

    __table_args__ = (
        Index("idx_alert_alert_name_trgm", "alert_name",
              postgresql_ops={"alert_name": "gin_trgm_ops"}, postgresql_using="gin"),
    )

    def __repr__(self) -> str:
        return f"<Alert id={self.id} alert_name={self.alert_name!r} status={self.status!r}>"


from app.models.rca import RCA  # noqa: E402, F401
