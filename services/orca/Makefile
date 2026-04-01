# Makefile — Orca + OTel Demo orchestration
#
# Run all targets from the repo root.

# ---------------------------------------------------------------------------
# Docker Compose command — combines Orca stack with OTel demo services.
# The OTel demo .env provides image tags and service port variables.
# The root .env provides Orca-specific secrets (ANTHROPIC_API_KEY, etc.).
#
# Path resolution: when using multiple -f flags, Docker Compose resolves all
# relative paths in every file relative to the FIRST file's directory (repo root).
# This is why demo/docker-compose.yml uses paths like ./demo/opentelemetry-demo/...
# ---------------------------------------------------------------------------
COMPOSE := docker compose \
	--env-file demo/opentelemetry-demo/.env \
	--env-file .env \
	-f docker-compose.yml \
	-f demo/docker-compose.yml

# Compose command for Orca-only (no demo services)
COMPOSE_ORCA := docker compose \
	--env-file .env \
	-f docker-compose.yml

# ---------------------------------------------------------------------------
# Orca services (from docker-compose.yml)
# ---------------------------------------------------------------------------
ORCA_SERVICES := \
	orca-postgres \
	orca-backend \
	orca-frontend

# ---------------------------------------------------------------------------
# OTel Demo services — minimal subset for Orca demo
#   3 fault-injection targets:   ad, cart, product-catalog
#   Feature flags:               flagd, flagd-ui
#   Traffic generation:          load-generator, frontend-proxy, frontend, image-provider
#   Telemetry pipeline:          otel-collector, prometheus, loki, grafana
#   Backing stores:              valkey-cart, postgresql
# ---------------------------------------------------------------------------
DEMO_SERVICES := \
	flagd \
	flagd-ui \
	ad \
	cart \
	product-catalog \
	valkey-cart \
	postgresql \
	frontend \
	frontend-proxy \
	image-provider \
	load-generator \
	otel-collector \
	prometheus \
	loki \
	grafana \
	grafana-provisioner \
	grafana-mcp

ALL_SERVICES := $(ORCA_SERVICES) $(DEMO_SERVICES)

# ---------------------------------------------------------------------------
# Build flag — set BUILD=1 to rebuild images from scratch, e.g.:
#   make up BUILD=1
#   make orca-up BUILD=1
# Defaults to 0 (use existing images).
# ---------------------------------------------------------------------------
BUILD ?= 0
_BUILD_FLAG := $(if $(filter 1,$(BUILD)),--build,)

.PHONY: help init up down restart logs logs-demo logs-all ps clean orca-up orca-down flags-reload

help: ## Show this help message
	@echo ""
	@echo "  Orca Demo — available targets:"
	@echo ""
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | \
		awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-14s\033[0m %s\n", $$1, $$2}'
	@echo ""
	@echo "  Demo services:  $(DEMO_SERVICES)"
	@echo "  Orca services:  $(ORCA_SERVICES)"
	@echo ""

init: ## Initialise the OTel demo submodule (first time only)
	@echo "→ Initialising OTel demo submodule..."
	git submodule update --init --recursive
	@echo "✓ Submodule ready"

up: ## Start the full stack (Orca + OTel demo subset)
	@echo "→ Starting all services: $(ALL_SERVICES)"
	$(COMPOSE) up -d --force-recreate --remove-orphans --build $(ALL_SERVICES)
	@echo ""
	@echo "✓ Stack is up. Endpoints:"
	@echo "   OTel Demo Storefront : http://localhost:8080"
	@echo "   Feature Flag UI      : http://localhost:8080/feature"
	@echo "   Grafana              : http://localhost:3001"
	@echo "   Prometheus           : http://localhost:9090"
	@echo "   Locust (load gen)    : http://localhost:8080/loadgen"
	@echo "   Orca Frontend        : http://localhost:3000"
	@echo "   Orca Backend API     : http://localhost:8000/docs"

down: ## Stop and remove all containers (Orca + demo)
	$(COMPOSE) down

restart: down up ## Restart the full stack

orca-up: ## Start only the Orca stack (no demo services)
	@echo "→ Starting Orca services only..."
	$(COMPOSE_ORCA) up -d --remove-orphans $(_BUILD_FLAG) $(ORCA_SERVICES)
	@echo ""
	@echo "✓ Orca stack is up."
	@echo "   Orca Frontend  : http://localhost:3000"
	@echo "   Orca Backend   : http://localhost:8000/docs"

orca-down: ## Stop only the Orca stack
	$(COMPOSE_ORCA) down

logs: ## Tail Orca service logs
	$(COMPOSE) logs -f $(ORCA_SERVICES)

logs-demo: ## Tail demo service logs
	$(COMPOSE) logs -f $(DEMO_SERVICES)

logs-all: ## Tail all service logs
	$(COMPOSE) logs -f $(ALL_SERVICES)

ps: ## Show running containers and their status
	$(COMPOSE) ps

clean: ## Stop all containers and remove volumes (destroys data)
	$(COMPOSE) down -v
	@echo "✓ Volumes removed"

grafana-key: ## Print the current Grafana API key (provisioned by grafana-provisioner)
	@echo "→ Current Grafana API key:"
	@docker logs grafana-provisioner 2>&1 | grep "GRAFANA_API_KEY=" | tail -1 \
		|| echo "  (grafana-provisioner not found — run 'make up' first)"

grafana-setup: ## Re-provision a fresh Grafana API token (rotate key)
	@echo "→ Re-running grafana-provisioner to rotate the API key..."
	$(COMPOSE) rm -f grafana-provisioner
	$(COMPOSE) up -d --no-deps grafana-provisioner
	@echo "→ Waiting for provisioner to complete..."
	@docker wait grafana-provisioner
	@echo ""
	@$(MAKE) grafana-key

trigger-rca: ## Manually fire a test alert to trigger a new RCA (SERVICE=name ALERT=name)
	@echo "→ Triggering RCA for alert=$(ALERT) service=$(SERVICE)..."
	@python3 scripts/trigger_rca.py --service $(SERVICE) --alert $(ALERT)

flags-reload: ## Apply flag changes — restart flagd then fault-injection services (ad cart product-catalog)
	@# The OpenFeature SDKs in the demo services use in-process evaluation: they
	@# cache all flag values at startup via the flagd gRPC EventStream and then
	@# evaluate entirely locally.  flagd v0.13.3 has a proto serialisation bug in
	@# the v1 EventStream handler that silently drops change notifications, so
	@# services never pick up changes made via the flagd-ui or by editing the JSON
	@# file directly.  This target works around that by:
	@#   1. Restarting flagd — forces all SDK clients to reconnect and re-sync.
	@#   2. Restarting the three fault-injection services — guarantees a fresh sync
	@#      even if a client fails to reconnect on its own.
	@echo "→ Restarting flagd (flushes all EventStream connections)..."
	$(COMPOSE) restart flagd
	@echo "→ Waiting 5s for flagd to be ready..."
	@sleep 5
	@echo "→ Restarting fault-injection services to re-sync flag cache..."
	$(COMPOSE) restart ad cart product-catalog
	@echo ""
	@echo "✓ Done. Services are now evaluating the current flag values."
	@echo "  Manage flags : http://localhost:8080/feature"
	@echo "  Grafana alerts: http://localhost:3001/alerting/list"

