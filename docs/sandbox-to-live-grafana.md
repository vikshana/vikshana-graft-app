# Promote sandbox Grafana → live (`grafana.electramet.com`)

Resume this when promoting Graft / TIG **code and settings** from the ElectraMet sandbox to live. **Do not copy dashboards, alert rules, or sandbox peer-RF/ML inventory.**

## Two stacks (not a data split)

AWS IoT Core does **not** send to Grafana. The PLC publishes once; each TIG box has its own Telegraf subscriber.

| | Sandbox | Live |
|---|---|---|
| Grafana URL | `https://35.175.68.13/` (HTTPS 443) | `https://grafana.electramet.com:3000/login` |
| AWS | us-east-1 EC2 `35.175.68.13` | us-west-2 behind ALB `graf-278683431` |
| SSH (known) | `ec2-user@35.175.68.13` + `~/.ssh/tig-key-pair.pem` | **Not yet given** (need `user@host` + key) |
| Graft plugin | **Build 213** on disk (`0.1.2-electramet.213`) | Not present on login HTML |
| Auth | Local Grafana admin | **2FA login plugin** — do not overwrite |
| MQTT | Same IoT: `al30xqfwuq8mo-ats.iot.us-west-2.amazonaws.com:8883` | Same broker, separate Telegraf + Influx |

Git branch `reconstruct/build-87` is a **name only**. Plugin badge is **build 213**. PRs:

- Graft: https://github.com/motionlabs-io/vikshana-graft-app/pull/1
- Exporter: https://github.com/motionlabs-io/promql-anomaly-detection/pull/1
- Cloud: https://github.com/motionlabs-io/electramet-cloud/pull/1
- PLC (`ptwjacobs619/electramet_plc`): **separate** — Bugbot does not cross-repo MQTT connections

Enable Bugbot in Cursor Automations for the three `motionlabs-io` repos (PLC later).

## In scope (merge these)

1. **Graft plugin** — rsync **only** `…/plugins/vikshana-graft-app/` (existing `deploy-electramet.sh` `--delete` is scoped to that folder). Point `GRAFT_EC2_HOST` / `GRAFT_SSH_KEY` at live. Restart Grafana container.
2. **grafana-llm-app** — install if missing (live login HTML did not list it). Graft chat needs it.
3. **Per-org plugin settings** — `scripts/provision-graft-orgs.mjs` enable + pin Graft, LLM provider/models. Uses **server-admin basic auth** (`GRAFANA_ADMIN_USER` / `PASSWORD`). Service-account tokens **cannot** list/switch orgs. On live, run via **localhost inside Docker** (`docker exec grafana curl` + host `.env`) so traffic never hits the 2FA browser plugin.
4. **Influx / peer-RF control settings** — `scripts/sync-grafana-influx-to-bridge.sh` so Graft talks to **that host’s** `data_bridge`. Settings only, not dashboards.
5. **TIG scripts** — `field_fill.py`, `bridge.py` last-value fill, compose volume mounts. Recreate `data_bridge` if the new mount is not live.

Confirm live compose path (sandbox is `~/ptw_data/Cloud/Docker/`). If different, match live.

## Out of scope (never)

- Dashboard export/import (Keysight `afq7tc6hl1m9sb`, Skywater `idHkqdqnkmfv`, etc.)
- Grafana-managed **alert rules**
- Copy `grafana.db` or whole `grafana-data/` (wipes 2FA, users, sessions)
- `rsync --delete` the entire `plugins/` directory (would remove the 2FA plugin)
- Overwrite live `grafana.ini` `[auth*]`
- Copy sandbox `peer_rf_config.json` enrollments or `ml_predictions`
- Merge Influx time-series (live already has its own MQTT copy)

## Peer-RF / ML must start empty

On live `data_bridge`, ship **`peer_rf_config.json` as** `{"machines": {}}`. Do not copy sandbox machines (`2406-176021`, etc.). Operators create RF panels later on live; the enrolled-machine list stays empty until then.

## Blocked until you provide

1. Live SSH: `user@host` and key (Oregon instance, not ALB IPs `35.84.159.18` / `100.23.157.165`)
2. Live Grafana admin user/password from that host’s `.env` (for localhost API), **or** permission to read `.env` over SSH
3. Confirmation live plugin path matches sandbox, or the real path

## Suggested first pass (when unblocked)

1. Dry-run: SSH, `docker ps`, list `plugins/` (confirm 2FA plugin name; do not delete it).
2. Deploy Graft + copy `grafana-llm-app` if absent. Restart Grafana. Check `https://grafana.electramet.com:3000/public/plugins/vikshana-graft-app/build-info.json`.
3. 2FA login still works.
4. Provision Graft + LLM per org from inside the live container.
5. Sync Influx DS / peer-RF control URLs to **local** bridge.
6. Sync fill scripts; empty `peer_rf_config.json`; recreate `data_bridge`.
7. Do **not** import dashboards or alerts.

Optional later: `deploy-electramet-live.sh` wrapper so default deploy stays sandbox.
