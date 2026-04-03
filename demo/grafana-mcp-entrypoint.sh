#!/bin/sh
# Entrypoint for the grafana-mcp sidecar container.
#
# Resolves GRAFANA_API_KEY in order of preference:
#   1. GRAFANA_API_KEY env var (set explicitly in docker-compose or .env)
#   2. /run/orca/GRAFANA_API_KEY file written by grafana-provisioner
#   3. Not set — Grafana anonymous Admin access handles auth (demo only)
set -e

if [ -z "$GRAFANA_API_KEY" ] && [ -f "/run/orca/GRAFANA_API_KEY" ]; then
    GRAFANA_API_KEY=$(cat /run/orca/GRAFANA_API_KEY)
    export GRAFANA_API_KEY
    echo "[grafana-mcp] Loaded GRAFANA_API_KEY from shared volume" >&2
fi

if [ -z "$GRAFANA_API_KEY" ]; then
    echo "[grafana-mcp] GRAFANA_API_KEY not set — relying on Grafana anonymous auth" >&2
fi

exec mcp-grafana "$@"

