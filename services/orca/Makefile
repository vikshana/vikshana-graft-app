# Makefile — Orca backend development helpers.
#
# The full development stack (Grafana + observability + test-app + Orca)
# is managed from the repo root via `npm run server` (docker compose).
# Use targets here for Orca-specific tasks and testing.

.PHONY: help up down logs ps clean trigger-rca

help: ## Show this help message
	@echo ""
	@echo "  Orca — available targets:"
	@echo ""
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | \
		awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-14s\033[0m %s\n", $$1, $$2}'
	@echo ""
	@echo "  Full stack: run 'npm run server' from the repo root"
	@echo ""

up: ## Start only Orca (postgres + backend) — no Grafana or test app
	docker compose up -d --remove-orphans --build orca-postgres orca-backend
	@echo ""
	@echo "✓ Orca stack is up."
	@echo "   Orca Backend   : http://localhost:8000/docs"

down: ## Stop Orca services
	docker compose down

logs: ## Tail orca-backend logs
	docker compose logs -f orca-backend

ps: ## Show running containers
	docker compose ps

clean: ## Stop containers and remove volumes (destroys DB data)
	docker compose down -v
	@echo "✓ Volumes removed"

trigger-rca: ## Manually fire a test alert (SERVICE=name ALERT=name)
	@echo "→ Triggering RCA for alert=$(ALERT) service=$(SERVICE)..."
	@python3 scripts/trigger_rca.py --service $(SERVICE) --alert $(ALERT)
