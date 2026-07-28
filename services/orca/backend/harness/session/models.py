"""SQLAlchemy ORM models for harness session tables.

These models correspond to the tables created in Alembic migration
``0002_harness_phase0.py``.  They use ``sa.JSON().with_variant(postgresql.JSONB(), "postgresql")``
for all JSONB columns so the models work with both PostgreSQL (production)
and SQLite (unit tests via aiosqlite).
"""

from __future__ import annotations

import uuid
from datetime import datetime, timezone

import sqlalchemy as sa
from sqlalchemy.dialects import postgresql
from sqlalchemy.orm import Mapped, mapped_column

from app.db import Base

# Cross-DB compatible JSON type: JSONB on Postgres, JSON on SQLite
_JSON = sa.JSON().with_variant(postgresql.JSONB(), "postgresql")


def _uuid() -> str:
    return str(uuid.uuid4())


def _now() -> datetime:
    return datetime.now(timezone.utc)


class Turn(Base):
    """A single conversational turn in a session.

    Each turn has a sequence number (``seq``) that orders it within the session.
    Content is stored as JSONB so it can hold structured data (tool results, etc.)
    alongside plain text.
    """

    __tablename__ = "turns"

    id: Mapped[str] = mapped_column(
        sa.String(36), primary_key=True, default=_uuid
    )
    session_id: Mapped[str] = mapped_column(
        sa.String(36),
        sa.ForeignKey("rca_sessions.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    seq: Mapped[int] = mapped_column(sa.Integer, nullable=False)
    role: Mapped[str] = mapped_column(sa.String(20), nullable=False)
    content: Mapped[dict] = mapped_column(_JSON, nullable=False)
    token_usage: Mapped[dict | None] = mapped_column(_JSON, nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        sa.DateTime(timezone=True), nullable=False, default=_now
    )

    def __repr__(self) -> str:
        return f"<Turn id={self.id} session={self.session_id} seq={self.seq} role={self.role!r}>"


class ToolCallRecord(Base):
    """Audit record for a single tool call within a turn.

    Records the guard verdict, the acting identity, any datasource UID,
    and the duration.  Used for audit logging and the guard denial rate metric.
    """

    __tablename__ = "tool_calls"

    id: Mapped[str] = mapped_column(
        sa.String(36), primary_key=True, default=_uuid
    )
    turn_id: Mapped[str | None] = mapped_column(
        sa.String(36),
        sa.ForeignKey("turns.id", ondelete="CASCADE"),
        nullable=True,
        index=True,
    )
    tool_name: Mapped[str] = mapped_column(sa.String(255), nullable=False)
    input: Mapped[dict] = mapped_column(_JSON, nullable=False)
    guard_verdict: Mapped[str] = mapped_column(sa.String(30), nullable=False)
    acting_identity: Mapped[str | None] = mapped_column(sa.String(36), nullable=True)
    datasource_uid: Mapped[str | None] = mapped_column(sa.String(255), nullable=True)
    duration_ms: Mapped[int | None] = mapped_column(sa.Integer, nullable=True)
    status: Mapped[str] = mapped_column(sa.String(20), nullable=False)
    result_ref: Mapped[str | None] = mapped_column(sa.String(255), nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        sa.DateTime(timezone=True), nullable=False, default=_now
    )

    def __repr__(self) -> str:
        return (
            f"<ToolCallRecord id={self.id} tool={self.tool_name!r} "
            f"verdict={self.guard_verdict!r}>"
        )


class Approval(Base):
    """Approval request for a write-class tool call.

    Only the session initiator may approve (enforced at the API layer and
    re-checked here via ``decided_by_user_id``).
    """

    __tablename__ = "approvals"

    id: Mapped[str] = mapped_column(
        sa.String(36), primary_key=True, default=_uuid
    )
    session_id: Mapped[str] = mapped_column(
        sa.String(36),
        sa.ForeignKey("rca_sessions.id"),
        nullable=False,
        index=True,
    )
    tool_call_id: Mapped[str | None] = mapped_column(
        sa.String(36),
        sa.ForeignKey("tool_calls.id"),
        nullable=True,
    )
    requested_at: Mapped[datetime] = mapped_column(
        sa.DateTime(timezone=True), nullable=False, default=_now
    )
    decided_at: Mapped[datetime | None] = mapped_column(
        sa.DateTime(timezone=True), nullable=True
    )
    decided_by_user_id: Mapped[str | None] = mapped_column(
        sa.String(36),
        sa.ForeignKey("users.id"),
        nullable=True,
    )
    decision: Mapped[str | None] = mapped_column(sa.String(10), nullable=True)
    payload: Mapped[dict | None] = mapped_column(_JSON, nullable=True)

    def __repr__(self) -> str:
        return (
            f"<Approval id={self.id} session={self.session_id} "
            f"decision={self.decision!r}>"
        )


class SpendLedger(Base):
    """Immutable spend record for a single LLM or tool call.

    Updated transactionally after every allowed LLM completion.
    The budget guard reads per-session and per-user totals by aggregating
    this table rather than maintaining a running counter (avoids update races).
    """

    __tablename__ = "spend_ledger"

    id: Mapped[str] = mapped_column(
        sa.String(36), primary_key=True, default=_uuid
    )
    session_id: Mapped[str] = mapped_column(
        sa.String(36),
        sa.ForeignKey("rca_sessions.id"),
        nullable=False,
        index=True,
    )
    turn_id: Mapped[str | None] = mapped_column(
        sa.String(36),
        sa.ForeignKey("turns.id"),
        nullable=True,
    )
    token_count: Mapped[int] = mapped_column(sa.Integer, nullable=False, default=0)
    cost_usd: Mapped[float] = mapped_column(sa.Float, nullable=False, default=0.0)
    provider: Mapped[str | None] = mapped_column(sa.String(50), nullable=True)
    model: Mapped[str | None] = mapped_column(sa.String(100), nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        sa.DateTime(timezone=True), nullable=False, default=_now
    )

    def __repr__(self) -> str:
        return (
            f"<SpendLedger id={self.id} session={self.session_id} "
            f"tokens={self.token_count} cost={self.cost_usd}>"
        )


class TurnJob(Base):
    """A pending agent turn claimed from the job queue.

    The worker loop polls this table with ``FOR UPDATE SKIP LOCKED`` to claim
    a single job, then uses a non-blocking, transaction-scoped
    ``pg_try_advisory_xact_lock`` (held on a dedicated execution session for
    the full turn execution, released automatically when that transaction
    ends) to serialise turns within a session. ``claimed_at`` doubles as a
    heartbeat: it is periodically refreshed while a turn is executing so the
    orphan reaper never requeues a still-live, long-running turn.
    """

    __tablename__ = "turn_jobs"

    id: Mapped[str] = mapped_column(
        sa.String(36), primary_key=True, default=_uuid
    )
    session_id: Mapped[str] = mapped_column(
        sa.String(36),
        sa.ForeignKey("rca_sessions.id"),
        nullable=False,
        index=True,
    )
    payload: Mapped[dict] = mapped_column(_JSON, nullable=False)
    status: Mapped[str] = mapped_column(
        sa.String(20), nullable=False, default="pending", index=True
    )
    created_at: Mapped[datetime] = mapped_column(
        sa.DateTime(timezone=True), nullable=False, default=_now
    )
    claimed_at: Mapped[datetime | None] = mapped_column(
        sa.DateTime(timezone=True), nullable=True
    )
    worker_id: Mapped[str | None] = mapped_column(sa.String(100), nullable=True)
    attempts: Mapped[int] = mapped_column(
        sa.Integer, nullable=False, default=0, server_default="0"
    )

    def __repr__(self) -> str:
        return (
            f"<TurnJob id={self.id} session={self.session_id} status={self.status!r}>"
        )


class DrillDownResult(Base):
    """Full tool result stored for deferred drill-down access.

    When a tool result is truncated by the result-shaping layer, the full
    result is stored here with a 24h TTL.  The ``fetch_more`` tool retrieves
    slices from this table.
    """

    __tablename__ = "drill_down_results"

    handle: Mapped[str] = mapped_column(sa.String(64), primary_key=True)
    session_id: Mapped[str | None] = mapped_column(
        sa.String(36),
        sa.ForeignKey("rca_sessions.id"),
        nullable=True,
    )
    tool_name: Mapped[str] = mapped_column(sa.String(255), nullable=False)
    full_result: Mapped[dict] = mapped_column(_JSON, nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        sa.DateTime(timezone=True), nullable=False, default=_now
    )
    expires_at: Mapped[datetime] = mapped_column(
        sa.DateTime(timezone=True), nullable=False, index=True
    )

    def __repr__(self) -> str:
        return f"<DrillDownResult handle={self.handle} tool={self.tool_name!r}>"


class HarnessUser(Base):
    """Platform user identity record.

    Maps Entra sub / Slack user to an internal user ID.
    The table name is ``users`` (matching the migration), but the model
    class is named ``HarnessUser`` to avoid shadowing Python builtins.
    """

    __tablename__ = "users"

    id: Mapped[str] = mapped_column(
        sa.String(36), primary_key=True, default=_uuid
    )
    entra_sub: Mapped[str | None] = mapped_column(
        sa.String(255), nullable=True, unique=True
    )
    email: Mapped[str | None] = mapped_column(sa.String(255), nullable=True)
    display_name: Mapped[str | None] = mapped_column(sa.String(255), nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        sa.DateTime(timezone=True), nullable=False, default=_now
    )

    def __repr__(self) -> str:
        return f"<HarnessUser id={self.id} email={self.email!r}>"


class Identity(Base):
    """Provider identity linked to an internal user.

    ``provider`` is one of: ``entra``, ``slack``, ``grafana``.
    The ``(provider, provider_subject)`` pair is unique.
    """

    __tablename__ = "identities"

    id: Mapped[str] = mapped_column(
        sa.String(36), primary_key=True, default=_uuid
    )
    user_id: Mapped[str] = mapped_column(
        sa.String(36),
        sa.ForeignKey("users.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    provider: Mapped[str] = mapped_column(sa.String(20), nullable=False)
    provider_subject: Mapped[str] = mapped_column(sa.String(255), nullable=False)
    email: Mapped[str | None] = mapped_column(sa.String(255), nullable=True)
    linked_at: Mapped[datetime] = mapped_column(
        sa.DateTime(timezone=True), nullable=False, default=_now
    )

    __table_args__ = (
        sa.UniqueConstraint("provider", "provider_subject", name="uq_identity_provider_subject"),
    )

    def __repr__(self) -> str:
        return (
            f"<Identity id={self.id} provider={self.provider!r} "
            f"subject={self.provider_subject!r}>"
        )
