"""Auth chain resolver — selects and executes the appropriate auth path.

Priority order (controlled by feature flags in config):
  1. Entra OBO (if AUTH_ENTRA_OBO_ENABLED=true AND user_entra_token is present)
  2. Session passthrough (if grafana_session_cookie is present)
  3. Service account (always available as last resort)

Each path is tried in order; if a path fails with ReauthRequiredError or
any exception, the next path is attempted.  If all paths are exhausted without
a valid credential, ReauthRequiredError is raised to the caller.

The resolved credential carries an auth_mode tag that must be recorded in:
  - sessions.auth_mode (on session creation)
  - tool_calls.acting_identity (on every tool call)
  - Audit log row
"""

from __future__ import annotations

from typing import Any

import structlog

from harness.auth.entra_obo import EntraOBOClient, TokenEncryption, resolve_obo_credential
from harness.auth.service_account import ServiceAccountRegistry, resolve_service_account
from harness.auth.session_passthrough import resolve_session_passthrough
from harness.auth.types import (
    AuthMode,
    AuthRequestContext,
    GrafanaCredential,
    ReauthRequiredError,
)

logger = structlog.get_logger()


class AuthChain:
    """Resolves a GrafanaCredential by trying auth paths in priority order.

    Args:
        obo_enabled: Whether the Entra OBO path is active (AUTH_ENTRA_OBO_ENABLED).
        obo_client: EntraOBOClient instance (required when obo_enabled=True).
        encryption: TokenEncryption instance (required when obo_enabled=True).
        sa_registry: ServiceAccountRegistry for the fallback path.
    """

    def __init__(
        self,
        obo_enabled: bool,
        sa_registry: ServiceAccountRegistry,
        obo_client: EntraOBOClient | None = None,
        encryption: TokenEncryption | None = None,
    ) -> None:
        self._obo_enabled = obo_enabled
        self._obo_client = obo_client
        self._encryption = encryption
        self._sa_registry = sa_registry

        if obo_enabled and (obo_client is None or encryption is None):
            raise ValueError(
                "obo_client and encryption are required when obo_enabled=True"
            )

    async def resolve(
        self,
        ctx: AuthRequestContext,
        db_session: Any | None = None,
    ) -> GrafanaCredential:
        """Resolve a GrafanaCredential by trying all configured auth paths.

        Paths are tried in priority order:
          1. Entra OBO (if feature-flagged on and token present)
          2. Session passthrough (if session cookie present)
          3. Service account (always)

        Args:
            ctx: Auth request context from the incoming request.
            db_session: SQLAlchemy AsyncSession (required for OBO path).

        Returns:
            GrafanaCredential from the first successful path.

        Raises:
            ReauthRequiredError: If all paths fail and no credential can be issued.
        """
        log = logger.bind(
            user_id=ctx.user_id,
            org_id=ctx.org_id,
            obo_enabled=self._obo_enabled,
        )

        # --- Path 1: Entra OBO ---
        if (
            self._obo_enabled
            and ctx.user_entra_token
            and self._obo_client is not None
            and self._encryption is not None
            and db_session is not None
        ):
            try:
                credential = await resolve_obo_credential(
                    user_token=ctx.user_entra_token,
                    user_id=ctx.user_id or "unknown",
                    org_id=ctx.org_id,
                    obo_client=self._obo_client,
                    encryption=self._encryption,
                    db_session=db_session,
                )
                log.info("auth_chain_resolved", path="obo")
                return credential
            except ReauthRequiredError:
                log.warning("obo_path_failed_trying_next")
            except Exception as exc:
                log.warning("obo_path_error", error=str(exc))

        # --- Path 2: Session passthrough ---
        if ctx.grafana_session_cookie or ctx.request_headers.get("X-Grafana-Session"):
            try:
                credential = resolve_session_passthrough(ctx)
                log.info("auth_chain_resolved", path="session_passthrough")
                return credential
            except ReauthRequiredError:
                log.warning("session_passthrough_failed_trying_next")

        # --- Path 3: Service account (always available) ---
        try:
            credential = resolve_service_account(ctx, self._sa_registry)
            log.info("auth_chain_resolved", path="service_account")
            return credential
        except ReauthRequiredError as exc:
            log.error("all_auth_paths_failed")
            raise ReauthRequiredError(
                "No valid Grafana credential could be resolved. "
                "Configure GRAFANA_ADMIN_TOKEN or enable Entra OBO."
            ) from exc


def make_auth_chain_from_settings() -> AuthChain:
    """Construct an AuthChain instance from the application settings.

    Reads AUTH_ENTRA_OBO_ENABLED and related config to build the chain.
    This is the production factory function; tests should construct AuthChain
    directly with injected dependencies.

    Returns:
        Configured AuthChain ready for use in request handlers.
    """
    from app.config import settings

    sa_registry = ServiceAccountRegistry(
        global_token=settings.GRAFANA_ADMIN_TOKEN,
    )

    if not settings.AUTH_ENTRA_OBO_ENABLED:
        return AuthChain(
            obo_enabled=False,
            sa_registry=sa_registry,
        )

    obo_client = EntraOBOClient(
        issuer=settings.OIDC_ISSUER,
        client_id=settings.ENTRA_CLIENT_ID,
        client_secret=settings.ENTRA_CLIENT_SECRET,
    )
    encryption = TokenEncryption(settings.OBO_ENCRYPTION_KEY)

    return AuthChain(
        obo_enabled=True,
        obo_client=obo_client,
        encryption=encryption,
        sa_registry=sa_registry,
    )
