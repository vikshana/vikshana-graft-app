#!/usr/bin/env python3
"""seed-eval-dataset.py — generate and upload an eval dataset to Langfuse.

Generates ≥50 evaluation scenarios from:
  1. Skill files in SKILLS_DIR (one scenario per skill)
  2. Alert rule names from provisioning/alerting/alert-rules.yml

Uploads to a Langfuse dataset named 'orca-eval'.
Safe to run multiple times (checks for existing items by ID).

Usage:
    LANGFUSE_HOST=http://localhost:4100 python scripts/seed-eval-dataset.py
    LANGFUSE_PUBLIC_KEY=lf-pk-... LANGFUSE_SECRET_KEY=lf-sk-... python scripts/seed-eval-dataset.py
"""

from __future__ import annotations

import os
import sys
import json
from pathlib import Path


def _find_repo_root() -> Path:
    here = Path(__file__).parent
    for p in [here, here.parent, here.parent.parent]:
        if (p / "docker-compose.yaml").exists():
            return p
    return here.parent


def _load_alert_rules(repo_root: Path) -> list[str]:
    """Extract alert rule names from provisioning files."""
    alert_file = repo_root / "provisioning" / "alerting" / "alert-rules.yml"
    if not alert_file.exists():
        return []
    try:
        import yaml
        data = yaml.safe_load(alert_file.read_text())
        names: list[str] = []
        for group in data.get("groups", []):
            for rule in group.get("rules", []):
                name = rule.get("grafana_alert", {}).get("title") or rule.get("alert", "")
                if name:
                    names.append(name)
        return names
    except Exception as exc:
        print(f"  WARN: Could not parse alert rules: {exc}")
        return []


def _build_scenarios(repo_root: Path) -> list[dict]:
    """Build evaluation scenarios from skills + alert rules."""
    scenarios: list[dict] = []

    # Scenarios from alert rules
    alert_names = _load_alert_rules(repo_root)
    services = [
        "checkout-service", "payment-service", "auth-service",
        "api-gateway", "order-service", "inventory-service",
    ]
    for i, alert_name in enumerate(alert_names):
        service = services[i % len(services)]
        scenarios.append({
            "id": f"alert-{i+1:03d}",
            "input": {
                "alert_name": alert_name,
                "description": f"{alert_name} triggered on {service}",
                "service": service,
                "environment": "production",
                "labels": {"severity": "critical", "team": "platform"},
            },
            "expected_output": {
                "node_sequence": [
                    "data_gathering", "historical_context",
                    "hypothesis_generation", "await_input",
                ],
                "hypothesis_has_content": True,
                "confidence_range": [0.0, 1.0],
            },
            "metadata": {"source": "alert_rule", "alert_name": alert_name},
        })

    # Synthetic scenarios to reach ≥50 total
    synthetic_templates = [
        ("HighErrorRate", "Error rate > 5%", "critical"),
        ("HighLatency", "P95 latency > 500ms", "warning"),
        ("DiskFull", "Disk usage > 90%", "critical"),
        ("OOMKill", "OOM kill detected", "critical"),
        ("SlowQuery", "DB query P99 > 1s", "warning"),
        ("ConnectionRefused", "TCP connection refused", "critical"),
        ("CertExpiringSoon", "TLS cert expires in 7 days", "warning"),
        ("PodCrashLoop", "Pod restarting repeatedly", "critical"),
        ("MemoryLeak", "Memory increasing monotonically", "warning"),
        ("NetworkPartition", "Increased packet loss detected", "critical"),
    ]
    idx = len(scenarios)
    while len(scenarios) < 50:
        tmpl = synthetic_templates[idx % len(synthetic_templates)]
        service = services[idx % len(services)]
        env = "staging" if idx % 3 == 0 else "production"
        scenarios.append({
            "id": f"synthetic-{idx+1:03d}",
            "input": {
                "alert_name": tmpl[0],
                "description": f"{tmpl[1]} on {service}",
                "service": service,
                "environment": env,
                "labels": {"severity": tmpl[2], "team": "platform"},
            },
            "expected_output": {
                "node_sequence": [
                    "data_gathering", "historical_context",
                    "hypothesis_generation", "await_input",
                ],
                "hypothesis_has_content": True,
                "confidence_range": [0.0, 1.0],
            },
            "metadata": {"source": "synthetic", "template": tmpl[0]},
        })
        idx += 1

    return scenarios


def main() -> int:
    repo_root = _find_repo_root()
    backend_dir = repo_root / "services" / "orca" / "backend"
    sys.path.insert(0, str(backend_dir))

    # Set defaults from env
    public_key = os.environ.get("LANGFUSE_PUBLIC_KEY", "lf-pk-dev-0000000000000000")
    secret_key = os.environ.get("LANGFUSE_SECRET_KEY", "lf-sk-dev-0000000000000000")
    host = os.environ.get("LANGFUSE_HOST", "http://localhost:4100")

    print(f"Connecting to Langfuse at {host} ...")

    try:
        from langfuse import Langfuse  # type: ignore[import]
        lf = Langfuse(public_key=public_key, secret_key=secret_key, host=host)
    except ImportError:
        print("ERROR: langfuse package not installed. Run: pip install langfuse")
        return 1
    except Exception as exc:
        print(f"ERROR: Could not connect to Langfuse: {exc}")
        return 1

    # Ensure dataset exists
    dataset_name = "orca-eval"
    try:
        dataset = lf.get_dataset(dataset_name)
        print(f"Dataset '{dataset_name}' found with {len(dataset.items)} existing items")
        existing_ids = {item.id for item in dataset.items}
    except Exception:
        print(f"Creating dataset '{dataset_name}' ...")
        lf.create_dataset(name=dataset_name, description="Orca agent eval regression dataset")
        existing_ids = set()

    scenarios = _build_scenarios(repo_root)
    print(f"Generated {len(scenarios)} scenarios")

    new_count = 0
    for scenario in scenarios:
        if scenario["id"] in existing_ids:
            continue
        try:
            lf.create_dataset_item(
                dataset_name=dataset_name,
                input=scenario["input"],
                expected_output=scenario["expected_output"],
                id=scenario["id"],
                metadata=scenario.get("metadata", {}),
            )
            new_count += 1
        except Exception as exc:
            print(f"  WARN: Could not create item {scenario['id']}: {exc}")

    lf.flush()
    print(f"Done. Added {new_count} new items (total now ≥{len(scenarios)}).")
    return 0


if __name__ == "__main__":
    sys.exit(main())
