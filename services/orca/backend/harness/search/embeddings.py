"""Embedding utilities for semantic search.

Provides ``embed_text`` — converts free text to a 1536-dimensional unit vector
suitable for pgvector cosine similarity queries.

The current implementation uses a deterministic hash-based placeholder.
Replace with a real embedding model (e.g. ``text-embedding-3-small``) before
going to production.
"""

import hashlib
import math

import structlog

logger = structlog.get_logger()


async def embed_text(text: str) -> list[float]:
    """Generate a 1536-dimensional embedding for the given text.

    Currently uses a deterministic SHA-256 hash-based pseudo-embedding that
    produces a unit-normalised 1536-d vector.  It has no semantic meaning but
    is stable across restarts and sufficient for development and testing.

    Replace the body with a real embedding API call (e.g. OpenAI
    ``text-embedding-3-small``) before production use.

    Args:
        text: Input text to embed.

    Returns:
        1536-dimensional list of floats (unit vector).
    """
    digest = hashlib.sha256(text.encode()).digest()
    values: list[float] = []
    for i in range(1536):
        byte_idx = i % len(digest)
        angle = (digest[byte_idx] / 255.0) * 2 * math.pi * (i + 1)
        values.append(math.sin(angle) * 0.1)

    magnitude = math.sqrt(sum(v * v for v in values))
    if magnitude > 0:
        values = [v / magnitude for v in values]

    return values
