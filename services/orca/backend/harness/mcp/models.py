"""Dataclasses for MCP server configuration and tool overrides."""

from __future__ import annotations

import uuid
from dataclasses import dataclass
from datetime import datetime


@dataclass
class MCPServerConfig:
    """Persisted configuration for an MCP server.

    Attributes:
        id: Server UUID (from DB).
        org_id: Grafana org ID that owns this server.
        name: Human-readable display name.
        url: SSE endpoint URL.
        transport: Transport type ('sse').
        token_encrypted: Optional encrypted bearer token.
        enabled: Whether the server is active.
        created_at: Creation timestamp.
    """

    id: uuid.UUID
    org_id: int
    name: str
    url: str
    transport: str = "sse"
    token_encrypted: str | None = None
    enabled: bool = True
    created_at: datetime | None = None


@dataclass
class MCPToolOverride:
    """Per-tool enabled/disabled override for a specific server.

    Attributes:
        server_id: FK to MCPServerConfig.
        tool_name: Bare tool name as reported by the MCP server.
        enabled: Whether this tool is available to sessions.
    """

    server_id: uuid.UUID
    tool_name: str
    enabled: bool = True


@dataclass
class DiscoveredTool:
    """A tool discovered from an MCP server.

    Attributes:
        server_id: FK to MCPServerConfig.
        server_name: Human-readable server name (used for namespace prefix).
        tool_name: Bare tool name from the MCP server.
        description: Tool description from the server.
        input_schema: JSON Schema dict from the server.
        org_id: Grafana org ID that owns the server this tool was discovered
            from. Included in ``qualified_name`` so the registry key itself
            is unique per org (see ``qualified_name`` docstring).
        enabled: Whether enabled by override (default True).
    """

    server_id: uuid.UUID
    server_name: str
    tool_name: str
    description: str
    input_schema: dict
    org_id: int
    enabled: bool = True

    @property
    def qualified_name(self) -> str:
        """Return ``mcp:{org_id}:{server_name}:{tool_name}``.

        The org ID is embedded directly in the registry key — not just as
        an ``_org_id`` tag on the registered tool object — because
        ``harness.tools.registry.ToolRegistry`` is a single process-global
        ``dict[name, Tool]``. Two different orgs are free to name their MCP
        server the same thing (e.g. both call it "github"); without the org
        ID in the key, both orgs' tools would collide on the same
        ``mcp:{server_name}:{tool_name}`` key, and whichever org
        connects/reconnects last would silently overwrite (and disconnecting
        one org's server would deregister the *other* org's live tool from
        the shared registry too). See docs/harness-risk-review.md, F12.
        """
        return f"mcp:{self.org_id}:{self.server_name}:{self.tool_name}"
