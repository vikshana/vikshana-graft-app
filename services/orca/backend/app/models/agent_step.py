"""SQLAlchemy ORM model for the agent_steps table."""

import uuid
from datetime import datetime, timezone

from sqlalchemy import DateTime, Float, ForeignKey, Integer, String, Text, func
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db import Base
from app.models.types import UUIDType


class AgentStep(Base):
    """Records a single action taken by the LangGraph agent during an RCA run.

    Each node in the graph logs one or more steps to create a complete audit
    trail of what the agent queried and what it found.
    """

    __tablename__ = "agent_steps"

    id: Mapped[uuid.UUID] = mapped_column(UUIDType(), primary_key=True, default=uuid.uuid4)
    rca_id: Mapped[uuid.UUID] = mapped_column(
        UUIDType(), ForeignKey("rcas.id", ondelete="CASCADE"), nullable=False, index=True
    )
    step_number: Mapped[int] = mapped_column(Integer, nullable=False)
    node_name: Mapped[str] = mapped_column(String(50), nullable=False)
    action: Mapped[str] = mapped_column(String(255), nullable=False)
    input: Mapped[str | None] = mapped_column(Text, nullable=True)
    output: Mapped[str | None] = mapped_column(Text, nullable=True)
    tokens_used: Mapped[int | None] = mapped_column(Integer, nullable=True)
    duration_seconds: Mapped[float | None] = mapped_column(Float, nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        server_default=func.now(),
        default=lambda: datetime.now(timezone.utc),
    )

    # Relationship
    rca: Mapped["RCA"] = relationship(  # type: ignore[name-defined]  # noqa: F821
        "RCA",
        back_populates="steps",
        lazy="select",
    )

    def __repr__(self) -> str:
        return (
            f"<AgentStep rca_id={self.rca_id} step={self.step_number} "
            f"node={self.node_name!r} action={self.action!r}>"
        )


from app.models.rca import RCA  # noqa: E402, F401

