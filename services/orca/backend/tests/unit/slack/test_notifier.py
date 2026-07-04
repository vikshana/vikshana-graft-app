"""Tests for harness/slack/notifier.py — SlackNotifier post_turn_result."""

from __future__ import annotations

from typing import Any
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from harness.slack.notifier import SlackNotifier, _build_blocks_for_result, _fallback_text


# ---------------------------------------------------------------------------
# _build_blocks_for_result helpers
# ---------------------------------------------------------------------------


class TestBuildBlocksForResult:
    def test_none_result_returns_thinking_message(self):
        blocks = _build_blocks_for_result("sess-1", None)
        assert any("Thinking" in str(b) for b in blocks)

    def test_error_result_returns_error_message(self):
        result = {"error_message": "Something failed"}
        blocks = _build_blocks_for_result("sess-1", result)
        assert any("Something failed" in str(b) for b in blocks)

    def test_final_report_returns_final_answer(self):
        result = {"final_report": "Root cause found.", "confidence_level": "high"}
        blocks = _build_blocks_for_result("sess-1", result)
        block_text = str(blocks)
        assert "Root cause found." in block_text

    def test_in_progress_result_returns_thinking(self):
        result = {"status": "investigating"}
        blocks = _build_blocks_for_result("sess-1", result)
        assert any("Thinking" in str(b) or "working" in str(b).lower() for b in blocks)


class TestFallbackText:
    def test_none_returns_thinking(self):
        assert "thinking" in _fallback_text(None).lower()

    def test_error_result(self):
        assert "error" in _fallback_text({"error_message": "fail"}).lower()

    def test_final_report_result(self):
        assert "complete" in _fallback_text({"final_report": "done"}).lower()


# ---------------------------------------------------------------------------
# SlackNotifier
# ---------------------------------------------------------------------------


class TestSlackNotifier:
    async def test_post_turn_result_no_slack_token_skips_silently(self):
        """If SLACK_BOT_TOKEN is empty, post_turn_result returns without posting."""
        mock_client = AsyncMock()

        with patch("harness.slack.notifier.settings") as mock_settings:
            mock_settings.SLACK_BOT_TOKEN = ""
            notifier = SlackNotifier(web_client=mock_client)
            await notifier.post_turn_result("sess-1", {}, turn_result=None)

        mock_client.chat_postMessage.assert_not_called()

    async def test_post_turn_result_no_channel_refs_skips(self):
        """If the session has no channel_refs, nothing is posted."""
        mock_client = AsyncMock()
        mock_db_row = MagicMock()
        mock_db_row.channel_refs = []

        async def mock_session_ctx():
            class FakeDB:
                async def execute(self, *a, **kw):
                    r = MagicMock()
                    r.fetchone = MagicMock(return_value=mock_db_row)
                    return r

                async def __aenter__(self):
                    return self

                async def __aexit__(self, *a):
                    pass

            return FakeDB()

        with (
            patch("harness.slack.notifier.settings") as mock_settings,
            patch("harness.slack.notifier.AsyncSessionLocal", side_effect=mock_session_ctx),
        ):
            mock_settings.SLACK_BOT_TOKEN = "xoxb-test"
            notifier = SlackNotifier(web_client=mock_client)
            await notifier.post_turn_result("sess-2", {}, turn_result=None)

        mock_client.chat_postMessage.assert_not_called()

    async def test_post_turn_result_posts_to_slack_channel(self):
        """When channel_refs contains a Slack ref, chat_postMessage is called."""
        mock_client = AsyncMock()
        mock_client.chat_postMessage = AsyncMock(return_value={"ok": True})

        slack_ref = {"type": "slack", "channel": "C12345", "thread_ts": "111.222", "team_id": "T1"}
        mock_db_row = MagicMock()
        mock_db_row.channel_refs = [slack_ref]

        class FakeDB:
            async def execute(self, *a, **kw):
                r = MagicMock()
                r.fetchone = MagicMock(return_value=mock_db_row)
                return r

            async def __aenter__(self):
                return self

            async def __aexit__(self, *a):
                pass

        with (
            patch("harness.slack.notifier.settings") as mock_settings,
            patch("harness.slack.notifier.AsyncSessionLocal", return_value=FakeDB()),
        ):
            mock_settings.SLACK_BOT_TOKEN = "xoxb-test"
            notifier = SlackNotifier(web_client=mock_client)
            await notifier.post_turn_result(
                "sess-3",
                {},
                turn_result={"final_report": "All good.", "confidence_level": "high"},
            )

        mock_client.chat_postMessage.assert_called_once()
        call_kwargs = mock_client.chat_postMessage.call_args.kwargs
        assert call_kwargs["channel"] == "C12345"
        assert call_kwargs["thread_ts"] == "111.222"

    async def test_exception_during_post_does_not_propagate(self):
        """Errors from Slack API calls are swallowed — never re-raised."""
        mock_client = AsyncMock()
        mock_client.chat_postMessage = AsyncMock(side_effect=RuntimeError("slack down"))

        slack_ref = {"type": "slack", "channel": "C99", "thread_ts": None, "team_id": "T1"}
        mock_db_row = MagicMock()
        mock_db_row.channel_refs = [slack_ref]

        class FakeDB:
            async def execute(self, *a, **kw):
                r = MagicMock()
                r.fetchone = MagicMock(return_value=mock_db_row)
                return r

            async def __aenter__(self):
                return self

            async def __aexit__(self, *a):
                pass

        with (
            patch("harness.slack.notifier.settings") as mock_settings,
            patch("harness.slack.notifier.AsyncSessionLocal", return_value=FakeDB()),
        ):
            mock_settings.SLACK_BOT_TOKEN = "xoxb-test"
            notifier = SlackNotifier(web_client=mock_client)
            # Should not raise
            await notifier.post_turn_result("sess-4", {}, turn_result=None)
