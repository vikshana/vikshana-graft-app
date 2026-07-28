"""Integration tests for the session API endpoints.

Tests: list_sessions, search_sessions, get_drill_down, post_session_feedback.
All endpoints share the same test DB provided by conftest fixtures.
"""

from __future__ import annotations

import uuid
from unittest.mock import MagicMock, patch

import pytest
from httpx import AsyncClient


# ---------------------------------------------------------------------------
# list_sessions
# ---------------------------------------------------------------------------


class TestListSessions:
    async def test_returns_empty_list_when_no_sessions(self, client: AsyncClient) -> None:
        resp = await client.get("/api/sessions")
        assert resp.status_code == 200
        body = resp.json()
        assert "sessions" in body
        assert "total" in body
        assert isinstance(body["sessions"], list)

    async def test_org_header_accepted(self, client: AsyncClient) -> None:
        resp = await client.get("/api/sessions", headers={"X-Grafana-Org-Id": "1"})
        assert resp.status_code == 200

    async def test_limit_param_accepted(self, client: AsyncClient) -> None:
        resp = await client.get("/api/sessions?limit=5")
        assert resp.status_code == 200

    async def test_status_filter_accepted(self, client: AsyncClient) -> None:
        resp = await client.get("/api/sessions?status=active")
        assert resp.status_code == 200

    async def test_type_filter_accepted(self, client: AsyncClient) -> None:
        resp = await client.get("/api/sessions?type=investigation")
        assert resp.status_code == 200

    async def test_db_failure_surfaces_503_not_empty_list(self, client: AsyncClient) -> None:
        """A genuine infra failure must not be masked as an empty result
        (harness-risk-review.md, F16) — it should surface as a safe 5xx
        with the real error logged server-side, distinct from the
        legitimate "no sessions" 200/empty-list case above."""
        with patch(
            "app.api.sessions.AsyncSessionLocal",
            side_effect=RuntimeError("db unreachable"),
        ):
            resp = await client.get("/api/sessions")
        assert resp.status_code == 503


# ---------------------------------------------------------------------------
# search_sessions
# ---------------------------------------------------------------------------


class TestSearchSessions:
    async def test_returns_empty_results_when_no_data(self, client: AsyncClient) -> None:
        with patch("app.api.sessions.embed_text") as mock_embed:
            mock_embed.return_value = [0.0] * 1536
            resp = await client.get("/api/sessions/search?q=high+error+rate")
        assert resp.status_code == 200
        body = resp.json()
        assert body["query"] == "high error rate"
        assert isinstance(body["results"], list)

    async def test_embed_failure_surfaces_503(self, client: AsyncClient) -> None:
        """An embedding-service failure is an infra failure, not "no
        results" — it must surface as a safe 5xx rather than a silent
        empty list (harness-risk-review.md, F16)."""
        with patch("app.api.sessions.embed_text", side_effect=RuntimeError("embed down")):
            resp = await client.get("/api/sessions/search?q=latency+spike")
        assert resp.status_code == 503

    async def test_db_failure_surfaces_503_not_empty_results(self, client: AsyncClient) -> None:
        with patch("app.api.sessions.embed_text") as mock_embed:
            mock_embed.return_value = [0.0] * 1536
            with patch(
                "app.api.sessions.AsyncSessionLocal",
                side_effect=RuntimeError("db unreachable"),
            ):
                resp = await client.get("/api/sessions/search?q=db+down")
        assert resp.status_code == 503

    async def test_service_filter_accepted(self, client: AsyncClient) -> None:
        with patch("app.api.sessions.embed_text") as mock_embed:
            mock_embed.return_value = [0.0] * 1536
            resp = await client.get("/api/sessions/search?q=error&service=checkout")
        assert resp.status_code == 200

    async def test_limit_enforced(self, client: AsyncClient) -> None:
        with patch("app.api.sessions.embed_text") as mock_embed:
            mock_embed.return_value = [0.0] * 1536
            resp = await client.get("/api/sessions/search?q=test&limit=51")
        # limit > 50 is a validation error
        assert resp.status_code == 422

    async def test_missing_query_returns_422(self, client: AsyncClient) -> None:
        resp = await client.get("/api/sessions/search")
        assert resp.status_code == 422


# ---------------------------------------------------------------------------
# get_drill_down
# ---------------------------------------------------------------------------


class TestGetDrillDown:
    async def test_missing_org_header_returns_400(self, client: AsyncClient) -> None:
        handle = "a" * 64
        resp = await client.get(f"/api/sessions/drill-down/{handle}")
        assert resp.status_code == 400

    async def test_returns_404_for_unknown_handle(self, client: AsyncClient) -> None:
        handle = "a" * 64
        resp = await client.get(
            f"/api/sessions/drill-down/{handle}",
            headers={"X-Grafana-Org-Id": "1"},
        )
        assert resp.status_code == 404

    async def test_404_detail_contains_truncated_handle(self, client: AsyncClient) -> None:
        handle = "b" * 64
        resp = await client.get(
            f"/api/sessions/drill-down/{handle}",
            headers={"X-Grafana-Org-Id": "1"},
        )
        assert "bbbbbbbbbbbbbbbb" in resp.json()["detail"]


# ---------------------------------------------------------------------------
# post_session_feedback
# ---------------------------------------------------------------------------


async def _seed_session(test_session, org_id: int) -> str:
    """Insert a minimal rca_sessions row and return its id."""
    from sqlalchemy import text as _text

    sid = str(uuid.uuid4())
    await test_session.execute(
        _text(
            "INSERT INTO rca_sessions (id, org_id, status, created_at) "
            "VALUES (:id, :org_id, 'completed', now())"
        ),
        {"id": sid, "org_id": org_id},
    )
    await test_session.commit()
    return sid


class TestPostSessionFeedback:
    async def test_missing_org_header_returns_400(self, client: AsyncClient) -> None:
        resp = await client.post(
            f"/api/sessions/{uuid.uuid4()}/feedback",
            json={"score": 1.0},
        )
        assert resp.status_code == 400

    async def test_unknown_session_returns_404(self, client: AsyncClient) -> None:
        resp = await client.post(
            f"/api/sessions/{uuid.uuid4()}/feedback",
            json={"score": 1.0},
            headers={"X-Grafana-Org-Id": "1"},
        )
        assert resp.status_code == 404

    async def test_owned_session_thumbs_up_returns_ok(
        self, client: AsyncClient, test_session
    ) -> None:
        sid = await _seed_session(test_session, org_id=1)
        with patch("app.api.sessions.make_langfuse_client") as mock_lf:
            mock_lf.return_value = MagicMock()
            resp = await client.post(
                f"/api/sessions/{sid}/feedback",
                json={"score": 1.0, "comment": "Great!"},
                headers={"X-Grafana-Org-Id": "1"},
            )
        assert resp.status_code == 200
        assert resp.json()["status"] == "ok"

    async def test_cross_org_session_returns_404(
        self, client: AsyncClient, test_session
    ) -> None:
        # Session owned by org 1; caller claims org 2 → must not be found.
        sid = await _seed_session(test_session, org_id=1)
        resp = await client.post(
            f"/api/sessions/{sid}/feedback",
            json={"score": 0.0},
            headers={"X-Grafana-Org-Id": "2"},
        )
        assert resp.status_code == 404

    async def test_langfuse_failure_does_not_propagate(
        self, client: AsyncClient, test_session
    ) -> None:
        sid = await _seed_session(test_session, org_id=1)
        with patch(
            "app.api.sessions.make_langfuse_client",
            side_effect=RuntimeError("langfuse down"),
        ):
            resp = await client.post(
                f"/api/sessions/{sid}/feedback",
                json={"score": 0.5},
                headers={"X-Grafana-Org-Id": "1"},
            )
        assert resp.status_code == 200

    async def test_missing_score_returns_422(self, client: AsyncClient) -> None:
        resp = await client.post(
            f"/api/sessions/{uuid.uuid4()}/feedback",
            json={"comment": "missing score"},
            headers={"X-Grafana-Org-Id": "1"},
        )
        assert resp.status_code == 422
