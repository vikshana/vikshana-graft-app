# Peer-RF enroll via Graft plugin backend proxy

## Shipped pieces

### Exporter (`promql-anomaly-detection`)

- `bridge_peer_rf.py`: `enroll_peer_rf_machine`, `reload_peer_rf_config`, `backfill_peer_rf_machine`
- `bridge_peer_rf_api.py`: HTTP control API on **port 8001**
  - `GET /health`
  - `GET /peer-rf/machines`
  - `GET /peer-rf/machines/{id}`
  - `POST /peer-rf/machines` `{ "machineId", "backfill": true }`
- Auth: `Authorization: Bearer $PEER_RF_CONTROL_TOKEN` (API disabled if token unset)
- `sync-exporter-electramet.sh` **skips** overwriting live `peer_rf_config.json` unless `SYNC_PEER_RF_CONFIG=1`

### Graft backend

- `POST/GET /api/plugins/vikshana-graft-app/resources/peer-rf/machines`
- `GET .../peer-rf/health`
- Proxies to exporter; requires Grafana **Admin** role
- Settings: `jsonData.peerRfControlUrl`, `secureJsonData.peerRfControlToken`

### Graft chat UX

1. Create peer-RF → probe Influx → if missing, **explain** (no empty panel)
2. Reply: **Enroll peer-RF for MACHINE and create the panel**
3. Graft enrolls via plugin proxy, queues backfill; creates panel when bands appear (or tells you to retry after backfill)

## Ops checklist (EC2)

1. Set on `data_bridge`: `PEER_RF_CONTROL_TOKEN=<secret>`, publish/map **8001**
2. Sync exporter code (not config): `./scripts/sync-exporter-electramet.sh`
3. In Grafana → Graft plugin config: Control API URL + token → Save
4. As Admin, enroll from chat
