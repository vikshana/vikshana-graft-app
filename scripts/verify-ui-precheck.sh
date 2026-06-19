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
  # Single request: capture both the final status and effective URL atomically.
  # A redirect to /login means anonymous auth is misconfigured — treat as failure.
  _plugin_out=$(curl -s -o /dev/null -w "%{http_code} %{url_effective}" --max-time 5 \
    -L "${GRAFANA_URL}${PLUGIN_APP_PATH}" 2>/dev/null || echo "000 ")
  PLUGIN_STATUS="${_plugin_out%% *}"
  PLUGIN_EFFECTIVE_URL="${_plugin_out#* }"
  case "${PLUGIN_EFFECTIVE_URL}" in
    */login*|*/auth/login*)
      fail "Plugin route redirected to login page — anonymous auth may be disabled"
      echo "      Effective URL: ${PLUGIN_EFFECTIVE_URL}"
      echo "      Restart with anonymous auth: npm run server"
      ERRORS=$((ERRORS + 1))
      ;;
    *)
      if [ "${PLUGIN_STATUS}" = "200" ]; then
        pass "Plugin route ${PLUGIN_APP_PATH} responds (HTTP 200)"
      else
        fail "Plugin route ${PLUGIN_APP_PATH} returned HTTP ${PLUGIN_STATUS}"
        echo "      The plugin may not be loaded. Check: docker logs ${PLUGIN_ID}"
        ERRORS=$((ERRORS + 1))
      fi
      ;;
  esac
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
    # Specifically check details.llmProvider.ok — a shallow grep for "ok":true
    # can produce false positives when other nested fields contain an ok flag.
    # Use python3 when available; fall back to a targeted grep on the llmProvider
    # object only. printf '%s' avoids echo escape-handling differences in /bin/sh.
    if command -v python3 > /dev/null 2>&1; then
      LLM_OK=$(printf '%s' "${LLM_BODY}" | python3 -c "
import sys, json
try:
    d = json.load(sys.stdin)
    provider = d.get('details', {}).get('llmProvider', {})
    ok = provider.get('ok') is True
    models_ok = provider.get('models', {}).get('base', {}).get('ok') is True
    print('true' if (ok and models_ok) else 'false')
except Exception:
    print('false')
" 2>/dev/null || echo "false")
    else
      # python3 not available — extract just the llmProvider object with awk so
      # we don't match ok flags in other sections of the response.
      _provider_json=$(printf '%s' "${LLM_BODY}" | \
        awk 'BEGIN{p=0} /"llmProvider"/{p=1} p{print} p && /}/{p=0}')
      case "${_provider_json}" in
        *'"ok":true'*) LLM_OK="true" ;;
        *)             LLM_OK="false" ;;
      esac
    fi
    if [ "${LLM_OK}" = "true" ]; then
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
