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
        '- Peer-RF bands: `ml_predictions` with tag `model=peer_rf` and `field=ModuleN_Current_A` per module. Panels are correct only when peer-RF backfill exists for that module field (not just Module 5).',
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
    ].join('\n');
}
