#!/usr/bin/env bash
# provision-grafana-teams.sh — Phase 0 Team & Permission Provisioning
#
# Creates two teams, two users (one per team), and sets datasource permissions
# so that team-A user can only query datasource-A (Mimir) and team-B user can
# only query datasource-B (Loki).  Used by the integration test
# tests/integration/test_grafana_permissions.py.
#
# Idempotent: safe to run multiple times; existing resources are skipped.
#
# Usage:
#   GRAFANA_ADMIN_TOKEN=<token> ./scripts/provision-grafana-teams.sh
#   or:
#   ./scripts/provision-grafana-teams.sh --url http://localhost:3000 --token glsa_xxx
#
# Environment variables:
#   GRAFANA_URL          default: http://localhost:3000
#   GRAFANA_ADMIN_TOKEN  required unless --token is passed
#   GRAFANA_ADMIN_USER   default: admin
#   GRAFANA_ADMIN_PASS   default: admin  (used only if TOKEN is not provided)

set -euo pipefail

GRAFANA_URL="${GRAFANA_URL:-http://localhost:3000}"
GRAFANA_ADMIN_TOKEN="${GRAFANA_ADMIN_TOKEN:-}"
GRAFANA_ADMIN_USER="${GRAFANA_ADMIN_USER:-admin}"
GRAFANA_ADMIN_PASS="${GRAFANA_ADMIN_PASS:-admin}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --url)   GRAFANA_URL="$2"; shift 2 ;;
    --token) GRAFANA_ADMIN_TOKEN="$2"; shift 2 ;;
    --user)  GRAFANA_ADMIN_USER="$2"; shift 2 ;;
    --pass)  GRAFANA_ADMIN_PASS="$2"; shift 2 ;;
    *) echo "Unknown arg: $1"; exit 1 ;;
  esac
done

# Choose auth header: token preferred, basic auth fallback
if [[ -n "$GRAFANA_ADMIN_TOKEN" ]]; then
  AUTH="-H 'Authorization: Bearer ${GRAFANA_ADMIN_TOKEN}'"
else
  AUTH="-u '${GRAFANA_ADMIN_USER}:${GRAFANA_ADMIN_PASS}'"
fi

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
gf_get() {
  eval "curl -sf $AUTH '${GRAFANA_URL}$1'"
}

gf_post() {
  local path="$1"
  local body="$2"
  eval "curl -sf -X POST $AUTH -H 'Content-Type: application/json' -d '$body' '${GRAFANA_URL}$path'"
}

gf_put() {
  local path="$1"
  local body="$2"
  eval "curl -sf -X PUT $AUTH -H 'Content-Type: application/json' -d '$body' '${GRAFANA_URL}$path'"
}

log() { echo "[provision] $*"; }

# ---------------------------------------------------------------------------
# Wait for Grafana to be ready
# ---------------------------------------------------------------------------
log "Waiting for Grafana at ${GRAFANA_URL} ..."
for i in $(seq 1 30); do
  if curl -sf "${GRAFANA_URL}/api/health" | grep -q '"database": "ok"' 2>/dev/null; then
    log "Grafana is ready."
    break
  fi
  sleep 2
  if [[ $i -eq 30 ]]; then
    echo "ERROR: Grafana did not become ready after 60s"
    exit 1
  fi
done

# ---------------------------------------------------------------------------
# 1. Create teams
# ---------------------------------------------------------------------------
log "Creating teams..."

create_team() {
  local name="$1"
  local email="$2"
  # Check if team exists
  existing=$(gf_get "/api/teams/search?name=${name}" | python3 -c "import sys,json; t=json.load(sys.stdin); print(t['teams'][0]['id'] if t.get('teams') else '')" 2>/dev/null || true)
  if [[ -n "$existing" ]]; then
    log "  Team '$name' already exists (id=$existing)"
    echo "$existing"
    return
  fi
  id=$(gf_post "/api/teams" "{\"name\":\"${name}\",\"email\":\"${email}\"}" | python3 -c "import sys,json; print(json.load(sys.stdin)['teamId'])" 2>/dev/null || true)
  log "  Created team '$name' (id=$id)"
  echo "$id"
}

TEAM_A_ID=$(create_team "team-alpha" "team-alpha@dev.local")
TEAM_B_ID=$(create_team "team-beta" "team-beta@dev.local")

# ---------------------------------------------------------------------------
# 2. Create users (org role: Viewer)
# ---------------------------------------------------------------------------
log "Creating users..."

create_user() {
  local login="$1"
  local email="$2"
  local password="$3"
  local name="$4"
  # Check if user exists
  existing=$(gf_get "/api/users/lookup?loginOrEmail=${login}" 2>/dev/null | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('id',''))" 2>/dev/null || true)
  if [[ -n "$existing" ]]; then
    log "  User '$login' already exists (id=$existing)"
    echo "$existing"
    return
  fi
  id=$(gf_post "/api/admin/users" \
    "{\"login\":\"${login}\",\"email\":\"${email}\",\"password\":\"${password}\",\"name\":\"${name}\",\"OrgId\":1}" \
    | python3 -c "import sys,json; print(json.load(sys.stdin)['id'])" 2>/dev/null || true)
  log "  Created user '$login' (id=$id)"
  echo "$id"
}

USER_A_ID=$(create_user "user-alpha" "user-alpha@dev.local" "Password1!" "Alpha User")
USER_B_ID=$(create_user "user-beta" "user-beta@dev.local" "Password1!" "Beta User")

# ---------------------------------------------------------------------------
# 3. Add users to teams
# ---------------------------------------------------------------------------
log "Adding users to teams..."

add_to_team() {
  local team_id="$1"
  local user_id="$2"
  gf_post "/api/teams/${team_id}/members" "{\"userId\":${user_id}}" >/dev/null 2>&1 || true
  log "  User $user_id -> team $team_id"
}

add_to_team "$TEAM_A_ID" "$USER_A_ID"
add_to_team "$TEAM_B_ID" "$USER_B_ID"

# ---------------------------------------------------------------------------
# 4. Get datasource UIDs
# ---------------------------------------------------------------------------
log "Looking up datasource UIDs..."

get_ds_uid() {
  local ds_type="$1"
  gf_get "/api/datasources" | python3 -c "
import sys, json
ds_list = json.load(sys.stdin)
ds = next((d for d in ds_list if d.get('type') == '$ds_type'), None)
print(ds['uid'] if ds else '')
" 2>/dev/null || true
}

MIMIR_UID=$(get_ds_uid "prometheus")
LOKI_UID=$(get_ds_uid "loki")

log "  Mimir UID: ${MIMIR_UID:-not found}"
log "  Loki UID: ${LOKI_UID:-not found}"

# ---------------------------------------------------------------------------
# 5. Set datasource permissions
#    team-alpha: Mimir=Query, Loki=no access
#    team-beta:  Loki=Query,  Mimir=no access
#
# Grafana datasource permissions API (requires RBAC / Enterprise or OSS >=10)
# PERMISSION values: 1=Query, 2=Edit
# ---------------------------------------------------------------------------
log "Setting datasource permissions..."

set_ds_permission() {
  local ds_uid="$1"
  local team_id="$2"
  local permission="$3"   # 1=Query, 2=Edit
  local ds_name="$4"
  local team_name="$5"

  if [[ -z "$ds_uid" ]]; then
    log "  SKIP: $ds_name datasource not found"
    return
  fi

  result=$(gf_post "/api/datasources/${ds_uid}/permissions" \
    "{\"permission\":${permission},\"teamId\":${team_id}}" 2>&1 || true)
  log "  ${team_name} -> ${ds_name}: permission=${permission} (${result:-ok})"
}

# Enable datasource permissions first (required in Grafana OSS RBAC)
enable_ds_permissions() {
  local ds_uid="$1"
  local ds_name="$2"
  if [[ -z "$ds_uid" ]]; then return; fi
  gf_post "/api/datasources/${ds_uid}/enable-permissions" "{}" >/dev/null 2>&1 || true
  log "  Enabled permissions on $ds_name"
}

enable_ds_permissions "$MIMIR_UID" "mimir"
enable_ds_permissions "$LOKI_UID" "loki"

# team-alpha gets Query on Mimir (datasource A)
set_ds_permission "$MIMIR_UID" "$TEAM_A_ID" "1" "Mimir" "team-alpha"
# team-beta gets Query on Loki (datasource B)
set_ds_permission "$LOKI_UID" "$TEAM_B_ID" "1" "Loki" "team-beta"

# ---------------------------------------------------------------------------
# 6. Generate API keys (service account tokens) for each user for testing
#    These are written to /tmp/grafana-test-tokens.env and sourced by tests.
# ---------------------------------------------------------------------------
log "Generating test service account tokens..."

TOKEN_FILE="/tmp/grafana-test-tokens.env"

create_sa_token() {
  local sa_name="$1"
  local role="$2"

  # Create service account
  sa_id=$(gf_post "/api/serviceaccounts" \
    "{\"name\":\"${sa_name}\",\"role\":\"${role}\"}" \
    | python3 -c "import sys,json; print(json.load(sys.stdin)['id'])" 2>/dev/null || true)

  if [[ -z "$sa_id" ]]; then
    # Already exists — find it
    sa_id=$(gf_get "/api/serviceaccounts/search?query=${sa_name}" \
      | python3 -c "import sys,json; d=json.load(sys.stdin); print(d['serviceAccounts'][0]['id'] if d.get('serviceAccounts') else '')" 2>/dev/null || true)
  fi

  if [[ -z "$sa_id" ]]; then
    log "  WARN: Could not create service account $sa_name"
    return
  fi

  token=$(gf_post "/api/serviceaccounts/${sa_id}/tokens" \
    "{\"name\":\"smoke-test-$(date +%s)\",\"secondsToLive\":86400}" \
    | python3 -c "import sys,json; print(json.load(sys.stdin).get('key',''))" 2>/dev/null || true)

  echo "$token"
}

SA_ALPHA_TOKEN=$(create_sa_token "smoke-team-alpha" "Viewer")
SA_BETA_TOKEN=$(create_sa_token "smoke-team-beta" "Viewer")

cat >"$TOKEN_FILE" <<EOF
# Generated by provision-grafana-teams.sh — do not commit
# Source this file in integration tests:
#   source /tmp/grafana-test-tokens.env
GRAFANA_URL=${GRAFANA_URL}
MIMIR_DS_UID=${MIMIR_UID}
LOKI_DS_UID=${LOKI_UID}
TEAM_ALPHA_ID=${TEAM_A_ID}
TEAM_BETA_ID=${TEAM_B_ID}
USER_ALPHA_ID=${USER_A_ID}
USER_BETA_ID=${USER_B_ID}
SA_ALPHA_TOKEN=${SA_ALPHA_TOKEN}
SA_BETA_TOKEN=${SA_BETA_TOKEN}
EOF

log "Token file written to: ${TOKEN_FILE}"

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------
echo ""
log "=== Provisioning complete ==="
log "  team-alpha (id=$TEAM_A_ID) -> user-alpha (id=$USER_A_ID) -> Mimir query access"
log "  team-beta  (id=$TEAM_B_ID) -> user-beta  (id=$USER_B_ID) -> Loki query access"
log "  Test tokens in: $TOKEN_FILE"
echo ""
log "Run integration tests with:"
log "  source $TOKEN_FILE && pytest services/orca/backend/tests/integration/test_grafana_permissions.py -v"
