#!/usr/bin/env python3
"""Provision a Grafana service account and rotating API token for Orca MCP.

This script is designed to run as a one-shot Docker init container.
It idempotently creates an 'orca-mcp' Viewer service account and generates a
fresh API token on every invocation.  The token is written to a shared
volume file so orca-backend can pick it up automatically, without needing to
pre-populate GRAFANA_API_KEY in .env.

The Grafana instance must have anonymous Admin access enabled (which is the
default for this demo) so that the provisioner can call the API without
credentials.

Environment variables:
    GRAFANA_URL          Grafana base URL (default: http://grafana:3000)
    GRAFANA_API_KEY_FILE Output path for the token (default: /run/orca/GRAFANA_API_KEY)
"""

import json
import os
import sys
import time
from typing import Any
from urllib.error import URLError
from urllib.request import Request, urlopen

GRAFANA_URL: str = os.environ.get("GRAFANA_URL", "http://grafana:3000").rstrip("/")
SA_NAME: str = "orca-mcp"
TOKEN_NAME: str = "orca-token"
OUTPUT_FILE: str = os.environ.get("GRAFANA_API_KEY_FILE", "/run/orca/GRAFANA_API_KEY")
MAX_WAIT_SECONDS: int = 120
POLL_INTERVAL_SECONDS: int = 3


def grafana_request(method: str, path: str, body: dict | None = None) -> Any:
    """Make an authenticated-free HTTP request to the Grafana API.

    Anonymous Admin access must be enabled on the Grafana instance.

    Args:
        method: HTTP method (GET, POST, DELETE).
        path: API path, e.g. '/api/health'.
        body: Optional JSON-serialisable request body.

    Returns:
        Parsed JSON response — may be a dict or a list depending on the endpoint.

    Raises:
        URLError: On network / HTTP errors.
    """
    url = f"{GRAFANA_URL}{path}"
    data = json.dumps(body).encode() if body is not None else None
    req = Request(url, data=data, method=method)
    req.add_header("Content-Type", "application/json")
    req.add_header("Accept", "application/json")
    with urlopen(req, timeout=10) as resp:
        return json.loads(resp.read())


def wait_for_grafana() -> None:
    """Poll /api/health until Grafana reports its database is ready.

    Raises:
        SystemExit: If Grafana is not ready within MAX_WAIT_SECONDS.
    """
    print(f"→ Waiting for Grafana at {GRAFANA_URL} ...", flush=True)
    deadline = time.monotonic() + MAX_WAIT_SECONDS
    while time.monotonic() < deadline:
        try:
            result = grafana_request("GET", "/api/health")
            if result.get("database") == "ok":
                print("✓ Grafana is ready", flush=True)
                return
        except (URLError, OSError):
            pass
        time.sleep(POLL_INTERVAL_SECONDS)
    print("✗ Grafana did not become ready within timeout", file=sys.stderr, flush=True)
    sys.exit(1)


def get_or_create_service_account() -> int:
    """Return the service account ID for SA_NAME, creating it if absent."""
    result: dict = grafana_request("GET", f"/api/serviceaccounts/search?query={SA_NAME}&perpage=10")
    for sa in result.get("serviceAccounts", []):
        if sa["name"] == SA_NAME:
            print(f"✓ Found existing service account '{SA_NAME}' (id={sa['id']})", flush=True)
            return int(sa["id"])

    sa: dict = grafana_request("POST", "/api/serviceaccounts", {"name": SA_NAME, "role": "Viewer"})
    print(f"✓ Created service account '{SA_NAME}' (id={sa['id']})", flush=True)
    return int(sa["id"])


def rotate_token(sa_id: int) -> str:
    """Delete any existing TOKEN_NAME token and issue a fresh one.

    Grafana token values cannot be retrieved after initial creation, so we
    always rotate to guarantee the output file contains a usable key.

    Args:
        sa_id: Service account ID returned by get_or_create_service_account.

    Returns:
        The raw token string (glsa_...).

    Raises:
        SystemExit: If Grafana does not return a token key in the response.
    """
    # /api/serviceaccounts/{id}/tokens returns a JSON array
    tokens: list = grafana_request("GET", f"/api/serviceaccounts/{sa_id}/tokens")
    for token in tokens:
        if token["name"] == TOKEN_NAME:
            grafana_request("DELETE", f"/api/serviceaccounts/{sa_id}/tokens/{token['id']}")
            print(f"  ↻ Deleted existing token '{TOKEN_NAME}'", flush=True)
            break

    result: dict = grafana_request(
        "POST",
        f"/api/serviceaccounts/{sa_id}/tokens",
        {"name": TOKEN_NAME},
    )
    key: str = result.get("key", "")
    if not key:
        print("✗ Token creation response did not include a key", file=sys.stderr, flush=True)
        sys.exit(1)

    print(f"✓ Created token '{TOKEN_NAME}'", flush=True)
    return key


def write_token(api_key: str) -> None:
    """Write the token to OUTPUT_FILE on the shared volume.

    Args:
        api_key: The Grafana API token string.
    """
    os.makedirs(os.path.dirname(OUTPUT_FILE), exist_ok=True)
    with open(OUTPUT_FILE, "w") as fh:
        fh.write(api_key)
    print(f"✓ Token written to {OUTPUT_FILE}", flush=True)


def main() -> None:
    """Entry point — provision service account, rotate token, write to file."""
    wait_for_grafana()
    sa_id = get_or_create_service_account()
    api_key = rotate_token(sa_id)
    write_token(api_key)

    sep = "=" * 60
    print(f"\n{sep}", flush=True)
    print(f"  GRAFANA_API_KEY={api_key}", flush=True)
    print("  Token auto-loaded from shared volume when running via", flush=True)
    print("  'make up'.  Optionally copy to .env for local dev.", flush=True)
    print(f"{sep}\n", flush=True)


if __name__ == "__main__":
    main()

