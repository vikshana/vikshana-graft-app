# Plan: Graft / Grafana can enroll machines in peer-RF exporter config

## Today

- Peer-RF training is owned by the ML **data bridge** (`peer_rf_config.json` + `bridge_peer_rf.py`).
- Graft can only read Grafana (dashboards / datasources / `/api/ds/query`).
- Graft now **probes** Influx for `ml_predictions{model=peer_rf}` and **explains** when missing — it does not create empty band panels.

## Goal

When an operator asks Graft to create a peer-RF panel for a machine that is not enrolled, Graft (or Grafana) should be able to **request enrollment** and optionally trigger backfill — without SSH or editing JSON by hand.

## Recommended approach (phased)

### Phase 1 — Read-only API on the exporter (safe)

Expose on the data-bridge host (or a small sidecar):

- `GET /peer-rf/machines` → list enrolled machine ids + targets
- `GET /peer-rf/machines/{id}/status` → last train time, backfill complete?, point counts

Graft uses this (via Grafana plugin backend proxy or a Grafana datasource) to make explanations precise (“machine not enrolled” vs “enrolled but backfill incomplete”).

### Phase 2 — Controlled write API

- `POST /peer-rf/machines` body: `{ "machineId": "2505-200033", "targets": "modules-1-8-current" }`
  - Validates machine has Module1–8 current history in Influx
  - Appends to `peer_rf_config.json` (atomic write + backup)
  - Optionally queues backfill job
- Auth: Grafana service account token or shared secret; **admin-only**
- Graft plugin backend route: `/a/vikshana-graft-app/peer-rf/enroll` → proxies to exporter write API (keeps token off the browser)

### Phase 3 — Graft UX

On peer-RF create when probe fails:

1. Explain (current behavior)
2. If operator is admin and Phase 2 exists: offer **“Enroll this machine and backfill”**
3. Poll status until bands exist, then create the panel

## Non-goals

- Graft must not invent peer-RF predictions client-side.
- Do not hard-code machine lists in the Graft frontend; the exporter remains source of truth.

## Ownership

| Piece | Repo |
|-------|------|
| Config + train/backfill | `promql-anomaly-detection` / data bridge |
| Probe + explain + later enroll UX | `vikshana-graft-app` |
| Auth / network | Grafana plugin backend + exporter HTTP |
