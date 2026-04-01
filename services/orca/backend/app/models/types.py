"""Shared SQLAlchemy column types that work across different database dialects.

These types enable the SQLite test database to work alongside the production
PostgreSQL database without any code changes in the tests.
"""

import uuid

import sqlalchemy
from sqlalchemy import JSON, CHAR
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.types import TypeDecorator


class UUIDType(TypeDecorator):
    """Platform-independent UUID type.

    Uses PostgreSQL's native UUID type on PostgreSQL, and CHAR(36) storing the
    UUID as a plain string on other dialects (e.g., SQLite used in tests).
    """

    impl = CHAR
    cache_ok = True

    def load_dialect_impl(self, dialect: sqlalchemy.engine.Dialect) -> sqlalchemy.types.TypeEngine:
        """Use native UUID on PostgreSQL, CHAR(36) elsewhere."""
        if dialect.name == "postgresql":
            from sqlalchemy.dialects.postgresql import UUID as PgUUID
            return dialect.type_descriptor(PgUUID(as_uuid=True))
        return dialect.type_descriptor(CHAR(36))

    def process_bind_param(
        self, value: uuid.UUID | str | None, dialect: sqlalchemy.engine.Dialect
    ) -> str | None:
        """Convert UUID to string for storage."""
        if value is None:
            return None
        return str(value)

    def process_result_value(
        self, value: str | None, dialect: sqlalchemy.engine.Dialect
    ) -> uuid.UUID | None:
        """Convert stored string back to UUID object."""
        if value is None:
            return None
        if isinstance(value, uuid.UUID):
            return value
        return uuid.UUID(str(value))


# Use JSONB on PostgreSQL, fall back to JSON on other dialects (e.g. SQLite in tests)
JsonType = JSONB().with_variant(JSON(), "sqlite")

