#!/bin/sh
# verify-ui-precheck.sh
#
# Confirms all prerequisites for the agentic UI verification workflow are met.
# Run this before starting a browser-driven verification session.
#
# Usage: sh scripts/verify-ui-precheck.sh
#
# Exit codes:
#   0 — all checks passed (LLM may still need config — see output)
#   1 — a blocking prerequisite is missing

set -e

GRAFANA_URL="${GRAFANA_URL:-http://localhost:3000}"
PLUGIN_ID="vikshana-graft-app"
PLUGIN_APP_PATH="/a/${PLUGIN_ID}"
RED='\033[0;31m'
YELLOW='\033[1;33m'
GREEN='\033[0;32m'
NC='\033[0m' # No colour

pass() { printf "${GREEN}[OK]${NC}  %s\n" "$1"; }
warn() { printf "${YELLOW}[WARN]${NC} %s\n" "$1"; }
fail() { printf "${RED}[FAIL]${NC} %s\n" "$1"; }

ERRORS=0

echo ""
echo "=== Graft UI Verification Pre-check ==="
echo "Grafana URL: ${GRAFANA_URL}"
echo ""

# ── 1. dist/ exists ────────────────────────────────────────────────────────────
printf "Checking dist/ directory... "
if [ -d "dist" ] && [ -f "dist/module.js" ]; then
  pass "dist/module.js exists"
else
  fail "dist/module.js not found — run 'npm run build' or 'npm run dev' first"
  ERRORS=$((ERRORS + 1))
fi

# ── 2. Grafana reachable ───────────────────────────────────────────────────────
printf "Checking Grafana at %s... " "${GRAFANA_URL}"
HTTP_STATUS=$(curl -s -o /dev/null -w "%{http_code}" --max-time 5 "${GRAFANA_URL}/api/health" 2>/dev/null || echo "000")
if [ "${HTTP_STATUS}" = "200" ]; then
  pass "Grafana is running (HTTP 200)"
else
  fail "Grafana not reachable at ${GRAFANA_URL}/api/health (status: ${HTTP_STATUS})"
  echo "      Run: npm run server"
  echo "      Wait ~15s for the container to start, then re-run this script."
  ERRORS=$((ERRORS + 1))
fi

# ── 3. Plugin app route loads ──────────────────────────────────────────────────
if [ "${HTTP_STATUS}" = "200" ]; then
  printf "Checking plugin app route... "
  PLUGIN_STATUS=$(curl -s -o /dev/null -w "%{http_code}" --max-time 5 \
    "${GRAFANA_URL}${PLUGIN_APP_PATH}" 2>/dev/null || echo "000")
  if [ "${PLUGIN_STATUS}" = "200" ] || [ "${PLUGIN_STATUS}" = "302" ]; then
    pass "Plugin route ${PLUGIN_APP_PATH} responds (HTTP ${PLUGIN_STATUS})"
  else
    fail "Plugin route ${PLUGIN_APP_PATH} returned HTTP ${PLUGIN_STATUS}"
    echo "      The plugin may not be loaded. Check: docker logs ${PLUGIN_ID}"
    ERRORS=$((ERRORS + 1))
  fi
fi

# ── 4. grafana-llm-app health ─────────────────────────────────────────────────
if [ "${HTTP_STATUS}" = "200" ]; then
  printf "Checking grafana-llm-app health... "
  LLM_BODY=$(curl -s --max-time 5 "${GRAFANA_URL}/api/plugins/grafana-llm-app/health" 2>/dev/null || echo "")
  LLM_STATUS=$(curl -s -o /dev/null -w "%{http_code}" --max-time 5 \
    "${GRAFANA_URL}/api/plugins/grafana-llm-app/health" 2>/dev/null || echo "000")

  if [ "${LLM_STATUS}" = "000" ] || [ -z "${LLM_BODY}" ]; then
    warn "LLM plugin health endpoint not reachable"
    echo "      The grafana-llm-app may still be installing (wait ~30s on first start)."
  else
    # Check if llmProvider.ok is true in the JSON response
    LLM_OK=$(echo "${LLM_BODY}" | grep -o '"ok":true' | head -1 || echo "")
    if [ -n "${LLM_OK}" ]; then
      pass "grafana-llm-app is configured and healthy"
    else
      warn "grafana-llm-app is not configured or unhealthy"
      echo ""
      echo "  ACTION REQUIRED before running chat verification:"
      echo "  1. Open ${GRAFANA_URL}"
      echo "  2. Go to: Administration → Plugins → Grafana LLM App → Configuration"
      echo "  3. Add a provider API key (e.g. OpenAI API key)"
      echo "  4. Click Save & Test"
      echo "  5. Re-run this script to confirm the LLM is healthy"
      echo ""
      echo "  Non-chat pages (history, prompts, config) can still be verified without the LLM."
    fi
  fi
fi

# ── 5. Google Chrome installed ────────────────────────────────────────────────
printf "Checking Google Chrome... "
CHROME_FOUND=0
for path in \
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  "/usr/bin/google-chrome" \
  "/usr/bin/google-chrome-stable" \
  "/usr/local/bin/google-chrome"; do
  if [ -x "${path}" ]; then
    CHROME_FOUND=1
    pass "Found at ${path}"
    break
  fi
done
if [ "${CHROME_FOUND}" = "0" ]; then
  fail "Google Chrome not found — Chrome DevTools MCP requires Google Chrome"
  echo "      Install from: https://www.google.com/chrome/"
  ERRORS=$((ERRORS + 1))
fi

# ── 6. output/ directory ──────────────────────────────────────────────────────
printf "Checking output/ directory... "
if [ -d "output" ]; then
  pass "output/ exists (screenshots land here)"
else
  mkdir -p output
  pass "output/ created"
fi

# ── Summary ───────────────────────────────────────────────────────────────────
echo ""
echo "=== Summary ==="
if [ "${ERRORS}" -gt 0 ]; then
  fail "${ERRORS} blocking issue(s) found — fix the [FAIL] items above before running verification"
  exit 1
else
  pass "All blocking checks passed — ready to start browser verification"
  echo ""
  echo "Next step: load the 'verify-ui' skill in OpenCode and begin the verification loop."
fi
