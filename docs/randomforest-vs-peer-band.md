# RandomForest ML vs peer ±2σ panels

## Two different comparisons

| Panel style | What it compares | Where bands come from |
|-------------|------------------|------------------------|
| **vs. Peer Band** | Module N vs average of modules 1–4,6–8 | Grafana Flux: `mean` + `2*stddev` across peer `_field`s |
| **History Comparison** / **RandomForest ML** | Module N vs its own 30-day history | Python exporter: `RandomForestRegressor` → mean ± 2σ on **residuals** |

Peer band answers: “Is this module unlike the other modules **right now**?”

RandomForest answers: “Is this module unlike **its own past** for this machine?”

Use **RandomForest** when you want the same logic as the ML exporter script, not peer stddev.

## Grafana wiring (best of both worlds)

### Recent window (~last 35 days)

Keep **History Comparison** panels on **Prometheus** (unchanged):

```promql
# A — actual
machine_metrics{machine="2406-176021", field="Module5_Current_A"}

# B–D — RandomForest (5m ML cadence; use lookback)
last_over_time(machine_metric_upper_bound{machine="2406-176021", field="Module5_Current_A"}[6m])
last_over_time(machine_metric_lower_bound{machine="2406-176021", field="Module5_Current_A"}[6m])
last_over_time(machine_metric_expected{machine="2406-176021", field="Module5_Current_A"}[6m])
```

### Older dates (before Prometheus retention)

Import **`scripts/fixtures/panel-module5-randomforest-ml-influx.json`** (Panel JSON).

- **A:** Influx actual (`r.machine` + `r._field`)
- **B–D:** Influx `ml_predictions` from **backfill** (`upper`, `lower`, `expected`)
- Set the range with the **dashboard time picker** only (never panel `timeFrom` / `timeTo`)

Backfill must run for that range; it does **not** populate Prometheus historical TSDB.

## Historical Influx panel checklist

1. Add panel from `panel-module5-randomforest-ml-influx.json` (not the peer-band fixture).
2. Set the incident or analysis window with the **dashboard** time picker.
3. Confirm actual (A) in Explore for that range.
4. If B–D are empty, re-run Python backfill so `ml_predictions` exists for the module field.

## Do not use for RF

- Panels titled **“vs. Peer Band”** with Flux `union` + `reduce` + `2.0 * std` — that is peer comparison only.
- PromQL `avg(machine_metrics{...}) + 2*stddev(...)` on History Comparison — that is COMPARISON 2 peer overlay, not the RF history band.
