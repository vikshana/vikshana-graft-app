"""Baseline migration — captures existing schema as a starting point.

This migration creates all existing tables that are currently managed via
SQLAlchemy ``create_all()`` in the app lifespan.  It also absorbs the three
inline ALTER TABLE statements that were previously run at startup:
  - rcas.feedback_rating
  - rcas.feedback_comment
  - rcas.org_id

After applying this migration, the inline ALTER TABLE statements in
``app/main.py`` lifespan are effectively no-ops (IF NOT EXISTS is safe).

Revision ID: 0001
Revises: (none — this is the initial migration)
Create Date: 2026-07-04
"""

from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

# revision identifiers, used by Alembic.
revision: str = "0001"
down_revision: Union[str, Sequence[str], None] = None
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Create all existing tables (baseline snapshot).

    Uses ``checkfirst=True`` equivalent via IF NOT EXISTS so the migration
    is safe to run against a database that already has these tables (dev envs
    where create_all() ran first).
    """
    conn = op.get_bind()

    # Enable extensions (non-fatal if already enabled or unavailable)
    conn.execute(sa.text("CREATE EXTENSION IF NOT EXISTS vector"))
    conn.execute(sa.text("CREATE EXTENSION IF NOT EXISTS pg_trgm"))

    # ------------------------------------------------------------------ #
    # alerts
    # ------------------------------------------------------------------ #
    op.execute(sa.text("""
        CREATE TABLE IF NOT EXISTS alerts (
            id          UUID PRIMARY KEY,
            raw_payload JSONB,
            alert_name  TEXT,
            status      TEXT,
            severity    TEXT,
            labels      JSONB,
            dedup_fingerprint TEXT,
            service_name TEXT,
            deployment_environment_name TEXT,
            domain TEXT,
            legal_company TEXT,
            sub_domain TEXT,
            system_id TEXT,
            team TEXT,
            version TEXT,
            fired_at    TIMESTAMPTZ DEFAULT now()
        )
    """))

    # ------------------------------------------------------------------ #
    # rcas (with the three previously-inline columns already included)
    # ------------------------------------------------------------------ #
    op.execute(sa.text("""
        CREATE TABLE IF NOT EXISTS rcas (
            id                  UUID PRIMARY KEY,
            alert_id            UUID REFERENCES alerts(id),
            alert_name          TEXT,
            status              TEXT,
            service_name        TEXT,
            deployment_environment_name TEXT,
            domain              TEXT,
            legal_company       TEXT,
            sub_domain          TEXT,
            system_id           TEXT,
            team                TEXT,
            version             TEXT,
            root_cause          TEXT,
            report_markdown     TEXT,
            confidence_level    TEXT,
            confidence_reasoning TEXT,
            error_message       TEXT,
            duplicate_count     INTEGER DEFAULT 0,
            feedback_rating     INTEGER,
            feedback_comment    TEXT,
            org_id              INTEGER,
            created_at          TIMESTAMPTZ DEFAULT now(),
            completed_at        TIMESTAMPTZ
        )
    """))
    op.execute(sa.text(
        "CREATE INDEX IF NOT EXISTS idx_rcas_alert_id ON rcas(alert_id)"
    ))
    op.execute(sa.text(
        "CREATE INDEX IF NOT EXISTS idx_rcas_status ON rcas(status)"
    ))

    # ------------------------------------------------------------------ #
    # agent_steps
    # ------------------------------------------------------------------ #
    op.execute(sa.text("""
        CREATE TABLE IF NOT EXISTS agent_steps (
            id          UUID PRIMARY KEY,
            rca_id      UUID REFERENCES rcas(id),
            step_number INTEGER,
            node_name   TEXT,
            action      TEXT,
            input       JSONB,
            output      JSONB,
            tokens_used INTEGER DEFAULT 0,
            duration    FLOAT,
            created_at  TIMESTAMPTZ DEFAULT now()
        )
    """))

    # ------------------------------------------------------------------ #
    # rca_duplicate_alerts
    # ------------------------------------------------------------------ #
    op.execute(sa.text("""
        CREATE TABLE IF NOT EXISTS rca_duplicate_alerts (
            id       UUID PRIMARY KEY,
            rca_id   UUID REFERENCES rcas(id),
            alert_id UUID REFERENCES alerts(id),
            created_at TIMESTAMPTZ DEFAULT now()
        )
    """))

    # ------------------------------------------------------------------ #
    # rca_sessions
    # ------------------------------------------------------------------ #
    op.execute(sa.text("""
        CREATE TABLE IF NOT EXISTS rca_sessions (
            id                  VARCHAR(36) PRIMARY KEY,
            thread_id           VARCHAR(36) UNIQUE,
            alert_id            VARCHAR(36),
            alert_type          VARCHAR(255),
            service             VARCHAR(255),
            environment         VARCHAR(255),
            org_id              INTEGER,
            rounds              INTEGER NOT NULL DEFAULT 0,
            final_confidence    FLOAT,
            developer_override  BOOLEAN NOT NULL DEFAULT false,
            final_hypothesis    TEXT,
            final_report        JSONB,
            hypothesis_trail    JSONB,
            started_at          TIMESTAMPTZ,
            accepted_at         TIMESTAMPTZ,
            created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
        )
    """))
    op.execute(sa.text(
        "CREATE INDEX IF NOT EXISTS idx_rca_sessions_org_id ON rca_sessions(org_id)"
    ))
    op.execute(sa.text(
        "CREATE INDEX IF NOT EXISTS idx_rca_sessions_created_at ON rca_sessions(created_at)"
    ))
    op.execute(sa.text(
        "CREATE INDEX IF NOT EXISTS idx_rca_sessions_thread_id ON rca_sessions(thread_id)"
    ))

    # ------------------------------------------------------------------ #
    # rca_embeddings
    # ------------------------------------------------------------------ #
    op.execute(sa.text("""
        CREATE TABLE IF NOT EXISTS rca_embeddings (
            id         VARCHAR(36) PRIMARY KEY,
            rca_id     VARCHAR(36) REFERENCES rca_sessions(id),
            chunk_type TEXT,
            content    TEXT,
            embedding  vector(1536),
            created_at TIMESTAMPTZ DEFAULT now()
        )
    """))


def downgrade() -> None:
    """Drop all baseline tables in reverse dependency order."""
    op.execute(sa.text("DROP TABLE IF EXISTS rca_embeddings"))
    op.execute(sa.text("DROP TABLE IF EXISTS rca_sessions"))
    op.execute(sa.text("DROP TABLE IF EXISTS rca_duplicate_alerts"))
    op.execute(sa.text("DROP TABLE IF EXISTS agent_steps"))
    op.execute(sa.text("DROP TABLE IF EXISTS rcas"))
    op.execute(sa.text("DROP TABLE IF EXISTS alerts"))
