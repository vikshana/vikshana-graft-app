# ADR-008 — Testcontainers for PostgreSQL in Tests

**Status**: Accepted
**Date**: 2026-07-04
**Phase**: 4

## Context

The test suite used `sqlite+aiosqlite` as the test database engine.  This caused 9 pre-existing failures in `test_dedup.py` because the pgvector `<=>` cosine distance operator is not available in SQLite, and `FOR UPDATE SKIP LOCKED` behaviour could not be validated.

## Decision

Replace SQLite with a real PostgreSQL 16 container managed by `testcontainers[postgres]>=4.8`.

### Implementation

```python
@pytest.fixture(scope="session")
def pg_container():
    with PostgresContainer("postgres:16-alpine", driver="asyncpg") as pg:
        yield pg

@pytest_asyncio.fixture(scope="session")
async def test_engine(pg_container):
    url = pg_container.get_connection_url()   # → postgresql+asyncpg://...
    sync_url = url.replace("+asyncpg", "")   # Alembic uses a sync engine
    subprocess.run(["alembic", "upgrade", "head"], env={..., "DATABASE_URL": sync_url})
    engine = create_async_engine(url)
    yield engine
    await engine.dispose()
```

### Why no psycopg2

`testcontainers[postgres]` manages the container lifecycle via the Docker socket — it does **not** import or use psycopg2.  The `driver` constructor parameter is purely a URL string formatter: `driver="asyncpg"` causes `get_connection_url()` to return `postgresql+asyncpg://...` directly.  No extra drivers beyond `asyncpg` (already a runtime dep) are needed.

### Why Alembic instead of `Base.metadata.create_all`

Running `alembic upgrade head` in the test fixture acts as a smoke test for the migration chain.  If any migration is broken, tests fail at setup rather than with cryptic `ProgrammingError` at runtime.

## Consequences

- All pre-existing pgvector failures in `test_dedup.py` resolve
- Alembic migration chain is smoke-tested on every CI run
- CI needs Docker socket access (available on all GitHub Actions `ubuntu-latest` runners)
- `aiosqlite` removed from dev dependencies
- Test startup ~3s slower on first run (Docker image pull is cached after first use)
