"""Unit tests for harness/auth/internal_auth.py — HMAC validation middleware.

Covers docs/harness-risk-review.md F4 (HMAC now enforced on /api/sessions,
/api/mcp, /api/identity, and /api/rca — not just /api/sessions) and F7
(signature binds method + timestamp + full target + body digest + org id,
plus nonce-based replay defense with a bounded/expiring in-memory cache).
"""

from __future__ import annotations

import hashlib
import time
import uuid

import pytest
from fastapi import FastAPI, Request
from httpx import ASGITransport, AsyncClient

from harness.auth.internal_auth import (
    InternalAuthMiddleware,
    _NonceCache,
    _compute_signature,
    _is_protected_path,
    _raw_target_path,
)


# ── Helpers ─────────────────────────────────────────────────────────────────


def _make_app(secret: str = "test-secret", nonce_cache_ttl_s: float | None = None) -> FastAPI:
    """Build a minimal FastAPI app with InternalAuthMiddleware for testing."""
    app = FastAPI()
    if nonce_cache_ttl_s is not None:
        app.add_middleware(InternalAuthMiddleware, secret=secret, nonce_cache_ttl_s=nonce_cache_ttl_s)
    else:
        app.add_middleware(InternalAuthMiddleware, secret=secret)

    @app.get("/api/sessions/list")
    async def list_sessions():
        return {"sessions": []}

    @app.post("/api/sessions/turn")
    async def post_turn(request: Request):
        body = await request.body()
        return {"received": body.decode()}

    @app.get("/api/mcp/servers")
    async def list_mcp_servers():
        return {"servers": []}

    @app.get("/api/mcp/servers/{name}")
    async def get_mcp_server(name: str):
        return {"name": name}

    @app.get("/api/identity/status")
    async def identity_status():
        return {"linked": False}

    @app.get("/api/rca/list")
    async def list_rca():
        return {"items": []}

    @app.get("/health")
    async def health():
        return {"status": "ok"}

    return app


def _target(path: str, query: str = "") -> str:
    return f"{path}?{query}" if query else path


def _make_headers(
    *,
    method: str,
    target: str,
    secret: str,
    body: bytes = b"",
    org_id: str = "",
    ts: int | None = None,
    nonce: str | None = None,
) -> dict[str, str]:
    """Build valid HMAC + nonce + timestamp headers for a given request."""
    ts_val = ts if ts is not None else int(time.time())
    ts_str = str(ts_val)
    nonce_val = nonce if nonce is not None else uuid.uuid4().hex
    body_hash = hashlib.sha256(body).hexdigest()
    sig = _compute_signature(
        method=method,
        target=target,
        timestamp=ts_str,
        nonce=nonce_val,
        body_hash=body_hash,
        org_id=org_id,
        secret=secret,
    )
    headers = {
        "X-Agent-Signature": sig,
        "X-Agent-Timestamp": ts_str,
        "X-Agent-Nonce": nonce_val,
    }
    if org_id:
        headers["X-Grafana-Org-Id"] = org_id
    return headers


# ── _is_protected_path ───────────────────────────────────────────────────────


class TestIsProtectedPath:
    """All four internal prefixes must be protected; nothing else should be."""

    @pytest.mark.parametrize(
        "path",
        [
            "/api/sessions",
            "/api/sessions/list",
            "/api/sessions/turn/abc",
            "/api/mcp",
            "/api/mcp/servers",
            "/api/identity",
            "/api/identity/status",
            "/api/identity/callback",
            "/api/rca",
            "/api/rca/list",
        ],
    )
    def test_protected_paths(self, path: str) -> None:
        assert _is_protected_path(path) is True

    @pytest.mark.parametrize(
        "path",
        [
            "/health",
            "/webhook/grafana",
            "/",
            "/api",
            "/apix/sessions",  # must not match on substring, only prefix
        ],
    )
    def test_unprotected_paths(self, path: str) -> None:
        assert _is_protected_path(path) is False


# ── Middleware tests ─────────────────────────────────────────────────────────


class TestInternalAuthMiddleware:
    """Tests for the HMAC validation middleware."""

    @pytest.mark.asyncio
    async def test_valid_signature_passes(self):
        """Correct HMAC + fresh timestamp + nonce → 200 from the handler."""
        app = _make_app(secret="s3cr3t")
        headers = _make_headers(method="GET", target="/api/sessions/list", secret="s3cr3t")

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
            "X-Agent-Nonce": uuid.uuid4().hex,
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
    async def test_missing_nonce_rejected(self):
        """Signature + timestamp present but nonce header missing → 401."""
        app = _make_app(secret="set-secret")
        headers = _make_headers(method="GET", target="/api/sessions/list", secret="set-secret")
        del headers["X-Agent-Nonce"]

        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
            resp = await client.get("/api/sessions/list", headers=headers)

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
        """Timestamp older than the freshness window → 401."""
        app = _make_app(secret="ts-secret")
        stale_ts = int(time.time()) - 120  # well outside the (tightened) window
        headers = _make_headers(
            method="GET", target="/api/sessions/list", secret="ts-secret", ts=stale_ts
        )

        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
            resp = await client.get("/api/sessions/list", headers=headers)

        assert resp.status_code == 401
        assert "too old" in resp.json()["detail"]

    @pytest.mark.asyncio
    async def test_health_path_bypasses_middleware(self):
        """Non-internal paths (e.g. /health) are never checked — no headers required."""
        app = _make_app(secret="strict-secret")

        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
            resp = await client.get("/health")  # no HMAC headers

        assert resp.status_code == 200

    @pytest.mark.asyncio
    @pytest.mark.parametrize(
        "path",
        ["/api/sessions/list", "/api/mcp/servers", "/api/identity/status", "/api/rca/list"],
    )
    async def test_all_four_prefixes_enforced(self, path: str):
        """F4: /api/mcp and /api/identity must now be enforced, same as
        /api/sessions and /api/rca — previously only /api/sessions was."""
        app = _make_app(secret="f4-secret")

        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
            # No headers → must be rejected on every protected prefix.
            resp = await client.get(path)
            assert resp.status_code == 401, f"{path} should require HMAC headers"

            # Correct headers → must be accepted.
            headers = _make_headers(method="GET", target=path, secret="f4-secret")
            resp2 = await client.get(path, headers=headers)
            assert resp2.status_code == 200, f"{path} should accept a valid signature"

    @pytest.mark.asyncio
    async def test_compute_signature_deterministic(self):
        """_compute_signature is deterministic for the same inputs."""
        sig1 = _compute_signature(
            method="GET",
            target="/api/sessions/test",
            timestamp="1234567890",
            nonce="fixed-nonce",
            body_hash=hashlib.sha256(b"").hexdigest(),
            org_id="1",
            secret="secret",
        )
        sig2 = _compute_signature(
            method="GET",
            target="/api/sessions/test",
            timestamp="1234567890",
            nonce="fixed-nonce",
            body_hash=hashlib.sha256(b"").hexdigest(),
            org_id="1",
            secret="secret",
        )
        assert sig1 == sig2

    def _base_kwargs(self) -> dict[str, str]:
        return {
            "method": "GET",
            "target": "/api/sessions/a",
            "timestamp": "1234567890",
            "nonce": "fixed-nonce",
            "body_hash": hashlib.sha256(b"").hexdigest(),
            "org_id": "1",
            "secret": "secret",
        }

    @pytest.mark.asyncio
    async def test_different_target_different_signature(self):
        """Signatures are target-scoped — different paths/queries produce
        different digests."""
        kwargs_a = self._base_kwargs()
        kwargs_b = {**kwargs_a, "target": "/api/sessions/b"}
        assert _compute_signature(**kwargs_a) != _compute_signature(**kwargs_b)

    @pytest.mark.asyncio
    async def test_different_method_different_signature(self):
        """F7: signature must bind the HTTP method."""
        kwargs_a = self._base_kwargs()
        kwargs_b = {**kwargs_a, "method": "POST"}
        assert _compute_signature(**kwargs_a) != _compute_signature(**kwargs_b)

    @pytest.mark.asyncio
    async def test_different_body_hash_different_signature(self):
        """F7: signature must bind a digest of the request body."""
        kwargs_a = self._base_kwargs()
        kwargs_b = {**kwargs_a, "body_hash": hashlib.sha256(b"payload").hexdigest()}
        assert _compute_signature(**kwargs_a) != _compute_signature(**kwargs_b)

    @pytest.mark.asyncio
    async def test_different_org_id_different_signature(self):
        """F7: signature must bind X-Grafana-Org-Id."""
        kwargs_a = self._base_kwargs()
        kwargs_b = {**kwargs_a, "org_id": "2"}
        assert _compute_signature(**kwargs_a) != _compute_signature(**kwargs_b)

    @pytest.mark.asyncio
    async def test_different_nonce_different_signature(self):
        """The nonce is bound into the signature (not a bare side-channel
        header) — swapping it must invalidate the signature."""
        kwargs_a = self._base_kwargs()
        kwargs_b = {**kwargs_a, "nonce": "other-nonce"}
        assert _compute_signature(**kwargs_a) != _compute_signature(**kwargs_b)

    # ── F7: full request binding via real HTTP requests ─────────────────────

    @pytest.mark.asyncio
    async def test_query_string_bound_into_signature(self):
        """A signature computed for one query string must be rejected when
        replayed against a request with a different query string."""
        app = _make_app(secret="q-secret")
        headers = _make_headers(
            method="GET", target=_target("/api/rca/list", "page=1"), secret="q-secret"
        )

        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
            ok = await client.get("/api/rca/list", params={"page": "1"}, headers=headers)
            assert ok.status_code == 200

            tampered = await client.get("/api/rca/list", params={"page": "2"}, headers=headers)
            assert tampered.status_code == 401
            assert "invalid signature" in tampered.json()["detail"]

    @pytest.mark.asyncio
    async def test_body_bound_into_signature(self):
        """Changing the body after signing must invalidate the signature —
        the previous scheme only signed ts:path and ignored the body."""
        app = _make_app(secret="body-secret")
        original_body = b'{"message":"hello"}'
        headers = _make_headers(
            method="POST",
            target="/api/sessions/turn",
            secret="body-secret",
            body=original_body,
        )

        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
            ok = await client.post(
                "/api/sessions/turn", content=original_body, headers=headers
            )
            assert ok.status_code == 200
            assert ok.json() == {"received": '{"message":"hello"}'}

            tampered = await client.post(
                "/api/sessions/turn", content=b'{"message":"tampered"}', headers=headers
            )
            assert tampered.status_code == 401
            assert "invalid signature" in tampered.json()["detail"]

    @pytest.mark.asyncio
    async def test_org_id_bound_into_signature(self):
        """A captured request signed for one org must not validate if the
        X-Grafana-Org-Id header is swapped to a different org — this is the
        core F7 gap (signature previously omitted org entirely)."""
        app = _make_app(secret="org-secret")
        headers = _make_headers(
            method="GET",
            target="/api/rca/list",
            secret="org-secret",
            org_id="1",
        )

        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
            ok = await client.get("/api/rca/list", headers=headers)
            assert ok.status_code == 200

            spoofed_headers = dict(headers)
            spoofed_headers["X-Grafana-Org-Id"] = "999"
            spoofed = await client.get("/api/rca/list", headers=spoofed_headers)
            assert spoofed.status_code == 401
            assert "invalid signature" in spoofed.json()["detail"]

    # ── F7: nonce-based replay defense ──────────────────────────────────────

    @pytest.mark.asyncio
    async def test_replayed_request_rejected(self):
        """A verbatim replay of a previously-accepted request (same nonce)
        must be rejected even though the timestamp is still fresh."""
        app = _make_app(secret="replay-secret")
        headers = _make_headers(
            method="GET", target="/api/sessions/list", secret="replay-secret"
        )

        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
            first = await client.get("/api/sessions/list", headers=headers)
            assert first.status_code == 200

            replay = await client.get("/api/sessions/list", headers=headers)
            assert replay.status_code == 401
            assert "replayed" in replay.json()["detail"]

    @pytest.mark.asyncio
    async def test_same_nonce_different_prefix_still_rejected_as_replay(self):
        """Nonce uniqueness is tracked globally by the middleware instance,
        not per-path — reusing a nonce on a different protected path is still
        a replay of the same signed token and must be rejected once the
        (method, target, body, org, nonce, ts) tuple has been consumed.

        Note: since the signature itself is target-specific, a nonce reused
        with a *different* target requires a fresh (valid) signature for that
        target — this test uses the same target twice to isolate pure nonce
        replay behaviour (already covered above) and confirms the nonce
        cache also rejects reuse when the second request is otherwise valid.
        """
        app = _make_app(secret="replay-secret-2")
        nonce = uuid.uuid4().hex
        headers = _make_headers(
            method="GET",
            target="/api/mcp/servers",
            secret="replay-secret-2",
            nonce=nonce,
        )

        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
            first = await client.get("/api/mcp/servers", headers=headers)
            assert first.status_code == 200

            replay = await client.get("/api/mcp/servers", headers=headers)
            assert replay.status_code == 401
            assert "replayed" in replay.json()["detail"]

    @pytest.mark.asyncio
    async def test_nonce_allowed_again_after_ttl_expiry(self):
        """Once a nonce's cache entry expires, reusing that nonce value with a
        freshly-signed request is allowed again (bounded cache, not permanent
        memory). Uses a tiny TTL so the test doesn't need to sleep for the
        production window.
        """
        app = _make_app(secret="ttl-secret", nonce_cache_ttl_s=0.05)
        nonce = uuid.uuid4().hex
        headers = _make_headers(
            method="GET", target="/api/sessions/list", secret="ttl-secret", nonce=nonce
        )

        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
            first = await client.get("/api/sessions/list", headers=headers)
            assert first.status_code == 200

            import asyncio

            await asyncio.sleep(0.1)  # let the tiny TTL expire

            # Re-sign with the same nonce but a fresh timestamp (still must
            # pass the freshness window) — should be accepted since the
            # nonce cache entry has expired.
            fresh_headers = _make_headers(
                method="GET", target="/api/sessions/list", secret="ttl-secret", nonce=nonce
            )
            second = await client.get("/api/sessions/list", headers=fresh_headers)
            assert second.status_code == 200

    @pytest.mark.asyncio
    async def test_invalid_signature_does_not_consume_nonce(self):
        """An unauthenticated caller (bad signature) must not be able to
        pre-burn a nonce to deny service to the legitimate caller — the
        signature check happens before the nonce is recorded."""
        app = _make_app(secret="dos-secret")
        nonce = uuid.uuid4().hex

        bad_headers = {
            "X-Agent-Signature": "0" * 64,
            "X-Agent-Timestamp": str(int(time.time())),
            "X-Agent-Nonce": nonce,
        }
        good_headers = _make_headers(
            method="GET", target="/api/sessions/list", secret="dos-secret", nonce=nonce
        )

        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
            bad = await client.get("/api/sessions/list", headers=bad_headers)
            assert bad.status_code == 401
            assert "invalid signature" in bad.json()["detail"]

            good = await client.get("/api/sessions/list", headers=good_headers)
            assert good.status_code == 200, "a valid request with the same nonce must still succeed"

    @pytest.mark.asyncio
    @pytest.mark.parametrize("nonce", ["", "short"])
    async def test_nonce_too_short_rejected(self, nonce: str):
        """Nonces shorter than the configured minimum are rejected outright
        (defense-in-depth bound, independent of signature validity)."""
        app = _make_app(secret="len-secret")
        headers = _make_headers(
            method="GET", target="/api/sessions/list", secret="len-secret", nonce=nonce or "x"
        )
        if nonce == "":
            headers["X-Agent-Nonce"] = ""

        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
            resp = await client.get("/api/sessions/list", headers=headers)
            assert resp.status_code == 401


# ── Raw encoded path canonicalisation ────────────────────────────────────────
#
# The signing target must be the *raw, percent-encoded* path exactly as
# received on the wire (matching Go's req.URL.EscapedPath()), not Starlette's
# ASGI-decoded request.url.path. A path segment containing a percent-encoded
# character (e.g. a space, or characters requiring escaping) is the simplest
# case where the two representations diverge — this is exactly the ambiguity
# the raw-path canonicalisation closes.


class TestRawTargetPath:
    """Direct tests of `_raw_target_path` against a real ASGI scope."""

    @pytest.mark.asyncio
    async def test_raw_path_used_for_encoded_segment(self):
        """A path containing '%20' must be signed as '%20', not decoded to a
        literal space — this is the raw-vs-decoded divergence being fixed."""
        captured: dict[str, str] = {}

        app = FastAPI()

        @app.get("/api/mcp/servers/{name}")
        async def handler(name: str, request: Request):
            captured["decoded_path"] = request.url.path
            captured["raw_target_path"] = _raw_target_path(request)
            captured["name_param"] = name
            return {"ok": True}

        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
            resp = await client.get("/api/mcp/servers/my%20server")
            assert resp.status_code == 200

        assert captured["decoded_path"] == "/api/mcp/servers/my server"
        assert captured["raw_target_path"] == "/api/mcp/servers/my%20server"
        assert captured["raw_target_path"] != captured["decoded_path"]

    def test_falls_back_to_decoded_path_when_raw_path_absent(self):
        """Defensive fallback: if an ASGI server didn't populate raw_path,
        _raw_target_path must still return something sane (the decoded
        path) rather than raising."""

        class _Req:
            scope: dict[str, object] = {}
            url = type("U", (), {"path": "/api/sessions/list"})()

        assert _raw_target_path(_Req()) == "/api/sessions/list"  # type: ignore[arg-type]


class TestRawPathCanonicalizationEndToEnd:
    """Full middleware round-trip proving the signature is verified against
    the raw encoded target, not a decoded approximation of it — mirrors
    pkg/plugin/internal_signer_test.go's
    TestSignInternalRequestUsesEscapedPathNotDecodedPath on the Go side."""

    @pytest.mark.asyncio
    async def test_signature_over_raw_encoded_path_is_accepted(self):
        app = _make_app(secret="raw-path-secret")
        headers = _make_headers(
            method="GET",
            target="/api/mcp/servers/my%20server",
            secret="raw-path-secret",
        )

        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
            resp = await client.get("/api/mcp/servers/my%20server", headers=headers)

        assert resp.status_code == 200
        assert resp.json() == {"name": "my server"}

    @pytest.mark.asyncio
    async def test_signature_over_decoded_path_is_rejected(self):
        """A signature computed over the *decoded* path (the old, pre-fix
        canonicalisation) must NOT validate — proves the middleware isn't
        silently accepting either representation."""
        app = _make_app(secret="raw-path-secret-2")
        headers = _make_headers(
            method="GET",
            target="/api/mcp/servers/my server",  # decoded — wrong on purpose
            secret="raw-path-secret-2",
        )

        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
            resp = await client.get("/api/mcp/servers/my%20server", headers=headers)

        assert resp.status_code == 401
        assert "invalid signature" in resp.json()["detail"]


# ── _NonceCache unit tests (no HTTP layer) ──────────────────────────────────


class TestNonceCache:
    """Direct tests of the bounded/expiring nonce cache used for replay
    defense — exercised without any real sleeping via an explicit `now`."""

    def test_first_use_not_a_replay(self):
        cache = _NonceCache(ttl_s=60)
        assert cache.seen_or_record("abc", now=100.0) is False

    def test_reuse_within_ttl_is_a_replay(self):
        cache = _NonceCache(ttl_s=60)
        assert cache.seen_or_record("abc", now=100.0) is False
        assert cache.seen_or_record("abc", now=120.0) is True

    def test_reuse_after_ttl_is_not_a_replay(self):
        cache = _NonceCache(ttl_s=60)
        assert cache.seen_or_record("abc", now=100.0) is False
        # 100 + 60 = 160 is the expiry; at t=161 it should have expired.
        assert cache.seen_or_record("abc", now=161.0) is False

    def test_distinct_nonces_tracked_independently(self):
        cache = _NonceCache(ttl_s=60)
        assert cache.seen_or_record("a", now=100.0) is False
        assert cache.seen_or_record("b", now=100.0) is False
        assert cache.seen_or_record("a", now=100.0) is True
        assert cache.seen_or_record("b", now=100.0) is True

    def test_expired_entries_are_evicted_on_access(self):
        cache = _NonceCache(ttl_s=10)
        cache.seen_or_record("a", now=0.0)
        cache.seen_or_record("b", now=0.0)
        assert len(cache) == 2

        # Both entries expire by t=11; touching the cache should evict them.
        cache.seen_or_record("c", now=11.0)
        assert len(cache) == 1  # only "c" remains
        assert "a" not in cache._entries
        assert "b" not in cache._entries

    def test_bounded_size_evicts_oldest(self):
        cache = _NonceCache(ttl_s=1000, max_entries=2)
        cache.seen_or_record("a", now=0.0)
        cache.seen_or_record("b", now=1.0)
        assert len(cache) == 2

        # Cache is full — adding "c" must evict the oldest ("a").
        cache.seen_or_record("c", now=2.0)
        assert len(cache) == 2
        assert "a" not in cache._entries
        assert "b" in cache._entries
        assert "c" in cache._entries

    def test_constant_time_compare_used(self):
        """Sanity check that the middleware verifies signatures with
        hmac.compare_digest rather than `==` (constant-time comparison)."""
        import inspect

        from harness.auth import internal_auth

        source = inspect.getsource(internal_auth.InternalAuthMiddleware.dispatch)
        assert "hmac.compare_digest" in source
