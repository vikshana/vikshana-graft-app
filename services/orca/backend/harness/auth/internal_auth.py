"""HMAC validation middleware for internal Go gateway → Python service calls.

The Go plugin gateway signs every request to the internal API surface
(``/api/sessions``, ``/api/mcp``, ``/api/identity``, ``/api/rca``) with:

    X-Agent-Signature: HMAC-SHA256(method:timestamp:nonce:target:body_sha256:org_id, secret)
    X-Agent-Timestamp: <unix_timestamp>
    X-Agent-Nonce:     <random per-request token>

where ``target`` is the full request target — the *raw, percent-encoded*
path (ASGI ``raw_path``, not the decoded ``request.url.path``) plus the raw
query string — and ``org_id`` is the verbatim value of the
``X-Grafana-Org-Id`` header (or ``""`` if absent). This middleware validates
those headers.

The raw encoded path is used deliberately (see ``_raw_target_path`` below):
it is the exact bytes uvicorn received on the wire, matching what
``pkg/plugin/internal_signer.go`` signs via ``req.URL.EscapedPath()`` on the
Go side. Canonicalising on the decoded path would tie correctness to Go's
reverse proxy happening to re-derive an equivalent encoding from a decoded
string — signing the raw bytes on both sides removes that indirection
entirely.

When AGENT_INTERNAL_SECRET is empty (default in dev/test) validation is
skipped entirely so the service works without configuring a shared secret.

Security properties:
  - Replay protection: timestamp must be within
    ``_MAX_TIMESTAMP_SKEW_S`` seconds of server time, AND the nonce must not
    have been seen before within its cache TTL. The nonce is bound into the
    signed message, so an attacker cannot strip/replace it on a captured
    request without invalidating the signature.
  - Full request binding: the signature covers the HTTP method, exact
    request target (raw encoded path + raw query string), a SHA-256 digest
    of the raw request body, and the caller-asserted Grafana org ID — not
    just the path.
  - Algorithm: HMAC-SHA256 with a server-side secret, verified with
    ``hmac.compare_digest`` (constant-time).

Nonce cache caveat (see docs/harness-risk-review.md F7, F10): the replay
cache is an in-memory, single-process structure. The harness backend runs as
a single uvicorn process / single replica today, so this is sufficient. If
the service is ever scaled to multiple workers or replicas, this cache MUST
be replaced with a shared store (e.g. Redis) — otherwise replay protection
would only hold "per worker", not "per deployment".

Applied to all Go-proxied internal prefixes: ``/api/sessions``, ``/api/mcp``,
``/api/identity``, and ``/api/rca`` (see docs/harness-risk-review.md F4).
"""

from __future__ import annotations

import hashlib
import hmac
import os
import threading
import time
from typing import Callable

import structlog
from fastapi import Request, Response
from fastapi.responses import JSONResponse
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.types import ASGIApp

logger = structlog.get_logger()

# Timestamp freshness window. Tightened from the original 60s (F7) — the Go
# gateway and this service are expected to run with clocks in close sync
# (same docker network / NTP-synced hosts), so 30s comfortably absorbs clock
# skew and request latency without leaving a large replay window open.
_MAX_TIMESTAMP_SKEW_S = 30

# Nonce replay cache TTL. Must be at least 2x the timestamp skew window so a
# nonce recorded at (server_time - skew) is still remembered when a replay is
# attempted at up to (server_time + skew); the extra buffer absorbs
# processing latency and clock granularity.
_NONCE_CACHE_TTL_S = 90.0

# Bound the cache so an attacker who *does* hold a valid secret (compromised
# internal caller) cannot grow the process's memory unboundedly by spamming
# unique nonces. Oldest entries are evicted first once full.
_NONCE_CACHE_MAX_ENTRIES = 10_000

# Sane bounds on the nonce value itself — purely a defense-in-depth memory
# guard, not a primary security control (the signature already requires the
# shared secret to produce a valid nonce+signature pair).
_MIN_NONCE_LEN = 8
_MAX_NONCE_LEN = 128

# All internal API prefixes that the Go plugin gateway proxies to this
# service. Every one of these must carry a valid internal HMAC signature
# when AGENT_INTERNAL_SECRET is configured (see docs/harness-risk-review.md
# F4 — MCP & identity endpoints previously bypassed HMAC entirely).
_PROTECTED_PREFIXES: tuple[str, ...] = (
    "/api/sessions",
    "/api/mcp",
    "/api/identity",
    "/api/rca",
)


def _is_protected_path(path: str) -> bool:
    """Return True if *path* falls under one of the internal-only prefixes."""
    return any(path.startswith(prefix) for prefix in _PROTECTED_PREFIXES)


def _raw_target_path(request: Request) -> str:
    """Return the exact percent-encoded path as received on the wire.

    ``request.url.path`` is decoded by Starlette (ASGI ``scope["path"]`` is
    unquoted per spec) — using it for signature canonicalization ties
    correctness to Go's ``http.ReverseProxy`` happening to re-derive an
    encoding from the decoded string that round-trips back to the same
    bytes. Signing the *raw* encoded path instead removes that indirection:
    both sides sign exactly what was transmitted.

    uvicorn (both the h11 and httptools implementations) populates ASGI
    ``scope["raw_path"]`` with the undecoded path bytes straight off the
    wire, so this reads that directly rather than re-deriving it. Falls back
    to the decoded ``request.url.path`` if the ASGI server didn't populate
    ``raw_path`` (defensive only — uvicorn always sets it) or if it isn't
    valid ASCII (a malformed/adversarial request); either fallback simply
    yields a signature mismatch (fail closed to 401), never a crash.
    """
    raw_path = request.scope.get("raw_path")
    if raw_path:
        try:
            return raw_path.decode("ascii")
        except UnicodeDecodeError:
            pass
    return request.url.path


class _NonceCache:
    """Bounded, expiring in-memory cache of recently seen nonces.

    Provides replay defense for :class:`InternalAuthMiddleware`: a nonce
    that has already been recorded within its TTL window is rejected on
    reuse.

    The ``now`` parameter is threaded through explicitly (rather than the
    cache calling ``time.time()`` itself) so tests can exercise expiry
    deterministically without sleeping.
    """

    def __init__(self, ttl_s: float = _NONCE_CACHE_TTL_S, max_entries: int = _NONCE_CACHE_MAX_ENTRIES) -> None:
        self._ttl_s = ttl_s
        self._max_entries = max_entries
        self._entries: dict[str, float] = {}  # nonce -> expiry epoch seconds
        self._lock = threading.Lock()

    def seen_or_record(self, nonce: str, now: float) -> bool:
        """Check-and-record *nonce* atomically.

        Args:
            nonce: The nonce value to check.
            now: Current time (epoch seconds) — used both to evict expired
                entries and to compute this nonce's expiry.

        Returns:
            True if *nonce* was already recorded and is still within its TTL
            (i.e. this is a replay — caller should reject the request).
            False if *nonce* is new (or its prior entry has expired); it is
            recorded with a fresh expiry of ``now + ttl_s``.
        """
        with self._lock:
            self._evict_expired(now)
            if nonce in self._entries:
                return True
            if len(self._entries) >= self._max_entries:
                # Bound memory: evict the single oldest entry to make room.
                oldest = min(self._entries, key=self._entries.__getitem__)
                del self._entries[oldest]
            self._entries[nonce] = now + self._ttl_s
            return False

    def _evict_expired(self, now: float) -> None:
        expired = [n for n, expiry in self._entries.items() if expiry <= now]
        for n in expired:
            del self._entries[n]

    def __len__(self) -> int:
        with self._lock:
            return len(self._entries)


class InternalAuthMiddleware(BaseHTTPMiddleware):
    """Validates X-Agent-Signature HMAC on internal API requests.

    Protects ``/api/sessions``, ``/api/mcp``, ``/api/identity``, and
    ``/api/rca`` (see ``_PROTECTED_PREFIXES``). When AGENT_INTERNAL_SECRET is
    empty the middleware is a transparent pass-through (dev mode). When set,
    all requests to a protected prefix must carry a valid signature, a fresh
    timestamp, and an unseen nonce, or they receive a 401 response.

    Args:
        app: The ASGI app to wrap.
        secret: HMAC secret. Reads AGENT_INTERNAL_SECRET from env if not given.
        nonce_cache_ttl_s: Override for the nonce replay-cache TTL (seconds).
            Exposed mainly for tests that need to exercise cache expiry
            without sleeping for the production default.
    """

    def __init__(
        self,
        app: ASGIApp,
        secret: str = "",
        nonce_cache_ttl_s: float = _NONCE_CACHE_TTL_S,
    ) -> None:
        super().__init__(app)
        self._secret = secret or os.environ.get("AGENT_INTERNAL_SECRET", "")
        self._nonce_cache = _NonceCache(ttl_s=nonce_cache_ttl_s)

    async def dispatch(self, request: Request, call_next: Callable) -> Response:
        """Validate HMAC on protected internal routes; pass through all others.

        Args:
            request: Incoming HTTP request.
            call_next: Next middleware/handler in the chain.

        Returns:
            401 JSONResponse on validation failure; otherwise the handler's response.
        """
        path = request.url.path

        # Only enforce on the internal API prefixes — everything else
        # (public health checks, webhooks, etc.) is unrestricted here.
        if not _is_protected_path(path):
            return await call_next(request)

        # Dev mode: no secret configured → skip validation
        if not self._secret:
            return await call_next(request)

        # Extract headers
        signature = request.headers.get("X-Agent-Signature", "")
        timestamp_str = request.headers.get("X-Agent-Timestamp", "")
        nonce = request.headers.get("X-Agent-Nonce", "")

        if not signature or not timestamp_str or not nonce:
            logger.warning(
                "internal_auth_missing_headers",
                path=path,
                has_sig=bool(signature),
                has_ts=bool(timestamp_str),
                has_nonce=bool(nonce),
            )
            return _unauthorized("missing HMAC headers")

        if not (_MIN_NONCE_LEN <= len(nonce) <= _MAX_NONCE_LEN):
            logger.warning("internal_auth_invalid_nonce_length", path=path, nonce_len=len(nonce))
            return _unauthorized("invalid nonce")

        # Validate timestamp freshness
        try:
            ts = int(timestamp_str)
        except ValueError:
            return _unauthorized("invalid timestamp")

        now = time.time()
        skew = abs(now - ts)
        if skew > _MAX_TIMESTAMP_SKEW_S:
            logger.warning(
                "internal_auth_stale_timestamp",
                path=path,
                skew_s=skew,
                max_skew_s=_MAX_TIMESTAMP_SKEW_S,
            )
            return _unauthorized("timestamp too old")

        # Bind the full request: method, exact target (raw encoded path +
        # query), body digest, and the caller-asserted org ID. The raw
        # encoded path (not the ASGI-decoded `path` used for routing above)
        # is used so this matches the Go signer's req.URL.EscapedPath() byte
        # for byte — see _raw_target_path and internal_signer.go.
        body = await request.body()
        body_hash = hashlib.sha256(body).hexdigest()
        org_id = request.headers.get("X-Grafana-Org-Id", "")
        raw_path = _raw_target_path(request)
        target = raw_path
        if request.url.query:
            target = f"{raw_path}?{request.url.query}"

        expected = _compute_signature(
            method=request.method,
            target=target,
            timestamp=timestamp_str,
            nonce=nonce,
            body_hash=body_hash,
            org_id=org_id,
            secret=self._secret,
        )

        # Constant-time comparison — do this before touching the nonce cache
        # so an unauthenticated caller (no valid secret) can never consume
        # replay-cache capacity, only callers who can already produce a
        # correct signature.
        if not hmac.compare_digest(expected, signature):
            logger.warning("internal_auth_invalid_signature", path=path)
            return _unauthorized("invalid signature")

        # Replay defense: reject a signature+nonce pair that's already been
        # used, even if it's still within the timestamp freshness window.
        if self._nonce_cache.seen_or_record(nonce, now):
            logger.warning("internal_auth_replayed_nonce", path=path)
            return _unauthorized("replayed request")

        return await call_next(request)


def _unauthorized(detail: str) -> JSONResponse:
    """Build the standard 401 response body used by every rejection path."""
    return JSONResponse(
        status_code=401,
        content={"error": "unauthorized", "detail": detail},
    )


def _compute_signature(
    method: str,
    target: str,
    timestamp: str,
    nonce: str,
    body_hash: str,
    org_id: str,
    secret: str,
) -> str:
    """Compute the expected HMAC-SHA256 signature.

    Args:
        method: HTTP method (e.g. "GET", "POST"), matched verbatim against
            ``request.method`` — callers must send it upper-cased.
        target: Full request target — the raw percent-encoded path (as
            transmitted on the wire, e.g. Go's ``req.URL.EscapedPath()`` /
            Python's ASGI ``raw_path``, NOT the decoded path) plus
            ``?``-prefixed raw query string when present (e.g.
            ``/api/sessions?limit=50``).
        timestamp: Unix timestamp string.
        nonce: Per-request random token bound into the signature so it
            cannot be stripped or altered without invalidating it.
        body_hash: Lowercase hex SHA-256 digest of the raw request body
            (``hashlib.sha256(b"").hexdigest()`` for an empty body).
        org_id: Verbatim value of the ``X-Grafana-Org-Id`` header, or ``""``
            if absent.
        secret: Shared HMAC secret.

    Returns:
        Lowercase hex-encoded HMAC-SHA256 digest.
    """
    message = f"{method}:{timestamp}:{nonce}:{target}:{body_hash}:{org_id}".encode()
    mac = hmac.new(secret.encode(), message, hashlib.sha256)
    return mac.hexdigest()
