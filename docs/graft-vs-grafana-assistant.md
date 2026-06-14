# Graft vs Grafana Assistant — Feature Comparison

Point-in-time comparison against Grafana Assistant as documented for Grafana Cloud / Grafana 13.0+ (June 2026).

---

## 1. Chat Interface

| Feature | Graft | Grafana Assistant |
|---|---|---|
| Multi-turn conversational chat | Yes | Yes |
| Streaming / progressive response rendering | Yes (via agent loop `onUpdate`) | Yes |
| Stop / abort generation | Yes | Yes |
| Copy message to clipboard | Yes | Yes |
| Delete individual messages | Yes | Not documented |
| Edit a sent user message | Yes (re-injects into input) | Not documented |
| Regenerate / retry last response | No | Not documented |
| Voice dictation input | Yes (Web Speech API) | No |
| File attachments (images, text, code) | Yes | No |
| Prompt refinement ("improve my prompt") | Yes (dedicated action) | No |
| Thinking block rendering (CoT visibility) | Yes (`<think>` tags, live timer) | No |
| Mermaid diagram rendering | Yes | No |
| Syntax-highlighted code blocks | Yes (full GFM + highlight) | Yes |
| Markdown rendering | Yes | Yes |
| URL-based session state (survives reload) | Yes | Not documented |
| Pre-fill prompt from router state | Yes | No |
| Personalized greeting | Yes (time-based, user name) | No |
| Multi-session side-by-side | No | No |
| Message branching / forking | No | No |

---

## 2. Model Selection

| Feature | Graft | Grafana Assistant |
|---|---|---|
| Multiple model tiers | Yes — Standard (BASE) and Deep Research (LARGE) | Yes — standard and more capable model |
| Per-session model toggle | Yes | Yes |
| Model config UI in the plugin | No (delegated to Grafana LLM plugin) | Managed by Grafana Cloud |
| Temperature / parameter controls | No | No |
| Custom / BYO model | No (via LLM plugin only) | No |
| Model availability-gating | Yes (disables unavailable tier) | Yes |

---

## 3. History & Sessions

| Feature | Graft | Grafana Assistant |
|---|---|---|
| Persistent conversation history | Yes (localStorage) | Yes (server-side) |
| Session resume by URL | Yes | Not documented |
| Session pinning | Yes (max 20) | No |
| Session delete | Yes | Not documented |
| Bulk delete with selection mode | Yes | No |
| Auto-generated session title | Yes (first message, 50 chars) | Not documented |
| Automatic cleanup policy (age + count) | Yes (50 sessions, 30 days; pins exempt) | N/A (server-managed) |
| History survives browser clear | No (localStorage only) | Yes (server-side) |
| Export / import history | No | No |
| Search within history | No | No |
| Session rename | No | Not documented |

---

## 4. Prompt Library

| Feature | Graft | Grafana Assistant |
|---|---|---|
| Pre-configured prompt catalogue | Yes (Category → Sub-category hierarchy) | No (Skills system instead — see §9) |
| Custom user prompts (CRUD) | Yes (localStorage) | No direct equivalent |
| Prompt pinning | Yes | No |
| Inject prompt directly into chat | Yes | Yes (via Skills) |
| Variables / templating in prompts | No | Yes (via Skills with parameters) |
| Prompt sharing across users | No | No (Skills are per-org) |
| Prompt versioning | No | No |
| Admin-configurable default prompts | Yes (via plugin `jsonData`) | Not documented |

---

## 5. Observability Context Injection

| Feature | Graft | Grafana Assistant |
|---|---|---|
| Current user info injected into system prompt | Yes (name, email, role, org) | Yes |
| Current dashboard context (title, JSON, variables) | Yes (full dashboard JSON) | Yes (panels, queries, variables) |
| Data source list injected | Yes (name, type, uid) | Yes (via infrastructure memory) |
| Panel query results / live data injected | No | Yes (queries data on demand) |
| Alert state context | No | Yes |
| Infrastructure memory (auto-built service map) | No | Yes (Grafana Cloud only) |
| User can inspect injected context | No | No |
| User can override/limit context | No | No (RBAC controls access) |

---

## 6. MCP / Tool Execution

| Feature | Graft | Grafana Assistant |
|---|---|---|
| MCP client integration | Yes (`mcp.MCPClientProvider`) | Yes |
| Tool discovery from MCP servers | Yes (`listTools` on mount) | Yes |
| Tool execution in agent loop | Yes (max 5 iterations) | Yes |
| Tool call status shown in UI | Yes (pending/success/error inline) | Not documented |
| Tool result content shown in UI | No (status only) | Not documented |
| Configure MCP servers in plugin | No (via Grafana LLM plugin) | Yes (Grafana Cloud MCP — Cloud only) |
| Grafana Cloud MCP (official server) | No | Yes (Cloud only) |
| Third-party MCP server support | Yes (via LLM plugin config) | Yes |

---

## 7. Root Cause Analysis (Automated Investigation)

| Feature | Graft | Grafana Assistant |
|---|---|---|
| Automated multi-step RCA pipeline | Yes (ORCA integration) | Yes (Assistant Investigations) |
| Start investigation from UI | Yes (manual trigger or alert webhook) | Yes (prompt-based in Workspace) |
| Real-time SSE streaming of agent progress | Yes (raw `fetch` + `ReadableStream`) | Yes |
| Step-by-step agent progress feed | Yes (node name + status in UI) | Yes (hypothesis updates in Workspace) |
| Working hypothesis with confidence score | Yes (0–100%, colour-coded) | Yes |
| High/uncertain confidence area tagging | Yes | Not documented |
| Interactive Q&A mid-investigation | Yes (developer refinement loop) | Yes (chat in Workspace) |
| Suggested follow-up questions from agent | Yes | Not documented |
| Accept / finalise investigation | Yes (double-confirm at <60% confidence) | Yes (report generation) |
| Final report (summary, root cause, recommendations) | Yes | Yes |
| RCA history browser | Yes (`/rca/runs`) | Yes (Workspace list) |
| RCA dashboard with aggregate stats | Yes | Not documented |
| Confidence breakdown panel | Yes | No |
| Per-investigation feedback (rating + comment) | Yes | Yes (thumbs in Workspace) |
| Automated trigger from alert / IRM webhook | Yes (ORCA webhook receiver) | Yes (IRM webhook automation) |
| Cross-signal investigation (metrics + logs + traces + profiles) | Depends on ORCA backend config | Yes (native — Grafana Cloud telemetry) |
| Investigation sharing / team scoping | No | Yes (team-scoped visibility) |
| Investigation memory / context across sessions | No | Yes (Cloud only) |
| Pricing for investigations | Included (self-hosted ORCA) | Free during public preview; paid after |

---

## 8. Navigation & Dashboard Integration

| Feature | Graft | Grafana Assistant |
|---|---|---|
| Chat accessible from sidebar nav | Yes | Yes (floating button + sidebar) |
| Deep link to specific session via URL | Yes | Not documented |
| Investigations reachable from alert manager | Yes (webhook → ORCA) | Yes (IRM integration) |
| Dashboard editing / creation via chat | No | Yes |
| Panel creation from natural language | No | Yes |
| Navigate Grafana resources via chat | No | Yes (Navigation guide mode) |
| Query generation / explanation | No | Yes (PromQL, LogQL, SQL, etc.) |
| k6 script authoring | No | Yes |

---

## 9. Knowledge & Skills

| Feature | Graft | Grafana Assistant |
|---|---|---|
| Custom team knowledge / skills | No | Yes (Skills system — encode team runbooks, procedures) |
| Pre-built quickstart guides | No | Yes (Learn mode) |
| Onboarding / product Q&A mode | No | Yes |
| Knowledge Graph mode | No | Yes (Grafana Cloud only) |
| Infrastructure memory (auto-built service map) | No | Yes (Grafana Cloud only) |

---

## 10. Integrations & Automation

| Feature | Graft | Grafana Assistant |
|---|---|---|
| Slack integration | No | Yes (Grafana Cloud only) |
| Microsoft Teams integration | No | Roadmap |
| CLI (terminal chat) | No | Yes (`gcx` CLI, Cloud only) |
| Automations (scheduled / on-demand prompts) | No | Yes (Grafana Cloud only) |
| IRM / on-call management via chat | No | Yes |
| Alert investigation via chat | No | Yes |
| Fleet Management (Alloy pipelines) | No | Yes |

---

## 11. Privacy, Security & Access Control

| Feature | Graft | Grafana Assistant |
|---|---|---|
| Runs entirely on-premises | Yes (LLM plugin + ORCA self-hosted) | No — backend is Grafana Cloud |
| Supports self-managed Grafana | Yes (no Cloud dependency) | Yes (hybrid — UI local, backend Cloud) |
| RBAC for plugin access | Grafana built-in app permissions | Yes (granular `Assistant User` / `Assistant Admin` roles) |
| Conversations processed on-prem | Yes (model calls via LLM plugin) | No (prompts sent to Grafana Cloud) |
| Per-user token / usage limits | No | Yes (configurable caps) |
| Usage analytics dashboard | No | Yes |
| Audit / feedback trail | Per-RCA feedback only | Yes (full feedback + usage analytics) |

---

## 12. Deployment & Hosting

| Feature | Graft | Grafana Assistant |
|---|---|---|
| Deployment model | Self-hosted Grafana app plugin | Grafana Cloud native; hybrid for self-managed |
| Minimum Grafana version | 10.4.0 | 13.0.0 (self-managed) |
| External dependencies | Grafana LLM plugin; ORCA backend for RCA | Grafana Cloud account |
| Model provider flexibility | Any provider supported by LLM plugin (OpenAI, Anthropic, Azure, etc.) | Grafana-managed (provider abstracted) |
| Cost model | Self-hosted cost + LLM API tokens | Usage-based SaaS (active users + tokens); investigations free in preview |
| Open source | Yes | No (closed, Grafana Cloud service) |

---

## Summary

### Graft's differentiators

- **Fully self-hosted** — no data leaves your infrastructure; model calls stay within your own LLM plugin deployment
- **Model provider flexibility** — works with any provider supported by the Grafana LLM plugin (OpenAI, Anthropic, Azure OpenAI, etc.)
- **Richer chat UX** — voice input, file attachments (images + code), prompt refinement, live thinking block visibility (`<think>` tag rendering), Mermaid diagram support
- **ORCA RCA integration** — deeper interactive investigation loop: confidence scoring, uncertain-area tagging, agent-suggested follow-up questions, double-confirm accept gate, and a dedicated aggregate stats dashboard
- **Prompt Library** — pre-configured and user-defined prompt catalogue with pinning and admin-configurable defaults
- **No Grafana Cloud dependency** — runs on Grafana 10.4+

### Grafana Assistant's differentiators

- **Dashboard authoring** — create and edit panels, queries, and dashboards via natural language
- **Query generation** — writes and explains PromQL, LogQL, SQL, CloudWatch, Elasticsearch, and other queries natively
- **Infrastructure memory** — automatically builds a service map from your telemetry to improve context accuracy over time
- **Cross-signal investigation** — natively queries metrics, logs, traces, and profiles from Grafana Cloud without an external RCA service
- **Skills system** — encodes team runbooks and procedures as reusable, parameterised prompt templates shared org-wide
- **Slack / CLI integrations** — interact with Assistant from outside Grafana
- **Automations** — schedule or trigger saved prompts on demand
- **IRM / on-call management** — manage alerts, silences, schedules, and incidents directly from chat
- **Team-scoped investigations** — share investigation results with specific Grafana teams
- **Managed deployment** — no infrastructure to operate; billing and limits built in
