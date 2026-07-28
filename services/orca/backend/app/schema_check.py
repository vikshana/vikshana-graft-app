"""Startup check verifying the database schema matches the Alembic head revision.

Schema management for Orca is owned exclusively by Alembic (see
``docker-entrypoint.sh``, which runs ``alembic upgrade head`` before the
application process starts — see docs/harness-risk-review.md F3/F13).
``app/main.py`` no longer creates or mutates schema at runtime.

This module provides a defense-in-depth check invoked from the app
lifespan: if the running database's recorded Alembic revision doesn't
match the head revision shipped in this image, the application refuses
to serve traffic in production rather than operate against a stale or
partial schema. In non-production environments the mismatch is only
logged, preserving bare-metal developer workflows that run
``uvicorn app.main:app --reload`` directly without a container entrypoint.
"""

from __future__ import annotations

from pathlib import Path

import structlog
from alembic.config import Config as AlembicConfig
from alembic.runtime.migration import MigrationContext
from alembic.script import ScriptDirectory
from sqlalchemy.engine import Connection
from sqlalchemy.ext.asyncio import AsyncConnection

logger = structlog.get_logger()

# services/orca/backend/alembic.ini — one level up from app/.
DEFAULT_ALEMBIC_INI = Path(__file__).resolve().parent.parent / "alembic.ini"


class SchemaRevisionError(RuntimeError):
    """Raised when the database schema is not at the expected Alembic head."""


def get_head_revision(alembic_ini_path: Path | str = DEFAULT_ALEMBIC_INI) -> str | None:
    """Return the head revision id from the packaged Alembic migrations.

    Args:
        alembic_ini_path: Path to ``alembic.ini``. Defaults to the copy
            shipped alongside this backend (also what ships in the
            production Docker image).

    Returns:
        The single head revision id, or None if no migrations exist.

    Raises:
        alembic.util.exc.CommandError: If multiple independent migration
            heads exist (branched history) — this is a configuration error
            that should be fixed rather than silently picking one.
    """
    cfg = AlembicConfig(str(alembic_ini_path))
    script = ScriptDirectory.from_config(cfg)
    return script.get_current_head()


def _get_db_revision_sync(sync_connection: Connection) -> str | None:
    """Return the current Alembic revision recorded in the database.

    Args:
        sync_connection: A synchronous SQLAlchemy Connection (obtained via
            ``AsyncConnection.run_sync``).

    Returns:
        The revision id stored in ``alembic_version``, or None if the
        table is missing or empty (i.e. migrations have never been run).
    """
    context = MigrationContext.configure(sync_connection)
    return context.get_current_revision()


async def get_db_revision(conn: AsyncConnection) -> str | None:
    """Return the current Alembic revision recorded in the database.

    Args:
        conn: An active AsyncConnection to the application database.

    Returns:
        The revision id, or None if the database has never been migrated.
    """
    return await conn.run_sync(_get_db_revision_sync)


async def verify_schema_at_head(
    conn: AsyncConnection,
    *,
    fail_hard: bool,
    alembic_ini_path: Path | str = DEFAULT_ALEMBIC_INI,
) -> None:
    """Verify the database schema matches the packaged Alembic head revision.

    ``alembic upgrade head`` is expected to have already run (via
    ``docker-entrypoint.sh``) before this function is called. This check
    catches the case where that step was skipped, failed silently, or the
    running image's migrations diverge from what was actually applied to
    the database.

    Args:
        conn: An active AsyncConnection to the application database.
        fail_hard: When True, raise ``SchemaRevisionError`` on a mismatch
            (used in production). When False, only log a warning
            (development), so bare-metal dev workflows that haven't run
            Alembic yet are not blocked from starting.
        alembic_ini_path: Path to ``alembic.ini``.

    Raises:
        SchemaRevisionError: If ``fail_hard`` is True and the schema is
            not at the expected head revision.
    """
    head_rev = get_head_revision(alembic_ini_path)
    db_rev = await get_db_revision(conn)

    if db_rev == head_rev:
        logger.info("alembic_schema_at_head", revision=db_rev)
        return

    message = (
        f"Database schema revision {db_rev!r} does not match the expected "
        f"Alembic head {head_rev!r}. Run `alembic upgrade head` before "
        f"starting the application."
    )
    if fail_hard:
        logger.error(
            "alembic_schema_mismatch", db_revision=db_rev, head_revision=head_rev
        )
        raise SchemaRevisionError(message)

    logger.warning(
        "alembic_schema_mismatch", db_revision=db_rev, head_revision=head_rev
    )
