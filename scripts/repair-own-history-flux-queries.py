#!/usr/bin/env python3
"""Replace invalid import \"join\" on vs. Own History panels with union+pivot bounds."""
from __future__ import annotations

import json
import re
import sqlite3
import sys

DASH_UID = "6gawrgawrgragg"
DB_PATH = "/home/ec2-user/ptw_data/Cloud/Docker/grafana-data/grafana.db"


def legend_suffix(label: str) -> str:
    esc = label.replace("\\", "\\\\").replace('"', '\\"')
    return (
        f'|> map(fn: (r) => ({{ _time: r._time, _value: r._value, _field: "{esc}" }}))\n'
        f'  |> map(fn: (r) => ({{ r with _field: "{esc}" }}))\n'
        f'  |> keep(columns: ["_time", "_value", "_field"])'
    )


def strip_legend_suffix(query: str) -> str:
    lines = query.rstrip().split("\n")
    while lines:
        line = lines[-1].strip()
        if re.match(r'^\|>\s*keep\s*\(\s*columns:\s*\[[^\]]*"_field"', line, re.I):
            lines.pop()
            continue
        if re.match(r"^\|>\s*map\s*\(", line, re.I):
            lines.pop()
            continue
        break
    return "\n".join(lines).rstrip()


def extract_filter(query: str) -> str | None:
    m = re.search(r"filter\(fn:\s*\(r\)\s*=>\s*(.+?)\)\s*$", query, re.S | re.M)
    if m:
        return m.group(1).strip()
    m = re.search(r'r\.machine\s*==\s*"[^"]+"\s+and\s+r\._field\s*==\s*"[^"]+"', query)
    return m.group(0) if m else None


def bound_query(filt: str, sign: str, label: str) -> str:
    op = "+" if sign == "+" else "-"
    base = (
        f"from(bucket: v.bucket)\n"
        f"  |> range(start: v.timeRangeStart, stop: v.timeRangeStop)\n"
        f"  |> filter(fn: (r) => {filt})"
    )
    return (
        f"base = {base}\n"
        f"  |> group()\n\n"
        f"meanTable = base\n"
        f"  |> aggregateWindow(every: 1h, fn: mean, createEmpty: false)\n"
        f'  |> set(key: "stat", value: "mean")\n\n'
        f"stdTable = base\n"
        f"  |> aggregateWindow(every: 1h, fn: stddev, createEmpty: false)\n"
        f'  |> set(key: "stat", value: "std")\n\n'
        f"union(tables: [meanTable, stdTable])\n"
        f'  |> pivot(rowKey: ["_time"], columnKey: ["stat"], valueColumn: "_value")\n'
        f"  |> map(fn: (r) => ({{ _time: r._time, _value: r.mean {op} 2.0 * r.std }}))\n"
        f"  {legend_suffix(label)}"
    )


def mean_query(filt: str) -> str:
    return (
        f"from(bucket: v.bucket)\n"
        f"  |> range(start: v.timeRangeStart, stop: v.timeRangeStop)\n"
        f"  |> filter(fn: (r) => {filt})\n"
        f"  |> group()\n"
        f"  |> aggregateWindow(every: 1h, fn: mean, createEmpty: false)\n"
        f"  {legend_suffix('Historical Mean')}"
    )


def walk_panels(panels):
    for p in panels or []:
        if isinstance(p, dict):
            yield p
            yield from walk_panels(p.get("panels"))


def ensure_ref_overrides(panel: dict) -> bool:
    targets = panel.get("targets") or []
    field_config = panel.setdefault("fieldConfig", {"defaults": {}, "overrides": []})
    overrides = field_config.setdefault("overrides", [])
    changed = False
    for t in targets:
        ref = t.get("refId")
        label = t.get("legendFormat")
        if not ref or not label:
            continue
        entry = next(
            (
                o
                for o in overrides
                if o.get("matcher", {}).get("id") == "byFrameRefID"
                and str(o.get("matcher", {}).get("options")) == str(ref)
            ),
            None,
        )
        if not entry:
            entry = {"matcher": {"id": "byFrameRefID", "options": ref}, "properties": []}
            overrides.append(entry)
            changed = True
        props = entry.setdefault("properties", [])
        dn = next((p for p in props if p.get("id") == "displayName"), None)
        if dn:
            if dn.get("value") != label:
                dn["value"] = label
                changed = True
        else:
            props.append({"id": "displayName", "value": label})
            changed = True
    return changed


def main() -> int:
    db = sys.argv[1] if len(sys.argv) > 1 else DB_PATH
    conn = sqlite3.connect(db)
    row = conn.execute("SELECT id, version, data FROM dashboard WHERE uid=?", (DASH_UID,)).fetchone()
    if not row:
        print("NOT_FOUND")
        return 1
    dash_id, version, data = row[0], row[1], json.loads(row[2])
    changed = 0
    for panel in walk_panels(data.get("panels")):
        if "Own History" not in panel.get("title", ""):
            continue
        title = panel.get("title", "")
        targets = panel.get("targets") or []
        filt = None
        for t in targets:
            q = t.get("query") or ""
            filt = extract_filter(q)
            if filt:
                break
        if not filt:
            print(f"SKIP {title}: no filter")
            continue
        for t in targets:
            ref = t.get("refId")
            q = t.get("query") or ""
            if ref == "B" and "aggregateWindow" in q:
                new_q = mean_query(filt)
                if new_q != q:
                    t["query"] = new_q
                    changed += 1
            elif ref == "C" and ('import "join"' in q or "_value_mean" in q):
                new_q = bound_query(filt, "+", "Upper Bound (±2σ)")
                if new_q != q:
                    t["query"] = new_q
                    changed += 1
            elif ref == "D" and ('import "join"' in q or "_value_mean" in q):
                new_q = bound_query(filt, "-", "Lower Bound (±2σ)")
                if new_q != q:
                    t["query"] = new_q
                    changed += 1
        if ensure_ref_overrides(panel):
            changed += 1
        print(f"OK {title}")

    if changed == 0:
        print("no changes")
        return 0

    data["version"] = version + 1
    conn.execute(
        "UPDATE dashboard SET version=?, data=? WHERE id=?",
        (version + 1, json.dumps(data), dash_id),
    )
    conn.commit()
    print(f"v{version} -> v{version + 1} ({changed} target queries updated)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
