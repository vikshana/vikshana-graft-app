"""SQLAlchemy ORM model for the rca_embeddings table.

Stores pgvector embeddings of RCA content chunks for semantic similarity
search in the historical_context node.

Three chunk types are stored per RCA:
- ``hypothesis``    — the final accepted hypothesis text
- ``qa_turn``       — each developer Q&A turn (question + answer pair)
- ``final_report``  — the first 2000 chars of the final report markdown

Schema mirrors rca-architecture-brief.md §7.
"""

import uuid
from datetime import datetime, timezone

from sqlalchemy import DateTime, Index, String, Text
from sqlalchemy.orm import Mapped, mapped_column

from app.db import Base

try:
    from pgvector.sqlalchemy import Vector  # type: ignore[import-untyped]
    _VECTOR_TYPE = Vector(1536)
except ImportError:
    # Fallback for environments without pgvector installed (tests)
    from sqlalchemy import JSON
    _VECTOR_TYPE = JSON()  # type: ignore[assignment]


class RCAEmbedding(Base):
    """Embedding chunk for semantic similarity search."""

    __tablename__ = "rca_embeddings"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    rca_id: Mapped[str] = mapped_column(String(36), nullable=False, index=True)
    """Foreign key to rca_sessions.id — not a FK constraint to allow async inserts."""

    chunk_type: Mapped[str] = mapped_column(
        String(20), nullable=False
    )
    """One of: hypothesis | qa_turn | final_report."""

    content: Mapped[str] = mapped_column(Text, nullable=False)
    """The text that was embedded."""

    embedding: Mapped[list] = mapped_column(_VECTOR_TYPE, nullable=False)
    """1536-dimensional embedding vector."""

    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        default=lambda: datetime.now(timezone.utc),
    )

    __table_args__ = (
        Index("idx_rca_embeddings_rca_id", "rca_id"),
        Index("idx_rca_embeddings_chunk_type", "chunk_type"),
    )

    def __repr__(self) -> str:
        return f"<RCAEmbedding id={self.id} rca_id={self.rca_id} chunk_type={self.chunk_type!r}>"
