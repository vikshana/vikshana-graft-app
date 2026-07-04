"""Langfuse integration — session correlation and feedback ingestion."""

from __future__ import annotations

import structlog

logger = structlog.get_logger()


class LangfuseClient:
    """Thin wrapper around the Langfuse Python SDK for session correlation.

    Args:
        public_key: Langfuse project public key.
        secret_key: Langfuse project secret key.
        host: Langfuse server URL (default: https://cloud.langfuse.com).
    """

    def __init__(self, public_key: str, secret_key: str, host: str = "") -> None:
        self._pk = public_key
        self._sk = secret_key
        self._host = host
        self._client: object | None = None

    def _get_client(self) -> object:
        """Lazily initialise the Langfuse SDK client.

        Returns:
            Langfuse client instance.
        """
        if self._client is None:
            try:
                from langfuse import Langfuse  # type: ignore[import]
                kwargs: dict = {
                    "public_key": self._pk,
                    "secret_key": self._sk,
                }
                if self._host:
                    kwargs["host"] = self._host
                self._client = Langfuse(**kwargs)
            except ImportError:
                logger.warning("langfuse_sdk_not_installed", hint="pip install langfuse")
                self._client = _NoOpLangfuse()
        return self._client

    def record_session_trace(self, session_id: str, trace_id: str) -> None:
        """Record a session → OTel trace correlation in Langfuse.

        Args:
            session_id: Internal session identifier.
            trace_id: OTel trace ID hex string.
        """
        try:
            client = self._get_client()
            client.trace(  # type: ignore[attr-defined]
                id=trace_id,
                session_id=session_id,
                name="agent_session",
            )
        except Exception as exc:
            logger.warning("langfuse_record_trace_failed", session_id=session_id, error=str(exc))

    def record_feedback(
        self,
        session_id: str,
        score: float,
        comment: str = "",
        trace_id: str | None = None,
    ) -> None:
        """Record user feedback for a session.

        Args:
            session_id: Internal session identifier.
            score: Numeric score (e.g. 1.0 for thumbs-up, 0.0 for thumbs-down).
            comment: Optional textual comment.
            trace_id: Optional OTel trace ID to attach the score to.
        """
        try:
            client = self._get_client()
            kwargs: dict = {
                "name": "user_feedback",
                "value": score,
                "comment": comment or None,
            }
            if trace_id:
                kwargs["trace_id"] = trace_id
            else:
                kwargs["trace_id"] = session_id  # fallback
            client.score(**kwargs)  # type: ignore[attr-defined]
            logger.info("langfuse_feedback_recorded", session_id=session_id, score=score)
        except Exception as exc:
            logger.warning("langfuse_feedback_failed", session_id=session_id, error=str(exc))

    def flush(self) -> None:
        """Flush pending Langfuse events.  Call at shutdown or after CI runs."""
        try:
            if self._client is not None and not isinstance(self._client, _NoOpLangfuse):
                self._client.flush()  # type: ignore[attr-defined]
        except Exception:
            pass


class _NoOpLangfuse:
    """No-op Langfuse stub used when the SDK is not installed."""

    def trace(self, **kwargs: object) -> None:  # noqa: D401
        """No-op trace."""

    def score(self, **kwargs: object) -> None:  # noqa: D401
        """No-op score."""

    def flush(self) -> None:  # noqa: D401
        """No-op flush."""


def make_langfuse_client() -> LangfuseClient:
    """Construct a LangfuseClient from application settings.

    Returns:
        Configured LangfuseClient.
    """
    from app.config import settings
    return LangfuseClient(
        public_key=settings.LANGFUSE_PUBLIC_KEY,
        secret_key=settings.LANGFUSE_SECRET_KEY,
        host=settings.LANGFUSE_HOST,
    )
