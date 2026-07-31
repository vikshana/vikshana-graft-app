#!/usr/bin/env bash
#
# Align Grafana's Influx datasource URL with data_bridge INFLUX_HOST, and
# re-apply Graft peer-RF control settings. Run on the ElectraMet EC2 host
# (Docker compose directory with .env), or via:
#   ./scripts/sync-grafana-influx-to-bridge.sh --remote
#
# Why: Graft probes peer_rf through Grafana's Influx DS. If that DS points at a
# different Influx than the exporter writes to, create always says "not available".
#
set -euo pipefail

GRAFT_SSH_KEY="${GRAFT_SSH_KEY:-${HOME}/.ssh/tig-key-pair.pem}"
GRAFT_EC2_HOST="${GRAFT_EC2_HOST:-ec2-user@35.175.68.13}"

if [[ "${1:-}" == "--remote" ]]; then
  SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  ssh -i "${GRAFT_SSH_KEY}" -o StrictHostKeyChecking=accept-new "${GRAFT_EC2_HOST}" \
    'mkdir -p ~/ptw_data/Cloud/Docker/scripts'
  scp -i "${GRAFT_SSH_KEY}" -o StrictHostKeyChecking=accept-new \
    "${SCRIPT_DIR}/sync-grafana-influx-to-bridge.sh" \
    "${GRAFT_EC2_HOST}:ptw_data/Cloud/Docker/scripts/sync-grafana-influx-to-bridge.sh"
  ssh -i "${GRAFT_SSH_KEY}" -o StrictHostKeyChecking=accept-new "${GRAFT_EC2_HOST}" \
    'bash ~/ptw_data/Cloud/Docker/scripts/sync-grafana-influx-to-bridge.sh'
  exit 0
fi

cd "${HOME}/ptw_data/Cloud/Docker"
set -a
# shellcheck disable=SC1091
source .env
set +a

BRIDGE_HOST="$(docker exec data_bridge python3 -c 'import bridge; print(bridge.INFLUX_HOST.rstrip("/"))' 2>/dev/null || true)"
if [[ -z "${BRIDGE_HOST}" ]]; then
  echo "sync-grafana-influx: could not read INFLUX_HOST from data_bridge — skip"
  exit 0
fi

python3 - <<'PY'
import json, os, subprocess, sys

user = os.environ["GF_SECURITY_ADMIN_USER"]
pw = os.environ["GF_SECURITY_ADMIN_PASSWORD"]
bridge = subprocess.check_output(
    ["docker", "exec", "data_bridge", "python3", "-c", "import bridge; print(bridge.INFLUX_HOST.rstrip('/'))"],
    text=True,
).strip()

def gcurl(*args: str) -> str:
    return subprocess.check_output(
        ["docker", "exec", "grafana", "curl", "-sk", "-u", f"{user}:{pw}", *args],
        text=True,
    )

datasources = json.loads(gcurl("https://127.0.0.1:3000/api/datasources"))
influx = [d for d in datasources if d.get("type") == "influxdb"]
if not influx:
    print("sync-grafana-influx: no Influx datasource — skip")
    sys.exit(0)

updated = 0
for ds in influx:
    uid = ds["uid"]
    full = json.loads(gcurl(f"https://127.0.0.1:3000/api/datasources/uid/{uid}"))
    before = (full.get("url") or "").rstrip("/")
    if before == bridge:
        print(f"sync-grafana-influx: {full.get('name')} ({uid}) already {bridge}")
        continue
    jd = dict(full.get("jsonData") or {})
    jd["tlsSkipVerify"] = True
    payload = {
        "id": full["id"],
        "uid": full["uid"],
        "orgId": full.get("orgId", 1),
        "name": full["name"],
        "type": full["type"],
        "access": full.get("access", "proxy"),
        "url": bridge,
        "user": full.get("user") or "",
        "database": full.get("database") or "",
        "basicAuth": full.get("basicAuth", False),
        "basicAuthUser": full.get("basicAuthUser") or "",
        "withCredentials": full.get("withCredentials", False),
        "isDefault": full.get("isDefault", False),
        "jsonData": jd,
        "version": full.get("version", 0),
        "readOnly": False,
    }
    path = f"/tmp/ds-sync-{uid}.json"
    open(path, "w").write(json.dumps(payload))
    subprocess.check_call(["docker", "cp", path, f"grafana:{path}"])
    res = subprocess.check_output(
        [
            "docker", "exec", "grafana", "curl", "-sk", "-u", f"{user}:{pw}",
            "-H", "Content-Type: application/json",
            "-X", "PUT", "--data", f"@{path}",
            f"https://127.0.0.1:3000/api/datasources/{full['id']}",
            "-w", " HTTP:%{http_code}",
        ],
        text=True,
    )
    print(f"sync-grafana-influx: {full.get('name')} ({uid}) {before} → {bridge} ({res[-12:]})")
    updated += 1

print(f"sync-grafana-influx: done ({updated} updated)")
PY

TOKEN="$(grep PEER_RF_CONTROL_TOKEN docker-compose.yml | head -1 | cut -d= -f2 || true)"
if [[ -n "${TOKEN}" ]]; then
  python3 - <<PY
import json, os, subprocess
user = os.environ["GF_SECURITY_ADMIN_USER"]
pw = os.environ["GF_SECURITY_ADMIN_PASSWORD"]
token = """${TOKEN}"""
url = "http://172.17.0.1:8001"
out = subprocess.check_output([
    "docker", "exec", "grafana", "curl", "-sk", "-u", f"{user}:{pw}",
    "https://127.0.0.1:3000/api/plugins/vikshana-graft-app/settings",
], text=True)
cur = json.loads(out)
jd = dict(cur.get("jsonData") or {})
jd["peerRfControlUrl"] = url
payload = {
    "enabled": True,
    "pinned": True,
    "jsonData": jd,
    "secureJsonData": {"peerRfControlToken": token},
}
open("/tmp/graft-peer-rf.json", "w").write(json.dumps(payload))
subprocess.check_call(["docker", "cp", "/tmp/graft-peer-rf.json", "grafana:/tmp/graft-peer-rf.json"])
res = subprocess.check_output([
    "docker", "exec", "grafana", "curl", "-sk", "-u", f"{user}:{pw}",
    "-H", "Content-Type: application/json",
    "-X", "POST", "--data", "@/tmp/graft-peer-rf.json",
    "https://127.0.0.1:3000/api/plugins/vikshana-graft-app/settings",
    "-w", " HTTP:%{http_code}",
], text=True)
print("sync-grafana-influx: peer-RF control settings", res[-12:])
PY
fi
