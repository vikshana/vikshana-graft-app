"""Harness Phase 3 — Slack identity linkage and event deduplication tables.

Adds:
  1. identity_link_requests — PKCE state for Entra identity linkage (Task 3.1)
  2. slack_events           — Slack event-ID deduplication store (Task 3.2)

Revision ID: 0003
Revises: 0002
Create Date: 2026-07-04
"""

from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision: str = "0003"
down_revision: Union[str, None] = "0002"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Create Phase 3 tables."""
    # ── identity_link_requests ────────────────────────────────────────────
    # Stores short-lived PKCE state for the Slack → Entra identity linkage flow.
    # Each row is created when a Slack user runs /obs link and consumed
    # (used_at set) when the OAuth callback completes.
    op.create_table(
        "identity_link_requests",
        sa.Column(
            "id",
            sa.String(36),
            nullable=False,
            server_default=sa.text("gen_random_uuid()::text"),
        ),
        sa.Column("slack_user_id", sa.String(50), nullable=False),
        sa.Column("slack_team_id", sa.String(50), nullable=False),
        # PKCE S256: random 43-128 char URL-safe base64 strings
        sa.Column("pkce_state", sa.String(256), nullable=False),
        sa.Column("pkce_verifier", sa.String(256), nullable=False),
        sa.Column("expires_at", sa.TIMESTAMP(timezone=True), nullable=False),
        sa.Column("used_at", sa.TIMESTAMP(timezone=True), nullable=True),
        sa.Column(
            "created_at",
            sa.TIMESTAMP(timezone=True),
            nullable=False,
            server_default=sa.text("now()"),
        ),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("pkce_state", name="uq_identity_link_state"),
    )
    op.create_index(
        "idx_identity_link_state",
        "identity_link_requests",
        ["pkce_state"],
    )
    op.create_index(
        "idx_identity_link_slack_user",
        "identity_link_requests",
        ["slack_user_id", "slack_team_id"],
    )

    # ── slack_events ──────────────────────────────────────────────────────
    # Idempotency store for Slack event IDs.  Rows older than 7 days are pruned
    # on insert by the application (lazy TTL — no background job needed).
    op.create_table(
        "slack_events",
        sa.Column("event_id", sa.String(100), nullable=False),
        sa.Column(
            "created_at",
            sa.TIMESTAMP(timezone=True),
            nullable=False,
            server_default=sa.text("now()"),
        ),
        sa.PrimaryKeyConstraint("event_id"),
    )
    op.create_index(
        "idx_slack_events_created",
        "slack_events",
        ["created_at"],
    )


def downgrade() -> None:
    """Drop Phase 3 tables."""
    op.drop_index("idx_slack_events_created", table_name="slack_events")
    op.drop_table("slack_events")

    op.drop_index("idx_identity_link_slack_user", table_name="identity_link_requests")
    op.drop_index("idx_identity_link_state", table_name="identity_link_requests")
    op.drop_table("identity_link_requests")
