#!/usr/bin/env bash
#
# Sync Grafana app-provisioning files to the EC2 Grafana and apply them.
#
# Copies provisioning/grafana/plugins/ -> the host dir bind-mounted into
# /etc/grafana/provisioning/plugins, then recreates the grafana container so the
# provisioning is re-read on start. Safe to run repeatedly.
#
# One-time prerequisite (host docker-compose grafana service must mount it):
#   - ./grafana/provisioning/plugins:/etc/grafana/provisioning/plugins
#
# Usage:
#   ./scripts/sync-provisioning.sh            # rsync + recreate grafana
#   ./scripts/sync-provisioning.sh --no-restart
#
# Env overrides (match deploy-electramet.sh):
#   GRAFT_SSH_KEY    (default ~/.ssh/tig-key-pair.pem)
#   GRAFT_EC2_HOST   (default ec2-user@35.175.68.13)
#   GRAFT_COMPOSE_DIR (default ~/ptw_data/Cloud/Docker)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

GRAFT_SSH_KEY="${GRAFT_SSH_KEY:-${HOME}/.ssh/tig-key-pair.pem}"
GRAFT_EC2_HOST="${GRAFT_EC2_HOST:-ec2-user@35.175.68.13}"
GRAFT_COMPOSE_DIR="${GRAFT_COMPOSE_DIR:-~/ptw_data/Cloud/Docker}"
DO_RESTART=1

[[ "${1:-}" == "--no-restart" ]] && DO_RESTART=0

SRC="${REPO_ROOT}/provisioning/grafana/plugins/"
DEST="${GRAFT_EC2_HOST}:${GRAFT_COMPOSE_DIR}/grafana/provisioning/plugins/"
SSH="ssh -i ${GRAFT_SSH_KEY} -o StrictHostKeyChecking=accept-new"

echo "==> Ensuring remote provisioning dir exists"
${SSH} "${GRAFT_EC2_HOST}" "mkdir -p ${GRAFT_COMPOSE_DIR}/grafana/provisioning/plugins"

echo "==> Syncing ${SRC} -> ${DEST}"
rsync -avz -e "${SSH}" "${SRC}" "${DEST}"

if [[ "${DO_RESTART}" -eq 1 ]]; then
  echo "==> Recreating grafana container (applies mounts + re-reads provisioning)"
  # Recreate (not just restart) so any new bind mounts take effect. Support
  # compose v2, v1, then fall back to a plain restart.
  ${SSH} "${GRAFT_EC2_HOST}" "cd ${GRAFT_COMPOSE_DIR} && { docker compose up -d --no-deps grafana 2>/dev/null || docker-compose up -d --no-deps grafana || docker restart grafana; }"
else
  echo "==> Skipping restart (--no-restart). Provisioning applies on next grafana start."
fi

echo "==> Done."
