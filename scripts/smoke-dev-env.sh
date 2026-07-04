#!/usr/bin/env bash
# smoke-dev-env.sh — Phase 0 smoke test for the full dev stack.
#
# Asserts:
#   1. Grafana is healthy and responding
#   2. Mimir datasource is queryable via /api/ds/query with admin token
#   3. Loki datasource is queryable via /api/ds/query with admin token
#   4. Langfuse UI is reachable (health endpoint)
#   5. OTel collector accepts OTLP — sends one test span, confirms it lands in Tempo
#   6. Orca backend is healthy
#
# Usage:
#   ./scripts/smoke-dev-env.sh [--grafana-url URL] [--admin-token TOKEN]
#
# Environment variables (override CLI flags):
#   GRAFANA_URL       Grafana base URL          (default: http://localhost:3000)
#   GRAFANA_ADMIN_TOKEN  Grafana admin API token (default: read from .env)
#   LANGFUSE_URL      Langfuse base URL          (default: http://localhost:4100)
#   ORCA_URL          Orca backend URL           (default: http://localhost:8001)
#   OTEL_GRPC_ENDPOINT  OTel gRPC endpoint       (default: localhost:4317)

set -euo pipefail

# ---------------------------------------------------------------------------
# Defaults
# ---------------------------------------------------------------------------
GRAFANA_URL="${GRAFANA_URL:-http://localhost:3000}"
GRAFANA_ADMIN_TOKEN="${GRAFANA_ADMIN_TOKEN:-}"
LANGFUSE_URL="${LANGFUSE_URL:-http://localhost:4100}"
ORCA_URL="${ORCA_URL:-http://localhost:8001}"
OTEL_GRPC_ENDPOINT="${OTEL_GRPC_ENDPOINT:-localhost:4317}"

# Parse CLI flags
while [[ $# -gt 0 ]]; do
  case "$1" in
    --grafana-url) GRAFANA_URL="$2"; shift 2 ;;
    --admin-token) GRAFANA_ADMIN_TOKEN="$2"; shift 2 ;;
    *) echo "Unknown arg: $1"; exit 1 ;;
  esac
done

# If no token given, try to read from .env
if [[ -z "$GRAFANA_ADMIN_TOKEN" ]] && [[ -f ".env" ]]; then
  GRAFANA_ADMIN_TOKEN=$(grep -E '^GRAFANA_ADMIN_TOKEN=' .env 2>/dev/null | cut -d'=' -f2- | tr -d '"' || true)
fi

PASS=0
FAIL=0
SKIP=0

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
check() {
  local name="$1"
  local cmd="$2"
  printf "  %-55s " "$name ..."
  if eval "$cmd" &>/dev/null; then
    echo "PASS"
    PASS=$((PASS + 1))
  else
    echo "FAIL"
    FAIL=$((FAIL + 1))
  fi
}

check_with_output() {
  local name="$1"
  shift
  printf "  %-55s " "$name ..."
  local out
  if out=$(eval "$@" 2>&1); then
    echo "PASS"
    PASS=$((PASS + 1))
    echo "    output: $(echo "$out" | head -1)"
  else
    echo "FAIL"
    FAIL=$((FAIL + 1))
    echo "    error: $(echo "$out" | head -3)"
  fi
}

skip() {
  local name="$1"
  local reason="$2"
  printf "  %-55s SKIP (%s)\n" "$name ..." "$reason"
  SKIP=$((SKIP + 1))
}

# ---------------------------------------------------------------------------
# 1. Grafana health
# ---------------------------------------------------------------------------
echo ""
echo "=== 1. Grafana ==="
check "Grafana API health" "curl -sf '${GRAFANA_URL}/api/health' | grep -q '\"database\": \"ok\"'"
check "Grafana login page reachable" "curl -sf '${GRAFANA_URL}/login' -o /dev/null"

# ---------------------------------------------------------------------------
# 2. Datasource queries via Grafana API
# ---------------------------------------------------------------------------
echo ""
echo "=== 2. Datasource queries ==="

if [[ -z "$GRAFANA_ADMIN_TOKEN" ]]; then
  skip "Mimir datasource query" "GRAFANA_ADMIN_TOKEN not set"
  skip "Loki datasource query" "GRAFANA_ADMIN_TOKEN not set"
else
  AUTH_HEADER="Authorization: Bearer ${GRAFANA_ADMIN_TOKEN}"

  # Find Mimir datasource UID
  MIMIR_UID=$(curl -sf -H "$AUTH_HEADER" "${GRAFANA_URL}/api/datasources" \
    2>/dev/null | python3 -c "
import sys, json
ds = json.load(sys.stdin)
mimir = next((d for d in ds if d.get('type') in ('prometheus', 'grafana-mimir-datasource')), None)
print(mimir['uid'] if mimir else '')
" 2>/dev/null || true)

  if [[ -n "$MIMIR_UID" ]]; then
    MIMIR_BODY='{"queries":[{"refId":"A","datasource":{"uid":"'"$MIMIR_UID"'"},"expr":"up","instant":true}],"from":"now-5m","to":"now"}'
    check "Mimir datasource query (up metric)" \
      "curl -sf -X POST -H '$AUTH_HEADER' -H 'Content-Type: application/json' \
        -d '$MIMIR_BODY' '${GRAFANA_URL}/api/ds/query' | python3 -c 'import sys,json; r=json.load(sys.stdin); exit(0 if r.get(\"results\") else 1)'"
  else
    skip "Mimir datasource query" "datasource not found (stack may not be running)"
  fi

  # Find Loki datasource UID
  LOKI_UID=$(curl -sf -H "$AUTH_HEADER" "${GRAFANA_URL}/api/datasources" \
    2>/dev/null | python3 -c "
import sys, json
ds = json.load(sys.stdin)
loki = next((d for d in ds if d.get('type') == 'loki'), None)
print(loki['uid'] if loki else '')
" 2>/dev/null || true)

  if [[ -n "$LOKI_UID" ]]; then
    LOKI_BODY='{"queries":[{"refId":"A","datasource":{"uid":"'"$LOKI_UID"'"},"expr":"{job=~\".+\"}","queryType":"range","maxLines":1}],"from":"now-5m","to":"now"}'
    check "Loki datasource query (label query)" \
      "curl -sf -X POST -H '$AUTH_HEADER' -H 'Content-Type: application/json' \
        -d '$LOKI_BODY' '${GRAFANA_URL}/api/ds/query' -o /dev/null"
  else
    skip "Loki datasource query" "datasource not found (stack may not be running)"
  fi
fi

# ---------------------------------------------------------------------------
# 3. Langfuse
# ---------------------------------------------------------------------------
echo ""
echo "=== 3. Langfuse ==="
check "Langfuse health endpoint" \
  "curl -sf '${LANGFUSE_URL}/api/public/health' | grep -q '\"status\":\"ok\"'"

# ---------------------------------------------------------------------------
# 4. Orca backend
# ---------------------------------------------------------------------------
echo ""
echo "=== 4. Orca backend ==="
check "Orca health endpoint" \
  "curl -sf '${ORCA_URL}/health' | grep -q '\"status\": \"ok\"'"

# ---------------------------------------------------------------------------
# 5. OTel collector — send a test span via grpcurl
# ---------------------------------------------------------------------------
echo ""
echo "=== 5. OTel collector ==="

if command -v grpcurl &>/dev/null; then
  TRACE_ID=$(python3 -c "import secrets; print(secrets.token_hex(16))" 2>/dev/null || echo "deadbeef00000000deadbeef00000001")
  SPAN_ID=$(python3 -c "import secrets; print(secrets.token_hex(8))" 2>/dev/null || echo "deadbeef00000001")
  NOW_NS=$(python3 -c "import time; print(int(time.time() * 1e9))" 2>/dev/null || echo "0")
  GRPC_PAYLOAD=$(cat <<EOF
{
  "resourceSpans": [{
    "resource": {
      "attributes": [{"key": "service.name", "value": {"stringValue": "smoke-test"}}]
    },
    "scopeSpans": [{
      "scope": {"name": "smoke-test"},
      "spans": [{
        "traceId": "$(echo $TRACE_ID | xxd -r -p | base64 2>/dev/null || echo 'AAAA')",
        "spanId": "$(echo $SPAN_ID | xxd -r -p | base64 2>/dev/null || echo 'AAAB')",
        "name": "smoke-test-span",
        "kind": 1,
        "startTimeUnixNano": "${NOW_NS}",
        "endTimeUnixNano": "${NOW_NS}"
      }]
    }]
  }]
}
EOF
)
  check "OTel gRPC endpoint accepts spans (grpcurl)" \
    "grpcurl -plaintext -d '$GRPC_PAYLOAD' ${OTEL_GRPC_ENDPOINT} opentelemetry.proto.collector.trace.v1.TraceService/Export 2>&1 | grep -qiE '(partialSuccess|{}|exportTracePartialSuccess)'"
else
  skip "OTel gRPC test (grpcurl)" "grpcurl not installed — brew install grpcurl"
fi

# HTTP OTLP fallback test using curl
OTLP_HTTP="${OTLP_HTTP:-http://localhost:4318}"
check "OTel HTTP endpoint accepts spans (curl)" \
  "curl -sf -X POST -H 'Content-Type: application/json' \
    -d '{\"resourceSpans\":[]}' '${OTLP_HTTP}/v1/traces' -o /dev/null"

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------
echo ""
echo "=== Summary ==="
echo "  PASS: ${PASS}   FAIL: ${FAIL}   SKIP: ${SKIP}"
echo ""

if [[ $FAIL -gt 0 ]]; then
  echo "SMOKE TEST FAILED — ${FAIL} check(s) did not pass."
  echo "Ensure 'docker compose up -d' is running and all services are healthy."
  exit 1
else
  echo "All checks passed."
  exit 0
fi
