"""Unit tests for harness/auth/internal_auth.py — HMAC validation middleware."""

from __future__ import annotations

import hashlib
import hmac
import time
from unittest.mock import AsyncMock, MagicMock

import pytest
from fastapi import FastAPI
from httpx import ASGITransport, AsyncClient

from harness.auth.internal_auth import InternalAuthMiddleware, _compute_signature


# ── Helper ────────────────────────────────────────────────────────────────────


def _make_app(secret: str = "test-secret") -> FastAPI:
    """Build a minimal FastAPI app with InternalAuthMiddleware for testing."""
    app = FastAPI()
    app.add_middleware(InternalAuthMiddleware, secret=secret)

    @app.get("/api/sessions/list")
    async def list_sessions():
        return {"sessions": []}

    @app.get("/api/rca/list")
    async def list_rca():
        return {"items": []}

    return app


def _make_headers(path: str, secret: str, ts: int | None = None) -> dict[str, str]:
    """Build valid HMAC headers for a given path."""
    ts_val = ts if ts is not None else int(time.time())
    ts_str = str(ts_val)
    sig = _compute_signature(ts_str, path, secret)
    return {
        "X-Agent-Signature": sig,
        "X-Agent-Timestamp": ts_str,
    }


# ── Tests ─────────────────────────────────────────────────────────────────────


class TestInternalAuthMiddleware:
    """Tests for the HMAC validation middleware."""

    @pytest.mark.asyncio
    async def test_valid_signature_passes(self):
        """Correct HMAC + fresh timestamp → 200 from the handler."""
        app = _make_app(secret="s3cr3t")
        headers = _make_headers("/api/sessions/list", "s3cr3t")

        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
            resp = await client.get("/api/sessions/list", headers=headers)

        assert resp.status_code == 200
        assert resp.json() == {"sessions": []}

    @pytest.mark.asyncio
    async def test_invalid_signature_rejected(self):
        """Wrong HMAC → 401."""
        app = _make_app(secret="correct-secret")
        ts_str = str(int(time.time()))
        bad_headers = {
            "X-Agent-Signature": "deadbeef" * 8,  # 64-char hex but wrong value
            "X-Agent-Timestamp": ts_str,
        }

        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
            resp = await client.get("/api/sessions/list", headers=bad_headers)

        assert resp.status_code == 401
        assert "invalid signature" in resp.json()["detail"]

    @pytest.mark.asyncio
    async def test_missing_headers_rejected(self):
        """No HMAC headers when secret is set → 401."""
        app = _make_app(secret="set-secret")

        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
            resp = await client.get("/api/sessions/list")  # no auth headers

        assert resp.status_code == 401
        assert "missing" in resp.json()["detail"]

    @pytest.mark.asyncio
    async def test_empty_secret_skips_validation(self):
        """AGENT_INTERNAL_SECRET empty → all requests pass without signature."""
        app = _make_app(secret="")  # dev mode

        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
            resp = await client.get("/api/sessions/list")  # no HMAC headers

        assert resp.status_code == 200

    @pytest.mark.asyncio
    async def test_old_timestamp_rejected(self):
        """Timestamp older than 60 seconds → 401."""
        app = _make_app(secret="ts-secret")
        stale_ts = int(time.time()) - 120  # 2 minutes ago
        headers = _make_headers("/api/sessions/list", "ts-secret", ts=stale_ts)

        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
            resp = await client.get("/api/sessions/list", headers=headers)

        assert resp.status_code == 401
        assert "too old" in resp.json()["detail"]

    @pytest.mark.asyncio
    async def test_non_session_path_bypasses_middleware(self):
        """Non-/api/sessions/ paths are never checked — no headers required."""
        app = _make_app(secret="strict-secret")

        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
            resp = await client.get("/api/rca/list")  # no HMAC headers

        assert resp.status_code == 200

    @pytest.mark.asyncio
    async def test_compute_signature_deterministic(self):
        """_compute_signature is deterministic for the same inputs."""
        sig1 = _compute_signature("1234567890", "/api/sessions/test", "secret")
        sig2 = _compute_signature("1234567890", "/api/sessions/test", "secret")
        assert sig1 == sig2

    @pytest.mark.asyncio
    async def test_different_path_different_signature(self):
        """Signatures are path-scoped — different paths produce different digests."""
        sig_a = _compute_signature("1234567890", "/api/sessions/a", "secret")
        sig_b = _compute_signature("1234567890", "/api/sessions/b", "secret")
        assert sig_a != sig_b
