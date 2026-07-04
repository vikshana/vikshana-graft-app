"""SlackNotifier — posts turn results to Slack threads.

After ``TurnWorker._execute_turn`` completes, it calls
``SlackNotifier.post_turn_result`` which:

1. Reads ``rca_sessions.channel_refs`` for any Slack refs.
2. Builds an appropriate Block Kit message based on the turn result.
3. Posts (or updates) the thread via ``slack_sdk.AsyncWebClient``.

This is a best-effort side-effect: failures are logged but never re-raised
so they cannot interrupt the main agent loop.

Integration point in ``harness/session/worker.py``::

    from harness.slack.notifier import SlackNotifier
    _notifier = SlackNotifier()
    # … after graph.ainvoke …
    await _notifier.post_turn_result(session_id, payload, turn_result=None)
"""

from __future__ import annotations

from typing import Any

import structlog
from sqlalchemy import text

from app.config import settings
from app.db import AsyncSessionLocal
from harness.slack.block_kit import error_message, final_answer_message, thinking_message
from harness.slack.channel_refs import parse_slack_refs

logger = structlog.get_logger()


class SlackNotifier:
    """Posts turn-completion notifications to Slack thread(s) referenced in
    ``rca_sessions.channel_refs``.

    Args:
        web_client: Optional pre-configured ``AsyncWebClient`` (for testing).
            When ``None``, a client is constructed lazily from
            ``SLACK_BOT_TOKEN`` on first use.
    """

    def __init__(self, web_client: Any | None = None) -> None:
        self._web_client = web_client
        self._client_initialized = web_client is not None

    def _get_client(self) -> Any:
        """Return (or lazily create) the AsyncWebClient."""
        if not self._client_initialized:
            from slack_sdk.web.async_client import AsyncWebClient  # type: ignore[import-untyped]

            self._web_client = AsyncWebClient(token=settings.SLACK_BOT_TOKEN)
            self._client_initialized = True
        return self._web_client

    async def post_turn_result(
        self,
        session_id: str,
        payload: dict[str, Any],
        turn_result: Any | None = None,
    ) -> None:
        """Post a turn-completion message to all Slack threads in ``channel_refs``.

        This is best-effort — any exception is caught and logged, never re-raised.

        Args:
            session_id: Session identifier used to look up ``channel_refs``.
            payload: Turn job payload (contains ``session_type`` etc.).
            turn_result: Optional result dict from the graph invocation.
                May contain ``final_report``, ``confidence_level``, ``error_message``.
        """
        try:
            await self._do_post(session_id, payload, turn_result)
        except Exception as exc:
            logger.warning(
                "slack_notifier_post_failed",
                session_id=session_id,
                error=str(exc),
            )

    async def _do_post(
        self,
        session_id: str,
        payload: dict[str, Any],
        turn_result: Any | None,
    ) -> None:
        """Internal implementation — may raise; caller handles exceptions."""
        if not settings.SLACK_BOT_TOKEN:
            return  # Slack not configured — skip silently

        # Look up channel_refs from the database
        async with AsyncSessionLocal() as db:
            result = await db.execute(
                text("SELECT channel_refs FROM rca_sessions WHERE id = :sid"),
                {"sid": session_id},
            )
            row = result.fetchone()

        if row is None:
            return

        slack_refs = parse_slack_refs(row.channel_refs or [])
        if not slack_refs:
            return

        # Build the Block Kit message
        blocks = _build_blocks_for_result(session_id, turn_result)

        client = self._get_client()
        for ref in slack_refs:
            channel: str = ref["channel"]
            thread_ts: str | None = ref.get("thread_ts")
            try:
                kwargs: dict[str, Any] = {
                    "channel": channel,
                    "blocks": blocks,
                    "text": _fallback_text(turn_result),
                }
                if thread_ts:
                    kwargs["thread_ts"] = thread_ts

                await client.chat_postMessage(**kwargs)
                logger.info(
                    "slack_turn_result_posted",
                    session_id=session_id,
                    channel=channel,
                    thread_ts=thread_ts,
                )
            except Exception as exc:
                logger.warning(
                    "slack_post_channel_failed",
                    session_id=session_id,
                    channel=channel,
                    error=str(exc),
                )


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _build_blocks_for_result(
    session_id: str,
    turn_result: Any | None,
) -> list[dict[str, Any]]:
    """Return the appropriate Block Kit blocks for *turn_result*.

    Args:
        session_id: Session ID for the footer.
        turn_result: Graph invocation result; may be a dict, a state object, or None.

    Returns:
        Block Kit blocks list.
    """
    if turn_result is None:
        return thinking_message(session_id=session_id)

    # turn_result may be a dict (LangGraph state snapshot) or a typed state object
    result_dict: dict[str, Any] = (
        dict(turn_result) if hasattr(turn_result, "__iter__") and not isinstance(turn_result, str)
        else {}
    )

    error = result_dict.get("error_message") or getattr(turn_result, "error_message", None)
    if error:
        return error_message(reason=str(error), session_id=session_id)

    final_report: str = (
        result_dict.get("final_report")
        or result_dict.get("report_markdown")
        or getattr(turn_result, "final_report", None)
        or getattr(turn_result, "report_markdown", None)
        or ""
    )
    confidence: str = (
        result_dict.get("confidence_level")
        or getattr(turn_result, "confidence_level", "")
        or ""
    )

    if final_report:
        return final_answer_message(
            answer_text=final_report,
            session_id=session_id,
            confidence=confidence,
        )

    # Still in-progress or no report yet
    return thinking_message(session_id=session_id)


def _fallback_text(turn_result: Any | None) -> str:
    """Return a plain-text fallback for push notifications."""
    if turn_result is None:
        return "Agent is thinking…"
    result_dict: dict[str, Any] = (
        dict(turn_result) if hasattr(turn_result, "__iter__") and not isinstance(turn_result, str)
        else {}
    )
    if result_dict.get("error_message") or getattr(turn_result, "error_message", None):
        return "Agent encountered an error."
    if result_dict.get("final_report") or result_dict.get("report_markdown"):
        return "Investigation complete."
    return "Agent is working…"
