/**
 * Compact operator conventions injected into the LLM system context (PowerTech / ElectraMet).
 * Keeps novel requests grounded without hard-coding every phrasing.
 */
export function buildPowerTechOperatorGuide(): string {
    return [
        '## PowerTech / ElectraMet conventions (follow for dashboard edits)',
        '',
        '**Data paths**',
        '- Live ~35d RandomForest on Prometheus: `machine_metrics` + `last_over_time(machine_metric_{upper,lower,expected}_bound[6m])`.',
        '- Historical / incident windows: Influx Flux on the same datasource as working peer-band panels — `r.machine` + `r._field`, ML bands from `ml_predictions` (not Prometheus).',
        '- Peer ±2σ in Grafana: Flux mean/stddev across peer module currents — not the same as RandomForest.',
        '- **vs. Own History (± 2σ)**: single-module rolling 1h mean ± 2σ on ModuleN_Current_A (Influx) — not ML, not peers.',
        '- Peer RandomForest vs Peers: Graft probes Influx for predictions before creating a panel. If a first-time history fill is still running, it explains in plain English and does **not** save empty charts. Peer Band (±2σ) and Own History panels/alerts do not need that fill.',
        '- **History Comparison (historical / Influx)** = module vs its own past (Influx backfill). Legacy title `RandomForest ML (Influx)` means the same — rename and sort it directly under live History Comparison, before Peer Band.',
        '',
        '**Flux panels**',
        '- Use Influx datasource (copy from a working Flux panel). `query` + `rawQuery` as strings; do not use `rawQuery: true` boolean or Prometheus `expr` for Flux.',
        '- Use `range(start: v.timeRangeStart, stop: v.timeRangeStop)` — never hard-code incident dates in panel `timeFrom`/`timeTo`.',
        '',
        '**Execution**',
        '- If the user asked for a change and you have enough detail: `get_dashboard_by_uid` then `update_dashboard` in this turn.',
        '- Do not stop after analysis or a clarifying question if the user already confirmed — save first, explain after.',
        '- For layout/reorder: preserve panel queries; only change `gridPos` (and title if needed). Module N Current blocks: order 1→8 at the **bottom** of the dashboard (below non-module panels), uniform size (w=24, h=12) unless asked otherwise.',
        '- **Dashboard title row**: full-width text panel (w=24, h=2, markdown `# Title`) at **array index 0** and y=0; shift **all** other panels down by 2 — setting y=0 alone is not enough when other panels share row 0. Re-running add/change with a new label updates the existing title text panel without shifting again.',
        '- **Rebuild / best practices**: when uid is given, call get_dashboard_by_uid first — do not ask what metrics to display. Instrumentation dashboards (Keysight: pressure/temperature/cartridge) reorganize existing panels only; do NOT add Module N RF/peer/own-history blocks. Module dashboards (Exsolve): keep module blocks 1→8 at the bottom.',
        '- **Instrumentation metrics (Keysight)**: live data is Prometheus `machine_metrics{machine="<MACHINE_ID>", field="Pressure1_psi"}` (175+ fields) — not standalone `Pressure1_psi{...}` or Influx `keysight_machine`. Infer `<MACHINE_ID>` from the dashboard title or prompt — never invent one. For “create N panels for every metric”, call `list_prometheus_label_values` on label **`field`** with `{__name__="machine_metrics", machine="<MACHINE_ID>"}` before inventing panels.',
        '- **Hybrid repair**: if your turn fails or leaves overlapping gridPos, Graft may auto-apply programmatic layout (title row, rebuild, module reorder, metric stat grid) — prefer correct gridPos in your first save.',
    ].join('\n');
}
