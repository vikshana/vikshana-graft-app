"""Regression tests for F3/F13 (docs/harness-risk-review.md).

Alembic must be the sole schema authority in production:

- ``app/main.py`` must never call ``Base.metadata.create_all`` or run
  ad-hoc ``ALTER TABLE`` statements at startup.
- The Docker image must ship ``alembic.ini`` + migrations and run
  ``alembic upgrade head`` via a runnable entrypoint before uvicorn starts.
- ``app/schema_check.py`` provides a production-safe startup revision
  check: fail hard in production on a schema mismatch, warn (don't
  crash) in development so bare-metal dev workflows keep working.

These tests are deliberately DB-light (SQLite via aiosqlite, no
Postgres/testcontainers) so they run in any environment without Docker.
"""

from __future__ import annotations

import inspect
import stat
from pathlib import Path

import pytest
from sqlalchemy import text
from sqlalchemy.ext.asyncio import create_async_engine

from app import main as app_main
from app.schema_check import (
    SchemaRevisionError,
    get_db_revision,
    get_head_revision,
    verify_schema_at_head,
)

_BACKEND_DIR = Path(__file__).resolve().parent.parent.parent


async def _sqlite_engine():
    return create_async_engine("sqlite+aiosqlite:///:memory:", echo=False)


async def _seed_alembic_version(conn, revision: str) -> None:
    """Create a minimal ``alembic_version`` table on ``conn`` with one row."""
    await conn.execute(
        text("CREATE TABLE alembic_version (version_num VARCHAR(32) NOT NULL)")
    )
    await conn.execute(
        text("INSERT INTO alembic_version (version_num) VALUES (:rev)"),
        {"rev": revision},
    )
    await conn.commit()


# ---------------------------------------------------------------------------
# app/schema_check.py — the production-safe startup revision check
# ---------------------------------------------------------------------------


class TestGetHeadRevision:
    def test_resolves_a_head_from_the_packaged_alembic_ini(self) -> None:
        head = get_head_revision()
        assert head is not None
        assert isinstance(head, str)


class TestVerifySchemaAtHead:
    async def test_passes_silently_when_db_matches_head(self) -> None:
        head = get_head_revision()
        assert head is not None
        engine = await _sqlite_engine()
        try:
            async with engine.connect() as conn:
                await _seed_alembic_version(conn, head)
                assert await get_db_revision(conn) == head
                # Must not raise, regardless of fail_hard.
                await verify_schema_at_head(conn, fail_hard=True)
                await verify_schema_at_head(conn, fail_hard=False)
        finally:
            await engine.dispose()

    async def test_fail_hard_raises_on_stale_revision(self) -> None:
        engine = await _sqlite_engine()
        try:
            async with engine.connect() as conn:
                await _seed_alembic_version(conn, "0001")
                with pytest.raises(SchemaRevisionError):
                    await verify_schema_at_head(conn, fail_hard=True)
        finally:
            await engine.dispose()

    async def test_fail_hard_raises_when_never_migrated(self) -> None:
        """No ``alembic_version`` table at all (entrypoint never ran)."""
        engine = await _sqlite_engine()
        try:
            async with engine.connect() as conn:
                assert await get_db_revision(conn) is None
                with pytest.raises(SchemaRevisionError):
                    await verify_schema_at_head(conn, fail_hard=True)
        finally:
            await engine.dispose()

    async def test_dev_mode_warns_but_does_not_raise_on_mismatch(self) -> None:
        """fail_hard=False (development) must never block startup."""
        engine = await _sqlite_engine()
        try:
            async with engine.connect() as conn:
                await _seed_alembic_version(conn, "0001")
                await verify_schema_at_head(conn, fail_hard=False)  # no raise
        finally:
            await engine.dispose()

    async def test_dev_mode_does_not_raise_when_never_migrated(self) -> None:
        engine = await _sqlite_engine()
        try:
            async with engine.connect() as conn:
                await verify_schema_at_head(conn, fail_hard=False)  # no raise
        finally:
            await engine.dispose()


# ---------------------------------------------------------------------------
# app/main.py — dual schema authority must not regress
# ---------------------------------------------------------------------------


class TestMainLifespanNoLongerMutatesSchema:
    """Guard against re-introducing create_all()/ad-hoc ALTER TABLE (F3/F13)."""

    def test_lifespan_source_has_no_create_all(self) -> None:
        source = inspect.getsource(app_main)
        assert "create_all" not in source

    def test_lifespan_source_has_no_ad_hoc_alter_table(self) -> None:
        source = inspect.getsource(app_main)
        assert "ALTER TABLE" not in source

    def test_lifespan_source_has_no_create_extension(self) -> None:
        # Extensions (pg_trgm, vector) are installed by Alembic migration
        # 0001, not by the app at runtime.
        source = inspect.getsource(app_main)
        assert "CREATE EXTENSION" not in source

    def test_lifespan_calls_schema_check(self) -> None:
        source = inspect.getsource(app_main)
        assert "verify_schema_at_head" in source

    def test_main_no_longer_imports_declarative_base(self) -> None:
        # `Base` was only imported for create_all(); its removal is a
        # canary that the schema-authority refactor stayed intact.
        assert "Base" not in app_main.__dict__


# ---------------------------------------------------------------------------
# Docker image — alembic config/migrations + runnable entrypoint (F3/F13)
# ---------------------------------------------------------------------------


class TestDockerShipsAlembicAndEntrypoint:
    def _dockerfile_text(self) -> str:
        return (_BACKEND_DIR / "Dockerfile").read_text()

    def test_dockerfile_copies_alembic_ini(self) -> None:
        assert "COPY alembic.ini" in self._dockerfile_text()

    def test_dockerfile_copies_harness_migrations(self) -> None:
        # harness/ is copied wholesale, which includes harness/migrations.
        assert "COPY harness/ ./harness/" in self._dockerfile_text()
        assert (_BACKEND_DIR / "harness" / "migrations" / "env.py").exists()
        assert (_BACKEND_DIR / "harness" / "migrations" / "versions").is_dir()

    def test_dockerfile_installs_runnable_entrypoint(self) -> None:
        content = self._dockerfile_text()
        assert "docker-entrypoint.sh" in content
        assert "ENTRYPOINT" in content

    def test_entrypoint_script_exists_and_is_executable(self) -> None:
        entrypoint = _BACKEND_DIR / "docker-entrypoint.sh"
        assert entrypoint.exists()
        mode = entrypoint.stat().st_mode
        assert mode & stat.S_IXUSR, "docker-entrypoint.sh must be executable"

    def test_entrypoint_runs_alembic_upgrade_head_before_exec(self) -> None:
        entrypoint = _BACKEND_DIR / "docker-entrypoint.sh"
        content = entrypoint.read_text()
        upgrade_idx = content.find("alembic upgrade head")
        exec_idx = content.find('exec "$@"')
        assert upgrade_idx != -1, "entrypoint must run `alembic upgrade head`"
        assert exec_idx != -1, "entrypoint must exec the passed-through CMD"
        assert upgrade_idx < exec_idx, (
            "migrations must run before the application process starts"
        )
