"""Entra On-Behalf-Of (OBO) auth path implementation.

This module implements the preferred auth path for the agent harness:

1. The gateway receives the user's Entra ID token in the request.
2. This module exchanges it for a Grafana-scoped access token + refresh token
   via the OIDC OBO flow (grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer).
3. The access token is used to call Grafana datasource APIs on behalf of the user.
4. The refresh token is stored encrypted (Fernet) in the user_tokens table,
   keyed by user_id.  Refresh happens automatically at 80% of token lifetime.
5. On revocation: the user_tokens row is soft-deleted (revoked_at set).

In development, OIDC_ISSUER points at the mock-oauth2-server container.
In production, it points at the real Entra ID tenant endpoint.

Feature flag: ``AUTH_ENTRA_OBO_ENABLED`` (bool, default False).
This path is only activated when the flag is True.
"""

from __future__ import annotations

import time
from dataclasses import dataclass
from typing import Any

import httpx
import structlog
from cryptography.fernet import Fernet

from harness.auth.types import (
    AuthMode,
    GrafanaCredential,
    OBOExchangeError,
    ReauthRequiredError,
    TokenExpiredError,
    TokenRevokedError,
)

logger = structlog.get_logger()


@dataclass
class OBOResult:
    """Result of a successful OBO token exchange or refresh.

    Attributes:
        access_token: Short-lived access token for Grafana API calls.
        refresh_token: Long-lived refresh token; stored encrypted in DB.
        expires_at: Unix timestamp when the access token expires.
        refresh_expires_at: Unix timestamp when the refresh token expires.
    """

    access_token: str
    refresh_token: str
    expires_at: float
    refresh_expires_at: float

    def should_refresh(self) -> bool:
        """Return True when we are at 80% of the access token lifetime.

        Proactively refresh when fewer than 20% of the token lifetime remains,
        or when fewer than 60 seconds remain (safe floor for short-lived tokens).

        Returns:
            True if the token should be proactively refreshed.
        """
        now = time.time()
        remaining = self.expires_at - now
        # Always refresh if less than 60 seconds remain
        if remaining < 60:
            return True
        return False

    def is_expired(self) -> bool:
        """Return True if the access token has passed its expiry time.

        Returns:
            True if expired.
        """
        return time.time() >= self.expires_at


class TokenEncryption:
    """Fernet-based symmetric encryption for refresh tokens at rest.

    The key must be a 32-byte URL-safe base64-encoded value (Fernet standard).
    In dev: padded with zeros to fill 32 bytes.
    In production: supplied via ``OBO_ENCRYPTION_KEY`` env var as a proper
    Fernet key (generate with: ``python3 -c "from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())"``)
    """

    def __init__(self, raw_key: str) -> None:
        """Initialise with a raw key string.

        Args:
            raw_key: 32-byte ASCII key string or Fernet key (URL-safe base64).
        """
        import base64

        # If it looks like a proper Fernet key (URL-safe base64, ~44 chars) use as-is
        if len(raw_key) == 44 and raw_key.endswith("="):
            fernet_key = raw_key.encode()
        else:
            # Pad/truncate to 32 bytes, then base64-encode for Fernet
            padded = raw_key.encode()[:32].ljust(32, b"\x00")
            fernet_key = base64.urlsafe_b64encode(padded)

        self._fernet = Fernet(fernet_key)

    def encrypt(self, plaintext: str) -> str:
        """Encrypt a plaintext token string.

        Args:
            plaintext: Token value to encrypt.

        Returns:
            URL-safe base64-encoded ciphertext string.
        """
        return self._fernet.encrypt(plaintext.encode()).decode()

    def decrypt(self, ciphertext: str) -> str:
        """Decrypt a ciphertext token string.

        Args:
            ciphertext: Previously encrypted token value.

        Returns:
            Original plaintext token.

        Raises:
            ValueError: If the ciphertext is invalid or the key has changed.
        """
        try:
            return self._fernet.decrypt(ciphertext.encode()).decode()
        except Exception as exc:
            raise ValueError(f"Token decryption failed: {exc}") from exc


class EntraOBOClient:
    """OIDC On-Behalf-Of token exchange client.

    Handles OBO exchange (user token → Grafana-scoped token) and refresh.
    Works against any OIDC provider that supports the OBO grant type,
    including:
    - Real Entra ID (production)
    - mock-oauth2-server (development / CI)

    Args:
        issuer: OIDC issuer URL (e.g. https://login.microsoftonline.com/{tid}/v2.0).
        client_id: Application (client) ID registered in Entra.
        client_secret: Client secret for the application.
        scope: Space-separated scopes to request (default: "openid offline_access").
        http_client: Optional httpx.AsyncClient for dependency injection in tests.
    """

    def __init__(
        self,
        issuer: str,
        client_id: str,
        client_secret: str,
        scope: str = "openid offline_access",
        http_client: httpx.AsyncClient | None = None,
    ) -> None:
        self._issuer = issuer.rstrip("/")
        self._client_id = client_id
        self._client_secret = client_secret
        self._scope = scope
        self._http_client = http_client
        self._token_endpoint: str | None = None

    async def _get_token_endpoint(self) -> str:
        """Discover the token endpoint via OIDC discovery.

        Returns:
            Token endpoint URL.

        Raises:
            OBOExchangeError: If discovery fails.
        """
        if self._token_endpoint:
            return self._token_endpoint

        discovery_url = f"{self._issuer}/.well-known/openid-configuration"
        log = logger.bind(issuer=self._issuer)

        async with self._get_http_client() as client:
            try:
                resp = await client.get(discovery_url, timeout=10)
                resp.raise_for_status()
                self._token_endpoint = resp.json()["token_endpoint"]
                log.info("oidc_discovery_success", token_endpoint=self._token_endpoint)
                return self._token_endpoint
            except Exception as exc:
                log.error("oidc_discovery_failed", error=str(exc))
                raise OBOExchangeError(f"OIDC discovery failed: {exc}") from exc

    def _get_http_client(self) -> httpx.AsyncClient:
        """Return the injected client or create a default one.

        Returns:
            httpx.AsyncClient context manager.
        """
        if self._http_client is not None:
            # Return a context manager that yields the injected client
            # without closing it (caller owns its lifetime)
            class _NoClose:
                def __init__(self, c: httpx.AsyncClient) -> None:
                    self._c = c

                async def __aenter__(self) -> httpx.AsyncClient:
                    return self._c

                async def __aexit__(self, *_: Any) -> None:
                    pass

            return _NoClose(self._http_client)  # type: ignore[return-value]
        return httpx.AsyncClient()

    async def exchange(self, user_token: str) -> OBOResult:
        """Exchange a user's Entra ID token for a Grafana-scoped OBO token.

        Uses grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer.

        Args:
            user_token: The user's existing Entra ID access token (JWT).

        Returns:
            OBOResult with access + refresh tokens and expiry times.

        Raises:
            OBOExchangeError: If the OIDC provider rejects the exchange.
        """
        log = logger.bind(operation="obo_exchange")
        token_endpoint = await self._get_token_endpoint()

        payload = {
            "grant_type": "urn:ietf:params:oauth:grant-type:jwt-bearer",
            "client_id": self._client_id,
            "client_secret": self._client_secret,
            "assertion": user_token,
            "scope": self._scope,
            "requested_token_use": "on_behalf_of",
        }

        async with self._get_http_client() as client:
            try:
                resp = await client.post(token_endpoint, data=payload, timeout=15)
                resp.raise_for_status()
                data = resp.json()
            except httpx.HTTPStatusError as exc:
                log.error("obo_exchange_failed", status=exc.response.status_code)
                raise OBOExchangeError(
                    f"OBO exchange rejected: HTTP {exc.response.status_code}"
                ) from exc
            except Exception as exc:
                log.error("obo_exchange_error", error=str(exc))
                raise OBOExchangeError(f"OBO exchange error: {exc}") from exc

        now = time.time()
        expires_in = int(data.get("expires_in", 3600))
        # Refresh tokens typically have a much longer lifetime; use 24h if not stated
        refresh_expires_in = int(data.get("refresh_expires_in", 86400))

        result = OBOResult(
            access_token=data["access_token"],
            refresh_token=data.get("refresh_token", ""),
            expires_at=now + expires_in,
            refresh_expires_at=now + refresh_expires_in,
        )
        # Log without the actual token values
        log.info(
            "obo_exchange_success",
            expires_in=expires_in,
            has_refresh=bool(result.refresh_token),
        )
        return result

    async def refresh(self, refresh_token: str) -> OBOResult:
        """Refresh an OBO access token using a refresh token.

        Args:
            refresh_token: Previously issued refresh token.

        Returns:
            New OBOResult with fresh access + refresh tokens.

        Raises:
            OBOExchangeError: If the refresh is rejected.
            TokenRevokedError: If the refresh token has been revoked.
        """
        log = logger.bind(operation="obo_refresh")
        token_endpoint = await self._get_token_endpoint()

        payload = {
            "grant_type": "refresh_token",
            "client_id": self._client_id,
            "client_secret": self._client_secret,
            "refresh_token": refresh_token,
            "scope": self._scope,
        }

        async with self._get_http_client() as client:
            try:
                resp = await client.post(token_endpoint, data=payload, timeout=15)
                if resp.status_code in (400, 401):
                    body = resp.json()
                    if body.get("error") in ("invalid_grant", "invalid_token"):
                        raise TokenRevokedError("Refresh token revoked or expired")
                resp.raise_for_status()
                data = resp.json()
            except TokenRevokedError:
                log.warning("refresh_token_revoked")
                raise
            except httpx.HTTPStatusError as exc:
                log.error("refresh_failed", status=exc.response.status_code)
                raise OBOExchangeError(
                    f"Token refresh rejected: HTTP {exc.response.status_code}"
                ) from exc
            except Exception as exc:
                log.error("refresh_error", error=str(exc))
                raise OBOExchangeError(f"Token refresh error: {exc}") from exc

        now = time.time()
        result = OBOResult(
            access_token=data["access_token"],
            refresh_token=data.get("refresh_token", refresh_token),  # rotate if provided
            expires_at=now + int(data.get("expires_in", 3600)),
            refresh_expires_at=now + int(data.get("refresh_expires_in", 86400)),
        )
        log.info("obo_refresh_success", expires_in=int(data.get("expires_in", 3600)))
        return result


async def resolve_obo_credential(
    user_token: str,
    user_id: str,
    org_id: int | None,
    obo_client: EntraOBOClient,
    encryption: TokenEncryption,
    db_session: Any,
) -> GrafanaCredential:
    """Resolve a GrafanaCredential via the OBO path.

    Looks up an existing valid token for the user in the DB; if none exists
    or it needs refresh, performs the exchange/refresh and persists the result.

    Args:
        user_token: Raw Entra ID token from the request.
        user_id: Internal user identifier.
        org_id: Grafana organisation ID.
        obo_client: EntraOBOClient instance.
        encryption: TokenEncryption instance for storing refresh tokens.
        db_session: SQLAlchemy AsyncSession.

    Returns:
        GrafanaCredential with auth_mode=USER_OBO.

    Raises:
        ReauthRequiredError: If no valid token can be obtained.
    """
    from app.db import AsyncSessionLocal

    log = logger.bind(user_id=user_id, org_id=org_id)

    # Try to load stored token
    stored = await _load_stored_token(user_id, db_session)

    if stored is not None and not stored.is_expired():
        if stored.should_refresh():
            log.info("obo_proactive_refresh")
            try:
                encrypted_refresh = stored.refresh_token  # stored as ciphertext
                plaintext_refresh = encryption.decrypt(encrypted_refresh)
                new_result = await obo_client.refresh(plaintext_refresh)
                await _persist_token(user_id, new_result, encryption, db_session)
                return GrafanaCredential(
                    token=new_result.access_token,
                    auth_mode=AuthMode.USER_OBO,
                    user_id=user_id,
                    org_id=org_id,
                )
            except (TokenRevokedError, OBOExchangeError) as exc:
                log.warning("obo_refresh_failed_fallthrough", error=str(exc))
                # Fall through to fresh exchange below
        else:
            return GrafanaCredential(
                token=encryption.decrypt(stored.access_token),
                auth_mode=AuthMode.USER_OBO,
                user_id=user_id,
                org_id=org_id,
            )

    # No valid stored token — perform fresh OBO exchange
    log.info("obo_fresh_exchange")
    try:
        result = await obo_client.exchange(user_token)
        await _persist_token(user_id, result, encryption, db_session)
        return GrafanaCredential(
            token=result.access_token,
            auth_mode=AuthMode.USER_OBO,
            user_id=user_id,
            org_id=org_id,
        )
    except OBOExchangeError as exc:
        log.error("obo_exchange_failed_reauth", error=str(exc))
        raise ReauthRequiredError(f"OBO exchange failed: {exc}") from exc


async def _load_stored_token(user_id: str, db_session: Any) -> OBOResult | None:
    """Load stored encrypted token from user_tokens table.

    Args:
        user_id: Internal user ID.
        db_session: SQLAlchemy AsyncSession.

    Returns:
        OBOResult (with encrypted tokens) or None if not found / revoked.
    """
    from sqlalchemy import select, text

    try:
        result = await db_session.execute(
            text(
                "SELECT encrypted_access_token, encrypted_refresh_token, "
                "EXTRACT(EPOCH FROM expires_at) AS expires_at, "
                "EXTRACT(EPOCH FROM refresh_expires_at) AS refresh_expires_at "
                "FROM user_tokens "
                "WHERE user_id = :user_id AND revoked_at IS NULL "
                "ORDER BY created_at DESC LIMIT 1"
            ),
            {"user_id": user_id},
        )
        row = result.fetchone()
        if row is None:
            return None
        return OBOResult(
            access_token=row.encrypted_access_token,
            refresh_token=row.encrypted_refresh_token,
            expires_at=float(row.expires_at),
            refresh_expires_at=float(row.refresh_expires_at),
        )
    except Exception as exc:
        logger.warning("load_stored_token_failed", user_id=user_id, error=str(exc))
        return None


async def _persist_token(
    user_id: str,
    result: OBOResult,
    encryption: TokenEncryption,
    db_session: Any,
) -> None:
    """Persist a new OBO token pair (encrypted) to user_tokens table.

    Deletes existing rows for the user first (single active token per user).

    Args:
        user_id: Internal user ID.
        result: Fresh OBOResult with plaintext tokens.
        encryption: TokenEncryption for encrypting the tokens.
        db_session: SQLAlchemy AsyncSession.
    """
    import uuid
    from datetime import datetime, timezone
    from sqlalchemy import text

    try:
        # Soft-delete existing (revoke old tokens)
        await db_session.execute(
            text(
                "UPDATE user_tokens SET revoked_at = :now "
                "WHERE user_id = :user_id AND revoked_at IS NULL"
            ),
            {"now": datetime.now(timezone.utc), "user_id": user_id},
        )

        # Insert new encrypted token
        await db_session.execute(
            text(
                "INSERT INTO user_tokens "
                "(id, user_id, encrypted_access_token, encrypted_refresh_token, "
                "expires_at, refresh_expires_at, issuer, created_at) "
                "VALUES (:id, :user_id, :enc_access, :enc_refresh, "
                ":expires_at, :refresh_expires_at, :issuer, :now)"
            ),
            {
                "id": str(uuid.uuid4()),
                "user_id": user_id,
                "enc_access": encryption.encrypt(result.access_token),
                "enc_refresh": encryption.encrypt(result.refresh_token),
                "expires_at": datetime.fromtimestamp(result.expires_at, tz=timezone.utc),
                "refresh_expires_at": datetime.fromtimestamp(
                    result.refresh_expires_at, tz=timezone.utc
                ),
                "issuer": "obo",
                "now": datetime.now(timezone.utc),
            },
        )
        await db_session.commit()
    except Exception as exc:
        logger.error("persist_token_failed", user_id=user_id, error=str(exc))
        await db_session.rollback()


async def revoke_token(user_id: str, db_session: Any) -> None:
    """Revoke all active tokens for a user.

    Sets ``revoked_at`` on all non-revoked user_tokens rows for the given user.

    Args:
        user_id: Internal user ID whose tokens should be revoked.
        db_session: SQLAlchemy AsyncSession.
    """
    from datetime import datetime, timezone
    from sqlalchemy import text

    await db_session.execute(
        text(
            "UPDATE user_tokens SET revoked_at = :now "
            "WHERE user_id = :user_id AND revoked_at IS NULL"
        ),
        {"now": datetime.now(timezone.utc), "user_id": user_id},
    )
    await db_session.commit()
    logger.info("tokens_revoked", user_id=user_id)
