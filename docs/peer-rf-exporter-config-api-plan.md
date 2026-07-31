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

1. Create peer-RF → probe Influx via Grafana DS
2. If bands missing and peer-RF control is configured → **auto-enroll** + poll backfill (~60s) + re-probe (no magic enroll phrase)
3. Create panel only when bands are visible; otherwise explain (including datasource mismatch if exporter finished but Grafana still empty)

### Ops: keep Influx aligned

Grafana’s Influx datasource URL **must** match `data_bridge` `INFLUX_HOST`. Deploy runs:

```bash
./scripts/sync-grafana-influx-to-bridge.sh --remote
```

(also re-applies `peerRfControlUrl` + token after Grafana recreates.)

## Ops checklist (EC2)

1. Set on `data_bridge`: `PEER_RF_CONTROL_TOKEN=<secret>`, publish/map **8001**
2. Sync exporter code (not config): `./scripts/sync-exporter-electramet.sh`
3. Graft settings (or deploy sync script): Control API URL `http://172.17.0.1:8001` + token
4. As Admin, create peer-RF from chat — enroll happens automatically when needed
