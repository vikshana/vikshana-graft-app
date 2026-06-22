#!/usr/bin/env bash
#
# Install the auto-provisioning systemd timer on the Grafana host.
#
# Copies provision-graft-orgs.sh + the systemd units to the EC2 box, enables a
# timer that re-provisions every org (incl. newly created ones) every 10 min,
# and runs it once immediately.
#
# Usage:  ./scripts/install-auto-provision.sh
#         ./scripts/install-auto-provision.sh --no-run   # install but don't run now
#
# Env overrides (match deploy-electramet.sh):
#   GRAFT_SSH_KEY     (default ~/.ssh/tig-key-pair.pem)
#   GRAFT_EC2_HOST    (default ec2-user@35.175.68.13)
#   GRAFT_PROVISION_DIR (default ~/ptw_data/Cloud/Docker/grafana/provision)

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

GRAFT_SSH_KEY="${GRAFT_SSH_KEY:-${HOME}/.ssh/tig-key-pair.pem}"
GRAFT_EC2_HOST="${GRAFT_EC2_HOST:-ec2-user@35.175.68.13}"
GRAFT_PROVISION_DIR="${GRAFT_PROVISION_DIR:-~/ptw_data/Cloud/Docker/grafana/provision}"
SSH="ssh -i ${GRAFT_SSH_KEY} -o StrictHostKeyChecking=accept-new"
RUN_NOW=1
[[ "${1:-}" == "--no-run" ]] && RUN_NOW=0

echo "==> Creating remote provision dir"
${SSH} "${GRAFT_EC2_HOST}" "mkdir -p ${GRAFT_PROVISION_DIR}"

echo "==> Copying provisioning script + systemd units"
scp -i "${GRAFT_SSH_KEY}" -o StrictHostKeyChecking=accept-new \
  "${SCRIPT_DIR}/provision-graft-orgs.sh" \
  "${GRAFT_EC2_HOST}:${GRAFT_PROVISION_DIR}/provision-graft-orgs.sh"
scp -i "${GRAFT_SSH_KEY}" -o StrictHostKeyChecking=accept-new \
  "${SCRIPT_DIR}/systemd/graft-provision.service" \
  "${SCRIPT_DIR}/systemd/graft-provision.timer" \
  "${GRAFT_EC2_HOST}:/tmp/"

echo "==> Installing units + enabling timer"
${SSH} "${GRAFT_EC2_HOST}" "
  set -e
  chmod +x ${GRAFT_PROVISION_DIR}/provision-graft-orgs.sh
  sudo mv /tmp/graft-provision.service /etc/systemd/system/graft-provision.service
  sudo mv /tmp/graft-provision.timer /etc/systemd/system/graft-provision.timer
  sudo systemctl daemon-reload
  sudo systemctl enable --now graft-provision.timer
  systemctl list-timers graft-provision.timer --no-pager || true
"

if [[ "${RUN_NOW}" -eq 1 ]]; then
  echo "==> Running provisioning once now"
  ${SSH} "${GRAFT_EC2_HOST}" "sudo systemctl start graft-provision.service; sleep 2; systemctl status graft-provision.service --no-pager -l | tail -20"
fi

echo "==> Done. Logs: journalctl -u graft-provision.service -n 50 --no-pager"
