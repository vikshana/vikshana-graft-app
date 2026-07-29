# Harness Risk Review — Findings (Phases 0–4)

**Review date:** 2026-07-10
**Reviewer:** Architecture risk review (oracle-assisted)
**Scope:** `services/orca/backend/harness/**`, `app/api/**`, `pkg/plugin/**` across harness phases 0–4
**Branch reviewed:** `feat/agent-harness-phase-4` (PR #27)

> **Status as of `61534e4` ("fix(backend): harden agent harness"): all of F1–F16
> below are resolved.** This document is kept as the historical record of the
> review — the problem descriptions under "Tracked for Phase 5" are preserved
> verbatim as they were written against PR #27, before the fix. See
> [Implementation Resolution (`61534e4`)](#implementation-resolution-61534e4)
> for what actually changed and where, and the
> [updated recommendation](#updated-recommendation-post-61534e4) at the
> bottom, which supersedes the original "Recommendation for the final PR"
> section.

---

## Executive summary

The harness was built as a clean, well-tested subsystem, but the single most important structural finding at review time was that **it was not yet on the live request path**. The only graph registered with the `TurnWorker` was the legacy `app/agent/rca_graph.py`, which bound tools via LangChain directly — so the harness guard pipeline, org-scoped tool registry, and MCP tool-execution path were dead code in production. Most high-severity findings flowed from the gap between "the tests exercise it" and "production runs it".

Findings were originally split into:
- **Fixed** — quick wins resolved in PR #27 (`154990d`).
- **Tracked** — structural items filed as GitHub issues for a follow-up Phase 5.

Commit `61534e4` resolved every item that was still "Tracked" (F1, F2, F3/F13,
F4, F7, F9, F10, F12, F15, F16) — see the status table and resolution section
below.

Legend: **[CONFIRMED]** = provable from code · **[RISK]** = needs runtime/infra verification.

---

## Status overview

| ID | Title | Severity | Status | Resolved in | Issue (historical) |
|----|-------|----------|--------|-------------|-----|
| F1 | Guards / OrgToolRegistry / MCP execution not on live path | Critical | **Fixed** | `61534e4` | [#28](https://github.com/vikshana/vikshana-graft-app/issues/28) |
| F2 | Advisory lock released before turn executes | Critical | **Fixed** | `61534e4` | [#29](https://github.com/vikshana/vikshana-graft-app/issues/29) |
| F3 | MCP tables never created in prod (`create_all` vs Alembic) | Critical/High | **Fixed** | `61534e4` | [#30](https://github.com/vikshana/vikshana-graft-app/issues/30) |
| F4 | `/api/mcp/*` & `/api/identity/*` bypass HMAC | High | **Fixed** | `61534e4` | [#31](https://github.com/vikshana/vikshana-graft-app/issues/31) |
| F5 | IDOR on MCP endpoints (missing org checks) | High | **Fixed** | `154990d` (PR #27) | — |
| F6 | Drill-down & feedback not org-scoped | High | **Fixed** | `154990d` (PR #27) | — |
| F7 | HMAC omits body/org, 60s replay, no nonce | High | **Fixed** | `61534e4` | [#32](https://github.com/vikshana/vikshana-graft-app/issues/32) |
| F8 | Hardcoded/empty encryption keys, plaintext fallback | High | **Fixed** | `154990d` (PR #27) | — |
| F9 | `decrypt_token` silently returns ciphertext | Medium | **Fixed** | `61534e4` | [#33](https://github.com/vikshana/vikshana-graft-app/issues/33) |
| F10 | Per-replica MCP state inconsistent | Medium/High | **Fixed** (bounded convergence — see caveat below) | `61534e4` | [#33](https://github.com/vikshana/vikshana-graft-app/issues/33) |
| F11 | No reaper for orphaned `claimed` turn_jobs | Medium | **Fixed** | `154990d` (PR #27) | — |
| F12 | MCP qualified-name collisions across orgs | Medium | **Fixed** | `61534e4` | [#33](https://github.com/vikshana/vikshana-graft-app/issues/33) |
| F13 | Dual schema authority, no downgrade testing | Medium | **Fixed** (schema authority; downgrade testing still not exercised) | `61534e4` | [#30](https://github.com/vikshana/vikshana-graft-app/issues/30) |
| F14 | Committed `.pyc` / `__pycache__` artifacts | Low/Medium | **Fixed** | `154990d` (PR #27) | — |
| F15 | PII guard rewrites query fields; low ReDoS risk | Low/Medium | **Fixed** | `61534e4` | [#34](https://github.com/vikshana/vikshana-graft-app/issues/34) |
| F16 | Broad `except` → silent empty/allow | Medium | **Fixed** | `61534e4` | [#34](https://github.com/vikshana/vikshana-graft-app/issues/34) |

Bonus: a latent Phase-4 test-isolation bug (`tests/unit/mcp/` shadowing the `mcp` PyPI package) was found and fixed while resolving the characterization-test flakiness (renamed to `tests/unit/mcp_client/`).

---

## Fixed in PR #27 (historical — commit `154990d`)

### F5 — IDOR on MCP endpoints — [CONFIRMED] — High
**Problem.** `toggle_mcp_tool` had no org check; `list_mcp_tools` ignored org; `add_mcp_server` defaulted to `org_id or 1`, silently writing another org's config into org 1.

**Fix.** Added a `_require_org` dependency (400 on missing/invalid `X-Grafana-Org-Id`) and an `_assert_server_owned_by_org` helper (returns 404 — not 403 — so callers cannot enumerate cross-org existence). All six endpoints (`list`/`add`/`delete`/`reconnect`/`list-tools`/`toggle-tool`) are now org-scoped, and the insecure `org_id or 1` default was removed.

**Files.** `app/api/mcp_servers.py`.

### F6 — Drill-down & feedback not org-scoped — [CONFIRMED] — High
**Problem.** `get_drill_down` queried `drill_down_results` by `handle` with no org filter; a leaked/guessed handle returned another org's evidence. `post_session_feedback` wrote feedback for any `session_id` with no ownership check.

**Fix.** `get_drill_down` now joins `drill_down_results → rca_sessions` and filters on the session's `org_id` (404 on mismatch, no existence leak). `post_session_feedback` verifies session ownership before recording. Both require a valid org header (400 otherwise). No schema change was needed — the join reuses the existing `session_id` FK.

**Files.** `app/api/sessions.py`. Integration tests assert cross-org 404 and missing-org 400.

### F8 — Insecure encryption keys in production — [CONFIRMED] — High
**Problem.** `OBO_ENCRYPTION_KEY` had a hardcoded dev default (`"devkey00…"`) in source; `MCP_ENCRYPTION_KEY` defaulted empty → MCP bearer tokens stored **plaintext**. No production guard.

**Fix.** Added `Settings.ENVIRONMENT` and `validate_production_secrets()`. Startup aborts in production if `OBO_ENCRYPTION_KEY` is empty/dev-default or `MCP_ENCRYPTION_KEY` is empty. Development is unaffected.

**Files.** `app/config.py`, `app/main.py`.

### F11 — No reaper for orphaned `claimed` turn_jobs — [CONFIRMED] — Medium
**Problem.** On a worker crash between claim (`status='claimed'`) and `_mark_job`, the row stayed `claimed` forever — the turn was silently lost and polluted the `enqueue_turn` busy-count. The existing reaper only cleaned `rcas`, not `turn_jobs`.

**Fix.** Added a `turn_jobs.attempts` column (ORM + Alembic `0005`). Claim increments `attempts`. `TurnWorker._reap_orphaned_jobs` resets stale `claimed` jobs (older than a lease TTL) back to `pending`, and marks attempt-exhausted jobs `failed` to stop a crash-retry loop. New env: `TURN_JOB_LEASE_TTL_S` (default 600), `TURN_JOB_MAX_ATTEMPTS` (default 5).

> Note: at the time of PR #27 this mitigated orphaned jobs but did **not**
> fix the concurrency hole in F2. F2 itself was subsequently fixed in
> `61534e4` — see [Implementation Resolution](#implementation-resolution-61534e4).

**Files.** `harness/session/worker.py`, `harness/session/models.py`, `harness/migrations/versions/0005_turn_jobs_attempts.py`.

### F14 — Committed bytecode artifacts — [CONFIRMED] — Low/Medium
**Problem.** 21 `__pycache__/*.pyc` files were force-added past the `services/` gitignore, proving the ignore boundary was bypassable.

**Fix.** Removed all tracked bytecode, added explicit `__pycache__/`, `*.pyc`, `*.pyo` to `.gitignore`, and added a CI `security-scan` step that fails if any `.pyc`/`__pycache__` is tracked.

**Files.** `.gitignore`, `.github/workflows/ci.yml`.

### Bonus — Test-package shadowing — [CONFIRMED]
**Problem.** `tests/unit/mcp/__init__.py` made the test package importable as top-level `mcp`, shadowing the `mcp` PyPI library so `from mcp import ClientSession` failed depending on import order. This was the real cause of the characterization-test flakiness (not the missing `app/agent/__init__.py`).

**Fix.** Renamed `tests/unit/mcp/` → `tests/unit/mcp_client/`. Full-suite run is green (410 passed).

---

## Implementation Resolution (`61534e4`)

Commit `61534e4` ("fix(backend): harden agent harness") resolved every
finding that was still "Tracked" above. This section states what actually
changed and where; the following "Original Findings" section preserves the
pre-fix problem descriptions verbatim for historical record.

### F1 — Guard pipeline & org-scoped registry wired into the live path

`app/agent/rca_graph.py`'s `data_gathering_node` and `refine_node` no longer
call `llm.bind_tools(get_grafana_tools())` + `tool.ainvoke()` directly. Both
nodes now build a per-turn `ToolRegistry` (built-in Grafana MCP tools +
org-scoped `OrgToolRegistry` entries via `_build_turn_tool_registry`) and
dispatch every LLM tool call through `GuardedToolExecutor`
(`harness/tools/bridge.py`), which runs `GuardPipeline.run()` (RBAC, PII,
Cost, Budget, Timeout, Write-approval, Loop) before invoking `tool.run()`.
Guard state (`spend.call_count`, the session's wall-clock start) is threaded
through `RCAState` across rounds so budgets apply to the whole investigation,
not just one node call. Unregistered tool names raise
`ToolNotRegisteredError` rather than executing. Real tool names (including
long, colon-separated MCP-qualified names) are exposed to the LLM via
collision-safe wire aliases (`harness/tools/naming.py`) and resolved back
before dispatch. **Caveat preserved from the original finding:** no
approval-flow consumer is wired in — a tool call that resolves to
`ApprovalRequired` is refused with a message to the LLM, never executed, but
there is no human-in-the-loop UI connected to this executor. This is
defense-in-depth (no write-class tool is registered on the live RCA path
today), not an implemented approval workflow.

**Files.** `app/agent/rca_graph.py`, `harness/tools/bridge.py` (new),
`harness/tools/naming.py` (new), `harness/tools/langchain_adapter.py` (new),
`harness/session/registry.py` (`aget()` — see F1's `TurnWorker` sub-issue
below), `harness/mcp/registry_bridge.py`.

*Sub-issue also fixed:* `TurnWorker._execute_turn` previously called the
synchronous `graph_registry.get(session_type)` against the async production
factory `app.agent.rca_graph.get_rca_graph`, caching an un-awaited coroutine.
`GraphRegistry.aget()` now transparently awaits async factories, and `get()`
raises a clear `TypeError` instead of silently caching a coroutine.

### F2 — Non-blocking, transaction-scoped advisory lock + heartbeat

`TurnWorker._poll_once` no longer holds a blocking
`pg_advisory_xact_lock` across a commit that immediately releases it (the
original bug: the lock was released right after being acquired, before the
turn ran). It now claims the job on a pooled connection (committed
immediately), then acquires `pg_try_advisory_xact_lock(hashtext(session_id))`
— non-blocking — on a *separate* execution connection held open for the
duration of `_execute_turn`. If the lock is unavailable (another
worker/replica already holds it for this session), the job is immediately
returned to `pending` via `_requeue_busy_job` (with its `attempts` counter
reverted, since this is healthy contention, not a crash) rather than
blocking. A background `_heartbeat_loop` refreshes `claimed_at` every
`TURN_JOB_HEARTBEAT_INTERVAL_S` (default 60s) while the turn executes, so
`_reap_orphaned_jobs` never requeues a turn that is still legitimately
running. Because the lock is transaction-scoped, ending the transaction
(commit or rollback, including on cancellation) always releases it — there
is no separate unlock call that can fail to run.

**Files.** `harness/session/worker.py`. See
[ADR-003](decisions/ADR-003-worker-queue.md).

### F3 / F13 — Alembic is the sole schema authority

`app/main.py`'s lifespan no longer calls `Base.metadata.create_all` or runs
ad-hoc `ALTER TABLE ... ADD COLUMN IF NOT EXISTS`. `docker-entrypoint.sh`
(new) runs `alembic upgrade head` before `uvicorn` starts in the container.
`app/schema_check.py` (new) is a defense-in-depth startup check: it compares
the DB's Alembic revision against the packaged head and raises
`SchemaRevisionError` (refusing to serve) when `ENVIRONMENT=production` and
they don't match; in development it only warns. MCP tables are now created
by the same Alembic chain as every other table — there is exactly one
schema authority. **Not addressed:** downgrade paths are still not
exercised by any test (F13's "no downgrade testing" half remains open).

**Files.** `services/orca/backend/docker-entrypoint.sh` (new),
`app/schema_check.py` (new), `app/main.py`,
`tests/unit/test_schema_authority.py` (new).

### F4 — HMAC enforced on every internal prefix

`InternalAuthMiddleware._PROTECTED_PREFIXES` now covers `/api/sessions`,
`/api/mcp`, `/api/identity`, **and** `/api/rca` (previously only
`/api/sessions`). `pkg/plugin/app.go`'s `/rca` proxy Director now calls
`signInternalRequest` the same way `/sessions` and `/mcp` already did.

**Files.** `harness/auth/internal_auth.py`, `pkg/plugin/app.go`.

### F7 — Full request binding + nonce replay defense

The signature now covers `method:timestamp:nonce:target:body_sha256:org_id`
— method, the raw percent-encoded path + raw query (`target`), a SHA-256
digest of the raw body, and the verbatim `X-Grafana-Org-Id` value — not just
`timestamp:path`. A per-request nonce (`X-Agent-Nonce`) is generated by the
Go signer (`pkg/plugin/internal_signer.go`) and checked against a bounded,
TTL-expiring in-memory cache (`_NonceCache`: 90s TTL, 10k-entry cap) on the
Python side before the request is accepted a second time. The freshness
window was tightened from 60s to 30s. **Caveat:** the nonce cache is
in-memory and per-process — sufficient because the harness backend runs as
a single replica today; it is **not** a shared/global replay cache and would
need to move to a shared store (e.g. Redis) if Orca is ever scaled to
multiple replicas.

**Files.** `harness/auth/internal_auth.py`, `pkg/plugin/internal_signer.go`
(new), `pkg/plugin/session_proxy.go`, `pkg/plugin/app.go`.

### F9 — Decrypt failures fail closed

`decrypt_token` raises `TokenDecryptionError` on a decrypt failure (malformed
ciphertext or a rotated key) instead of returning the ciphertext unchanged.
`MCPClientManager.connect()` and `set_tool_enabled()` propagate this and
refuse to register/enable the affected tool; `toggle_mcp_tool` surfaces it
to the API caller as a 422.

**Files.** `harness/mcp/crypto.py`, `harness/mcp/client_manager.py`,
`app/api/mcp_servers.py`.

### F10 — Bounded, not immediate, cross-replica MCP convergence

`MCPClientManager` state is still per-replica, in-memory, with Postgres as
the source of truth — this was not changed to a shared/synchronous model.
What was added is `reconcile()`, a full diff-and-converge pass against the
DB, invoked two ways: a bounded periodic background loop
(`MCP_RECONCILE_INTERVAL_S`, default 30s, started in `app/main.py`'s
lifespan) and an on-access, TTL-gated call (`ensure_fresh()`,
`MCP_RECONCILE_TTL_S`, default 10s) from the `/api/mcp/*` read/write paths.
**This bounds staleness to roughly `min(MCP_RECONCILE_INTERVAL_S, time since
last access)` — it is not immediate or push-based** (no LISTEN/NOTIFY); a
replica can still serve a stale view for up to the reconcile interval.

**Files.** `harness/mcp/client_manager.py`, `app/main.py`,
`app/api/mcp_servers.py`, `app/config.py`.

### F12 — MCP registry keys are org-qualified

`DiscoveredTool.qualified_name` changed from `mcp:{server_name}:{tool_name}`
to `mcp:{org_id}:{server_name}:{tool_name}`. Two orgs naming a server
identically no longer collide in the shared process-global `ToolRegistry`,
and disconnecting one org's server can no longer deregister another org's
live tool.

**Files.** `harness/mcp/models.py`.

### F15 / F16 — PII field exclusion + fail-closed guard; error classification

`PIIRedactionGuard` now excludes `expr`/`query` fields (`_QUERY_LANGUAGE_FIELDS`)
from redaction entirely — a PII-looking match in a PromQL/LogQL query is
logged (without echoing the match) but the query string is left untouched,
so redaction can never silently change what a query executes. The guard also
now **fails closed**: an internal error while inspecting or re-validating
input returns `Deny`, not `Allow`. Separately, `list_sessions` and
`search_sessions` (`app/api/sessions.py`) now distinguish a genuinely empty
result (returned normally) from a DB/embedding failure (raised as an HTTP
503) instead of collapsing both into a silent empty list. Tool-call error
classification (`harness/tools/error_classification.py`, new; and
`harness/mcp/tool_adapter.py`'s `_classify_error`) sets `retryable` from the
actual exception type (timeouts/connection errors retryable; HTTP 4xx and
protocol-level rejections not retryable) instead of defaulting every
failure to `retryable=True`.

**Files.** `harness/guards/pii.py`, `app/api/sessions.py`,
`harness/tools/error_classification.py` (new), `harness/mcp/tool_adapter.py`,
`harness/tools/bridge.py`.

---

## Updated recommendation (post-`61534e4`)

The original "Recommendation for the final PR" below (calling out F1, F3,
and F4 as merge gates) is **obsolete** — all three are fixed as of `61534e4`
and the harness security layer (guards, org-scoped registry, HMAC on every
internal prefix, Alembic-only schema) is now on the live path. Remaining
forward-looking items, none of which block a merge on their own:

- **No approval-flow consumer** (F1 caveat) — add one before registering any
  `CostClass.WRITE` tool on the live RCA path; today `ApprovalRequired` is
  refused, not executed, so this is safe but incomplete.
- **Nonce replay cache is per-process** (F7 caveat) — move to a shared store
  before running Orca with more than one replica.
- **MCP convergence is bounded, not instant** (F10 caveat) — acceptable at
  current scale; revisit if `/api/mcp/*` write latency-to-visibility
  becomes a product requirement.
- **Alembic downgrade paths are untested** (F13 remainder).
- **The Python test suite is not run in CI** — see `ARCHITECTURE.md` §
  Testing / Known CI gap. `pytest` for `services/orca/backend/tests/` must
  be run manually; no workflow invokes it today.

---

## Original Findings — Detailed Problem Statements (historical)

> Preserved as written at review time (against PR #27, before `61534e4`).
> Every finding below is now **Fixed** — see
> [Implementation Resolution](#implementation-resolution-61534e4) above for
> what changed.

### F1 — Harness guard/tool machinery is dead code in the live path — [CONFIRMED] — Critical
Issue [#28](https://github.com/vikshana/vikshana-graft-app/issues/28).

The only registered graph is `get_rca_graph` (`app/main.py:121`), which uses `bind_tools(get_grafana_tools())`. `GuardPipeline.run`, `make_default_pipeline`, `OrgToolRegistry`, and `MCPTool.run` have **zero non-test callers**. Consequences:
- Every guard — RBAC re-check, PII redaction, Cost, Budget, Timeout, **Write-approval**, Loop — is inert at runtime.
- User-configured MCP tools register into `tool_registry`, which the live agent never reads → **MCP tools are never callable by the agent** (contradicts ADR-007 §6).
- If the harness graph is wired in later, write tools would execute with no approval because the executor that consumes `ApprovalRequired` doesn't exist.

**Fix direction.** Route the live agent through the harness executor + `OrgToolRegistry.tool_specs(org_id)`, or explicitly document the harness as not-yet-wired and correct the ADRs. Add a smoke test asserting `GuardPipeline.run` is on the hot path.

### F2 — Advisory lock released before the turn executes — [CONFIRMED] — Critical
Issue [#29](https://github.com/vikshana/vikshana-graft-app/issues/29).

`harness/session/worker.py` acquires `pg_advisory_xact_lock(hashtext(session_id))` then `await db.commit()` immediately, ending the transaction and releasing the xact-scoped lock. Two `turn_jobs` rows for the same session are distinct rows, so `FOR UPDATE SKIP LOCKED` skips only *rows* — two workers can run `graph.ainvoke(config={"thread_id": session_id})` concurrently against the same LangGraph checkpoint → corruption. Contradicts ADR-003 "exactly one active turn per session".

**Fix direction.** Hold a session-scoped `pg_advisory_lock` for the duration of `_execute_turn` (release in `finally`), or claim by `session_id` with a partial unique index on `status='claimed'` per session.

### F3 / F13 — Production never creates MCP tables; dual schema authority — [CONFIRMED] — Critical/High
Issue [#30](https://github.com/vikshana/vikshana-graft-app/issues/30).

Production boots `uvicorn app.main:app` and builds schema via `Base.metadata.create_all` + ad-hoc `ALTER TABLE ... ADD COLUMN IF NOT EXISTS`; it never runs `alembic upgrade`. `mcp_server_configs` / `mcp_tool_overrides` exist only in Alembic `0004`, and the MCP models are plain `@dataclass` (not ORM), so `create_all` doesn't create them. In production, `mcp_client_manager.startup` hits `relation does not exist` (swallowed as a warning) and all `/api/mcp/*` endpoints 500 — **the MCP feature is dead in prod but green in tests** because testcontainers run Alembic. Downgrades are never exercised.

**Fix direction.** Pick one schema authority: either make MCP tables real ORM models included in `create_all`, or run `alembic upgrade head` at container start and drop `create_all`. Add a CI check that boots the prod entrypoint against an empty DB and hits `/api/mcp/servers`.

### F4 — MCP & identity endpoints bypass HMAC internal auth — [CONFIRMED] — High
Issue [#31](https://github.com/vikshana/vikshana-graft-app/issues/31).

`InternalAuthMiddleware` enforces HMAC only for `path.startswith("/api/sessions")`. `/api/mcp/*` (token storage) and `/api/identity/*` are unauthenticated at the Python layer — reachable with a spoofed `X-Grafana-Org-Id` by anything that can reach the FastAPI port. The F5/F6 org-ownership checks reduce blast radius but the endpoints are still reachable without HMAC.

**Fix direction.** Enforce HMAC on all Go-proxied prefixes (`/api/mcp`, `/api/identity`, `/api/rca`), or bind FastAPI to a private interface / mTLS with a mandatory shared secret in prod.

### F7 — HMAC omits body/org, 60s replay, no nonce — [CONFIRMED] — High
Issue [#32](https://github.com/vikshana/vikshana-graft-app/issues/32).

The signature covers only `ts:path` — not body, query, or `X-Grafana-Org-Id`. A captured request can be replayed for 60s with a different body or org and still validate.

**Fix direction.** Sign `ts:method:path:sha256(body):org_id`; add a nonce with a short server-side seen-cache; tighten skew. Keep `compare_digest`.

### F9 / F10 / F12 — MCP client-manager robustness — [CONFIRMED] — Medium
Issue [#33](https://github.com/vikshana/vikshana-graft-app/issues/33).

- **F9.** `decrypt_token` catches all exceptions and returns raw ciphertext → after key rotation the manager sends ciphertext as a bearer token, silently. No re-encrypt path.
- **F10.** `MCPClientManager` keeps state in memory; add/toggle/reconnect mutate only the serving replica. ADR-007 "toggles take effect immediately (no restart)" is false at >1 replica.
- **F12.** Qualified names `mcp:{server_name}:{tool}` are unique only per `(org_id, url)`; with a process-global dict and `replace=True`, two orgs naming a server "github" overwrite each other, and one disconnecting removes the other's tool. Latent until F1 wires the registry in.

**Fix direction.** Fail loud on decrypt error + add key versioning; make the DB the runtime source of truth (per-request load or TTL/LISTEN-NOTIFY); namespace by `org_id` or key the registry by `(org_id, name)`.

### F15 / F16 — PII query-field rewrite & broad exception swallowing — Medium
Issue [#34](https://github.com/vikshana/vikshana-graft-app/issues/34).

- **F15.** The PII guard runs before Cost and rewrites string fields; redacting an IP/number embedded in a PromQL `expr` mutates the query that ultimately executes. ReDoS risk is low (polynomial, not exponential). Latent per F1.
- **F16.** `list_sessions`/`search_sessions` return empty on any error; MCP failures become warnings; PII transform failure → `Allow()`; `tool_adapter` marks every error `retryable=True`. This produces operational blindness and potential retry storms.

**Fix direction.** Exclude query-language fields from PII redaction (or run Cost first); distinguish expected-empty from error and surface 5xx on infra failures; set `retryable` from the actual error class.

---

## ADR contradictions to correct (historical — resolved in `61534e4`)

These were true against PR #27 and have since been fixed alongside the ADRs
themselves (see [ADR-003](decisions/ADR-003-worker-queue.md) and
[ADR-007](decisions/ADR-007-mcp-architecture.md), both amended to describe
current behaviour):

- **ADR-003** "exactly one active turn per session" → was false (F2); now
  true via the non-blocking `pg_try_advisory_xact_lock` + heartbeat design.
- **ADR-007** §3/§6 org-scoping + "tools immediately available to sessions"
  → was false (F1, F3, F10); tools are now org-qualified in the registry key
  and routed through the guard pipeline (F1/F3), and "immediately available"
  has been corrected to describe the bounded reconcile-based convergence
  that actually exists (F10).
- `internal_auth.py` docstring overselling replay/path binding → now
  documents the full `method:timestamp:nonce:target:body_sha256:org_id`
  binding and the per-process nonce-cache caveat (F7).

---

## Recommendation for the final PR (historical — superseded)

> **Superseded.** This section reflects the state at PR #27 and is kept for
> historical record only. See
> [Updated recommendation (post-`61534e4`)](#updated-recommendation-post-61534e4)
> above for the current guidance.

The quick-win fixes harden the reachable API surface, but **F1, F3, and F4 should gate the final merge to `main`** — the harness security layer isn't wired into the live path (F1), the MCP feature has no tables in production (F3), and its management endpoints are unauthenticated at the Python layer (F4). Until those are resolved, the harness should be treated as not production-ready even though its unit tests pass.
