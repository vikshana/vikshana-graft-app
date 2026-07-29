# AGENTS.md — Grafana Plugin Backend (`pkg/plugin/`)

Go plugin backend for the Grafana app plugin. Registers HTTP resource
routes served under `/api/plugins/vikshana-graft-app/resources/...` and
reverse-proxies the agent/RCA surface to the Orca FastAPI backend. See
root `AGENTS.md` §1 for the Go↔Python HMAC contract this package is one
half of.

## Files

```
app.go               NewApp() — route registration, org-ID/role context
                      injection via CallResource; /settings, /tools, /ping,
                      /rca/ proxy (registerRoutes)
session_proxy.go      registerSessionRoutes() → /sessions/ ; registerMCPRoutes()
                      → /mcp/ — both with RBAC + HMAC signing + SSE passthrough
internal_signer.go    signInternalRequest() — HMAC signer, see root AGENTS.md §1
otel.go               Custom TracerProvider/MeterProvider global store
```

## Routes

| Route | RBAC middleware | HMAC signed | Backend target | Notes |
|---|---|---|---|---|
| `/settings` | no | n/a | — | Returns plugin JSONData |
| `/tools` | no | n/a | grafana-llm-app MCP (`tools/list`) | Forwards caller's cookie/Authorization; not the Orca backend |
| `/ping` | no | n/a | — | `{"message":"ok"}` |
| `/rca/*` → `/api/rca/*` | **no** | yes | orca-backend | `registerRoutes`; only route without `rbacMiddleware` |
| `/sessions/*` → `/api/sessions/*` | yes | yes | orca-backend | `registerSessionRoutes`; SSE passthrough |
| `/mcp/*` → `/api/mcp/*` | yes | yes | orca-backend | `registerMCPRoutes` |

`/api/identity/*` on the Python side (`InternalAuthMiddleware`'s
`_PROTECTED_PREFIXES`) has **no corresponding Go proxy route** — nothing
in `pkg/plugin/*.go` forwards to it. If you need the browser to reach
identity-linkage endpoints, you must add a Go route for it first (mirror
`registerMCPRoutes`) and add its prefix everywhere the HMAC contract cares
(see root `AGENTS.md` §1).

## Request-processing sequence for `/sessions/*` and `/mcp/*`

1. Grafana calls `CallResource` (`app.go`) with `PluginContext`. This
   threads `orgIDKey{}` (from `PluginContext.OrgID`, never client-supplied)
   and, for `/sessions/*`/`/mcp/*`, `orgRoleKey{}` (from
   `PluginContext.User.Role`) into the request context — this is the only
   place org/role enter the pipeline; nothing downstream trusts a header
   from the browser for either value.
2. `rbacMiddleware(allowedRoles, next)` (session_proxy.go) — reads
   `orgRoleKey{}`; 403s if empty or not in `agent_allowed_roles` (plugin
   JSONData) / the `{"Admin","Editor"}` default. `/rca/*` skips this step
   entirely — RBAC there relies solely on Grafana's own page-level access
   control, not this middleware.
3. Go `ServeMux` normalisation: both `/sessions` and `/sessions/` (and
   `/mcp` / `/mcp/`) are registered explicitly — without the bare-path
   handler, `ServeMux`'s automatic redirect from `/sessions` to
   `/sessions/` strips the Grafana plugin path prefix and 404s (a real bug
   hit during Phase 2; see `docs/HARNESS_PLAN.md`).
4. `httputil.ReverseProxy.Director`: sets `req.URL.Scheme/Host` to
   `RCA_BACKEND_URL` (default `http://orca-backend:8000`); rewrites the
   stripped path back to `/api/sessions...` / `/api/mcp...`; sets
   `X-Grafana-Org-Id` from `orgIDKey{}`; calls `signInternalRequest(req,
   secret)` **last**, after the URL/org-ID are final — the signature
   covers exactly what gets sent.
5. `FlushInterval: -1` on every proxy disables response buffering — needed
   for SSE passthrough. **Currently unexercised on the `/rca/*` route**:
   the backend endpoints this was built for (`POST /api/rca/start`,
   `POST /api/rca/{id}/refine`) were removed when `app/api/rca_sessions.py`
   was deleted in the harness Phase 4 hardening commit and never
   reimplemented — see `services/orca/backend/AGENTS.md`. `/sessions/*`'s
   `/stream` route (also planned, also not implemented) is in the same
   state. The proxy-side flush setting is correct and forward-compatible;
   it's the backend routes that are missing.

## RBAC config

`agent_allowed_roles` in plugin `AppInstanceSettings.JSONData`
(`sessionRBACConfig`), parsed once at `NewApp` time via
`parseAllowedRoles`. Falls back to `{"Admin","Editor"}`
(`defaultAllowedRoles`) if absent/unparseable. This is enforced only for
`/sessions/*` and `/mcp/*` — see the route table above.

## HMAC signing

`AGENT_INTERNAL_SECRET` env var, read once in `NewApp`/`registerRoutes`/
`registerSessionRoutes`/`registerMCPRoutes` via `getEnv`. Empty secret =
`signInternalRequest` is a no-op (dev-mode pass-through) and `NewApp` logs
a loud warning — the Go side has no hard startup failure for this (unlike
the Python side's `validate_production_secrets`; see root `AGENTS.md` §4).
See root `AGENTS.md` §1 for the exact message format both sides must agree
on, and `internal_signer.go`'s doc comment for why `req.URL.EscapedPath()`
(not `.Path`) is signed.

## Tests

`app_test.go`, `internal_signer_test.go`, `rca_proxy_test.go`,
`session_proxy_test.go` — cover RBAC allow/deny, HMAC header
presence/absence/correctness (including body/query/org-ID binding and
per-request nonce uniqueness), org-ID injection, SSE passthrough, 502 on
backend-unavailable, and path-stripping. Run with `go test ./pkg/...` from
repo root (see root `AGENTS.md` test commands). After any change here,
rebuild the plugin binary before it takes effect in the running stack:

```bash
rm ./dist/gpx_* && mage -v build:linuxARM64   # or `mage -v` on non-arm64
docker compose restart grafana
```
