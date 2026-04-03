# Architecture — Container & Service Map

## Stack Overview

The full system spans three Docker Compose stacks connected via a shared `graft-orca` Docker network.

| Stack | Started by | Purpose |
|-------|-----------|---------|
| **① Graft Dev** | `npm run server` | Grafana with the Graft plugin loaded for UI development |
| **② Orca** | `cd services/orca && make orca-up` | RCA backend + database |
| **③ Demo** | `cd services/orca && make up` | OTel demo services that generate real alerts to drive Orca |

---

## Service Map

```mermaid
flowchart LR
    classDef graftNode fill:#1a2f5e,stroke:#4a7fd4,color:#fff
    classDef orcaNode fill:#4a2000,stroke:#d4770a,color:#fff
    classDef demoNode fill:#1a3d1a,stroke:#4aaa4a,color:#fff
    classDef conflictNode fill:#5c0a0a,stroke:#ff5555,color:#fff,stroke-width:2px
    classDef storeNode fill:#2a2a2a,stroke:#777,color:#ccc

    subgraph GRAFT["① Graft Dev Stack — npm run server"]
        GRAFANA_GRAFT["vikshana-graft-app\nGrafana + Graft plugin\n:3000"]
        OTEL_LGTM["otel-lgtm\nGrafana :3001\nLoki :3100\nPrometheus :9090\nOTLP :4317 / :4318\nTempo :3200"]
        ALLOY["alloy\n:12345"]
    end

    subgraph ORCA["② Orca Stack — make orca-up"]
        ORCA_FE["orca-frontend\n⚠️ :3000\n(decommissioning — make frontend-up only)"]
        ORCA_BE["orca-backend\n:8000\n[graft-orca network]"]
        ORCA_PG[("orca-postgres\n:5432")]
    end

    subgraph DEMO["③ Demo Stack — make up (adds to Orca stack)"]

        subgraph FAULT["Fault Injection Targets"]
            AD["ad — Java\nadFailure · adHighCpu · adManualGc"]
            CART["cart — .NET\ncartFailure"]
            PC["product-catalog — Go\nproductCatalogFailure"]
        end

        subgraph FLAGS["Feature Flags"]
            FLAGD["flagd\n:8013"]
            FLAGD_UI["flagd-ui\n:4000"]
        end

        subgraph TRAFFIC["Traffic Generation"]
            LOCUST["load-generator\nLocust · :8089"]
            FP["frontend-proxy\nEnvoy · :8080"]
            DEMO_FE["demo-frontend"]
        end

        subgraph TELEM["Telemetry Pipeline"]
            COLLECTOR["otel-collector\n(internal only)"]
            PROM["prometheus\n:9091"]
            LOKI["loki\n(internal only)"]
        end

        subgraph INTEGRATION["Grafana · Alerting · MCP"]
            DEMO_GRAFANA["grafana — demo\n:3002"]
            GRA_PROV["grafana-provisioner\none-shot · creates API key"]
            GRA_MCP["grafana-mcp\nSSE server · internal :8000"]
        end

        subgraph STORES["Backing Stores"]
            VALKEY[("valkey-cart")]
            DEMO_PG[("demo-postgresql")]
        end

    end

    %% ── Graft dev internal ──────────────────────────────────────────────────
    ALLOY         -->|"container logs"| OTEL_LGTM
    GRAFANA_GRAFT -->|"OTLP :4317"| OTEL_LGTM

    %% ── Traffic flow ────────────────────────────────────────────────────────
    LOCUST  -->|"HTTP"| FP
    FP      -->|"proxy"| DEMO_FE
    DEMO_FE -->|"gRPC"| AD
    DEMO_FE -->|"gRPC"| CART
    DEMO_FE -->|"gRPC"| PC

    %% ── Feature flag evaluation ─────────────────────────────────────────────
    AD   -. "OpenFeature SDK" .-> FLAGD
    CART -. "OpenFeature SDK" .-> FLAGD
    PC   -. "OpenFeature SDK" .-> FLAGD

    %% ── Telemetry ───────────────────────────────────────────────────────────
    AD      -->|"OTLP traces + metrics + logs"| COLLECTOR
    CART    -->|"OTLP traces + metrics + logs"| COLLECTOR
    PC      -->|"OTLP traces + metrics + logs"| COLLECTOR
    DEMO_FE -->|"OTLP"| COLLECTOR
    COLLECTOR -->|"spanmetrics → OTLP push"| PROM
    COLLECTOR -->|"OTLP logs"| LOKI

    %% ── Backing stores ──────────────────────────────────────────────────────
    CART -->|"cache"| VALKEY
    PC   -->|"reads"| DEMO_PG

    %% ── Alerting → Orca ─────────────────────────────────────────────────────
    PROM         -->|"PromQL queries"| DEMO_GRAFANA
    LOKI         -->|"LogQL queries"| DEMO_GRAFANA
    GRA_PROV     -->|"POST service account + API key"| DEMO_GRAFANA
    DEMO_GRAFANA -->|"POST /webhook/grafana\n(alert fires)"| ORCA_BE

    %% ── Orca internal ───────────────────────────────────────────────────────
    ORCA_BE -->|"R/W alerts · rcas · steps"| ORCA_PG
    ORCA_BE -->|"MCP SSE — read tools"| GRA_MCP
    GRA_MCP -->|"Grafana HTTP API"| DEMO_GRAFANA
    ORCA_FE -->|"REST /api/rca"| ORCA_BE

    %% ── Cross-stack (graft-orca shared network) ────────────────────────────
    GRAFANA_GRAFT -->|"RCA proxy → http://orca-backend:8000\n(graft-orca network)"| ORCA_BE

    %% ── Styling ─────────────────────────────────────────────────────────────
    class GRAFANA_GRAFT graftNode
    class ALLOY graftNode
    class OTEL_LGTM graftNode
    class ORCA_FE conflictNode
    class ORCA_BE orcaNode
    class ORCA_PG storeNode
    class AD,CART,PC,FLAGD,FLAGD_UI,LOCUST,FP,DEMO_FE,COLLECTOR,PROM,LOKI,DEMO_GRAFANA,GRA_PROV,GRA_MCP demoNode
    class VALKEY,DEMO_PG storeNode
```

---

## Port Allocation

All previous host-port conflicts between the Graft dev stack and the Orca+Demo stack have been resolved.

| Port | Container | Stack |
|------|-----------|-------|
| **3000** | `vikshana-graft-app` (Grafana + Graft plugin) | ① Graft dev |
| **3001** | `otel-lgtm` (Grafana) | ① Graft dev |
| **3002** | `grafana` (demo alerts + dashboards) | ③ Demo |
| **3100** | `otel-lgtm` (Loki) | ① Graft dev |
| **3200** | `otel-lgtm` (Tempo) | ① Graft dev |
| **4317/4318** | `otel-lgtm` (OTLP) | ① Graft dev |
| **5432** | `orca-postgres` | ② Orca |
| **8000** | `orca-backend` | ② Orca |
| **8080** | `frontend-proxy` (Envoy) | ③ Demo |
| **9090** | `otel-lgtm` (Prometheus) | ① Graft dev |
| **9091** | `prometheus` | ③ Demo |
| **12345** | `alloy` | ① Graft dev |

> `loki` and `otel-collector` in the demo stack have no host port binding — they are accessed only via Docker networking by other demo containers.

---

## Use Case Quick Reference

| Goal | Command | Notes |
|------|---------|-------|
| Graft UI development only | `npm run server` | Stack ① only |
| Graft + pre-seeded RCA data | `cd services/orca && make orca-up` then `npm run server` | Stacks ① + ② |
| Orca RCA pipeline (alert → investigation → report) | `cd services/orca && make up` | Stacks ② + ③ — `make init` required first time |
| **Full E2E: Graft displaying live Orca RCAs** | `cd services/orca && make up` then `npm run server` | All stacks — `graft-orca` network created automatically by both commands |
| Legacy Orca frontend | `cd services/orca && make frontend-up` | Deprecated — use Graft plugin UI instead |

---

## Known Gaps

1. **`orca-frontend` port collision** — Orca's Next.js dashboard (`make frontend-up`) still uses `:3000`, which clashes with Graft's Grafana if both are started simultaneously. `orca-frontend` is being decommissioned in favour of the Graft plugin UI and is excluded from `make up` / `make orca-up`.
