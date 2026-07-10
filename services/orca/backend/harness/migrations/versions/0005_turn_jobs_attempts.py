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
    op.add_column(
        "turn_jobs",
        sa.Column(
            "attempts",
            sa.Integer(),
            nullable=False,
            server_default="0",
        ),
    )


def downgrade() -> None:
    op.drop_column("turn_jobs", "attempts")
