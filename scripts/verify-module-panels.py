#!/usr/bin/env python3
import json
import re
import sqlite3
import sys
from collections import defaultdict

DB = sys.argv[1] if len(sys.argv) > 1 else "/home/ec2-user/ptw_data/Cloud/Docker/grafana-data/grafana.db"
UID = sys.argv[2] if len(sys.argv) > 2 else "6gawrgawrgragg"

TITLE_RE = re.compile(r"^Module\s*(\d+)\s+Current\b", re.I)


def walk(ps, out):
    for p in ps or []:
        if not isinstance(p, dict):
            continue
        t = p.get("title", "")
        m = TITLE_RE.match(t)
        if m:
            gp = p.get("gridPos") or {}
            out.append(
                {
                    "module": int(m.group(1)),
                    "title": t,
                    "y": gp.get("y", 0),
                    "h": gp.get("h", 0),
                    "w": gp.get("w", 0),
                    "panel": p,
                }
            )
        if p.get("panels"):
            walk(p["panels"], out)


conn = sqlite3.connect(DB)
row = conn.execute("SELECT data, version FROM dashboard WHERE uid=?", (UID,)).fetchone()
if not row:
    print("NOT_FOUND")
    sys.exit(1)

data = json.loads(row[0])
version = row[1]
entries = []
walk(data.get("panels", []), entries)

by_mod = defaultdict(list)
for e in entries:
    by_mod[e["module"]].append(e)

print(f"dashboard_version={version}")
print(f"total_module_current_panels={len(entries)}")
legacy = [e["title"] for e in entries if "RandomForest ML" in e["title"]]
print(f"legacy_randomforest_ml_titles={len(legacy)}")

ok = True
for mod in range(1, 9):
    group = sorted(by_mod.get(mod, []), key=lambda e: e["y"])
    print(f"\nModule {mod}: {len(group)} panels")
    for e in group:
        print(f"  y={e['y']:>3} w={e['w']:>2} | {e['title']}")
    if len(group) != 4:
        ok = False
        print("  FAIL expected 4 panels")
    expect = [
        "History Comparison",
        "History Comparison (historical / Influx)",
        "vs. Peer Band",
        "RandomForest vs Peers",
    ]
    titles = [e["title"] for e in group]
    for i, needle in enumerate(expect):
        if i >= len(titles) or needle not in titles[i]:
            ok = False
            got = titles[i] if i < len(titles) else "MISSING"
            print(f"  FAIL slot {i + 1}: expected '{needle}' in '{got}'")
    if group and not all(e["w"] == 24 and e["h"] == 12 for e in group):
        ok = False
        print("  FAIL not all panels 24x12")

for mod in (1, 3):
    hist = next((e for e in entries if e["module"] == mod and "historical / Influx" in e["title"]), None)
    peer = next((e for e in entries if e["module"] == mod and "RandomForest vs Peers" in e["title"]), None)
    if hist:
        blob = json.dumps(hist["panel"].get("targets", []))
        field = f"Module{mod}_Current_A"
        print(f"\nmodule{mod}_historical_has_{field}={field in blob}")
        print(f"module{mod}_historical_has_Module5_Current_A={'Module5_Current_A' in blob}")
    if peer:
        blob = json.dumps(peer["panel"].get("targets", []))
        field = f"Module{mod}_Current_A"
        print(f"module{mod}_peer_rf_has_{field}={field in blob}")
        print(f"module{mod}_peer_rf_has_peer_rf={'peer_rf' in blob}")

print(f"\nOVERALL={'PASS' if ok and not legacy and version >= 234 else 'FAIL'}")
