#!/bin/sh
# wait-for-plugin-reload.sh
#
# Polls Grafana until the plugin's served module.js has changed — confirming
# that Grafana has picked up the latest dist/ build before the agent navigates
# the browser. This prevents verifying a stale bundle after a rebuild.
#
# Usage: sh scripts/wait-for-plugin-reload.sh [timeout_seconds]
#
# Arguments:
#   timeout_seconds — how long to wait (default: 60)
#
# How it works:
#   1. Captures the current ETag / Last-Modified of the plugin's module.js.
#   2. Waits for it to change (meaning Grafana served the new build).
#   3. Exits 0 when changed, 1 on timeout.
#
# Note: Grafana hot-reloads plugins when it detects changes to the mounted
# dist/ directory. This typically takes 2–10 seconds after webpack finishes.
# If using 'npm run dev' (watch), the rebuild completes before this script
# needs to be called — but the script still validates the bundle is fresh.

set -e

GRAFANA_URL="${GRAFANA_URL:-http://localhost:3000}"
PLUGIN_ID="vikshana-graft-app"
MODULE_URL="${GRAFANA_URL}/public/plugins/${PLUGIN_ID}/module.js"
TIMEOUT="${1:-60}"
POLL_INTERVAL=2

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

echo ""
echo "=== Waiting for plugin reload ==="
echo "Polling: ${MODULE_URL}"
echo "Timeout: ${TIMEOUT}s"
echo ""

# ── Capture the current asset fingerprint ─────────────────────────────────────
get_fingerprint() {
  # Use ETag + Last-Modified + Content-Length as a combined fingerprint.
  # curl -I fetches headers only without downloading the full bundle.
  curl -s -I --max-time 5 "${MODULE_URL}" 2>/dev/null | \
    grep -iE "^(etag|last-modified|content-length):" | \
    tr '[:upper:]' '[:lower:]' | \
    sort
}

# ── Wait for Grafana to be responsive first ────────────────────────────────────
printf "Checking Grafana is reachable... "
HTTP_STATUS=$(curl -s -o /dev/null -w "%{http_code}" --max-time 5 \
  "${GRAFANA_URL}/api/health" 2>/dev/null || echo "000")
if [ "${HTTP_STATUS}" != "200" ]; then
  printf "${RED}FAIL${NC}\n"
  echo "Grafana is not reachable at ${GRAFANA_URL} (status: ${HTTP_STATUS})"
  echo "Start it with: npm run server"
  exit 1
fi
printf "${GREEN}OK${NC}\n"

# ── Capture baseline fingerprint ──────────────────────────────────────────────
BASELINE=$(get_fingerprint)
if [ -z "${BASELINE}" ]; then
  echo ""
  printf "${YELLOW}[WARN]${NC} Could not read module.js headers — plugin may not be loaded yet.\n"
  echo "Checking if dist/module.js exists locally..."
  if [ ! -f "dist/module.js" ]; then
    echo "dist/module.js not found. Run 'npm run build' first."
    exit 1
  fi
  echo "dist/module.js found locally. Grafana may still be starting — waiting..."
fi

echo "Baseline fingerprint captured. Waiting for change..."
echo "(If you have not rebuilt yet, run 'npm run build' in another terminal now.)"
echo ""

# ── Poll for change ────────────────────────────────────────────────────────────
ELAPSED=0
while [ "${ELAPSED}" -lt "${TIMEOUT}" ]; do
  CURRENT=$(get_fingerprint)

  if [ -n "${CURRENT}" ] && [ "${CURRENT}" != "${BASELINE}" ]; then
    printf "${GREEN}[OK]${NC} Plugin module.js has changed — Grafana is serving the new build.\n"
    echo ""
    echo "Fingerprint before: $(echo "${BASELINE}" | tr '\n' ' ')"
    echo "Fingerprint after:  $(echo "${CURRENT}" | tr '\n' ' ')"
    echo ""
    echo "Safe to navigate the browser now."
    exit 0
  fi

  # Also check if the baseline was empty and Grafana now serves the file
  if [ -z "${BASELINE}" ] && [ -n "${CURRENT}" ]; then
    printf "${GREEN}[OK]${NC} Plugin module.js is now available.\n"
    exit 0
  fi

  printf "."
  sleep "${POLL_INTERVAL}"
  ELAPSED=$((ELAPSED + POLL_INTERVAL))
done

echo ""
printf "${RED}[TIMEOUT]${NC} Plugin did not reload within ${TIMEOUT}s.\n"
echo ""
echo "Possible causes:"
echo "  - The build has not completed yet (check 'npm run dev' / 'npm run build' output)"
echo "  - Grafana did not detect the dist/ change (try restarting: npm run server)"
echo "  - The module URL is wrong: ${MODULE_URL}"
echo ""
echo "You can proceed manually, but you may be testing a stale bundle."
exit 1
