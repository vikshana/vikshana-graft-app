"""Service account auth path (Fallback B).

Uses per-team Grafana service account tokens.  This is the last-resort auth
mode and is always used for:
  - Alert-triggered auto-triage sessions (no human initiator)
  - Development environments where OBO and session passthrough are unavailable

Every tool call using this mode is tagged:
  - ``auth_mode=service_account`` in the audit log
  - surfaced in the UI as "running with team credentials"

Team-to-token mapping is loaded from the Settings object.
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


class ServiceAccountRegistry:
    """Registry of per-team Grafana service account tokens.

    Tokens are loaded from application config (not hardcoded).
    The registry is read-only after initialisation.

    Args:
        global_token: Fallback token used when no team-specific token exists.
            Typically the ``GRAFANA_ADMIN_TOKEN`` from env.
        team_tokens: Optional dict mapping team_id (str) to token.
    """

    def __init__(
        self,
        global_token: str,
        team_tokens: dict[str, str] | None = None,
    ) -> None:
        self._global_token = global_token
        self._team_tokens: dict[str, str] = team_tokens or {}

    def get_token_for_team(self, team_id: str | int | None) -> str:
        """Return the service account token for a given team, or the global fallback.

        Args:
            team_id: Grafana team ID.  None returns the global token.

        Returns:
            Service account token string.
        """
        if team_id is not None:
            key = str(team_id)
            if key in self._team_tokens:
                return self._team_tokens[key]
        return self._global_token


def resolve_service_account(
    ctx: AuthRequestContext,
    registry: ServiceAccountRegistry,
) -> GrafanaCredential:
    """Build a GrafanaCredential using the service account fallback.

    Args:
        ctx: Auth request context (team_id and org_id are used).
        registry: ServiceAccountRegistry holding available tokens.

    Returns:
        GrafanaCredential with auth_mode=SERVICE_ACCOUNT.

    Raises:
        ReauthRequiredError: If no service account token is configured at all.
    """
    token = registry.get_token_for_team(ctx.team_id)
    if not token:
        raise ReauthRequiredError(
            "No service account token configured. "
            "Set GRAFANA_ADMIN_TOKEN or per-team tokens in config."
        )

    logger.bind(
        team_id=ctx.team_id,
        org_id=ctx.org_id,
        auth_mode=AuthMode.SERVICE_ACCOUNT,
    ).info("service_account_credential_resolved")

    return GrafanaCredential(
        token=token,
        auth_mode=AuthMode.SERVICE_ACCOUNT,
        user_id=None,  # non-attributed
        org_id=ctx.org_id,
    )
