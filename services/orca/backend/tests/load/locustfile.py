"""Locust load test scenarios for the Orca harness.

Usage (local)::

    locust -f tests/load/locustfile.py --headless -u 500 -r 10 \\
        --run-time 2m --host http://localhost:8001 \\
        --html output/load-report.html --csv output/load

Scenarios:
    SessionBurstUser  — 500 concurrent POST /api/sessions + poll GET  (50% weight)
    SearchFloodUser   — 50 concurrent semantic-search requests          (10% weight)
    AuthStressUser    — 200 concurrent authenticated list requests       (20% weight)
"""

from __future__ import annotations

import json
import uuid

from locust import HttpUser, between, events, task


# ---------------------------------------------------------------------------
# Scenario 1 — Session burst
# ---------------------------------------------------------------------------


class SessionBurstUser(HttpUser):
    """Simulates the peak load of concurrent new session requests."""

    wait_time = between(0.5, 2.0)
    weight = 5

    @task
    def start_and_list_sessions(self) -> None:
        """POST a new session then immediately list sessions for the org."""
        payload = {
            "alert_name": f"HighLatency_{uuid.uuid4().hex[:8]}",
            "labels": {"service": "checkout", "env": "production"},
            "org_id": 1,
        }
        body = json.dumps(payload).encode()

        with self.client.post(
            "/api/sessions",
            data=body,
            headers={
                "Content-Type": "application/json",
                "X-Grafana-Org-Id": "1",
            },
            name="/api/sessions [POST]",
            catch_response=True,
        ) as resp:
            if resp.status_code not in (200, 201, 404, 422):
                resp.failure(f"Unexpected status {resp.status_code}")
            else:
                resp.success()

        self.client.get(
            "/api/sessions",
            headers={"X-Grafana-Org-Id": "1"},
            name="/api/sessions [GET list]",
        )


# ---------------------------------------------------------------------------
# Scenario 2 — Semantic search flood (exercises pgvector)
# ---------------------------------------------------------------------------


class SearchFloodUser(HttpUser):
    """Rapid semantic search queries — exercises the pgvector path."""

    wait_time = between(0.1, 0.5)
    weight = 1

    @task
    def search_sessions(self) -> None:
        self.client.get(
            f"/api/sessions/search?q=high+error+rate+{uuid.uuid4().hex[:4]}",
            headers={"X-Grafana-Org-Id": "1"},
            name="/api/sessions/search [GET]",
        )


# ---------------------------------------------------------------------------
# Scenario 3 — Auth stress
# ---------------------------------------------------------------------------


class AuthStressUser(HttpUser):
    """200 concurrent list requests with org header — tests auth middleware."""

    wait_time = between(0.2, 1.0)
    weight = 2

    @task
    def list_sessions_authenticated(self) -> None:
        self.client.get(
            "/api/sessions",
            headers={"X-Grafana-Org-Id": "1"},
            name="/api/sessions [GET auth]",
        )


# ---------------------------------------------------------------------------
# SLA validation hook
# ---------------------------------------------------------------------------


@events.quitting.add_listener
def assert_p95(environment, **_kwargs):  # type: ignore[no-untyped-def]
    """Fail the run if any endpoint's p95 response time exceeds 5 000 ms."""
    for entry in environment.stats.entries.values():
        p95 = entry.get_response_time_percentile(0.95)
        if p95 is not None and p95 > 5_000:
            print(f"FAIL: {entry.name} p95={p95:.0f}ms > 5000ms")
            environment.process_exit_code = 1
