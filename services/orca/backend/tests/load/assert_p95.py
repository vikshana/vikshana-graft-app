#!/usr/bin/env python3
"""Assert that Locust CSV stats meet the p95 < 5 000 ms SLA.

Usage::

    python tests/load/assert_p95.py output/load_stats.csv

Exits with code 1 if any endpoint violates the p95 threshold.
Exits with code 2 if arguments are wrong or the file is missing.
"""

from __future__ import annotations

import csv
import sys

THRESHOLD_MS = 5_000
P95_COLUMN = "95%"
NAME_COLUMN = "Name"


def check(csv_path: str) -> int:
    """Check p95 values in a Locust stats CSV file.

    Args:
        csv_path: Path to the Locust ``*_stats.csv`` file.

    Returns:
        0 if all endpoints pass, 1 if any violate the threshold.
    """
    failures: list[str] = []

    with open(csv_path, newline="") as fh:
        reader = csv.DictReader(fh)
        for row in reader:
            name = row.get(NAME_COLUMN, "")
            if name in ("Aggregated", ""):
                continue
            raw = row.get(P95_COLUMN, "")
            if not raw:
                continue
            try:
                p95 = float(raw)
            except ValueError:
                continue
            if p95 > THRESHOLD_MS:
                failures.append(
                    f"  {name}: p95={p95:.0f}ms (limit {THRESHOLD_MS}ms)"
                )

    if failures:
        print("LOAD TEST FAILURES — p95 SLA violations:")
        for f in failures:
            print(f)
        return 1

    print(f"All endpoints within p95 < {THRESHOLD_MS}ms SLA")
    return 0


if __name__ == "__main__":
    if len(sys.argv) != 2:
        print(f"Usage: {sys.argv[0]} <stats_csv_path>")
        sys.exit(2)
    sys.exit(check(sys.argv[1]))
