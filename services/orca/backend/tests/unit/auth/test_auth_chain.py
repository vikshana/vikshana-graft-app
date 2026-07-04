"""Unit tests for harness/auth — OBO client, encryption, session passthrough, service account, chain resolver.

All tests are pure unit tests with no DB or network dependencies.
"""

from __future__ import annotations

import time
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from harness.auth.entra_obo import (
    EntraOBOClient,
    OBOResult,
    TokenEncryption,
    revoke_token,
)
from harness.auth.service_account import ServiceAccountRegistry, resolve_service_account
from harness.auth.session_passthrough import check_grafana_response, resolve_session_passthrough
from harness.auth.types import (
    AuthMode,
    AuthRequestContext,
    OBOExchangeError,
    ReauthRequiredError,
    TokenRevokedError,
)
from harness.auth.chain import AuthChain


# ============================================================================
# TokenEncryption
# ============================================================================


class TestTokenEncryption:
    """Tests for Fernet-based token encryption."""

    def test_roundtrip(self):
        """encrypt + decrypt returns the original value."""
        enc = TokenEncryption("testkey0000000000000000000000000")
        plaintext = "glsa_supersecretgrafanatoken12345"
        assert enc.decrypt(enc.encrypt(plaintext)) == plaintext

    def test_different_key_cannot_decrypt(self):
        """Decryption with the wrong key raises ValueError."""
        enc_a = TokenEncryption("keyAAAA00000000000000000000000000")
        enc_b = TokenEncryption("keyBBBB00000000000000000000000000")
        ciphertext = enc_a.encrypt("secret")
        with pytest.raises(ValueError, match="decryption failed"):
            enc_b.decrypt(ciphertext)

    def test_dev_key_padding(self):
        """Short dev key is padded to 32 bytes without raising."""
        enc = TokenEncryption("devkey")
        assert enc.decrypt(enc.encrypt("hello")) == "hello"

    def test_fernet_key_format(self):
        """44-character URL-safe base64 key is accepted directly."""
        from cryptography.fernet import Fernet
        key = Fernet.generate_key().decode()
        enc = TokenEncryption(key)
        assert enc.decrypt(enc.encrypt("test")) == "test"


# ============================================================================
# OBOResult
# ============================================================================


class TestOBOResult:
    """Tests for OBOResult expiry/refresh logic."""

    def test_not_expired_fresh_token(self):
        """A token expiring in 3600s is not expired."""
        r = OBOResult(
            access_token="t",
            refresh_token="r",
            expires_at=time.time() + 3600,
            refresh_expires_at=time.time() + 86400,
        )
        assert not r.is_expired()

    def test_expired_past_token(self):
        """A token with expires_at in the past is expired."""
        r = OBOResult(
            access_token="t",
            refresh_token="r",
            expires_at=time.time() - 1,
            refresh_expires_at=time.time() + 86400,
        )
        assert r.is_expired()

    def test_should_refresh_when_less_than_60s_remain(self):
        """Token should refresh when fewer than 60s remain."""
        r = OBOResult(
            access_token="t",
            refresh_token="r",
            expires_at=time.time() + 30,
            refresh_expires_at=time.time() + 86400,
        )
        assert r.should_refresh()

    def test_no_refresh_needed_with_plenty_of_time(self):
        """No refresh needed when >60s remain."""
        r = OBOResult(
            access_token="t",
            refresh_token="r",
            expires_at=time.time() + 3600,
            refresh_expires_at=time.time() + 86400,
        )
        # should_refresh checks remaining < 60
        assert not r.should_refresh()


# ============================================================================
# EntraOBOClient — exchange
# ============================================================================


@pytest.fixture
def mock_http_client():
    """Return a mock httpx.AsyncClient."""
    client = AsyncMock()
    return client


class TestEntraOBOClientExchange:
    """Tests for OBO token exchange."""

    @pytest.mark.asyncio
    async def test_successful_exchange(self, mock_http_client):
        """exchange() returns OBOResult on HTTP 200."""
        # Mock discovery
        discovery_resp = MagicMock()
        discovery_resp.status_code = 200
        discovery_resp.json.return_value = {
            "token_endpoint": "http://mock-oidc/token"
        }
        discovery_resp.raise_for_status = MagicMock()

        # Mock token exchange
        token_resp = MagicMock()
        token_resp.status_code = 200
        token_resp.json.return_value = {
            "access_token": "eyJaccess",
            "refresh_token": "eyJrefresh",
            "expires_in": 3600,
        }
        token_resp.raise_for_status = MagicMock()

        mock_http_client.get = AsyncMock(return_value=discovery_resp)
        mock_http_client.post = AsyncMock(return_value=token_resp)

        client = EntraOBOClient(
            issuer="http://mock-oidc/default",
            client_id="client-id",
            client_secret="client-secret",
            http_client=mock_http_client,
        )
        result = await client.exchange("eyJusertoken")

        assert result.access_token == "eyJaccess"
        assert result.refresh_token == "eyJrefresh"
        assert result.expires_at > time.time()

    @pytest.mark.asyncio
    async def test_exchange_raises_on_http_error(self, mock_http_client):
        """exchange() raises OBOExchangeError on HTTP 401."""
        import httpx

        discovery_resp = MagicMock()
        discovery_resp.status_code = 200
        discovery_resp.json.return_value = {"token_endpoint": "http://mock-oidc/token"}
        discovery_resp.raise_for_status = MagicMock()

        error_resp = MagicMock()
        error_resp.status_code = 401
        http_error = httpx.HTTPStatusError("unauthorized", request=MagicMock(), response=error_resp)

        mock_http_client.get = AsyncMock(return_value=discovery_resp)
        mock_http_client.post = AsyncMock(side_effect=http_error)

        client = EntraOBOClient(
            issuer="http://mock-oidc/default",
            client_id="cid",
            client_secret="csec",
            http_client=mock_http_client,
        )
        with pytest.raises(OBOExchangeError):
            await client.exchange("bad_token")

    @pytest.mark.asyncio
    async def test_refresh_raises_token_revoked_on_invalid_grant(self, mock_http_client):
        """refresh() raises TokenRevokedError on invalid_grant response."""
        discovery_resp = MagicMock()
        discovery_resp.status_code = 200
        discovery_resp.json.return_value = {"token_endpoint": "http://mock-oidc/token"}
        discovery_resp.raise_for_status = MagicMock()

        revoked_resp = MagicMock()
        revoked_resp.status_code = 400
        revoked_resp.json.return_value = {"error": "invalid_grant"}

        mock_http_client.get = AsyncMock(return_value=discovery_resp)
        mock_http_client.post = AsyncMock(return_value=revoked_resp)

        client = EntraOBOClient(
            issuer="http://mock-oidc/default",
            client_id="cid",
            client_secret="csec",
            http_client=mock_http_client,
        )
        with pytest.raises(TokenRevokedError):
            await client.refresh("expired_refresh_token")


# ============================================================================
# revoke_token
# ============================================================================


@pytest.mark.asyncio
async def test_revoke_token_updates_revoked_at():
    """revoke_token sets revoked_at on all active rows for a user."""
    db = AsyncMock()
    db.execute = AsyncMock()
    db.commit = AsyncMock()

    await revoke_token("user-123", db)

    db.execute.assert_called_once()
    call_args = db.execute.call_args
    # The SQL text should reference user_id and revoked_at
    sql = str(call_args[0][0])
    assert "revoked_at" in sql.lower() or "UPDATE user_tokens" in sql

    db.commit.assert_called_once()


# ============================================================================
# Session passthrough
# ============================================================================


class TestSessionPassthrough:
    """Tests for session passthrough auth path."""

    def test_resolves_from_header(self):
        """resolve_session_passthrough extracts token from X-Grafana-Session header."""
        ctx = AuthRequestContext(
            request_headers={"X-Grafana-Session": "grafana-session-token"},
            org_id=1,
            user_id="user-1",
        )
        cred = resolve_session_passthrough(ctx)
        assert cred.token == "grafana-session-token"
        assert cred.auth_mode == AuthMode.SESSION_PASSTHROUGH
        assert cred.user_id == "user-1"

    def test_resolves_from_cookie(self):
        """resolve_session_passthrough falls back to cookie."""
        ctx = AuthRequestContext(
            grafana_session_cookie="cookie-session-value",
            org_id=2,
        )
        cred = resolve_session_passthrough(ctx)
        assert cred.token == "cookie-session-value"
        assert cred.auth_mode == AuthMode.SESSION_PASSTHROUGH

    def test_raises_reauth_when_no_session(self):
        """resolve_session_passthrough raises ReauthRequiredError with no session."""
        ctx = AuthRequestContext()
        with pytest.raises(ReauthRequiredError):
            resolve_session_passthrough(ctx)

    def test_check_grafana_response_401_raises(self):
        """check_grafana_response raises ReauthRequiredError on 401."""
        with pytest.raises(ReauthRequiredError):
            check_grafana_response(401, "user-1")

    def test_check_grafana_response_403_does_not_raise(self):
        """check_grafana_response does NOT raise on 403 (handled as PermissionDenied)."""
        # Must not raise — 403 is a tool-level PermissionDenied, not a reauth signal
        check_grafana_response(403, "user-1")

    def test_check_grafana_response_200_does_not_raise(self):
        """check_grafana_response is a no-op on success codes."""
        check_grafana_response(200, "user-1")


# ============================================================================
# Service account
# ============================================================================


class TestServiceAccount:
    """Tests for service account auth path."""

    def test_resolves_global_token_when_no_team(self):
        """resolve_service_account returns global token when no team_id."""
        registry = ServiceAccountRegistry(global_token="glsa_global")
        ctx = AuthRequestContext(org_id=1)
        cred = resolve_service_account(ctx, registry)
        assert cred.token == "glsa_global"
        assert cred.auth_mode == AuthMode.SERVICE_ACCOUNT
        assert cred.user_id is None  # non-attributed

    def test_resolves_team_specific_token(self):
        """resolve_service_account returns team-specific token when available."""
        registry = ServiceAccountRegistry(
            global_token="glsa_global",
            team_tokens={"42": "glsa_team42"},
        )
        ctx = AuthRequestContext(team_id=42, org_id=1)
        cred = resolve_service_account(ctx, registry)
        assert cred.token == "glsa_team42"

    def test_falls_back_to_global_for_unknown_team(self):
        """resolve_service_account falls back to global for an unknown team."""
        registry = ServiceAccountRegistry(
            global_token="glsa_global",
            team_tokens={"99": "glsa_team99"},
        )
        ctx = AuthRequestContext(team_id=7, org_id=1)
        cred = resolve_service_account(ctx, registry)
        assert cred.token == "glsa_global"

    def test_raises_when_no_token_configured(self):
        """resolve_service_account raises ReauthRequiredError when no token."""
        registry = ServiceAccountRegistry(global_token="")
        ctx = AuthRequestContext()
        with pytest.raises(ReauthRequiredError):
            resolve_service_account(ctx, registry)


# ============================================================================
# AuthChain resolver
# ============================================================================


class TestAuthChain:
    """Tests for the priority-ordered auth chain resolver."""

    @pytest.mark.asyncio
    async def test_obo_disabled_uses_service_account(self):
        """When OBO disabled and no session, chain falls through to service account."""
        registry = ServiceAccountRegistry(global_token="glsa_sa_token")
        chain = AuthChain(obo_enabled=False, sa_registry=registry)
        ctx = AuthRequestContext(org_id=1)

        cred = await chain.resolve(ctx)
        assert cred.auth_mode == AuthMode.SERVICE_ACCOUNT
        assert cred.token == "glsa_sa_token"

    @pytest.mark.asyncio
    async def test_session_passthrough_used_when_cookie_present(self):
        """Chain selects session passthrough when session cookie is present and OBO disabled."""
        registry = ServiceAccountRegistry(global_token="glsa_sa")
        chain = AuthChain(obo_enabled=False, sa_registry=registry)
        ctx = AuthRequestContext(
            grafana_session_cookie="session-cookie-value",
            org_id=1,
        )
        cred = await chain.resolve(ctx)
        assert cred.auth_mode == AuthMode.SESSION_PASSTHROUGH
        assert cred.token == "session-cookie-value"

    @pytest.mark.asyncio
    async def test_obo_path_used_when_enabled_and_token_present(self):
        """Chain selects OBO when feature-flagged on and user token present."""
        from unittest.mock import patch

        mock_obo = AsyncMock()
        mock_obo.exchange = AsyncMock()
        mock_obo._get_token_endpoint = AsyncMock(return_value="http://mock/token")

        enc = TokenEncryption("testkey0000000000000000000000000")
        registry = ServiceAccountRegistry(global_token="glsa_sa")

        chain = AuthChain(
            obo_enabled=True,
            obo_client=mock_obo,
            encryption=enc,
            sa_registry=registry,
        )

        ctx = AuthRequestContext(
            user_entra_token="eyJusertoken",
            user_id="user-1",
            org_id=1,
        )

        mock_db = AsyncMock()
        # Simulate no stored token (load returns None)
        mock_db.execute = AsyncMock(return_value=MagicMock(fetchone=MagicMock(return_value=None)))
        mock_db.commit = AsyncMock()

        # Mock resolve_obo_credential to return a credential
        from harness.auth.types import GrafanaCredential

        expected_cred = GrafanaCredential(
            token="eyJaccess",
            auth_mode=AuthMode.USER_OBO,
            user_id="user-1",
            org_id=1,
        )

        with patch(
            "harness.auth.chain.resolve_obo_credential",
            new=AsyncMock(return_value=expected_cred),
        ):
            cred = await chain.resolve(ctx, db_session=mock_db)

        assert cred.auth_mode == AuthMode.USER_OBO
        assert cred.token == "eyJaccess"

    @pytest.mark.asyncio
    async def test_chain_falls_through_to_sa_when_obo_fails(self):
        """Chain falls through to service account when OBO raises ReauthRequiredError."""
        from harness.auth.types import GrafanaCredential

        enc = TokenEncryption("testkey0000000000000000000000000")
        registry = ServiceAccountRegistry(global_token="glsa_fallback")

        chain = AuthChain(
            obo_enabled=True,
            obo_client=MagicMock(),
            encryption=enc,
            sa_registry=registry,
        )

        ctx = AuthRequestContext(
            user_entra_token="eyJbadtoken",
            user_id="user-1",
            org_id=1,
        )

        mock_db = AsyncMock()

        with patch(
            "harness.auth.chain.resolve_obo_credential",
            new=AsyncMock(side_effect=ReauthRequiredError("OBO failed")),
        ):
            cred = await chain.resolve(ctx, db_session=mock_db)

        # Should fall through to service account
        assert cred.auth_mode == AuthMode.SERVICE_ACCOUNT
        assert cred.token == "glsa_fallback"

    @pytest.mark.asyncio
    async def test_chain_raises_when_all_paths_fail(self):
        """Chain raises ReauthRequiredError when no path can produce a credential."""
        registry = ServiceAccountRegistry(global_token="")  # empty = will fail
        chain = AuthChain(obo_enabled=False, sa_registry=registry)
        ctx = AuthRequestContext()

        with pytest.raises(ReauthRequiredError):
            await chain.resolve(ctx)

    def test_obo_enabled_without_client_raises(self):
        """Constructing AuthChain with obo_enabled=True but no client raises ValueError."""
        registry = ServiceAccountRegistry(global_token="glsa_sa")
        with pytest.raises(ValueError, match="obo_client"):
            AuthChain(obo_enabled=True, sa_registry=registry)
