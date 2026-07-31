#!/usr/bin/env bash
#
# Align Grafana Influx datasources + Graft peer-RF settings across ALL orgs.
# Run on ElectraMet EC2, or: ./scripts/sync-grafana-influx-to-bridge.sh --remote
#
# Why: Graft probes peer_rf through the active org's Influx DS. Multi-org setups
# (Keysight lives in Main Org) need settings per org; a read-only local Influx
# without ml_predictions must not be the only option Graft uses.
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

TOKEN="$(grep PEER_RF_CONTROL_TOKEN docker-compose.yml | head -1 | cut -d= -f2 || true)"

python3 - <<PY
import json, os, subprocess, sys

user = os.environ["GF_SECURITY_ADMIN_USER"]
pw = os.environ["GF_SECURITY_ADMIN_PASSWORD"]
token = """${TOKEN}"""
bridge = subprocess.check_output(
    ["docker", "exec", "data_bridge", "python3", "-c", "import bridge; print(bridge.INFLUX_HOST.rstrip('/'))"],
    text=True,
).strip()
control_url = "http://172.17.0.1:8001"
auth = f"{user}:{pw}"

def gcurl(*args: str) -> str:
    return subprocess.check_output(
        ["docker", "exec", "grafana", "curl", "-sk", "-u", auth, *args],
        text=True,
    )

def switch_org(org_id: int) -> None:
    gcurl(
        "-X", "POST",
        "-H", "Content-Type: application/json",
        "-d", "{}",
        f"https://127.0.0.1:3000/api/user/using/{org_id}",
    )

orgs = json.loads(gcurl("https://127.0.0.1:3000/api/orgs"))
print(f"sync-grafana-influx: bridge={bridge} orgs={len(orgs)}")

for org in orgs:
    oid = org["id"]
    oname = org.get("name") or str(oid)
    switch_org(oid)
    print(f"--- org {oid} {oname} ---")

    # Influx DS: rewrite non-readonly docker-local URLs to bridge
    try:
        datasources = json.loads(gcurl("https://127.0.0.1:3000/api/datasources"))
    except Exception as e:
        print(f"  datasources error: {e}")
        continue

    influx = [d for d in datasources if d.get("type") == "influxdb"]
    if not influx:
        print("  no Influx DS")
    for ds in influx:
        uid = ds["uid"]
        full = json.loads(gcurl(f"https://127.0.0.1:3000/api/datasources/uid/{uid}"))
        before = (full.get("url") or "").rstrip("/")
        if before == bridge:
            print(f"  Influx {full.get('name')} ({uid}) already {bridge}")
            continue
        if full.get("readOnly"):
            print(f"  Influx {full.get('name')} ({uid}) read-only at {before} — leave (prefer bridge DS for peer-RF)")
            continue
        if "influxdb:8086" not in before and before != "":
            print(f"  Influx {full.get('name')} ({uid}) leave custom url {before}")
            continue
        jd = dict(full.get("jsonData") or {})
        jd["tlsSkipVerify"] = True
        payload = {
            "id": full["id"],
            "uid": full["uid"],
            "orgId": full.get("orgId", oid),
            "name": full["name"],
            "type": full["type"],
            "access": full.get("access", "proxy"),
            "url": bridge,
            "user": full.get("user") or "",
            "database": full.get("database") or "",
            "basicAuth": bool(full.get("basicAuth")),
            "basicAuthUser": full.get("basicAuthUser") or "",
            "withCredentials": bool(full.get("withCredentials")),
            "isDefault": bool(full.get("isDefault")),
            "jsonData": jd,
            "version": full.get("version", 0),
            "readOnly": False,
        }
        path = f"/tmp/ds-sync-{oid}-{uid}.json"
        open(path, "w").write(json.dumps(payload))
        subprocess.check_call(["docker", "cp", path, f"grafana:{path}"])
        res = subprocess.check_output(
            [
                "docker", "exec", "grafana", "curl", "-sk", "-u", auth,
                "-H", "Content-Type: application/json",
                "-X", "PUT", "--data", f"@{path}",
                f"https://127.0.0.1:3000/api/datasources/{full['id']}",
                "-w", " HTTP:%{http_code}",
            ],
            text=True,
        )
        print(f"  Influx {full.get('name')} ({uid}) {before} → {bridge} ({res[-12:]})")

    if not token:
        print("  skip peer-RF settings (no token)")
        continue

    try:
        cur = json.loads(gcurl("https://127.0.0.1:3000/api/plugins/vikshana-graft-app/settings"))
    except Exception as e:
        print(f"  graft settings error: {e}")
        continue
    jd = dict(cur.get("jsonData") or {})
    jd["peerRfControlUrl"] = control_url
    payload = {
        "enabled": True,
        "pinned": True,
        "jsonData": jd,
        "secureJsonData": {"peerRfControlToken": token},
    }
    path = f"/tmp/graft-peer-rf-{oid}.json"
    open(path, "w").write(json.dumps(payload))
    subprocess.check_call(["docker", "cp", path, f"grafana:{path}"])
    res = subprocess.check_output(
        [
            "docker", "exec", "grafana", "curl", "-sk", "-u", auth,
            "-H", "Content-Type: application/json",
            "-X", "POST", "--data", f"@{path}",
            "https://127.0.0.1:3000/api/plugins/vikshana-graft-app/settings",
            "-w", " HTTP:%{http_code}",
        ],
        text=True,
    )
    print(f"  peer-RF control settings {res[-12:]}")

# Leave admin in Main Org (Keysight)
switch_org(1)
print("sync-grafana-influx: done (active org → Main Org.)")
PY
