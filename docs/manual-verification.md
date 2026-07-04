# Manual Verification Guide — Observability Agent Harness (Phases 2–4)

This document covers all user-facing changes introduced in the harness phases. Use it to manually confirm correct behaviour before merging `feat/orca-rca-integration` → `main`.

---

## Prerequisites

Before starting, confirm the full stack is running:

```bash
# Start minimum required containers
docker compose up --no-deps loki tempo mimir otel-collector \
  orca-postgres mcp-grafana mcp-postgres orca-backend grafana -d

# Confirm health
curl -s http://localhost:3000/api/health          # → {"database":"ok","version":"..."}
curl -s http://localhost:8001/health              # → {"status":"ok"}
```

Navigate to **http://localhost:3000** and confirm Grafana loads without a login prompt (anonymous Admin auth is enabled in the dev stack).

> **Note**: Some scenarios require orca-backend to be running and reachable through the Go plugin proxy. If a page shows "Failed to load" errors, confirm `docker compose ps orca-backend` shows `healthy`.

---

## 1. Plugin Configuration Tabs

**Path**: Administration → Plugins and data → Plugins → **Graft AI Assistant**

**URL**: `http://localhost:3000/plugins/vikshana-graft-app`

### 1.1 Three tabs present

| Tab | Expected content |
|---|---|
| **Configuration** | Prompt Library YAML upload/download + Save button |
| **Agent** | Tool category checkboxes (OSS/Cloud), max iterations input |
| **MCP Servers** | MCP Servers heading, Add Server button, table with NAME/URL/STATUS/TOOLS/ACTIONS columns |

Verify:
- [ ] All three tabs are visible and clickable
- [ ] Switching tabs does not reload the page (client-side navigation)
- [ ] The Configuration and Agent tabs still function as before (no regression)

### 1.2 MCP Servers tab

**URL**: `http://localhost:3000/plugins/vikshana-graft-app?page=mcp`

- [ ] Table is visible with five column headers: NAME, URL, STATUS, TOOLS, ACTIONS
- [ ] **Add Server** button is present in the top-right of the tab
- [ ] Clicking **Add Server** opens a modal with fields:
  - Name (required, placeholder: "e.g. GitHub MCP")
  - SSE Endpoint URL (required, placeholder: "https://api.example.com/mcp/sse")
  - Transport dropdown (SSE selected by default)
  - Bearer Token (password field, optional, hint: "Stored encrypted at rest.")
- [ ] Submitting with empty Name or URL shows validation error
- [ ] **Cancel** button dismisses the modal without saving
- [ ] If orca-backend is unreachable, the table area shows "Failed to load MCP servers" alert — this is expected in a partial stack

---

## 2. Sessions Page

**Path**: Graft AI Assistant → Sessions (sidebar nav)

**URL**: `http://localhost:3000/a/vikshana-graft-app/sessions`

### 2.1 Header

- [ ] **Back** button is present on the left — clicking it navigates to the chat interface (`/a/vikshana-graft-app`)
- [ ] **Sessions** title is horizontally centred — same height and layout as the Chat History and RCA History headers
- [ ] Header is sticky — scrolling the session list does not scroll the header out of view

### 2.2 Empty state (no sessions in DB)

If no RCA investigations have been run, the page shows:

- [ ] "No sessions yet." message
- [ ] "Start an investigation from the RCA page to create your first session." message
- [ ] **Go to RCA** button — clicking it navigates to `/a/vikshana-graft-app/rca`

### 2.3 Session list (sessions exist)

After running at least one RCA investigation:

- [ ] Table rows appear with columns: ID (truncated), Type, Status, Alert, Service, Auth, Created
- [ ] ID column uses monospace font
- [ ] Status column shows a coloured badge (blue = active, green = completed, red = failed, orange = paused/awaiting_approval)
- [ ] Auth column shows "team creds" for `service_account` mode
- [ ] Created column shows a human-readable timestamp
- [ ] Clicking a row navigates to `/a/vikshana-graft-app/sessions/:id` (SessionPanel)
- [ ] Row hover shows a subtle highlight

### 2.4 Sessions from different sources

Both old RCA investigations and new harness sessions appear in the list:

| Source | `type` column | `status` column |
|---|---|---|
| Old `rca_graph.py` interactive RCA | `investigation` or blank | blank or `completed` |
| New harness session worker | `investigation` | `active`, `completed`, etc. |

- [ ] Rows from old RCA investigations appear (if any exist) — they may have blank type/status
- [ ] Rows do NOT include chat conversations from the chat interface (those are localStorage-only)

---

## 3. SessionPanel

**URL**: `http://localhost:3000/a/vikshana-graft-app/sessions/:sessionId`

Navigate to a session by clicking a row on the Sessions page.

### 3.1 Header

- [ ] **Back** button navigates back to `/sessions`
- [ ] Session ID or title shown as the page heading

### 3.2 Live investigation (status: active)

For a session currently running:

- [ ] Tool call feed renders as steps arrive via SSE stream
- [ ] Each tool call shows tool name, input summary, and result (collapsible)
- [ ] Loading indicator visible while stream is open

### 3.3 Awaiting input (hypothesis state)

When the agent presents a hypothesis:

- [ ] Hypothesis text is displayed
- [ ] Suggested follow-up questions are listed
- [ ] A text input and **Send** button are available for follow-up questions
- [ ] Submitting a question resumes the stream

### 3.4 Approval gate (write-class tools)

When the agent requests a write operation:

- [ ] **Approval modal appears only for the session initiator** — log in as the initiator user to verify
- [ ] Non-initiator users do not see the approval modal (the `isInitiator` check uses `window.grafanaBootData.user.login` vs `session.initiator_user_id`)
- [ ] **Approve** and **Deny** buttons are present in the modal for the initiator
- [ ] Approving resumes the agent; denying cancels the tool call

### 3.5 Feedback widget

After a session reaches `completed` or `failed` status:

- [ ] Thumbs-up / thumbs-down buttons appear
- [ ] Clicking either submits feedback and shows a confirmation

### 3.6 Evidence panel / drill-down

If a tool call stored a drill-down handle:

- [ ] Clicking a drill-down link in the tool result opens the evidence panel
- [ ] The panel shows the original Grafana query parameters (datasource uid, expression, time range)

---

## 4. Chat Interface

**URL**: `http://localhost:3000/a/vikshana-graft-app`

The chat interface is **not** connected to the harness session system. Verify no regressions:

- [ ] Chat landing page loads with "Good Morning/Afternoon/Evening" greeting
- [ ] LLM Plugin Not Configured alert appears if LLM plugin is not set up
- [ ] When LLM plugin is configured: chat input is enabled, Standard and Deep Research mode buttons are active
- [ ] Sending a message produces an assistant reply
- [ ] Chat sessions are stored in the browser (visible on the Chat History page at `/history`)
- [ ] Chat sessions do **not** appear on the Sessions page (`/sessions`) — these are two separate systems
- [ ] Previous Conversations, Prompt Library, and Refine my prompt landing cards navigate correctly

---

## 5. Chat History Page

**URL**: `http://localhost:3000/a/vikshana-graft-app/history`

Confirm no regression from Sessions page changes:

- [ ] Back button present, centred title "Chat History"
- [ ] Header height matches Sessions page header height visually
- [ ] Session cards render, search works, delete works
- [ ] Clicking a session card resumes that conversation in the chat interface

---

## 6. RCA Pages

Confirm the legacy RCA flow is unaffected (no endpoints were removed from the proxy):

**URL**: `http://localhost:3000/a/vikshana-graft-app/rca`

- [ ] Root Cause Analysis page loads
- [ ] **Start Investigation** button is present (or equivalent — form to submit an alert)
- [ ] Submitting an investigation creates a row in `rca_sessions` that subsequently appears on the Sessions page
- [ ] RCA History page (`/rca/runs`) lists past investigations

---

## 7. Slack Integration (Phase 3 — requires Slack workspace)

> Skip if `SLACK_BOT_TOKEN`, `SLACK_APP_TOKEN`, and `SLACK_SIGNING_SECRET` are not configured.

### 7.1 Identity linkage

- [ ] Navigate to the identity link start endpoint: `GET /api/plugins/vikshana-graft-app/resources/identity/link/start`
- [ ] A redirect to the Grafana OAuth consent page is returned
- [ ] Completing the OAuth flow links the Slack user to the Grafana user
- [ ] `GET /api/plugins/vikshana-graft-app/resources/identity/link/status` returns `{"linked": true, "provider": "slack"}`

### 7.2 Slash command

- [ ] In a configured Slack workspace, type `/obs` in a channel
- [ ] A Block Kit message appears with the investigation options
- [ ] Approving or dismissing the action updates the Slack message

### 7.3 Alert triage notification

- [ ] When Alertmanager fires a webhook alert, the auto-triage service processes it
- [ ] A Slack notification is posted to the configured channel with alert details and a drill-down link

---

## 8. Backend Health Checks

Confirm the orca-backend is healthy and all routes are reachable through the Grafana proxy:

```bash
# Direct backend health
curl -s http://localhost:8001/health

# Through Grafana plugin proxy (requires Grafana running)
curl -s -H "X-Grafana-Org-Id: 1" \
  http://localhost:3000/api/plugins/vikshana-graft-app/resources/sessions \
  | python3 -m json.tool

# MCP servers list
curl -s -H "X-Grafana-Org-Id: 1" \
  http://localhost:3000/api/plugins/vikshana-graft-app/resources/mcp/servers \
  | python3 -m json.tool
```

Expected responses:

| Endpoint | Expected |
|---|---|
| `/health` | `{"status": "ok"}` |
| `/resources/sessions` | `{"sessions": [...], "total": N}` |
| `/resources/mcp/servers` | `{"servers": [...]}` |

---

## 9. Automated Test Coverage Reference

For each area above, the corresponding automated tests:

| Area | Test file(s) |
|---|---|
| Sessions API endpoints | `tests/integration/test_api_sessions.py` |
| MCP registry (org scoping) | `tests/unit/mcp/test_registry_bridge.py` |
| MCP tool adapter | `tests/unit/mcp/test_tool_adapter.py` |
| MCP token encryption | `tests/unit/mcp/test_crypto.py` |
| PII redaction guard | `tests/unit/guards/test_pii_guard.py` |
| Injection red-team | `tests/security/test_injection_redteam.py` |
| Guard pipeline (7 guards) | `tests/unit/guards/test_guards.py` |
| Session worker / queue | `tests/unit/session/test_session.py` |
| RCA graph node behaviour | `tests/characterization/test_characterization.py` |
| SessionList page | `src/pages/SessionList.test.tsx` |
| SessionPanel page | `src/pages/SessionPanel.test.tsx` |

Run the full suite:

```bash
# Python (from services/orca/backend/)
pytest tests/unit/ tests/llm/ tests/security/ tests/characterization/ \
  --cov=harness --cov-fail-under=85 -q

# Go
go test ./pkg/...

# Frontend
npm run test:ci
```

---

## Known Limitations

| Limitation | Impact | Phase to address |
|---|---|---|
| Chat interface sessions not persisted to DB | Chat conversations are browser-only; no server-side history or multi-device sync | Future |
| MCP server tools not available to chat interface | Tools from user-configured MCP servers are available to harness sessions but not to the chat LLM | Future |
| Sessions page only shows `rca_sessions` rows | Rows from old RCA investigations may show blank type/status columns | Cosmetic only |
| Characterization tests test old RCA nodes only | No characterization tests for the new harness session worker yet | Future |
