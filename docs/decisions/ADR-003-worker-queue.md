# ADR-003: Worker Queue Design

**Date:** 2026-07-04
**Status:** Accepted (amended `61534e4`, 2026-07-28 — see Amendment below)

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

---

## Amendment (`61534e4`): non-blocking lock, busy-requeue, heartbeat

The original `pg_advisory_xact_lock` design above had a concurrency bug
(tracked as F2 in `docs/harness-risk-review.md`): the worker committed the
claiming transaction immediately after acquiring the lock, which released
it *before* the turn actually executed — so two workers could run
`graph.ainvoke()` concurrently against the same session's LangGraph
checkpoint. Commit `61534e4` replaced the locking design as follows
(`harness/session/worker.py`):

- **Claim and lock are separate transactions.** The claim (`SELECT ... FOR
  UPDATE SKIP LOCKED`, status → `claimed`) commits immediately on a pooled
  connection, independent of how long the turn takes. Session-level
  serialization is then acquired separately, on a **dedicated execution
  connection**, and held for the full duration of `_execute_turn`.
- **The lock is non-blocking:** `pg_try_advisory_xact_lock(hashtext(session_id))`,
  not the blocking `pg_advisory_xact_lock`/`pg_advisory_lock`. If another
  worker (possibly another replica) already holds the lock for this
  session, the job is immediately returned to `pending`
  (`_requeue_busy_job`) instead of blocking the poll loop or tying up a
  pooled connection for the duration of someone else's turn. This is a
  belt-and-suspenders safety net *in addition to* the `agent_busy`
  short-circuit described above, which is a separate check
  (`enqueue_turn` counting already-`claimed` rows for the session) done
  before a job is even inserted — the non-blocking lock is what makes it
  safe if that count-based check ever races (e.g. two enqueue calls land
  concurrently, or the orphan reaper requeues a job while its original
  worker is still finishing up).
- **The lock is transaction-scoped**, so it is released purely by ending
  that one transaction (commit *or* rollback) once the turn finishes, by
  any means (success, failure, cancellation, or a killed process) — there
  is no separate unlock statement that itself has to round-trip
  successfully to Postgres, and no risk of a session-level lock surviving
  under a transaction-pooling connection pooler (e.g. PgBouncer).
- **A background heartbeat** (`_heartbeat_loop`, default interval
  `TURN_JOB_HEARTBEAT_INTERVAL_S=60`) refreshes the claimed job's
  `claimed_at` for as long as the turn is actually executing, so the
  orphan reaper (`_reap_orphaned_jobs`, `TURN_JOB_LEASE_TTL_S=600` default)
  never mistakes a live, long-running turn for a crashed one and requeues
  it out from under the worker still executing it.

Net effect: "exactly one active turn per session" now holds under
concurrent claims (including across replicas), a contended session never
blocks the poll loop, and a legitimately long-running turn is never
requeued while its own worker still holds the lock. See
`ARCHITECTURE.md` § TurnWorker Concurrency Model and
`docs/harness-risk-review.md` (F2, F11) for full detail.
