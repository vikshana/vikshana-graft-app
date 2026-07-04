"""Entra identity linkage — PKCE flow for connecting Slack users to Entra accounts.

Flow:
  1. Slack user runs ``/obs link`` → ``generate_link_request`` creates a PKCE state
     row and returns an OIDC authorization URL.
  2. User follows the URL, authenticates, is redirected back to
     ``GET /api/identity/callback?state=<state>&code=<code>``.
  3. ``complete_link`` validates the state, exchanges the code for tokens via PKCE,
     and writes an ``identities`` row linking the Slack user to their Entra OID.
  4. ``revoke_link`` removes the ``identities`` row for a given provider.

Security properties:
  - ``pkce_state`` is a cryptographically random 32-byte URL-safe string.
  - ``pkce_verifier`` is a random 32-byte value; ``pkce_challenge`` = S256(verifier).
  - State is single-use (``used_at`` set on first successful exchange).
  - State expires after ``IDENTITY_LINK_STATE_TTL_S`` seconds (default 10 min).
  - No client secret is sent; PKCE removes the need for confidential-client flow.
"""

from __future__ import annotations

import base64
import hashlib
import secrets
import uuid
from datetime import datetime, timezone, timedelta
from typing import Any
from urllib.parse import urlencode

import httpx
import structlog
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import settings

logger = structlog.get_logger()

# ---------------------------------------------------------------------------
# Custom exception hierarchy
# ---------------------------------------------------------------------------


class LinkError(Exception):
    """Base class for all identity linkage errors."""


class LinkStateNotFoundError(LinkError):
    """The pkce_state was not found in the database."""


class LinkStateMismatchError(LinkError):
    """The provided state does not match any pending request (CSRF guard)."""


class LinkStateExpiredError(LinkError):
    """The link request has passed its expiry time."""


class LinkStateAlreadyUsedError(LinkError):
    """The link request has already been consumed (replay guard)."""


class DuplicateIdentityError(LinkError):
    """An identity for this provider + subject already exists for a different user."""


# ---------------------------------------------------------------------------
# PKCE helpers
# ---------------------------------------------------------------------------


def _generate_code_verifier() -> str:
    """Return a cryptographically random PKCE code verifier (43 chars, URL-safe base64)."""
    return base64.urlsafe_b64encode(secrets.token_bytes(32)).rstrip(b"=").decode()


def _compute_code_challenge(verifier: str) -> str:
    """Return the S256 code challenge for *verifier*."""
    digest = hashlib.sha256(verifier.encode()).digest()
    return base64.urlsafe_b64encode(digest).rstrip(b"=").decode()


def _generate_state() -> str:
    """Return a cryptographically random 43-char URL-safe state string."""
    return base64.urlsafe_b64encode(secrets.token_bytes(32)).rstrip(b"=").decode()


# ---------------------------------------------------------------------------
# Data classes
# ---------------------------------------------------------------------------


class LinkRequest:
    """Result of ``generate_link_request``.

    Attributes:
        request_id: UUID of the ``identity_link_requests`` row.
        auth_url: The OIDC authorization URL the user should be directed to.
        pkce_state: The opaque state value embedded in the URL.
    """

    def __init__(self, request_id: str, auth_url: str, pkce_state: str) -> None:
        self.request_id = request_id
        self.auth_url = auth_url
        self.pkce_state = pkce_state


class LinkedIdentity:
    """Result of ``complete_link``.

    Attributes:
        identity_id: UUID of the ``identities`` row.
        user_id: UUID of the linked ``users`` row.
        provider: Identity provider (``"entra"``).
        provider_subject: Entra OID (``sub`` claim from the token).
        email: Email from the token (may be None).
    """

    def __init__(
        self,
        identity_id: str,
        user_id: str,
        provider: str,
        provider_subject: str,
        email: str | None,
    ) -> None:
        self.identity_id = identity_id
        self.user_id = user_id
        self.provider = provider
        self.provider_subject = provider_subject
        self.email = email


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------


async def generate_link_request(
    slack_user_id: str,
    slack_team_id: str,
    db: AsyncSession,
    redirect_uri: str | None = None,
) -> LinkRequest:
    """Create a PKCE link request and return the OIDC authorization URL.

    Writes a row to ``identity_link_requests`` and returns the auth URL that
    the Slack user should visit to authenticate.

    Args:
        slack_user_id: Slack user ID (e.g. ``U01234567``).
        slack_team_id: Slack workspace/team ID (e.g. ``T01234567``).
        db: Async database session.
        redirect_uri: Override the callback URI (defaults to orca-backend /api/identity/callback).

    Returns:
        ``LinkRequest`` containing the authorization URL and state.
    """
    verifier = _generate_code_verifier()
    challenge = _compute_code_challenge(verifier)
    state = _generate_state()
    request_id = str(uuid.uuid4())
    expires_at = datetime.now(timezone.utc) + timedelta(seconds=settings.IDENTITY_LINK_STATE_TTL_S)

    await db.execute(
        text("""
            INSERT INTO identity_link_requests
                (id, slack_user_id, slack_team_id, pkce_state, pkce_verifier, expires_at, created_at)
            VALUES (:id, :slack_user_id, :slack_team_id, :state, :verifier, :expires_at, :now)
        """),
        {
            "id": request_id,
            "slack_user_id": slack_user_id,
            "slack_team_id": slack_team_id,
            "state": state,
            "verifier": verifier,
            "expires_at": expires_at,
            "now": datetime.now(timezone.utc),
        },
    )
    await db.commit()

    callback_uri = redirect_uri or f"{settings.GRAFANA_URL}/api/plugins/vikshana-graft-app/resources/identity/callback"

    # Build OIDC authorization URL
    params: dict[str, str] = {
        "response_type": "code",
        "client_id": settings.ENTRA_CLIENT_ID or "orca-dev-client",
        "redirect_uri": callback_uri,
        "scope": "openid profile email",
        "state": state,
        "code_challenge": challenge,
        "code_challenge_method": "S256",
    }
    auth_url = f"{settings.OIDC_ISSUER}/authorize?{urlencode(params)}"

    log = logger.bind(slack_user_id=slack_user_id, slack_team_id=slack_team_id)
    log.info("identity_link_request_created", request_id=request_id)

    return LinkRequest(request_id=request_id, auth_url=auth_url, pkce_state=state)


async def complete_link(
    state: str,
    code: str,
    db: AsyncSession,
    redirect_uri: str | None = None,
    http_client: httpx.AsyncClient | None = None,
) -> LinkedIdentity:
    """Exchange the PKCE authorization code for tokens and write an ``identities`` row.

    Validates the ``state`` against ``identity_link_requests``, performs the PKCE
    token exchange with the OIDC token endpoint, then upserts ``users`` and
    ``identities`` rows.

    Args:
        state: The ``state`` parameter received in the OAuth callback.
        code: The authorization code received in the OAuth callback.
        db: Async database session.
        redirect_uri: Must match the URI used in ``generate_link_request``.
        http_client: Optional ``httpx.AsyncClient`` for testing (avoids real HTTP).

    Returns:
        ``LinkedIdentity`` describing the newly created identity link.

    Raises:
        LinkStateMismatchError: If ``state`` is not found.
        LinkStateExpiredError: If the link request has expired.
        LinkStateAlreadyUsedError: If the link request was already consumed.
        DuplicateIdentityError: If the Entra subject is already linked to a *different* user.
    """
    # Look up the link request by state
    result = await db.execute(
        text("""
            SELECT id, slack_user_id, slack_team_id, pkce_verifier, expires_at, used_at
            FROM identity_link_requests
            WHERE pkce_state = :state
        """),
        {"state": state},
    )
    row = result.fetchone()
    if row is None:
        raise LinkStateMismatchError(f"No pending link request for state={state!r}")

    now = datetime.now(timezone.utc)

    if row.used_at is not None:
        raise LinkStateAlreadyUsedError("Link request already consumed")

    expires_at = row.expires_at
    # SQLite returns datetime strings; Postgres returns datetime objects.
    if isinstance(expires_at, str):
        from datetime import datetime as _dt
        expires_at = _dt.fromisoformat(expires_at)
    if expires_at.tzinfo is None:
        expires_at = expires_at.replace(tzinfo=timezone.utc)
    if now > expires_at:
        raise LinkStateExpiredError("Link request has expired")

    # Mark as used immediately to prevent replay
    await db.execute(
        text("UPDATE identity_link_requests SET used_at = :now WHERE pkce_state = :state"),
        {"now": now, "state": state},
    )
    await db.flush()

    slack_user_id: str = row.slack_user_id
    slack_team_id: str = row.slack_team_id
    verifier: str = row.pkce_verifier

    # Exchange authorization code for tokens
    callback_uri = redirect_uri or f"{settings.GRAFANA_URL}/api/plugins/vikshana-graft-app/resources/identity/callback"
    token_endpoint = f"{settings.OIDC_ISSUER}/token"

    token_data: dict[str, Any] = await _exchange_code(
        token_endpoint=token_endpoint,
        code=code,
        verifier=verifier,
        redirect_uri=callback_uri,
        http_client=http_client,
    )

    provider_subject: str = token_data.get("sub", "")
    email: str | None = token_data.get("email")

    log = logger.bind(slack_user_id=slack_user_id, provider_subject=provider_subject)

    # Upsert user row (keyed on slack_user_id+slack_team_id via existing identities)
    # Look up by composite Slack subject (team_id:user_id) to ensure
    # cross-workspace uniqueness.
    slack_subject = f"{slack_team_id}:{slack_user_id}"
    existing_slack = await db.execute(
        text("""
            SELECT u.id as user_id
            FROM identities i
            JOIN users u ON u.id = i.user_id
            WHERE i.provider = 'slack' AND i.provider_subject = :slack_sub
        """),
        {"slack_sub": slack_subject},
    )
    slack_row = existing_slack.fetchone()

    if slack_row:
        user_id: str = str(slack_row.user_id)
    else:
        # Create new user row
        user_id = str(uuid.uuid4())
        await db.execute(
            text("""
                INSERT INTO users (id, created_at)
                VALUES (:id, :now)
                ON CONFLICT (id) DO NOTHING
            """),
            {"id": user_id, "now": now},
        )
        # Also create the Slack identity using composite subject (team_id:user_id)
        # to ensure uniqueness across workspaces.
        slack_identity_id = str(uuid.uuid4())
        slack_subject = f"{slack_team_id}:{slack_user_id}"
        await db.execute(
            text("""
                INSERT INTO identities (id, user_id, provider, provider_subject, linked_at)
                VALUES (:id, :user_id, 'slack', :subject, :now)
                ON CONFLICT (provider, provider_subject) DO NOTHING
            """),
            {
                "id": slack_identity_id,
                "user_id": user_id,
                "subject": slack_subject,
                "now": now,
            },
        )

    # Check if this Entra subject is already linked to a DIFFERENT user
    existing_entra = await db.execute(
        text("""
            SELECT user_id FROM identities
            WHERE provider = 'entra' AND provider_subject = :subject
        """),
        {"subject": provider_subject},
    )
    entra_row = existing_entra.fetchone()

    if entra_row and str(entra_row.user_id) != user_id:
        raise DuplicateIdentityError(
            f"Entra subject {provider_subject!r} is already linked to a different user"
        )

    # Upsert Entra identity (idempotent: same user re-linking is OK)
    identity_id = str(uuid.uuid4())  # used as the INSERT value; may be overridden below
    await db.execute(
        text("""
            INSERT INTO identities (id, user_id, provider, provider_subject, email, linked_at)
            VALUES (:id, :user_id, 'entra', :subject, :email, :now)
            ON CONFLICT (provider, provider_subject)
            DO UPDATE SET email = EXCLUDED.email, linked_at = EXCLUDED.linked_at
        """),
        {
            "id": identity_id,
            "user_id": user_id,
            "subject": provider_subject,
            "email": email,
            "now": now,
        },
    )

    # SELECT the persisted id — on the conflict/update path the row keeps its
    # original id, so identity_id (newly generated above) may be incorrect.
    persisted = await db.execute(
        text(
            "SELECT id FROM identities "
            "WHERE provider = 'entra' AND provider_subject = :subject"
        ),
        {"subject": provider_subject},
    )
    persisted_row = persisted.fetchone()
    identity_id = str(persisted_row.id) if persisted_row else identity_id

    await db.commit()

    log.info("identity_linked", user_id=user_id, email=email)
    return LinkedIdentity(
        identity_id=identity_id,
        user_id=user_id,
        provider="entra",
        provider_subject=provider_subject,
        email=email,
    )


async def revoke_link(user_id: str, provider: str, db: AsyncSession) -> None:
    """Remove an identity link for a given user and provider.

    If no matching identity exists, this is a no-op (idempotent).

    Args:
        user_id: UUID of the ``users`` row.
        provider: Identity provider to unlink (e.g. ``"entra"``).
        db: Async database session.
    """
    await db.execute(
        text("DELETE FROM identities WHERE user_id = :user_id AND provider = :provider"),
        {"user_id": user_id, "provider": provider},
    )
    await db.commit()
    logger.info("identity_revoked", user_id=user_id, provider=provider)


async def get_link_status(
    slack_user_id: str,
    slack_team_id: str,
    db: AsyncSession,
) -> dict[str, Any]:
    """Return the Entra linkage status for a Slack user.

    Args:
        slack_user_id: Slack user ID.
        slack_team_id: Slack team/workspace ID.
        db: Async database session.

    Returns:
        Dict with ``linked`` (bool) and optionally ``email`` (str).
    """
    result = await db.execute(
        text("""
            SELECT ie.email
            FROM identities is_
            JOIN users u ON u.id = is_.user_id
            JOIN identities ie ON ie.user_id = u.id AND ie.provider = 'entra'
            WHERE is_.provider = 'slack'
              AND is_.provider_subject = :slack_sub
            LIMIT 1
        """),
        {"slack_sub": f"{slack_team_id}:{slack_user_id}"},
    )
    row = result.fetchone()
    if row is None:
        return {"linked": False}
    return {"linked": True, "email": row.email}


# ---------------------------------------------------------------------------
# Internal helpers
# ---------------------------------------------------------------------------


async def _exchange_code(
    token_endpoint: str,
    code: str,
    verifier: str,
    redirect_uri: str,
    http_client: httpx.AsyncClient | None,
) -> dict[str, Any]:
    """Perform the PKCE token exchange and return the decoded ID-token claims.

    Args:
        token_endpoint: OIDC token endpoint URL.
        code: Authorization code from the callback.
        verifier: PKCE code verifier.
        redirect_uri: Redirect URI used in the authorization request.
        http_client: Optional client for testing.

    Returns:
        Dict of claims decoded from the ID token ``sub``, ``email``, etc.
        For mock providers the token endpoint returns JSON with these fields
        directly; for Entra the ID token must be decoded (we decode without
        signature verification since the endpoint is trusted/internal in dev).
    """
    own_client = http_client is None
    client = http_client or httpx.AsyncClient(timeout=10.0)
    try:
        resp = await client.post(
            token_endpoint,
            data={
                "grant_type": "authorization_code",
                "code": code,
                "redirect_uri": redirect_uri,
                "client_id": settings.ENTRA_CLIENT_ID or "orca-dev-client",
                "code_verifier": verifier,
            },
        )
        resp.raise_for_status()
        token_response: dict[str, Any] = resp.json()
    finally:
        if own_client:
            await client.aclose()

    # Decode the id_token (JWT) to extract claims.
    # We trust the token endpoint (internal/dev); no signature verification needed.
    id_token: str = token_response.get("id_token", "")
    if id_token:
        claims = _decode_jwt_payload(id_token)
        return claims

    # Fallback: some mock servers return claims directly in the token response
    return token_response


def _decode_jwt_payload(token: str) -> dict[str, Any]:
    """Decode the payload section of a JWT without signature verification.

    Args:
        token: A dot-separated JWT string.

    Returns:
        Decoded JSON payload as a dict.  Returns ``{}`` on parse errors.
    """
    import json

    parts = token.split(".")
    if len(parts) < 2:
        return {}
    payload_b64 = parts[1]
    # Re-pad base64 to a multiple of 4
    padding = 4 - len(payload_b64) % 4
    if padding != 4:
        payload_b64 += "=" * padding
    try:
        decoded = base64.urlsafe_b64decode(payload_b64)
        return dict(json.loads(decoded))
    except Exception:
        return {}
