"""MCPClientManager — lifecycle management for per-org MCP server connections.

Responsibilities:
1. On startup: load all enabled server configs from DB and connect.
2. On connect: call tools/list on the MCP server, register tools in
   ToolRegistry with mcp:{server_name}:{tool_name} prefix and _org_id tag.
3. On disconnect: deregister all tools for that server from ToolRegistry.
4. On toggle: update mcp_tool_overrides and re-register/deregister tool.
5. On reconcile: diff the in-memory state against the DB (the runtime
   source of truth) and converge — used both by a bounded periodic
   background refresh and by on-access TTL invalidation, so an
   add/toggle/reconnect/delete made through *any* replica's API becomes
   visible on every other replica without a restart. See
   docs/harness-risk-review.md, F10.

Thread-safety: all mutations go through asyncio.Lock (single-process).

Cross-replica consistency (F10): each application process/replica runs
its own ``MCPClientManager`` with independent in-memory state. Postgres
(``mcp_server_configs`` / ``mcp_tool_overrides``) is the single source of
truth. ``reconcile()`` performs a full diff against that source of truth
and is:

- Invoked periodically by a bounded background loop (``app/main.py``,
  interval ``settings.MCP_RECONCILE_INTERVAL_S``) so every replica
  self-heals even if no request ever lands on it.
- Invoked on-demand, TTL-gated, via ``ensure_fresh()`` from the read/write
  API paths in ``app/api/mcp_servers.py`` (``settings.MCP_RECONCILE_TTL_S``)
  so a request landing on a stale replica shortly after another replica's
  mutation still observes the change instead of waiting for the next
  periodic tick.

This bounds staleness to ``min(MCP_RECONCILE_INTERVAL_S, time since last
access)`` without requiring a new transport (e.g. LISTEN/NOTIFY) or schema
change — the existing ``enabled`` columns and row presence/absence are
sufficient to detect adds, deletes, toggles, and reconnect-worthy config
changes (url/token/transport/name).

``reconcile()`` is single-flighted via ``_reconcile_lock`` regardless of
which of the two callers above triggered it, and updates
``_last_reconciled_at`` once, after any caller's successful pass — so a
background-loop reconcile is observed by a subsequent ``ensure_fresh()``
TTL check on the same replica, and vice versa. ``ensure_fresh()`` performs
its own TTL check *before* touching that lock so an already-fresh replica
never blocks a request behind an unrelated in-flight reconcile. Within a
single diff pass, a server connected concurrently on this replica (e.g. by
`add_mcp_server`/`reconnect_mcp_server`, neither of which is gated by
`_reconcile_lock`) after the diff's DB snapshot was taken is never mistaken
for a deletion by the prune step — see ``_connected_at`` and
``_reconcile_locked()``.
"""

from __future__ import annotations

import asyncio
import time
import uuid
from typing import Any

import httpx
import structlog
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from harness.mcp.crypto import TokenDecryptionError, decrypt_token, encrypt_token
from harness.mcp.models import DiscoveredTool, MCPServerConfig
from harness.mcp.tool_adapter import MCPTool
from harness.tools.registry import ToolRegistry, tool_registry

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

    One instance per application process/replica.  All state is in-memory
    with Postgres as the source of truth for server configs and tool
    overrides — see ``reconcile()`` and ``ensure_fresh()`` for how that
    source of truth is used to converge multiple replicas (F10).

    Args:
        registry: Tool registry to register/deregister MCP tools into.
            Defaults to the process-global ``harness.tools.registry.tool_registry``
            singleton used in production. Tests may inject an isolated
            ``ToolRegistry()`` instance per simulated replica so that two
            ``MCPClientManager`` instances in the same test process don't
            share state the way two independent replica processes never do.

    Usage::

        manager = MCPClientManager()
        async with lifespan:
            await manager.startup(db_session_factory)
            # ... serve requests ...
            await manager.shutdown()
    """

    def __init__(self, registry: ToolRegistry | None = None) -> None:
        # {server_id → MCPServerConfig}
        self._configs: dict[uuid.UUID, MCPServerConfig] = {}
        # {server_id → list[DiscoveredTool]}
        self._discovered: dict[uuid.UUID, list[DiscoveredTool]] = {}
        # {server_id → time.monotonic() of the last successful connect()}.
        # Used by reconcile()'s prune step to tell "this replica already
        # knows about a server whose row simply isn't in the DB anymore"
        # apart from "this server was connected *after* reconcile() took
        # its DB snapshot, so its absence from that snapshot is stale
        # information, not evidence of deletion" — see reconcile().
        self._connected_at: dict[uuid.UUID, float] = {}
        self._lock = asyncio.Lock()
        self._registry: ToolRegistry = registry or tool_registry
        # Cross-replica convergence (F10): single-flights reconcile()
        # itself (see reconcile()'s docstring) — every caller, whether the
        # bounded background loop or an on-access ensure_fresh(), goes
        # through this same lock, so at most one full diff/connect pass
        # ever runs at a time regardless of who triggered it. Separate
        # from `_lock`, which only guards ToolRegistry mutations and is
        # held only briefly (no network I/O under `_lock`).
        self._reconcile_lock = asyncio.Lock()
        self._last_reconciled_at: float = 0.0

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

        # Startup just loaded the full authoritative state — start the
        # on-access TTL clock from here rather than from epoch 0, so the
        # first request right after boot doesn't trigger a redundant
        # reconcile().
        self._last_reconciled_at = time.monotonic()

    async def shutdown(self) -> None:
        """Disconnect all servers and deregister their tools."""
        async with self._lock:
            for server_id in list(self._discovered.keys()):
                self._deregister_server_tools(server_id)
            self._configs.clear()
            self._discovered.clear()
            self._connected_at.clear()

    async def connect(self, cfg: MCPServerConfig, db: AsyncSession) -> list[DiscoveredTool]:
        """Connect to an MCP server, discover tools, register in ToolRegistry.

        Args:
            cfg: Server configuration.
            db: DB session for reading tool overrides.

        Returns:
            List of discovered tools.

        Raises:
            RuntimeError: If the server is unreachable or returns an error.
            TokenDecryptionError: If ``cfg.token_encrypted`` is set but
                cannot be decrypted (malformed ciphertext or a rotated
                key). The server is never contacted in this case — we
                fail closed rather than sending ciphertext as a bearer
                token.
        """
        log = logger.bind(server=cfg.name, org_id=cfg.org_id)
        try:
            token = decrypt_token(cfg.token_encrypted) if cfg.token_encrypted else None
        except TokenDecryptionError as exc:
            log.error("mcp_connect_aborted_token_decrypt_failed", error=str(exc))
            raise

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
                org_id=cfg.org_id,
                enabled=enabled,
            )
            discovered.append(dt)

        async with self._lock:
            # Deregister any previously registered tools for this server
            if cfg.id in self._discovered:
                self._deregister_server_tools(cfg.id)

            self._configs[cfg.id] = cfg
            self._discovered[cfg.id] = discovered
            # Record *after* the (possibly slow) tools/list network call
            # above, and *after* it is safe to say this server is fully
            # connected — reconcile()'s prune step uses this to recognize
            # servers connected concurrently, mid-reconcile, on this same
            # replica (see reconcile()).
            self._connected_at[cfg.id] = time.monotonic()

            for dt in discovered:
                if not dt.enabled:
                    continue
                mcp_tool = self._build_mcp_tool(cfg, dt, token)
                try:
                    self._registry.register(mcp_tool, replace=True)
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
            self._connected_at.pop(server_id, None)

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

        Raises:
            TokenDecryptionError: If ``enabled`` is True and the server's
                stored token cannot be decrypted (malformed ciphertext or a
                rotated key). The tool is left/marked disabled and is not
                registered — we fail closed rather than registering a tool
                whose calls would carry ciphertext as a bearer token.
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

        async with self._lock:
            tools = self._discovered.get(server_id, [])
            for dt in tools:
                if dt.tool_name != tool_name:
                    continue
                dt.enabled = enabled
                if enabled:
                    # Decrypt lazily — only needed when (re-)registering a
                    # live tool. Disabling never needs the token, so a
                    # decrypt failure never blocks turning a bad tool off.
                    try:
                        token = decrypt_token(cfg.token_encrypted) if cfg.token_encrypted else None
                    except TokenDecryptionError as exc:
                        dt.enabled = False
                        logger.error(
                            "mcp_tool_enable_aborted_token_decrypt_failed",
                            server=cfg.name,
                            org_id=cfg.org_id,
                            tool=tool_name,
                            error=str(exc),
                        )
                        raise
                    mcp_tool = self._build_mcp_tool(cfg, dt, token)
                    self._registry.register(mcp_tool, replace=True)
                else:
                    self._registry._tools.pop(dt.qualified_name, None)
                break

    # -----------------------------------------------------------------
    # Cross-replica convergence (F10)
    # -----------------------------------------------------------------
    #
    # `connect`/`disconnect`/`set_tool_enabled` above are called from the
    # API handlers on whichever replica served that particular request,
    # and only mutate *that* replica's in-memory state (plus the DB, which
    # every replica shares). The methods below let every other replica
    # converge with the DB without a restart:
    #
    #   - `reconcile()` does a full diff against the DB and converges this
    #     replica. It is single-flighted by `_reconcile_lock` regardless
    #     of caller: the bounded background loop (`app/main.py`) and
    #     on-access `ensure_fresh()` (`app/api/mcp_servers.py`) both call
    #     `reconcile()` directly and both go through the same lock, so at
    #     most one diff/connect pass ever runs at a time and
    #     `_last_reconciled_at` is updated in exactly one place — after
    #     *any* caller's successful pass, not just ensure_fresh's.
    #   - `ensure_fresh()` adds a cheap, lock-free TTL pre-check in front
    #     of `reconcile()` so read/write API paths on an already-fresh
    #     replica don't contend for `_reconcile_lock` at all — only a
    #     stale caller pays the (possibly network-bound) cost of waiting
    #     for/running a `reconcile()` pass.

    async def ensure_fresh(self, db: AsyncSession, ttl_s: float) -> None:
        """Reconcile with the DB if the last reconcile is older than ``ttl_s``.

        Intended to be called from API read/write paths (see
        ``app/api/mcp_servers.py``) as "invalidation on access": a request
        landing on a replica that missed another replica's add/toggle/
        reconnect/delete will trigger a synchronous catch-up here instead
        of waiting for the next periodic background tick.

        Args:
            db: Async DB session.
            ttl_s: Maximum staleness (seconds) tolerated before forcing a
                reconcile. A value <= 0 disables on-access reconciliation
                (periodic background refresh, if configured, still runs).
        """
        if ttl_s <= 0:
            return
        # Lock-free fast path: reading a single float is safe without a
        # lock under asyncio's single-threaded cooperative scheduling, and
        # this is the overwhelmingly common case (the replica is already
        # fresh, whether because *this* method last refreshed it or the
        # periodic background loop did). Skipping the lock here means a
        # request on a fresh replica is never made to wait behind an
        # unrelated, potentially slow, network-bound `reconcile()` pass
        # that's mid-flight for some other reason.
        if time.monotonic() - self._last_reconciled_at < ttl_s:
            return
        # Stale (or never reconciled): hand off to reconcile()'s own
        # single-flighted lock. `min_staleness_s` makes reconcile()
        # re-check freshness once more *after* acquiring the lock, so if
        # we lost a race to another caller (a concurrent request's
        # ensure_fresh(), or the periodic background loop) that already
        # refreshed while we were waiting, we skip the redundant pass
        # instead of doing it twice back-to-back.
        await self.reconcile(db, min_staleness_s=ttl_s)

    async def reconcile(self, db: AsyncSession, *, min_staleness_s: float | None = None) -> None:
        """Diff in-memory state against the DB and converge — single-flighted.

        Single-flighted via `_reconcile_lock` **regardless of caller**: both
        the periodic background loop (`app/main.py`, which calls this
        directly on a fixed interval) and on-access `ensure_fresh()`
        (`app/api/mcp_servers.py`) go through this same lock, so at most
        one full diff/connect pass runs at a time no matter which caller
        triggered it, and `_last_reconciled_at` is updated here — once,
        after any caller's successful pass — so both the background loop
        and every replica's `ensure_fresh()` TTL gate observe it.

        Args:
            db: Async DB session.
            min_staleness_s: When provided (as `ensure_fresh` does), the
                staleness check is re-evaluated *after* acquiring the lock
                and the diff is skipped entirely if another caller already
                refreshed within this window while this caller was
                blocked waiting for the lock. `None` (the periodic
                background loop's call shape) always performs the diff
                unconditionally once the lock is acquired.
        """
        async with self._reconcile_lock:
            if (
                min_staleness_s is not None
                and time.monotonic() - self._last_reconciled_at < min_staleness_s
            ):
                return
            await self._reconcile_locked(db)
            # Only reached on success — an exception from
            # `_reconcile_locked` (e.g. the DB itself is unreachable, as
            # opposed to a single server's connect() failing, which is
            # caught and logged internally) propagates out of this `async
            # with` block without updating the timestamp, so the next
            # caller retries promptly rather than treating a failed pass
            # as a fresh one.
            self._last_reconciled_at = time.monotonic()

    async def _reconcile_locked(self, db: AsyncSession) -> None:
        """Diff in-memory state against the DB and converge (body of `reconcile()`).

        Must be called while holding `_reconcile_lock` — see `reconcile()`.

        For every row in ``mcp_server_configs``:

        - Disabled in DB but connected locally → disconnect.
        - Not connected locally (added/enabled elsewhere) → connect.
        - Connected locally but the config changed (url/token/transport/
          name/org_id — a reconnect-worthy change) → reconnect (re-runs
          tool discovery against the live server).
        - Connected locally with unchanged config → cheaply sync
          ``mcp_tool_overrides`` only (no network round-trip to the MCP
          server itself).

        Any server connected locally whose row no longer exists in the DB
        at all (deleted on another replica) is disconnected — *unless* it
        was connected concurrently on this replica (e.g. by an
        `add_mcp_server`/`reconnect_mcp_server` API call that isn't itself
        gated by `_reconcile_lock`) after this method's DB snapshot was
        taken: such a server's absence from the snapshot reflects a
        pre-insert DB state, not a deletion, and pruning it here would
        incorrectly deregister a server another concurrent caller on this
        same replica just added. See ``_connected_at``.

        Args:
            db: Async DB session.
        """
        # Captured *before* the snapshot SELECT below. `connect()` always
        # writes the DB row (INSERT/commit) strictly before it records
        # `_connected_at[cfg.id]` (network round-trip to the MCP server
        # happens in between), so any server whose `_connected_at` is >=
        # this timestamp cannot have been missed by the SELECT due to
        # being added too late — its absence from `seen_ids` can only mean
        # it was still being connected concurrently as we scanned, not
        # that it was deleted. See the prune loop below.
        scan_started_at = time.monotonic()

        rows = (
            await db.execute(
                text(
                    "SELECT id, org_id, name, url, transport, token_encrypted, enabled "
                    "FROM mcp_server_configs"
                )
            )
        ).fetchall()

        seen_ids: set[uuid.UUID] = set()
        for row in rows:
            seen_ids.add(row.id)
            cfg = MCPServerConfig(
                id=row.id,
                org_id=row.org_id,
                name=row.name,
                url=row.url,
                transport=row.transport,
                token_encrypted=row.token_encrypted,
                enabled=row.enabled,
            )
            existing = self._configs.get(row.id)

            if not row.enabled:
                if existing is not None:
                    await self.disconnect(row.id)
                continue

            if existing is None or self._config_changed(existing, cfg):
                try:
                    await self.connect(cfg, db)
                except Exception as exc:
                    logger.warning(
                        "mcp_reconcile_connect_failed",
                        server=cfg.name,
                        org_id=cfg.org_id,
                        error=str(exc),
                    )
                continue

            # Config unchanged — no need to re-hit the MCP server, just
            # pick up any tool-override toggles made on another replica.
            await self._apply_tool_overrides(row.id, db)

        # Servers not present in the DB snapshot above, but still
        # connected locally: either genuinely deleted (on this or another
        # replica), or connected concurrently on *this* replica after the
        # snapshot was taken (see `scan_started_at` above) — only the
        # former should be pruned.
        for server_id in list(self._configs.keys()):
            if server_id in seen_ids:
                continue
            if self._connected_at.get(server_id, 0.0) >= scan_started_at:
                logger.debug(
                    "mcp_reconcile_prune_skipped_concurrent_connect",
                    server_id=str(server_id),
                )
                continue
            await self.disconnect(server_id)

    @staticmethod
    def _config_changed(old: MCPServerConfig, new: MCPServerConfig) -> bool:
        """Return True if a server's config changed in a reconnect-worthy way.

        Args:
            old: Currently-connected config (this replica's view).
            new: Latest config row read from the DB.

        Returns:
            True if the URL, transport, token, name, or owning org changed
            — any of which requires re-running tool discovery against the
            (possibly now-different) live server.
        """
        return (
            old.url != new.url
            or old.transport != new.transport
            or old.token_encrypted != new.token_encrypted
            or old.name != new.name
            or old.org_id != new.org_id
        )

    async def _apply_tool_overrides(self, server_id: uuid.UUID, db: AsyncSession) -> None:
        """Sync per-tool enabled overrides for an already-connected server.

        Compares the DB's ``mcp_tool_overrides`` against this replica's
        cached ``DiscoveredTool`` state and only registers/deregisters
        tools whose enabled bit actually changed (presumably toggled via
        another replica's API) — without re-running tool discovery against
        the live MCP server.

        Args:
            server_id: Server UUID (must already be connected locally).
            db: Async DB session.
        """
        cfg = self._configs.get(server_id)
        if cfg is None:
            return

        overrides_rows = (
            await db.execute(
                text("SELECT tool_name, enabled FROM mcp_tool_overrides WHERE server_id = :sid"),
                {"sid": server_id},
            )
        ).fetchall()
        overrides: dict[str, bool] = {row.tool_name: row.enabled for row in overrides_rows}

        async with self._lock:
            for dt in self._discovered.get(server_id, []):
                desired = overrides.get(dt.tool_name, True)
                if desired == dt.enabled:
                    continue
                if desired:
                    try:
                        token = decrypt_token(cfg.token_encrypted) if cfg.token_encrypted else None
                    except TokenDecryptionError as exc:
                        logger.error(
                            "mcp_reconcile_tool_enable_aborted_token_decrypt_failed",
                            server=cfg.name,
                            org_id=cfg.org_id,
                            tool=dt.tool_name,
                            error=str(exc),
                        )
                        continue
                    dt.enabled = True
                    mcp_tool = self._build_mcp_tool(cfg, dt, token)
                    self._registry.register(mcp_tool, replace=True)
                else:
                    dt.enabled = False
                    self._registry._tools.pop(dt.qualified_name, None)

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
            self._registry._tools.pop(dt.qualified_name, None)

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
