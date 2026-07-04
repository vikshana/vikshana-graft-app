"""HMAC validation middleware for internal Go gateway → Python service calls.

The Go plugin gateway signs every request to /api/sessions/* with:
  X-Agent-Signature: HMAC-SHA256(timestamp + ":" + path, secret)
  X-Agent-Timestamp: <unix_timestamp>

This middleware validates those headers.  When AGENT_INTERNAL_SECRET is empty
(default in dev/test) validation is skipped entirely so the service works
without configuring a shared secret.

Applied only to /api/sessions/* paths.  Existing /api/rca/* paths bypass it
for backward compatibility.

Security properties:
  - Replay protection: timestamp must be within 60s of server time
  - Path binding: signature covers the exact request path
  - Algorithm: HMAC-SHA256 with a server-side secret
"""

from __future__ import annotations

import hashlib
import hmac
import os
import time
from typing import Callable

import structlog
from fastapi import Request, Response
from fastapi.responses import JSONResponse
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.types import ASGIApp

logger = structlog.get_logger()

_MAX_TIMESTAMP_SKEW_S = 60
_SESSIONS_PREFIX = "/api/sessions"


class InternalAuthMiddleware(BaseHTTPMiddleware):
    """Validates X-Agent-Signature HMAC on /api/sessions/* requests.

    When AGENT_INTERNAL_SECRET is empty the middleware is a transparent pass-
    through (dev mode).  When set, all requests to /api/sessions/* must carry
    a valid signature or they receive a 401 response.

    Args:
        app: The ASGI app to wrap.
        secret: HMAC secret.  Reads AGENT_INTERNAL_SECRET from env if not given.
    """

    def __init__(self, app: ASGIApp, secret: str = "") -> None:
        super().__init__(app)
        self._secret = secret or os.environ.get("AGENT_INTERNAL_SECRET", "")

    async def dispatch(self, request: Request, call_next: Callable) -> Response:
        """Validate HMAC on session routes; pass through all other paths.

        Args:
            request: Incoming HTTP request.
            call_next: Next middleware/handler in the chain.

        Returns:
            401 JSONResponse on validation failure; otherwise the handler's response.
        """
        path = request.url.path

        # Only enforce on /api/sessions/* — all other paths are unrestricted
        if not path.startswith(_SESSIONS_PREFIX):
            return await call_next(request)

        # Dev mode: no secret configured → skip validation
        if not self._secret:
            return await call_next(request)

        # Extract headers
        signature = request.headers.get("X-Agent-Signature", "")
        timestamp_str = request.headers.get("X-Agent-Timestamp", "")

        if not signature or not timestamp_str:
            logger.warning(
                "internal_auth_missing_headers",
                path=path,
                has_sig=bool(signature),
                has_ts=bool(timestamp_str),
            )
            return JSONResponse(
                status_code=401,
                content={"error": "unauthorized", "detail": "missing HMAC headers"},
            )

        # Validate timestamp freshness
        try:
            ts = int(timestamp_str)
        except ValueError:
            return JSONResponse(
                status_code=401,
                content={"error": "unauthorized", "detail": "invalid timestamp"},
            )

        skew = abs(time.time() - ts)
        if skew > _MAX_TIMESTAMP_SKEW_S:
            logger.warning(
                "internal_auth_stale_timestamp",
                path=path,
                skew_s=skew,
                max_skew_s=_MAX_TIMESTAMP_SKEW_S,
            )
            return JSONResponse(
                status_code=401,
                content={"error": "unauthorized", "detail": "timestamp too old"},
            )

        # Validate HMAC
        expected = _compute_signature(timestamp_str, path, self._secret)
        if not hmac.compare_digest(expected, signature):
            logger.warning("internal_auth_invalid_signature", path=path)
            return JSONResponse(
                status_code=401,
                content={"error": "unauthorized", "detail": "invalid signature"},
            )

        return await call_next(request)


def _compute_signature(timestamp: str, path: str, secret: str) -> str:
    """Compute the expected HMAC-SHA256 signature.

    Args:
        timestamp: Unix timestamp string.
        path: Request path string.
        secret: Shared HMAC secret.

    Returns:
        Lowercase hex-encoded HMAC-SHA256 digest.
    """
    message = f"{timestamp}:{path}".encode()
    mac = hmac.new(secret.encode(), message, hashlib.sha256)
    return mac.hexdigest()
