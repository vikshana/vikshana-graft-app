# Panel 424 — Module 5 vs Peer Band (corrected Flux)

**Problem:** `r._measurement == "machine_metrics"` is PromQL naming; it does not match Influx rows → Grafana shows **No data** with no error.

**Fix:** Use only `r.machine` and `r._field` in every target (A–D).

## Paste into Grafana (Panel → Edit → each query, Code mode)

### Target A — Module 5 (Actual)

```flux
from(bucket: v.bucket)
  |> range(start: v.timeRangeStart, stop: v.timeRangeStop)
  |> filter(fn: (r) =>
    r.machine == "2406-176021" and
    r._field == "Module5_Current_A"
  )
  |> keep(columns: ["_time", "_value"])
  |> aggregateWindow(every: v.windowPeriod, fn: mean, createEmpty: false)
```

### Target B — Peer Avg

See `scripts/fixtures/panel-424-broken-input-fixed.json` target B (long union query).

### Targets C & D — Upper / Lower Band

Same union branches as B, then `group` + `reduce` + `map` (see fixed JSON file).

## Regenerate from repo

```bash
npx tsx scripts/emit-fixed-panel-424.ts path/to/panel-export.json
```

## Graft

After build **67+** deploy, run scoped fix on dashboard uid `6gawrgawrgragg` for this panel title.
