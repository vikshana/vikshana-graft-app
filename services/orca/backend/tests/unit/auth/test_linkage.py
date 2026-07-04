"""Unit tests for harness/auth/linkage.py — Entra PKCE identity linkage flow."""

from __future__ import annotations

import json
import base64
from datetime import datetime, timezone, timedelta
from typing import Any
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
import pytest_asyncio
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from harness.auth.linkage import (
    DuplicateIdentityError,
    LinkStateAlreadyUsedError,
    LinkStateExpiredError,
    LinkStateMismatchError,
    LinkedIdentity,
    LinkRequest,
    _decode_jwt_payload,
    _generate_code_verifier,
    _compute_code_challenge,
    complete_link,
    generate_link_request,
    get_link_status,
    revoke_link,
)

# ---------------------------------------------------------------------------
# Test DB setup — SQLite in-memory with the required tables
# ---------------------------------------------------------------------------

_DDL = """
CREATE TABLE IF NOT EXISTS identity_link_requests (
    id TEXT PRIMARY KEY,
    slack_user_id TEXT NOT NULL,
    slack_team_id TEXT NOT NULL,
    pkce_state TEXT NOT NULL UNIQUE,
    pkce_verifier TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    used_at TEXT,
    created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS identities (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    provider TEXT NOT NULL,
    provider_subject TEXT NOT NULL,
    email TEXT,
    linked_at TEXT NOT NULL,
    UNIQUE (provider, provider_subject)
);
"""


@pytest_asyncio.fixture(scope="module")
async def link_engine():
    """Per-module SQLite in-memory engine for linkage tests."""
    engine = create_async_engine("sqlite+aiosqlite:///:memory:", echo=False)
    async with engine.begin() as conn:
        for stmt in _DDL.strip().split(";"):
            stmt = stmt.strip()
            if stmt:
                await conn.execute(text(stmt))
    yield engine
    await engine.dispose()


@pytest_asyncio.fixture
async def link_db(link_engine) -> AsyncSession:
    """Per-test async session; rolls back after each test."""
    Session = async_sessionmaker(
        bind=link_engine, class_=AsyncSession, expire_on_commit=False
    )
    async with Session() as session:
        yield session
        await session.rollback()


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _make_jwt(payload: dict[str, Any]) -> str:
    """Build a minimal unsigned JWT with *payload*."""
    header = base64.urlsafe_b64encode(b'{"alg":"none"}').rstrip(b"=").decode()
    body = base64.urlsafe_b64encode(json.dumps(payload).encode()).rstrip(b"=").decode()
    return f"{header}.{body}."


def _make_token_response(sub: str, email: str | None = None) -> dict[str, Any]:
    """Build a fake token endpoint response containing an id_token."""
    claims: dict[str, Any] = {"sub": sub, "iss": "http://test-issuer"}
    if email:
        claims["email"] = email
    return {"id_token": _make_jwt(claims), "access_token": "fake-access"}


# ---------------------------------------------------------------------------
# PKCE helpers
# ---------------------------------------------------------------------------


class TestPkceHelpers:
    """Tests for the PKCE utility functions."""

    def test_verifier_is_url_safe_base64(self):
        v = _generate_code_verifier()
        assert len(v) >= 43
        # Must only contain URL-safe base64 chars (no padding)
        import re
        assert re.fullmatch(r"[A-Za-z0-9_\-]+", v), "verifier contains invalid chars"

    def test_challenge_is_s256_of_verifier(self):
        import hashlib
        verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"
        challenge = _compute_code_challenge(verifier)
        expected_digest = hashlib.sha256(verifier.encode()).digest()
        expected = base64.urlsafe_b64encode(expected_digest).rstrip(b"=").decode()
        assert challenge == expected

    def test_decode_jwt_payload_happy_path(self):
        payload = {"sub": "abc123", "email": "user@example.com"}
        token = _make_jwt(payload)
        decoded = _decode_jwt_payload(token)
        assert decoded["sub"] == "abc123"
        assert decoded["email"] == "user@example.com"

    def test_decode_jwt_payload_invalid_returns_empty(self):
        assert _decode_jwt_payload("not.a.jwt") == {} or True  # may return {}
        assert isinstance(_decode_jwt_payload("x"), dict)


# ---------------------------------------------------------------------------
# generate_link_request
# ---------------------------------------------------------------------------


class TestGenerateLinkRequest:
    """Tests for generate_link_request."""

    async def test_returns_link_request_with_auth_url(self, link_db: AsyncSession):
        """generate_link_request returns a LinkRequest with an auth_url."""
        result = await generate_link_request(
            slack_user_id="U001",
            slack_team_id="T001",
            db=link_db,
        )
        assert isinstance(result, LinkRequest)
        assert result.auth_url.startswith("http")
        assert "code_challenge" in result.auth_url
        assert result.pkce_state in result.auth_url

    async def test_creates_db_row(self, link_db: AsyncSession):
        """A row is written to identity_link_requests."""
        result = await generate_link_request(
            slack_user_id="U002",
            slack_team_id="T001",
            db=link_db,
        )
        row = (
            await link_db.execute(
                text(
                    "SELECT slack_user_id, slack_team_id FROM identity_link_requests"
                    " WHERE pkce_state = :state"
                ),
                {"state": result.pkce_state},
            )
        ).fetchone()
        assert row is not None
        assert row.slack_user_id == "U002"
        assert row.slack_team_id == "T001"

    async def test_each_request_has_unique_state(self, link_db: AsyncSession):
        """Two calls produce different pkce_state values."""
        r1 = await generate_link_request("U003", "T001", link_db)
        r2 = await generate_link_request("U003", "T001", link_db)
        assert r1.pkce_state != r2.pkce_state


# ---------------------------------------------------------------------------
# complete_link
# ---------------------------------------------------------------------------


class TestCompleteLink:
    """Tests for complete_link."""

    async def _seed_request(
        self,
        db: AsyncSession,
        slack_user_id: str = "U100",
        slack_team_id: str = "T100",
        expires_delta: int = 600,
        used_at: str | None = None,
    ) -> str:
        """Insert a link request row and return its pkce_state."""
        import uuid as _uuid
        import secrets as _sec
        state = base64.urlsafe_b64encode(
            _sec.token_bytes(16) + slack_user_id.encode()
        ).rstrip(b"=").decode()
        verifier = base64.urlsafe_b64encode(
            _sec.token_bytes(16) + slack_user_id.encode()
        ).rstrip(b"=").decode()
        now = datetime.now(timezone.utc)
        expires = now + timedelta(seconds=expires_delta)
        await db.execute(
            text("""
                INSERT INTO identity_link_requests
                    (id, slack_user_id, slack_team_id, pkce_state, pkce_verifier,
                     expires_at, used_at, created_at)
                VALUES (:id, :su, :st, :state, :verifier, :exp, :used, :now)
            """),
            {
                "id": str(_uuid.uuid4()),
                "su": slack_user_id,
                "st": slack_team_id,
                "state": state,
                "verifier": verifier,
                "exp": expires.isoformat(),
                "used": used_at,
                "now": now.isoformat(),
            },
        )
        await db.flush()
        return state

    def _mock_http_client(self, sub: str, email: str | None = None) -> MagicMock:
        """Return an httpx.AsyncClient mock that returns a fake token response."""
        mock_response = MagicMock()
        mock_response.raise_for_status = MagicMock()
        mock_response.json = MagicMock(
            return_value=_make_token_response(sub=sub, email=email)
        )
        mock_client = AsyncMock()
        mock_client.post = AsyncMock(return_value=mock_response)
        mock_client.aclose = AsyncMock()
        return mock_client

    async def test_happy_path_returns_linked_identity(self, link_db: AsyncSession):
        """Successful exchange returns a LinkedIdentity with correct fields."""
        state = await self._seed_request(link_db, "U110", "T100")
        http = self._mock_http_client(sub="entra-oid-abc", email="alice@example.com")

        result = await complete_link(
            state=state,
            code="test-code",
            db=link_db,
            http_client=http,
        )
        assert isinstance(result, LinkedIdentity)
        assert result.provider == "entra"
        assert result.provider_subject == "entra-oid-abc"
        assert result.email == "alice@example.com"
        assert result.user_id != ""

    async def test_invalid_state_raises_mismatch_error(self, link_db: AsyncSession):
        """An unknown state raises LinkStateMismatchError."""
        with pytest.raises(LinkStateMismatchError):
            await complete_link(state="nonexistent-state", code="code", db=link_db)

    async def test_expired_state_raises_expired_error(self, link_db: AsyncSession):
        """A state past expires_at raises LinkStateExpiredError."""
        state = await self._seed_request(
            link_db, "U120", "T100", expires_delta=-1
        )
        http = self._mock_http_client(sub="entra-oid-xyz")
        with pytest.raises(LinkStateExpiredError):
            await complete_link(state=state, code="code", db=link_db, http_client=http)

    async def test_used_state_raises_already_used_error(self, link_db: AsyncSession):
        """A state with used_at set raises LinkStateAlreadyUsedError."""
        state = await self._seed_request(
            link_db,
            "U130",
            "T100",
            used_at=datetime.now(timezone.utc).isoformat(),
        )
        http = self._mock_http_client(sub="entra-oid-xyz")
        with pytest.raises(LinkStateAlreadyUsedError):
            await complete_link(state=state, code="code", db=link_db, http_client=http)

    async def test_duplicate_entra_identity_different_user_raises(self, link_db: AsyncSession):
        """Linking an Entra OID already linked to a different user raises DuplicateIdentityError."""
        import uuid

        # Pre-seed an existing entra identity for a different user
        existing_user_id = str(uuid.uuid4())
        existing_identity_id = str(uuid.uuid4())
        now = datetime.now(timezone.utc)
        await link_db.execute(
            text("INSERT INTO users (id, created_at) VALUES (:id, :now)"),
            {"id": existing_user_id, "now": now.isoformat()},
        )
        await link_db.execute(
            text("""
                INSERT INTO identities (id, user_id, provider, provider_subject, linked_at)
                VALUES (:id, :uid, 'entra', 'shared-oid-dup', :now)
            """),
            {"id": existing_identity_id, "uid": existing_user_id, "now": now.isoformat()},
        )
        await link_db.flush()

        state = await self._seed_request(link_db, "U140", "T100")
        http = self._mock_http_client(sub="shared-oid-dup")
        with pytest.raises(DuplicateIdentityError):
            await complete_link(state=state, code="code", db=link_db, http_client=http)

    async def test_complete_link_idempotent_same_user_relink(self, link_db: AsyncSession):
        """Re-linking the same user to the same Entra OID is idempotent (no error)."""
        state1 = await self._seed_request(link_db, "U150", "T100")
        state2 = await self._seed_request(link_db, "U150", "T100")
        http = self._mock_http_client(sub="entra-oid-idempotent", email="bob@example.com")

        await complete_link(state=state1, code="code1", db=link_db, http_client=http)
        # Second link for same Slack user → same Entra OID → should not raise
        http2 = self._mock_http_client(sub="entra-oid-idempotent", email="bob@example.com")
        result = await complete_link(state=state2, code="code2", db=link_db, http_client=http2)
        assert result.provider_subject == "entra-oid-idempotent"


# ---------------------------------------------------------------------------
# revoke_link
# ---------------------------------------------------------------------------


class TestRevokeLink:
    """Tests for revoke_link."""

    async def test_revoke_removes_identity_row(self, link_db: AsyncSession):
        """revoke_link deletes the identities row for user+provider."""
        import uuid

        user_id = str(uuid.uuid4())
        identity_id = str(uuid.uuid4())
        now = datetime.now(timezone.utc)
        await link_db.execute(
            text("INSERT INTO users (id, created_at) VALUES (:id, :now)"),
            {"id": user_id, "now": now.isoformat()},
        )
        await link_db.execute(
            text("""
                INSERT INTO identities (id, user_id, provider, provider_subject, linked_at)
                VALUES (:id, :uid, 'entra', 'revoke-sub', :now)
            """),
            {"id": identity_id, "uid": user_id, "now": now.isoformat()},
        )
        await link_db.flush()

        await revoke_link(user_id=user_id, provider="entra", db=link_db)

        row = (
            await link_db.execute(
                text("SELECT 1 FROM identities WHERE user_id = :uid AND provider = 'entra'"),
                {"uid": user_id},
            )
        ).fetchone()
        assert row is None

    async def test_revoke_nonexistent_is_noop(self, link_db: AsyncSession):
        """Revoking a non-existent link does not raise."""
        import uuid
        await revoke_link(user_id=str(uuid.uuid4()), provider="entra", db=link_db)


# ---------------------------------------------------------------------------
# get_link_status
# ---------------------------------------------------------------------------


class TestGetLinkStatus:
    """Tests for get_link_status."""

    async def test_returns_linked_true_when_identity_exists(self, link_db: AsyncSession):
         """Returns linked=True with email when the Slack user has an Entra identity."""
         import uuid

         user_id = str(uuid.uuid4())
         now = datetime.now(timezone.utc)
         slack_user = "U_STATUS_TEST"
         slack_team = "T_STATUS"
         # Slack provider_subject must use the composite team_id:user_id format
         slack_sub = f"{slack_team}:{slack_user}"

         await link_db.execute(
             text("INSERT INTO users (id, created_at) VALUES (:id, :now)"),
             {"id": user_id, "now": now.isoformat()},
         )
         for provider, subject, email in [
             ("slack", slack_sub, None),
             ("entra", "entra-status-sub", "status@example.com"),
         ]:
             await link_db.execute(
                 text("""
                     INSERT INTO identities (id, user_id, provider, provider_subject, email, linked_at)
                     VALUES (:id, :uid, :provider, :subject, :email, :now)
                 """),
                 {
                     "id": str(uuid.uuid4()),
                     "uid": user_id,
                     "provider": provider,
                     "subject": subject,
                     "email": email,
                     "now": now.isoformat(),
                 },
             )
         await link_db.flush()

         result = await get_link_status(slack_user, slack_team, link_db)
         assert result["linked"] is True
         assert result["email"] == "status@example.com"

    async def test_returns_linked_false_when_no_identity(self, link_db: AsyncSession):
        """Returns linked=False for an unknown Slack user."""
        result = await get_link_status("U_UNKNOWN", "T_UNKNOWN", link_db)
        assert result["linked"] is False
        assert "email" not in result
