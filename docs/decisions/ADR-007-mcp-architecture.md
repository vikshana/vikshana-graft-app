# ADR-007 — MCP Server Architecture

**Status**: Accepted (amended `61534e4`, 2026-07-28 — see Amendment below)
**Date**: 2026-07-04
**Phase**: 4

## Context

The harness needs to support user-configurable MCP (Model Context Protocol) servers so that each Grafana organisation can connect their own tools (GitHub, Kubernetes, etc.) without modifying the plugin code.

## Decision

### 1. JSON-RPC 2.0 over HTTP — no SSE client for tool invocation

MCP SSE servers expose standard HTTP endpoints (`/tools/list`, `/tools/call`) alongside the SSE stream.  We use `httpx.AsyncClient` to call these directly — no SSE client library needed for discovery or invocation.  This keeps the implementation simple and avoids a persistent connection per server.

### 2. Namespace prefix `mcp:{server_name}:{tool_name}`

All MCP tools are registered in `ToolRegistry` with a qualified name.  This avoids collisions with native Grafana tools (`query_metrics`, `list_dashboards`, etc.) and allows the name alone to communicate origin.

> **Amended `61534e4`:** the qualified name now also includes the owning
> org ID — see the Amendment section below. Point 2 as originally written
> undercounted a collision: two different orgs naming a server the same
> thing collided on this key.

### 3. Per-org scoping via `OrgToolRegistry` (Decorator pattern)

The global `ToolRegistry` is a plain dict singleton.  `OrgToolRegistry` wraps it as a read-only org-scoped view: native tools (no `_org_id` tag) are always visible to every org; MCP tools carry an `_org_id` tag and are visible only to their owner org.  Zero data duplication — the filter is a predicate on the existing collection.

### 4. Token encryption via Fernet

Bearer tokens are encrypted with `cryptography.fernet` before storage in `mcp_server_configs.token_encrypted`.  When `MCP_ENCRYPTION_KEY` is empty (dev), tokens are stored as plain text.

> **Amended `61534e4`:** decrypt failures now fail closed — see the
> Amendment section below.

### 5. `MCPClientManager` singleton

One manager per process.  On startup it loads all `enabled=true` server configs from DB and connects.  Connect/disconnect is available at runtime without restart.  All in-memory mutations are protected by `asyncio.Lock`.

> **Amended `61534e4`:** "one manager per process" is unchanged, but with
> more than one replica each process's manager is an independent, in-memory
> view — see the multi-replica convergence note in the Amendment section.

### 6. User-configurable — "bring your own MCP"

The frontend exposes a `/mcp` page where users add any SSE-compatible MCP server by URL.  The backend stores the config, attempts to connect, and makes discovered tools immediately available to that org's sessions.

> **Amended `61534e4`:** the current frontend surface is a Grafana plugin
> **config-page tab** ("MCP Servers", `src/module.tsx`'s
> `addConfigPage({ id: 'mcp', ... })`, backed by
> `src/components/features/AppConfig/MCPConfig.tsx`) reached via
> Administration → Plugins and data → Plugins → Graft AI Assistant, in
> addition to the in-app route at `/a/vikshana-graft-app/mcp`
> (`src/pages/MCPServers.tsx`). "Makes discovered tools immediately
> available" also needs the multi-replica caveat below — immediate on the
> replica that served the request; bounded, not immediate, on others.

## Alternatives considered

- **Per-request MCP client**: rejected — connection and tool-discovery overhead is too high per tool call
- **Store tool schemas in DB**: rejected — schemas can change server-side; discovery at connect time is always correct
- **SSE client for tool calls**: rejected — the HTTP endpoints are simpler and sufficient

## Consequences

- Users can add any SSE-compatible MCP server via the Grafana plugin UI
- Tool toggles take effect immediately (no restart required) **on the
  replica that handled the toggle request** — see the multi-replica
  convergence note below for other replicas
- `ToolRegistry._tools` is mutated directly for deregistration (acceptable given `asyncio.Lock` serialisation)
- GitHub and Kubernetes MCP servers are supported out-of-the-box via user-provided URLs and tokens

---

## Amendment (`61534e4`)

Three gaps identified in `docs/harness-risk-review.md` (F9, F10, F12) were
fixed against this design without changing its fundamentals (still an
in-memory `MCPClientManager` singleton per process, still Postgres as the
config source of truth, still Fernet encryption):

### Org-qualified registry keys vs. LLM-facing wire aliases

The registry key (point 2 above) is now `mcp:{org_id}:{server_name}:{tool_name}`
(`harness/mcp/models.py: DiscoveredTool.qualified_name`) — not just
`mcp:{server_name}:{tool_name}`. Two different orgs naming a server
identically (e.g. both calling it `"github"`) no longer collide in the
shared, process-global `ToolRegistry` dict, and disconnecting one org's
server can no longer deregister another org's live tool.

This registry key is a separate concern from what the LLM sees on the
wire: MCP-qualified names use `:` and can exceed the ~64-character limit
most LLM function-calling APIs impose on tool names. `harness/tools/naming.py`
computes a short, collision-safe **wire alias** per turn
(`build_wire_aliases`) that `harness/tools/bridge.GuardedToolExecutor` and
`bind_tools_from_registry` use to present tools to the LLM and resolve an
LLM-issued call back to the real, org-scoped registry name before dispatch.
The alias never weakens org isolation — it is derived from, and resolution
still goes through, the already org-scoped registry.

### Bounded multi-replica convergence, not immediate/synchronous sync

`MCPClientManager` state remains per-replica, in-memory, with Postgres as
the runtime source of truth — this was **not** changed to a shared or
synchronous model, and there is no LISTEN/NOTIFY or other push mechanism.
What was added is `reconcile()`, a full diff-and-converge pass against the
DB, invoked two ways:

- A bounded periodic background loop (`MCP_RECONCILE_INTERVAL_S`, default
  30s, started from `app/main.py`'s lifespan).
- An on-access, TTL-gated call (`ensure_fresh()`, `MCP_RECONCILE_TTL_S`,
  default 10s) from every `/api/mcp/*` read/write path
  (`app/api/mcp_servers.py`), so a request landing on a replica shortly
  after another replica's add/toggle/reconnect/delete still observes the
  change without waiting for the next periodic tick.

This **bounds** staleness to roughly `min(MCP_RECONCILE_INTERVAL_S, time
since last access)` per replica. It does not make an add/toggle/reconnect/
delete visible on every replica instantaneously.

### Token decryption fails closed

`decrypt_token` (`harness/mcp/crypto.py`) now raises `TokenDecryptionError`
instead of silently returning ciphertext when a key is configured but
decryption fails (malformed ciphertext, or a rotated key). `connect()` and
`set_tool_enabled()` propagate this and refuse to register/enable the
affected tool rather than sending ciphertext as a bearer token; the API
surfaces it as an HTTP 422 on `toggle_mcp_tool`.

See `ARCHITECTURE.md` § Org Scoping & MCP Tool Registry Replication and
`docs/harness-risk-review.md` (F9, F10, F12) for further detail.
