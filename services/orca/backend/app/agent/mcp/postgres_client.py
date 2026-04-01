"""Postgres MCP client configuration for searching historical RCA data.

Transport modes
---------------
1. **SSE sidecar** (preferred, used when running via Docker Compose):
   The ``mcp-postgres`` Docker service wraps ``@modelcontextprotocol/server-postgres``
   as an HTTP/SSE server via ``supergateway``.  ``POSTGRES_MCP_URL`` points at it.

2. **stdio subprocess** (local dev fallback):
   If ``POSTGRES_MCP_URL`` is not set, the MCP server is spawned as a subprocess
   via ``npx``.  Node.js and npx must be on PATH.

Note: In Phase 2 the historical context retrieval will move to direct pgvector
queries, making this client redundant. It is retained for Phase 1 compatibility.
"""

import os
from typing import Any

import structlog
from langchain_mcp_adapters.client import MultiServerMCPClient

from app.config import settings

logger = structlog.get_logger()


def get_postgres_mcp_config() -> dict[str, Any]:
    """Return the MultiServerMCPClient server configuration for Postgres.

    Selects between SSE sidecar mode and stdio subprocess mode based on
    whether ``POSTGRES_MCP_URL`` is set in the environment.

    Returns:
        Dictionary suitable for passing to MultiServerMCPClient as server config.
    """
    postgres_mcp_url = settings.POSTGRES_MCP_URL.strip()

    if postgres_mcp_url:
        # ------------------------------------------------------------------
        # Mode 1: SSE sidecar — connect to the persistent mcp-postgres server
        # running via supergateway.
        # ------------------------------------------------------------------
        logger.info(
            "postgres_mcp_mode",
            mode="sse_sidecar",
            url=postgres_mcp_url,
        )
        return {
            "postgres": {
                "url": postgres_mcp_url,
                "transport": "sse",
            }
        }

    # ----------------------------------------------------------------------
    # Mode 2: stdio subprocess — spawn via npx (local dev).
    # Requires Node.js and npx to be on PATH.
    # ----------------------------------------------------------------------
    logger.info("postgres_mcp_mode", mode="stdio_subprocess")

    # Convert asyncpg URL to plain postgres URL for the MCP server
    db_url = settings.DATABASE_URL.replace("postgresql+asyncpg://", "postgresql://")
    env = dict(os.environ)

    return {
        "postgres": {
            "command": "npx",
            "args": ["-y", "@modelcontextprotocol/server-postgres@latest", db_url],
            "env": env,
            "transport": "stdio",
        }
    }


async def get_postgres_tools() -> list[Any]:
    """Start the Postgres MCP server and return available tools.

    Connects to or spawns the Postgres MCP server configured to connect to
    Orca's database, returning all available query tools.

    Returns:
        List of LangChain tool objects for querying the Orca Postgres database.

    Raises:
        RuntimeError: If the MCP server fails to start or no tools are returned.
    """
    log = logger.bind(mcp_server="postgres")

    try:
        client = MultiServerMCPClient(get_postgres_mcp_config())
        tools = await client.get_tools()
        log.info(
            "postgres_tools_loaded",
            total=len(tools),
            tool_names=[t.name for t in tools],
        )
        return tools
    except Exception as exc:
        log.error("postgres_mcp_failed", error=str(exc))
        raise RuntimeError(f"Failed to load Postgres MCP tools: {exc}") from exc
