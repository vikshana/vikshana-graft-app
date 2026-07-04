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
        enabled: Whether enabled by override (default True).
    """

    server_id: uuid.UUID
    server_name: str
    tool_name: str
    description: str
    input_schema: dict
    enabled: bool = True

    @property
    def qualified_name(self) -> str:
        """Return ``mcp:{server_name}:{tool_name}``."""
        return f"mcp:{self.server_name}:{self.tool_name}"
