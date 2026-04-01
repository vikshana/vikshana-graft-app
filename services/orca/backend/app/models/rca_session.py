"""SQLAlchemy ORM model for the rca_sessions table.

This is the canonical long-lived RCA store, written once when a developer
accepts the final hypothesis.  It is separate from the LangGraph checkpointer
tables (short-lived, operational) and the legacy ``rcas`` table (one-shot flow).

Schema mirrors rca-architecture-brief.md §7.
"""

import uuid
from datetime import datetime, timezone

from sqlalchemy import Boolean, DateTime, Float, Index, Integer, String, Text
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column

from app.db import Base
from app.models.types import UUIDType


class RCASession(Base):
    """Canonical RCA record written on developer acceptance."""

    __tablename__ = "rca_sessions"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    thread_id: Mapped[str | None] = mapped_column(String(36), nullable=True, unique=True, index=True)
    """LangGraph thread_id — links to the checkpointer table (operational)."""

    # Alert provenance
    alert_id: Mapped[str | None] = mapped_column(String(36), nullable=True, index=True)
    alert_type: Mapped[str | None] = mapped_column(String(255), nullable=True, index=True)
    service: Mapped[str | None] = mapped_column(String(255), nullable=True, index=True)
    environment: Mapped[str | None] = mapped_column(String(255), nullable=True, index=True)

    # Multi-org isolation
    org_id: Mapped[int | None] = mapped_column(Integer, nullable=True, index=True)
    """Grafana organisation ID — used to scope queries per org."""

    # Investigation outcome
    rounds: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    final_confidence: Mapped[float | None] = mapped_column(Float, nullable=True)
    developer_override: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    """True if accepted at low confidence or at max_rounds (force-finalised)."""

    final_hypothesis: Mapped[str | None] = mapped_column(Text, nullable=True)
    final_report: Mapped[dict | None] = mapped_column(JSONB, nullable=True)
    hypothesis_trail: Mapped[list | None] = mapped_column(JSONB, nullable=True)
    """Append-only list of all hypothesis texts across all rounds."""

    # Timestamps
    started_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    accepted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        default=lambda: datetime.now(timezone.utc),
    )

    __table_args__ = (
        Index("idx_rca_sessions_org_id", "org_id"),
        Index("idx_rca_sessions_created_at", "created_at"),
    )

    def __repr__(self) -> str:
        return f"<RCASession id={self.id} alert_type={self.alert_type!r} org_id={self.org_id}>"
