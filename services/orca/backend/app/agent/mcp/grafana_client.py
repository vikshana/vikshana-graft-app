"""Grafana MCP client configuration and tool allow-list.

Transport modes
---------------
1. **SSE sidecar** (preferred, used when running via Docker Compose):
   The ``mcp-grafana`` Docker service runs the official ``mcp-grafana`` binary
   as a persistent SSE HTTP server.  ``GRAFANA_MCP_URL`` points at it.
   Per-request org isolation is enforced by injecting ``X-Grafana-Org-Id``
   into every MCP call via the ``org_id`` parameter.

2. **stdio subprocess** (local dev fallback):
   If ``GRAFANA_MCP_URL`` is not set, the ``mcp-grafana`` binary is spawned as
   a subprocess per-investigation.  The binary must be on PATH (install from
   https://github.com/grafana/mcp-grafana/releases).

The GRAFANA_ALLOWED_TOOLS allow-list is kept as a secondary filter on top of
whatever the server exposes — defence-in-depth against accidental tool leakage.

Per-org isolation
-----------------
``get_grafana_mcp_config(org_id=42)`` injects ``X-Grafana-Org-Id: 42`` into
every HTTP request the SSE client sends to mcp-grafana.  The server uses this
header (in conjunction with the admin token) to scope all Grafana API calls to
that organisation's datasources.  Without the header the server uses the
admin token's default org.
"""

import os
import shutil
from pathlib import Path
from typing import Any

import structlog
from langchain_mcp_adapters.client import MultiServerMCPClient

from app.config import settings

logger = structlog.get_logger()

# ---------------------------------------------------------------------------
# Tool allow-list (secondary filter — primary enforcement is on the server)
# ---------------------------------------------------------------------------
GRAFANA_ALLOWED_TOOLS: list[str] = [
    "search_dashboards",
    "get_dashboard_by_uid",
    "query_prometheus",
    "query_loki",
    "list_datasources",
    "get_alerts",
]

# File written by grafana-provisioner; used as fallback for the API key in
# stdio subprocess mode (the sidecar reads it directly via its entrypoint).
_GRAFANA_API_KEY_FILE = Path("/run/orca/GRAFANA_API_KEY")


def get_grafana_mcp_config(org_id: int | None = None) -> dict[str, Any]:
    """Return the MultiServerMCPClient server configuration for Grafana.

    Selects between SSE sidecar mode and stdio subprocess mode based on
    whether ``GRAFANA_MCP_URL`` is set in the environment.

    In SSE mode, ``org_id`` is injected as ``X-Grafana-Org-Id`` on every
    request so the server scopes all Grafana API calls to that organisation.

    Args:
        org_id: Grafana organisation ID to scope this investigation to.
            None means no org header is sent (server uses its default org).

    Returns:
        Dictionary suitable for passing to ``MultiServerMCPClient``.
    """
    grafana_mcp_url = settings.GRAFANA_MCP_URL.strip()

    if grafana_mcp_url:
        # ------------------------------------------------------------------
        # Mode 1: SSE sidecar — connect to the persistent mcp-grafana server.
        # Inject X-Grafana-Org-Id so every tool call is scoped to this org.
        # ------------------------------------------------------------------
        headers: dict[str, str] = {}
        if org_id is not None:
            headers["X-Grafana-Org-Id"] = str(org_id)

        logger.info(
            "grafana_mcp_mode",
            mode="sse_sidecar",
            url=grafana_mcp_url,
            org_id=org_id,
        )
        config: dict[str, Any] = {
            "url": grafana_mcp_url,
            "transport": "sse",
        }
        if headers:
            config["headers"] = headers

        return {"grafana": config}

    # ----------------------------------------------------------------------
    # Mode 2: stdio subprocess — spawn the binary directly (local dev).
    # Org isolation is not available in this mode; use SSE in production.
    # ----------------------------------------------------------------------
    if org_id is not None:
        logger.warning(
            "grafana_mcp_org_id_ignored_in_stdio_mode",
            org_id=org_id,
            hint="Set GRAFANA_MCP_URL to enable per-org isolation via SSE sidecar.",
        )

    binary = shutil.which("mcp-grafana")

    env = dict(os.environ)
    env["GRAFANA_URL"] = settings.GRAFANA_URL

    api_key = settings.GRAFANA_API_KEY
    if not api_key and _GRAFANA_API_KEY_FILE.exists():
        try:
            api_key = _GRAFANA_API_KEY_FILE.read_text().strip()
            if api_key:
                logger.info(
                    "grafana_api_key_loaded_from_file",
                    path=str(_GRAFANA_API_KEY_FILE),
                )
        except OSError as exc:
            logger.warning(
                "grafana_api_key_file_read_error",
                path=str(_GRAFANA_API_KEY_FILE),
                error=str(exc),
            )

    if api_key:
        env["GRAFANA_API_KEY"] = api_key
    else:
        logger.warning(
            "grafana_api_key_not_set",
            hint="Set GRAFANA_API_KEY in .env or run via Docker Compose to use the SSE sidecar.",
        )

    if binary:
        logger.info("grafana_mcp_mode", mode="stdio_binary", binary=binary)
        return {
            "grafana": {
                "command": binary,
                "args": [
                    "-enabled-tools",
                    "search,datasource,prometheus,loki,alerting,dashboard",
                ],
                "env": env,
                "transport": "stdio",
            }
        }

    # Last resort: npx
    logger.error(
        "grafana_mcp_binary_not_found",
        hint=(
            "mcp-grafana binary not found. "
            "Install from https://github.com/grafana/mcp-grafana/releases "
            "or run via Docker Compose to use the SSE sidecar."
        ),
    )
    return {
        "grafana": {
            "command": "npx",
            "args": ["-y", "@grafana/mcp-grafana@latest"],
            "env": env,
            "transport": "stdio",
        }
    }


async def get_grafana_tools(org_id: int | None = None) -> list[Any]:
    """Start the Grafana MCP server and return the allowed tool list.

    Spawns or connects to the Grafana MCP server, retrieves all available
    tools, and filters to the explicit allow-list defined in
    ``GRAFANA_ALLOWED_TOOLS``.

    Args:
        org_id: Grafana organisation ID to scope this investigation to.

    Returns:
        List of LangChain tool objects that the agent may call.

    Raises:
        RuntimeError: If the MCP server fails to start or no tools are returned.
    """
    log = logger.bind(mcp_server="grafana", org_id=org_id)

    try:
        client = MultiServerMCPClient(get_grafana_mcp_config(org_id=org_id))
        all_tools = await client.get_tools()
        allowed = [t for t in all_tools if t.name in GRAFANA_ALLOWED_TOOLS]
        log.info(
            "grafana_tools_loaded",
            total=len(all_tools),
            allowed=len(allowed),
            tool_names=[t.name for t in allowed],
        )
        return allowed
    except Exception as exc:
        log.error("grafana_mcp_failed", error=str(exc))
        raise RuntimeError(f"Failed to load Grafana MCP tools: {exc}") from exc
