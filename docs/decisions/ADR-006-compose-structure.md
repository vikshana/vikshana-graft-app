# ADR-006: Dev Compose File Location

**Date:** 2026-07-04
**Status:** Accepted

## Context

The implementation plan spec mentioned creating `deploy/dev/docker-compose.yml` as a new file. The repository already has a root-level `docker-compose.yaml` that serves as the complete dev stack.

## Decision

Extend the existing root `docker-compose.yaml` in place rather than creating `deploy/dev/docker-compose.yml`.

Rationale:
- `npm run server` references the root compose; changing its location would require updating multiple scripts
- Creating a parallel file risks divergence and confusion
- All existing team muscle memory uses `docker compose up` at the repo root

## Consequences

- The root `docker-compose.yaml` grows to include Langfuse and mock-oauth2-server
- mock-oauth2-server is gated behind `--profile auth-spike` to keep normal startup lightweight
- `docs/decisions/ADR-006` documents this deviation from the plan spec
