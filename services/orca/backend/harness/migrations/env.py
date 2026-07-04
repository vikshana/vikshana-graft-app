"""Alembic environment configuration for the Orca/harness service.

Uses the app's SQLAlchemy async engine and metadata for both offline
(SQL script generation) and online (direct DB connection) migrations.

LangGraph checkpoint tables (checkpoints, checkpoint_blobs, etc.) are
created by the checkpointer itself via ``checkpointer.setup()`` and must
NOT be managed by Alembic.  They are excluded from autogenerate.
"""

from __future__ import annotations

import asyncio
import os
from logging.config import fileConfig

from alembic import context
from sqlalchemy import engine_from_config, pool
from sqlalchemy.ext.asyncio import async_engine_from_config

# ---------------------------------------------------------------------------
# Import all models so Alembic sees their metadata
# ---------------------------------------------------------------------------
# App models (existing)
import app.models.alert  # noqa: F401
import app.models.agent_step  # noqa: F401
import app.models.rca  # noqa: F401
import app.models.rca_duplicate_alert  # noqa: F401
import app.models.rca_embedding  # noqa: F401
import app.models.rca_session  # noqa: F401

from app.db import Base

# ---------------------------------------------------------------------------
# Alembic Config
# ---------------------------------------------------------------------------
config = context.config

# Interpret the config file for Python logging.
if config.config_file_name is not None:
    fileConfig(config.config_file_name)

# Use the app's declarative Base metadata
target_metadata = Base.metadata

# Tables created by LangGraph's checkpointer — excluded from autogenerate
# so Alembic never tries to drop them.
_LANGGRAPH_TABLES: set[str] = {
    "checkpoints",
    "checkpoint_blobs",
    "checkpoint_writes",
    "checkpoint_migrations",
}


def include_object(
    obj: object,
    name: str,
    type_: str,
    reflected: bool,
    compare_to: object,
) -> bool:
    """Exclude LangGraph-managed tables from Alembic autogenerate.

    Args:
        obj: The schema object.
        name: Object name.
        type_: Object type (e.g. "table").
        reflected: Whether this object was reflected from DB.
        compare_to: The compare target.

    Returns:
        True to include the object in migrations, False to skip.
    """
    if type_ == "table" and name in _LANGGRAPH_TABLES:
        return False
    return True


def get_url() -> str:
    """Resolve the database URL for Alembic.

    Priority: ALEMBIC_DATABASE_URL env var → DATABASE_URL env var → alembic.ini value.
    We convert the asyncpg URL to a sync psycopg URL for Alembic's sync engine.

    Returns:
        Synchronous PostgreSQL connection string.
    """
    url = (
        os.environ.get("ALEMBIC_DATABASE_URL")
        or os.environ.get("DATABASE_URL")
        or config.get_main_option("sqlalchemy.url", "")
    )
    # Alembic needs a sync driver; swap asyncpg for psycopg2
    return (
        url
        .replace("postgresql+asyncpg://", "postgresql://")
        .replace("postgresql+psycopg://", "postgresql://")
    )


def run_migrations_offline() -> None:
    """Run migrations in 'offline' mode (SQL script output only).

    Configures the context with just a URL and generates SQL without a
    DB connection.
    """
    url = get_url()
    context.configure(
        url=url,
        target_metadata=target_metadata,
        literal_binds=True,
        dialect_opts={"paramstyle": "named"},
        include_object=include_object,
        compare_type=True,
    )
    with context.begin_transaction():
        context.run_migrations()


def do_run_migrations(connection: object) -> None:
    """Execute migrations with a live connection.

    Args:
        connection: SQLAlchemy Connection object.
    """
    context.configure(
        connection=connection,
        target_metadata=target_metadata,
        include_object=include_object,
        compare_type=True,
    )
    with context.begin_transaction():
        context.run_migrations()


async def run_migrations_online() -> None:
    """Run migrations in 'online' mode with a live DB connection."""
    configuration = config.get_section(config.config_ini_section) or {}
    configuration["sqlalchemy.url"] = get_url()

    connectable = async_engine_from_config(
        configuration,
        prefix="sqlalchemy.",
        poolclass=pool.NullPool,
    )
    async with connectable.connect() as connection:
        await connection.run_sync(do_run_migrations)
    await connectable.dispose()


if context.is_offline_mode():
    run_migrations_offline()
else:
    asyncio.run(run_migrations_online())
