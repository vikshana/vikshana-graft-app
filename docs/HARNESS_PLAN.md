# Observability Agent Harness — Implementation State

> **This document is a historical phase record.** It captures the
> Phase 0–4 implementation plan and status as it stood on **2026-07-04**,
> before the `feat/agent-harness-phase-4` PR (#27) was reviewed and before
> commit `61534e4` ("fix(backend): harden agent harness") landed. The phase
> narrative below is preserved as-is for historical context; it is **not**
> an accurate description of current behaviour in several places (schema
> management, live-path wiring, test status — see the addendum immediately
> below). For the current architecture, read
> [`ARCHITECTURE.md`](../ARCHITECTURE.md) (canonical, current) and
> [`docs/harness-risk-review.md`](harness-risk-review.md) (findings +
> resolution status). For current ADR text, read `docs/decisions/ADR-003-worker-queue.md`
> and `docs/decisions/ADR-007-mcp-architecture.md` directly, not the "ADR
> Index" summaries below, which reflect the pre-`61534e4` decisions.

---

## Current-State Addendum (post-`61534e4`)

Corrections to the phase narrative below, current as of commit `61534e4`:

- **Schema authority.** Phase 0 below says "`create_all()` inline remains
  for backward compat" alongside Alembic. That is no longer true: Alembic is
  now the *sole* schema authority. `services/orca/backend/docker-entrypoint.sh`
  runs `alembic upgrade head` before the app starts; `app/main.py` no longer
  calls `Base.metadata.create_all` or runs ad-hoc column migrations; a
  startup check (`app/schema_check.py`) fails hard in production if the DB
  isn't at the expected Alembic head. See docs/harness-risk-review.md F3/F13.
- **Harness is now on the live path.** Phase 2's "Verification status" and
  Phase 4's summary predate the risk review finding (F1) that the guard
  pipeline and org-scoped tool registry were dead code — the live
  `app/agent/rca_graph.py` bound tools directly and never ran
  `GuardPipeline`. This was fixed in `61534e4`: the graph now dispatches
  every tool call through `GuardedToolExecutor`. See
  `ARCHITECTURE.md` § Guarded Tool Execution.
- **TurnWorker concurrency.** The worker design described under Phase 1
  ("`pg_advisory_xact_lock` … exactly one active turn per session") had a
  bug where the lock was released immediately on claim-commit, before the
  turn ran (risk review F2). `61534e4` replaced this with a non-blocking
  `pg_try_advisory_xact_lock` held for the duration of the turn, plus a
  heartbeat and busy-requeue. See `ARCHITECTURE.md` § TurnWorker Concurrency
  Model and `docs/decisions/ADR-003-worker-queue.md`.
- **MCP org-scoping and replication.** Phase 4's `harness/mcp/` summary
  predates fixes for cross-org registry-key collisions and per-replica
  staleness (risk review F10/F12) — see `ARCHITECTURE.md` § Org Scoping & MCP
  Tool Registry Replication and `docs/decisions/ADR-007-mcp-architecture.md`.
- **Test status.** The "Running tests" section below is still the correct
  command to run the Python suite locally. It is **not**, and has never
  been, wired into CI: `.github/workflows/ci.yml` runs frontend unit tests,
  Go tests, and Python dependency/vulnerability scans (`pip-audit`,
  `govulncheck`) — it does not invoke `pytest` for
  `services/orca/backend/tests/` anywhere. Coverage/pass-count figures
  quoted per-phase below (e.g. "410 passed", "86.96% harness coverage") were
  true at the time they were written but are not re-verified by any
  automated gate today.

---

**Last updated:** 2026-07-04
**Active branch:** `feat/orca-rca-integration` (all harness work lives here until complete)
**Monorepo root:** `services/orca/backend/` — Python backend (FastAPI + LangGraph)
**Go plugin:** `pkg/plugin/` — Grafana plugin backend (proxy + RBAC)
**Frontend:** `src/` — React/TypeScript

---

## Branch Strategy

```
main
  └── feat/orca-rca-integration          ← base for all harness work
        ├── feat/agent-harness-phase-0   ✅ merged (PR #23)
        ├── feat/agent-harness-phase-1   ✅ merged (PR #24)
        ├── feat/agent-harness-phase-2   ✅ merged (PR #25)
        ├── feat/agent-harness-phase-3   ✅ merged (PR #26)
        └── feat/agent-harness-phase-4   🔄 open PR (branch: feat/agent-harness-phase-4)
```

**Rule:** Each phase branch is cut from `feat/orca-rca-integration`, work is done, then PR merges back into `feat/orca-rca-integration`. Final PR from `feat/orca-rca-integration` → `main` only when all phases complete.

To continue on Phase 3:
```bash
cd <worktree>
git checkout feat/agent-harness-phase-3
```

To start Phase 4:
```bash
git checkout feat/orca-rca-integration && git pull
git checkout -b feat/agent-harness-phase-4
```

---

## Phase Status

### ✅ Phase 0 — Environment, Auth Spike, Safety Nets (merged PR #23)

**What was built:**
- `docker-compose.yaml`: Langfuse stack (5 containers, UI at :4100), mock-oauth2-server under `--profile auth-spike`
- `config/otel-collector.yaml`: OTel fan-out to Langfuse OTLP endpoint (orca-backend spans only)
- `scripts/smoke-dev-env.sh`: asserts Grafana health, datasource queryability, Langfuse health, OTel acceptance
- `scripts/provision-grafana-teams.sh`: creates team-alpha + team-beta, per-team users, datasource permissions
- `harness/auth/`: full auth chain — `types.py`, `entra_obo.py` (OBO + Fernet token encryption), `session_passthrough.py`, `service_account.py`, `chain.py` (priority resolver)
- Alembic setup: `alembic.ini`, `harness/migrations/env.py`, `0001_baseline.py`, `0002_harness_phase0.py` (user_tokens, users, identities, turns, tool_calls, approvals, spend_ledger, turn_jobs, drill_down_results)
- `app/config.py`: extended with AUTH_ENTRA_OBO_ENABLED (feature flag, default false), OIDC_ISSUER, ENTRA_* fields, OBO_ENCRYPTION_KEY, LANGFUSE_* settings
- 35 unit tests (auth chain + security/secret-redaction)
- 3 characterization golden-transcript tests (Phase 0 FakeProvider)
- 6 ADRs in `docs/decisions/`

**Key decisions:**
- OBO enabled via feature flag (`AUTH_ENTRA_OBO_ENABLED=false` default), service account is the default path
- Alembic for all future migrations; `create_all()` inline remains for backward compat
- Langfuse self-hosted in dev compose (not deferred)

---

### ✅ Phase 1 — Core Harness Refactor (merged PR #24)

**What was built:**
- `harness/llm/`: `LLMProvider` protocol, `Turn`, error taxonomy, `AnthropicProvider`, `OpenAICompatProvider`, `FakeProvider` (deterministic replay + `recorded_prompts()`)
- `harness/session/models.py`: 8 cross-DB ORM models (Turn, ToolCallRecord, Approval, SpendLedger, TurnJob, DrillDownResult, HarnessUser, Identity) — JSONB via `sa.JSON().with_variant(postgresql.JSONB(), "postgresql")` for SQLite compat
- `harness/session/registry.py`: `GraphRegistry` — lazy session-type → graph factory
- `harness/session/worker.py`: `TurnWorker` (FOR UPDATE SKIP LOCKED + `pg_advisory_xact_lock`), `enqueue_turn()` with agent_busy detection
- `app/main.py`: registers RCA graph in GraphRegistry as `type=investigation`; starts TurnWorker background loop
- `harness/tools/protocol.py`: `Tool` protocol, `CostClass`, `ToolContext`, `ToolResult`, `ToolResultEnvelope` (injection framing with `<tool_result source="untrusted_telemetry">`)
- `harness/tools/registry.py`: `ToolRegistry`
- `harness/tools/grafana/`: 8 read tools + 2 write tools (create_silence, create_annotation) + `fetch_more`, `result_shaping.py` (MetricsShaper LTTB/50 series, LogsShaper head+tail+32KB, TracesShaper slowest path), drill_down_results TTL storage
- `harness/guards/`: `GuardPipeline` + 6 guards: RBACGuard, CostGuard (range clamp + unbounded matcher), BudgetGuard (3 dimensions), TimeoutGuard (per-tool/turn/session), WriteGuard (always ApprovalRequired), LoopGuard (max 25/turn)
- `harness/skills/loader.py`: `SkillsLoader` (YAML frontmatter, content hashing), `LoadSkillTool`
- `harness/observability/otel.py`: `@trace_span` decorator, 6 metric instruments (GenAI semconv)
- `harness/observability/langfuse.py`: `LangfuseClient` with NoOp fallback
- `harness/compaction/compactor.py`: `ContextCompactor` (threshold-based, pinned messages, LLM summary)
- `app/api/rca_sessions.py`: `POST /api/sessions/{id}/feedback` → Langfuse
- `app/models/rca_session.py`: fixed JSONB → cross-DB JSON (fixed pre-existing test_dedup.py ERRORs)
- New deps: `pyyaml`, `langfuse`, `cryptography`, `alembic` in `pyproject.toml`
- 271 passing tests; 88% coverage on `harness/`; 4 REQUIRES_ENV skips

**Key architectural invariant:** Existing `app/agent/rca_graph.py` is unchanged; it's registered in GraphRegistry and wrapped by the harness. `app/api/rca_sessions.py` endpoints unchanged (adapter pattern — retire in Phase 4).

---

### ✅ Phase 2 — Grafana Plugin Integration (merged PR #25)

**What was built:**
- `pkg/plugin/session_proxy.go`: `/sessions/` + `/sessions` reverse proxy with RBAC (reads `agent_allowed_roles` from plugin JSONData, default `["Admin","Editor"]`), HMAC signing (`X-Agent-Signature` when `AGENT_INTERNAL_SECRET` set), `X-Grafana-Org-Id` injection, SSE passthrough
- `pkg/plugin/app.go`: `registerSessionRoutes()` call in `NewApp`; `CallResource` now threads `OrgRole` via `orgRoleKey{}` alongside existing `orgIDKey{}`
- `harness/auth/internal_auth.py`: `InternalAuthMiddleware` — HMAC-SHA256 validation on `/api/sessions`, `/api/mcp`, `/api/identity`, and `/api/rca`; signature binds method + raw encoded path/query + body digest + org ID + a replay-cache nonce; 30s timestamp skew (hosts must be NTP-synced — see services/orca/README.md); dev-mode pass-through when `AGENT_INTERNAL_SECRET` empty, refused at startup when `ENVIRONMENT=production` (see `app/config.py`)
- `app/api/rca_sessions.py`: new endpoints:
  - `GET /api/sessions/drill-down/{handle}` — retrieves stored tool result for EvidencePanel re-execution (Option B)
  - `GET /api/sessions` — lists rca_sessions with status/type/org filters
- `src/types/session.types.ts`: full session SSE event union, SessionStatus state machine, ToolCallStep
- `src/services/sessionApi.ts`: listSessions, postTurn, approveAction, postFeedback, getDrillDown, streamSession
- `src/components/features/Session/`: AgentBusyBanner, PausedStateBanner, ApprovalModal, ToolCallFeed, EvidencePanel (re-executes queries as viewing user; 403 → permission-denied placeholder), FeedbackWidget
- `src/pages/SessionList.tsx` + `SessionPanel.tsx` — new session UI at `/sessions` and `/sessions/:id`
- `src/constants.ts`, `App.tsx`, `plugin.json`: Sessions nav entry + routes (Option A: alongside existing /rca pages)
- `tests/session-flow.spec.ts`: 7 Playwright e2e tests (mocked)
- `docs/demo/phase2-walkthrough.md`

**Infrastructure bugs fixed during Phase 2 (committed to feat/agent-harness-phase-2):**
- `config/otel-collector.yaml`: Phase 0 edit accidentally duplicated the entire file — deleted lines 98–158
- `services/orca/backend/Dockerfile`: added `COPY harness/ ./harness/` (was missing, caused ModuleNotFoundError)
- `pkg/plugin/session_proxy.go`: Go ServeMux auto-redirect `/sessions` → `/sessions/` stripped Grafana plugin prefix; Director path rewrite (`"/"` → `/api/sessions`, `/sub` → `/api/sessions/sub`)

**Verification status:** Sessions page loads cleanly ("No sessions yet" empty state), zero console errors, `GET /api/sessions → 200`.

**Still TODO for Phase 2 to be fully complete:**
- The `isInitiator` check in `SessionPanel.tsx` is hardcoded to `true` (noted with TODO comment for Phase 4)
- E2E tests in `session-flow.spec.ts` are mocked — full e2e against live stack not yet run

---

### 🔄 Phase 3 — Slack Integration & Identity Linkage (PR #26 open, branch: feat/agent-harness-phase-3)

**What was built:**
- Task 3.0: `slack_bolt>=1.18`, `slack_sdk>=3.27` added to `pyproject.toml`; 11 new config fields in `app/config.py` (`SLACK_BOT_TOKEN`, `SLACK_APP_TOKEN`, `SLACK_SIGNING_SECRET`, `IDENTITY_LINK_STATE_TTL_S`, `ALERT_TRIAGE_*`); `docker-compose.yaml` updated with Slack env vars; Alembic migration `0003_phase3.py` (`identity_link_requests`, `slack_events` tables)
- Task 3.1 (Identity linkage): `harness/auth/linkage.py` — PKCE S256 flow: `generate_link_request`, `complete_link` (with Entra OID exchange), `revoke_link`, `get_link_status`; `app/api/identity.py` — `/api/identity/link/start`, `/callback`, `/status`, `DELETE /link`; 17 unit tests covering happy path, expired/used/mismatched state, duplicate identity, idempotent re-link, revoke, status
- Task 3.2 (Slack Bolt): `harness/slack/` package — `app.py` (AsyncApp singleton + Socket Mode factory), `handlers.py` (`/obs ask|investigate|link`, `approve_tool_call`/`reject_tool_call` actions, 3-second ack guarantee, background tasks), `block_kit.py` (5 pure Block Kit builders: thinking, tool_call, approval_prompt, final_answer, error), `idempotency.py` (Postgres `slack_events` dedup with 7-day lazy TTL), `notifier.py` (SlackNotifier reads `channel_refs`, posts to thread post-turn), `channel_refs.py` (ref JSONB helpers); `TurnWorker._execute_turn` calls `SlackNotifier` after graph invocation; 39 unit tests
- Task 3.3 (Auto-triage): `harness/triage/` package — `dedup_adapter.py` (`DedupPort` protocol + `OrcaDedupAdapter` wrapping `app.agent.dedup`), `circuit_breaker.py` (3-state async circuit breaker: CLOSED/OPEN/HALF_OPEN, asyncio.Lock-protected), `auto_triage.py` (`AutoTriageService` with `asyncio.BoundedSemaphore` cap, circuit breaker, service-account session tagging, `enqueue_turn` dispatch); 25 unit tests
- `app/main.py`: AutoTriageService wired in lifespan (`app.state.auto_triage`); Slack Socket Mode handler started when `SLACK_APP_TOKEN` set; `identity_router` registered

**Verification status:** 87% coverage on `harness/`; 383 total Python tests pass (4 pre-existing failures unchanged); Go and frontend pass.

---

### ✅ Phase 4 — Hardening, Evals, Retirement (complete — open PR)

**What was built:**
- **Testcontainers**: replaced SQLite test engine with real PostgreSQL 16 container; Alembic migration chain smoke-tested on every run; resolved 9 pre-existing pgvector failures (`test_dedup.py`)
- **Task 4.3**: Retired legacy RCA endpoints (`app/api/rca_sessions.py` deleted); `embed_text` moved to `harness/search/embeddings.py`; new `app/api/sessions.py` with 4 clean endpoints including `GET /sessions/search`
- **Task 4.1**: `PIIRedactionGuard` (8 GDPR pattern families, default-off via `HARNESS_PII_REDACTION_ENABLED`); ≥25-case injection red-team dataset; `pip-audit` + `govulncheck` CI job
- **Task 4.2**: `harness/mcp/` package (`MCPClientManager`, `OrgToolRegistry` Decorator, `MCPTool` adapter, Fernet token encryption); Alembic `0004_mcp_servers.py`; `app/api/mcp_servers.py` (6 endpoints); `/mcp/` Go proxy prefix; frontend MCPServers page (`src/pages/MCPServers.tsx`, `src/components/features/MCPServers/`)
- **Frontend**: `isInitiator` in `SessionPanel.tsx` now reads from `window.grafanaBootData` vs session metadata
- **Task 4.4**: Locust load test suite (`tests/load/locustfile.py`, `assert_p95.py`); `load-test.yml` `workflow_dispatch` CI job
- **Task 4.5**: `docs/decisions/ADR-007-mcp-architecture.md`, `ADR-008-testcontainers.md`; this plan updated
- **Coverage**: 86.96% harness coverage (≥85% threshold met)

---

## Running the Stack

### Minimum containers for UI verification (Sessions page)
```bash
docker compose up --no-deps loki tempo mimir otel-collector orca-postgres mcp-grafana mcp-postgres orca-backend grafana -d
```

### Full stack (includes Langfuse — slow on first boot due to ClickHouse)
```bash
npm run server
```

### After any Go source change
```bash
rm ./dist/gpx_* && mage -v build:linuxARM64
docker compose restart grafana
```

### After any Python source change
```bash
docker compose up --build --no-deps orca-backend -d
```

### After any frontend change
```bash
npm run build
docker compose restart grafana
```

### Running tests
```bash
# Python (from services/orca/backend/)
pytest tests/unit/ tests/llm/ tests/security/ tests/characterization/ --cov=harness --cov-fail-under=85 -q

# Go
go test ./pkg/...

# Frontend
npm run test:ci

# Playwright e2e (requires running stack)
npm run e2e
```

> The Python `pytest` command above is not invoked by any CI workflow —
> `.github/workflows/ci.yml` runs the Go and frontend suites plus Python
> dependency/vulnerability scans (`pip-audit`, `govulncheck`) only. Run it
> manually before merging any change under `services/orca/backend/`.

---

## Known Infrastructure Quirks

| Issue | Cause | Fix |
|---|---|---|
| `langfuse-clickhouse is unhealthy` | ClickHouse alpine slow to init; corrupt volume from prior failed boot | Add `start_period: 60s` (already in compose); or wipe: `docker volume rm <project>_langfuse-clickhouse-data` |
| `ModuleNotFoundError: No module named 'harness'` | Dockerfile missing `COPY harness/ ./harness/` | Fixed in Phase 2; rebuild with `--build` |
| otel-collector exits with YAML error | Duplicate top-level YAML keys | Fixed in Phase 2; `config/otel-collector.yaml` is now a single valid document |
| Sessions API 404 via Go proxy | ServeMux redirect drops Grafana plugin prefix; Director forwarded to orca root | Fixed in Phase 2 with explicit `/sessions` handler + Director path rewrite |
| Go plugin changes invisible after restart | Binary in `dist/gpx_*` is stale — must be explicitly rebuilt | Always `rm dist/gpx_* && mage -v build:linuxARM64` after Go changes |
| `ChatInterface.test.tsx` 1 failure | Pre-existing `window.location.href` assertion bug (not introduced by harness work) | Known, not ours to fix |

---

## ADR Index

| ADR | Decision |
|---|---|
| ADR-001 | Auth chain: OBO behind feature flag; service account default |
| ADR-002 | LLM provider abstraction: protocol wrapping vendor SDKs |
| ADR-003 | Worker queue: full Postgres job queue with FOR UPDATE SKIP LOCKED |
| ADR-004 | Data store: Postgres + pgvector retained; Alembic adopted |
| ADR-005 | Langfuse included in Phase 1 dev compose |
| ADR-006 | Dev compose: extend root `docker-compose.yaml` in place (not `deploy/dev/`) |

Full ADR docs in `docs/decisions/`. **ADR-003 and ADR-007 were amended after
`61534e4`** to describe the non-blocking lock/heartbeat design and the
org-qualified MCP registry keys / bounded replication convergence
respectively — read those two files directly rather than relying on this
one-line summary table.

---

## How to Continue in a New Session

> Historical — written when Phase 3 was the next unstarted phase. All
> phases (0–4) are now complete and `61534e4` has landed on top of them. For
> current work, start from `ARCHITECTURE.md` and
> `docs/harness-risk-review.md` instead of this section.

1. Read this file (`docs/HARNESS_PLAN.md`) and the ADRs in `docs/decisions/`
2. Check current branch: `git branch --show-current`
3. Check what's open: `gh pr list --base feat/orca-rca-integration`
4. For Phase 3: cut `feat/agent-harness-phase-3` from `feat/orca-rca-integration`
5. Refer to Phase 3 scope above and the original implementation plan (summarised in the Phase 3 section above)
6. After implementation: `go test ./pkg/...` + `npm run test:ci` + `pytest tests/ -q` all green before creating PR
