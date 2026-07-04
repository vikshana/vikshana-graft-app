# ADR-004: Data Store — Postgres + pgvector

**Date:** 2026-07-04
**Status:** Accepted

## Context

During planning, MongoDB was briefly considered as an alternative to Postgres's inline migration pattern.

## Decision

Retain Postgres + pgvector. Adopt Alembic for all future migrations.

Rationale:
- `langgraph-checkpoint-postgres` uses Postgres natively; replacing it would require a custom LangGraph saver
- pgvector provides the semantic similarity search needed for historical RCA context without a separate vector database
- Alembic solves the migration-history and rollback gap without changing the database engine
- MongoDB offers no advantage for this workload and would require significant rewrite

PII/data-residency concern: Noted in this ADR. Self-hosted Postgres + a self-hosted embedding model is the recommended path for tenants with data-residency requirements, rather than introducing a separate SaaS-hosted vector store.

## Consequences

- Alembic manages schema from Phase 0 onward; inline ALTER TABLE removed from lifespan
- `langgraph-checkpoint-postgres` tables are excluded from Alembic autogenerate
- pgvector extension is enabled via Alembic 0001 migration
