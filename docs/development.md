# Development Guide

## Prerequisites

- Node.js 18+
- Go 1.21+
- Mage build tool
- Docker (for local Grafana instance)

## Building

```bash
# Install frontend dependencies
npm install

# Build frontend
npm run build

# Build backend (all platforms)
mage -v

# For Apple Silicon development
mage build:linuxARM64
```

## Running Locally

### Frontend Only (Watch Mode)

```bash
# Start Grafana with the plugin
npm run server

# Frontend in watch mode (separate terminal)
npm run dev
```

### Full Stack with Docker Compose

For development with backend changes (especially on Apple Silicon):

```bash
# 1. Clean previous backend binaries
rm -v ./dist/gpx_*

# 2. Build backend for Linux ARM64 (required for Docker on Apple Silicon)
mage -v build:linuxARM64

# 3. Start Grafana with Docker Compose
docker compose up --build --force-recreate --remove-orphans
```

Or as a single command:

```bash
rm -v ./dist/gpx_* && mage -v build:linuxARM64 && docker compose up --build --force-recreate --remove-orphans
```

> **Note**: Use `build:linux` instead of `build:linuxARM64` on Intel/AMD systems.

## Testing

```bash
# Unit tests
npm run test:ci

# E2E tests (requires running Grafana)
npm run e2e

# Backend tests
go test ./pkg/...

# Type checking and linting
npm run typecheck && npm run lint
```
