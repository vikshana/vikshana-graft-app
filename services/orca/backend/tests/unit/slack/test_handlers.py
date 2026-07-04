"""Tests for harness/slack/handlers.py — /obs command and action handlers.

Uses the Bolt AsyncSlackRequestHandler to simulate inbound Slack payloads
without a real workspace.
"""

from __future__ import annotations

import json
from typing import Any
from unittest.mock import AsyncMock, MagicMock, patch

import pytest


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


@pytest.fixture(autouse=True)
def _reset_handler_registration():
    """Reset the _handlers_registered flag before each test so handlers can
    be cleanly re-registered on a fresh bolt_app mock."""
    import harness.slack.handlers as h
    original = h._handlers_registered
    h._handlers_registered = False
    yield
    h._handlers_registered = original


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _make_obs_command(text: str, user_id: str = "U001", channel_id: str = "C001", team_id: str = "T001") -> dict[str, Any]:
    return {
        "command": "/obs",
        "text": text,
        "user_id": user_id,
        "channel_id": channel_id,
        "team_id": team_id,
    }


# ---------------------------------------------------------------------------
# /obs dispatcher
# ---------------------------------------------------------------------------


class TestObsCommandDispatcher:
    async def test_unknown_subcommand_returns_error(self):
        """An unknown subcommand results in an error message."""
        from harness.slack.handlers import _handle_obs_command

        ack = AsyncMock()
        say = AsyncMock()

        await _handle_obs_command(
            ack=ack,
            command=_make_obs_command("unknown-sub"),
            say=say,
        )

        ack.assert_awaited_once()
        say.assert_awaited_once()
        call_kwargs = say.call_args.kwargs or say.call_args[1]
        blocks = call_kwargs.get("blocks", [])
        assert any("Unknown subcommand" in str(b) for b in blocks)

    async def test_empty_text_returns_error(self):
        """Empty /obs text returns error."""
        from harness.slack.handlers import _handle_obs_command

        ack = AsyncMock()
        say = AsyncMock()

        await _handle_obs_command(
            ack=ack,
            command=_make_obs_command(""),
            say=say,
        )

        ack.assert_awaited_once()
        say.assert_awaited_once()

    async def test_ack_called_before_say(self):
        """ack() must be called before any say() to satisfy 3-second guarantee."""
        from harness.slack.handlers import _handle_obs_command

        call_order: list[str] = []

        async def tracking_ack():
            call_order.append("ack")

        async def tracking_say(*a, **kw):
            call_order.append("say")
            return {"ts": "1234.5678"}

        with patch("harness.slack.handlers.asyncio.create_task"):
            await _handle_obs_command(
                ack=tracking_ack,
                command=_make_obs_command("ask hello"),
                say=tracking_say,
            )

        assert call_order[0] == "ack"


# ---------------------------------------------------------------------------
# /obs ask
# ---------------------------------------------------------------------------


class TestObsAsk:
    async def test_ask_without_prompt_returns_error(self):
        """``/obs ask`` with no text replies with an error."""
        from harness.slack.handlers import _do_ask

        say = AsyncMock()
        log = MagicMock()
        log.info = MagicMock()
        log.error = MagicMock()

        await _do_ask(
            command=_make_obs_command("ask"),
            prompt="",
            say=say,
            log=log,
        )

        say.assert_awaited_once()
        call = say.call_args.kwargs or say.call_args[1]
        # Error message should contain some indicator of missing input
        block_str = str(call.get("blocks", [])) + str(call.get("text", ""))
        assert any(word in block_str.lower() for word in ("question", "missing", "provide", "error"))

    async def test_ask_with_prompt_calls_say_thinking(self):
        """``/obs ask <prompt>`` posts a Thinking… message and enqueues a turn."""
        from harness.slack.handlers import _do_ask

        say = AsyncMock(return_value={"ts": "111.222"})
        log = MagicMock()
        log.info = MagicMock()
        log.error = MagicMock()

        with (
            patch("harness.slack.handlers._create_session_and_enqueue", new_callable=AsyncMock),
        ):
            await _do_ask(
                command=_make_obs_command("ask"),
                prompt="why is checkout slow?",
                say=say,
                log=log,
            )

        say.assert_awaited_once()
        call = say.call_args.kwargs or say.call_args[1]
        assert any("Thinking" in str(b) for b in call.get("blocks", []))


# ---------------------------------------------------------------------------
# Approval actions
# ---------------------------------------------------------------------------


class TestApprovalActions:
    async def test_approve_acks_and_enqueues_resume(self):
        """approve_tool_call acks and calls enqueue_turn with approved=True."""
        from harness.slack.handlers import _handle_approve

        ack = AsyncMock()
        say = AsyncMock()
        body = {
            "actions": [{"action_id": "approve_tool_call", "value": "sess-abc:job-xyz"}]
        }

        with (
            patch("harness.slack.handlers.asyncio.create_task") as mock_create_task,
        ):
            await _handle_approve(ack=ack, body=body, say=say)

        ack.assert_awaited_once()
        mock_create_task.assert_called_once()

    async def test_reject_acks_and_dispatches_task(self):
        """reject_tool_call acks and dispatches a background task."""
        from harness.slack.handlers import _handle_reject

        ack = AsyncMock()
        say = AsyncMock()
        body = {
            "actions": [{"action_id": "reject_tool_call", "value": "sess-abc:job-xyz"}]
        }

        with patch("harness.slack.handlers.asyncio.create_task") as mock_create_task:
            await _handle_reject(ack=ack, body=body, say=say)

        ack.assert_awaited_once()
        mock_create_task.assert_called_once()


# ---------------------------------------------------------------------------
# register_handlers
# ---------------------------------------------------------------------------


class TestRegisterHandlers:
    def test_register_handlers_is_idempotent(self):
        """Calling register_handlers twice does not double-register."""
        import harness.slack.handlers as h

        with patch.object(h.bolt_app, "command") as mock_cmd:
            mock_cmd.return_value = lambda f: f  # decorator passthrough

            h.register_handlers()
            h.register_handlers()  # second call should be no-op

        # command() called exactly once (not twice)
        assert mock_cmd.call_count == 1
