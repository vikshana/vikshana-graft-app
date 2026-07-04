"""Historical context retrieval via pgvector semantic search.

Queries the ``rca_embeddings`` table for the top-N most similar past RCAs
based on embedding distance.  Results are injected into the hypothesis
generation prompt to give the agent institutional memory from day one.

This module replaces the Postgres MCP approach for historical context —
it queries pgvector directly without going through the MCP server.
"""

from typing import Any

import structlog

from app.agent.rca_state import AlertContext
from app.db import AsyncSessionLocal
from harness.search.embeddings import embed_text

logger = structlog.get_logger()


async def gather_historical_context(
    alert: AlertContext,
    limit: int = 5,
) -> list[dict[str, Any]]:
    """Query rca_embeddings for past RCAs similar to the given alert.

    Embeds the alert description and runs a pgvector nearest-neighbour
    query to find the most similar past RCA hypotheses.

    Args:
        alert: The triggering alert context.
        limit: Maximum number of past RCAs to return.

    Returns:
        List of dicts with keys: alert_type, service, final_hypothesis,
        final_confidence, accepted_at.  Empty list if no embeddings exist yet
        or if the query fails.
    """
    log = logger.bind(alert_name=alert["alert_name"])

    search_text = f"{alert['alert_name']} {alert['description']}"
    if alert.get("service"):
        search_text += f" service={alert['service']}"

    try:
        query_embedding = await embed_text(search_text)
    except Exception as exc:
        log.warning("embedding_failed", error=str(exc))
        return []

    try:
        async with AsyncSessionLocal() as db:
            # pgvector cosine distance operator: <=>
            result = await db.execute(
                """
                SELECT
                    r.alert_type,
                    r.service,
                    r.final_hypothesis,
                    r.final_confidence,
                    r.accepted_at,
                    e.embedding <=> :query_embedding AS distance
                FROM rca_embeddings e
                JOIN rca_sessions r ON r.id = e.rca_id
                WHERE e.chunk_type = 'hypothesis'
                  AND r.final_hypothesis IS NOT NULL
                ORDER BY distance ASC
                LIMIT :limit
                """,
                {
                    "query_embedding": str(query_embedding),
                    "limit": limit,
                },
            )
            rows = result.fetchall()

        past_rcas = [
            {
                "alert_type": row.alert_type,
                "service": row.service,
                "final_hypothesis": row.final_hypothesis,
                "final_confidence": row.final_confidence,
                "accepted_at": row.accepted_at.isoformat() if row.accepted_at else None,
                "similarity": 1.0 - float(row.distance),
            }
            for row in rows
        ]

        log.info("historical_context_retrieved", count=len(past_rcas))
        return past_rcas

    except Exception as exc:
        # Table may not exist yet on first run — not fatal
        log.warning("historical_context_query_failed", error=str(exc))
        return []
