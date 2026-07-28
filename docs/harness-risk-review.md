# Harness Risk Review — Findings (Phases 0–4)

**Review date:** 2026-07-10
**Reviewer:** Architecture risk review (oracle-assisted)
**Scope:** `services/orca/backend/harness/**`, `app/api/**`, `pkg/plugin/**` across harness phases 0–4
**Branch reviewed:** `feat/agent-harness-phase-4` (PR #27)

---

## Executive summary

The harness was built as a clean, well-tested subsystem, but the single most important structural finding is that **it is not yet on the live request path**. The only graph registered with the `TurnWorker` is the legacy `app/agent/rca_graph.py`, which binds tools via LangChain directly — so the harness guard pipeline, org-scoped tool registry, and MCP tool-execution path are dead code in production today. Most high-severity findings flow from the gap between "the tests exercise it" and "production runs it".

Findings are split into:
- **Fixed** — quick wins resolved in PR #27 (this branch).
- **Tracked** — structural items filed as GitHub issues for a follow-up Phase 5.

Legend: **[CONFIRMED]** = provable from code · **[RISK]** = needs runtime/infra verification.

---

## Status overview

| ID | Title | Severity | Status | Issue |
|----|-------|----------|--------|-------|
| F1 | Guards / OrgToolRegistry / MCP execution not on live path | Critical | Tracked | [#28](https://github.com/vikshana/vikshana-graft-app/issues/28) |
| F2 | Advisory lock released before turn executes | Critical | Tracked | [#29](https://github.com/vikshana/vikshana-graft-app/issues/29) |
| F3 | MCP tables never created in prod (`create_all` vs Alembic) | Critical/High | Tracked | [#30](https://github.com/vikshana/vikshana-graft-app/issues/30) |
| F4 | `/api/mcp/*` & `/api/identity/*` bypass HMAC | High | Tracked | [#31](https://github.com/vikshana/vikshana-graft-app/issues/31) |
| F5 | IDOR on MCP endpoints (missing org checks) | High | **Fixed** | — |
| F6 | Drill-down & feedback not org-scoped | High | **Fixed** | — |
| F7 | HMAC omits body/org, 60s replay, no nonce | High | Tracked | [#32](https://github.com/vikshana/vikshana-graft-app/issues/32) |
| F8 | Hardcoded/empty encryption keys, plaintext fallback | High | **Fixed** | — |
| F9 | `decrypt_token` silently returns ciphertext | Medium | Tracked | [#33](https://github.com/vikshana/vikshana-graft-app/issues/33) |
| F10 | Per-replica MCP state inconsistent | Medium/High | Tracked | [#33](https://github.com/vikshana/vikshana-graft-app/issues/33) |
| F11 | No reaper for orphaned `claimed` turn_jobs | Medium | **Fixed** | — |
| F12 | MCP qualified-name collisions across orgs | Medium | Tracked | [#33](https://github.com/vikshana/vikshana-graft-app/issues/33) |
| F13 | Dual schema authority, no downgrade testing | Medium | Tracked | [#30](https://github.com/vikshana/vikshana-graft-app/issues/30) |
| F14 | Committed `.pyc` / `__pycache__` artifacts | Low/Medium | **Fixed** | — |
| F15 | PII guard rewrites query fields; low ReDoS risk | Low/Medium | Tracked | [#34](https://github.com/vikshana/vikshana-graft-app/issues/34) |
| F16 | Broad `except` → silent empty/allow | Medium | Tracked | [#34](https://github.com/vikshana/vikshana-graft-app/issues/34) |

Bonus: a latent Phase-4 test-isolation bug (`tests/unit/mcp/` shadowing the `mcp` PyPI package) was found and fixed while resolving the characterization-test flakiness.

---

## Fixed in PR #27

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

> Note: this mitigates orphaned jobs but does **not** fix the concurrency hole in F2.

**Files.** `harness/session/worker.py`, `harness/session/models.py`, `harness/migrations/versions/0005_turn_jobs_attempts.py`.

### F14 — Committed bytecode artifacts — [CONFIRMED] — Low/Medium
**Problem.** 21 `__pycache__/*.pyc` files were force-added past the `services/` gitignore, proving the ignore boundary was bypassable.

**Fix.** Removed all tracked bytecode, added explicit `__pycache__/`, `*.pyc`, `*.pyo` to `.gitignore`, and added a CI `security-scan` step that fails if any `.pyc`/`__pycache__` is tracked.

**Files.** `.gitignore`, `.github/workflows/ci.yml`.

### Bonus — Test-package shadowing — [CONFIRMED]
**Problem.** `tests/unit/mcp/__init__.py` made the test package importable as top-level `mcp`, shadowing the `mcp` PyPI library so `from mcp import ClientSession` failed depending on import order. This was the real cause of the characterization-test flakiness (not the missing `app/agent/__init__.py`).

**Fix.** Renamed `tests/unit/mcp/` → `tests/unit/mcp_client/`. Full-suite run is green (410 passed).

---

## Tracked for Phase 5

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

## ADR contradictions to correct

- **ADR-003** "exactly one active turn per session" → false (F2).
- **ADR-007** §3/§6 org-scoping + "tools immediately available to sessions" → false (F1, F3, F10).
- `internal_auth.py` docstring overselling replay/path binding → omits body + org (F7).

---

## Recommendation for the final PR (`feat/orca-rca-integration → main`)

The quick-win fixes harden the reachable API surface, but **F1, F3, and F4 should gate the final merge to `main`** — the harness security layer isn't wired into the live path (F1), the MCP feature has no tables in production (F3), and its management endpoints are unauthenticated at the Python layer (F4). Until those are resolved, the harness should be treated as not production-ready even though its unit tests pass.
