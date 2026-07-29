# AGENTS.md — Orca Backend (`services/orca/backend/`)

Python 3.12 / FastAPI service. See root `AGENTS.md` first for the
cross-repo request path and the Go↔Python HMAC/schema/guard pair-change
rules — this file does not repeat them. For the `harness/` package
specifically (guards, tools, MCP, sessions, auth, Slack) see
`harness/AGENTS.md`. `services/orca/CLAUDE.md` and `services/orca/AGENT.md`
describe an earlier, pre-harness version of this service (single batch
LangGraph, `create_all()` schema) — several of their claims are superseded
by what's below; when they conflict, this file and the source win.

## Package map

```
app/
  main.py            FastAPI app + lifespan (schema check, secret validation,
                      graph registration, TurnWorker/Slack/AutoTriage/MCP startup)
  config.py           pydantic-settings Settings — all env-var config
  db.py               async_engine, AsyncSessionLocal, Base, get_session()
  schema_check.py     verify_schema_at_head() — Alembic-head defense-in-depth check
  api/
    webhooks.py       POST /webhook/grafana — creates an RCA row, spawns
                      app.agent.graph.run_agent as a FastAPI background task
                      (legacy batch pipeline — NOT the harness/TurnWorker path)
    rca.py            GET/PATCH /api/rca/* — 5 endpoints: list, detail,
                      feedback, /api/stats, /api/filters/values. **No**
                      /start, /refine, /accept, /history, or /search route
                      exists here (see note below) despite
                      `src/services/rcaApi.ts` calling all five
    sessions.py       GET/POST /api/sessions/* — 4 endpoints (list, search,
                      drill-down, feedback); org-scoped via X-Grafana-Org-Id
    identity.py        /api/identity/* — Entra OBO account-linkage (PKCE)
    mcp_servers.py      /api/mcp/* — 6 endpoints for user-configured MCP servers
  agent/
    graph.py          Legacy 5-node batch graph (triage→investigate→analyze→
                      report→publish). Only caller: webhooks.py's background
                      task. Does not go through harness guards or GraphRegistry.
    rca_graph.py       Interactive interrupt/resume LangGraph (996 lines) — the
                      graph registered in GraphRegistry as "investigation" and
                      executed by harness.session.worker.TurnWorker. Routes both
                      built-in Grafana MCP tools and user-configured MCP tools
                      through harness.tools.bridge.GuardedToolExecutor.
    nodes/, prompts/  triage/investigate/analyze/report/publish nodes + their
                      system prompts — used only by the legacy graph.py above.
    mcp/              grafana_client.py / postgres_client.py — LangChain MCP
                      tool loaders (not the harness.mcp package; different concern)
  models/             SQLAlchemy ORM models for the legacy tables (alerts, rcas,
                      agent_steps, rca_session, rca_embedding, ...)
  schemas/            Pydantic request/response schemas (API contracts, not ORM)

harness/              See harness/AGENTS.md
```

### Two independent alert→RCA execution paths (verify before assuming either is dead)

- **Direct webhook path**: `POST /webhook/grafana` → `_run_agent_task` →
  `app.agent.graph.run_agent`. Uses the legacy batch graph directly; never
  touches `GuardPipeline`, `ToolRegistry`, or `TurnWorker`.
- **Harness/session path**: Slack `/obs investigate` and
  `harness.triage.auto_triage.AutoTriageService.handle_alert` both call
  `harness.session.worker.enqueue_turn(...)`, which `TurnWorker` executes
  against `app.agent.rca_graph` (guarded, org-scoped tools).
- `AutoTriageService` is constructed and stored on `app.state.auto_triage`
  in `main.py`'s lifespan, but **nothing in `app/api/webhooks.py` calls
  it** — the webhook endpoint only ever drives the legacy path above. If a
  task asks you to wire auto-triage into the webhook flow, that wiring
  does not exist yet; don't assume it does because the service object
  exists.
- The Sessions UI (`src/pages/SessionPanel.tsx`) calls `postTurn` (→
  `POST /api/sessions/{id}/turns`) and `streamSession` (→
  `GET /api/sessions/{id}/stream`) — **neither route exists** in
  `app/api/sessions.py` today (only `list`, `search`, `drill-down`,
  `feedback` are implemented). `enqueue_turn` is only ever called from
  Slack handlers and `AutoTriageService`, never from an HTTP route. Adding
  those two endpoints (and a way to stream `TurnWorker` progress back to
  the browser) is unimplemented work, not a bug in existing code — check
  current source before describing the Sessions UI as fully wired.
- **The legacy interactive RCA flow is equally broken, and for the same
  structural reason.** `app/api/rca_sessions.py` — which implemented
  `POST /rca/start`, `POST /rca/{tid}/refine`, `POST /rca/{tid}/accept`,
  `GET /rca/{tid}/history`, and `GET /rca/search` (using the
  `app/agent/streaming.py` SSE helpers) — was deleted in the Phase 4
  hardening commit (`0ee5946`, "legacy retirement") and never
  reimplemented. `app/agent/streaming.py`'s `stream_rca_start`/
  `stream_rca_refine` generator functions still exist and are still
  imported by nothing (verified: `app.main`'s registered routes are only
  `GET/PATCH /api/rca`, `/api/rca/{rca_id}`, `/api/rca/{rca_id}/feedback`,
  `/api/stats`, `/api/filters/values` — run `python3 -c "from app.main
  import app; [print(r.methods, r.path) for r in app.routes]"` to
  reverify). `src/services/rcaApi.ts`'s `startRCAStream`, `refineRCAStream`,
  `acceptRCA`, `getHistory`, and `searchRCAs` all target routes that 404
  today, which means `src/pages/RCAInvestigate.tsx` (the entire
  `/rca/investigate/:threadId` interactive flow) cannot complete an
  investigation end-to-end. Only `RCADashboard` (stats), `RCAList`
  (list/search-by-filter), and feedback-on-a-completed-RCA still work.
  Treat any task involving `/rca/investigate` as needing new backend
  routes, not a regression fix in existing plumbing — same caveat as the
  Sessions `turns`/`stream` gap above.

## Invariants

### Schema — Alembic only (see root AGENTS.md §2)
`docker-entrypoint.sh` runs `alembic upgrade head` before `uvicorn` starts.
`app/main.py` calls `schema_check.verify_schema_at_head(conn,
fail_hard=settings.is_production())` in the lifespan — raises
`SchemaRevisionError` (blocks startup) in production on any mismatch, only
logs a warning otherwise. There is no `Base.metadata.create_all()` call
anywhere in the live app. New schema changes are a new file under
`harness/migrations/versions/`.

### `GraphRegistry.aget()` vs `.get()`
`harness/session/registry.py: GraphRegistry` caches compiled graphs keyed
by session type. `app.agent.rca_graph.get_rca_graph` is an **async**
factory (it lazily opens an `AsyncPostgresSaver` connection pool on first
call). `TurnWorker._execute_turn` must call `await graph_registry.aget(...)`
— the sync `get()` raises `TypeError` on an async factory rather than
silently caching an un-awaited coroutine (this used to fail with
`'coroutine' object has no attribute 'ainvoke'`).

### `TurnWorker` locking — non-blocking, transaction-scoped, heartbeated
`harness/session/worker.py` claims a `turn_jobs` row with
`UPDATE ... FOR UPDATE SKIP LOCKED`, commits immediately (durable claim),
then acquires session-level serialization via
`SELECT pg_try_advisory_xact_lock(hashtext(session_id))` on a **separate**
connection (`exec_db`, never the pooled claim connection):
- **Non-blocking** (`pg_try_...`, not `pg_advisory_lock`): if another
  worker/replica already holds the lock for that session, this poll
  returns `False` immediately and the job is requeued
  (`_requeue_busy_job`, which reverses the `attempts` increment so healthy
  contention never counts against the crash-retry budget) — the poll loop
  never blocks on a busy session.
- **Transaction-scoped** (`_xact_lock`, not the session-scoped variant):
  the lock is released purely by ending `exec_db`'s transaction (commit or
  rollback) in the `finally` block — there is no separate `pg_advisory_unlock`
  call that itself has to round-trip successfully, so a crash, raised
  exception, or cancelled coroutine can never leave the lock stuck held.
- **Heartbeated**: a background `_heartbeat_loop` task refreshes
  `claimed_at` every `TURN_JOB_HEARTBEAT_INTERVAL_S` (default 60s) while
  the turn executes, so `_reap_orphaned_jobs` (which resets `claimed` rows
  older than `TURN_JOB_LEASE_TTL_S`, default 600s, back to `pending`, or to
  `failed` past `TURN_JOB_MAX_ATTEMPTS`) never mistakes a long-running-but-
  live turn for a crashed one.

If you touch this file, preserve all three properties together — dropping
any one reintroduces the "two workers running `graph.ainvoke` on the same
LangGraph checkpoint" corruption this design exists to prevent.

### Fail-closed decryption and error handling
- `harness/mcp/crypto.py: decrypt_token` — when `MCP_ENCRYPTION_KEY` is
  configured but decryption fails (rotated key, malformed ciphertext), it
  raises `TokenDecryptionError`; it **never** falls back to returning the
  ciphertext as if it were a usable bearer token. Only the "no key
  configured at all" dev-mode case returns the value unchanged (there was
  never anything encrypted to begin with). Callers must catch
  `TokenDecryptionError` and refuse to connect, not swallow it.
- `app/api/sessions.py` (`list_sessions`, `search_sessions`) distinguishes
  a genuinely empty result (`[]`/`0`, returned normally) from a query/infra
  failure (logged and re-raised as `HTTPException(503)`) — do not collapse
  both into a bare `except: return []`, which was the original bug (silent
  operational blindness).
- `harness/tools/bridge.py: GuardedToolExecutor._run_tool_safely` classifies
  every exception via `harness.tools.error_classification.classify_exception`
  instead of hardcoding `retryable=True` for all failures.

### Production secret validation (see root AGENTS.md §4)
`app/config.py: Settings.validate_production_secrets()`, called from
`main.py`'s lifespan, blocks startup under `ENVIRONMENT=production` if
`OBO_ENCRYPTION_KEY`, `MCP_ENCRYPTION_KEY`, or `AGENT_INTERNAL_SECRET` is
empty or a known dev default.

## Test layout (from `services/orca/backend/`)

```
tests/unit/            Fast, mocked — one dir per harness subpackage
                       (auth/, compaction/, guards/, mcp_client/, session/,
                       skills/, slack/, tools/, triage/) plus top-level
                       app/-focused files (test_graph.py, test_config.py, ...)
tests/integration/     Real Postgres (Testcontainers) — org isolation,
                       webhook→RCA, Grafana MCP/permissions, session API
tests/security/        test_injection_redteam.py, test_secret_redaction.py
tests/characterization/ Golden-transcript tests against FakeProvider
tests/llm/             LLM provider contract tests
tests/eval/            test_eval_regression.py
tests/load/            Locust suite (locustfile.py, assert_p95.py) — run via
                       CI's workflow_dispatch load-test.yml, not in normal CI
```

`tests/conftest.py` spins up a session-scoped `PostgresContainer` and runs
the full Alembic chain against it (not `create_all`) — schema drift between
migrations and ORM models fails here, in CI, not silently in production.

```bash
# Fast suite (matches CI / root AGENTS.md)
pytest tests/unit/ tests/llm/ tests/security/ tests/characterization/ \
  --cov=harness --cov-fail-under=85 -q

# Everything, including Testcontainers-backed integration tests
pytest tests/ -q

# Type checking (strict; tests/ excluded)
mypy app/ harness/
```

`pyproject.toml`'s `[tool.coverage.run]` omits `harness/mcp/client_manager.py`
and the vendor LLM adapters from the coverage gate (network transport,
integration-tested against live servers instead of unit-mocked).
