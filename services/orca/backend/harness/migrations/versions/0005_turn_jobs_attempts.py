"""Add attempts counter to turn_jobs for orphaned-job reaping.

Revision ID: 0005
Revises: 0004
Create Date: 2026-07-10
"""

from __future__ import annotations

from alembic import op
import sqlalchemy as sa

revision: str = "0005"
down_revision: str = "0004"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # Idempotent: uses ADD COLUMN IF NOT EXISTS (matching the style used by
    # migrations 0001/0002) rather than `op.add_column`, which raises
    # "column already exists" against a database whose `turn_jobs` table was
    # provisioned via `Base.metadata.create_all()` -- the ORM `TurnJob`
    # model already declares `attempts`, so a dev/legacy environment that
    # bootstrapped its schema via create_all() before adopting Alembic as
    # the sole schema authority may already have this column. Without this,
    # `alembic upgrade head` fails outright on such a database.
    op.execute(sa.text(
        "ALTER TABLE turn_jobs ADD COLUMN IF NOT EXISTS attempts "
        "INTEGER NOT NULL DEFAULT 0"
    ))


def downgrade() -> None:
    op.execute(sa.text("ALTER TABLE turn_jobs DROP COLUMN IF EXISTS attempts"))
