# Phase 5 — Structural Remediation Plan

**Status:** Planned  
**Source review:** `docs/harness-risk-review.md`  
**Goal:** Make the agent harness a real, production-safe execution path rather than a tested but disconnected subsystem.

## Why Phase 5 exists

Phases 0–4 built the harness, queue, guards, MCP configuration, session UI, and security controls. The risk review found that several core controls are not live in production:

- The legacy RCA graph is the only graph registered with `TurnWorker`; it binds LangChain tools directly.
- `GuardPipeline`, `OrgToolRegistry`, and `MCPTool` execution are not called by live agent turns.
- Production schema creation uses `create_all`, while MCP tables exist only in Alembic migrations.
- Several Go-proxied backend routes lack complete HMAC protection and request binding.

Phase 5 is a release-blocking hardening phase. Do not merge `feat/orca-rca-integration` to `main` until its release gates are satisfied.

---

## Structural findings

| ID | Finding | Severity | GitHub issue | Required Phase 5 result |
|---|---|---:|---|---|
| F1 | Guard pipeline, org-scoped registry, and MCP execution are not on the live path | Critical | #28 | Every live tool call goes through `GuardedToolExecutor`; MCP tools are visible only to their org |
| F2 | `pg_advisory_xact_lock` is released before turn execution | Critical | #29 | At most one active turn executes per session across workers/replicas |
| F3 / F13 | Production uses `create_all`; MCP schema exists only in Alembic | Critical/High | #30 | Alembic is the only production schema authority; empty-db boot proves migrations work |
| F4 | `/api/mcp/*` and `/api/identity/*` bypass internal HMAC | High | #31 | Every Go-proxied agent route requires internal authentication |
| F7 | HMAC does not bind method/body/query/org; no nonce replay prevention | High | #32 | Canonical signed request includes all security-relevant request components and nonce replay is rejected |
| F9 | MCP decryption silently returns ciphertext after key failures/rotation | Medium | #33 | Decryption fails closed and supports an explicit token-rotation lifecycle |
| F10 | MCP connection/tool state is process-local and replica-inconsistent | Medium/High | #33 | Runtime state converges across replicas after server/tool changes |
| F12 | Global MCP name collisions can overwrite another org's tool | Medium | #33 | Registry key is intrinsically tenant-scoped; cross-org collision is impossible |
| F15 / F16 | PII redaction may mutate executable queries; broad exception handling hides faults | Medium | #34 | PII policy is semantically safe; infrastructure failures are observable and fail appropriately |

The detailed evidence and the quick wins already completed are in `docs/harness-risk-review.md`.

---

## Architecture target

```text
Grafana browser
  → Go plugin resource proxy
      - Grafana RBAC
      - canonical HMAC signature: method, timestamp, nonce, raw target,
        body hash, org id
  → FastAPI internal-auth middleware
      - timestamp window + nonce replay rejection
      - protected /api/sessions, /api/mcp, /api/identity, /api/rca prefixes
  → Session / TurnWorker
      - session-scoped distributed lock held for entire turn
      - lease/retry recovery for orphaned work
  → Harness graph adapter
      - OrgToolRegistry(org_id)
      - GuardedToolExecutor for every tool call
      - GuardPipeline: RBAC → Cost → PII-safe output/input policy → Budget →
        Timeout → Write approval → Loop
  → Native Grafana + tenant-scoped MCP tools
```

### Invariants

1. No live tool invocation bypasses `GuardedToolExecutor`.
2. A session has one active turn across all processes/replicas.
3. An org can only enumerate, enable, execute, or retrieve data owned by that org.
4. The production schema is exactly Alembic head before the app serves traffic.
5. A signed proxy request cannot be altered or replayed within its validity window.
6. A configured MCP server/tool change converges on every worker without a restart.

---

## Implementation steps

### Step 5.0 — Establish release gates and regression fixtures

**Dependencies:** none.

1. Add a Phase 5 PR checklist linking issues #28–#34.
2. Add integration fixtures for two Grafana orgs, two MCP servers with the same display name, and two FastAPI worker processes.
3. Add a production-like empty Postgres boot test that runs the same container entrypoint used in deployment.
4. Mark the following as release blockers in the final integration-to-main PR: F1, F2, F3, F4, F7.

**Exit criteria**
- The CI suite can demonstrate two-org isolation and multi-worker execution.
- The final PR template has explicit release-gate checkboxes.

---

### Step 5.1 — Make Alembic the only schema authority (F3/F13)

**Dependencies:** Step 5.0.

1. Update the production container entrypoint to run `alembic upgrade head` before `uvicorn`.
2. Remove schema-mutating `Base.metadata.create_all` and ad-hoc DDL from `app/main.py`.
3. Retain an optional development-only schema check, but never create or alter schema at application runtime.
4. Add a schema-head check at startup:
   - production: fail closed when DB revision is not Alembic head;
   - development: emit a clear warning rather than mutating schema.
5. Verify migration `0005` is applied on a populated representative DB.
6. Add an Alembic downgrade/upgrade round-trip test for reversible migrations and document irreversible migrations explicitly.

**Tests**
- Empty Postgres: production entrypoint creates every table, including `mcp_server_configs`, `mcp_tool_overrides`, and `turn_jobs.attempts`.
- Existing Postgres at revision `0004`: upgrade produces revision `0005` safely.
- App boot against non-head schema fails in production.

**Exit criteria**
- `/api/mcp/servers` works after a clean production-style boot.
- No call to `create_all` remains in production startup.

---

### Step 5.2 — Replace the legacy direct-tool graph path with harness execution (F1)

**Dependencies:** Step 5.1.

1. Define a graph adapter contract that accepts `session_id`, `org_id`, authenticated identity, and an `OrgToolRegistry` view.
2. Refactor the live investigation graph so tool specifications originate from `OrgToolRegistry(org_id).tool_specs()`.
3. Route every returned tool call through `GuardedToolExecutor`:
   - call `GuardPipeline.run`;
   - execute `effective_input` after `Transform`;
   - persist guard decisions and tool-call state;
   - represent `ApprovalRequired` as a pause/resume workflow rather than executing;
   - enforce timeout, budget, and loop counters on the live path.
4. Decide the migration strategy for the legacy `app/agent/rca_graph.py`:
   - preferred: adapt it incrementally while preserving its behavior using the characterization fixtures;
   - do not run a second parallel tool-execution path indefinitely.
5. Register only the harness-wrapped graph in `GraphRegistry` for `investigation`.
6. Wire `MCPTool` instances into the same execution path as native tools.

**Tests**
- A smoke test proves that a live queued turn invokes `GuardPipeline.run`.
- Transform test: cost and PII transformations use `effective_input`, not the original tool input.
- Write tool test: action remains pending until the initiator approves it.
- Cross-org test: a tool configured by org A is absent from org B tool specs and cannot be invoked by name.
- Existing RCA characterization scenarios pass through the adapter without behavior regression.

**Exit criteria**
- No production graph calls `tool.run`, LangChain `ainvoke`, or `bind_tools` outside the guarded adapter.
- MCP tools become genuinely callable by the agent only for their owning org.

---

### Step 5.3 — Correct queue serialization and recovery (F2/F11)

**Dependencies:** Step 5.1.

1. Replace `pg_advisory_xact_lock` in the short claim transaction with one of:
   - a session-scoped `pg_advisory_lock` held over `_execute_turn` and released in `finally`; or
   - a database-enforced session claim (recommended: unique partial index for active/claimed turn by `session_id`) plus a transactional state transition.
2. Ensure the claim, lock acquisition, and job state transition cannot leave two executable jobs for one session.
3. Keep the orphaned-job lease reaper added in Phase 4, but make its attempt transitions explicit and observable.
4. Add a dead-letter/review state or structured error result for exhausted jobs instead of silently dropping them.
5. Add metrics: claimed count, lease requeues, exhausted jobs, lock contention, execution duration.

**Tests**
- Two workers / two pending turns for one session: exactly one graph execution at a time.
- Kill a worker mid-turn: lease expiry causes bounded retry.
- Exhaust attempts: job reaches terminal failure and is visible to operators.
- Different sessions execute concurrently.

**Exit criteria**
- ADR-003 claim "exactly one active turn per session" is true and demonstrated by an integration test.

---

### Step 5.4 — Harden the Go ↔ Python trust boundary (F4/F7)

**Dependencies:** Step 5.1. Go and Python changes must ship together.

1. Extend protected Python prefixes to `/api/sessions`, `/api/mcp`, `/api/identity`, and `/api/rca`.
2. Replace the current signature message with this canonical format:

   ```text
   method:timestamp:nonce:raw_target:body_sha256:org_id
   ```

   - `raw_target`: percent-encoded path plus raw query string;
   - `body_sha256`: SHA-256 of exact transmitted bytes;
   - `org_id`: verbatim injected `X-Grafana-Org-Id` value.

3. Add `X-Agent-Nonce` and server-side nonce replay prevention with TTL greater than timestamp skew.
4. Keep timing-safe signature comparison.
5. Require a non-empty `AGENT_INTERNAL_SECRET` in production startup validation.
6. Bind FastAPI to a private network interface where deployment supports it; document network policy/mTLS requirements.
7. Update Go signer and Python verifier tests together for encoded paths, raw query, changed body, changed org, replay, timestamp expiry, and nonce reuse.

**Tests**
- A valid request succeeds.
- Mutating method, query, body, raw path, or org after signing fails.
- Replaying the same nonce fails.
- MCP and identity routes reject unsigned direct requests.

**Exit criteria**
- Every Go-proxied agent route is authenticated internally and signed request content is fully bound.

---

### Step 5.5 — Make MCP tenancy and replica behavior correct (F9/F10/F12)

**Dependencies:** Step 5.2 and Step 5.4.

1. Replace the process-global MCP tool key with an intrinsically tenant-scoped key:

   ```text
   mcp:{org_id}:{server_id}:{tool_name}
   ```

   Human-facing display names may remain `mcp:{server_name}:{tool_name}`, but must not be the internal uniqueness key.
2. Remove direct mutation of `tool_registry._tools`; expose explicit registration/removal APIs or replace the singleton with a tenant-aware registry service.
3. Make DB configuration the source of truth across replicas:
   - preferred: transactional writes publish PostgreSQL `NOTIFY` events;
   - workers listen and refresh only affected `(org_id, server_id)`;
   - fallback: short TTL cache with version/revision polling.
4. Define connection status explicitly (`connected`, `degraded`, `disconnected`) and store/report it without treating a single replica's local state as global truth.
5. Change decryption behavior to fail closed. Store a key version with encrypted token material and provide an explicit rotation workflow:
   - decrypt with current/previous allowed key;
   - re-encrypt using current key;
   - mark server `degraded` and avoid outbound calls if token cannot decrypt.
6. Validate server URL/transport and avoid returning raw backend/credential errors to frontend users.

**Tests**
- Two orgs each name a server `github`; their tools cannot overwrite or remove each other.
- Add/toggle/delete on replica A converges on replica B.
- Invalid encryption key produces degraded status and does not send ciphertext as `Authorization: Bearer`.
- Tool enablement is enforced in the live graph, not merely registry metadata.

**Exit criteria**
- MCP behavior is deterministic across orgs and replicas.
- ADR-007 claims about immediate tool changes are true or revised to match documented propagation guarantees.

---

### Step 5.6 — Make policy failure semantics explicit (F15/F16)

**Dependencies:** Step 5.2.

1. Define whether PII redaction applies to:
   - user-visible transcripts and tool output;
   - tool metadata and audit logs;
   - executable query-language fields.
2. Do not silently rewrite executable PromQL/LogQL/SQL-like expression fields unless the resulting query semantics are explicitly approved and tested.
3. Prefer output/log redaction for sensitive observations; use input denial or approval for unsafe executable input.
4. Set a maximum input length before regex processing; use linear-time patterns where possible.
5. Replace broad exception swallowing with typed failure handling:
   - expected absent data → empty response;
   - unavailable dependency / DB / schema fault → structured 5xx + OTel error;
   - policy transform failure → deny safely, not allow.
6. Classify tool errors as retryable only for transient failures (timeouts, selected 5xx); use bounded backoff.

**Tests**
- PII in a query expression does not silently alter a query result.
- PII transform failure fails closed.
- Broken DB returns an observable 5xx, not an empty session list.
- Retry classification distinguishes a validation error from transient upstream failure.

**Exit criteria**
- Guard decisions are safe, explainable, and observable.

---

### Step 5.7 — Documentation, ADR corrections, and release validation

**Dependencies:** Steps 5.1–5.6.

1. Update ADR-003 after serialization implementation proves the invariant.
2. Update ADR-007 after MCP is truly live, tenant-scoped, and replica-consistent.
3. Update `docs/harness-risk-review.md` with remediation status and evidence.
4. Update `docs/manual-verification.md` with Phase 5 user/operator checks.
5. Run the final validation matrix:
   - Python unit, security, characterization, integration, and migration tests;
   - Go signing/proxy tests;
   - frontend typecheck/tests;
   - Testcontainers production-style clean boot;
   - two-org MCP isolation;
   - two-worker same-session serialization;
   - request-tamper/replay test suite;
   - local load/chaos validation.

**Exit criteria**
- All release blockers are resolved with automated evidence.
- The final `feat/orca-rca-integration → main` PR explicitly records the validation evidence.

---

## Recommended branch and PR structure

The work is too high-risk for one opaque Phase 5 PR. Use bounded branches, each based on the latest `feat/orca-rca-integration`:

```text
feat/orca-rca-integration
  ├── feat/agent-harness-phase-5-schema-auth       # Step 5.1
  ├── feat/agent-harness-phase-5-live-guard-path   # Step 5.2
  ├── feat/agent-harness-phase-5-queue-locking     # Step 5.3
  ├── feat/agent-harness-phase-5-internal-auth     # Step 5.4
  ├── feat/agent-harness-phase-5-mcp-tenancy       # Step 5.5
  └── feat/agent-harness-phase-5-policy-semantics  # Step 5.6 + 5.7
```

Merge order is strict: **schema → live guard path → queue → internal auth → MCP tenancy → policy/validation**. Do not parallelize writers that touch the graph/registry contract, migrations, or HMAC canonicalization without an explicit integration owner.

---

## Final release gates

The integration branch must not merge to `main` until all are true:

- [ ] F1: live tool calls run through `GuardedToolExecutor`.
- [ ] F2: one active turn per session is proven under multi-worker test.
- [ ] F3: production-style boot runs Alembic and exposes working MCP tables.
- [ ] F4: unsigned `/api/mcp`, `/api/identity`, `/api/rca`, and `/api/sessions` requests are rejected.
- [ ] F7: signed request tampering and nonce replay are rejected.
- [ ] Two-org MCP isolation and identical-server-name collision tests pass.
- [ ] Encryption rotation/failure is fail-closed.
- [ ] Full test and manual verification evidence is attached to the final PR.
