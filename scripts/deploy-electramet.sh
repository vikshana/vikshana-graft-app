#!/usr/bin/env bash
#
# Build and deploy the ElectraMet Graft plugin to EC2 Grafana.
#
# Usage:
#   ./scripts/deploy-electramet.sh              # bump build, build, rsync, restart
#   ./scripts/deploy-electramet.sh --no-bump    # deploy without incrementing build number
#   ./scripts/deploy-electramet.sh --build-only # build locally, no rsync/restart
#   ./scripts/deploy-electramet.sh --rsync-only  # deploy existing dist/ only (no bump, no rebuild)
#
# Environment (optional overrides):
#   GRAFT_SSH_KEY          SSH private key (default: ~/.ssh/tig-key-pair.pem)
#   GRAFT_EC2_HOST         SSH target (default: ec2-user@35.175.68.13)
#   GRAFT_REMOTE_PATH      Remote plugin dir (default: ~/ptw_data/Cloud/Docker/grafana-data/plugins/vikshana-graft-app/)
#   GRAFT_DOCKER_IMAGE     Node image for npm build (default: node:22-bookworm)
#   GRAFT_PATH             Extra PATH prefix for mage/go (default: $HOME/go/bin:/usr/local/opt/node@22/bin)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

GRAFT_SSH_KEY="${GRAFT_SSH_KEY:-${HOME}/.ssh/tig-key-pair.pem}"
GRAFT_EC2_HOST="${GRAFT_EC2_HOST:-ec2-user@35.175.68.13}"
GRAFT_REMOTE_PATH="${GRAFT_REMOTE_PATH:-~/ptw_data/Cloud/Docker/grafana-data/plugins/vikshana-graft-app/}"
GRAFT_DOCKER_IMAGE="${GRAFT_DOCKER_IMAGE:-node:22-bookworm}"
GRAFT_PATH="${GRAFT_PATH:-${HOME}/go/bin:/usr/local/opt/node@22/bin}"

DO_BUMP=1
DO_DEPLOY=1
DO_BUILD=1

usage() {
  sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//'
  exit "${1:-0}"
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    -h|--help)
      usage 0
      ;;
    --no-bump)
      DO_BUMP=0
      shift
      ;;
    --build-only)
      DO_DEPLOY=0
      shift
      ;;
    --rsync-only)
      DO_BUMP=0
      DO_BUILD=0
      shift
      ;;
    *)
      echo "Unknown option: $1" >&2
      usage 1
      ;;
  esac
done

log() {
  printf '\n==> %s\n' "$*"
}

die() {
  echo "ERROR: $*" >&2
  exit 1
}

verify_dist_build() {
  local expected="$1"
  local json_build
  local plugin_version

  json_build="$(node -e "const d=require('./dist/build-info.json'); console.log(d.build)")" \
    || die "dist/build-info.json missing — webpack build may have failed"
  if [[ "${json_build}" != "${expected}" ]]; then
    die "dist/build-info.json has build ${json_build}, expected ${expected}"
  fi
  log "Verified dist/build-info.json has build ${json_build}"

  plugin_version="$(node -e "const p=require('./dist/plugin.json'); console.log(p.info.version)")"
  if [[ "${plugin_version}" != *".${expected}" ]] && [[ "${plugin_version}" != "${expected}" ]]; then
    die "dist/plugin.json version is ${plugin_version}, expected *.${expected}"
  fi
  log "Verified dist/plugin.json version: ${plugin_version}"
}

verify_remote_build() {
  local expected="$1"
  local json_build
  local plugin_version

  json_build="$(ssh -i "${GRAFT_SSH_KEY}" -o StrictHostKeyChecking=accept-new "${GRAFT_EC2_HOST}" \
    "cat ${GRAFT_REMOTE_PATH}build-info.json" 2>/dev/null | node -e "const d=JSON.parse(require('fs').readFileSync(0,'utf8')); console.log(d.build)")" || true
  if [[ "${json_build}" != "${expected}" ]]; then
    die "EC2 build-info.json has build ${json_build:-?}, expected ${expected}"
  fi
  log "Verified EC2 build-info.json has build ${json_build}"

  plugin_version="$(ssh -i "${GRAFT_SSH_KEY}" -o StrictHostKeyChecking=accept-new "${GRAFT_EC2_HOST}" \
    "node -e \"const p=require('${GRAFT_REMOTE_PATH}plugin.json'); console.log(p.info.version)\"" 2>/dev/null)" || true
  if [[ -n "${plugin_version}" ]]; then
    log "EC2 plugin.json version: ${plugin_version}"
  fi
}

cd "${REPO_ROOT}"

if [[ ! -f package.json ]]; then
  die "package.json not found — run from vikshana-graft-app repo"
fi

if [[ "${DO_BUMP}" -eq 1 ]]; then
  log "Bumping deploy build number"
  npm run bump:deploy
else
  log "Skipping bump (--no-bump or --rsync-only)"
fi

VERSION="$(node -e "const m=require('./electramet-build.json'); console.log(m.version||'unknown')")"
BUILD_NUM="$(node -e "const m=require('./electramet-build.json'); console.log(m.build||'?')")"
FULL_VERSION="$(node -e "const m=require('./package.json'); console.log(m.version)")"
log "Deploying ${FULL_VERSION} (badge: ${VERSION} · build ${BUILD_NUM})"

DIST_VERSION="$(node -e "const p=require('./dist/plugin.json'); console.log(p.info?.version||'unknown')" 2>/dev/null || echo 'unknown')"

if [[ "${DO_BUILD}" -eq 0 ]]; then
  log "Skipping build (--rsync-only)"
  [[ -f dist/build-info.json ]] || die "dist/ missing — run a full deploy first"
  verify_dist_build "${BUILD_NUM}"
else

log "Installing dependencies and building frontend (Docker)"
rm -rf node_modules
docker run --rm \
  -v "${REPO_ROOT}:/app" \
  -v /app/node_modules \
  -w /app \
  "${GRAFT_DOCKER_IMAGE}" \
  bash -c "npm install --ignore-scripts && npm run build"

if [[ ! -f dist/plugin.json ]]; then
  die "dist/plugin.json missing — webpack build failed"
fi

DIST_VERSION="$(node -e "const p=require('./dist/plugin.json'); console.log(p.info?.version||'unknown')")"
log "dist/plugin.json version: ${DIST_VERSION}"
verify_dist_build "${BUILD_NUM}"

log "Building Linux backend (mage)"
export PATH="${GRAFT_PATH}:${PATH}"
if ! command -v mage >/dev/null 2>&1; then
  die "mage not found on PATH — set GRAFT_PATH or install Go mage"
fi
rm -f ./dist/gpx_*
mage -v build:linux

fi

if [[ "${DO_DEPLOY}" -eq 0 ]]; then
  log "Build complete (--build-only). dist/ is ready to deploy manually."
  exit 0
fi

[[ -f "${GRAFT_SSH_KEY}" ]] || die "SSH key not found: ${GRAFT_SSH_KEY}"

log "Syncing dist/ to ${GRAFT_EC2_HOST}:${GRAFT_REMOTE_PATH}"
rsync -avz --delete \
  -e "ssh -i ${GRAFT_SSH_KEY} -o StrictHostKeyChecking=accept-new" \
  "${REPO_ROOT}/dist/" \
  "${GRAFT_EC2_HOST}:${GRAFT_REMOTE_PATH}"

log "Restarting Grafana container on EC2"
ssh -i "${GRAFT_SSH_KEY}" -o StrictHostKeyChecking=accept-new "${GRAFT_EC2_HOST}" \
  'docker restart grafana'

verify_remote_build "${BUILD_NUM}"

log "Deploy complete."
echo ""
echo "  Expected build: ${BUILD_NUM}"
echo "  Plugins → Graft version: ${DIST_VERSION}"
echo "  Chat badge (loads from build-info.json): build ${BUILD_NUM}"
echo "  Sanity check in browser:"
echo "    <your-grafana-url>/public/plugins/vikshana-graft-app/build-info.json"
echo ""
echo "  If the UI still shows an OLD build number:"
echo "    1. Hard refresh: Cmd+Shift+R (Mac) or Ctrl+Shift+R (Windows)"
echo "    2. Or open Grafana in a private/incognito window"
echo "    3. Plugins page version (${DIST_VERSION}) updates before the badge if cache is stale"
echo ""
echo "  If Plugins shows the new version but the badge does not, clear site data for this Grafana URL."
