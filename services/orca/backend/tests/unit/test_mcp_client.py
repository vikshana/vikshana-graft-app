"""Unit tests for MCP client configuration helpers.

Verifies SSE mode, org_id header injection, stdio fallback, and
per-request config generation without requiring a running MCP server.
"""

from unittest.mock import patch

import pytest

from app.agent.mcp.grafana_client import get_grafana_mcp_config
from app.agent.mcp.postgres_client import get_postgres_mcp_config


# ---------------------------------------------------------------------------
# Grafana MCP client
# ---------------------------------------------------------------------------


def test_grafana_mcp_config_sse_mode_with_org_id():
    """SSE mode with org_id should add X-Grafana-Org-Id header."""
    with patch("app.agent.mcp.grafana_client.settings") as mock_settings:
        mock_settings.GRAFANA_MCP_URL = "http://mcp-grafana:3001/sse"
        mock_settings.GRAFANA_ADMIN_TOKEN = "test-token"
        mock_settings.GRAFANA_URL = "http://grafana:3000"

        config = get_grafana_mcp_config(org_id=42)

    assert "grafana" in config
    grafana_cfg = config["grafana"]
    assert grafana_cfg["transport"] == "sse"
    assert grafana_cfg["url"] == "http://mcp-grafana:3001/sse"
    assert grafana_cfg["headers"]["X-Grafana-Org-Id"] == "42"


def test_grafana_mcp_config_sse_mode_without_org_id():
    """SSE mode without org_id should not include X-Grafana-Org-Id header."""
    with patch("app.agent.mcp.grafana_client.settings") as mock_settings:
        mock_settings.GRAFANA_MCP_URL = "http://mcp-grafana:3001/sse"
        mock_settings.GRAFANA_ADMIN_TOKEN = "test-token"
        mock_settings.GRAFANA_URL = "http://grafana:3000"

        config = get_grafana_mcp_config(org_id=None)

    assert "grafana" in config
    grafana_cfg = config["grafana"]
    assert grafana_cfg["transport"] == "sse"
    assert "headers" not in grafana_cfg or "X-Grafana-Org-Id" not in grafana_cfg.get("headers", {})


def test_grafana_mcp_config_stdio_fallback():
    """When GRAFANA_MCP_URL is unset, should fall back to stdio config."""
    with patch("app.agent.mcp.grafana_client.settings") as mock_settings:
        mock_settings.GRAFANA_MCP_URL = ""
        mock_settings.GRAFANA_ADMIN_TOKEN = "test-token"
        mock_settings.GRAFANA_URL = "http://grafana:3000"

        config = get_grafana_mcp_config(org_id=1)

    assert "grafana" in config
    grafana_cfg = config["grafana"]
    # stdio fallback should not have a transport key or have transport=stdio
    assert grafana_cfg.get("transport") != "sse"


def test_grafana_mcp_config_org_id_zero_not_injected():
    """org_id=0 should be treated as falsy and not inject a header."""
    with patch("app.agent.mcp.grafana_client.settings") as mock_settings:
        mock_settings.GRAFANA_MCP_URL = "http://mcp-grafana:3001/sse"
        mock_settings.GRAFANA_ADMIN_TOKEN = "test-token"
        mock_settings.GRAFANA_URL = "http://grafana:3000"

        config = get_grafana_mcp_config(org_id=0)

    grafana_cfg = config["grafana"]
    # org_id=0 is falsy, so header should not be present
    assert "headers" not in grafana_cfg or "X-Grafana-Org-Id" not in grafana_cfg.get("headers", {})


# ---------------------------------------------------------------------------
# Postgres MCP client
# ---------------------------------------------------------------------------


def test_postgres_mcp_config_sse_mode():
    """When POSTGRES_MCP_URL is set, should return SSE config."""
    with patch("app.agent.mcp.postgres_client.settings") as mock_settings:
        mock_settings.POSTGRES_MCP_URL = "http://mcp-postgres:3002/sse"
        mock_settings.DATABASE_URL = "postgresql+asyncpg://orca:pass@localhost/orca"

        config = get_postgres_mcp_config()

    assert "postgres" in config
    pg_cfg = config["postgres"]
    assert pg_cfg["transport"] == "sse"
    assert pg_cfg["url"] == "http://mcp-postgres:3002/sse"


def test_postgres_mcp_config_stdio_fallback():
    """When POSTGRES_MCP_URL is unset, should fall back to stdio config."""
    with patch("app.agent.mcp.postgres_client.settings") as mock_settings:
        mock_settings.POSTGRES_MCP_URL = ""
        mock_settings.DATABASE_URL = "postgresql+asyncpg://orca:pass@localhost/orca"

        config = get_postgres_mcp_config()

    assert "postgres" in config
    pg_cfg = config["postgres"]
    assert pg_cfg.get("transport") != "sse"
