"""Unit tests for MCPClientManager org-scoping and the F12 collision fix.

Covers:
  - DiscoveredTool.qualified_name embeds org_id (F12 fix).
  - Two different orgs configuring a same-named MCP server/tool do not
    collide in the shared ToolRegistry singleton (previously the second
    org's `connect()` would silently overwrite the first org's registered
    tool at the same dict key, and disconnecting one org's server would
    deregister the other org's live tool).
  - An org cannot reach another org's same-named MCP tool through
    OrgToolRegistry, which is what the live tool-execution path
    (harness.tools.bridge.GuardedToolExecutor) uses to resolve tool calls.
"""

from __future__ import annotations

import uuid
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from harness.mcp.client_manager import MCPClientManager
from harness.mcp.models import DiscoveredTool, MCPServerConfig
from harness.mcp.registry_bridge import OrgToolRegistry
from harness.tools.registry import tool_registry


@pytest.fixture(autouse=True)
def _clean_shared_tool_registry():
    """Ensure the process-global ToolRegistry singleton starts and ends empty.

    `MCPClientManager` registers into `harness.tools.registry.tool_registry`
    directly (by design — it is the shared runtime source of tools for all
    orgs), so tests that exercise `connect()`/`disconnect()` must not leak
    registrations into other test modules.
    """
    tool_registry.clear()
    yield
    tool_registry.clear()


def _mock_db(overrides: list | None = None) -> AsyncMock:
    db = AsyncMock()
    db.execute = AsyncMock(
        return_value=MagicMock(fetchall=MagicMock(return_value=overrides or []))
    )
    db.commit = AsyncMock()
    return db


# ---------------------------------------------------------------------------
# DiscoveredTool.qualified_name — F12 fix
# ---------------------------------------------------------------------------


class TestQualifiedNameOrgScoping:
    def test_qualified_name_includes_org_id(self) -> None:
        dt = DiscoveredTool(
            server_id=uuid.uuid4(),
            server_name="github",
            tool_name="search_issues",
            description="d",
            input_schema={},
            org_id=42,
        )
        assert dt.qualified_name == "mcp:42:github:search_issues"

    def test_different_orgs_same_server_and_tool_name_yield_different_keys(self) -> None:
        """The whole point of the fix: same server_name + tool_name, different
        org_id, must not produce the same registry key."""
        common = dict(
            server_id=uuid.uuid4(),
            server_name="github",
            tool_name="search_issues",
            description="d",
            input_schema={},
        )
        dt_org1 = DiscoveredTool(org_id=1, **common)
        dt_org2 = DiscoveredTool(org_id=2, **common)
        assert dt_org1.qualified_name != dt_org2.qualified_name


# ---------------------------------------------------------------------------
# MCPClientManager.connect() — cross-org collision (F12) via the live registry
# ---------------------------------------------------------------------------


class TestMCPClientManagerOrgIsolation:
    async def _connect_org(
        self,
        manager: MCPClientManager,
        org_id: int,
        server_name: str = "github",
        tool_name: str = "search_issues",
    ) -> MCPServerConfig:
        """Connect a fake MCP server for the given org, returning its config."""
        from unittest.mock import patch

        cfg = MCPServerConfig(
            id=uuid.uuid4(),
            org_id=org_id,
            name=server_name,
            url=f"http://mcp-{server_name}-org{org_id}:3001/sse",
        )
        raw_tools = [{"name": tool_name, "description": "d", "inputSchema": {}}]
        with patch(
            "harness.mcp.client_manager._call_mcp_tools_list",
            new=AsyncMock(return_value=raw_tools),
        ):
            await manager.connect(cfg, _mock_db())
        return cfg

    async def test_two_orgs_same_server_name_both_remain_registered(self) -> None:
        """Before the F12 fix, org2's connect() would silently overwrite
        org1's registration at the shared `mcp:{server_name}:{tool_name}` key.
        After the fix, both orgs get distinct keys and both stay registered.
        """
        manager = MCPClientManager()

        cfg1 = await self._connect_org(manager, org_id=1)
        cfg2 = await self._connect_org(manager, org_id=2)

        dt1 = manager.get_discovered_tools(cfg1.id)[0]
        dt2 = manager.get_discovered_tools(cfg2.id)[0]

        assert dt1.qualified_name != dt2.qualified_name
        # Both tools are simultaneously present in the shared registry —
        # neither org's connect() evicted the other's.
        assert tool_registry.get(dt1.qualified_name) is not None
        assert tool_registry.get(dt2.qualified_name) is not None

    async def test_disconnecting_one_org_does_not_remove_the_others_tool(self) -> None:
        """Disconnecting org1's same-named server must not deregister org2's
        live tool from the shared registry (the "disconnecting one org
        removes the other's tool" failure mode described in F12)."""
        manager = MCPClientManager()

        cfg1 = await self._connect_org(manager, org_id=1)
        cfg2 = await self._connect_org(manager, org_id=2)
        dt2 = manager.get_discovered_tools(cfg2.id)[0]

        await manager.disconnect(cfg1.id)

        # org2's tool must still be registered and retrievable.
        assert tool_registry.get(dt2.qualified_name) is not None

    async def test_org_cannot_access_another_orgs_same_named_mcp_tool(self) -> None:
        """The concrete cross-org access check: OrgToolRegistry — which the
        live tool-execution path (harness.tools.bridge.GuardedToolExecutor)
        uses to resolve tool calls — must deny org2 access to org1's
        same-named tool, and vice versa.
        """
        manager = MCPClientManager()

        cfg1 = await self._connect_org(manager, org_id=1)
        cfg2 = await self._connect_org(manager, org_id=2)
        dt1 = manager.get_discovered_tools(cfg1.id)[0]
        dt2 = manager.get_discovered_tools(cfg2.id)[0]

        org1_view = OrgToolRegistry(org_id=1, registry=tool_registry)
        org2_view = OrgToolRegistry(org_id=2, registry=tool_registry)

        # Each org can reach its own tool...
        assert org1_view.get(dt1.qualified_name) is not None
        assert org2_view.get(dt2.qualified_name) is not None

        # ...but neither can reach the other's same-named tool, even though
        # both were configured with the identical server_name/tool_name.
        with pytest.raises(KeyError):
            org2_view.get(dt1.qualified_name)
        with pytest.raises(KeyError):
            org1_view.get(dt2.qualified_name)

        # And each org's tool_specs() (what the LLM is told is callable)
        # never leaks the other org's same-named tool.
        org1_names = {s["name"] for s in org1_view.tool_specs()}
        org2_names = {s["name"] for s in org2_view.tool_specs()}
        assert dt2.qualified_name not in org1_names
        assert dt1.qualified_name not in org2_names

    async def test_set_tool_enabled_toggles_only_the_targeted_orgs_tool(self) -> None:
        """Disabling org1's tool via set_tool_enabled must not affect org2's
        same-named tool."""
        manager = MCPClientManager()

        cfg1 = await self._connect_org(manager, org_id=1)
        cfg2 = await self._connect_org(manager, org_id=2)
        dt1 = manager.get_discovered_tools(cfg1.id)[0]
        dt2 = manager.get_discovered_tools(cfg2.id)[0]

        await manager.set_tool_enabled(cfg1.id, dt1.tool_name, False, _mock_db())

        with pytest.raises(KeyError):
            tool_registry.get(dt1.qualified_name)
        # org2's tool, sharing the same bare tool_name/server_name, is untouched.
        assert tool_registry.get(dt2.qualified_name) is not None


# ---------------------------------------------------------------------------
# F9 — decrypt_token must never return ciphertext; callers must fail closed
# ---------------------------------------------------------------------------
#
# `decrypt_token` raises `TokenDecryptionError` instead of returning
# ciphertext when a key is configured but decryption fails (malformed
# ciphertext or a rotated/mismatched key). These tests assert
# `MCPClientManager` fails closed on that error: no network call is ever
# made with the bad value, and no tool is registered as callable.


class TestMCPClientManagerFailsClosedOnTokenDecryptFailure:
    async def test_connect_never_contacts_server_when_ciphertext_malformed(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """A key IS configured but the stored token_encrypted value is not
        valid Fernet ciphertext. connect() must abort before ever calling
        the MCP server — the malformed value must never be sent as a
        bearer token."""
        from cryptography.fernet import Fernet

        from harness.mcp.crypto import TokenDecryptionError

        monkeypatch.setenv("MCP_ENCRYPTION_KEY", Fernet.generate_key().decode())

        manager = MCPClientManager()
        cfg = MCPServerConfig(
            id=uuid.uuid4(),
            org_id=1,
            name="broken-token-server",
            url="http://mcp-broken:3001/sse",
            token_encrypted="not-a-real-fernet-token",
        )

        tools_list_mock = AsyncMock(
            return_value=[{"name": "whoami", "description": "d", "inputSchema": {}}]
        )
        with patch("harness.mcp.client_manager._call_mcp_tools_list", new=tools_list_mock):
            with pytest.raises(TokenDecryptionError):
                await manager.connect(cfg, _mock_db())

        # Fail closed: no network call was made, and no partial state
        # (config or discovered tools) was persisted for this server.
        tools_list_mock.assert_not_called()
        assert cfg.id not in manager._configs
        assert manager.get_discovered_tools(cfg.id) == []

    async def test_connect_never_contacts_server_after_key_rotation(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """Token was encrypted under a key that has since been rotated
        away. connect() must fail closed rather than send the
        still-encrypted blob as a bearer token."""
        from cryptography.fernet import Fernet

        from harness.mcp.crypto import TokenDecryptionError, encrypt_token

        monkeypatch.setenv("MCP_ENCRYPTION_KEY", Fernet.generate_key().decode())
        token_encrypted = encrypt_token("super-secret-bearer-token")

        # Simulate rotation: a different key is now active.
        monkeypatch.setenv("MCP_ENCRYPTION_KEY", Fernet.generate_key().decode())

        manager = MCPClientManager()
        cfg = MCPServerConfig(
            id=uuid.uuid4(),
            org_id=1,
            name="rotated-key-server",
            url="http://mcp-rotated:3001/sse",
            token_encrypted=token_encrypted,
        )

        tools_list_mock = AsyncMock(return_value=[])
        with patch("harness.mcp.client_manager._call_mcp_tools_list", new=tools_list_mock):
            with pytest.raises(TokenDecryptionError):
                await manager.connect(cfg, _mock_db())

        tools_list_mock.assert_not_called()

    async def test_set_tool_enabled_does_not_register_tool_when_token_undecryptable(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """Enabling a tool whose server token can no longer be decrypted
        must not register it in the shared ToolRegistry — we must not
        expose a tool whose calls would carry ciphertext as a bearer
        token."""
        from cryptography.fernet import Fernet

        from harness.mcp.crypto import TokenDecryptionError

        manager = MCPClientManager()
        server_id = uuid.uuid4()
        cfg = MCPServerConfig(
            id=server_id,
            org_id=1,
            name="toggle-server",
            url="http://mcp-toggle:3001/sse",
        )
        raw_tools = [{"name": "risky_tool", "description": "d", "inputSchema": {}}]
        # Discover the tool already disabled (via override) so connect()
        # itself never needs to decrypt anything yet.
        overrides = [MagicMock(tool_name="risky_tool", enabled=False)]
        with patch(
            "harness.mcp.client_manager._call_mcp_tools_list",
            new=AsyncMock(return_value=raw_tools),
        ):
            await manager.connect(cfg, _mock_db(overrides=overrides))

        dt = manager.get_discovered_tools(server_id)[0]
        assert dt.enabled is False
        with pytest.raises(KeyError):
            tool_registry.get(dt.qualified_name)

        # Simulate the server being reconfigured with a bearer token that
        # can no longer be decrypted (corruption or key rotation).
        monkeypatch.setenv("MCP_ENCRYPTION_KEY", Fernet.generate_key().decode())
        cfg.token_encrypted = "not-a-real-fernet-token"

        with pytest.raises(TokenDecryptionError):
            await manager.set_tool_enabled(server_id, "risky_tool", True, _mock_db())

        # Fail closed: the tool must remain unregistered/uncallable, and
        # its recorded state must reflect that it is not actually live.
        with pytest.raises(KeyError):
            tool_registry.get(dt.qualified_name)
        assert dt.enabled is False

    async def test_set_tool_enabled_can_still_disable_when_token_undecryptable(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """Disabling a tool never needs the bearer token, so it must
        succeed even when the server's stored token can't be decrypted —
        a decrypt failure must not block turning a bad tool off."""
        from cryptography.fernet import Fernet

        manager = MCPClientManager()
        server_id = uuid.uuid4()
        cfg = MCPServerConfig(
            id=server_id,
            org_id=1,
            name="disable-server",
            url="http://mcp-disable:3001/sse",
        )
        raw_tools = [{"name": "some_tool", "description": "d", "inputSchema": {}}]
        with patch(
            "harness.mcp.client_manager._call_mcp_tools_list",
            new=AsyncMock(return_value=raw_tools),
        ):
            await manager.connect(cfg, _mock_db())

        dt = manager.get_discovered_tools(server_id)[0]
        assert tool_registry.get(dt.qualified_name) is not None

        monkeypatch.setenv("MCP_ENCRYPTION_KEY", Fernet.generate_key().decode())
        cfg.token_encrypted = "not-a-real-fernet-token"

        # Must not raise — disabling doesn't touch the token.
        await manager.set_tool_enabled(server_id, "some_tool", False, _mock_db())

        with pytest.raises(KeyError):
            tool_registry.get(dt.qualified_name)
        assert dt.enabled is False
