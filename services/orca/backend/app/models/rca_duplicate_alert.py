"""SQLAlchemy ORM model for the rca_duplicate_alerts association table.

Each row links a suppressed (duplicate) Alert to the canonical RCA that
absorbed it. The parent RCA's ``duplicate_count`` column is the fast-path
counter; this table provides the full audit trail.
"""

import uuid
from datetime import datetime, timezone

from sqlalchemy import DateTime, ForeignKey, func
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db import Base
from app.models.types import UUIDType


class RCADuplicateAlert(Base):
    """Associates a duplicate Alert with the canonical RCA that absorbed it.

    Attributes:
        id: Primary key.
        rca_id: FK to the canonical RCA record.
        alert_id: FK to the duplicate Alert record.
        created_at: Timestamp when the duplicate was recorded.
    """

    __tablename__ = "rca_duplicate_alerts"

    id: Mapped[uuid.UUID] = mapped_column(UUIDType(), primary_key=True, default=uuid.uuid4)
    rca_id: Mapped[uuid.UUID] = mapped_column(
        UUIDType(),
        ForeignKey("rcas.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    alert_id: Mapped[uuid.UUID] = mapped_column(
        UUIDType(),
        ForeignKey("alerts.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        server_default=func.now(),
        default=lambda: datetime.now(timezone.utc),
    )

    # Relationships
    rca: Mapped["RCA"] = relationship("RCA", back_populates="duplicate_alerts")  # type: ignore[name-defined]  # noqa: F821
    alert: Mapped["Alert"] = relationship("Alert")  # type: ignore[name-defined]  # noqa: F821

    def __repr__(self) -> str:
        return f"<RCADuplicateAlert rca_id={self.rca_id} alert_id={self.alert_id}>"


# Avoid circular import — import parents after the class definition
from app.models.rca import RCA  # noqa: E402, F401
from app.models.alert import Alert  # noqa: E402, F401

