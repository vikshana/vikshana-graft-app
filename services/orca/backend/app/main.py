"""FastAPI application entrypoint with lifespan management."""

import asyncio
from contextlib import asynccontextmanager
from collections.abc import AsyncGenerator
from datetime import datetime, timedelta, timezone
from typing import Any

import structlog
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from sqlalchemy import update

from app.config import settings
from app.db import async_engine
from app.logging import configure_logging
from app.schema_check import verify_schema_at_head

logger = structlog.get_logger()

# Background task handles — kept to allow clean cancellation on shutdown
_worker_task: asyncio.Task | None = None
_slack_handler: Any | None = None
_mcp_reconcile_task: asyncio.Task | None = None


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncGenerator[None, None]:
    """Application lifespan context manager.

    On startup:
    - Configures structlog
    - Verifies the database schema is at the Alembic head revision
      (schema itself is managed exclusively by Alembic; see
      docker-entrypoint.sh and app/schema_check.py)
    - Cleans up orphaned in-flight RCAs from a prior container restart
    - Initialises the interactive RCA graph and registers it in GraphRegistry
    - Starts the TurnWorker background loop

    On shutdown:
    - Cancels the TurnWorker background task
    - Disposes the async engine connection pool

    Args:
        app: The FastAPI application instance.
    """
    global _worker_task, _slack_handler, _mcp_reconcile_task  # noqa: PLW0603

    configure_logging()
    log = structlog.get_logger()
    log.info("orca_starting", version="0.1.0", environment=settings.ENVIRONMENT)

    # Fail fast in production if encryption keys or the internal HMAC secret
    # are insecure (empty / dev defaults) — see Settings.validate_production_secrets.
    secret_errors = settings.validate_production_secrets()
    if secret_errors:
        for err in secret_errors:
            log.error("insecure_production_secret", error=err)
        raise RuntimeError(
            "Refusing to start in production with insecure secrets: "
            + "; ".join(secret_errors)
        )

    # ── Schema authority: Alembic ───────────────────────────────────────
    # `alembic upgrade head` runs in docker-entrypoint.sh before this
    # process starts — the app itself never creates or mutates schema
    # (see docs/harness-risk-review.md F3/F13). This is a defense-in-depth
    # check: fail fast in production if the DB isn't at the expected
    # revision (entrypoint bypassed / migration failed silently); only
    # warn in development so bare-metal `uvicorn --reload` workflows that
    # haven't run Alembic yet are not blocked from starting.
    async with async_engine.begin() as conn:
        await verify_schema_at_head(conn, fail_hard=settings.is_production())

        # ── Orphan RCA cleanup ────────────────────────────────────────────
        from app.models.rca import RCA as _RCA  # local import to avoid top-level

        stuck_cutoff = datetime.now(timezone.utc) - timedelta(
            seconds=settings.ORCA_AGENT_TIMEOUT_SECONDS + 60
        )
        stuck_stmt = (
            update(_RCA)
            .where(_RCA.status.in_(["triggered", "investigating"]))
            .where(_RCA.created_at < stuck_cutoff)
            .values(
                status="failed",
                error_message="Agent process killed before completion (container restart)",
                completed_at=datetime.now(timezone.utc),
            )
        )
        result = await conn.execute(stuck_stmt)
        if result.rowcount:
            log.info("orphan_rcas_cleaned_up", count=result.rowcount)

    # Initialise the interactive RCA graph (LangGraph + Postgres checkpointer)
    # and register it in the GraphRegistry under "investigation"
    try:
        from app.agent.rca_graph import init_rca_graph, get_rca_graph
        await init_rca_graph()

        from harness.session.registry import graph_registry
        graph_registry.register("investigation", get_rca_graph)
        log.info("rca_graph_ready")
    except Exception as exc:
        log.warning("rca_graph_init_failed", error=str(exc))

    # Start the TurnWorker background loop
    try:
        from harness.session.worker import TurnWorker
        worker = TurnWorker()
        _worker_task = asyncio.create_task(worker.run_loop(), name="turn_worker")
        log.info("turn_worker_started")
    except Exception as exc:
        log.warning("turn_worker_start_failed", error=str(exc))

    # ── Slack Socket Mode handler (Phase 3) ───────────────────────────────
    # Only started when SLACK_APP_TOKEN is configured — safe to skip in CI.
    if settings.SLACK_APP_TOKEN:
        try:
            # Import through harness.slack (not harness.slack.app) so the package
            # __init__.py runs register_handlers() before the Socket Mode handler starts.
            from harness.slack import create_socket_mode_handler
            _slack_handler = create_socket_mode_handler()
            asyncio.create_task(_slack_handler.start_async(), name="slack_socket_mode")
            log.info("slack_socket_mode_started")
        except Exception as exc:
            log.warning("slack_socket_mode_start_failed", error=str(exc))

    # ── AutoTriageService singleton (Phase 3) ─────────────────────────────
    try:
        from harness.triage.auto_triage import AutoTriageService
        from harness.triage.circuit_breaker import CircuitBreaker
        from harness.triage.dedup_adapter import OrcaDedupAdapter

        _auto_triage_service = AutoTriageService(
            dedup=OrcaDedupAdapter(),
            max_concurrent=settings.ALERT_TRIAGE_MAX_CONCURRENT,
            breaker=CircuitBreaker(
                threshold=settings.ALERT_TRIAGE_CIRCUIT_BREAKER_THRESHOLD,
                timeout_s=settings.ALERT_TRIAGE_CIRCUIT_BREAKER_TIMEOUT_S,
                name="alert_triage",
            ),
        )
        # Make available to the webhooks router via app state
        app.state.auto_triage = _auto_triage_service
        log.info("auto_triage_service_ready")
    except Exception as exc:
        log.warning("auto_triage_service_init_failed", error=str(exc))

    # ── MCP client manager (Phase 4) ─────────────────────────────────────
    # Connect all enabled MCP servers and register their tools in ToolRegistry.
    try:
        from app.db import AsyncSessionLocal
        from harness.mcp.client_manager import mcp_client_manager
        async with AsyncSessionLocal() as _mcp_db:
            await mcp_client_manager.startup(_mcp_db)
        log.info("mcp_client_manager_started")

        # Cross-replica convergence (F10): MCPClientManager state is
        # per-replica in-memory; Postgres is the runtime source of truth.
        # This bounded background loop periodically reconciles this
        # replica against the DB so add/toggle/reconnect/delete made
        # through *another* replica's API becomes visible here too,
        # without waiting for a request to trigger the on-access
        # `ensure_fresh` TTL check in app/api/mcp_servers.py. See
        # harness/mcp/client_manager.py and docs/harness-risk-review.md F10.
        async def _mcp_reconcile_loop() -> None:
            while True:
                await asyncio.sleep(settings.MCP_RECONCILE_INTERVAL_S)
                try:
                    async with AsyncSessionLocal() as _reconcile_db:
                        await mcp_client_manager.reconcile(_reconcile_db)
                except Exception as exc:
                    log.warning("mcp_reconcile_loop_iteration_failed", error=str(exc))

        _mcp_reconcile_task = asyncio.create_task(
            _mcp_reconcile_loop(), name="mcp_reconcile"
        )
        log.info(
            "mcp_reconcile_loop_started",
            interval_s=settings.MCP_RECONCILE_INTERVAL_S,
        )
    except Exception as exc:
        log.warning("mcp_client_manager_start_failed", error=str(exc))

    log.info("orca_ready")
    yield

    # Cleanup
    if _slack_handler is not None:
        try:
            await _slack_handler.close_async()
            log.info("slack_socket_mode_stopped")
        except Exception as exc:
            log.warning("slack_socket_mode_stop_failed", error=str(exc))

    # Shutdown MCP client manager — deregister all MCP tools
    if _mcp_reconcile_task is not None and not _mcp_reconcile_task.done():
        _mcp_reconcile_task.cancel()
        try:
            await _mcp_reconcile_task
        except asyncio.CancelledError:
            pass
        log.info("mcp_reconcile_loop_stopped")

    try:
        from harness.mcp.client_manager import mcp_client_manager
        await mcp_client_manager.shutdown()
        log.info("mcp_client_manager_stopped")
    except Exception as exc:
        log.warning("mcp_client_manager_stop_failed", error=str(exc))

    # Cleanup
    if _worker_task is not None and not _worker_task.done():
        _worker_task.cancel()
        try:
            await _worker_task
        except asyncio.CancelledError:
            pass
        log.info("turn_worker_stopped")

    await async_engine.dispose()
    log.info("orca_shutdown")


def create_app() -> FastAPI:
    """Create and configure the FastAPI application.

    Returns:
        Configured FastAPI app instance with all routes and middleware.
    """
    app = FastAPI(
        title="Orca — Omniscient Root Cause Analyser",
        description=(
            "Agentic RCA system that receives Grafana alert webhooks, "
            "investigates via MCP, and produces structured RCA reports."
        ),
        version="0.1.0",
        lifespan=lifespan,
    )

    # CORS — the Go plugin backend is the public-facing gateway.
    # FastAPI is not directly exposed in production, but we allow localhost
    # for developer convenience when running the backend standalone.
    app.add_middleware(
        CORSMiddleware,
        allow_origins=[
            "http://localhost:3000",
            "http://127.0.0.1:3000",
        ],
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )

    # HMAC validation middleware for Go gateway → Python service calls.
    # Applied to /api/sessions, /api/mcp, /api/identity, and /api/rca (see
    # docs/harness-risk-review.md F4); transparent pass-through when
    # AGENT_INTERNAL_SECRET is not configured (dev mode).
    #
    # The secret is passed explicitly from `settings` (pydantic-settings —
    # reads both real env vars and a .env file) rather than left to
    # InternalAuthMiddleware's own os.environ fallback, so that a secret set
    # only via a .env file is honoured consistently with what
    # validate_production_secrets() just checked above — otherwise an
    # operator could pass startup validation via .env while the middleware
    # itself (reading raw os.environ) silently stayed in pass-through mode.
    from harness.auth.internal_auth import InternalAuthMiddleware
    app.add_middleware(InternalAuthMiddleware, secret=settings.AGENT_INTERNAL_SECRET)

    # Register routers
    from app.api.webhooks import router as webhooks_router
    from app.api.rca import router as rca_router
    from app.api.sessions import router as sessions_router
    from app.api.identity import router as identity_router
    from app.api.mcp_servers import router as mcp_servers_router

    app.include_router(webhooks_router, tags=["webhooks"])
    app.include_router(rca_router, prefix="/api", tags=["rca"])
    app.include_router(sessions_router, prefix="/api", tags=["sessions"])
    app.include_router(identity_router, prefix="/api", tags=["identity"])
    app.include_router(mcp_servers_router, prefix="/api", tags=["mcp-servers"])

    @app.get("/health", tags=["health"])
    async def health_check() -> dict[str, str]:
        """Simple health check endpoint."""
        return {"status": "ok"}

    return app


app = create_app()

