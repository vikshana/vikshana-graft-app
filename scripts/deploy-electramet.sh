#!/usr/bin/env bash
#
# Build and deploy the ElectraMet Graft plugin to EC2 Grafana.
#
# Usage:
#   ./scripts/deploy-electramet.sh              # bump, incremental build, rsync, restart (~1 min)
#   ./scripts/deploy-electramet.sh --no-bump    # deploy without incrementing build number
#   ./scripts/deploy-electramet.sh --build-only # build locally, no rsync/restart
#   ./scripts/deploy-electramet.sh --rsync-only  # deploy existing dist/ only (~10 s)
#   ./scripts/deploy-electramet.sh --frontend-only  # webpack only, skip Go binary rebuild
#   ./scripts/deploy-electramet.sh --no-restart     # rsync without restarting Grafana
#   ./scripts/deploy-electramet.sh --clean        # full rebuild: wipe deps + Go (slow, ~3 min)
#
# Environment (optional overrides):
#   GRAFT_SSH_KEY          SSH private key (default: ~/.ssh/tig-key-pair.pem)
#   GRAFT_EC2_HOST         SSH target (default: ec2-user@35.175.68.13)
#   GRAFT_REMOTE_PATH      Remote plugin dir (default: ~/ptw_data/Cloud/Docker/grafana-data/plugins/vikshana-graft-app/)
#   GRAFT_DOCKER_IMAGE     Node image for npm build (default: node:22-bookworm)
#   GRAFT_NM_VOLUME        Docker volume for cached node_modules (default: graft-electramet-node-modules)
#   GRAFT_PATH             Extra PATH prefix for mage/go (default: $HOME/go/bin:/usr/local/opt/node@22/bin)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

GRAFT_SSH_KEY="${GRAFT_SSH_KEY:-${HOME}/.ssh/tig-key-pair.pem}"
GRAFT_EC2_HOST="${GRAFT_EC2_HOST:-ec2-user@35.175.68.13}"
GRAFT_REMOTE_PATH="${GRAFT_REMOTE_PATH:-~/ptw_data/Cloud/Docker/grafana-data/plugins/vikshana-graft-app/}"
GRAFT_DOCKER_IMAGE="${GRAFT_DOCKER_IMAGE:-node:22-bookworm}"
GRAFT_NM_VOLUME="${GRAFT_NM_VOLUME:-graft-electramet-node-modules}"
GRAFT_PATH="${GRAFT_PATH:-${HOME}/go/bin:/usr/local/opt/node@22/bin}"

DO_BUMP=1
DO_DEPLOY=1
DO_BUILD=1
DO_CLEAN=0
DO_GO_BUILD=1
DO_RESTART=1

usage() {
  sed -n '2,22p' "$0" | sed 's/^# \{0,1\}//'
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
    --frontend-only)
      DO_GO_BUILD=0
      shift
      ;;
    --no-restart)
      DO_RESTART=0
      shift
      ;;
    --clean)
      DO_CLEAN=1
      shift
      ;;
    --fast)
      # Legacy alias — incremental is now the default
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

needs_npm_install() {
  [[ "${DO_CLEAN}" -eq 1 ]] && return 0
  [[ ! -d "${REPO_ROOT}/node_modules/.bin" ]] && return 0
  [[ ! -f "${REPO_ROOT}/node_modules/.package-lock.json" ]] && return 0
  [[ "${REPO_ROOT}/package-lock.json" -nt "${REPO_ROOT}/node_modules/.package-lock.json" ]] && return 0
  return 1
}

run_npm_install() {
  npm install --ignore-scripts
  cp "${REPO_ROOT}/package-lock.json" "${REPO_ROOT}/node_modules/.package-lock.json"
}

docker_npm_install() {
  if [[ "${DO_CLEAN}" -eq 1 ]]; then
    docker volume rm "${GRAFT_NM_VOLUME}" 2>/dev/null || true
  fi
  docker volume create "${GRAFT_NM_VOLUME}" >/dev/null 2>&1 || true
  docker run --rm \
    -v "${REPO_ROOT}:/app" \
    -v "${GRAFT_NM_VOLUME}:/app/node_modules" \
    -w /app \
    "${GRAFT_DOCKER_IMAGE}" \
    bash -c 'if [ ! -d node_modules/.bin/webpack ] || [ ! -f node_modules/.package-lock.json ] || [ package-lock.json -nt node_modules/.package-lock.json ]; then npm install --ignore-scripts && cp package-lock.json node_modules/.package-lock.json; fi'
}

run_frontend_build() {
  if [[ -x "${REPO_ROOT}/node_modules/.bin/webpack" ]] && [[ "${DO_CLEAN}" -eq 0 ]]; then
    log "Building frontend (local npm — incremental)"
    cd "${REPO_ROOT}"
    if needs_npm_install; then
      log "Installing npm dependencies (package-lock changed or missing)"
      run_npm_install
    else
      log "Skipping npm install (deps up to date)"
    fi
    npm run build
    return
  fi

  log "Building frontend (Docker — cached node_modules volume: ${GRAFT_NM_VOLUME})"
  docker_npm_install
  docker run --rm \
    -v "${REPO_ROOT}:/app" \
    -v "${GRAFT_NM_VOLUME}:/app/node_modules" \
    -w /app \
    "${GRAFT_DOCKER_IMAGE}" \
    npm run build
}

needs_go_rebuild() {
  [[ "${DO_GO_BUILD}" -eq 1 ]] || return 1
  [[ "${DO_CLEAN}" -eq 1 ]] && return 0
  local bin="${REPO_ROOT}/dist/gpx_graft_linux_amd64"
  [[ -f "${bin}" ]] || return 0
  local f
  for f in "${REPO_ROOT}/go.mod" "${REPO_ROOT}/go.sum" "${REPO_ROOT}/Magefile.go"; do
    [[ -f "${f}" && "${f}" -nt "${bin}" ]] && return 0
  done
  if [[ -d "${REPO_ROOT}/pkg" ]]; then
    while IFS= read -r -d '' f; do
      [[ "${f}" -nt "${bin}" ]] && return 0
    done < <(find "${REPO_ROOT}/pkg" -type f -print0 2>/dev/null)
  fi
  return 1
}

run_go_build() {
  if ! needs_go_rebuild; then
    log "Skipping Go build (binary up to date — use --clean or change pkg/ to rebuild)"
    return
  fi
  log "Building Linux backend (mage)"
  export PATH="${GRAFT_PATH}:${PATH}"
  command -v mage >/dev/null 2>&1 || die "mage not found on PATH — set GRAFT_PATH or install Go mage"
  rm -f "${REPO_ROOT}/dist/gpx_"*
  mage -v build:linux
}

cd "${REPO_ROOT}"

[[ -f package.json ]] || die "package.json not found — run from vikshana-graft-app repo"

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
  if [[ "${DO_CLEAN}" -eq 1 ]]; then
    log "Clean build requested — wiping local node_modules"
    rm -rf "${REPO_ROOT}/node_modules"
  fi

  run_frontend_build

  [[ -f dist/plugin.json ]] || die "dist/plugin.json missing — webpack build failed"

  DIST_VERSION="$(node -e "const p=require('./dist/plugin.json'); console.log(p.info?.version||'unknown')")"
  log "dist/plugin.json version: ${DIST_VERSION}"
  verify_dist_build "${BUILD_NUM}"

  run_go_build
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

if [[ "${DO_RESTART}" -eq 1 ]]; then
  log "Restarting Grafana container on EC2"
  ssh -i "${GRAFT_SSH_KEY}" -o StrictHostKeyChecking=accept-new "${GRAFT_EC2_HOST}" \
    'docker restart grafana'
else
  log "Skipping Grafana restart (--no-restart). Hard-refresh the browser to load new JS."
fi

verify_remote_build "${BUILD_NUM}"

log "Deploy complete."
echo ""
echo "  Expected build: ${BUILD_NUM}"
echo "  Plugins → Graft version: ${DIST_VERSION}"
echo "  Chat badge (loads from build-info.json): build ${BUILD_NUM}"
echo "  Sanity check in browser:"
echo "    <your-grafana-url>/public/plugins/vikshana-graft-app/build-info.json"
echo ""
echo "  Faster redeploy (same build number, after local webpack):"
echo "    ./scripts/deploy-electramet.sh --no-bump --rsync-only"
echo ""
echo "  Full clean rebuild (deps or Go changed):"
echo "    ./scripts/deploy-electramet.sh --clean"
echo ""
echo "  If the UI still shows an OLD build number:"
echo "    1. Hard refresh: Cmd+Shift+R (Mac) or Ctrl+Shift+R (Windows)"
echo "    2. Or open Grafana in a private/incognito window"
