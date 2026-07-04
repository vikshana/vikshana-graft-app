"""MCPClientManager — lifecycle management for per-org MCP server connections.

Responsibilities:
1. On startup: load all enabled server configs from DB and connect.
2. On connect: call tools/list on the MCP server, register tools in
   ToolRegistry with mcp:{server_name}:{tool_name} prefix and _org_id tag.
3. On disconnect: deregister all tools for that server from ToolRegistry.
4. On toggle: update mcp_tool_overrides and re-register/deregister tool.

Thread-safety: all mutations go through asyncio.Lock (single-process).
"""

from __future__ import annotations

import asyncio
import uuid
from typing import Any

import httpx
import structlog
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from harness.mcp.crypto import decrypt_token, encrypt_token
from harness.mcp.models import DiscoveredTool, MCPServerConfig
from harness.mcp.tool_adapter import MCPTool
from harness.tools.registry import tool_registry

logger = structlog.get_logger()


async def _call_mcp_tools_list(url: str, token: str | None) -> list[dict]:
    """Call tools/list on an SSE MCP server.

    Sends a JSON-RPC 2.0 request to the MCP server's HTTP endpoint and
    returns the list of tool dicts from the response.

    Args:
        url: Base SSE URL of the MCP server (e.g. http://host:3001/sse).
        token: Optional bearer token for authentication.

    Returns:
        List of tool dicts from the MCP server.

    Raises:
        RuntimeError: If the server returns an error or is unreachable.
    """
    # MCP SSE servers expose a /tools/list HTTP endpoint alongside the SSE stream
    base = url.rstrip("/sse").rstrip("/")
    tools_url = f"{base}/tools/list"

    headers: dict[str, str] = {"Content-Type": "application/json"}
    if token:
        headers["Authorization"] = f"Bearer {token}"

    payload = {"jsonrpc": "2.0", "id": 1, "method": "tools/list", "params": {}}

    async with httpx.AsyncClient(timeout=10.0) as client:
        resp = await client.post(tools_url, json=payload, headers=headers)
        resp.raise_for_status()
        data = resp.json()

    if "error" in data:
        raise RuntimeError(f"MCP tools/list error: {data['error']}")

    return data.get("result", {}).get("tools", [])


async def _call_mcp_tool(url: str, token: str | None, tool_name: str, args: dict) -> Any:
    """Invoke a tool on an MCP server.

    Args:
        url: Base SSE URL of the MCP server.
        token: Optional bearer token.
        tool_name: Bare tool name on the server.
        args: Tool arguments dict.

    Returns:
        Tool result (string or dict).
    """
    base = url.rstrip("/sse").rstrip("/")
    call_url = f"{base}/tools/call"

    headers: dict[str, str] = {"Content-Type": "application/json"}
    if token:
        headers["Authorization"] = f"Bearer {token}"

    payload = {
        "jsonrpc": "2.0",
        "id": 1,
        "method": "tools/call",
        "params": {"name": tool_name, "arguments": args},
    }

    async with httpx.AsyncClient(timeout=30.0) as client:
        resp = await client.post(call_url, json=payload, headers=headers)
        resp.raise_for_status()
        data = resp.json()

    if "error" in data:
        raise RuntimeError(f"MCP tool call error: {data['error']}")

    result = data.get("result", {})
    content = result.get("content", [])
    if content and isinstance(content, list) and content[0].get("type") == "text":
        return content[0]["text"]
    return result


class MCPClientManager:
    """Manages MCP server connections and tool registration for all orgs.

    One singleton per application process.  All state is in-memory with
    Postgres as the source of truth for server configs and tool overrides.

    Usage::

        manager = MCPClientManager()
        async with lifespan:
            await manager.startup(db_session_factory)
            # ... serve requests ...
            await manager.shutdown()
    """

    def __init__(self) -> None:
        # {server_id → MCPServerConfig}
        self._configs: dict[uuid.UUID, MCPServerConfig] = {}
        # {server_id → list[DiscoveredTool]}
        self._discovered: dict[uuid.UUID, list[DiscoveredTool]] = {}
        self._lock = asyncio.Lock()

    async def startup(self, db: AsyncSession) -> None:
        """Load all enabled servers from DB and connect.

        Called once from the FastAPI lifespan.

        Args:
            db: Async DB session for reading configs.
        """
        rows = (
            await db.execute(
                text("SELECT id, org_id, name, url, transport, token_encrypted, enabled FROM mcp_server_configs WHERE enabled = true")
            )
        ).fetchall()

        for row in rows:
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
                await self.connect(cfg, db)
            except Exception as exc:
                logger.warning("mcp_startup_connect_failed", server=cfg.name, error=str(exc))

    async def shutdown(self) -> None:
        """Disconnect all servers and deregister their tools."""
        async with self._lock:
            for server_id in list(self._discovered.keys()):
                self._deregister_server_tools(server_id)
            self._configs.clear()
            self._discovered.clear()

    async def connect(self, cfg: MCPServerConfig, db: AsyncSession) -> list[DiscoveredTool]:
        """Connect to an MCP server, discover tools, register in ToolRegistry.

        Args:
            cfg: Server configuration.
            db: DB session for reading tool overrides.

        Returns:
            List of discovered tools.

        Raises:
            RuntimeError: If the server is unreachable or returns an error.
        """
        log = logger.bind(server=cfg.name, org_id=cfg.org_id)
        token = decrypt_token(cfg.token_encrypted) if cfg.token_encrypted else None

        raw_tools = await _call_mcp_tools_list(cfg.url, token)
        log.info("mcp_tools_discovered", count=len(raw_tools))

        # Load tool overrides from DB
        overrides_rows = (
            await db.execute(
                text("SELECT tool_name, enabled FROM mcp_tool_overrides WHERE server_id = :sid"),
                {"sid": cfg.id},
            )
        ).fetchall()
        overrides: dict[str, bool] = {row.tool_name: row.enabled for row in overrides_rows}

        discovered: list[DiscoveredTool] = []
        for raw in raw_tools:
            tool_name = raw.get("name", "")
            if not tool_name:
                continue
            enabled = overrides.get(tool_name, True)
            dt = DiscoveredTool(
                server_id=cfg.id,
                server_name=cfg.name,
                tool_name=tool_name,
                description=raw.get("description", ""),
                input_schema=raw.get("inputSchema", {}),
                enabled=enabled,
            )
            discovered.append(dt)

        async with self._lock:
            # Deregister any previously registered tools for this server
            if cfg.id in self._discovered:
                self._deregister_server_tools(cfg.id)

            self._configs[cfg.id] = cfg
            self._discovered[cfg.id] = discovered

            for dt in discovered:
                if not dt.enabled:
                    continue
                mcp_tool = self._build_mcp_tool(cfg, dt, token)
                try:
                    tool_registry.register(mcp_tool, replace=True)
                    log.debug("mcp_tool_registered", tool=dt.qualified_name)
                except Exception as exc:
                    log.warning("mcp_tool_register_failed", tool=dt.qualified_name, error=str(exc))

        return discovered

    async def disconnect(self, server_id: uuid.UUID) -> None:
        """Disconnect a server and deregister all its tools.

        Args:
            server_id: UUID of the server to disconnect.
        """
        async with self._lock:
            self._deregister_server_tools(server_id)
            self._configs.pop(server_id, None)
            self._discovered.pop(server_id, None)

    async def set_tool_enabled(
        self,
        server_id: uuid.UUID,
        tool_name: str,
        enabled: bool,
        db: AsyncSession,
    ) -> None:
        """Enable or disable a single tool.

        Upserts the mcp_tool_overrides row and re-registers or deregisters
        the tool from ToolRegistry.

        Args:
            server_id: Server UUID.
            tool_name: Bare tool name.
            enabled: New enabled state.
            db: DB session for upsert.
        """
        # Upsert the override row
        await db.execute(
            text("""
                INSERT INTO mcp_tool_overrides (server_id, tool_name, enabled)
                VALUES (:sid, :name, :enabled)
                ON CONFLICT (server_id, tool_name)
                DO UPDATE SET enabled = EXCLUDED.enabled
            """),
            {"sid": server_id, "name": tool_name, "enabled": enabled},
        )
        await db.commit()

        cfg = self._configs.get(server_id)
        if cfg is None:
            return

        token = decrypt_token(cfg.token_encrypted) if cfg.token_encrypted else None

        async with self._lock:
            tools = self._discovered.get(server_id, [])
            for dt in tools:
                if dt.tool_name != tool_name:
                    continue
                dt.enabled = enabled
                if enabled:
                    mcp_tool = self._build_mcp_tool(cfg, dt, token)
                    tool_registry.register(mcp_tool, replace=True)
                else:
                    tool_registry._tools.pop(dt.qualified_name, None)
                break

    def get_discovered_tools(self, server_id: uuid.UUID) -> list[DiscoveredTool]:
        """Return discovered tools for a server.

        Args:
            server_id: Server UUID.

        Returns:
            List of DiscoveredTool instances (empty if not connected).
        """
        return list(self._discovered.get(server_id, []))

    def _deregister_server_tools(self, server_id: uuid.UUID) -> None:
        """Remove all registered tools for a server from ToolRegistry (internal).

        Must be called while holding ``self._lock``.
        """
        for dt in self._discovered.get(server_id, []):
            tool_registry._tools.pop(dt.qualified_name, None)

    def _build_mcp_tool(
        self,
        cfg: MCPServerConfig,
        dt: DiscoveredTool,
        token: str | None,
    ) -> MCPTool:
        """Build an MCPTool instance for a discovered tool.

        Args:
            cfg: Server config.
            dt: Discovered tool metadata.
            token: Decrypted bearer token (or None).

        Returns:
            MCPTool instance ready for ToolRegistry.
        """
        url = cfg.url
        tool_name = dt.tool_name
        org_id = cfg.org_id

        async def _call(tn: str, args: dict) -> Any:
            return await _call_mcp_tool(url, token, tn, args)

        mcp_tool = MCPTool(
            qualified_name=dt.qualified_name,
            description=dt.description,
            input_schema_dict=dt.input_schema,
            mcp_client=_call,
            bare_tool_name=tool_name,
        )
        # Tag with org_id so OrgToolRegistry can filter by org
        mcp_tool._org_id = org_id  # type: ignore[attr-defined]
        return mcp_tool


# Module-level singleton
mcp_client_manager = MCPClientManager()
