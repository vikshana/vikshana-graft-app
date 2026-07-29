# AGENTS.md — Harness (`services/orca/backend/harness/`)

The harness is the guard/tool/session/auth layer shared by the interactive
RCA graph, Slack, and auto-triage. See `services/orca/backend/AGENTS.md`
for how it fits into the FastAPI app, and root `AGENTS.md` for the
Go↔Python HMAC contract, Alembic-only schema rule, and the
`GuardPipeline` 3-tuple contract. This file describes the packages'
contracts and — deliberately — where they stop short of what their own
docstrings sometimes describe. Verify against source before repeating a
claim from an older doc (`docs/HARNESS_PLAN.md` phase summaries describe
intent at merge time, not necessarily current behavior).

## Package map

```
guards/       pipeline.py (GuardPipeline), types.py (Allow/Deny/
              ApprovalRequired/Transform), guards.py (RBAC, Cost, Budget,
              Timeout, Write, Loop), pii.py (PIIRedactionGuard)
tools/        protocol.py (Tool/ToolContext/ToolResult/CostClass),
              registry.py (ToolRegistry), bridge.py (GuardedToolExecutor —
              the only supported live dispatch chokepoint), naming.py
              (LLM-safe wire aliases for long/collision-prone tool names),
              error_classification.py, langchain_adapter.py, grafana/
              (native tool implementations)
mcp/          client_manager.py (MCPClientManager — per-org MCP server
              lifecycle), crypto.py (Fernet token encrypt/decrypt),
              models.py (MCPServerConfig/MCPToolOverride/DiscoveredTool —
              plain dataclasses, not ORM — persisted via raw SQL against
              tables created by harness/migrations/versions/0004),
              registry_bridge.py (OrgToolRegistry), tool_adapter.py
session/      registry.py (GraphRegistry), worker.py (TurnWorker,
              enqueue_turn), models.py (ORM: Turn, ToolCallRecord,
              Approval, SpendLedger, TurnJob, DrillDownResult,
              HarnessUser, Identity)
auth/         types.py (AuthMode, GrafanaCredential), chain.py (priority
              resolver), entra_obo.py, session_passthrough.py,
              service_account.py, internal_auth.py (Go↔Python HMAC —
              see root AGENTS.md §1), linkage.py (PKCE identity linking)
slack/        app.py, handlers.py (/obs commands + approve/reject button
              actions), block_kit.py, notifier.py, idempotency.py
triage/       auto_triage.py (AutoTriageService), circuit_breaker.py,
              dedup_adapter.py
compaction/   compactor.py — context window compaction
observability/ otel.py (@trace_span, GenAI metrics), langfuse.py
search/       embeddings.py (embed_text — pgvector query embedding)
skills/       loader.py — YAML-frontmatter skill files
migrations/   Alembic — see root AGENTS.md §2; 5 revisions as of 61534e4
```

## Guard pipeline contract

`GuardPipeline.run(tool, input, ctx)` returns
`(verdict, effective_input, decisions)` — see root `AGENTS.md` §3. The
default pipeline (`guards.make_default_pipeline()`) runs, in order: RBAC →
PII redaction → Cost → Budget → Timeout → Write → Loop. First non-`Allow`
short-circuits; a `Transform` (e.g. `CostGuard` clamping a time range)
updates `effective_input` and continues.

- `PIIRedactionGuard` is **default-off** (`HARNESS_PII_REDACTION_ENABLED`);
  only applies to `QUERY`/`WRITE` tools; never mutates the `expr`/`query`
  fields themselves (mutating live PromQL/LogQL would silently change what
  executes) — it only redacts other fields and logs a warning for
  PII-looking content inside query strings.
- `RBACGuard` allows `AuthMode.SERVICE_ACCOUNT` credentials through
  unconditionally (RBAC for those is enforced at the Go gateway, not
  per-tool-call) — the automated investigation graph
  (`app/agent/rca_graph.py`) always builds a service-account credential
  today (no per-request Grafana OBO/session credential is wired into it
  yet), so `RBACGuard` is a no-op on the current live path.
- `start_turn()`/`start_session()` must be called explicitly (once per
  node invocation / once per investigation, respectively) or
  `TimeoutGuard`'s ceilings stay permanently un-armed — `rca_graph.py`'s
  `_build_turn_executor` threads `investigation_started_at` through
  `RCAState` across interrupt/resume rounds so the session ceiling reflects
  the true start, not each round's build time.

## The only supported live dispatch path: `GuardedToolExecutor`

`harness/tools/bridge.py: GuardedToolExecutor.execute()` is the sole
chokepoint every LLM-initiated tool call goes through in
`app/agent/rca_graph.py`. Never call `tool.run()` directly from a graph
node or a new endpoint. The executor:
- Resolves an LLM-safe wire alias back to the real registry tool name
  (`harness.tools.naming`) — real names like `mcp:{org_id}:{server}:{tool}`
  can exceed function-calling name-length/charset limits.
- Raises `ToolNotRegisteredError` for any name not visible in the
  caller-supplied registry — never falls back to executing arbitrary code.
- Runs `tool.run()` under `asyncio.wait_for(ctx.tool_timeout_s)` and
  classifies any exception via `error_classification.classify_exception`
  instead of assuming `retryable=True`.

## Approval is not implemented end to end — do not assume it works

Several docstrings in this package (`guards.py: WriteGuard`,
`tools/grafana/write_tools.py`) describe an approval flow — "Approval
request created in the `approvals` table", "only the session initiator
may approve via `POST /sessions/{id}/approve`". As of commit `61534e4`,
**none of that is wired up**:

- `WriteGuard.evaluate()` only *returns* an in-memory `ApprovalRequired`
  dataclass; it never writes an `Approval` row. The `Approval` ORM model
  (`harness/session/models.py`) and `approvals` table exist (migration
  `0002`), but nothing in live code ever inserts into it — the model is
  referenced only from one test.
- `GuardedToolExecutor.execute()` has no consumer for `ApprovalRequired`
  beyond returning a "this execution context does not support approval;
  the call was not executed" string to the LLM. A write-class tool call
  can never actually run through this path, approved or not.
- `POST /sessions/{id}/approve` — referenced in the docstrings above and
  called by the frontend's `approveAction()` (`src/services/sessionApi.ts`)
  — **does not exist** in `app/api/sessions.py` (only `list`, `search`,
  `drill-down`, `feedback` are implemented there).
- The only two native `CostClass.WRITE` tools in the codebase
  (`CreateSilenceTool`, `CreateAnnotationTool` in
  `harness/tools/grafana/write_tools.py`) are registered by
  `harness.tools.grafana.register_all_grafana_tools()` — which is called
  only from tests, never from `app/main.py` or `rca_graph.py`. So even
  setting the approval flow aside, no native write tool is reachable by
  the LLM on the live path today.

If a task asks you to "wire up approvals", treat it as new functionality
(guard → DB row → API endpoint → frontend polling/SSE), not a bug fix in
existing plumbing.

## MCP tools require `org_id` — there is no org-less MCP path

`harness.mcp.registry_bridge.OrgToolRegistry(org_id, ...)` filters the
global `tool_registry` to native tools (`_org_id` tag is `None`, always
visible) plus MCP tools tagged with a matching `_org_id`. In
`app/agent/rca_graph.py: _build_turn_tool_registry`, user-configured MCP
tools are only merged in `if org_id is not None:` — an investigation with
no resolved `org_id` (e.g. triggered without a Grafana org context) sees
built-in Grafana MCP tools only, never any user-added MCP server's tools.
`DiscoveredTool.qualified_name` is `mcp:{org_id}:{server_name}:{tool_name}`
— the org ID is embedded in the registry key itself (not just an
attribute) specifically so two orgs naming a server the same thing never
collide in the process-global `ToolRegistry` singleton.

`MCPClientManager` keeps per-replica in-memory state; Postgres
(`mcp_server_configs`/`mcp_tool_overrides`, both plain dataclasses in
`harness/mcp/models.py`, persisted via raw SQL against tables owned by
Alembic migration `0004`, not SQLAlchemy ORM models) is the runtime source
of truth. `reconcile()` — invoked by a bounded periodic background loop in
`app/main.py` (`MCP_RECONCILE_INTERVAL_S`) and by on-access TTL check in
`app/api/mcp_servers.py` (`MCP_RECONCILE_TTL_S`) — converges a replica
that didn't itself serve the mutating request.

`harness/mcp/crypto.py: decrypt_token` is fail-closed: if
`MCP_ENCRYPTION_KEY` is configured but a stored token fails to decrypt
(rotated key, corrupt value), it raises `TokenDecryptionError`. Callers
must treat that as "no usable token" and refuse to connect — never send
the still-encrypted value as a bearer token.

## Session queue contract

`harness.session.worker.enqueue_turn(session_id, session_type, ...)`
inserts a `pending` row in `turn_jobs` and reports whether the session is
currently `busy` (another job already `claimed` for that `session_id`).
`TurnWorker` (any replica) claims and executes jobs — see
`services/orca/backend/AGENTS.md` for the non-blocking, transaction-scoped
advisory-lock + heartbeat protocol. `enqueue_turn` is called today only
from `harness.triage.auto_triage.AutoTriageService.handle_alert` and from
Slack slash-command/button handlers in `harness.slack.handlers` — **no
HTTP route calls it**. The Sessions UI's `postTurn`/`streamSession` calls
target routes that don't exist yet in `app/api/sessions.py` (see
`services/orca/backend/AGENTS.md`); don't assume the browser can drive a
turn end-to-end without adding that route.

`GraphRegistry.aget(session_type)` (not the sync `get()`) is required for
async graph factories — see `services/orca/backend/AGENTS.md`.

## Test layout

Unit tests live under `tests/unit/<subpackage>/` mirroring this package
(`auth/`, `compaction/`, `guards/`, `mcp_client/`, `session/`, `skills/`,
`slack/`, `tools/`, `triage/`). `tests/security/test_injection_redteam.py`
red-teams the `ToolResultEnvelope` injection framing (≥25 cases).
`--cov=harness --cov-fail-under=85` is the coverage gate (see root
`AGENTS.md` test commands); `harness/mcp/client_manager.py` and the vendor
LLM adapters are excluded from the gate (network-transport code,
integration-tested against live servers instead).
