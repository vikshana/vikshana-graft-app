"""Session passthrough auth path.

This is Fallback A in the auth chain: the Go gateway forwards the user's
Grafana session cookie, and the agent uses it for the duration of the
interactive turn.

Long-running turns that receive a 401 from Grafana pause the session with
a ``reauth_required`` event to the frontend.  The session is never retried
automatically on 401.

Usage flow:
    1. Gateway includes the Grafana session cookie in X-Grafana-Session header.
    2. ``resolve_session_passthrough`` builds a GrafanaCredential from it.
    3. On 401 from any Grafana API call, the caller must raise ReauthRequiredError.
       This is signalled by checking the response status via ``check_grafana_response``.
"""

from __future__ import annotations

import structlog

from harness.auth.types import (
    AuthMode,
    AuthRequestContext,
    GrafanaCredential,
    ReauthRequiredError,
)

logger = structlog.get_logger()

# Header name the Go gateway uses to forward the Grafana session
_SESSION_HEADER = "X-Grafana-Session"


def resolve_session_passthrough(ctx: AuthRequestContext) -> GrafanaCredential:
    """Build a GrafanaCredential from a forwarded Grafana session cookie.

    Args:
        ctx: Auth request context containing request headers.

    Returns:
        GrafanaCredential with auth_mode=SESSION_PASSTHROUGH.

    Raises:
        ReauthRequiredError: If no session cookie is present in the context.
    """
    # Check the forwarded header first, then fall back to cookie
    session_value = ctx.request_headers.get(_SESSION_HEADER, "")
    if not session_value and ctx.grafana_session_cookie:
        session_value = ctx.grafana_session_cookie

    if not session_value:
        raise ReauthRequiredError(
            "No Grafana session available for passthrough auth"
        )

    logger.bind(user_id=ctx.user_id, org_id=ctx.org_id).info(
        "session_passthrough_resolved"
    )
    return GrafanaCredential(
        token=session_value,
        auth_mode=AuthMode.SESSION_PASSTHROUGH,
        user_id=ctx.user_id,
        org_id=ctx.org_id,
    )


def check_grafana_response(status_code: int, user_id: str | None) -> None:
    """Check a Grafana API response status and raise on 401.

    This must be called by every tool that uses session passthrough credentials
    so that 401s are surfaced as ReauthRequiredError rather than silently
    retried or swallowed.

    Args:
        status_code: HTTP status code from the Grafana API response.
        user_id: User identifier for logging context.

    Raises:
        ReauthRequiredError: If the status code is 401 (session expired).
    """
    if status_code == 401:
        logger.bind(user_id=user_id).warning("grafana_session_expired_401")
        raise ReauthRequiredError(
            "Grafana session has expired. Re-authentication required."
        )
