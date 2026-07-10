"""MCP server management API.

Endpoints:
  GET    /api/mcp/servers                         — list configured servers for org
  POST   /api/mcp/servers                         — add and connect a server
  DELETE /api/mcp/servers/{server_id}             — disconnect and delete
  POST   /api/mcp/servers/{server_id}/reconnect   — force reconnect + re-discover
  GET    /api/mcp/servers/{server_id}/tools        — list discovered tools + enabled state
  PATCH  /api/mcp/tools/{server_id}/{tool_name}   — toggle tool enabled/disabled

All endpoints are org-scoped via X-Grafana-Org-Id.
"""

from __future__ import annotations

import uuid
from typing import Any

import structlog
from fastapi import APIRouter, Depends, Header, HTTPException, status
from pydantic import BaseModel
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from app.db import get_session
from harness.mcp.client_manager import mcp_client_manager
from harness.mcp.crypto import encrypt_token
from harness.mcp.models import MCPServerConfig

logger = structlog.get_logger()
router = APIRouter()


def _require_org(x_grafana_org_id: str | None = Header(None)) -> int:
    """FastAPI dependency: return the caller's org ID or reject the request.

    Unlike ``_org_id`` this never returns None — a missing or malformed
    ``X-Grafana-Org-Id`` header is a hard 400 so endpoints cannot silently
    fall back to an unscoped or default-org query.

    Args:
        x_grafana_org_id: Grafana org ID header (injected by the Go proxy).

    Returns:
        Parsed org ID.

    Raises:
        HTTPException: 400 if the header is missing or not an integer.
    """
    if x_grafana_org_id:
        try:
            return int(x_grafana_org_id)
        except ValueError:
            pass
    raise HTTPException(
        status_code=status.HTTP_400_BAD_REQUEST,
        detail="Missing or invalid X-Grafana-Org-Id header.",
    )


async def _assert_server_owned_by_org(
    db: AsyncSession, server_id: uuid.UUID, org_id: int
) -> None:
    """Raise 404 unless ``server_id`` exists and belongs to ``org_id``.

    Returns 404 (not 403) so callers cannot distinguish "exists but not yours"
    from "does not exist" — avoids cross-org existence enumeration.

    Args:
        db: Async DB session.
        server_id: MCP server UUID.
        org_id: Caller's org ID.

    Raises:
        HTTPException: 404 if the server does not exist for this org.
    """
    row = (
        await db.execute(
            text("SELECT id FROM mcp_server_configs WHERE id = :id AND org_id = :org_id"),
            {"id": server_id, "org_id": org_id},
        )
    ).fetchone()
    if row is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"MCP server {server_id} not found.",
        )


# ---------------------------------------------------------------------------
# Schemas
# ---------------------------------------------------------------------------


class AddServerRequest(BaseModel):
    """Request body for adding a new MCP server."""

    name: str
    url: str  # SSE endpoint URL
    transport: str = "sse"
    token: str | None = None  # plain-text; stored encrypted


class ToolToggleRequest(BaseModel):
    """Request body for toggling a tool."""

    enabled: bool


# ---------------------------------------------------------------------------
# GET /api/mcp/servers
# ---------------------------------------------------------------------------


@router.get("/mcp/servers", summary="List MCP servers for the current org")
async def list_mcp_servers(
    db: AsyncSession = Depends(get_session),
    org_id: int = Depends(_require_org),
) -> dict[str, Any]:
    """List all configured MCP servers for the caller's org.

    Args:
        db: Async DB session.
        org_id: Grafana org ID from header (required).

    Returns:
        Dict with ``servers`` list.
    """
    rows = (
        await db.execute(
            text(
                "SELECT id, org_id, name, url, transport, enabled, created_at "
                "FROM mcp_server_configs WHERE org_id = :org_id ORDER BY created_at"
            ),
            {"org_id": org_id},
        )
    ).fetchall()

    servers = [
        {
            "id": str(row.id),
            "org_id": row.org_id,
            "name": row.name,
            "url": row.url,
            "transport": row.transport,
            "enabled": row.enabled,
            "created_at": row.created_at.isoformat() if row.created_at else None,
            "connected": str(row.id) in {str(k) for k in mcp_client_manager._configs},
            "tool_count": len(mcp_client_manager.get_discovered_tools(row.id)),
        }
        for row in rows
    ]
    return {"servers": servers}


# ---------------------------------------------------------------------------
# POST /api/mcp/servers
# ---------------------------------------------------------------------------


@router.post("/mcp/servers", status_code=201, summary="Add and connect an MCP server")
async def add_mcp_server(
    body: AddServerRequest,
    db: AsyncSession = Depends(get_session),
    org_id: int = Depends(_require_org),
) -> dict[str, Any]:
    """Add a new MCP server config and attempt to connect immediately.

    Args:
        body: Server details (name, url, token).
        db: Async DB session.
        org_id: Grafana org ID from header (required).

    Returns:
        Created server config with discovered tool count.

    Raises:
        HTTPException: 409 if (org_id, url) already exists.
        HTTPException: 422 if connection fails.
    """
    log = logger.bind(server=body.name, org_id=org_id)

    token_enc = encrypt_token(body.token) if body.token else None

    try:
        row = (
            await db.execute(
                text("""
                    INSERT INTO mcp_server_configs (org_id, name, url, transport, token_encrypted)
                    VALUES (:org_id, :name, :url, :transport, :token)
                    RETURNING id, org_id, name, url, transport, enabled, created_at
                """),
                {
                    "org_id": org_id,
                    "name": body.name,
                    "url": body.url,
                    "transport": body.transport,
                    "token": token_enc,
                },
            )
        ).fetchone()
        await db.commit()
    except Exception as exc:
        if "uq_mcp_server_org_url" in str(exc):
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail=f"Server with URL {body.url!r} already exists for this org.",
            ) from exc
        raise

    assert row is not None
    cfg = MCPServerConfig(
        id=row.id,
        org_id=row.org_id,
        name=row.name,
        url=row.url,
        transport=row.transport,
        token_encrypted=token_enc,
    )

    tool_count = 0
    connect_error: str | None = None
    try:
        tools = await mcp_client_manager.connect(cfg, db)
        tool_count = len(tools)
        log.info("mcp_server_added_and_connected", tool_count=tool_count)
    except Exception as exc:
        connect_error = str(exc)
        log.warning("mcp_server_added_connect_failed", error=connect_error)

    return {
        "id": str(row.id),
        "org_id": row.org_id,
        "name": row.name,
        "url": row.url,
        "transport": row.transport,
        "enabled": row.enabled,
        "created_at": row.created_at.isoformat() if row.created_at else None,
        "tool_count": tool_count,
        "connect_error": connect_error,
    }


# ---------------------------------------------------------------------------
# DELETE /api/mcp/servers/{server_id}
# ---------------------------------------------------------------------------


@router.delete(
    "/mcp/servers/{server_id}",
    status_code=204,
    summary="Disconnect and delete an MCP server",
)
async def delete_mcp_server(
    server_id: uuid.UUID,
    db: AsyncSession = Depends(get_session),
    org_id: int = Depends(_require_org),
) -> None:
    """Disconnect and permanently delete an MCP server config.

    Args:
        server_id: Server UUID.
        db: Async DB session.
        org_id: Grafana org ID (required).

    Raises:
        HTTPException: 404 if server not found for this org.
    """
    await _assert_server_owned_by_org(db, server_id, org_id)

    await mcp_client_manager.disconnect(server_id)

    await db.execute(
        text("DELETE FROM mcp_server_configs WHERE id = :id AND org_id = :org_id"),
        {"id": server_id, "org_id": org_id},
    )
    await db.commit()
    logger.info("mcp_server_deleted", server_id=str(server_id), org_id=org_id)


# ---------------------------------------------------------------------------
# POST /api/mcp/servers/{server_id}/reconnect
# ---------------------------------------------------------------------------


@router.post(
    "/mcp/servers/{server_id}/reconnect",
    summary="Force reconnect and re-discover tools",
)
async def reconnect_mcp_server(
    server_id: uuid.UUID,
    db: AsyncSession = Depends(get_session),
    org_id: int = Depends(_require_org),
) -> dict[str, Any]:
    """Disconnect and reconnect an MCP server, refreshing tool discovery.

    Args:
        server_id: Server UUID.
        db: Async DB session.
        org_id: Grafana org ID (required).

    Returns:
        Updated tool count.

    Raises:
        HTTPException: 404 if not found, 422 if reconnect fails.
    """
    row = (
        await db.execute(
            text(
                "SELECT id, org_id, name, url, transport, token_encrypted, enabled "
                "FROM mcp_server_configs WHERE id = :id AND org_id = :org_id"
            ),
            {"id": server_id, "org_id": org_id},
        )
    ).fetchone()

    if row is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"MCP server {server_id} not found.",
        )

    cfg = MCPServerConfig(
        id=row.id,
        org_id=row.org_id,
        name=row.name,
        url=row.url,
        transport=row.transport,
        token_encrypted=row.token_encrypted,
        enabled=row.enabled,
    )

    try:
        tools = await mcp_client_manager.connect(cfg, db)
        return {"server_id": str(server_id), "tool_count": len(tools)}
    except Exception as exc:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=f"Reconnect failed: {exc}",
        ) from exc


# ---------------------------------------------------------------------------
# GET /api/mcp/servers/{server_id}/tools
# ---------------------------------------------------------------------------


@router.get(
    "/mcp/servers/{server_id}/tools",
    summary="List discovered tools for an MCP server",
)
async def list_mcp_tools(
    server_id: uuid.UUID,
    db: AsyncSession = Depends(get_session),
    org_id: int = Depends(_require_org),
) -> dict[str, Any]:
    """Return discovered tools and their enabled state for a server.

    Args:
        server_id: Server UUID.
        db: Async DB session.
        org_id: Grafana org ID (required, used for ownership check).

    Returns:
        Dict with ``tools`` list.

    Raises:
        HTTPException: 404 if the server does not belong to this org.
    """
    await _assert_server_owned_by_org(db, server_id, org_id)

    tools = mcp_client_manager.get_discovered_tools(server_id)
    return {
        "server_id": str(server_id),
        "tools": [
            {
                "name": dt.tool_name,
                "qualified_name": dt.qualified_name,
                "description": dt.description,
                "enabled": dt.enabled,
            }
            for dt in tools
        ],
    }


# ---------------------------------------------------------------------------
# PATCH /api/mcp/tools/{server_id}/{tool_name}
# ---------------------------------------------------------------------------


@router.patch(
    "/mcp/tools/{server_id}/{tool_name}",
    summary="Enable or disable a single MCP tool",
)
async def toggle_mcp_tool(
    server_id: uuid.UUID,
    tool_name: str,
    body: ToolToggleRequest,
    db: AsyncSession = Depends(get_session),
    org_id: int = Depends(_require_org),
) -> dict[str, Any]:
    """Enable or disable an MCP tool for a specific server.

    Upserts an override row in mcp_tool_overrides and immediately
    updates the in-memory ToolRegistry.

    Args:
        server_id: Server UUID.
        tool_name: Bare tool name on the MCP server.
        body: New enabled state.
        db: Async DB session.
        org_id: Grafana org ID (required, used for ownership check).

    Returns:
        Updated tool state.

    Raises:
        HTTPException: 404 if the server does not belong to this org.
    """
    await _assert_server_owned_by_org(db, server_id, org_id)

    await mcp_client_manager.set_tool_enabled(server_id, tool_name, body.enabled, db)
    logger.info(
        "mcp_tool_toggled",
        server_id=str(server_id),
        tool_name=tool_name,
        enabled=body.enabled,
        org_id=org_id,
    )
    return {"server_id": str(server_id), "tool_name": tool_name, "enabled": body.enabled}
