# ORCA Production Readiness — Gap Analysis

Comprehensive audit of what is missing or broken before the ORCA/RCA integration can be considered production-ready. Covers the full stack: Grafana plugin frontend, Go proxy backend, ORCA FastAPI backend, infrastructure, tests, and documentation.

Severity labels: **Critical** (broken today, silently wrong), **High** (security or data-loss risk), **Medium** (significant UX or operational gap), **Low** (polish, hygiene).

---

## 1. Critical Blockers

These items are broken or would silently produce wrong results in production.

---

### 1.1 Semantic search is non-functional — `embed_text` is a SHA-256 stub

**File:** `services/orca/backend/agent/historical_context.py:29–63`  
**Severity:** Critical

The `embed_text` function that powers historical RCA context and semantic search does not call any embedding model. It uses `hashlib.sha256` plus trigonometric transforms to produce 1536-dimensional vectors with no semantic meaning. The comment in the code explicitly flags this:

> "Replace this with a real embedding model call in production."

The `_embed_model` variable is initialised as a `ChatAnthropic` instance but is never called — it is dead code. Every cosine similarity search in `rca_sessions.py` and `gather_historical_context` returns results based on hash proximity, not semantic similarity. The "find similar past incidents" feature is entirely non-functional.

**What's needed:**
- Replace `embed_text` with a real embedding model call (e.g. `text-embedding-3-small` via OpenAI, or a self-hosted model via `sentence-transformers`).
- Add `ORCA_EMBEDDING_MODEL` and `ORCA_EMBEDDING_API_KEY` to `config.py` and `.env.example`.
- Add integration tests that verify cosine similarity returns semantically related records.

---

### 1.2 Completed sessions are unrecoverable — `thread_id=None` in `_persist_rca_session`

**File:** `services/orca/backend/agent/rca_graph.py:732`  
**Severity:** Critical

`_persist_rca_session` creates every `RCASession` record with `thread_id=None`. The comment says "set by caller if available" but the only caller (`finalize_node`) never sets it. The `GET /api/rca/{thread_id}/history` endpoint's DB fallback path looks up records by `thread_id` UUID — it will never find a `rca_sessions` record because all of them have `thread_id=NULL`. Once an investigation completes and the LangGraph checkpoint is evicted, the history is permanently inaccessible via the investigate page.

**What's needed:**
- Pass `thread_id` through from `finalize_node` into `_persist_rca_session`.
- Add a migration to backfill the column if records already exist.
- Add an integration test that starts an investigation, completes it, and verifies `/history` returns the report.

---

### 1.3 Stream cancellation is non-functional — `AbortController` signal never passed to `fetch`

**File:** `src/pages/RCAInvestigate.tsx:120–133`, `src/services/rcaApi.ts:181–202`  
**Severity:** Critical

`abortRef.current = new AbortController()` is created in `handleStart` and `handleRefine`, but `startRCAStream` and `refineRCAStream` in `rcaApi.ts` never receive or use the signal. The `fetch()` calls have no abort hook. Consequences:

1. Navigating away from the investigation page mid-stream does not cancel the fetch. The stream continues running in the background.
2. React `setState` calls fire on an unmounted component, producing warnings in development and potential memory leaks in production.
3. The "stop" affordance has no effect on the underlying network request.

**What's needed:**
- Add `signal?: AbortSignal` parameter to `startRCAStream` and `refineRCAStream`.
- Pass `abortRef.current.signal` from `RCAInvestigate.tsx` to both functions.
- Add a `useEffect` cleanup that calls `abortRef.current?.abort()` on component unmount.
- Add a test that verifies abort cancels the fetch.

---

### 1.4 Race condition on startup — `init_rca_graph` has no async lock

**File:** `services/orca/backend/agent/rca_graph.py:109–120`  
**Severity:** Critical

```python
async def get_rca_graph() -> Any:
    if _compiled_graph is None:
        return await init_rca_graph()
    return _compiled_graph
```

If two concurrent requests arrive before the lifespan `init_rca_graph()` completes, both see `_compiled_graph is None`, both call `init_rca_graph()`, and two connection pools plus checkpointer instances are created. The second overwrites the global, leaking the first pool's connections permanently.

**What's needed:**
- Wrap with `asyncio.Lock`: initialise a module-level `_init_lock = asyncio.Lock()` and `async with _init_lock:` guard the double-check pattern.
- Add a startup probe that verifies the graph is ready before the container accepts traffic.

---

## 2. Security Gaps

---

### 2.1 ORCA webhook has no authentication

**File:** `services/orca/backend/api/webhooks.py`  
**Severity:** High

`POST /webhook/grafana` accepts any payload with no shared-secret validation. Anyone who can reach the ORCA backend network port can trigger arbitrary RCA investigations, exhaust Anthropic API quota, and flood the database.

**What's needed:**
- Add `ORCA_WEBHOOK_SECRET` to config and `.env.example`.
- Validate an `X-Webhook-Signature` HMAC header (same pattern Grafana uses for its own webhooks).
- Return 401 on missing/invalid signature.

---

### 2.2 Postgres MCP server has unrestricted database access

**File:** `docker-compose.yaml:119`  
**Severity:** High

The `mcp-postgres` container is given the full `ORCA_DB_URL` including admin credentials. The LLM driving the agent can instruct the MCP server to execute any SQL — including `DROP TABLE`, `DELETE FROM rca_sessions`, or exfiltrating all data. There is no read-only constraint.

**What's needed:**
- Create a dedicated Postgres role with `SELECT`-only access to the tables the agent needs to read (`rcas`, `rca_sessions`, `rca_embeddings`).
- Pass this read-only connection string to `mcp-postgres` instead of the admin URL.
- Document which tables the agent is permitted to read.

---

### 2.3 `.env` file with API key committed to the repository

**File:** `services/orca/.env`  
**Severity:** High

The `.env` file in the ORCA service directory is tracked in git. It contains `ANTHROPIC_API_KEY=sk-ant-api03-...`. Even if the key is partially redacted in this worktree, the file being tracked is a secrets hygiene risk. Any full clone of the repository will contain it.

**What's needed:**
- Add `services/orca/.env` to `.gitignore`.
- Add `services/orca/.env.example` with placeholder values and documentation of every required variable.
- Rotate the Anthropic API key.
- Audit git history and consider a `git filter-branch` or BFG rewrite if the full key was ever committed.

---

### 2.4 No rate limiting on `/api/rca/start`

**File:** `services/orca/backend/api/rca_sessions.py:87–149`  
**Severity:** High

A single authenticated Grafana user can submit unlimited concurrent `/api/rca/start` requests. Each request spawns a LangGraph thread, an Anthropic API session, and a Postgres connection. There is no idempotency check — submitting the same alert twice creates two separate investigations.

**What's needed:**
- Add per-org rate limiting (e.g. max 5 concurrent active investigations per org) enforced at the API layer.
- Add idempotency: hash `alert_context` fields and reject duplicate starts within a configurable window (e.g. 5 minutes).
- Surface a `429 Too Many Requests` with a `Retry-After` header.

---

### 2.5 Go backend leaks internal service names in error responses

**File:** `pkg/plugin/app.go:158–162`  
**Severity:** Low

The proxy error handler returns the string `"RCA backend unavailable"` verbatim to the browser. This reveals that a separate backend service exists and its current availability state. Use a generic message like `"Service temporarily unavailable"`.

---

## 3. UX Gaps

Features users of any production RCA tool would expect.

---

### 3.1 The entire data-gathering phase is invisible to the user

**File:** `src/pages/RCAInvestigate.tsx:215–250`, `src/types/rca.types.ts:64–74`  
**Severity:** High

`ToolCallEvent` and `ToolResultEvent` are fully typed in `rca.types.ts` but are completely ignored in `consumeSseStream`. During the data-gathering phase — which is when the agent is querying metrics, logs, traces, and Postgres — the UI shows nothing except a spinner in the header. An investigation that takes 2–5 minutes looks frozen. Users have no way to know what the agent is doing, whether it found data, or whether it is stuck.

**What's needed:**
- Handle `tool_call` events: add a `toolCalls` state array and render tool names as they are invoked (e.g. "Querying Prometheus...", "Searching RCA history...").
- Handle `tool_result` events: update each tool call entry with success/failure and optionally a result summary.
- Add a collapsible "Agent Activity" panel (similar to the existing "Agent Steps" panel) that renders this feed in real time.

---

### 3.2 "Start Manual Investigation" is a stub with hardcoded dummy data

**File:** `src/pages/RCAInvestigate.tsx:449–469`  
**Severity:** High

The idle state shows a "Start Manual Investigation" button that fires `handleStart` with:

```ts
alert_context: {
  alert_name: 'Manual investigation',
  description: 'Manually triggered RCA',
  labels: {},
}
```

This is a placeholder. A user clicking the button gets an investigation titled "Manual investigation" with no actual context. The agent has no signals to work with.

**What's needed:**
- A form with fields for: Alert name (required), Description, Service name, Environment, Labels (key-value pairs).
- Basic validation before submission.
- Optionally: a pre-fill from a Grafana alert rule picker.

---

### 3.3 No retry in the failed state

**File:** `src/pages/RCAInvestigate.tsx`  
**Severity:** Medium

When `status === 'failed'` (network error, backend error, or stream error), the page shows an error alert with no way to recover other than navigating away and back. This is particularly problematic for transient failures during the refine loop.

**What's needed:**
- A "Retry" button in the failed state that re-invokes the appropriate handler (`handleStart` for a new session, `handleRefine` for the current message, or `loadHistory` to re-fetch the current thread state).

---

### 3.4 No auto-refresh on the dashboard for live investigations

**File:** `src/pages/RCADashboard.tsx:20–26`  
**Severity:** Medium

`investigating_runs` is highlighted with a warning border to draw attention to in-flight RCAs, but the count is fetched once on mount and never updates. An operator watching the dashboard during an incident sees stale numbers.

**What's needed:**
- A polling interval (e.g. `setInterval` every 30 seconds) that re-calls `getStats()` when `investigating_runs > 0`.
- A manual refresh button in the header actions slot.

---

### 3.5 Filter state is not persisted in the URL

**File:** `src/pages/RCAList.tsx`  
**Severity:** Medium

Alert name, status, and service filter values live only in React state. Navigating away resets all filters and the page number. A developer cannot share a filtered view of RCAs with a colleague, bookmark a specific filter, or return to the same filtered list after following an investigation.

**What's needed:**
- Sync filter values and page number to URL query parameters (`?alert=&status=&service=&page=`).
- Read initial values from the URL on mount.

---

### 3.6 No debounce on text filter inputs

**File:** `src/pages/RCAList.tsx:78–81, 98–101`  
**Severity:** Medium

Each keystroke in the alert name or service inputs immediately triggers a new API call via the `useCallback`/`useEffect` chain. Typing a 10-character alert name fires 10 requests, 9 of which are discarded.

**What's needed:**
- Debounce text input changes by 300ms before updating the filter state that drives `fetchRCAs`.

---

### 3.7 `searchRCAs` and `submitFeedback` are implemented but have no UI

**File:** `src/services/rcaApi.ts:100–137`  
**Severity:** Medium

Both functions are fully implemented in the API service layer and the ORCA backend has the corresponding endpoints. Neither is called from any page component.

- `searchRCAs`: semantic search over past investigations — relevant when an operator wants to find a similar past incident before starting a new one.
- `submitFeedback`: thumbs-up/down with comment — needed for quality measurement and model improvement.

**What's needed:**
- A search input on `RCAList` that calls `searchRCAs` and replaces the list results.
- Thumbs-up/thumbs-down buttons on `RCAInvestigate` (final report panel and hypothesis panel) that call `submitFeedback`.

---

### 3.8 `StatusBreakdown` data from the backend is silently discarded

**File:** `src/pages/RCADashboard.tsx`, `src/types/rca.types.ts:186–191`  
**Severity:** Low

`DashboardStats` includes a `status_breakdown` field (`{ triggered, investigating, complete, failed }`). The dashboard renders only `confidence_breakdown`. The status distribution is never shown.

**What's needed:**
- Add a "Status Breakdown" row alongside the confidence breakdown, using the same coloured badge style with semantic colours per status.

---

### 3.9 `deployment_environment_name` exists in types and API but is not surfaced

**File:** `src/types/rca.types.ts:162`, `src/services/rcaApi.ts`  
**Severity:** Low

`RCASummary` includes `deployment_environment_name` and `listRCAs` accepts it as a filter parameter, but there is no table column showing it and no filter input for it on `RCAList`.

**What's needed:**
- Add an "Environment" column to the RCA list table (or make it a tooltip/badge on the alert name).
- Add an environment filter input to the filter bar.

---

### 3.10 Round counter shows "Round 0" on first interrupt

**File:** `src/pages/RCAInvestigate.tsx:273–277`  
**Severity:** Low

The `roundBadge` renders as "Round 0" when the first interrupt arrives (before any refinement has happened). `round = 0` should either not render a badge, or should be labelled "Initial analysis".

---

## 4. Operational Gaps

---

### 4.1 Health check always returns OK — ORCA backend is never probed

**File:** `pkg/plugin/app.go:200–204`  
**Severity:** High

`CheckHealth` unconditionally returns `StatusOk`. If the ORCA backend is down, Grafana reports the plugin as healthy. Operators have no automated way to detect that RCA functionality is degraded.

**What's needed:**
- `CheckHealth` should `GET` the ORCA backend's `/health` endpoint.
- Return `StatusError` with a descriptive message if ORCA is unreachable or returns non-2xx.
- Make the probe timeout configurable (default 3s).

---

### 4.2 Agent timeout not enforced in the interactive graph

**File:** `services/orca/backend/agent/rca_graph.py`  
**Severity:** High

`ORCA_AGENT_TIMEOUT_SECONDS` is used in the legacy `graph.py` with `asyncio.wait_for` but is absent from `rca_graph.py`. A `data_gathering_node` blocked on a slow MCP tool can run indefinitely. No clean error is surfaced to the UI.

**What's needed:**
- Wrap `data_gathering_node` with `asyncio.wait_for(coro, timeout=settings.ORCA_AGENT_TIMEOUT_SECONDS)`.
- Catch `asyncio.TimeoutError` and yield a `type: error` SSE event with a timeout message.
- Update `RCAInvestigate.tsx` to surface this as a recoverable error with a Retry button.

---

### 4.3 `RCA_BACKEND_URL` is not documented and not configurable from Grafana UI

**File:** `pkg/plugin/app.go:140`  
**Severity:** Medium

The ORCA backend URL defaults to `http://orca-backend:8000` and is only overridable via an environment variable on the plugin container. There is no entry in any `.env.example`, and an operator cannot change it from the Grafana plugin config page.

**What's needed:**
- Add `RCA_BACKEND_URL` to the root `.env.example` with documentation.
- Expose it as a plugin `jsonData` field in `AppConfig` so operators can change it without redeploying the container.
- Add it to the `docs/development.md` environment variable reference.

---

### 4.4 No RCA-specific metrics on the Go proxy

**File:** `pkg/plugin/app.go`  
**Severity:** Medium

The Go backend tracks `rcaRequestErrors` (a counter) but has no `rcaRequestsTotal` counter or `rcaRequestDuration` histogram. Chat requests have both. This means there is no way to measure RCA proxy throughput, latency, or error rate in Grafana dashboards.

**What's needed:**
- Add `rcaRequestsTotal` counter (labelled by `org_id` and `path`).
- Add `rcaRequestDuration` histogram with standard buckets.
- Include these in the existing OTel setup alongside the chat metrics.

---

### 4.5 Column migrations are hand-written SQL — no rollback capability

**File:** `services/orca/backend/main.py:68–77`  
**Severity:** Medium

Schema changes are applied via raw `ADD COLUMN IF NOT EXISTS` statements at startup. This handles only additive migrations. Column type changes, renames, index additions, and drops cannot be expressed, and there is no migration history or rollback path.

**What's needed:**
- Replace the hand-written startup migrations with Alembic.
- Add an `alembic/` directory with an initial migration capturing the current schema.
- Document the migration workflow in `docs/development.md`.

---

### 4.6 No operational runbook

**Severity:** Medium

There is no documentation covering:

- What to do when a session is stuck in `investigating` state.
- How to manually cancel an in-flight LangGraph thread.
- How to rotate the Anthropic API key without downtime.
- How to scale ORCA horizontally (the Postgres checkpointer supports multiple instances, but connection pool sizing and session affinity are undocumented).
- How to recover from a full Postgres connection pool.
- What to do when the `orca-backend` container crashes mid-investigation.

**What's needed:**
- Add `docs/orca-operations.md` covering at minimum: stuck sessions, API key rotation, horizontal scaling, and database maintenance.

---

## 5. Test Coverage Gaps

---

### 5.1 Zero tests for the SSE streaming code path

**File:** `src/pages/RCAInvestigate.tsx:199–253`  
**Severity:** High

`consumeSseStream` is the most complex and critical piece of the frontend. It handles all SSE event types, drives the entire investigation state machine, and contains several of the bugs identified above (abort signal, tool call events, done event handling). It has no test coverage at all. All `RCAInvestigate` tests go through the `getHistory` path and mock the API entirely.

**What's needed:**
- Mock `startRCAStream` and `refineRCAStream` to return a `Response` with a `ReadableStream` body.
- Write tests for each SSE event type: `session_created`, `step`, `hypothesis`, `interrupt`, `done`, `error`.
- Write a test that verifies `tool_call` and `tool_result` events are handled once implemented.
- Write a test that verifies component unmount aborts the stream once the abort fix is in place.

---

### 5.2 Multi-org isolation is untested at the integration level

**File:** `services/orca/backend/tests/integration/test_org_isolation.py`  
**Severity:** High

The integration test suite uses SQLite, which does not support the `pgvector` extension. `RCAEmbedding` falls back to a JSON column in SQLite. The org isolation tests query without an org header and assert they get records back — they do not assert that org A cannot see org B's records. The comment in the test file explicitly admits this:

> "the actual org isolation is done inside the API handler; since the test DB doesn't filter by default (column may not exist in SQLite)"

**What's needed:**
- Add a Docker-based integration test target that uses a real `pgvector`-enabled Postgres container.
- Write a test that creates records for two different org IDs and asserts that querying with org A's header does not return org B's records.
- This test should run in CI.

---

### 5.3 `streaming.py` has no tests

**File:** `services/orca/backend/api/streaming.py`  
**Severity:** Medium

The SSE event formatting and stream management logic (`stream_rca_start`, `stream_rca_refine`) is mocked entirely in all integration tests. No test exercises the actual generator functions, event types, or error handling paths.

**What's needed:**
- Unit tests for each SSE event type emitted by `stream_rca_start` and `stream_rca_refine`.
- A test that verifies the `error` event is emitted (not an unhandled exception) when the graph raises.

---

### 5.4 No end-to-end tests for any RCA page

**Severity:** Medium

The `tests/` directory (Playwright) contains no RCA test files. The full user journey — navigating to `/rca`, viewing stats, opening history, clicking a row to investigate — is not covered by any automated test.

**What's needed:**
- `tests/rca-dashboard.spec.ts`: load the dashboard, assert stat cards render, click "All RCA runs".
- `tests/rca-list.spec.ts`: filter by status, click a row to navigate to investigation.
- `tests/rca-investigate.spec.ts`: load an existing thread, verify hypothesis panel, verify accept flow. (Requires a seeded database or API mocks.)

---

## 6. Infrastructure Gaps

---

### 6.1 ORCA backend has no Docker healthcheck

**File:** `docker-compose.yaml:126–153`  
**Severity:** Medium

`orca-backend` starts without a `healthcheck` directive. Services that depend on it use `condition: service_started` rather than `condition: service_healthy`. The Grafana plugin may begin routing requests to ORCA before its database migrations and LangGraph initialisation have completed.

**What's needed:**
- Add a healthcheck to `orca-backend`: `GET /health` with a 10s interval, 30s start period.
- Change dependent services to use `condition: service_healthy`.

---

### 6.2 Unpinned image versions

**File:** `docker-compose.yaml`  
**Severity:** Medium

Several images use `latest` or unversioned tags:

- `grafana/mimir:latest` (line 46)
- `@modelcontextprotocol/server-postgres@latest` in the `mcp-postgres` command

These will pull potentially breaking upstream changes on every `docker compose pull`. The stack should be reproducible across machines and CI.

**What's needed:**
- Pin all image tags to specific versions (e.g. `grafana/mimir:2.13.0`).
- Pin the npm package version in the `mcp-postgres` command.
- Document the upgrade process in `docs/development.md`.

---

### 6.3 ORCA backend port exposed externally in Docker Compose

**File:** `docker-compose.yaml:153`  
**Severity:** Low

`ports: - "8001:8000"` exposes the ORCA FastAPI directly on the host. In production, all traffic should route through the Grafana plugin proxy. Direct exposure allows bypassing the `X-Grafana-Org-Id` injection and RBAC controls.

**What's needed:**
- Remove the host port binding in any production compose file.
- Keep `8001:8000` in a `docker-compose.override.yaml` for local development only.
- Document that the port should not be exposed in production.

---

### 6.4 `test.db` committed to the repository

**File:** `services/orca/backend/test.db`  
**Severity:** Low

A SQLite test artifact is tracked in git. It may contain test data that grows over time and will cause merge conflicts.

**What's needed:**
- Add `services/orca/backend/test.db` to `.gitignore`.
- Delete it from the repository with `git rm --cached`.

---

## 7. Documentation Gaps

---

### 7.1 Root `CLAUDE.md` and `docs/` do not mention RCA

**Severity:** Medium

The root `CLAUDE.md` describes the original chat architecture but has no reference to the RCA feature, its routes, its backend service, or its architecture. A developer reading the project entry point would not know the RCA integration exists. None of the files in `docs/` cover ORCA either.

**What's needed:**
- Add an "RCA / ORCA Integration" section to `CLAUDE.md` covering routes, service dependencies, and the SSE streaming pattern.
- Add `docs/orca-architecture.md` with a description of the two-graph model (legacy webhook graph vs interactive `rca_graph`), the data flow, and the SSE event protocol.

---

### 7.2 `services/orca/CLAUDE.md` describes the old graph

**Severity:** Medium

The ORCA service `CLAUDE.md` describes the legacy 5-node one-shot graph (`triage → investigate → analyze → report → publish`). The interactive `rca_graph.py` that powers the UI is not documented anywhere other than inline code comments.

**What's needed:**
- Update `services/orca/CLAUDE.md` to describe both the webhook-triggered legacy flow and the interactive investigation flow, with clear notes on which code paths are active for each.

---

### 7.3 No consolidated environment variable reference

**Severity:** Medium

Environment variables for the full stack are scattered across `services/orca/.env` (if it exists), `docker-compose.yaml` inline defaults, and hardcoded fallbacks in Go and Python. There is no single document listing every variable, its purpose, its default, and whether it is required.

**What's needed:**
- A root `.env.example` listing every variable needed to run the full stack (currently it is 0 bytes).
- At minimum: `ANTHROPIC_API_KEY`, `GRAFANA_ADMIN_TOKEN`, `ORCA_DB_PASSWORD`, `RCA_BACKEND_URL`, `ORCA_WEBHOOK_SECRET`, `ORCA_MAX_ROUNDS`, `ORCA_AGENT_TIMEOUT_SECONDS`, `ORCA_EMBEDDING_MODEL`.

---

## Priority Summary

| # | Gap | Severity | Area |
|---|---|---|---|
| 1.1 | `embed_text` is a SHA-256 stub — semantic search non-functional | **Critical** | Backend |
| 1.2 | `thread_id=None` in `_persist_rca_session` — completed sessions unrecoverable | **Critical** | Backend |
| 1.3 | `AbortController` signal never passed to SSE fetch | **Critical** | Frontend |
| 1.4 | `init_rca_graph` has no async lock — race condition leaks DB pool | **Critical** | Backend |
| 2.1 | ORCA webhook has no authentication | **High** | Security |
| 2.2 | Postgres MCP has unrestricted DB write access | **High** | Security |
| 2.3 | `.env` with API key committed to git | **High** | Security |
| 2.4 | No rate limiting on `/api/rca/start` | **High** | Security |
| 3.1 | Data-gathering phase is invisible — tool calls not rendered | **High** | UX |
| 3.2 | Manual investigation start is a stub with hardcoded dummy data | **High** | UX |
| 4.1 | Health check never probes ORCA backend | **High** | Ops |
| 4.2 | Agent timeout not enforced in interactive graph | **High** | Ops |
| 5.1 | Zero tests for SSE streaming code path | **High** | Tests |
| 5.2 | Multi-org isolation is untested at integration level | **High** | Tests |
| 3.3 | No retry button in the failed state | **Medium** | UX |
| 3.4 | No auto-refresh for live "Investigating" counts | **Medium** | UX |
| 3.5 | Filter state not in URL — cannot share filtered views | **Medium** | UX |
| 3.6 | No debounce on text filter inputs | **Medium** | UX |
| 3.7 | `searchRCAs` and `submitFeedback` have no UI | **Medium** | UX |
| 4.3 | `RCA_BACKEND_URL` not documented or configurable from Grafana | **Medium** | Ops |
| 4.4 | No RCA-specific metrics on the Go proxy | **Medium** | Ops |
| 4.5 | Column migrations are hand-written SQL — no Alembic | **Medium** | Ops |
| 4.6 | No operational runbook | **Medium** | Ops |
| 5.3 | `streaming.py` has no tests | **Medium** | Tests |
| 5.4 | No E2E tests for any RCA page | **Medium** | Tests |
| 6.1 | ORCA backend has no Docker healthcheck | **Medium** | Infra |
| 6.2 | Unpinned image versions (`mimir:latest`, `server-postgres@latest`) | **Medium** | Infra |
| 2.5 | Go backend leaks internal service name in error messages | **Low** | Security |
| 3.8 | `StatusBreakdown` data received but silently discarded | **Low** | UX |
| 3.9 | `deployment_environment_name` not surfaced in table or filters | **Low** | UX |
| 3.10 | Round counter shows "Round 0" on first interrupt | **Low** | UX |
| 6.3 | ORCA backend port exposed externally in Docker Compose | **Low** | Infra |
| 6.4 | `test.db` committed to the repository | **Low** | Infra |
| 7.1 | Root `CLAUDE.md` and `docs/` do not mention RCA | **Medium** | Docs |
| 7.2 | `services/orca/CLAUDE.md` describes the old graph only | **Medium** | Docs |
| 7.3 | No consolidated environment variable reference | **Medium** | Docs |
