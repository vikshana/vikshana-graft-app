#!/usr/bin/env python3
"""Apply full-width title row at dashboard top — mirrors dashboardTitleRowLayout.ts."""
from __future__ import annotations

import json
import sqlite3
import sys

DB_PATH = "/home/ec2-user/ptw_data/Cloud/Docker/grafana-data/grafana.db"
TITLE_ROW_HEIGHT = 2
TITLE_ROW_WIDTH = 24


def title_row_markdown(label: str) -> str:
    trimmed = label.strip()
    if not trimmed:
        return "# Dashboard"
    return trimmed if trimmed.startswith("#") else f"# {trimmed}"


def panel_looks_like_title_row(panel: dict, label: str | None = None) -> bool:
    if panel.get("type") != "text":
        return False
    options = panel.get("options") or {}
    if options.get("mode") != "markdown":
        return False
    content = (options.get("content") or "").strip()
    if not content.startswith("#"):
        return False
    if label is None:
        return True
    return content.lower() == title_row_markdown(label).lower()


def shift_grid_pos(panel: dict, delta_y: int) -> None:
    gp = panel.get("gridPos")
    if isinstance(gp, dict) and isinstance(gp.get("y"), (int, float)):
        panel["gridPos"] = {**gp, "y": int(gp["y"]) + delta_y}
    for child in panel.get("panels") or []:
        if isinstance(child, dict):
            shift_grid_pos(child, delta_y)


def min_top_level_y(panels: list[dict], exclude: dict | None = None) -> int:
    ys = []
    for p in panels:
        if p is exclude:
            continue
        gp = p.get("gridPos") or {}
        if isinstance(gp.get("y"), (int, float)):
            ys.append(int(gp["y"]))
    return min(ys) if ys else 0


def layout_applied(panels: list[dict], title_panel: dict) -> bool:
    if not panels or panels[0] is not title_panel:
        return False
    gp = title_panel.get("gridPos") or {}
    if gp.get("y") != 0 or gp.get("x") != 0 or gp.get("w") != TITLE_ROW_WIDTH:
        return False
    return min_top_level_y(panels, title_panel) >= TITLE_ROW_HEIGHT


def apply_title_row(panels: list[dict], label: str) -> tuple[list[dict], dict, bool, int]:
    title_panel = next((p for p in panels if panel_looks_like_title_row(p, label)), None)
    if title_panel is None:
        title_panel = next((p for p in panels if panel_looks_like_title_row(p)), None)
    created = title_panel is None
    max_id = max((p.get("id") or 0 for p in panels), default=0)
    if created:
        title_panel = {
            "id": max_id + 1,
            "type": "text",
            "title": "",
            "gridPos": {"x": 0, "y": 0, "w": TITLE_ROW_WIDTH, "h": TITLE_ROW_HEIGHT},
            "fieldConfig": {"defaults": {}, "overrides": []},
            "options": {"mode": "markdown", "content": title_row_markdown(label)},
        }
    else:
        title_panel["type"] = "text"
        title_panel["title"] = ""
        title_panel["options"] = {
            **(title_panel.get("options") or {}),
            "mode": "markdown",
            "content": title_row_markdown(label),
        }

    title_panel["gridPos"] = {"x": 0, "y": 0, "w": TITLE_ROW_WIDTH, "h": TITLE_ROW_HEIGHT}
    others = [p for p in panels if p is not title_panel]
    shifted = 0
    if not layout_applied([title_panel, *others], title_panel):
        for p in others:
            shift_grid_pos(p, TITLE_ROW_HEIGHT)
            shifted += 1
    return [title_panel, *others], title_panel, created, shifted


def main() -> int:
    dash_uid = sys.argv[1] if len(sys.argv) > 1 else "cfo0wckufbdhce"
    label = sys.argv[2] if len(sys.argv) > 2 else "Keysight"

    conn = sqlite3.connect(DB_PATH)
    row = conn.execute("SELECT id, version, data FROM dashboard WHERE uid=?", (dash_uid,)).fetchone()
    if not row:
        print(f"Dashboard uid={dash_uid} not found")
        return 1

    dash_id, version, data = row[0], row[1], json.loads(row[2])
    panels = data.get("panels") or []
    print(f"Before ({len(panels)} panels):")
    for i, p in enumerate(panels):
        gp = p.get("gridPos") or {}
        print(f"  {i}: id={p.get('id')} title={p.get('title')!r} y={gp.get('y')} x={gp.get('x')}")

    new_panels, title_panel, created, shifted = apply_title_row(panels, label)
    data["panels"] = new_panels
    data["version"] = version + 1
    conn.execute(
        "UPDATE dashboard SET version=?, data=? WHERE id=?",
        (version + 1, json.dumps(data), dash_id),
    )
    conn.commit()

    print(f"\nv{version} -> v{version + 1}")
    print(f"Title panel id={title_panel.get('id')} created={created} shifted={shifted}")
    print("After:")
    for i, p in enumerate(new_panels):
        gp = p.get("gridPos") or {}
        print(f"  {i}: id={p.get('id')} title={p.get('title')!r} y={gp.get('y')} x={gp.get('x')}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
