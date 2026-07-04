# Observability Agent Harness — Implementation State

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
        ├── feat/agent-harness-phase-3   🔄 open PR #26 (branch: feat/agent-harness-phase-3)
        └── feat/agent-harness-phase-4   🔲 not started
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
- `harness/auth/internal_auth.py`: `InternalAuthMiddleware` — HMAC-SHA256 validation on `/api/sessions/*`, 60s timestamp skew, dev-mode pass-through when `AGENT_INTERNAL_SECRET` empty
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

### 🔲 Phase 4 — Hardening, Evals, Retirement (not started)

**Scope:**
- Task 4.1: Security hardening — expand injection red-team dataset to ≥25 cases, PII redaction guard (default-off), dependency/container scanning in CI
- Task 4.2: MCP tool integration — Python MCP SDK client manager for GitHub, Kubernetes; tool discovery merged into ToolRegistry with namespace prefix
- Task 4.3: Retire legacy RCA endpoints — remove `app/api/rca_sessions.py` adapter endpoints; characterization tests migrate to session API
- Task 4.4: Load & scale validation — Locust 500 concurrent sessions × 3 workers, p95 < 5s; chaos: kill workers + Postgres failover
- Task 4.5: Final documentation
- Fix `isInitiator` in `SessionPanel.tsx` (compare `contextSrv.user.id` with `session.initiator_user_id`)

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

Full ADR docs in `docs/decisions/`.

---

## How to Continue in a New Session

1. Read this file (`docs/HARNESS_PLAN.md`) and the ADRs in `docs/decisions/`
2. Check current branch: `git branch --show-current`
3. Check what's open: `gh pr list --base feat/orca-rca-integration`
4. For Phase 3: cut `feat/agent-harness-phase-3` from `feat/orca-rca-integration`
5. Refer to Phase 3 scope above and the original implementation plan (summarised in the Phase 3 section above)
6. After implementation: `go test ./pkg/...` + `npm run test:ci` + `pytest tests/ -q` all green before creating PR
