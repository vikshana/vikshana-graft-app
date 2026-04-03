# Orca — Architecture

This document describes the architecture of the Orca system in detail, covering the system context, agent orchestration, data model, MCP integration, observability strategy, and deployment topology.

---

## Table of Contents

- [System Context](#system-context)
- [Alert Deduplication](#alert-deduplication)
- [Agent Orchestration (LangGraph)](#agent-orchestration-langgraph)
- [Agent Termination Strategy](#agent-termination-strategy)
- [MCP Integration](#mcp-integration)
- [Data Model](#data-model)
- [API Endpoints](#api-endpoints)
- [Observability Strategy](#observability-strategy)
- [Deployment Topology](#deployment-topology)
- [Frontend Architecture](#frontend-architecture)
- [Future Extensibility](#future-extensibility)

---

## System Context

The system context diagram shows how Orca fits into the broader infrastructure. Grafana is the alert source, Orca is the processing engine, and Slack + Frontend are the output channels.

```mermaid
graph LR
    subgraph External Systems
        GF[Grafana]
        SLACK[Slack]
    end

    subgraph Orca System
        API[FastAPI Backend]
        AGENT[LangGraph Agent]
        DB[(PostgreSQL)]
        FE[Next.js Frontend]
    end

    subgraph Data Sources
        GMCP[Grafana MCP Server<br/><i>grafana/mcp-grafana</i>]
        PMCP[Postgres MCP Server<br/><i>modelcontextprotocol/server-postgres</i>]
    end

    GF -- "webhook<br/>POST /webhook/grafana" --> API
    API -- "spawns async task" --> AGENT
    AGENT -- "query metrics,<br/>logs, dashboards" --> GMCP
    AGENT -- "search previous<br/>alerts & RCAs" --> PMCP
    GMCP -- "reads from" --> GF
    PMCP -- "reads from" --> DB
    AGENT -- "writes RCA,<br/>alert, steps" --> DB
    AGENT -- "post summary<br/>+ link" --> SLACK
    FE -- "GET /rca<br/>GET /rca/:id" --> API
    API -- "reads" --> DB

    style GF fill:#ff6b35,color:#fff
    style SLACK fill:#4a154b,color:#fff
    style API fill:#009688,color:#fff
    style AGENT fill:#1565c0,color:#fff
    style DB fill:#2e7d32,color:#fff
    style FE fill:#0070f3,color:#fff
    style GMCP fill:#f57c00,color:#fff
    style PMCP fill:#f57c00,color:#fff
```

### Flow Summary

1. **Grafana** fires a critical alert → sends webhook payload to Orca's `POST /webhook/grafana`
2. **Orca Backend** validates the payload (checks required labels), stores the raw alert, creates an RCA record with status `triggered`, and spawns an async LangGraph agent task
3. **LangGraph Agent** runs through triage → investigate → analyze → report → publish stages
4. **During investigation**, the agent queries Grafana via MCP (metrics, logs, dashboards) and Postgres via MCP (previous alerts, past RCAs with similar labels/alert names)
5. **On completion**, the agent writes the final RCA report to Postgres and posts a summary to Slack
6. **Frontend** polls the backend API to display RCA status and renders the final report

---

## Alert Deduplication

Grafana can fire the same alert rule multiple times before the underlying issue is resolved — for example, on every evaluation cycle while a service is degraded, or when multiple alert instances share the same labels. Without deduplication, each webhook call would spawn an independent agent investigation, wasting LLM budget and cluttering the RCA list with near-identical reports.

### Deduplication Rules

An incoming alert is considered a **duplicate** of an existing RCA if both of the following are true:

1. It has the **same fingerprint** (see below) as the alert that triggered the existing RCA.
2. Either:
   - The existing RCA's investigation is **still active** (`status` is `triggered` or `investigating`), **OR**
   - The existing RCA was created **within the last `ORCA_DEDUP_WINDOW_MINUTES`** (default: 30 minutes).

The active-investigation rule takes priority over the window — an ongoing investigation always absorbs matching duplicates regardless of how long it has been running.

### Fingerprinting

Rather than doing a full JSON deep-compare on every incoming alert, Orca computes a stable **SHA-256 fingerprint** derived from the alert name and its complete label set:

```python
def compute_fingerprint(alert_name: str, labels: dict[str, str]) -> str:
    payload = json.dumps(
        {"alert_name": alert_name, "labels": labels},
        sort_keys=True,   # stable regardless of insertion order
        separators=(",", ":"),
    )
    return hashlib.sha256(payload.encode()).hexdigest()
```

The fingerprint is stored in `alerts.dedup_fingerprint` (indexed) and used as the key for all dedup lookups. This means the deduplication query is a fast indexed equality check (`WHERE dedup_fingerprint = ?`) rather than a JSON comparison.

### Decision Flow

The deduplication check runs **inside the webhook handler**, before the agent is spawned. A duplicate alert is still persisted to the `alerts` table (for full audit trail) but no new `RCA` record is created and no agent task is queued.

```mermaid
flowchart TD
    WH["POST /webhook/grafana"] --> PARSE["Parse + validate payload\nExtract firing alerts"]
    PARSE --> LOOP["For each firing alert"]
    LOOP --> FP["Compute fingerprint\nSHA-256(alert_name + sorted labels)"]
    FP --> PERSIST["Persist Alert row\n(always — audit trail)"]
    PERSIST --> LOOKUP["Query rcas JOIN alerts\nWHERE fingerprint = ?\nAND (status IN active OR created_at >= now - window)"]

    LOOKUP --> FOUND{Canonical\nRCA found?}

    FOUND -- "Yes" --> DEDUP["Insert rca_duplicate_alerts row\nIncrement canonical.duplicate_count\nReturn existing rca_id\ndeduplicated=true"]
    FOUND -- "No" --> NEW["Create new RCA row\nstatus=triggered\nSpawn agent background task\ndeduplicated=false"]

    DEDUP --> RESP["Return WebhookResponse"]
    NEW --> RESP

    style DEDUP fill:#f57c00,color:#fff
    style NEW fill:#2e7d32,color:#fff
    style FOUND fill:#1565c0,color:#fff
```

### Data Model Additions

The deduplication feature introduces three schema additions:

| Change | Table | Description |
|---|---|---|
| `dedup_fingerprint VARCHAR(64)` | `alerts` | SHA-256 hex digest, indexed; `NULL` for alerts created before the feature was deployed (backfilled by `scripts/backfill_dedup.py`) |
| `duplicate_count INTEGER DEFAULT 0` | `rcas` | Fast-path counter — how many duplicate alerts this RCA has absorbed |
| `rca_duplicate_alerts` | new table | Association table linking each suppressed Alert to its canonical RCA; provides the full audit trail shown on the RCA detail page |

```mermaid
erDiagram
    ALERT {
        uuid id PK
        varchar dedup_fingerprint "SHA-256 of alert_name+labels — indexed"
    }

    RCA {
        uuid id PK
        integer duplicate_count "Incremented on each absorbed duplicate"
        varchar status "triggered | investigating | complete | failed | deduplicated"
    }

    RCA_DUPLICATE_ALERTS {
        uuid id PK
        uuid rca_id FK "Canonical RCA"
        uuid alert_id FK "Suppressed duplicate alert"
        timestamp created_at "When the duplicate was recorded"
    }

    ALERT ||--o{ RCA_DUPLICATE_ALERTS : "absorbed as duplicate by"
    RCA ||--o{ RCA_DUPLICATE_ALERTS : "absorbs"
```

### The `deduplicated` RCA Status

In addition to the `rca_duplicate_alerts` table, a sixth RCA status value — **`deduplicated`** — is used exclusively by the historical backfill script. It marks pre-existing RCA records that were created before the deduplication feature was deployed and that would have been suppressed had dedup been active. These rows are hidden from the default `GET /api/rca` list (they appear only when the caller explicitly requests `?status=deduplicated`) so they do not clutter the dashboard.

New RCAs created after deployment are never assigned this status — they are simply never created in the first place if a canonical RCA exists.

### Race-Condition Safety

Two identical webhooks arriving within milliseconds of each other could theoretically both pass the dedup check before either commits. In practice the FastAPI webhook handler processes alerts sequentially within a single request (the `for grafana_alert in firing_alerts` loop runs inside one DB transaction), so intra-request races are not possible. Cross-request races on truly simultaneous webhooks are mitigated by the fact that `find_canonical_rca` is executed inside the same session transaction as the `Alert` insert and `session.flush()` is called before the check — but a `UNIQUE` partial index on `(dedup_fingerprint) WHERE status IN ('triggered','investigating')` would be the production-grade solution for high-concurrency environments.

### Configuration

| Variable | Default | Description |
|---|---|---|
| `ORCA_DEDUP_WINDOW_MINUTES` | `30` | Alerts with the same fingerprint arriving within this many minutes are considered duplicates, even if the investigation has already completed |

### Backfilling Pre-Existing Data

A one-shot migration script (`backend/scripts/backfill_dedup.py`) handles databases that already contain duplicate RCA records from before the feature was deployed:

1. **Backfills `dedup_fingerprint`** on all `alerts` rows that have `NULL`.
2. **Groups RCAs by fingerprint** and processes each group chronologically.
3. For each group, applies the same 30-minute window rule — the oldest RCA in each window becomes the canonical; later ones within the window are marked `status='deduplicated'` and their alerts are linked via `rca_duplicate_alerts`.

```bash
DATABASE_URL=postgresql+asyncpg://orca:orca@localhost:5432/orca \
    python backend/scripts/backfill_dedup.py
```

---

## Agent Orchestration (LangGraph)

The agent is implemented as a LangGraph `StateGraph` with five nodes and conditional edges. Each node uses a different Claude model optimised for its task.

```mermaid
stateDiagram-v2
    [*] --> Triage
    Triage --> InvalidAlert: missing labels
    Triage --> Investigate: labels valid
    InvalidAlert --> [*]
    Investigate --> Investigate: need more data (step < budget)
    Investigate --> Analyze: sufficient evidence OR budget exhausted
    Analyze --> Report
    Report --> Publish
    Publish --> [*]

    note right of Triage
        Model: Claude Haiku (fast, cheap)
        - Parse alert payload
        - Validate required labels
        - Classify severity
    end note

    note left of InvalidAlert
        Log warning, set status=failed
        No agent execution
    end note

    note right of Investigate
        Model: Claude Sonnet (balanced)
        ReAct loop:
        1. Decide what to query
        2. Call MCP tool (Grafana/Postgres)
        3. Evaluate result
        4. Repeat or exit
    end note

    note right of Analyze
        Model: Claude Sonnet
        - Synthesise all gathered evidence
        - Identify root cause
        - Build timeline
        - List contributing factors
        - Assess confidence level (high/medium/low)
    end note

    note right of Report
        Model: Claude Sonnet
        - Generate structured RCA markdown
        - Follow 11-section template
        - Include confidence level + justification
        - Include evidence references
    end note

    note right of Publish
        No LLM - deterministic code
        - Write RCA report to Postgres
        - Update RCA status to complete
        - Send Slack notification
    end note
```

### State Schema

The LangGraph state is a `TypedDict` that flows through all nodes:

```python
class OrcaState(TypedDict):
    # Alert context
    rca_id: str                      # UUID for this RCA run
    alert_payload: dict              # Raw Grafana webhook payload
    alert_labels: dict               # Extracted labels (service_name, team, etc.)
    alert_name: str                  # Alert name for searching
    severity: str                    # Classified severity

    # Investigation state
    investigation_steps: list[dict]  # Log of each tool call + result
    step_count: int                  # Current step number
    total_tokens_used: int           # Cumulative token usage
    evidence: list[dict]             # Collected evidence items

    # Historical context
    similar_past_alerts: list[dict]  # Previous alerts with matching labels
    related_rcas: list[dict]         # Past RCAs for similar incidents

    # Analysis output
    root_cause: str                  # Identified root cause
    contributing_factors: list[str]  # Contributing factors
    timeline: list[dict]            # Event timeline
    impact_summary: str              # Impact description
    confidence_level: str            # high | medium | low
    confidence_reasoning: str        # Why this confidence level was assigned

    # Final output
    report_markdown: str             # The final RCA report
    status: str                      # triggered | investigating | complete | failed
    error_message: str | None        # Error details if failed
```

---

## Agent Termination Strategy

The investigation loop is bounded by three layered guardrails:

```mermaid
graph TD
    START[Enter Investigate Node] --> DECIDE{Agent decides:<br/>enough evidence?}
    DECIDE -- "Yes" --> EXIT[→ Analyze Node]
    DECIDE -- "No" --> STEP_CHECK{step_count <br/>< MAX_STEPS?}
    STEP_CHECK -- "No" --> FORCE_EXIT[Force → Analyze Node<br/><i>budget exhausted</i>]
    STEP_CHECK -- "Yes" --> TOKEN_CHECK{total_tokens <br/>< MAX_TOKENS?}
    TOKEN_CHECK -- "No" --> FORCE_EXIT
    TOKEN_CHECK -- "Yes" --> TOOL_CALL[Execute MCP tool call]
    TOOL_CALL --> LOG[Log step to agent_step table]
    LOG --> INCREMENT[step_count += 1<br/>total_tokens += usage]
    INCREMENT --> DECIDE

    style FORCE_EXIT fill:#e53935,color:#fff
    style EXIT fill:#2e7d32,color:#fff
    style TOOL_CALL fill:#1565c0,color:#fff
```

| Guardrail | Default | Configurable Via |
|---|---|---|
| Max investigation steps | 15 | `ORCA_MAX_INVESTIGATION_STEPS` env var |
| Max tokens (investigation) | 100,000 | `ORCA_MAX_INVESTIGATION_TOKENS` env var |
| Wall-clock timeout | 5 minutes | `ORCA_AGENT_TIMEOUT_SECONDS` env var |
| LangGraph recursion limit | 25 | `recursion_limit` in graph config |

The wall-clock timeout wraps the entire `graph.ainvoke()` call via `asyncio.wait_for()` and is the ultimate safety net.

---

## MCP Integration

### Grafana MCP Server

- **Server**: `grafana/mcp-grafana` (official Grafana Labs MCP server)
- **Connection**: stdio transport, spawned as a subprocess by the agent
- **Tool filtering**: Done at the **LangGraph tool-binding level** — only read/query tools are bound to the agent

**Allowed tools** (allow-list):

| Tool | Purpose |
|---|---|
| `search_dashboards` | Find relevant dashboards by service/keyword |
| `get_dashboard_by_uid` | Retrieve a specific dashboard's panels |
| `query_prometheus` | Execute PromQL queries for metrics |
| `query_loki` | Execute LogQL queries for logs |
| `list_datasources` | Discover available datasources |
| `get_alerts` | List current alert instances and their states |

**Blocked tools** (everything else, including mutations like `create_dashboard`, `update_alert_rule`, etc.)

### Postgres MCP Server

- **Server**: `modelcontextprotocol/server-postgres` (community MCP server)
- **Connection**: stdio transport, configured with Orca's Postgres connection string
- **Purpose**: Agent searches for previous alerts and past RCAs by matching on labels and alert name

**Typical queries the agent runs via Postgres MCP:**

```sql
-- Find previous alerts for the same service in the same environment
SELECT * FROM alerts
WHERE labels->>'service_name' = 'checkout-service'
  AND labels->>'deployment_environment_name' = 'production'
ORDER BY created_at DESC LIMIT 10;

-- Find past RCAs with similar alert names
SELECT id, alert_name, root_cause, report_markdown, created_at
FROM rcas
WHERE alert_name ILIKE '%high_latency%'
  AND service_name = 'checkout-service'
ORDER BY created_at DESC LIMIT 5;
```

---

## Data Model

```mermaid
erDiagram
    ALERT {
        uuid id PK
        jsonb raw_payload "Full Grafana webhook payload"
        varchar alert_name "Alert rule name"
        varchar status "firing | resolved"
        varchar severity "critical | warning | info"
        jsonb labels "All alert labels"
        varchar dedup_fingerprint "SHA-256(alert_name+labels) — indexed"
        varchar service_name "Indexed — from labels"
        varchar deployment_environment_name "Indexed — from labels"
        varchar domain "Indexed — from labels"
        varchar legal_company "Indexed — from labels"
        varchar sub_domain "Indexed — from labels"
        varchar system_id "Indexed — from labels"
        varchar team "Indexed — from labels"
        varchar version "Indexed — from labels"
        timestamp fired_at "When alert fired"
        timestamp created_at "When Orca received it"
    }

    RCA {
        uuid id PK
        uuid alert_id FK "Source alert"
        varchar alert_name "Denormalised for search"
        varchar status "triggered | investigating | complete | failed | deduplicated"
        integer duplicate_count "How many duplicates this RCA has absorbed"
        varchar service_name "Indexed — from alert labels"
        varchar deployment_environment_name "Indexed — from alert labels"
        varchar domain "Indexed — from alert labels"
        varchar legal_company "Indexed — from alert labels"
        varchar sub_domain "Indexed — from alert labels"
        varchar system_id "Indexed — from alert labels"
        varchar team "Indexed — from alert labels"
        varchar version "Indexed — from alert labels"
        text root_cause "Identified root cause (plain text)"
        text report_markdown "Full RCA report in markdown"
        varchar confidence_level "high | medium | low"
        text confidence_reasoning "Why this confidence was assigned"
        integer total_steps "Number of investigation steps"
        integer total_tokens "Total tokens consumed"
        float duration_seconds "Wall-clock duration"
        varchar error_message "Error details if failed"
        timestamp started_at "Agent start time"
        timestamp completed_at "Agent completion time"
        timestamp created_at
    }

    AGENT_STEP {
        uuid id PK
        uuid rca_id FK "Parent RCA"
        integer step_number "Sequential step within the RCA"
        varchar node_name "triage | investigate | analyze | report | publish"
        varchar action "Tool name or decision description"
        text input "Query or prompt sent"
        text output "Result or response received"
        integer tokens_used "Tokens for this step"
        float duration_seconds "Latency for this step"
        timestamp created_at
    }

    RCA_DUPLICATE_ALERTS {
        uuid id PK
        uuid rca_id FK "Canonical RCA that absorbed the duplicate"
        uuid alert_id FK "The suppressed duplicate alert"
        timestamp created_at "When the duplicate was recorded"
    }

    ALERT ||--o{ RCA : "triggers"
    RCA ||--o{ AGENT_STEP : "contains"
    RCA ||--o{ RCA_DUPLICATE_ALERTS : "absorbs duplicates"
    ALERT ||--o{ RCA_DUPLICATE_ALERTS : "absorbed as duplicate"
```

### Indexing Strategy

The 8 label fields are denormalised onto both `ALERT` and `RCA` tables and individually indexed to support fast filtering in the frontend. The `alert_name` field has a GIN trigram index for free-text `ILIKE` search.

```sql
-- Example indexes on RCA table
CREATE INDEX idx_rca_service_name ON rcas (service_name);
CREATE INDEX idx_rca_environment ON rcas (deployment_environment_name);
CREATE INDEX idx_rca_domain ON rcas (domain);
CREATE INDEX idx_rca_team ON rcas (team);
CREATE INDEX idx_rca_status ON rcas (status);
CREATE INDEX idx_rca_alert_name_trgm ON rcas USING gin (alert_name gin_trgm_ops);
```

### Confidence Level

Every RCA includes a confidence assessment set by the Analyze node. The agent evaluates the quality and breadth of evidence gathered during investigation:

| Level | Criteria | Example |
|---|---|---|
| **high** | Multiple corroborating data sources, clear metrics correlation, root cause directly observable in logs/traces | Prometheus shows CPU spike at exact alert time, matching error logs in Loki, same pattern in 3 past incidents |
| **medium** | Partial evidence from some sources, reasonable inference but gaps remain | Metrics show degradation but no matching logs found; root cause inferred from timing correlation |
| **low** | Limited data available, speculative analysis, investigation budget exhausted before sufficient evidence gathered | Only alert payload available; Grafana queries returned no relevant data; best-guess based on alert name and service history |

The confidence level is stored on the RCA record and displayed prominently in both the frontend and Slack notification, so engineers can calibrate their trust in the findings.

---

## API Endpoints

### Webhook

| Method | Path | Description |
|---|---|---|
| `POST` | `/webhook/grafana` | Receive Grafana alert webhook, validate labels, trigger RCA |

### RCA

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/rca` | List RCAs with filtering and pagination |
| `GET` | `/api/rca/{id}` | Get full RCA detail including report and agent steps |

### Query Parameters for `GET /api/rca`

| Parameter | Type | Description |
|---|---|---|
| `service_name` | `string` | Filter by service name |
| `deployment_environment_name` | `string` | Filter by environment |
| `domain` | `string` | Filter by domain |
| `legal_company` | `string` | Filter by legal company |
| `sub_domain` | `string` | Filter by sub-domain |
| `system_id` | `string` | Filter by system ID |
| `team` | `string` | Filter by team |
| `version` | `string` | Filter by version |
| `status` | `string` | Filter by status (triggered, investigating, complete, failed) |
| `alert_name` | `string` | Free-text search on alert name |
| `page` | `int` | Page number (default: 1) |
| `page_size` | `int` | Items per page (default: 20) |

---

## Observability Strategy

Orca uses a three-layer observability approach:

```mermaid
graph TB
    subgraph "Layer 1: Developer Observability"
        LS[LangSmith]
        LS_DETAIL["• Full prompt/response pairs per node<br/>• Token usage per model (Haiku vs Sonnet)<br/>• Latency per step<br/>• Tool call inputs/outputs<br/>• Compare traces across RCA runs<br/>• Annotation queues for feedback"]
    end

    subgraph "Layer 2: User-Facing Observability"
        FE[Frontend RCA Detail Page]
        AS[(agent_step table)]
        FE_DETAIL["• Step-by-step timeline of agent actions<br/>• Queries executed and results<br/>• Status progression<br/>• Duration and token counts"]
        FE --> AS
    end

    subgraph "Layer 3: Operational Observability"
        SL[structlog]
        SL_DETAIL["• Structured JSON logs<br/>• rca_id correlation across all log lines<br/>• Request/response logging<br/>• Error tracking with stack traces"]
    end

    style LS fill:#7c4dff,color:#fff
    style FE fill:#0070f3,color:#fff
    style AS fill:#2e7d32,color:#fff
    style SL fill:#ff6f00,color:#fff
```

### LangSmith Setup

LangSmith integration is automatic — LangGraph instruments itself when these env vars are set:

```bash
LANGCHAIN_TRACING_V2=true
LANGCHAIN_API_KEY=ls-...
LANGCHAIN_PROJECT=orca-dev
```

No code changes required. Every node execution, tool call, and conditional edge decision is traced.

### structlog Configuration

All logs use `structlog` with bound context:

```python
logger = structlog.get_logger()

# In every agent execution, bind the rca_id
log = logger.bind(rca_id=rca_id)
log.info("investigation_step", step=3, tool="query_prometheus", query="rate(http_requests_total[5m])")
```

---

## Deployment Topology

### Development (docker-compose)

```mermaid
graph TB
    subgraph "docker-compose.yml (Core Orca)"
        PG[(PostgreSQL<br/>:5432)]
        BE[Orca Backend<br/>FastAPI<br/>:8000]
        FE[Orca Frontend<br/>Next.js<br/>:3000]

        BE --> PG
        FE --> BE
    end

    DEV[Developer] --> FE
    DEV --> BE

    style PG fill:#2e7d32,color:#fff
    style BE fill:#009688,color:#fff
    style FE fill:#0070f3,color:#fff
```

### Demo (with OpenTelemetry Demo)

`demo/docker-compose.yml` (at repo root) is a standalone compose file that directly defines a minimal subset of OTel demo services alongside Orca overrides. It does not use `include` — only the services needed for fault injection and alerting are declared, avoiding the full ~25-service OTel demo stack.

```mermaid
graph TB
    subgraph "demo/docker-compose.yml"
        subgraph "OTel Demo subset (standalone)"
            FRONTEND[frontend<br/><i>:8080</i>]
            CART[cartservice]
            CHECKOUT[checkoutservice]
            CATALOG[productcatalogservice]
            PAYMENT[paymentservice]
            AD[adservice<br/><i>adServiceFailure flag</i>]
            LOCUST[loadgenerator<br/><i>Locust</i>]
            OTELCOL[otelcol<br/><i>OTel Collector</i>]
            PROM[Prometheus<br/><i>:9090</i>]
            GRAF[Grafana<br/><i>:3001 — provisioned<br/>alerts + contact point</i>]
            JAEGER[Jaeger<br/><i>:16686</i>]

            FRONTEND --> CART
            FRONTEND --> CHECKOUT
            FRONTEND --> CATALOG
            CHECKOUT --> PAYMENT
            LOCUST --> FRONTEND
            CART --> OTELCOL
            CHECKOUT --> OTELCOL
            PAYMENT --> OTELCOL
            AD --> OTELCOL
            OTELCOL --> PROM
            OTELCOL --> JAEGER
            PROM --> GRAF
        end

        subgraph "Orca Stack"
            PG[(orca-postgres<br/>:5432)]
            BE[orca-backend<br/>FastAPI<br/>:8000]
            FE[orca-frontend<br/>Next.js<br/>:3000]
            GMCP[Grafana MCP Server]
            PMCP[Postgres MCP Server]

            BE --> PG
            FE --> BE
            BE --> GMCP
            BE --> PMCP
            GMCP --> GRAF
            PMCP --> PG
        end

        GRAF -- "webhook on alert" --> BE
    end

    subgraph "Grafana Provisioning"
        AR[alerting/alert-rules.yml<br/><i>Rules on OTel metrics</i>]
        CP[contact-points/orca-webhook.yml<br/><i>→ http://orca-backend:8000/webhook/grafana</i>]
        AR --> GRAF
        CP --> GRAF
    end

    style GRAF fill:#ff6b35,color:#fff
    style BE fill:#009688,color:#fff
    style FE fill:#0070f3,color:#fff
    style PG fill:#2e7d32,color:#fff
    style AD fill:#e53935,color:#fff
```

### Demo Walkthrough

1. Clone the OTel demo: `cd services/orca && make init`
2. Start the demo stack: `cd services/orca && make up`
3. Locust begins generating continuous traffic to the OTel demo frontend automatically
4. Open Grafana at `http://localhost:3002` — pre-provisioned alert rules are already active
5. To trigger an incident: open the Feature Flag UI at `http://localhost:8080` and enable `adServiceFailure` or `cartServiceFailure`
6. The degraded service causes metric anomalies → Grafana alert fires → webhook POSTs to `http://orca-backend:8000/webhook/grafana`
7. Orca agent investigates → RCA generated → Slack notification sent
8. View the RCA in the Orca frontend at `http://localhost:3000/rca/{id}`

---

## Frontend Architecture

The frontend is a Next.js application with two main views:

### Dashboard (`/`)

- **FilterBar**: Dropdowns for each of the 8 label fields + free-text input for alert name
- **RCATable**: Paginated table showing RCAs with columns: alert name, service, environment, team, confidence, status, created time
- **StatusBadge**: Colour-coded status indicator (triggered=yellow, investigating=blue, complete=green, failed=red)
- **Polling**: Dashboard polls `GET /api/rca` every 5 seconds to reflect status changes

### RCA Detail (`/rca/{id}`)

- **Confidence Badge**: Prominent colour-coded indicator (high=green, medium=amber, low=red) with justification tooltip
- **Report**: Rendered markdown of the full 11-section RCA report
- **Agent Steps**: Collapsible timeline showing every step the agent took (from `agent_step` table)
- **Metadata**: Alert labels, duration, token usage, timestamps
- **Shareable URL**: The page URL is the unique link for post-mortems (`/rca/{uuid}`)

---

## Future Extensibility

The architecture is designed to accommodate future enhancements without structural changes:

| Enhancement | How It Fits |
|---|---|
| **Additional MCP data sources** | Add new MCP client configs in `agent/mcp/` (e.g., `confluence_client.py`, `git_runbooks_client.py`) and bind their tools to the investigate node |
| **Container-based sandbox** | Replace `BackgroundTask` with a container orchestrator (Docker SDK / K8s Job) that runs the agent graph in isolation |
| **Interactive Slack** | Add Slack bolt handler in `integrations/slack.py` to receive thread replies and feed them back to the agent |
| **Self-hosted LLM observability** | Swap LangSmith for LangFuse — same callback interface, self-hosted via additional docker-compose service |
| **PDF export** | Add a `/api/rca/{id}/pdf` endpoint that renders the markdown report to PDF via `weasyprint` or similar |
| **RCA quality scoring** | Add a thumbs-up/down endpoint + store feedback in a `rca_feedback` table; use for evaluation datasets in LangSmith |
| **Multi-LLM support** | Swap Anthropic for OpenAI/Azure in node configs — LangChain's model abstraction makes this a config change |

