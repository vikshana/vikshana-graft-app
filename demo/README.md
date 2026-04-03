# Orca Demo — Walkthrough

This demo runs the Orca RCA stack alongside a **minimal subset** of the [OpenTelemetry Demo](https://github.com/open-telemetry/opentelemetry-demo) application to generate realistic production incidents and automatically investigate them.

---

## Architecture

```
OTel Demo Services (via submodule — minimal subset):
  - Locust (load-generator) → generates continuous traffic
  - Frontend + Frontend-Proxy → web storefront entry point
  - AdService       — fault injection: adFailure, adHighCpu, adManualGc
  - CartService     — fault injection: cartFailure, failedReadinessProbe
  - ProductCatalog  — fault injection: productCatalogFailure
  - Flagd + Flagd UI → feature flag control plane for fault injection
  - OTel Collector → routes telemetry to Prometheus + Loki
  - Prometheus → metrics
  - Loki → logs
  - Grafana → dashboards + alerting (fires webhooks to Orca)

Orca Stack:
  - orca-postgres  → Orca database
  - orca-backend   → FastAPI + LangGraph agent
  - orca-frontend  → Next.js dashboard
```

---

## Prerequisites

- Docker & Docker Compose v2.20+
- 8GB+ RAM
- `ANTHROPIC_API_KEY` set in your `.env`

---

## Setup

### Step 1: Initialise the submodule

```bash
# From the repo root
git submodule update --init --recursive
# Or use the Makefile shortcut:
make init
```

### Step 2: Set up environment variables

```bash
cp .env.example .env
# Edit .env — set ANTHROPIC_API_KEY (and optionally SLACK_WEBHOOK_URL, LANGCHAIN_API_KEY)
```

### Step 3: Start the demo stack

```bash
# From the repo root
make up
```

> **Why `make up`?**
>
> The Makefile combines two compose files — the root `docker-compose.yml` (Orca services)
> and `demo/docker-compose.yml` (OTel demo subset) — and loads both `.env` files.
> Running `docker compose up -d` alone only starts Orca services.

---

## Services

| Service | URL | Purpose |
|---|---|---|
| OTel Demo Storefront | http://localhost:8080 | Web storefront + Feature Flag UI |
| Feature Flag UI | http://localhost:8080/feature | Toggle fault injection scenarios |
| Grafana | http://localhost:3001 | Dashboards + pre-provisioned alert rules |
| Prometheus | http://localhost:9090 | Metrics |
| Locust | http://localhost:8080/loadgen | Load generator UI |
| **Orca Frontend** | **http://localhost:3000** | **RCA Dashboard** |
| Orca Backend | http://localhost:8000/docs | FastAPI + API docs |

---

## Triggering an Incident

### Option 1: Feature Flag UI (recommended)

1. Open http://localhost:8080/feature (Feature Flag section)
2. Enable one of these failure scenarios:
   - **`adFailure`** — Ad service returns errors, causing frontend degradation
   - **`adHighCpu`** — Ad service high CPU load
   - **`cartFailure`** — Cart service fails, blocking cart operations
   - **`productCatalogFailure`** — Product listing errors on a specific product
3. Locust (running automatically) will hit the degraded service
4. Metrics spike → Grafana alert fires → webhook sent to Orca → RCA generated

### Option 2: Direct load via Locust

1. Open http://localhost:8080/loadgen (Locust UI)
2. Adjust the user count to generate higher load
3. Combined with a feature flag, this produces faster metric threshold crossings

---

## Viewing the RCA

1. Open http://localhost:3000 — the Orca dashboard
2. An RCA should appear within seconds of the Grafana alert firing
3. Watch the status progress: `triggered` → `investigating` → `complete`
4. Click the alert name to view the full RCA detail:
   - 11-section markdown report
   - Confidence level with justification
   - Agent step timeline (every query the agent ran)

---

## Grafana Alert Rules

Pre-provisioned rules (in `grafana-provisioning/alerting/alert-rules.yml`):

| Alert | Threshold | Condition |
|---|---|---|
| `HighErrorRate` | Error rate > 5% | 2 minutes |
| `HighLatency` | P95 latency > 1s | 2 minutes |
| `CartServiceDown` | Service unreachable | 1 minute |

All alerts are routed to Orca via the pre-provisioned `orca-webhook` contact point and notification policy (see `grafana-provisioning/contact-points/orca-webhook.yml`).

---

## Makefile Targets

Run all targets from the **repo root**:

| Target | Description |
|---|---|
| `make up` | Start the full stack (Orca + OTel demo subset) |
| `make down` | Stop and remove all containers |
| `make restart` | Restart the full stack |
| `make orca-up` | Start only Orca services (no demo) |
| `make orca-down` | Stop only Orca services |
| `make logs` | Tail Orca service logs |
| `make logs-demo` | Tail demo service logs |
| `make logs-all` | Tail all service logs |
| `make ps` | Show running containers |
| `make clean` | Stop all and remove volumes (destroys data) |
| `make init` | Initialise the OTel demo git submodule |

---

## Resetting the Demo

```bash
# Stop all services
make down

# Remove all data (Postgres volumes)
make clean

# Restart fresh
make up
```

---

## Updating the OTel demo version

The submodule is pinned to a specific commit. To update:

```bash
cd demo/opentelemetry-demo
git fetch origin
git checkout <new-tag-or-commit>  # e.g. v1.12.0
cd ../..
git add demo/opentelemetry-demo
git commit -m "chore(demo): bump opentelemetry-demo to v1.12.0"
```

Test locally before committing — service names and ports occasionally change between releases.

---

## Troubleshooting

**Orca backend not receiving webhooks?**
- Check that Grafana's contact point is configured correctly (provisioned automatically)
- Verify `orca-backend` container is healthy: `docker logs orca-backend`
- Confirm the alert rule is in a FIRING state in Grafana

**Agent not producing RCAs?**
- Check `ANTHROPIC_API_KEY` is set correctly in `.env`
- View agent logs: `docker logs orca-backend`
- Check the RCA record status in the Orca frontend — `failed` status includes an error message

**OTel demo services not starting?**
- Ensure submodule is initialised: `make init`
- Check Docker has sufficient memory allocated (8GB+)

**Some storefront features are broken?**
- This is expected — we run only 3 of the ~15 OTel demo microservices. Features
  like checkout, recommendations, and shipping will show errors. The 3 fault-injection
  targets (ad, cart, product-catalog) and basic browsing work correctly.
