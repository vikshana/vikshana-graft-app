ARCH := $(shell uname -m)

.PHONY: up down restart build build-frontend build-backend logs logs-grafana clean seed help

## Default target — full build + start
up: build
	docker compose up --build --force-recreate --remove-orphans -d

## Stop all containers
down:
	docker compose down

## Rebuild and restart
restart: down up

## Build frontend + backend binary
build: build-frontend build-backend

## Build the React/TypeScript frontend into dist/
build-frontend:
	npm install
	npm run build

## Build the Go backend binary for the correct architecture
build-backend:
ifeq ($(ARCH),arm64)
	mage -v build:linuxARM64
else
	mage -v
endif

## Follow logs for all services
logs:
	docker compose logs -f

## Follow logs for the Grafana plugin container only
logs-grafana:
	docker compose logs -f grafana

## Insert 5 dummy RCA records into the running orca-backend database
seed:
	docker compose exec -T orca-backend python < services/orca/backend/scripts/seed_dummy.py

## Remove built Go binaries from dist/ (forces a fresh backend build)
clean:
	rm -f dist/gpx_*

help:
	@grep -E '^##' Makefile | sed 's/## //'
