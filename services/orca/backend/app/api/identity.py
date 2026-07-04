"""FastAPI route handlers for Entra identity linkage.

Endpoints:
    GET  /api/identity/link/start    — Generate PKCE link request and return auth URL.
    GET  /api/identity/callback      — Handle OIDC callback; complete the code exchange.
    GET  /api/identity/status        — Return Entra linkage status for a Slack user.
    DELETE /api/identity/link        — Revoke an identity link.

The callback endpoint is reached after the user completes the Entra authentication
flow. The Go plugin proxy forwards it from
``/api/plugins/vikshana-graft-app/resources/identity/callback`` to here.
"""

from __future__ import annotations

from typing import Any

import structlog
from fastapi import APIRouter, Depends, HTTPException, Query, status
from fastapi.responses import RedirectResponse
from pydantic import BaseModel
from sqlalchemy.ext.asyncio import AsyncSession

from app.db import get_session
from harness.auth.linkage import (
    DuplicateIdentityError,
    LinkStateAlreadyUsedError,
    LinkStateExpiredError,
    LinkStateMismatchError,
    complete_link,
    generate_link_request,
    get_link_status,
    revoke_link,
)

logger = structlog.get_logger()

router = APIRouter(prefix="/identity", tags=["identity"])


# ---------------------------------------------------------------------------
# Response / request schemas
# ---------------------------------------------------------------------------


class LinkStartResponse(BaseModel):
    """Response from the link/start endpoint."""

    request_id: str
    auth_url: str


class LinkStatusResponse(BaseModel):
    """Response from the status endpoint."""

    linked: bool
    email: str | None = None


# ---------------------------------------------------------------------------
# Endpoints
# ---------------------------------------------------------------------------


@router.get(
    "/link/start",
    response_model=LinkStartResponse,
    summary="Start identity linkage",
    description=(
        "Creates a PKCE state record and returns the OIDC authorization URL "
        "that the Slack user should visit to link their Entra account."
    ),
)
async def link_start(
    slack_user_id: str = Query(..., description="Slack user ID (e.g. U01234567)"),
    slack_team_id: str = Query(..., description="Slack team/workspace ID (e.g. T01234567)"),
    db: AsyncSession = Depends(get_session),
) -> LinkStartResponse:
    """Generate a PKCE link request for *slack_user_id* in *slack_team_id*.

    Args:
        slack_user_id: Slack user ID.
        slack_team_id: Slack workspace ID.
        db: Async database session.

    Returns:
        Auth URL to redirect the user to.
    """
    link = await generate_link_request(
        slack_user_id=slack_user_id,
        slack_team_id=slack_team_id,
        db=db,
    )
    return LinkStartResponse(request_id=link.request_id, auth_url=link.auth_url)


@router.get(
    "/callback",
    summary="OIDC callback — complete identity linkage",
    description=(
        "Receives the OIDC authorization code redirect, validates the PKCE state, "
        "exchanges the code for tokens, and writes the identities row. "
        "On success redirects the user to the Graft plugin UI."
    ),
)
async def link_callback(
    state: str = Query(...),
    code: str = Query(...),
    db: AsyncSession = Depends(get_session),
) -> Any:
    """Handle the OIDC callback redirect.

    Args:
        state: PKCE state parameter from the authorization response.
        code: Authorization code from the authorization response.
        db: Async database session.

    Returns:
        Redirect to the Graft plugin success page, or a 400/409 JSON error.
    """
    log = logger.bind(state_prefix=state[:8] + "…" if len(state) > 8 else state)
    try:
        identity = await complete_link(state=state, code=code, db=db)
        log.info("identity_link_complete", user_id=identity.user_id)
        # Redirect to the Graft plugin with a success indicator
        return RedirectResponse(
            url="/a/vikshana-graft-app?linked=1",
            status_code=status.HTTP_302_FOUND,
        )
    except (LinkStateMismatchError, LinkStateExpiredError, LinkStateAlreadyUsedError) as exc:
        log.warning("identity_link_state_error", error=str(exc))
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=str(exc),
        ) from exc
    except DuplicateIdentityError as exc:
        log.warning("identity_link_duplicate", error=str(exc))
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=str(exc),
        ) from exc


@router.get(
    "/status",
    response_model=LinkStatusResponse,
    summary="Check Entra linkage status for a Slack user",
)
async def link_status(
    slack_user_id: str = Query(..., description="Slack user ID"),
    slack_team_id: str = Query(..., description="Slack team ID"),
    db: AsyncSession = Depends(get_session),
) -> LinkStatusResponse:
    """Return whether *slack_user_id* has linked their Entra account.

    Args:
        slack_user_id: Slack user ID.
        slack_team_id: Slack workspace ID.
        db: Async database session.

    Returns:
        ``{linked: bool, email?}``
    """
    result = await get_link_status(
        slack_user_id=slack_user_id,
        slack_team_id=slack_team_id,
        db=db,
    )
    return LinkStatusResponse(**result)


@router.delete(
    "/link",
    status_code=status.HTTP_204_NO_CONTENT,
    summary="Revoke an identity link",
    description="Removes the identities row for *user_id* and *provider*.",
)
async def unlink(
    user_id: str = Query(..., description="UUID of the users row"),
    provider: str = Query(default="entra", description="Identity provider to unlink"),
    db: AsyncSession = Depends(get_session),
) -> None:
    """Revoke the identity link for *user_id* / *provider*.

    Args:
        user_id: UUID of the ``users`` row.
        provider: Provider to unlink (default: ``"entra"``).
        db: Async database session.
    """
    await revoke_link(user_id=user_id, provider=provider, db=db)
