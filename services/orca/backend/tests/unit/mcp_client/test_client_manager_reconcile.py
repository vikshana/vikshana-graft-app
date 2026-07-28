"""Cross-replica convergence tests for MCPClientManager (F10).

`MCPClientManager` keeps its `_configs`/`_discovered` state — and the tools
it registers — entirely in-memory, per process/replica. Postgres
(`mcp_server_configs` / `mcp_tool_overrides`) is the runtime source of
truth. Before this fix, an add/toggle/reconnect/delete made through one
replica's API only ever mutated that replica's in-memory state (plus the
DB); every other replica kept serving its stale view until restarted
(ADR-007's "toggles take effect immediately" was false at >1 replica —
see docs/harness-risk-review.md, F10).

These tests simulate two independent replicas by giving each its own
`MCPClientManager` instance backed by its own `ToolRegistry()` (mirroring
two separate OS processes, each with its own process-global tool
registry) while sharing a single `FakeDB` (mirroring the one Postgres
instance every replica actually talks to in production). They prove that
`MCPClientManager.reconcile()` — invoked here directly, standing in for
either the bounded background loop or the on-access `ensure_fresh()` TTL
check wired into `app/api/mcp_servers.py` and `app/main.py` — converges a
replica's view to match the DB without any restart.

`test_client_manager.py` covers the F12 org-collision fix (same-named
servers/tools across orgs must not collide/overwrite in the shared
registry); these tests confirm the F10 reconciliation logic preserves
that isolation.
"""

from __future__ import annotations

import asyncio
import uuid
from typing import Any
from unittest.mock import AsyncMock, patch

import pytest

from harness.mcp.client_manager import MCPClientManager
from harness.mcp.models import MCPServerConfig
from harness.mcp.registry_bridge import OrgToolRegistry
from harness.tools.registry import ToolRegistry


# ---------------------------------------------------------------------------
# FakeDB — a minimal in-memory stand-in for the one shared Postgres instance
# ---------------------------------------------------------------------------
#
# `MCPClientManager` issues raw `sqlalchemy.text()` queries (no ORM), so
# this fake dispatches on the literal SQL string rather than emulating a
# real query planner. It only implements the exact statements
# `client_manager.py` issues: the two `mcp_server_configs` reads (startup's
# "enabled = true" filter and reconcile's unfiltered read), the per-server
# `mcp_tool_overrides` read (used by both `connect()` and
# `_apply_tool_overrides()`), and the `mcp_tool_overrides` upsert (used by
# `set_tool_enabled()`).


class _FakeRow:
    def __init__(self, **kwargs: Any) -> None:
        self.__dict__.update(kwargs)


class _FakeResult:
    def __init__(self, rows: list[_FakeRow]) -> None:
        self._rows = rows

    def fetchall(self) -> list[_FakeRow]:
        return self._rows


class FakeDB:
    """Shared in-memory Postgres stand-in for `mcp_server_configs`/`mcp_tool_overrides`.

    A single instance is shared across two (or more) `MCPClientManager`
    instances in a test to simulate the one Postgres database every
    replica in production actually talks to.
    """

    def __init__(self) -> None:
        self.servers: dict[uuid.UUID, dict[str, Any]] = {}
        self.overrides: dict[tuple[uuid.UUID, str], bool] = {}

    def add_server(
        self,
        *,
        org_id: int,
        name: str,
        url: str,
        transport: str = "sse",
        token_encrypted: str | None = None,
        enabled: bool = True,
        server_id: uuid.UUID | None = None,
    ) -> uuid.UUID:
        """Insert a server row directly (simulating `POST /mcp/servers`)."""
        sid = server_id or uuid.uuid4()
        self.servers[sid] = {
            "id": sid,
            "org_id": org_id,
            "name": name,
            "url": url,
            "transport": transport,
            "token_encrypted": token_encrypted,
            "enabled": enabled,
        }
        return sid

    def delete_server(self, server_id: uuid.UUID) -> None:
        """Remove a server row (simulating `DELETE /mcp/servers/{id}`)."""
        self.servers.pop(server_id, None)
        for key in [k for k in self.overrides if k[0] == server_id]:
            self.overrides.pop(key)

    async def execute(self, query: Any, params: dict[str, Any] | None = None) -> _FakeResult:
        sql = str(query)
        params = params or {}

        if "FROM mcp_server_configs" in sql:
            if "WHERE enabled = true" in sql:
                rows = [_FakeRow(**s) for s in self.servers.values() if s["enabled"]]
            else:
                rows = [_FakeRow(**s) for s in self.servers.values()]
            return _FakeResult(rows)

        if "FROM mcp_tool_overrides" in sql:
            sid = params["sid"]
            rows = [
                _FakeRow(tool_name=name, enabled=enabled)
                for (s, name), enabled in self.overrides.items()
                if s == sid
            ]
            return _FakeResult(rows)

        if "INSERT INTO mcp_tool_overrides" in sql:
            self.overrides[(params["sid"], params["name"])] = params["enabled"]
            return _FakeResult([])

        raise AssertionError(f"FakeDB: unhandled query: {sql!r}")

    async def commit(self) -> None:
        pass


def _cfg_from_row(fake_db: FakeDB, server_id: uuid.UUID) -> MCPServerConfig:
    row = fake_db.servers[server_id]
    return MCPServerConfig(
        id=row["id"],
        org_id=row["org_id"],
        name=row["name"],
        url=row["url"],
        transport=row["transport"],
        token_encrypted=row["token_encrypted"],
        enabled=row["enabled"],
    )


def _tools_list_mock(tool_names: list[str]) -> AsyncMock:
    return AsyncMock(
        return_value=[
            {"name": name, "description": f"{name} tool", "inputSchema": {}}
            for name in tool_names
        ]
    )


# ---------------------------------------------------------------------------
# Add — reconcile() picks up a server added/connected on another replica
# ---------------------------------------------------------------------------


class TestAddConverges:
    async def test_add_on_one_replica_converges_to_other_via_reconcile(self) -> None:
        fake_db = FakeDB()
        registry_a, registry_b = ToolRegistry(), ToolRegistry()
        replica_a = MCPClientManager(registry=registry_a)
        replica_b = MCPClientManager(registry=registry_b)

        sid = fake_db.add_server(org_id=7, name="jira", url="http://mcp-jira:3001/sse")
        cfg = _cfg_from_row(fake_db, sid)

        with patch(
            "harness.mcp.client_manager._call_mcp_tools_list",
            new=_tools_list_mock(["search"]),
        ):
            # Simulate `POST /mcp/servers` being served by replica A: it
            # connects immediately, as the real endpoint does.
            await replica_a.connect(cfg, fake_db)

            # Per-replica inconsistency (the F10 bug, pre-fix): replica B
            # never received this request and has no idea the server
            # exists yet.
            assert replica_b.get_discovered_tools(sid) == []
            with pytest.raises(KeyError):
                registry_b.get("mcp:7:jira:search")

            # Convergence: replica B's reconcile (standing in for its
            # bounded background loop tick, or an on-access ensure_fresh)
            # picks the new server up from the DB without any restart.
            await replica_b.reconcile(fake_db)

        assert registry_b.get("mcp:7:jira:search") is not None
        assert len(replica_b.get_discovered_tools(sid)) == 1
        # Replica A's own state is unaffected/unchanged by B's reconcile.
        assert registry_a.get("mcp:7:jira:search") is not None


# ---------------------------------------------------------------------------
# Toggle — reconcile() picks up a tool override made on another replica
# ---------------------------------------------------------------------------


class TestToggleConverges:
    async def _both_replicas_connected(
        self, fake_db: FakeDB, tool_names: list[str], org_id: int = 3
    ) -> tuple[MCPClientManager, ToolRegistry, MCPClientManager, ToolRegistry, uuid.UUID]:
        registry_a, registry_b = ToolRegistry(), ToolRegistry()
        replica_a = MCPClientManager(registry=registry_a)
        replica_b = MCPClientManager(registry=registry_b)

        sid = fake_db.add_server(org_id=org_id, name="github", url="http://mcp-github:3001/sse")
        cfg = _cfg_from_row(fake_db, sid)

        with patch(
            "harness.mcp.client_manager._call_mcp_tools_list",
            new=_tools_list_mock(tool_names),
        ):
            await replica_a.connect(cfg, fake_db)
            await replica_b.connect(cfg, fake_db)

        return replica_a, registry_a, replica_b, registry_b, sid

    async def test_toggle_off_on_one_replica_converges_to_other(self) -> None:
        fake_db = FakeDB()
        replica_a, registry_a, replica_b, registry_b, sid = await self._both_replicas_connected(
            fake_db, ["search_issues"]
        )
        qname = "mcp:3:github:search_issues"
        assert registry_a.get(qname) is not None
        assert registry_b.get(qname) is not None

        # Toggle served by replica B.
        await replica_b.set_tool_enabled(sid, "search_issues", False, fake_db)
        with pytest.raises(KeyError):
            registry_b.get(qname)

        # Replica A hasn't reconciled yet — still stale (bounded lag is
        # expected and acceptable; it must not be permanent).
        assert registry_a.get(qname) is not None

        # Convergence.
        await replica_a.reconcile(fake_db)
        with pytest.raises(KeyError):
            registry_a.get(qname)

    async def test_toggle_on_after_off_converges_and_still_works(self) -> None:
        fake_db = FakeDB()
        replica_a, registry_a, replica_b, registry_b, sid = await self._both_replicas_connected(
            fake_db, ["search_issues"]
        )
        qname = "mcp:3:github:search_issues"

        await replica_a.set_tool_enabled(sid, "search_issues", False, fake_db)
        await replica_b.reconcile(fake_db)
        with pytest.raises(KeyError):
            registry_b.get(qname)

        # Re-enable, served by replica A this time.
        await replica_a.set_tool_enabled(sid, "search_issues", True, fake_db)
        assert registry_a.get(qname) is not None

        await replica_b.reconcile(fake_db)
        assert registry_b.get(qname) is not None


# ---------------------------------------------------------------------------
# Delete — reconcile() removes a server deleted on another replica
# ---------------------------------------------------------------------------


class TestDeleteConverges:
    async def test_delete_on_one_replica_converges_to_other(self) -> None:
        fake_db = FakeDB()
        registry_a, registry_b = ToolRegistry(), ToolRegistry()
        replica_a = MCPClientManager(registry=registry_a)
        replica_b = MCPClientManager(registry=registry_b)

        sid = fake_db.add_server(org_id=9, name="datadog", url="http://mcp-dd:3001/sse")
        cfg = _cfg_from_row(fake_db, sid)

        with patch(
            "harness.mcp.client_manager._call_mcp_tools_list",
            new=_tools_list_mock(["query_metrics"]),
        ):
            await replica_a.connect(cfg, fake_db)
            await replica_b.connect(cfg, fake_db)

        qname = "mcp:9:datadog:query_metrics"
        assert registry_a.get(qname) is not None
        assert registry_b.get(qname) is not None

        # Delete served by replica A: real endpoint calls disconnect()
        # locally and deletes the DB row.
        await replica_a.disconnect(sid)
        fake_db.delete_server(sid)
        with pytest.raises(KeyError):
            registry_a.get(qname)

        # Replica B still thinks the server exists until it reconciles.
        assert registry_b.get(qname) is not None

        await replica_b.reconcile(fake_db)
        with pytest.raises(KeyError):
            registry_b.get(qname)
        assert replica_b.get_discovered_tools(sid) == []

    async def test_delete_of_one_server_does_not_affect_another_on_the_same_replica(self) -> None:
        """Guard against an overly-broad reconcile() implementation that
        might accidentally disconnect every server instead of only the
        one that's actually gone."""
        fake_db = FakeDB()
        registry = ToolRegistry()
        replica = MCPClientManager(registry=registry)

        sid_keep = fake_db.add_server(org_id=1, name="keep-me", url="http://mcp-keep:3001/sse")
        sid_drop = fake_db.add_server(org_id=1, name="drop-me", url="http://mcp-drop:3001/sse")

        with patch(
            "harness.mcp.client_manager._call_mcp_tools_list",
            new=_tools_list_mock(["tool_a"]),
        ):
            await replica.connect(_cfg_from_row(fake_db, sid_keep), fake_db)
            await replica.connect(_cfg_from_row(fake_db, sid_drop), fake_db)

        fake_db.delete_server(sid_drop)
        await replica.reconcile(fake_db)

        assert registry.get("mcp:1:keep-me:tool_a") is not None
        with pytest.raises(KeyError):
            registry.get("mcp:1:drop-me:tool_a")


# ---------------------------------------------------------------------------
# Reconnect-recovery — a replica that failed to connect at its own startup
# independently retries via reconcile() once the upstream server is
# reachable, mirroring the effect of a manual "reconnect" without requiring
# every replica to be reconnected individually.
# ---------------------------------------------------------------------------


class TestReconnectRecoveryConverges:
    async def test_replica_that_failed_at_startup_recovers_via_reconcile(self) -> None:
        fake_db = FakeDB()
        registry_a, registry_b = ToolRegistry(), ToolRegistry()
        replica_a = MCPClientManager(registry=registry_a)
        replica_b = MCPClientManager(registry=registry_b)

        sid = fake_db.add_server(org_id=4, name="flaky", url="http://mcp-flaky:3001/sse")
        cfg = _cfg_from_row(fake_db, sid)

        failing = AsyncMock(side_effect=RuntimeError("connection refused"))
        with patch("harness.mcp.client_manager._call_mcp_tools_list", new=failing):
            with pytest.raises(RuntimeError):
                await replica_a.connect(cfg, fake_db)
            with pytest.raises(RuntimeError):
                await replica_b.connect(cfg, fake_db)

        assert sid not in replica_a._configs
        assert sid not in replica_b._configs

        # Operator hits POST /mcp/servers/{id}/reconnect, served by
        # replica A only — the upstream server has since recovered.
        with patch(
            "harness.mcp.client_manager._call_mcp_tools_list",
            new=_tools_list_mock(["ping"]),
        ):
            await replica_a.connect(cfg, fake_db)
            assert registry_a.get("mcp:4:flaky:ping") is not None

            # Replica B was never manually reconnected — but its own
            # reconcile() independently retries (nothing in the DB
            # signals "someone clicked reconnect"; it just notices it
            # still isn't connected to an enabled server and retries).
            # Because the upstream dependency has recovered, the retry
            # now succeeds, converging replica B too.
            await replica_b.reconcile(fake_db)

        assert registry_b.get("mcp:4:flaky:ping") is not None


# ---------------------------------------------------------------------------
# Cross-org safety (F12) must hold through reconcile(), not just connect()
# ---------------------------------------------------------------------------


class TestReconcilePreservesOrgIsolation:
    async def test_reconcile_discovers_same_named_servers_across_orgs_without_collision(
        self,
    ) -> None:
        fake_db = FakeDB()
        registry = ToolRegistry()
        replica = MCPClientManager(registry=registry)

        sid1 = fake_db.add_server(org_id=1, name="github", url="http://mcp-github-org1:3001/sse")
        sid2 = fake_db.add_server(org_id=2, name="github", url="http://mcp-github-org2:3001/sse")

        with patch(
            "harness.mcp.client_manager._call_mcp_tools_list",
            new=_tools_list_mock(["search_issues"]),
        ):
            # Both servers are discovered by the *same* reconcile() pass —
            # this is the path the periodic background loop / ensure_fresh
            # take, distinct from individual connect() calls already
            # covered by test_client_manager.py's F12 tests.
            await replica.reconcile(fake_db)

        org1_view = OrgToolRegistry(org_id=1, registry=registry)
        org2_view = OrgToolRegistry(org_id=2, registry=registry)

        assert org1_view.get("mcp:1:github:search_issues") is not None
        assert org2_view.get("mcp:2:github:search_issues") is not None
        with pytest.raises(KeyError):
            org2_view.get("mcp:1:github:search_issues")
        with pytest.raises(KeyError):
            org1_view.get("mcp:2:github:search_issues")

        # Deleting org1's server via reconcile must not touch org2's
        # same-named tool.
        fake_db.delete_server(sid1)
        await replica.reconcile(fake_db)
        with pytest.raises(KeyError):
            org1_view.get("mcp:1:github:search_issues")
        assert org2_view.get("mcp:2:github:search_issues") is not None
        assert sid2 in replica._configs


# ---------------------------------------------------------------------------
# reconcile() is cheap when nothing changed, and only re-hits the live MCP
# server when the persisted config actually changed in a reconnect-worthy
# way (url/token/transport/name/org_id) — bounding the network cost of the
# periodic background loop / on-access ensure_fresh.
# ---------------------------------------------------------------------------


class TestReconcileNetworkCost:
    async def test_reconcile_does_not_rehit_server_when_nothing_changed(self) -> None:
        fake_db = FakeDB()
        registry = ToolRegistry()
        replica = MCPClientManager(registry=registry)

        sid = fake_db.add_server(org_id=1, name="svc", url="http://mcp-svc:3001/sse")
        cfg = _cfg_from_row(fake_db, sid)
        tools_list_mock = _tools_list_mock(["tool_a"])

        with patch("harness.mcp.client_manager._call_mcp_tools_list", new=tools_list_mock):
            await replica.connect(cfg, fake_db)
            assert tools_list_mock.call_count == 1

            # Nothing changed in the DB — repeated reconcile() calls must
            # not re-hit the live MCP server.
            await replica.reconcile(fake_db)
            await replica.reconcile(fake_db)
            assert tools_list_mock.call_count == 1

    async def test_reconcile_rehits_server_when_url_changes(self) -> None:
        fake_db = FakeDB()
        registry = ToolRegistry()
        replica = MCPClientManager(registry=registry)

        sid = fake_db.add_server(org_id=1, name="svc", url="http://mcp-svc-old:3001/sse")
        cfg = _cfg_from_row(fake_db, sid)
        tools_list_mock = _tools_list_mock(["tool_a"])

        with patch("harness.mcp.client_manager._call_mcp_tools_list", new=tools_list_mock):
            await replica.connect(cfg, fake_db)
            assert tools_list_mock.call_count == 1

            # Simulate the URL changing in the DB underneath this replica.
            fake_db.servers[sid]["url"] = "http://mcp-svc-new:3001/sse"
            await replica.reconcile(fake_db)
            assert tools_list_mock.call_count == 2


# ---------------------------------------------------------------------------
# ensure_fresh() — TTL-gated on-access invalidation
# ---------------------------------------------------------------------------


class _FakeClock:
    def __init__(self, start: float = 1_000.0) -> None:
        self.t = start

    def advance(self, dt: float) -> None:
        self.t += dt

    def __call__(self) -> float:
        return self.t


class TestEnsureFresh:
    async def test_ensure_fresh_reconciles_once_then_skips_within_ttl(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        clock = _FakeClock()
        monkeypatch.setattr("harness.mcp.client_manager.time.monotonic", clock)

        replica = MCPClientManager(registry=ToolRegistry())
        # Mock the diff logic (`_reconcile_locked`), not `reconcile()`
        # itself — `reconcile()` now *owns* the lock + `_last_reconciled_at`
        # bookkeeping (see TestReconcileSingleFlight /
        # TestReconcileUpdatesTimestamp below), so mocking it away here
        # would also mock away the exact gating behaviour this test wants
        # to exercise.
        reconcile_once_mock = AsyncMock()
        monkeypatch.setattr(replica, "_reconcile_locked", reconcile_once_mock)

        fake_db = FakeDB()

        await replica.ensure_fresh(fake_db, ttl_s=10)
        assert reconcile_once_mock.call_count == 1

        # Same instant — well within the TTL window, must not reconcile again.
        await replica.ensure_fresh(fake_db, ttl_s=10)
        assert reconcile_once_mock.call_count == 1

        clock.advance(5)
        await replica.ensure_fresh(fake_db, ttl_s=10)
        assert reconcile_once_mock.call_count == 1

        # TTL exceeded — must force a fresh reconcile.
        clock.advance(6)
        await replica.ensure_fresh(fake_db, ttl_s=10)
        assert reconcile_once_mock.call_count == 2

    async def test_ensure_fresh_disabled_when_ttl_is_zero_or_negative(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        replica = MCPClientManager(registry=ToolRegistry())
        reconcile_once_mock = AsyncMock()
        monkeypatch.setattr(replica, "_reconcile_locked", reconcile_once_mock)

        await replica.ensure_fresh(FakeDB(), ttl_s=0)
        await replica.ensure_fresh(FakeDB(), ttl_s=-1)
        reconcile_once_mock.assert_not_called()

    async def test_startup_seeds_last_reconciled_at_so_first_request_does_not_reconcile_again(
        self,
    ) -> None:
        """After `startup()` already loaded the authoritative state, the
        very next `ensure_fresh()` call (e.g. the first API request after
        boot) should not immediately force a redundant reconcile()."""
        fake_db = FakeDB()
        replica = MCPClientManager(registry=ToolRegistry())

        with patch(
            "harness.mcp.client_manager._call_mcp_tools_list",
            new=_tools_list_mock([]),
        ):
            await replica.startup(fake_db)

        assert replica._last_reconciled_at > 0.0


# ---------------------------------------------------------------------------
# reconcile() must be single-flighted regardless of caller: the periodic
# background loop (app/main.py calls reconcile() directly, unconditionally)
# and on-access ensure_fresh() (app/api/mcp_servers.py) must never run a
# diff/connect pass concurrently with each other, and a successful pass
# triggered by *either* caller shape must be visible to the other via
# `_last_reconciled_at`.
# ---------------------------------------------------------------------------


class TestReconcileSingleFlight:
    async def test_reconcile_is_single_flighted_across_background_and_ensure_fresh_callers(
        self,
    ) -> None:
        fake_db = FakeDB()
        replica = MCPClientManager(registry=ToolRegistry())

        sid = fake_db.add_server(org_id=1, name="svc", url="http://mcp-svc:3001/sse")
        cfg = _cfg_from_row(fake_db, sid)
        with patch(
            "harness.mcp.client_manager._call_mcp_tools_list",
            new=_tools_list_mock(["tool_a"]),
        ):
            await replica.connect(cfg, fake_db)

        in_flight = 0
        max_in_flight = 0
        real_reconcile_locked = replica._reconcile_locked

        async def _tracking_reconcile_locked(db: FakeDB) -> None:
            nonlocal in_flight, max_in_flight
            in_flight += 1
            max_in_flight = max(max_in_flight, in_flight)
            try:
                # Yield control so a second, concurrently-scheduled caller
                # has a chance to race in while this "slow" reconcile pass
                # is mid-flight — if (and only if) single-flighting is
                # broken, it would slip in here and `in_flight` would
                # briefly read 2.
                await asyncio.sleep(0)
                await real_reconcile_locked(db)
            finally:
                in_flight -= 1

        replica._reconcile_locked = _tracking_reconcile_locked  # type: ignore[method-assign]

        # Force ensure_fresh()'s lock-free TTL pre-check to see "stale"
        # deterministically, regardless of the test process's real
        # `time.monotonic()` value (which depends on system uptime, not
        # something this test controls).
        replica._last_reconciled_at = -1_000_000.0

        # Caller 1 mimics the periodic background loop's call shape
        # (unconditional, no TTL). Caller 2 mimics an on-access
        # ensure_fresh() call racing it on a different replica request.
        # `asyncio.gather` schedules both onto the same event loop so
        # they genuinely interleave rather than running back-to-back.
        await asyncio.gather(
            replica.reconcile(fake_db),
            replica.ensure_fresh(fake_db, ttl_s=1.0),
        )

        assert max_in_flight == 1

    async def test_concurrent_reconcile_callers_only_hit_mcp_server_once_for_a_changed_config(
        self,
    ) -> None:
        """Two overlapping reconcile() callers (e.g. one request's
        ensure_fresh() and a background-loop tick racing it) must not
        duplicate the network round-trip to the *same* MCP server just
        because both observed the same stale config at once."""
        fake_db = FakeDB()
        replica = MCPClientManager(registry=ToolRegistry())

        sid = fake_db.add_server(org_id=1, name="svc", url="http://mcp-svc-old:3001/sse")
        cfg = _cfg_from_row(fake_db, sid)
        tools_list_mock = _tools_list_mock(["tool_a"])

        with patch("harness.mcp.client_manager._call_mcp_tools_list", new=tools_list_mock):
            await replica.connect(cfg, fake_db)
            assert tools_list_mock.call_count == 1

            # Config changes underneath this replica — both concurrent
            # callers below will see the same "reconnect-worthy change".
            fake_db.servers[sid]["url"] = "http://mcp-svc-new:3001/sse"

            await asyncio.gather(
                replica.reconcile(fake_db),
                replica.reconcile(fake_db),
            )

            # Single-flighting means the second caller waits for the
            # first to finish and then (via its own DB re-read) sees the
            # config as already converged — not two independent
            # tools/list round-trips for the same URL change.
            assert tools_list_mock.call_count == 2


# ---------------------------------------------------------------------------
# `_last_reconciled_at` must be updated after a *successful* reconcile()
# regardless of whether it was called with the background loop's shape
# (unconditional, no `min_staleness_s`) or ensure_fresh's shape — and must
# NOT be updated if the diff itself raises.
# ---------------------------------------------------------------------------


class TestReconcileUpdatesTimestamp:
    async def test_background_style_reconcile_call_updates_last_reconciled_at(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        clock = _FakeClock()
        monkeypatch.setattr("harness.mcp.client_manager.time.monotonic", clock)

        fake_db = FakeDB()
        replica = MCPClientManager(registry=ToolRegistry())
        assert replica._last_reconciled_at == 0.0

        clock.advance(50)
        # Mimics app/main.py's periodic background loop: calls
        # reconcile() directly, with no `min_staleness_s`/TTL argument
        # (that call shape is ensure_fresh's alone).
        await replica.reconcile(fake_db)

        assert replica._last_reconciled_at == 1_050.0

        # A subsequent ensure_fresh() call within the TTL window must see
        # the background loop's success and skip re-reconciling entirely
        # — proving the timestamp update is actually observed cross-caller,
        # not just a private counter nobody reads.
        reconcile_once_mock = AsyncMock()
        monkeypatch.setattr(replica, "_reconcile_locked", reconcile_once_mock)
        await replica.ensure_fresh(fake_db, ttl_s=10)
        reconcile_once_mock.assert_not_called()

    async def test_reconcile_does_not_update_timestamp_when_diff_raises(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        clock = _FakeClock()
        monkeypatch.setattr("harness.mcp.client_manager.time.monotonic", clock)

        replica = MCPClientManager(registry=ToolRegistry())
        monkeypatch.setattr(
            replica, "_reconcile_locked", AsyncMock(side_effect=RuntimeError("db unreachable"))
        )

        with pytest.raises(RuntimeError, match="db unreachable"):
            await replica.reconcile(FakeDB())

        # A failed pass must not be mistaken for a fresh one — the next
        # caller should retry promptly rather than waiting out the TTL.
        assert replica._last_reconciled_at == 0.0


# ---------------------------------------------------------------------------
# reconcile()'s prune step must not deregister a server that was added
# concurrently on this same replica (e.g. via `add_mcp_server`/
# `reconnect_mcp_server`, neither of which is gated by `_reconcile_lock`)
# after the diff's DB snapshot was already taken — its absence from that
# snapshot reflects a pre-insert DB state, not a deletion.
# ---------------------------------------------------------------------------


class TestReconcilePrunePreservesConcurrentAdd:
    async def test_prune_does_not_disconnect_server_added_concurrently_during_reconcile(
        self,
    ) -> None:
        fake_db = FakeDB()
        registry = ToolRegistry()
        replica = MCPClientManager(registry=registry)

        # One pre-existing, unchanged server so reconcile()'s per-row loop
        # takes the "config unchanged" branch (`_apply_tool_overrides`,
        # which awaits a DB query) between the initial snapshot SELECT and
        # the final prune loop — this is what gives the concurrent add
        # below a real window to race into.
        sid_existing = fake_db.add_server(
            org_id=1, name="existing", url="http://mcp-existing:3001/sse"
        )
        cfg_existing = _cfg_from_row(fake_db, sid_existing)
        with patch(
            "harness.mcp.client_manager._call_mcp_tools_list",
            new=_tools_list_mock(["tool_a"]),
        ):
            await replica.connect(cfg_existing, fake_db)

        snapshot_taken = asyncio.Event()
        new_server_committed = asyncio.Event()
        original_execute = fake_db.execute

        async def _execute_with_hook(query: Any, params: dict[str, Any] | None = None) -> Any:
            sql = str(query)
            result = await original_execute(query, params)
            if "FROM mcp_server_configs" in sql and "WHERE enabled = true" not in sql:
                # This is reconcile()'s unfiltered snapshot SELECT.
                # Signal that the snapshot has been taken, then block
                # reconcile() right here until the concurrently-added
                # server below has actually committed and connected —
                # reproducing the TOCTOU window between the snapshot and
                # the prune step at the end of the same diff pass.
                snapshot_taken.set()
                await new_server_committed.wait()
            return result

        fake_db.execute = _execute_with_hook  # type: ignore[method-assign]

        new_server_id: uuid.UUID | None = None

        async def _concurrent_add() -> None:
            nonlocal new_server_id
            await snapshot_taken.wait()
            # Simulates POST /mcp/servers being served concurrently by
            # this same replica: the DB row is inserted (and, in
            # production, committed) strictly before connect() is called
            # — after reconcile() already took its snapshot.
            new_server_id = fake_db.add_server(
                org_id=1, name="fresh", url="http://mcp-fresh:3001/sse"
            )
            cfg_new = _cfg_from_row(fake_db, new_server_id)
            with patch(
                "harness.mcp.client_manager._call_mcp_tools_list",
                new=_tools_list_mock(["tool_b"]),
            ):
                await replica.connect(cfg_new, fake_db)
            new_server_committed.set()

        with patch(
            "harness.mcp.client_manager._call_mcp_tools_list",
            new=_tools_list_mock(["tool_a"]),
        ):
            add_task = asyncio.create_task(_concurrent_add())
            await replica.reconcile(fake_db)
            await add_task

        assert new_server_id is not None
        # The freshly-added server must survive reconcile()'s prune step
        # even though its row didn't exist yet when reconcile() took its
        # snapshot.
        assert new_server_id in replica._configs
        assert registry.get("mcp:1:fresh:tool_b") is not None
        # The pre-existing server is unaffected by the race.
        assert registry.get("mcp:1:existing:tool_a") is not None

    async def test_prune_still_disconnects_a_server_deleted_before_the_snapshot(self) -> None:
        """Sanity check that the concurrent-add guard above doesn't
        accidentally defeat pruning altogether: a server genuinely deleted
        *before* reconcile() takes its snapshot must still be pruned."""
        fake_db = FakeDB()
        registry = ToolRegistry()
        replica = MCPClientManager(registry=registry)

        sid = fake_db.add_server(org_id=1, name="gone", url="http://mcp-gone:3001/sse")
        cfg = _cfg_from_row(fake_db, sid)
        with patch(
            "harness.mcp.client_manager._call_mcp_tools_list",
            new=_tools_list_mock(["tool_a"]),
        ):
            await replica.connect(cfg, fake_db)

        fake_db.delete_server(sid)
        await replica.reconcile(fake_db)

        assert sid not in replica._configs
        with pytest.raises(KeyError):
            registry.get("mcp:1:gone:tool_a")
