"""Harness Phase 0 — add auth + session columns and new harness tables.

Adds:
  1. user_tokens — encrypted OBO token storage (Task 0.2)
  2. rca_sessions extension — new session harness columns (Task 1.2 prep)
  3. users / identities — identity model (Task 1.2 prep)
  4. turns / tool_calls / approvals / spend_ledger / turn_jobs — session harness tables
  5. drill_down_results — tool result oversize storage (Task 1.3 prep)

Revision ID: 0002
Revises: 0001
Create Date: 2026-07-04
"""

from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "0002"
down_revision: Union[str, Sequence[str], None] = "0001"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Apply Phase 0 harness schema additions."""

    # ------------------------------------------------------------------ #
    # 1. user_tokens — encrypted refresh token storage for OBO auth
    # ------------------------------------------------------------------ #
    op.execute(sa.text("""
        CREATE TABLE IF NOT EXISTS user_tokens (
            id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            user_id                 VARCHAR(36) NOT NULL,
            encrypted_access_token  TEXT NOT NULL,
            encrypted_refresh_token TEXT NOT NULL,
            expires_at              TIMESTAMPTZ NOT NULL,
            refresh_expires_at      TIMESTAMPTZ NOT NULL,
            issuer                  VARCHAR(255),
            created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
            revoked_at              TIMESTAMPTZ
        )
    """))
    op.execute(sa.text(
        "CREATE INDEX IF NOT EXISTS idx_user_tokens_user_id ON user_tokens(user_id)"
    ))
    op.execute(sa.text(
        "CREATE INDEX IF NOT EXISTS idx_user_tokens_revoked ON user_tokens(user_id, revoked_at)"
    ))

    # ------------------------------------------------------------------ #
    # 2. Extend rca_sessions with harness columns
    #    (idempotent — IF NOT EXISTS on each column)
    # ------------------------------------------------------------------ #
    for stmt in [
        "ALTER TABLE rca_sessions ADD COLUMN IF NOT EXISTS type VARCHAR(20) DEFAULT 'investigation'",
        "ALTER TABLE rca_sessions ADD COLUMN IF NOT EXISTS status VARCHAR(30) DEFAULT 'active'",
        "ALTER TABLE rca_sessions ADD COLUMN IF NOT EXISTS initiator_user_id VARCHAR(36)",
        "ALTER TABLE rca_sessions ADD COLUMN IF NOT EXISTS initiator_channel VARCHAR(20) DEFAULT 'grafana'",
        "ALTER TABLE rca_sessions ADD COLUMN IF NOT EXISTS auth_mode VARCHAR(30) DEFAULT 'service_account'",
        "ALTER TABLE rca_sessions ADD COLUMN IF NOT EXISTS entry_state JSONB",
        "ALTER TABLE rca_sessions ADD COLUMN IF NOT EXISTS channel_refs JSONB",
        "ALTER TABLE rca_sessions ADD COLUMN IF NOT EXISTS skill_version_pins JSONB",
        "ALTER TABLE rca_sessions ADD COLUMN IF NOT EXISTS budget JSONB",
        "ALTER TABLE rca_sessions ADD COLUMN IF NOT EXISTS spend JSONB",
        "ALTER TABLE rca_sessions ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT now()",
    ]:
        op.execute(sa.text(stmt))

    # ------------------------------------------------------------------ #
    # 3. users + identities — identity model
    # ------------------------------------------------------------------ #
    op.execute(sa.text("""
        CREATE TABLE IF NOT EXISTS users (
            id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            entra_sub    VARCHAR UNIQUE,
            email        VARCHAR,
            display_name VARCHAR,
            created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
        )
    """))

    op.execute(sa.text("""
        CREATE TABLE IF NOT EXISTS identities (
            id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            user_id          UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            provider         VARCHAR(20) NOT NULL,
            provider_subject VARCHAR NOT NULL,
            email            VARCHAR,
            linked_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
            UNIQUE(provider, provider_subject)
        )
    """))
    op.execute(sa.text(
        "CREATE INDEX IF NOT EXISTS idx_identities_user_id ON identities(user_id)"
    ))

    # ------------------------------------------------------------------ #
    # 4. turns + tool_calls + approvals + spend_ledger + turn_jobs
    # ------------------------------------------------------------------ #
    op.execute(sa.text("""
        CREATE TABLE IF NOT EXISTS turns (
            id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            session_id  VARCHAR(36) NOT NULL REFERENCES rca_sessions(id) ON DELETE CASCADE,
            seq         INTEGER NOT NULL,
            role        VARCHAR(20) NOT NULL,
            content     JSONB NOT NULL,
            token_usage JSONB,
            created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
        )
    """))
    op.execute(sa.text(
        "CREATE INDEX IF NOT EXISTS idx_turns_session_id ON turns(session_id)"
    ))

    op.execute(sa.text("""
        CREATE TABLE IF NOT EXISTS tool_calls (
            id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            turn_id          UUID REFERENCES turns(id) ON DELETE CASCADE,
            tool_name        VARCHAR NOT NULL,
            input            JSONB NOT NULL,
            guard_verdict    VARCHAR(30) NOT NULL,
            acting_identity  VARCHAR(36),
            datasource_uid   VARCHAR(255),
            duration_ms      INTEGER,
            status           VARCHAR(20) NOT NULL,
            result_ref       VARCHAR,
            created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
        )
    """))
    op.execute(sa.text(
        "CREATE INDEX IF NOT EXISTS idx_tool_calls_turn_id ON tool_calls(turn_id)"
    ))

    op.execute(sa.text("""
        CREATE TABLE IF NOT EXISTS approvals (
            id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            session_id          VARCHAR(36) NOT NULL REFERENCES rca_sessions(id),
            tool_call_id        UUID REFERENCES tool_calls(id),
            requested_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
            decided_at          TIMESTAMPTZ,
            decided_by_user_id  UUID REFERENCES users(id),
            decision            VARCHAR(10),
            payload             JSONB
        )
    """))
    op.execute(sa.text(
        "CREATE INDEX IF NOT EXISTS idx_approvals_session_id ON approvals(session_id)"
    ))

    op.execute(sa.text("""
        CREATE TABLE IF NOT EXISTS spend_ledger (
            id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            session_id  VARCHAR(36) NOT NULL REFERENCES rca_sessions(id),
            turn_id     UUID REFERENCES turns(id),
            token_count INTEGER NOT NULL DEFAULT 0,
            cost_usd    NUMERIC(12, 6) NOT NULL DEFAULT 0,
            provider    VARCHAR(50),
            model       VARCHAR(100),
            created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
        )
    """))
    op.execute(sa.text(
        "CREATE INDEX IF NOT EXISTS idx_spend_ledger_session_id ON spend_ledger(session_id)"
    ))

    op.execute(sa.text("""
        CREATE TABLE IF NOT EXISTS turn_jobs (
            id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            session_id  VARCHAR(36) NOT NULL REFERENCES rca_sessions(id),
            payload     JSONB NOT NULL,
            status      VARCHAR(20) NOT NULL DEFAULT 'pending',
            created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
            claimed_at  TIMESTAMPTZ,
            worker_id   VARCHAR(100)
        )
    """))
    op.execute(sa.text(
        "CREATE INDEX IF NOT EXISTS idx_turn_jobs_status ON turn_jobs(status, created_at)"
    ))
    op.execute(sa.text(
        "CREATE INDEX IF NOT EXISTS idx_turn_jobs_session_id ON turn_jobs(session_id)"
    ))

    # ------------------------------------------------------------------ #
    # 5. drill_down_results — stores oversized tool results (TTL 24h)
    # ------------------------------------------------------------------ #
    op.execute(sa.text("""
        CREATE TABLE IF NOT EXISTS drill_down_results (
            handle     VARCHAR(64) PRIMARY KEY,
            session_id VARCHAR(36) REFERENCES rca_sessions(id),
            tool_name  VARCHAR NOT NULL,
            full_result JSONB NOT NULL,
            created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
            expires_at  TIMESTAMPTZ NOT NULL
        )
    """))
    op.execute(sa.text(
        "CREATE INDEX IF NOT EXISTS idx_drill_down_expires ON drill_down_results(expires_at)"
    ))


def downgrade() -> None:
    """Revert Phase 0 harness schema additions."""
    op.execute(sa.text("DROP TABLE IF EXISTS drill_down_results"))
    op.execute(sa.text("DROP TABLE IF EXISTS turn_jobs"))
    op.execute(sa.text("DROP TABLE IF EXISTS spend_ledger"))
    op.execute(sa.text("DROP TABLE IF EXISTS approvals"))
    op.execute(sa.text("DROP TABLE IF EXISTS tool_calls"))
    op.execute(sa.text("DROP TABLE IF EXISTS turns"))
    op.execute(sa.text("DROP TABLE IF EXISTS identities"))
    op.execute(sa.text("DROP TABLE IF EXISTS users"))
    op.execute(sa.text("DROP TABLE IF EXISTS user_tokens"))

    # Remove added columns from rca_sessions
    for col in [
        "type", "status", "initiator_user_id", "initiator_channel",
        "auth_mode", "entry_state", "channel_refs", "skill_version_pins",
        "budget", "spend", "updated_at",
    ]:
        op.execute(sa.text(
            f"ALTER TABLE rca_sessions DROP COLUMN IF EXISTS {col}"
        ))
