# Infrastructure Simplification Plan

Consolidate from a three-stack architecture (Graft Dev + Orca + OTel Demo) into a single Docker Compose stack with one Grafana instance, individual observability backends, and a simple test app for RCA testing.

## Phase 1: Observability Backend Configs ✅

- [x] Create `config/loki.yaml` — Loki 3.4.3, local filesystem, auth disabled, OTLP endpoint enabled
- [x] Create `config/tempo.yaml` — Tempo, local filesystem, OTLP receivers, metrics generator → Mimir
- [x] Create `config/mimir.yaml` — Mimir single-binary, local filesystem, multitenancy disabled
- [x] Create `config/otel-collector.yaml` — routes traces → Tempo, metrics → Mimir, logs → Loki

## Phase 2: Docker Compose Consolidation ✅

- [x] Modify `.config/docker-compose-base.yaml` — remove `otel-lgtm`, `alloy`, `graft-orca` network; update Grafana OTLP endpoint to `otel-collector:4317`
- [x] Rewrite `docker-compose.yaml` — single flat file with all services (grafana, loki, tempo, mimir, otel-collector, orca-postgres, mcp-grafana, mcp-postgres, orca-backend, test-app); remove `graft-orca` external network
- [x] Delete `provisioning/alloy-config.alloy`
- [x] Rename `provisioning/datasources/otel-lgtm.yaml` → `datasources.yaml`; repoint Prometheus → Mimir (`http://mimir:9009/prometheus`), Loki → `http://loki:3100`, Tempo → `http://tempo:3200`; update all UIDs to `mimir`/`loki`/`tempo`

## Phase 3: Test Application ✅

- [x] Create `services/test-app/` — single container (FastAPI backend + React frontend)
  - [x] `Dockerfile` — multi-stage: Node build for React → Python 3.12 with OTel auto-instrumentation
  - [x] `pyproject.toml` — fastapi, uvicorn, opentelemetry-instrumentation-fastapi, opentelemetry-exporter-otlp
  - [x] `app/main.py` — FastAPI app with CORS, serves static React files
  - [x] `app/routes/api.py` — GET /api/orders, /api/products, /api/users, /api/health
  - [x] `app/routes/chaos.py` — POST /api/chaos/enable?type=error|latency|exception, POST /api/chaos/disable, GET /api/chaos/status
  - [x] `app/chaos.py` — in-memory chaos state
  - [x] `frontend/` — Vite React app with API status panel and chaos engineering panel

## Phase 4: Alert Rules & Contact Points ✅

- [x] Create `provisioning/alerting/alert-rules.yml` — TestAppHighErrorRate, TestAppHighLatency, TestAppDown; datasourceUid `mimir`
- [x] Create `provisioning/alerting/contact-points.yml` — webhook to `http://orca-backend:8000/webhook/grafana`

## Phase 5: Cleanup ✅

- [x] Delete `demo/` directory entirely
- [x] Delete `services/orca/frontend/` directory entirely
- [x] Simplify `services/orca/Makefile` — remove demo targets (init, flags-reload, grafana-key, grafana-setup, frontend-up, logs-demo)
- [x] Update `services/orca/docker-compose.yml` — remove `orca-frontend`, remove `graft-orca` external network
- [x] Update `services/orca/backend/app/config.py` — change `GRAFANA_URL` default to `http://localhost:3000`
- [x] Update `services/orca/.env.example` — change `GRAFANA_URL` to `http://localhost:3000`
- [x] Update `pkg/plugin/otel.go` — change fallback endpoint to `otel-collector:4317`
- [x] Update `package.json` `server` script — remove `docker network create graft-orca` prefix
- [x] Update `.gitignore` — remove `demo/opentelemetry-demo/` entry
- [x] Rewrite `ARCHITECTURE.md` — single stack, new port table, updated service map
- [x] Update `services/orca/CLAUDE.md` — remove demo references

## Port Allocation (New)

| Port | Container      | Purpose                |
|------|----------------|------------------------|
| 3000 | grafana        | Grafana + Graft plugin |
| 4317 | otel-collector | OTLP gRPC              |
| 4318 | otel-collector | OTLP HTTP              |
| 5432 | orca-postgres  | PostgreSQL             |
| 8001 | orca-backend   | Orca RCA API           |
| 8080 | test-app       | Test app (API + UI)    |

Internal only (no host port): loki (3100), tempo (3200), mimir (9009), mcp-grafana, mcp-postgres

## Verification Checklist

- [x] `docker compose up --build` — all services start cleanly
- [x] Grafana datasources provisioned: Mimir, Loki, Tempo
- [x] Test app at `http://localhost:8080` — UI loads, API endpoints respond
- [ ] Mimir has metrics: `http_server_request_duration_seconds_count{service_name="test-app"}`
- [ ] Loki has logs: `{service_name="test-app"}`
- [ ] Tempo has traces for `test-app`
- [ ] Enable error chaos → alert fires in Grafana alerting within 2 minutes
- [ ] Orca receives webhook → RCA spawned (`GET http://localhost:8001/api/rca`)
