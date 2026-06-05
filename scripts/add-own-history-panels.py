#!/usr/bin/env python3
"""Apply vs. Own History (±2σ) panels — mirrors programmaticOwnHistoryPanel.ts."""
from __future__ import annotations

import json
import re
import sqlite3
import sys

DASH_UID = "6gawrgawrgragg"
DB_PATH = "/home/ec2-user/ptw_data/Cloud/Docker/grafana-data/grafana.db"
MACHINE = "2406-176021"


def canonical_title(mod: int) -> str:
    return f"Module {mod} Current — vs. Own History (± 2σ)"


def legend_suffix(label: str) -> str:
    esc = label.replace("\\", "\\\\").replace('"', '\\"')
    return (
        f'|> map(fn: (r) => ({{ _time: r._time, _value: r._value, _field: "{esc}" }}))\n'
        f'  |> map(fn: (r) => ({{ r with _field: "{esc}" }}))\n'
        f'  |> keep(columns: ["_time", "_value", "_field"])'
    )


def build_panel(machine: str, mod: int, influx_uid: str, panel_id: int) -> dict:
    field = f"Module{mod}_Current_A"
    filt = f'r.machine == "{machine}" and r._field == "{field}"'
    base = (
        f"from(bucket: v.bucket)\n"
        f"  |> range(start: v.timeRangeStart, stop: v.timeRangeStop)\n"
        f"  |> filter(fn: (r) => {filt})"
    )
    mean1h = f"{base}\n  |> group()\n  |> aggregateWindow(every: 1h, fn: mean, createEmpty: false)"
    actual = f"Module {mod} (Actual)"

    def bound_query(sign: str, label: str) -> str:
        op = "+" if sign == "+" else "-"
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

    upper_q = bound_query("+", "Upper Bound (±2σ)")
    lower_q = bound_query("-", "Lower Bound (±2σ)")
    ds = {"uid": influx_uid}
    return {
        "id": panel_id,
        "type": "timeseries",
        "title": canonical_title(mod),
        "description": f"Module {mod} actual vs own rolling 1h mean ± 2σ (not ML, not peers).",
        "datasource": ds,
        "gridPos": {"h": 12, "w": 24, "x": 0, "y": 0},
        "fieldConfig": {"defaults": {"unit": "amp"}},
        "options": {"legend": {"displayMode": "list", "placement": "bottom", "showLegend": True}},
        "targets": [
            {
                "refId": "A",
                "datasource": ds,
                "legendFormat": actual,
                "query": f"{base}\n  |> aggregateWindow(every: v.windowPeriod, fn: mean, createEmpty: false)\n  {legend_suffix(actual)}",
                "rawQuery": True,
                "editorMode": "code",
            },
            {
                "refId": "B",
                "datasource": ds,
                "legendFormat": "Historical Mean",
                "query": f"{mean1h}\n  {legend_suffix('Historical Mean')}",
                "rawQuery": True,
                "editorMode": "code",
            },
            {"refId": "C", "datasource": ds, "legendFormat": "Upper Bound (±2σ)", "query": upper_q, "rawQuery": True, "editorMode": "code"},
            {"refId": "D", "datasource": ds, "legendFormat": "Lower Bound (±2σ)", "query": lower_q, "rawQuery": True, "editorMode": "code"},
        ],
    }


def find_influx_uid(panels) -> str:
    for p in panels or []:
        if isinstance(p, dict):
            for t in p.get("targets") or []:
                q = t.get("query") or ""
                if "from(bucket:" in q:
                    ds = t.get("datasource") or p.get("datasource") or {}
                    if isinstance(ds, dict) and ds.get("uid"):
                        return str(ds["uid"])
            uid = find_influx_uid(p.get("panels"))
            if uid:
                return uid
    return "AGC54U-Vk"


def list_panels(panels):
    out = []
    def walk(ps):
        for p in ps or []:
            if isinstance(p, dict):
                out.append(p)
                walk(p.get("panels"))
    walk(panels)
    return out


def module_num(title: str) -> int | None:
    m = re.match(r"^Module\s*(\d+)\s+Current", title, re.I)
    return int(m.group(1)) if m else None


def main() -> int:
    phase = sys.argv[1] if len(sys.argv) > 1 else "all"
    conn = sqlite3.connect(DB_PATH)
    row = conn.execute("SELECT id, version, data FROM dashboard WHERE uid=?", (DASH_UID,)).fetchone()
    dash_id, version, data = row[0], row[1], json.loads(row[2])
    panels = data.get("panels") or []
    influx_uid = find_influx_uid(panels)
    flat = list_panels(panels)
    max_id = max((p.get("id") or 0 for p in flat), default=0)

    added = []
    if phase in ("create", "all"):
        if not any("Own History" in p.get("title", "") and module_num(p.get("title", "")) == 5 for p in flat):
            max_id += 1
            panels.append(build_panel(MACHINE, 5, influx_uid, max_id))
            added.append(canonical_title(5))

    if phase in ("copy", "all"):
        flat = list_panels(panels)
        template = next((p for p in flat if module_num(p.get("title", "")) == 5 and "Own History" in p.get("title", "")), None)
        if not template and phase == "copy":
            print("No Module 5 template — run create first")
            return 1
        if template:
            for mod in [1, 2, 3, 4, 6, 7, 8]:
                if any(module_num(p.get("title", "")) == mod and "Own History" in p.get("title", "") for p in list_panels(panels)):
                    continue
                max_id += 1
                panels.append(build_panel(MACHINE, mod, influx_uid, max_id))
                added.append(canonical_title(mod))

    for p in list_panels(panels):
        mod = module_num(p.get("title", ""))
        if mod and "Own History" in p.get("title", ""):
            p["title"] = canonical_title(mod)

    # Do not reorder gridPos here — add-own-history-panels only adds panels.
    # Use Graft "Module N Current" reorder (computeModulePanelSectionStartY) so module
    # blocks stay grouped at the bottom without overlapping Pressure/Flow panels.
    data["panels"] = panels
    data["version"] = version + 1
    conn.execute(
        "UPDATE dashboard SET version=?, data=? WHERE id=?",
        (version + 1, json.dumps(data), dash_id),
    )
    conn.commit()
    print(f"v{version} -> v{version + 1}")
    for t in added:
        print(f"  added: {t}")
    print("own-history panels:", [p.get("title") for p in list_panels(panels) if "Own History" in p.get("title", "")])
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
