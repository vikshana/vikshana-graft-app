"""SQLAlchemy ORM model for the rcas table."""

import uuid
from datetime import datetime, timezone

from sqlalchemy import DateTime, Float, ForeignKey, Index, Integer, String, Text, func
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db import Base
from app.models.types import UUIDType


class RCA(Base):
    """Represents a root cause analysis record."""

    __tablename__ = "rcas"

    id: Mapped[uuid.UUID] = mapped_column(UUIDType(), primary_key=True, default=uuid.uuid4)
    alert_id: Mapped[uuid.UUID | None] = mapped_column(
        UUIDType(), ForeignKey("alerts.id", ondelete="SET NULL"), nullable=True, index=True
    )
    alert_name: Mapped[str] = mapped_column(String(255), nullable=False)
    status: Mapped[str] = mapped_column(String(50), nullable=False, default="triggered", index=True)

    # Denormalised label fields
    service_name: Mapped[str | None] = mapped_column(String(255), nullable=True, index=True)
    deployment_environment_name: Mapped[str | None] = mapped_column(String(255), nullable=True, index=True)
    domain: Mapped[str | None] = mapped_column(String(255), nullable=True, index=True)
    legal_company: Mapped[str | None] = mapped_column(String(255), nullable=True, index=True)
    sub_domain: Mapped[str | None] = mapped_column(String(255), nullable=True, index=True)
    system_id: Mapped[str | None] = mapped_column(String(255), nullable=True, index=True)
    team: Mapped[str | None] = mapped_column(String(255), nullable=True, index=True)
    version: Mapped[str | None] = mapped_column(String(255), nullable=True, index=True)

    root_cause: Mapped[str | None] = mapped_column(Text, nullable=True)
    report_markdown: Mapped[str | None] = mapped_column(Text, nullable=True)
    confidence_level: Mapped[str | None] = mapped_column(String(20), nullable=True)
    confidence_reasoning: Mapped[str | None] = mapped_column(Text, nullable=True)

    # Deduplication — count of alerts suppressed because they matched this RCA
    duplicate_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0, server_default="0")

    # User feedback on the RCA quality: 1 = positive (thumbs up), 0 = negative (thumbs down), NULL = no feedback
    feedback_rating: Mapped[int | None] = mapped_column(Integer, nullable=True)
    feedback_comment: Mapped[str | None] = mapped_column(Text, nullable=True)

    total_steps: Mapped[int | None] = mapped_column(Integer, nullable=True)
    total_tokens: Mapped[int | None] = mapped_column(Integer, nullable=True)
    duration_seconds: Mapped[float | None] = mapped_column(Float, nullable=True)
    error_message: Mapped[str | None] = mapped_column(Text, nullable=True)

    started_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    completed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        server_default=func.now(),
        default=lambda: datetime.now(timezone.utc),
    )

    alert: Mapped["Alert | None"] = relationship("Alert", back_populates="rcas", lazy="select")  # type: ignore[name-defined]  # noqa: F821
    steps: Mapped[list["AgentStep"]] = relationship(  # type: ignore[name-defined]  # noqa: F821
        "AgentStep", back_populates="rca", order_by="AgentStep.step_number", lazy="select"
    )
    duplicate_alerts: Mapped[list["RCADuplicateAlert"]] = relationship(  # type: ignore[name-defined]  # noqa: F821
        "RCADuplicateAlert", back_populates="rca", order_by="RCADuplicateAlert.created_at", lazy="select"
    )

    __table_args__ = (
        Index("idx_rca_alert_name_trgm", "alert_name",
              postgresql_ops={"alert_name": "gin_trgm_ops"}, postgresql_using="gin"),
    )

    def __repr__(self) -> str:
        return f"<RCA id={self.id} alert_name={self.alert_name!r} status={self.status!r}>"


from app.models.alert import Alert  # noqa: E402, F401
from app.models.agent_step import AgentStep  # noqa: E402, F401
from app.models.rca_duplicate_alert import RCADuplicateAlert  # noqa: E402, F401

