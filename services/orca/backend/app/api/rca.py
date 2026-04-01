"""FastAPI route handlers for the RCA API.

Provides GET /api/rca (list with filtering + pagination),
GET /api/rca/{id} (full detail with agent steps),
GET /api/stats (aggregate dashboard stats with dimension slicing),
and GET /api/filters/values (distinct values for filter dropdowns).
"""

import uuid
from typing import Any

import structlog
from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy import case, func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.db import get_session
from app.models.agent_step import AgentStep
from app.models.rca import RCA
from app.models.rca_duplicate_alert import RCADuplicateAlert
from app.schemas.rca import (
    ConfidenceBreakdown,
    DashboardStats,
    FeedbackRequest,
    FilterValues,
    RCADetail,
    RCAListResponse,
    RCASummary,
    StatusBreakdown,
)

logger = structlog.get_logger()

router = APIRouter()


def _apply_dimension_filters(
    stmt: select,  # type: ignore[type-arg]
    *,
    service_name: str | None = None,
    deployment_environment_name: str | None = None,
    domain: str | None = None,
    sub_domain: str | None = None,
    team: str | None = None,
) -> select:  # type: ignore[type-arg]
    """Apply optional label dimension filters to a SQLAlchemy select statement.

    Args:
        stmt: Base select statement targeting the RCA table.
        service_name: Filter by service_name.
        deployment_environment_name: Filter by deployment_environment_name.
        domain: Filter by domain.
        sub_domain: Filter by sub_domain.
        team: Filter by team.

    Returns:
        Select statement with filters applied.
    """
    if service_name:
        stmt = stmt.where(RCA.service_name == service_name)
    if deployment_environment_name:
        stmt = stmt.where(RCA.deployment_environment_name == deployment_environment_name)
    if domain:
        stmt = stmt.where(RCA.domain == domain)
    if sub_domain:
        stmt = stmt.where(RCA.sub_domain == sub_domain)
    if team:
        stmt = stmt.where(RCA.team == team)
    return stmt


@router.get(
    "/rca",
    response_model=RCAListResponse,
    summary="List RCAs with optional filters and pagination",
)
async def list_rcas(
    service_name: str | None = Query(None, description="Filter by service name"),
    deployment_environment_name: str | None = Query(None, description="Filter by environment"),
    domain: str | None = Query(None, description="Filter by domain"),
    legal_company: str | None = Query(None, description="Filter by legal company"),
    sub_domain: str | None = Query(None, description="Filter by sub-domain"),
    system_id: str | None = Query(None, description="Filter by system ID"),
    team: str | None = Query(None, description="Filter by team"),
    version: str | None = Query(None, description="Filter by version"),
    rca_status: str | None = Query(None, alias="status", description="Filter by status"),
    alert_name: str | None = Query(None, description="Free-text search on alert name"),
    page: int = Query(1, ge=1, description="Page number (1-based)"),
    page_size: int = Query(20, ge=1, le=100, description="Items per page"),
    session: AsyncSession = Depends(get_session),
) -> RCAListResponse:
    """List RCAs with optional label filters, status filter, and free-text search.

    Args:
        service_name: Exact match filter on service_name.
        deployment_environment_name: Exact match filter on deployment_environment_name.
        domain: Exact match filter on domain.
        legal_company: Exact match filter on legal_company.
        sub_domain: Exact match filter on sub_domain.
        system_id: Exact match filter on system_id.
        team: Exact match filter on team.
        version: Exact match filter on version.
        rca_status: Exact match filter on status.
        alert_name: Case-insensitive substring search on alert_name.
        page: Page number (1-based).
        page_size: Items per page.
        session: Async database session.

    Returns:
        Paginated list of RCA summaries.
    """
    stmt = select(RCA).order_by(RCA.created_at.desc())

    # Hide deduplicated RCAs from the default list unless explicitly requested.
    # 'deduplicated' is only assigned by the backfill script for pre-existing
    # duplicates; new duplicates are suppressed at webhook ingestion time and
    # never get their own RCA row.
    if rca_status:
        stmt = stmt.where(RCA.status == rca_status)
    else:
        stmt = stmt.where(RCA.status != "deduplicated")

    # Apply remaining filters
    if service_name:
        stmt = stmt.where(RCA.service_name == service_name)
    if deployment_environment_name:
        stmt = stmt.where(RCA.deployment_environment_name == deployment_environment_name)
    if domain:
        stmt = stmt.where(RCA.domain == domain)
    if legal_company:
        stmt = stmt.where(RCA.legal_company == legal_company)
    if sub_domain:
        stmt = stmt.where(RCA.sub_domain == sub_domain)
    if system_id:
        stmt = stmt.where(RCA.system_id == system_id)
    if team:
        stmt = stmt.where(RCA.team == team)
    if version:
        stmt = stmt.where(RCA.version == version)
    if alert_name:
        stmt = stmt.where(RCA.alert_name.ilike(f"%{alert_name}%"))

    # Count total matching rows
    count_stmt = select(func.count()).select_from(stmt.subquery())
    total_result = await session.execute(count_stmt)
    total = total_result.scalar_one()

    # Apply pagination
    offset = (page - 1) * page_size
    stmt = stmt.offset(offset).limit(page_size)

    result = await session.execute(stmt)
    rcas = result.scalars().all()

    return RCAListResponse(
        items=[RCASummary.model_validate(rca) for rca in rcas],
        total=total,
        page=page,
        page_size=page_size,
    )


@router.get(
    "/rca/{rca_id}",
    response_model=RCADetail,
    summary="Get full RCA detail including report and agent steps",
)
async def get_rca(
    rca_id: uuid.UUID,
    session: AsyncSession = Depends(get_session),
) -> RCADetail:
    """Retrieve a single RCA by ID with all agent steps.

    Args:
        rca_id: UUID of the RCA record.
        session: Async database session.

    Returns:
        Full RCA detail including report markdown and agent step timeline.

    Raises:
        HTTPException: 404 if the RCA does not exist.
    """
    stmt = (
        select(RCA)
        .where(RCA.id == rca_id)
        .options(
            selectinload(RCA.steps),
            selectinload(RCA.duplicate_alerts),
        )
    )
    result = await session.execute(stmt)
    rca = result.scalar_one_or_none()

    if rca is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"RCA with id={rca_id} not found",
        )

    return RCADetail.model_validate(rca)


@router.patch(
    "/rca/{rca_id}/feedback",
    response_model=RCADetail,
    summary="Submit user feedback (thumbs up/down + comment) for an RCA",
)
async def submit_rca_feedback(
    rca_id: uuid.UUID,
    body: FeedbackRequest,
    session: AsyncSession = Depends(get_session),
) -> RCADetail:
    """Persist user feedback on an RCA report quality.

    Args:
        rca_id: UUID of the RCA record.
        body: Feedback payload containing rating and optional comment.
        session: Async database session.

    Returns:
        Updated RCA detail.

    Raises:
        HTTPException: 404 if the RCA does not exist.
    """
    log = logger.bind(rca_id=str(rca_id))

    stmt = (
        select(RCA)
        .where(RCA.id == rca_id)
        .options(
            selectinload(RCA.steps),
            selectinload(RCA.duplicate_alerts),
        )
    )
    result = await session.execute(stmt)
    rca = result.scalar_one_or_none()

    if rca is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"RCA with id={rca_id} not found",
        )

    rca.feedback_rating = body.rating
    rca.feedback_comment = body.comment
    await session.commit()
    await session.refresh(rca)

    log.info("rca_feedback_submitted", rating=body.rating, has_comment=bool(body.comment))
    return RCADetail.model_validate(rca)


@router.get(
    "/stats",
    response_model=DashboardStats,
    summary="Aggregate dashboard statistics with optional dimension slicing",
)
async def get_dashboard_stats(
    service_name: str | None = Query(None, description="Slice by service name"),
    deployment_environment_name: str | None = Query(None, description="Slice by environment"),
    domain: str | None = Query(None, description="Slice by domain"),
    sub_domain: str | None = Query(None, description="Slice by sub-domain"),
    team: str | None = Query(None, description="Slice by team"),
    session: AsyncSession = Depends(get_session),
) -> DashboardStats:
    """Return aggregate stats for the dashboard overview.

    Computes total runs, success rate, average duration, confidence breakdown,
    status breakdown, and recent anomalies. All metrics can be sliced by
    team, service, environment, domain, or sub-domain.

    Args:
        service_name: Optional service filter.
        deployment_environment_name: Optional environment filter.
        domain: Optional domain filter.
        sub_domain: Optional sub-domain filter.
        team: Optional team filter.
        session: Async database session.

    Returns:
        Aggregate dashboard statistics.
    """
    # Base filter: exclude deduplicated RCAs
    base = select(RCA).where(RCA.status != "deduplicated")
    base = _apply_dimension_filters(
        base,
        service_name=service_name,
        deployment_environment_name=deployment_environment_name,
        domain=domain,
        sub_domain=sub_domain,
        team=team,
    )
    base_sub = base.subquery()

    # --- Aggregate counts + avg duration in one query ---
    agg_stmt = select(
        func.count().label("total"),
        func.count().filter(base_sub.c.status == "complete").label("completed"),
        func.count().filter(base_sub.c.status == "failed").label("failed"),
        func.count().filter(
            base_sub.c.status.in_(["triggered", "investigating"])
        ).label("investigating"),
        func.avg(base_sub.c.duration_seconds).filter(
            base_sub.c.status == "complete"
        ).label("avg_duration"),
    ).select_from(base_sub)

    agg_result = await session.execute(agg_stmt)
    row = agg_result.one()

    total_runs: int = row.total or 0
    completed_runs: int = row.completed or 0
    failed_runs: int = row.failed or 0
    investigating_runs: int = row.investigating or 0
    avg_duration: float | None = float(row.avg_duration) if row.avg_duration is not None else None

    terminal = completed_runs + failed_runs
    success_rate = (completed_runs / terminal * 100) if terminal > 0 else 0.0

    # --- Confidence breakdown ---
    conf_stmt = select(
        func.count().filter(base_sub.c.confidence_level == "high").label("high"),
        func.count().filter(base_sub.c.confidence_level == "medium").label("medium"),
        func.count().filter(base_sub.c.confidence_level == "low").label("low"),
        func.count().filter(
            or_(base_sub.c.confidence_level.is_(None), base_sub.c.confidence_level == "")
        ).label("unset"),
    ).select_from(base_sub)

    conf_result = await session.execute(conf_stmt)
    conf_row = conf_result.one()

    confidence_breakdown = ConfidenceBreakdown(
        high=conf_row.high or 0,
        medium=conf_row.medium or 0,
        low=conf_row.low or 0,
        unset=conf_row.unset or 0,
    )

    # --- Status breakdown ---
    status_breakdown = StatusBreakdown(
        triggered=0,
        investigating=investigating_runs,
        complete=completed_runs,
        failed=failed_runs,
    )
    # triggered is total minus the others
    status_breakdown.triggered = total_runs - completed_runs - failed_runs - investigating_runs

    # --- Recent anomalies (failed or low-confidence, last 5) ---
    anomaly_stmt = (
        select(RCA)
        .where(RCA.status != "deduplicated")
        .where(
            or_(
                RCA.status == "failed",
                RCA.confidence_level == "low",
            )
        )
    )
    anomaly_stmt = _apply_dimension_filters(
        anomaly_stmt,
        service_name=service_name,
        deployment_environment_name=deployment_environment_name,
        domain=domain,
        sub_domain=sub_domain,
        team=team,
    )
    anomaly_stmt = anomaly_stmt.order_by(RCA.created_at.desc()).limit(5)
    anomaly_result = await session.execute(anomaly_stmt)
    anomalies = anomaly_result.scalars().all()

    return DashboardStats(
        total_runs=total_runs,
        completed_runs=completed_runs,
        failed_runs=failed_runs,
        investigating_runs=investigating_runs,
        success_rate=round(success_rate, 1),
        avg_duration_seconds=round(avg_duration, 1) if avg_duration is not None else None,
        confidence_breakdown=confidence_breakdown,
        status_breakdown=status_breakdown,
        recent_anomalies=[RCASummary.model_validate(rca) for rca in anomalies],
    )


@router.get(
    "/filters/values",
    response_model=FilterValues,
    summary="Distinct values for filter dropdowns",
)
async def get_filter_values(
    session: AsyncSession = Depends(get_session),
) -> FilterValues:
    """Return distinct non-null values for each filterable label dimension.

    Used by the frontend to populate dropdown options dynamically.

    Args:
        session: Async database session.

    Returns:
        Lists of distinct values per dimension.
    """
    async def _distinct(column: Any) -> list[str]:
        """Fetch sorted distinct non-null values for a single column."""
        stmt = (
            select(column)
            .select_from(RCA)
            .where(column.isnot(None))
            .where(column != "")
            .where(RCA.status != "deduplicated")
            .distinct()
            .order_by(column)
        )
        result = await session.execute(stmt)
        return [row[0] for row in result.all()]

    return FilterValues(
        teams=await _distinct(RCA.team),
        services=await _distinct(RCA.service_name),
        environments=await _distinct(RCA.deployment_environment_name),
        domains=await _distinct(RCA.domain),
        sub_domains=await _distinct(RCA.sub_domain),
        statuses=await _distinct(RCA.status),
    )
