# ADR-003: Worker Queue Design

**Date:** 2026-07-04
**Status:** Accepted

## Context

For thousands of concurrent sessions, the current `asyncio.create_task()` approach has no cross-process coordination. Sessions are tied to the process that started them; a restart loses in-flight work.

## Decision

Implement a Postgres job queue using `FOR UPDATE SKIP LOCKED` (Phase 1):
- `turn_jobs` table: pending/claimed/done/failed
- Any worker replica can claim and execute any pending job
- `pg_advisory_xact_lock(session_id_hash)` ensures exactly one active turn per session
- Concurrent turn requests for the same session queue and emit `agent_busy` SSE

Future path: migrate job queue to WarpStream/Kafka if Postgres throughput becomes a bottleneck. Postgres is sufficient for thousands of sessions; Kafka-class throughput is only needed at tens of thousands of concurrent sessions.

## Consequences

- Stateless FastAPI workers → horizontal scaling = add replicas
- No in-process session affinity → restart-safe
- Slightly higher per-turn latency due to poll loop (200ms default, configurable)
- Postgres becomes the coordination point; its availability is the system's availability
