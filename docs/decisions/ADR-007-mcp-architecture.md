# ADR-007 — MCP Server Architecture

**Status**: Accepted
**Date**: 2026-07-04
**Phase**: 4

## Context

The harness needs to support user-configurable MCP (Model Context Protocol) servers so that each Grafana organisation can connect their own tools (GitHub, Kubernetes, etc.) without modifying the plugin code.

## Decision

### 1. JSON-RPC 2.0 over HTTP — no SSE client for tool invocation

MCP SSE servers expose standard HTTP endpoints (`/tools/list`, `/tools/call`) alongside the SSE stream.  We use `httpx.AsyncClient` to call these directly — no SSE client library needed for discovery or invocation.  This keeps the implementation simple and avoids a persistent connection per server.

### 2. Namespace prefix `mcp:{server_name}:{tool_name}`

All MCP tools are registered in `ToolRegistry` with a qualified name.  This avoids collisions with native Grafana tools (`query_metrics`, `list_dashboards`, etc.) and allows the name alone to communicate origin.

### 3. Per-org scoping via `OrgToolRegistry` (Decorator pattern)

The global `ToolRegistry` is a plain dict singleton.  `OrgToolRegistry` wraps it as a read-only org-scoped view: native tools (no `_org_id` tag) are always visible to every org; MCP tools carry an `_org_id` tag and are visible only to their owner org.  Zero data duplication — the filter is a predicate on the existing collection.

### 4. Token encryption via Fernet

Bearer tokens are encrypted with `cryptography.fernet` before storage in `mcp_server_configs.token_encrypted`.  When `MCP_ENCRYPTION_KEY` is empty (dev), tokens are stored as plain text.

### 5. `MCPClientManager` singleton

One manager per process.  On startup it loads all `enabled=true` server configs from DB and connects.  Connect/disconnect is available at runtime without restart.  All in-memory mutations are protected by `asyncio.Lock`.

### 6. User-configurable — "bring your own MCP"

The frontend exposes a `/mcp` page where users add any SSE-compatible MCP server by URL.  The backend stores the config, attempts to connect, and makes discovered tools immediately available to that org's sessions.

## Alternatives considered

- **Per-request MCP client**: rejected — connection and tool-discovery overhead is too high per tool call
- **Store tool schemas in DB**: rejected — schemas can change server-side; discovery at connect time is always correct
- **SSE client for tool calls**: rejected — the HTTP endpoints are simpler and sufficient

## Consequences

- Users can add any SSE-compatible MCP server via the Grafana plugin UI
- Tool toggles take effect immediately (no restart required)
- `ToolRegistry._tools` is mutated directly for deregistration (acceptable given `asyncio.Lock` serialisation)
- GitHub and Kubernetes MCP servers are supported out-of-the-box via user-provided URLs and tokens
