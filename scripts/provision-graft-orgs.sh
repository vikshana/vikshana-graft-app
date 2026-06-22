#!/usr/bin/env bash
#
# Auto-provision Graft + the Grafana LLM app across EVERY org.
#
# Designed to run on the Grafana host (e.g. via the graft-provision.timer
# systemd unit). On each run it enumerates all orgs and, per org, ensures the
# admin is a member, enables+pins the Graft app, and enables the LLM app with
# the Sonnet model mapping + shared Anthropic key. Idempotent; brand-new orgs
# are configured automatically on the next run.
#
# Dependencies: curl + jq (no node required).
#
# Config comes from the docker .env (same file the grafana container uses):
#   GRAFT_PROVISION_USER / GRAFT_PROVISION_PASSWORD      (server admin, basic auth)
#       Falls back to GF_SECURITY_ADMIN_USER/PASSWORD, but note the GF_SECURITY_*
#       password is only the *first-boot* value — if the admin password was
#       changed later it is stale, so set GRAFT_PROVISION_PASSWORD to the current
#       server-admin password.
#   ANTHROPIC_API_KEY                                    (shared key; optional)
# If ANTHROPIC_API_KEY is unset/empty the key is left untouched (existing keys
# are preserved) and only enable + model mapping are applied.
#
# Env overrides:
#   ENV_FILE      (default /home/ec2-user/ptw_data/Cloud/Docker/.env)
#   GRAFANA_URL   (default https://localhost)
#   BASE_MODEL    (default claude-sonnet-4-6)
#   LARGE_MODEL   (default claude-sonnet-4-6)
#   PROVIDER      (default anthropic)

ENV_FILE="${ENV_FILE:-/home/ec2-user/ptw_data/Cloud/Docker/.env}"
GRAFANA_URL="${GRAFANA_URL:-https://localhost}"
GRAFT_PLUGIN="${GRAFT_PLUGIN:-vikshana-graft-app}"
LLM_PLUGIN="grafana-llm-app"
BASE_MODEL="${BASE_MODEL:-claude-sonnet-4-6}"
LARGE_MODEL="${LARGE_MODEL:-claude-sonnet-4-6}"
PROVIDER="${PROVIDER:-anthropic}"

log() { printf '%s graft-provision: %s\n' "$(date -u +%H:%M:%S)" "$*"; }
die() { printf 'ERROR graft-provision: %s\n' "$*" >&2; exit 1; }

command -v curl >/dev/null || die "curl not found"
command -v jq >/dev/null || die "jq not found"
[[ -f "$ENV_FILE" ]] || die "env file not found: $ENV_FILE"

# Load the docker .env (admin creds + shared key).
set -a
# shellcheck disable=SC1090
source "$ENV_FILE"
set +a

ADMIN_USER="${GRAFT_PROVISION_USER:-${GF_SECURITY_ADMIN_USER:-}}"
ADMIN_PASS="${GRAFT_PROVISION_PASSWORD:-${GF_SECURITY_ADMIN_PASSWORD:-}}"
KEY="${ANTHROPIC_API_KEY:-}"
[[ -n "$ADMIN_USER" && -n "$ADMIN_PASS" ]] || die "set GRAFT_PROVISION_USER/PASSWORD (or GF_SECURITY_ADMIN_USER/PASSWORD) in $ENV_FILE"

# api METHOD PATH [JSON_BODY] -> prints "<http_code>\n<body>"
api() {
  local method="$1" path="$2" body="${3:-}"
  local args=(-ks -u "${ADMIN_USER}:${ADMIN_PASS}" -H "Content-Type: application/json"
              -w $'\n%{http_code}' -X "$method" "${GRAFANA_URL}${path}")
  [[ -n "$body" ]] && args+=(-d "$body")
  curl "${args[@]}"
}
# Returns 0 if the last api() output (passed in) is a 2xx.
http_ok() { [[ "$1" =~ ^2[0-9][0-9]$ ]]; }

# Identify the admin + remember its current org so we can restore it.
me="$(api GET /api/user)"; me_code="${me##*$'\n'}"; me_body="${me%$'\n'*}"
http_ok "$me_code" || die "auth failed for ${ADMIN_USER} (${me_code}) — need a server admin"
ADMIN_LOGIN="$(jq -r '.login' <<<"$me_body")"
ORIG_ORG="$(jq -r '.orgId' <<<"$me_body")"
[[ "$(jq -r '.isGrafanaAdmin' <<<"$me_body")" == "true" ]] || log "WARNING: ${ADMIN_LOGIN} is not a server admin; org enumeration may fail"

orgs_resp="$(api GET /api/orgs)"; orgs_code="${orgs_resp##*$'\n'}"; orgs_body="${orgs_resp%$'\n'*}"
http_ok "$orgs_code" || die "could not list orgs (${orgs_code}); a server admin is required"
mapfile -t ORG_IDS < <(jq -r '.[].id' <<<"$orgs_body")

log "Provisioning ${#ORG_IDS[@]} org(s) at ${GRAFANA_URL} (base=${BASE_MODEL}, key=$( [[ -n "$KEY" ]] && echo set || echo preserve ))"

errors=0
for id in "${ORG_IDS[@]}"; do
  # 1) membership (server admin can only switch into orgs it belongs to)
  api POST "/api/orgs/${id}/users" "{\"loginOrEmail\":\"${ADMIN_LOGIN}\",\"role\":\"Admin\"}" >/dev/null 2>&1 || true

  # 2) switch active org
  sw="$(api POST "/api/user/using/${id}")"; [[ "${sw##*$'\n'}" =~ ^2 ]] || { log "org ${id}: switch failed (${sw##*$'\n'})"; errors=$((errors+1)); continue; }

  # 3) enable Graft (preserve existing jsonData)
  g="$(api GET "/api/plugins/${GRAFT_PLUGIN}/settings")"
  if http_ok "${g##*$'\n'}"; then
    gjd="$(jq -c '.jsonData // {}' <<<"${g%$'\n'*}")"
    gp="$(jq -nc --argjson jd "$gjd" '{enabled:true,pinned:true,jsonData:$jd}')"
    r="$(api POST "/api/plugins/${GRAFT_PLUGIN}/settings" "$gp")"
    http_ok "${r##*$'\n'}" || { log "org ${id}: graft enable failed (${r##*$'\n'})"; errors=$((errors+1)); }
  else
    log "org ${id}: ${GRAFT_PLUGIN} not installed/visible"
  fi

  # 4) configure LLM app (merge mapping; set shared key only if provided)
  l="$(api GET "/api/plugins/${LLM_PLUGIN}/settings")"
  if http_ok "${l##*$'\n'}"; then
    ljd="$(jq -c --arg b "$BASE_MODEL" --arg lg "$LARGE_MODEL" --arg p "$PROVIDER" \
      '(.jsonData // {}) | .disabled=false | .provider=$p
       | .models = ((.models // {}) | .default=(.default // "base")
                    | .mapping = ((.mapping // {}) | .base=$b | .large=$lg))
       | .openAI = (.openAI // {disabled:false})' <<<"${l%$'\n'*}")"
    if [[ -n "$KEY" ]]; then
      lp="$(jq -nc --argjson jd "$ljd" --arg k "$KEY" '{enabled:true,pinned:true,jsonData:$jd,secureJsonData:{anthropicKey:$k}}')"
    else
      lp="$(jq -nc --argjson jd "$ljd" '{enabled:true,pinned:true,jsonData:$jd}')"
    fi
    r="$(api POST "/api/plugins/${LLM_PLUGIN}/settings" "$lp")"
    http_ok "${r##*$'\n'}" || { log "org ${id}: llm config failed (${r##*$'\n'})"; errors=$((errors+1)); }
  else
    log "org ${id}: ${LLM_PLUGIN} not installed/visible"
  fi
done

# Restore the admin's original active org.
api POST "/api/user/using/${ORIG_ORG}" >/dev/null 2>&1 || true

log "Done. ${#ORG_IDS[@]} org(s), ${errors} error(s)."
[[ "$errors" -eq 0 ]]
