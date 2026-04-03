# CLAUDE.md — Project Instructions for Claude Code

This file provides project-specific context for Claude Code when working on the Orca codebase.

---

## Project Overview

Orca (Omniscient Root Cause Analyser) is an agentic RCA system that:

1. Receives Grafana alert webhooks
2. Spawns a LangGraph agent per alert
3. Agent queries Grafana + Postgres via MCP to investigate
4. Produces a structured 11-section RCA markdown report with confidence level
5. Stores results in Postgres and notifies Slack

---

## Tech Stack

- **Backend**: Python 3.12+ / FastAPI / LangGraph / LangChain / SQLAlchemy (async) / structlog
- **Frontend**: TypeScript / Next.js 14+ / React
- **Database**: PostgreSQL
- **LLM**: Anthropic Claude (Haiku for triage, Sonnet for investigation/analysis/reporting)
- **MCP Servers**: `grafana/mcp-grafana` (read-only tools), `modelcontextprotocol/server-postgres`
- **Observability**: LangSmith (agent tracing), structlog (operational logs)

---

## Directory Layout

```
backend/
├── app/
│   ├── main.py              # FastAPI app entrypoint with lifespan
│   ├── config.py            # pydantic-settings — all config from env vars
│   ├── db.py                # Async SQLAlchemy engine + session factory
│   ├── logging.py           # structlog configuration
│   ├── api/                 # FastAPI route handlers
│   │   ├── webhooks.py      # POST /webhook/grafana
│   │   └── rca.py           # GET /api/rca, GET /api/rca/{id}
│   ├── models/              # SQLAlchemy ORM models
│   │   ├── alert.py         # Alert table
│   │   ├── rca.py           # RCA table
│   │   └── agent_step.py    # AgentStep table
│   ├── schemas/             # Pydantic request/response schemas (NOT ORM models)
│   │   ├── webhook.py       # Grafana webhook payload validation
│   │   └── rca.py           # RCA API response shapes
│   ├── agent/               # LangGraph agent
│   │   ├── graph.py         # StateGraph definition + edges
│   │   ├── state.py         # OrcaState TypedDict
│   │   ├── mcp/             # MCP client configurations (agent data sources)
│   │   │   ├── grafana_client.py
│   │   │   └── postgres_client.py
│   │   ├── nodes/           # One file per graph node
│   │   │   ├── triage.py
│   │   │   ├── investigate.py
│   │   │   ├── analyze.py
│   │   │   ├── report.py
│   │   │   └── publish.py
│   │   └── prompts/         # System prompts (markdown files)
│   │       ├── triage.md
│   │       ├── investigate.md
│   │       ├── analyze.md
│   │       └── report.md
│   └── integrations/        # Outbound publish/notify integrations
│       └── slack.py
├── tests/
│   ├── conftest.py
│   ├── unit/
│   └── integration/
└── pyproject.toml

frontend/
└── src/
    ├── app/                  # Next.js App Router pages
    │   ├── page.tsx          # Dashboard
    │   └── rca/[id]/page.tsx # RCA detail
    ├── components/           # React components
    ├── lib/                  # API client + utilities
    └── types/                # TypeScript type definitions

docker-compose.yml                  # Orca stack (orca-postgres, orca-backend, orca-frontend)
Makefile                            # Orchestrates Orca + demo (make up / make down)
.env.example

../../demo/                         # OTel demo stack (at repo root)
├── docker-compose.yml              # Standalone OTel demo subset (minimal)
├── otel-collector-config.yml       # Simplified collector config (Prometheus + Loki)
├── opentelemetry-demo/             # Cloned by make init (v2.2.0)
├── README.md                       # Demo walkthrough
└── grafana-provisioning/
    ├── alerting/
    │   └── alert-rules.yml
    ├── contact-points/
    │   └── orca-webhook.yml
    └── datasources/
        └── datasources.yml
```

---

## Key Commands

```bash
# --- Backend ---

# Install dependencies (from backend/)
pip install -e ".[dev]"

# Start the backend (dev mode)
uvicorn app.main:app --reload --port 8000

# Run all tests
pytest tests/ -v

# Run unit tests only
pytest tests/unit/ -v

# Run integration tests only (requires running Postgres)
pytest tests/integration/ -v

# Run tests with coverage
pytest --cov=app tests/

# Type checking
mypy app/

# Database tables are auto-created on startup via SQLAlchemy create_all() in main.py lifespan

# --- Frontend ---

# Install dependencies (from frontend/)
npm install

# Start dev server
npm run dev

# Type checking
npx tsc --noEmit

# --- Docker (from repo root) ---

# Start Orca stack only (Postgres + backend + frontend)
docker compose up -d

# Start full demo stack (Orca + OTel demo subset)
make up

# Stop full demo stack
make down

# Start only Orca services (when demo is also configured)
make orca-up

# View all available Makefile targets
make help

# Clone the OTel demo into demo/opentelemetry-demo/ (first time only)
make init
```

---

## Coding Conventions

### Python (Backend)

1. **Type hints on everything** — all function parameters, return types, and variables where not obvious. Use `mypy --strict` compatibility as the target.

   ```python
   # ✅ Good
   async def get_rca_by_id(rca_id: uuid.UUID, session: AsyncSession) -> RCA | None:
       ...

   # ❌ Bad
   async def get_rca_by_id(rca_id, session):
       ...
   ```

2. **Pydantic for all data boundaries** — API request/response schemas in `schemas/`, config in `config.py`. Never pass raw dicts across module boundaries.

3. **SQLAlchemy models vs Pydantic schemas** — `models/` contains ORM models (table definitions). `schemas/` contains Pydantic models (API contracts). They are separate concerns.

4. **Async everywhere** — All database operations use `AsyncSession`. All HTTP calls use `httpx.AsyncClient`. All agent execution is async.

5. **structlog for logging** — Never use `print()` or `logging.getLogger()`. Always use `structlog.get_logger()` and bind `rca_id` in agent contexts.

   ```python
   import structlog
   logger = structlog.get_logger()

   log = logger.bind(rca_id=str(rca_id))
   log.info("triage_complete", severity="critical", service="checkout-service")
   ```

6. **No `Any` type** — Use specific types. If the type is truly dynamic (e.g., raw JSON from Grafana), use `dict[str, Any]` with a comment explaining why.

7. **Docstrings on public functions** — Use Google-style docstrings.

   ```python
   async def run_triage(state: OrcaState) -> OrcaState:
       """Validate alert labels and classify severity.

       Args:
           state: Current agent state with alert_payload populated.

       Returns:
           Updated state with severity and validation results.

       Raises:
           InvalidAlertError: If required labels are missing.
       """
   ```

8. **Error handling** — Define custom exceptions in a shared module. Never swallow exceptions silently. Always log errors with context.

9. **Import ordering** — stdlib → third-party → local, separated by blank lines. Use absolute imports from `app.`.

### TypeScript (Frontend)

1. **Strict TypeScript** — `strict: true` in tsconfig. No `any` types.
2. **Types mirror backend schemas** — `types/rca.ts` should match `schemas/rca.py` shapes.
3. **Server components by default** — Use client components (`"use client"`) only when needed (interactivity, hooks).

---

## Environment Variables

All config is read from environment variables via `pydantic-settings` in `app/config.py`:

```bash
# Database
DATABASE_URL=postgresql+asyncpg://orca:orca@localhost:5432/orca

# Anthropic
ANTHROPIC_API_KEY=sk-ant-...

# LangSmith (optional but recommended)
LANGCHAIN_TRACING_V2=true
LANGCHAIN_API_KEY=ls-...
LANGCHAIN_PROJECT=orca-dev

# Slack (optional)
SLACK_WEBHOOK_URL=https://hooks.slack.com/services/...

# Grafana MCP
GRAFANA_URL=http://localhost:3002
GRAFANA_API_KEY=glsa_...

# Agent tuning
ORCA_MAX_INVESTIGATION_STEPS=15
ORCA_MAX_INVESTIGATION_TOKENS=100000
ORCA_AGENT_TIMEOUT_SECONDS=300

# Frontend
NEXT_PUBLIC_API_URL=http://localhost:8000
```

---

## Database

- PostgreSQL with async driver (`asyncpg`)
- Tables auto-created on startup via `SQLAlchemy metadata.create_all()` in `main.py` lifespan
- Three main tables: `alerts`, `rcas`, `agent_steps`
- Label fields are denormalised onto `alerts` and `rcas` for fast filtering
- `alert_name` uses GIN trigram index for free-text `ILIKE` search
- `rcas` table includes `confidence_level` (high/medium/low) and `confidence_reasoning` columns
- Always use `AsyncSession` from `app.db` — never create engines directly

---

## Testing

- **Framework**: pytest + pytest-asyncio
- **Fixtures**: Defined in `tests/conftest.py` — includes test database, async HTTP client, mock MCP servers
- **Unit tests**: One file per module in `tests/unit/`. Mock external dependencies (MCP, DB, LLM).
- **Integration tests**: In `tests/integration/`. Use a real test Postgres database. Mark slow tests with `@pytest.mark.slow`.
- **Every public function must have a test**. Every API endpoint must have an integration test.

---

## Common Pitfalls

1. **MCP tool filtering is at the LangGraph binding level**, not the MCP server config. When binding Grafana MCP tools to the investigate node, explicitly allow-list only read tools. Don't rely on the MCP server to restrict itself.

2. **`agent_step` must be written in every node** — this is how the frontend shows what the agent did. If a node doesn't log steps, the user sees a gap.

3. **The Postgres MCP server connects to Orca's own database** — the agent queries its own `alerts` and `rcas` tables for historical context. Make sure the connection string points to the right DB.

4. **Grafana webhook payloads can contain multiple alerts** — the `alerts` field in the payload is an array. Each alert should be processed individually.

5. **Always bind `rca_id` to structlog** before any agent operations — this is the correlation key for debugging.

