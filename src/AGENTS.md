# AGENTS.md — Frontend (`src/`)

Grafana app plugin frontend (React 18 + TypeScript, `react-router-dom`
routes rendered inside the Grafana app-plugin shell). See root `AGENTS.md`
for the end-to-end request path and the Go↔Python HMAC contract this
layer's backend calls ride on top of.

## Two unrelated backend-call patterns — know which one you're in

1. **Chat (`/` route, `ChatInterface`) calls `@grafana/llm` directly.**
   `src/services/llm.ts` (`llmService.chat`) uses the `llm` export from
   `@grafana/llm` — Grafana's own LLM app plugin — for completions, and
   (separately) `mcp.useMCPClient()` from `@grafana/llm` for MCP
   tool-calling in chat. **This never goes through `pkg/plugin/` or the
   Orca backend at all.** `pkg/plugin/app.go: handleTools` is a *separate*
   helper that proxies a `tools/list` call to the same grafana-llm-app MCP
   server for the config page (which has no React MCP context) — still
   not the Orca harness.
2. **RCA / Sessions / MCP-server-management pages call the Go plugin
   resource routes**, which reverse-proxy to the Orca FastAPI backend:
   - `src/services/rcaApi.ts` → `/api/plugins/vikshana-graft-app/resources/rca/api/...`
   - `src/services/sessionApi.ts` → `/api/plugins/vikshana-graft-app/resources/sessions/...`
   - MCP server management (`src/pages/MCPServers.tsx`,
     `src/components/features/MCPServers/`) →
     `/api/plugins/vikshana-graft-app/resources/mcp/...`

   All three use `getBackendSrv().fetch(...)` for JSON calls (which
   injects Grafana's own auth) — **except** SSE-streaming calls
   (`rcaApi.ts`'s `/start`/`/refine`, `sessionApi.ts`'s `streamSession`),
   which use raw `fetch()` + `ReadableStream` because
   `getBackendSrv().fetch()` buffers the full response before resolving
   and cannot be used for a live stream. **None of these SSE calls
   currently reach a working backend route** — see the gap section below.

Do not conflate these two "MCP" concepts: `@grafana/llm`'s
`mcp.useMCPClient()` (chat tool-calling, talks to grafana-llm-app's own
MCP server) and the harness's user-configured MCP servers (`/mcp` page,
`harness.mcp` package, `pkg/plugin/session_proxy.go: registerMCPRoutes`,
used only by the RCA/session investigation graph) are unrelated systems
that happen to share an acronym.

## Routes (`src/components/features/App/App.tsx`)

| Path | Component | Backend calls |
|---|---|---|
| `/` (default + `*` fallback) | `ChatInterface` | `@grafana/llm` only |
| `/history` | `ChatHistory` | local storage (`chatHistory.ts`) |
| `/prompts` | `PromptLibrary` | local/plugin config (`promptLibrary.ts`) |
| `/rca`, `/rca/runs`, `/rca/investigate/:threadId` | `RCADashboard`/`RCAList`/`RCAInvestigate` | `rcaApi.ts` → Go `/rca/` proxy; `RCAInvestigate`'s start/refine/accept calls 404 — see gap section below |
| `/sessions`, `/sessions/:sessionId` | `SessionList`/`SessionPanel` | `sessionApi.ts` → Go `/sessions/` proxy; `SessionPanel`'s turn/stream calls 404 — see gap section below |
| `/mcp` | `MCPServers` | Go `/mcp/` proxy (also reachable from the plugin config tab — see `AppConfig/MCPConfig.tsx`) |

Every route component is lazy-loaded (`React.lazy`); `plugin.json`'s
`extensions.addedComponents`/nav links must stay in sync with anything you
add or rename here.

## Known gap: both interactive investigation UIs call routes the backend doesn't implement

`src/pages/SessionPanel.tsx` calls `postTurn()` (→
`POST .../sessions/{id}/turns`) and `streamSession()` (→
`GET .../sessions/{id}/stream`) from `sessionApi.ts`. As of commit
`61534e4`, `services/orca/backend/app/api/sessions.py` implements only
`list`, `search`, `drill-down`, and `feedback` — **not** `turns`,
`approve`, or `stream`. See `services/orca/backend/harness/AGENTS.md` for
what actually enqueues a turn today (Slack + auto-triage only). Don't
assume the Sessions UI is fully functional end-to-end just because the
frontend code compiles and has tests — the tests mock `sessionApi`.

The legacy `src/pages/RCAInvestigate.tsx` flow (`/rca/investigate/:threadId`)
has the identical problem, for the identical reason: `rcaApi.ts`'s
`startRCAStream`, `refineRCAStream`, `acceptRCA`, `getHistory`, and
`searchRCAs` target `/api/rca/start`, `/api/rca/{id}/refine`,
`/api/rca/{id}/accept`, `/api/rca/{id}/history`, and `/api/rca/search` —
none of which exist; `app/api/rca_sessions.py` (which implemented all
five) was deleted in the same Phase 4 hardening pass and never replaced.
`app/api/rca.py` today only serves `GET /api/rca`, `GET /api/rca/{id}`,
`PATCH /api/rca/{id}/feedback`, `GET /api/stats`, `GET /api/filters/values`
— confirmed by enumerating `app.routes` at runtime, not just reading
source. Only `RCADashboard` and `RCAList` (and feedback on an already-
completed RCA) work against the current backend; starting or refining an
investigation from the browser 404s. See
`services/orca/backend/AGENTS.md` for the full route inventory.

## Conventions

- Types live in `src/types/*.types.ts`, one file per domain
  (`chat.types.ts`, `session.types.ts`, `rca.types.ts`, `settings.types.ts`,
  ...) — import from there, not from a component.
- `src/services/*Api.ts` files are the only place that should construct
  the `/api/plugins/vikshana-graft-app/resources/...` base URL for their
  domain; don't hardcode plugin resource paths in components.
- Feature components live under `src/components/features/<Feature>/`;
  shared/presentational components under `src/components/common/`.
- Tests are colocated (`Foo.tsx` + `Foo.test.tsx`); see root `AGENTS.md`
  for the `npm run test:ci` / `typecheck` / `lint` commands.
