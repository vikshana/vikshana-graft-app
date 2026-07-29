# AGENTS.md — Repo Map for Coding Agents

This is a navigational map, not a tutorial. It tells you what lives where,
what to read before touching it, and which changes are dangerous if made
on only one side of a boundary. For conventions/workflow (branching, commit
format, PR process) see `CLAUDE.md` — this file does not repeat that.

Verified against commit `61534e4` ("fix(backend): harden agent harness").

## Subsystem map

| Path | What it is | Read first |
|---|---|---|
| `src/` | Grafana app plugin frontend (React/TS) — chat, RCA, sessions, MCP config UI | `src/AGENTS.md` |
| `pkg/plugin/` | Go plugin backend — resource routes, RBAC, HMAC signing, reverse proxies | `pkg/plugin/AGENTS.md` |
| `services/orca/backend/` | Python FastAPI service ("Orca") — webhooks, RCA graph, harness | `services/orca/backend/AGENTS.md` |
| `services/orca/backend/harness/` | Guard pipeline, tool registry, MCP client, session queue, auth chain, Slack | `services/orca/backend/harness/AGENTS.md` |
| `services/orca/backend/app/` | Legacy/production FastAPI app: routers, ORM models, the live RCA LangGraph | see backend guide |
| `docs/` | Design docs, ADRs (`docs/decisions/`), risk review, phase plan | `docs/HARNESS_PLAN.md`, `docs/harness-risk-review.md` |
| `docker-compose.yaml`, `Makefile` | Full-stack dev environment (Grafana + Orca + observability) | root `Makefile` targets |

Request path for anything agent/RCA/session related, end to end:

```
Browser (src/services/*Api.ts)
  → Grafana → plugin resource route (pkg/plugin/*.go: /rca, /sessions, /mcp)
      → HMAC-signed + org-ID-injected reverse proxy
          → FastAPI (services/orca/backend/app/main.py middleware + routers)
              → harness/ (guards, tool registry, MCP, session worker)
```

Chat (`/` route, `ChatInterface`) does **not** go through this path — it
calls `@grafana/llm` directly. See `src/AGENTS.md`.

## The `services/` gitignore trap

Root `.gitignore` ignores `services/` wholesale (line ~63), but 200+ files
under `services/orca/` are already tracked — they were force-added
(`git add -f`) before the ignore rule existed. This means:

- **Editing an already-tracked file under `services/`** works normally —
  `git status` / `git add` see it.
- **Creating a *new* file under `services/`** (a new module, a new
  migration, a new test file) is **silently invisible** to plain
  `git add -A` / `git status`. It will not show up as untracked, and a
  commit will not include it, unless you explicitly force-add it:

  ```bash
  git add -f services/orca/backend/harness/whatever_new_file.py
  ```

- Before committing any change that touches `services/`, run
  `git status --porcelain services/` and diff the file count against what
  you expect — a missing new file here is the most common way a PR silently
  ships broken (imports a module that was never committed).
- CI has a `security-scan` step that fails the build if `__pycache__`/`*.pyc`
  end up tracked again (this happened once — see `docs/harness-risk-review.md`
  F14) — don't work around the ignore rule by removing `__pycache__/` from
  `.gitignore`; force-add only the source file you intended to add.

## Pair-change rules

These changes are split across a process/language boundary. Changing one
side without the other produces something that passes its own unit tests
and still breaks at runtime.

### 1. Go ↔ Python internal HMAC contract

Signer: `pkg/plugin/internal_signer.go` (`signInternalRequest`).
Verifier: `services/orca/backend/harness/auth/internal_auth.py`
(`InternalAuthMiddleware`, `_compute_signature`).

Both sides must agree on:
- Message format: `method:timestamp:nonce:target:body_sha256:org_id`
  (colon-joined, exact field order).
- `target` = **raw percent-encoded** path + `?`-prefixed raw query — Go's
  `req.URL.EscapedPath()`, Python's ASGI `raw_path` (not the decoded
  `request.url.path` / `req.URL.Path`). Signing the decoded path on either
  side breaks verification for any URL containing encoded characters.
- `org_id` = the verbatim `X-Grafana-Org-Id` header value (or `""`), never
  a re-parsed/re-formatted int.
- Headers: `X-Agent-Signature`, `X-Agent-Timestamp`, `X-Agent-Nonce`.
- Shared secret: `AGENT_INTERNAL_SECRET`, identical on both sides. Empty on
  either side = dev-mode pass-through (no signing/no verification) — this
  must **not** be the case in production (see secret validation below).
- Protected prefixes on the Python side: `/api/sessions`, `/api/mcp`,
  `/api/identity`, `/api/rca`. If you add a new Go proxy route to the Orca
  backend, add its `/api/...` prefix to `_PROTECTED_PREFIXES` in
  `internal_auth.py`, or it is reachable unauthenticated.

If you change the message format, canonicalization, or header names on one
side, update the other side and both test suites in the same change:
`pkg/plugin/internal_signer_test.go` / `session_proxy_test.go` /
`rca_proxy_test.go` and `tests/unit/auth/test_internal_auth.py`.

### 2. Alembic is the only schema authority — never add `create_all`

`services/orca/backend/docker-entrypoint.sh` runs `alembic upgrade head`
before the app process starts. `app/main.py` never creates or alters
schema at runtime — it only calls `app/schema_check.py` to verify the DB
is at the Alembic head, failing hard when `ENVIRONMENT=production` and only
warning otherwise. New tables/columns **must** go through a new file in
`harness/migrations/versions/`, not through a new SQLAlchemy model that
relies on `Base.metadata.create_all`. Adding a model without a matching
migration reproduces the exact bug tracked as F3/F13 in
`docs/harness-risk-review.md` (table exists in tests via Testcontainers,
never exists in production).

### 3. `GuardPipeline.run` returns a 3-tuple — callers must use `effective_input`

`harness/guards/pipeline.py: GuardPipeline.run(...)` returns
`(verdict, effective_input, decisions)`, not just a verdict. Callers
**must** execute the tool with `effective_input`, not the original input —
a `Transform` verdict (e.g. `CostGuard` clamping a time range) is silently
discarded otherwise. The only supported way to dispatch a live tool call is
through `harness.tools.bridge.GuardedToolExecutor` — do not call
`tool.run()` directly from a graph node or a new endpoint; that bypasses
every guard (RBAC, PII, cost, budget, timeout, write-approval, loop) the
same way the pre-hardening code did (see F1 in the risk review, now fixed
by routing `app/agent/rca_graph.py` through the bridge).

### 4. Production secret validation gate

`app/config.py: Settings.validate_production_secrets()` is called from
`app/main.py`'s lifespan and raises `RuntimeError` (refuses to start) when
`ENVIRONMENT=production` and any of `OBO_ENCRYPTION_KEY`,
`MCP_ENCRYPTION_KEY`, or `AGENT_INTERNAL_SECRET` is empty/a known dev
default. If you add a new secret-backed feature, add its check here rather
than relying on a silent dev-mode fallback — the Go side has no equivalent
hard gate (`pkg/plugin/app.go: NewApp` only logs a warning when
`AGENT_INTERNAL_SECRET` is unset), so the Python-side gate is the only
thing that can stop an insecure production boot.

## Test commands

```bash
# Frontend (root)
npm run test:ci
npm run typecheck
npm run lint

# Go plugin backend (root)
go test ./pkg/...

# Python backend (from services/orca/backend/)
pytest tests/unit/ tests/llm/ tests/security/ tests/characterization/ \
  --cov=harness --cov-fail-under=85 -q

# Everything an agent-harness change should run before a PR
npm run test:ci && go test ./pkg/... && \
  (cd services/orca/backend && pytest tests/ -q)

# E2E (requires `npm run server` running first)
npm run e2e
```

See `docs/HARNESS_PLAN.md` ("Running the Stack" / "Running tests") for the
full container rebuild sequence after Go/Python/frontend changes, and
`docs/harness-risk-review.md` for the security history and current resolution
status behind the rules above. Its original findings are retained as a
historical record; use its status table and the source, not a historical
finding section, to determine current behavior.
