#!/usr/bin/env python3
"""Repair duplicated Flux legend suffixes on RandomForest vs Peers panels (Grafana DB)."""
from __future__ import annotations

import json
import re
import sqlite3
import sys
from copy import deepcopy
from datetime import datetime, timezone

DASH_UID = "6gawrgawrgragg"
DB_PATH = "/home/ec2-user/ptw_data/Cloud/Docker/grafana-data/grafana.db"


def strip_flux_legend_suffix(query: str) -> str:
    lines = query.rstrip().split("\n")
    while lines:
        line = lines[-1].strip()
        if re.match(r'^\|>\s*keep\s*\(\s*columns:\s*\[[^\]]*"_field"', line, re.I):
            lines.pop()
            continue
        if re.match(r"^\|>\s*map\s*\(", line, re.I):
            lines.pop()
            continue
        if re.match(r'^\|>\s*set\s*\(\s*key:\s*"_field"', line, re.I):
            lines.pop()
            continue
        break
    return "\n".join(lines).rstrip()


def canonical_suffix(label: str) -> str:
    esc = label.replace("\\", "\\\\").replace('"', '\\"')
    return (
        f'|> map(fn: (r) => ({{ _time: r._time, _value: r._value, _field: "{esc}" }}))\n'
        f'  |> map(fn: (r) => ({{ r with _field: "{esc}" }}))\n'
        f'  |> keep(columns: ["_time", "_value", "_field"])'
    )


def repair_query(query: str, label: str) -> tuple[str, bool]:
    base = strip_flux_legend_suffix(query)
    next_q = f"{base}\n  {canonical_suffix(label)}"
    return next_q, next_q != query


def find_panels(panels, substr):
    for p in panels or []:
        if not isinstance(p, dict):
            continue
        if substr in p.get("title", ""):
            yield p
        yield from find_panels(p.get("panels"), substr)


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
    db_path = sys.argv[1] if len(sys.argv) > 1 else DB_PATH
    conn = sqlite3.connect(db_path)
    row = conn.execute(
        "SELECT id, version, data FROM dashboard WHERE uid=?", (DASH_UID,)
    ).fetchone()
    if not row:
        print(f"Dashboard {DASH_UID} not found")
        return 1

    dash_id, version, data_json = row
    data = json.loads(data_json)
    repaired_panels = []

    for panel in find_panels(data.get("panels"), "RandomForest vs Peers"):
        title = panel.get("title", "")
        panel_changed = False
        for t in panel.get("targets") or []:
            label = t.get("legendFormat") or ""
            q = t.get("query") or ""
            if not label or not q:
                continue
            new_q, q_changed = repair_query(q, label)
            if q_changed:
                t["query"] = new_q
                panel_changed = True
        if ensure_ref_overrides(panel):
            panel_changed = True
        if panel_changed:
            repaired_panels.append(title)

    if not repaired_panels:
        print("No panels needed repair")
        return 0

    new_version = version + 1
    now_ms = int(datetime.now(timezone.utc).timestamp() * 1000)
    data["version"] = new_version
    conn.execute(
        "UPDATE dashboard SET version=?, data=?, updated=?, updated_by=1 WHERE id=?",
        (new_version, json.dumps(data), now_ms, dash_id),
    )
    conn.commit()
    print(f"Dashboard v{version} -> v{new_version}")
    for title in repaired_panels:
        print(f"  repaired: {title}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
