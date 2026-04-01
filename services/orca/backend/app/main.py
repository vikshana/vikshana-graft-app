"""FastAPI application entrypoint with lifespan management."""

from contextlib import asynccontextmanager
from collections.abc import AsyncGenerator
from datetime import datetime, timedelta, timezone

import structlog
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from sqlalchemy import text, update

from app.config import settings
from app.db import Base, async_engine
from app.logging import configure_logging

logger = structlog.get_logger()


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncGenerator[None, None]:
    """Application lifespan context manager.

    On startup:
    - Configures structlog
    - Creates all database tables (if not already present)
    - Attempts to install the pg_trgm extension for GIN trigram indexes

    On shutdown:
    - Disposes the async engine connection pool

    Args:
        app: The FastAPI application instance.
    """
    configure_logging()
    log = structlog.get_logger()
    log.info("orca_starting", version="0.1.0")

    # Create all tables and attempt to enable extensions
    async with async_engine.begin() as conn:
        # Install trigram extension if available (non-fatal if not)
        try:
            await conn.execute(text("CREATE EXTENSION IF NOT EXISTS pg_trgm"))
            log.info("pg_trgm_extension_enabled")
        except Exception as exc:
            log.warning("pg_trgm_extension_failed", error=str(exc))

        # Install pgvector extension for semantic similarity search
        try:
            await conn.execute(text("CREATE EXTENSION IF NOT EXISTS vector"))
            log.info("pgvector_extension_enabled")
        except Exception as exc:
            log.warning("pgvector_extension_failed", error=str(exc))

        # Import all models so SQLAlchemy knows about them before create_all
        import app.models.alert  # noqa: F401
        import app.models.rca  # noqa: F401
        import app.models.agent_step  # noqa: F401
        import app.models.rca_duplicate_alert  # noqa: F401
        import app.models.rca_session  # noqa: F401
        import app.models.rca_embedding  # noqa: F401

        await conn.run_sync(Base.metadata.create_all)
        log.info("database_tables_created")

        # ── Forward-compatible column migrations ──────────────────────────
        # create_all() never alters existing tables, so add new columns
        # here with ADD COLUMN IF NOT EXISTS to stay idempotent.
        migrations = [
            "ALTER TABLE rcas ADD COLUMN IF NOT EXISTS feedback_rating INTEGER",
            "ALTER TABLE rcas ADD COLUMN IF NOT EXISTS feedback_comment TEXT",
            "ALTER TABLE rcas ADD COLUMN IF NOT EXISTS org_id INTEGER",
        ]
        for stmt_sql in migrations:
            try:
                await conn.execute(text(stmt_sql))
            except Exception as exc:
                log.warning("migration_skipped", stmt=stmt_sql, error=str(exc))
        log.info("column_migrations_applied")

        # ── Orphan RCA cleanup ────────────────────────────────────────────
        # RCAs left in triggered/investigating after a container kill (SIGKILL)
        # never reach _mark_rca_failed, so they stay stuck indefinitely.
        # Mark any such RCA older than the agent timeout + 60s buffer as failed.
        import app.models.rca  # noqa: F401  (ensure RCA mapped before update)
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
    try:
        from app.agent.rca_graph import init_rca_graph
        await init_rca_graph()
        log.info("rca_graph_ready")
    except Exception as exc:
        log.warning("rca_graph_init_failed", error=str(exc))

    log.info("orca_ready")
    yield

    # Cleanup
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

    # Register routers
    from app.api.webhooks import router as webhooks_router
    from app.api.rca import router as rca_router
    from app.api.rca_sessions import router as rca_sessions_router

    app.include_router(webhooks_router, tags=["webhooks"])
    app.include_router(rca_router, prefix="/api", tags=["rca"])
    app.include_router(rca_sessions_router, prefix="/api", tags=["rca-sessions"])

    @app.get("/health", tags=["health"])
    async def health_check() -> dict[str, str]:
        """Simple health check endpoint."""
        return {"status": "ok"}

    return app


app = create_app()

