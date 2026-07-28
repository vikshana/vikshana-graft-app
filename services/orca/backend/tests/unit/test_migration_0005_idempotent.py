"""Regression test: migration 0005 must be idempotent against a
``turn_jobs`` table that already has the ``attempts`` column
(docs/harness-risk-review.md F3/F13 -- "existing create_all databases").

The ORM ``TurnJob`` model (``harness/session/models.py``) already declares
``attempts``, so a dev/legacy database whose schema was bootstrapped via
``Base.metadata.create_all()`` before Alembic became the sole schema
authority may already have this column. Migration 0005 must therefore use
idempotent DDL (``ADD COLUMN IF NOT EXISTS`` / ``DROP COLUMN IF EXISTS``)
rather than ``op.add_column``/``op.drop_column``, which raise
"column already exists" / "column does not exist" against such a database
-- causing ``alembic upgrade head`` to fail outright the first time it runs
there.

This test is deliberately DB-light (source inspection only, no
Postgres/testcontainers needed -- SQLite doesn't support the
``IF NOT EXISTS``/``IF EXISTS`` column clauses used here, so a real
functional idempotency check requires Postgres) so it runs in any
environment, matching the style of ``tests/unit/test_schema_authority.py``.
"""

from __future__ import annotations

import importlib
import inspect

_MODULE_NAME = "harness.migrations.versions.0005_turn_jobs_attempts"


def _migration_source() -> str:
    module = importlib.import_module(_MODULE_NAME)
    return inspect.getsource(module)


class TestMigration0005Idempotent:
    def test_upgrade_uses_add_column_if_not_exists(self) -> None:
        """upgrade() must not use `op.add_column`, which raises
        "column already exists" against a create_all()-provisioned DB that
        already has `attempts` (the ORM model declares it)."""
        source = _migration_source()
        assert "ADD COLUMN IF NOT EXISTS attempts" in source
        assert "op.add_column(" not in source

    def test_downgrade_uses_drop_column_if_exists(self) -> None:
        """downgrade() must not use `op.drop_column`, which raises
        "column does not exist" if `attempts` was never added by this
        migration (e.g. it pre-existed from create_all())."""
        source = _migration_source()
        assert "DROP COLUMN IF EXISTS attempts" in source
        assert "op.drop_column(" not in source

    def test_upgrade_and_downgrade_are_plain_sql_via_op_execute(self) -> None:
        """Both directions go through `op.execute(sa.text(...))`, matching
        the idempotent-DDL idiom already used by migrations 0001/0002 for
        this exact "may already exist" scenario."""
        module = importlib.import_module(_MODULE_NAME)
        source = inspect.getsource(module)
        assert source.count("op.execute(sa.text(") >= 2

    def test_revision_chain_unchanged(self) -> None:
        """This fix must not change the migration's identity/position in
        the revision chain."""
        module = importlib.import_module(_MODULE_NAME)
        assert module.revision == "0005"
        assert module.down_revision == "0004"

    def test_upgrade_and_downgrade_are_idempotent_when_called_twice_against_a_stub(self) -> None:
        """Exercise upgrade()/downgrade() twice against a minimal fake
        Alembic `op` that just records executed SQL (no real DB) --
        proving both are pure, side-effect-free-on-repeat statement
        generators with no assumption that the column is (or isn't)
        already present.
        """
        module = importlib.import_module(_MODULE_NAME)

        executed: list[str] = []

        class _FakeOp:
            @staticmethod
            def execute(clause) -> None:
                executed.append(str(clause))

        original_op = module.op
        try:
            module.op = _FakeOp()
            module.upgrade()
            module.upgrade()  # must not raise the second time
            module.downgrade()
            module.downgrade()  # must not raise the second time
        finally:
            module.op = original_op

        assert executed.count(
            "ALTER TABLE turn_jobs ADD COLUMN IF NOT EXISTS attempts "
            "INTEGER NOT NULL DEFAULT 0"
        ) == 2
        assert executed.count(
            "ALTER TABLE turn_jobs DROP COLUMN IF EXISTS attempts"
        ) == 2
