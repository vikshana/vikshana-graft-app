"""Auth chain types shared across all auth path implementations."""

from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum
from typing import Any


class AuthMode(str, Enum):
    """Authentication mode used for a session or tool call."""

    USER_OBO = "user_obo"
    SESSION_PASSTHROUGH = "session_passthrough"
    SERVICE_ACCOUNT = "service_account"


@dataclass(frozen=True)
class GrafanaCredential:
    """Resolved credential used to call Grafana datasource APIs.

    Attributes:
        token: Bearer token to send in the Authorization header.
        auth_mode: Which auth path produced this credential.
        user_id: Optional Grafana user ID (set when auth is user-attributed).
        org_id: Grafana organisation ID to scope queries to.
    """

    token: str
    auth_mode: AuthMode
    user_id: str | None = None
    org_id: int | None = None

    def redacted_repr(self) -> str:
        """Return a log-safe representation with the token redacted.

        Returns:
            String suitable for logging that never leaks the token value.
        """
        prefix = self.token[:6] if len(self.token) >= 6 else "***"
        return (
            f"GrafanaCredential(auth_mode={self.auth_mode}, "
            f"user_id={self.user_id}, org_id={self.org_id}, "
            f"token={prefix}...REDACTED)"
        )


@dataclass
class AuthRequestContext:
    """Input context used by the auth chain resolver.

    Attributes:
        user_entra_token: Raw Entra ID token from the incoming request, if any.
        grafana_session_cookie: Grafana session cookie, if forwarded by the gateway.
        org_id: Grafana organisation ID extracted from X-Grafana-Org-Id header.
        team_id: Grafana team ID (used to select per-team service account).
        user_id: Internal user identifier (after identity lookup).
        request_headers: Original HTTP request headers (for session passthrough).
    """

    user_entra_token: str | None = None
    grafana_session_cookie: str | None = None
    org_id: int | None = None
    team_id: int | None = None
    user_id: str | None = None
    request_headers: dict[str, str] = field(default_factory=dict)


class AuthError(Exception):
    """Base class for authentication errors."""


class TokenExpiredError(AuthError):
    """The token has expired and cannot be refreshed."""


class TokenRevokedError(AuthError):
    """The token has been explicitly revoked."""


class OBOExchangeError(AuthError):
    """On-Behalf-Of exchange with the OIDC provider failed."""


class ReauthRequiredError(AuthError):
    """Interactive session must re-authenticate before proceeding.

    Raised when no valid credential can be resolved and user interaction
    is required.  The caller should transition the session to
    ``paused/reauth_required`` and emit a ``reauth_required`` SSE event.
    """
