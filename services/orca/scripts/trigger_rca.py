#!/usr/bin/env python3
"""Manually fire a Grafana-shaped webhook to trigger a new Orca RCA.

Useful for:
  - Testing MCP tool connectivity after config changes
  - Triggering an investigation without waiting for a real alert
  - Bypassing the repeat_interval / dedup window during development

Usage:
    python3 scripts/trigger_rca.py
    python3 scripts/trigger_rca.py --service cartservice
    python3 scripts/trigger_rca.py --service adservice --alert HighErrorRate
    python3 scripts/trigger_rca.py --url http://localhost:8000

The fingerprint is always unique (timestamp-based) so each invocation
creates a fresh RCA regardless of the dedup window.
"""

import argparse
import json
import sys
from datetime import datetime, timezone
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen


def build_payload(service: str, alert: str) -> dict:
    fired_at = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    # Unique fingerprint per invocation — bypasses dedup so a new RCA is always created
    fingerprint = f"manual-{service}-{datetime.now(timezone.utc).strftime('%Y%m%d%H%M%S')}"
    return {
        "version": "1",
        "receiver": "orca-webhook",
        "status": "firing",
        "groupLabels": {"alertname": alert, "service_name": service},
        "commonLabels": {},
        "commonAnnotations": {},
        "alerts": [
            {
                "status": "firing",
                "fingerprint": fingerprint,
                "startsAt": fired_at,
                "endsAt": "0001-01-01T00:00:00Z",
                "generatorURL": "http://localhost:3002",
                "labels": {
                    "alertname": alert,
                    "severity": "critical",
                    "service_name": service,
                    "deployment_environment_name": "production",
                    "domain": "commerce",
                    "legal_company": "otel-demo",
                    "sub_domain": "checkout",
                    "system_id": "otel-demo-001",
                    "team": "platform",
                    "version": "1.0.0",
                },
                "annotations": {
                    "summary": f"High error rate on {service} (manual test trigger)",
                    "description": (
                        f"Manually triggered test alert for {service}. "
                        "Use this to validate MCP tooling and agent behaviour."
                    ),
                },
            }
        ],
    }


def main() -> None:
    parser = argparse.ArgumentParser(description="Trigger an Orca RCA via a test webhook")
    parser.add_argument("--service", default="checkoutservice", help="service_name label value")
    parser.add_argument("--alert", default="HighErrorRate", help="alertname label value")
    parser.add_argument("--url", default="http://localhost:8000", help="Orca backend base URL")
    args = parser.parse_args()

    endpoint = f"{args.url.rstrip('/')}/webhook/grafana"
    payload = build_payload(args.service, args.alert)

    print(f"→ POST {endpoint}")
    print(f"  alert:   {args.alert}")
    print(f"  service: {args.service}")
    print()

    try:
        req = Request(
            endpoint,
            data=json.dumps(payload).encode(),
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        with urlopen(req, timeout=10) as resp:
            body = json.loads(resp.read())
    except HTTPError as exc:
        detail = exc.read().decode()
        print(f"✗ HTTP {exc.code}: {detail}", file=sys.stderr)
        sys.exit(1)
    except URLError as exc:
        print(f"✗ Connection failed: {exc.reason}", file=sys.stderr)
        print("  Is orca-backend running?  Try: make up  or  make orca-up", file=sys.stderr)
        sys.exit(1)

    print(json.dumps(body, indent=2))
    print()

    if body:
        entry = body[0]
        rca_id = entry["rca_id"]
        deduped = entry.get("deduplicated", False)
        if deduped:
            print(f"  ℹ️  Deduplicated → existing RCA: http://localhost:3000/rca/{rca_id}")
            print("     (same fingerprint seen within dedup window — change --service to force a new one)")
        else:
            print(f"  ✓  New RCA triggered: http://localhost:3000/rca/{rca_id}")


if __name__ == "__main__":
    main()

