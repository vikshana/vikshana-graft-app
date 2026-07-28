# 🐋 Orca — Omniscient Root Cause Analyser

> Agentic root cause analysis powered by LLMs, triggered by Grafana alerts, delivering structured RCA reports in seconds.

Orca is an AI-powered system that automatically investigates production incidents. When a critical Grafana alert fires, Orca spins up an LLM agent that queries your observability stack via MCP (Model Context Protocol), analyses metrics, logs, and traces, correlates with past incidents, and produces a structured Root Cause Analysis report — all without human intervention.

---

## ✨ Features

- **Automated RCA** — Grafana webhook triggers an LLM agent that investigates autonomously
- **Multi-model orchestration** — Uses Claude Haiku for triage, Claude Sonnet for deep investigation and reporting — optimising cost and speed
- **MCP integration** — Queries Grafana and Postgres via Model Context Protocol for standardised tool access
- **Structured reports** — Every RCA follows a consistent 11-section template with confidence scoring (Summary → Confidence → Timeline → Root Cause → Actions → ...)
- **Historical correlation** — Agent searches past alerts and RCAs to identify patterns and recurring issues
- **Real-time status** — Frontend dashboard shows agent progress (triggered → investigating → complete → failed)
- **Filterable dashboard** — Filter RCAs by service, environment, domain, team, and more; free-text search on alert name
- **Unique RCA links** — Every analysis has a permanent URL for post-mortems and documentation
- **Slack notifications** — Summary report posted to Slack with a link to the full detailed report
- **Full reasoning trace** — Every agent step (queries, results, decisions) is logged and viewable

---

## 🏗️ Tech Stack

| Layer | Technology |
|---|---|
| **Backend** | Python · FastAPI · LangGraph · LangChain |
| **LLM Provider** | Anthropic (Claude Haiku, Claude Sonnet) |
| **Agent Tools** | Grafana MCP Server (`grafana/mcp-grafana`) · Postgres MCP Server |
| **Database** | PostgreSQL (async via SQLAlchemy) |
| **Frontend** | TypeScript · Next.js · React |
| **Observability** | LangSmith (agent tracing) · structlog (operational logs) |
| **Integrations** | Slack (webhook) · Grafana (alert webhook) |
| **Demo** | OpenTelemetry Demo (git submodule) |

---

## 📐 Architecture Overview

```
┌─────────────┐     webhook      ┌──────────────────┐     MCP      ┌─────────────────┐
│   Grafana   │  ───────────────►│   Orca Backend   │ ◄──────────► │  Grafana MCP    │
│  Alerting   │                  │   (FastAPI)      │              │  Server         │
└─────────────┘                  │                  │     MCP      ├─────────────────┤
                                 │   LangGraph      │ ◄──────────► │  Postgres MCP   │
                                 │   Agent          │              │  Server         │
                                 └────────┬─────────┘              └─────────────────┘
                                          │
                           ┌──────────────┼──────────────┐
                           ▼              ▼              ▼
                    ┌────────────┐ ┌────────────┐ ┌────────────┐
                    │ PostgreSQL │ │   Slack    │ │  Frontend  │
                    │ (storage)  │ │ (notify)   │ │  (Next.js) │
                    └────────────┘ └────────────┘ └────────────┘
```

For detailed architecture with Mermaid diagrams, see [docs/architecture.md](docs/architecture.md).

---

## 🤖 Agent Flow

The LangGraph agent processes each alert through five stages:

| Stage | Model | Purpose |
|---|---|---|
| **Triage** | Claude Haiku | Validate alert labels, classify severity, check for duplicates |
| **Investigate** | Claude Sonnet | ReAct loop — query Grafana metrics/logs, search past alerts via Postgres MCP |
| **Analyze** | Claude Sonnet | Synthesise evidence into root cause, contributing factors, timeline |
| **Report** | Claude Sonnet | Generate structured 11-section RCA markdown with confidence level |
| **Publish** | No LLM | Persist to database, send Slack notification |

The Investigate stage loops with a step budget (max iterations + token limit + wall-clock timeout) to prevent runaway execution.

---

## 📋 RCA Report Template

Every report follows this structure:

1. **Summary** — One-paragraph executive summary (what happened, impact, root cause)
2. **Confidence Level** — How reliable the findings are: `high` (strong evidence, multiple corroborating sources), `medium` (partial evidence, some gaps), or `low` (limited data, speculative). Includes a brief justification.
3. **Alert Details** — Original alert name, labels, severity, timestamps, source dashboard
4. **Timeline** — Chronological sequence of events with timestamps
5. **Impact** — What was affected, blast radius, duration, user-facing symptoms
6. **Root Cause** — The identified root cause with evidence
7. **Contributing Factors** — Other conditions that enabled or worsened the issue
8. **Evidence** — Queries executed, metrics/logs examined, key data points
9. **Remediation** — What was done or should be done to resolve the immediate issue
10. **Actions** — Concrete follow-up items with suggested priority (P1–P4)
11. **Related Incidents** — Links to similar past RCAs from the Orca database

---

## 🔍 Alert Label Requirements

Orca requires the following labels on every Grafana alert. If any are missing, the agent will **not** trigger and a warning will be logged.

| Label | Description |
|---|---|
| `service_name` | Name of the affected service |
| `deployment_environment_name` | Environment (production, staging, etc.) |
| `domain` | Business domain |
| `legal_company` | Legal entity / company |
| `sub_domain` | Sub-domain within the business domain |
| `system_id` | System identifier |
| `team` | Owning team |
| `version` | Service version |

---

## 📁 Project Structure

<details>

```
O11y-Orca/
├── CLAUDE.md                           # Claude Code project instructions
├── AGENT.md                            # AI agent coding guidelines
├── README.md
├── docs/
│   └── architecture.md                 # Detailed architecture with Mermaid diagrams
│
├── backend/
│   ├── pyproject.toml                  # Dependencies, mypy config, pytest config
│   └── app/
│       ├── main.py                     # FastAPI app + lifespan (creates tables on startup)
│       ├── config.py                   # pydantic-settings (.env)
│       ├── db.py                       # Async SQLAlchemy engine + session factory
│       ├── logging.py                  # structlog config with rca_id correlation
│       ├── api/
│       │   ├── webhooks.py             # POST /webhook/grafana
│       │   └── rca.py                  # GET /rca, GET /rca/{id}
│       ├── models/
│       │   ├── alert.py                # Raw alert ingestion model
│       │   ├── rca.py                  # RCA record (status, report, labels)
│       │   └── agent_step.py           # Agent step log (node, query, result, tokens)
│       ├── schemas/
│       │   ├── webhook.py              # Grafana webhook payload schema
│       │   └── rca.py                  # RCA API response schemas
│       ├── agent/
│       │   ├── graph.py                # LangGraph StateGraph + conditional edges
│       │   ├── state.py                # TypedDict for agent state
│       │   ├── mcp/
│       │   │   ├── grafana_client.py   # Grafana MCP client + tool allow-list
│       │   │   └── postgres_client.py  # Postgres MCP client
│       │   ├── nodes/
│       │   │   ├── triage.py           # Haiku — validate, classify, dupe check
│       │   │   ├── investigate.py      # Sonnet — ReAct loop via MCP
│       │   │   ├── analyze.py          # Sonnet — synthesise root cause
│       │   │   ├── report.py           # Sonnet — generate structured markdown
│       │   │   └── publish.py          # No LLM — persist + notify
│       │   └── prompts/
│       │       ├── triage.md
│       │       ├── investigate.md
│       │       ├── analyze.md
│       │       └── report.md
│       └── integrations/
│           └── slack.py                # Slack incoming webhook client
│
├── backend/tests/
│   ├── conftest.py                     # Fixtures: test DB, async client, mock MCP
│   ├── unit/
│   │   ├── test_triage_node.py
│   │   ├── test_investigate_node.py
│   │   ├── test_analyze_node.py
│   │   ├── test_report_node.py
│   │   ├── test_publish_node.py
│   │   ├── test_webhook_validation.py
│   │   └── test_models.py
│   └── integration/
│       ├── test_webhook_to_rca.py      # Full flow: webhook → stored RCA
│       ├── test_rca_api.py             # API endpoints with test DB
│       └── test_grafana_mcp.py         # Live MCP connectivity (slow)
│
├── frontend/
│   ├── package.json
│   ├── tsconfig.json
│   ├── next.config.js
│   └── src/
│       ├── app/
│       │   ├── layout.tsx
│       │   ├── page.tsx                # Dashboard with filters + search
│       │   └── rca/[id]/page.tsx       # RCA detail: markdown + step log
│       ├── components/
│       │   ├── RCATable.tsx
│       │   ├── StatusBadge.tsx
│       │   └── FilterBar.tsx
│       ├── lib/
│       │   └── api.ts                  # Typed fetch wrappers
│       └── types/
│           └── rca.ts                  # TypeScript types
│
├── demo/
│   ├── README.md                       # Demo walkthrough
│   ├── docker-compose.yml              # Standalone OTel demo subset (minimal)
│   ├── otel-collector-config.yml       # Simplified collector config (Prometheus + Loki)
│   ├── opentelemetry-demo/             # Git submodule (images + configs only)
│   └── grafana-provisioning/
│       ├── alerting/
│       │   └── alert-rules.yml
│       ├── contact-points/
│       │   └── orca-webhook.yml
│       └── datasources/
│           └── datasources.yml
│
├── docker-compose.yml                  # Orca stack (orca-postgres, orca-backend, orca-frontend)
├── Makefile                            # Orchestrates Orca + demo (make up / make down)
└── .env.example
```

</details>

---

## 🚀 Quick Start

### Prerequisites

- Docker & Docker Compose
- Python 3.12+
- Node.js 20+
- Anthropic API key
- (Optional) LangSmith API key
- (Optional) Slack incoming webhook URL

### Option A — Full Docker stack (simplest)

```bash
# Copy and fill in environment variables at the root of the repo
cp .env.example .env
# Edit .env — set ANTHROPIC_API_KEY at minimum

# Start Orca services only (Postgres + backend + frontend)
docker compose up --force-recreate --remove-orphans --build

# Schema is managed by Alembic — docker-entrypoint.sh runs
# `alembic upgrade head` automatically before the backend starts.
```

### Option B — Local development (backend + frontend outside Docker)

> **Prerequisite:** PostgreSQL must be running and reachable at `localhost:5432` before starting the backend.
> The easiest way is to spin up just the Postgres container:
>
> ```bash
> docker-compose up -d orca-postgres
> # Wait for it to become healthy (usually a few seconds)
> docker inspect --format='{{.State.Health.Status}}' orca-postgres
> # → "healthy"
> ```

```bash
# Copy and fill in environment variables
cp .env.example .env
# Edit .env — set ANTHROPIC_API_KEY and ensure DATABASE_URL points to localhost:5432

# Start Postgres only
docker-compose up -d orca-postgres

# Install backend dependencies and start dev server
cd backend
pip install -e ".[dev]"
alembic upgrade head
# Schema is managed exclusively by Alembic — run the migration above once
# before first startup and whenever new migrations land.
uvicorn app.main:app --reload --port 8000

# In a second terminal — install frontend dependencies and start dev server
cd frontend
npm install
npm run dev
```

### Run Tests

```bash
cd backend

# Unit tests
pytest tests/unit/ -v

# Integration tests (requires running Postgres)
pytest tests/integration/ -v

# All tests with coverage
pytest --cov=app tests/
```

### Demo with OpenTelemetry

The demo environment uses the [OpenTelemetry Demo](https://github.com/open-telemetry/opentelemetry-demo) as a git submodule. A standalone `demo/docker-compose.yml` defines a minimal subset of OTel demo services — only 3 fault-injection targets plus the infrastructure needed to generate traffic and alerts.

**Step 1 — Initialise the submodule:**

```bash
# From the repo root
make init
# Or manually: git submodule update --init --recursive
```

**Step 2 — Set up environment variables:**

```bash
cp .env.example .env
# Edit .env — set ANTHROPIC_API_KEY at minimum
```

**Step 3 — Start the full demo stack (OTel services + Orca):**

```bash
make up
```

This starts the following services — enough to generate realistic traffic and trigger meaningful alerts:

| Layer | Services |
|---|---|
| **Fault injection targets** | `ad`, `cart`, `product-catalog` |
| **Feature flags** | `flagd`, `flagd-ui` |
| **Traffic generation** | `load-generator`, `frontend`, `frontend-proxy`, `image-provider` |
| **Telemetry pipeline** | `otel-collector`, `prometheus`, `loki`, `grafana` (:3001) |
| **Backing stores** | `valkey-cart`, `postgresql` (OTel demo's) |
| **Orca** | `orca-postgres`, `orca-backend`, `orca-frontend` |

**Step 4 — Trigger an incident:**

```bash
# Open the Feature Flag UI
open http://localhost:8080/feature

# Enable a failure scenario (e.g. adFailure or cartFailure)
# Locust will hit the degraded service → metrics spike → Grafana alert fires
# → Orca webhook triggers → RCA generated
```

**Step 5 — View the RCA:**

```bash
open http://localhost:3000
```

See [demo/README.md](demo/README.md) for the full step-by-step walkthrough including available feature flags and pre-provisioned alert rules.

---

## 🔐 Internal Authentication (HMAC)

The Grafana Go plugin gateway (`pkg/plugin/`) is the only intended caller of
this backend's internal API surface (`/api/sessions`, `/api/mcp`,
`/api/identity`, `/api/rca`). Every request the gateway proxies is signed
with HMAC-SHA256 and validated by `InternalAuthMiddleware`
(`harness/auth/internal_auth.py`):

```
X-Agent-Signature: HMAC-SHA256(method:timestamp:nonce:target:body_sha256:org_id, secret)
X-Agent-Timestamp: <unix timestamp>
X-Agent-Nonce:     <random per-request token>
```

`target` is the raw, percent-encoded path plus raw query string exactly as
transmitted on the wire (Go's `req.URL.EscapedPath()` / Python's ASGI
`raw_path` — not the decoded path), so a byte-for-byte identical
canonicalisation is used on both sides of the proxy.

**Shared secret.** Both sides read `AGENT_INTERNAL_SECRET` — the Go plugin
(`grafana` service) and this backend (`orca-backend` service) **must** be
configured with the exact same value, or every internal request will be
rejected with `401 invalid signature`. The root `docker-compose.yaml` sources
both from a single `AGENT_INTERNAL_SECRET` entry in the repo-root `.env`
file, so setting it once keeps them in sync:

```bash
# repo root .env
AGENT_INTERNAL_SECRET=$(openssl rand -hex 32)
```

Leaving it unset (the default) disables signature validation entirely —
acceptable for local development, but `Settings.validate_production_secrets`
(`app/config.py`) refuses to start this backend when `ENVIRONMENT=production`
and `AGENT_INTERNAL_SECRET` is empty.

**Clock synchronisation (NTP).** The signature's timestamp is checked
against a 30-second freshness window (`_MAX_TIMESTAMP_SKEW_S` in
`internal_auth.py`) to bound the replay attack surface. This means the Go
plugin container/host and the `orca-backend` container/host **must have
their clocks synchronised via NTP to within a few seconds of each other** —
if either host's clock drifts by more than ~30 seconds, every internal
request will start failing with `401 timestamp too old`, even with a correct
secret. In `docker-compose.yaml` both services normally share the host's
clock (containers inherit host time by default), so this only becomes a
concern in multi-host production deployments — ensure `chrony`/`ntpd` (or
equivalent) is running and healthy on every host that runs either service.

---

## 🔭 Observability

Orca's own observability is layered:

| Layer           | Tool                          | Purpose                                             |
|-----------------|-------------------------------|-----------------------------------------------------|
| **Developer**   | LangSmith                     | Trace every agent step, compare runs, debug prompts |
| **User-facing** | Frontend + `agent_step` table | View what the agent did for each RCA                |
| **Operational** | structlog with `rca_id`       | Correlate all logs for a single RCA run             |

---

## 📄 License

Internal hackathon project — O11y Team 3 (Orca).
