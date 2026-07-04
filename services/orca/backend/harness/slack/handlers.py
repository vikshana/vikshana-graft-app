"""Slack Bolt command and action handlers for the observability agent.

All handlers are registered on the shared ``bolt_app`` from ``harness.slack.app``
via the ``register_handlers()`` function, which is idempotent (called once at
module import from ``harness/slack/__init__.py``).

Slash command: ``/obs <subcommand> [args]``

Supported subcommands:
  ask <prompt>          — Single-shot question to the agent.
  investigate <prompt>  — Start a structured investigation session.
  link                  — Start the Entra identity linkage flow.

Action handlers:
  approve_tool_call     — Approve a pending tool call (value: "session_id:job_id").
  reject_tool_call      — Reject a pending tool call (value: "session_id:job_id").

3-second ack guarantee:
  Every command handler calls ``await ack()`` before any async work.
  Actual processing runs in a background ``asyncio.create_task()``.
"""

from __future__ import annotations

import asyncio
import uuid
from typing import Any

import structlog
from slack_bolt.async_app import AsyncAck, AsyncSay

from harness.slack.app import bolt_app
from harness.slack.block_kit import (
    approval_prompt,
    error_message,
    thinking_message,
)
from harness.slack.channel_refs import build_slack_ref

logger = structlog.get_logger()

_handlers_registered = False


# ---------------------------------------------------------------------------
# Registration entry point
# ---------------------------------------------------------------------------


def register_handlers() -> None:
    """Idempotently register all Slack Bolt handlers on ``bolt_app``.

    Called once at import time from ``harness/slack/__init__.py``.
    Safe to call multiple times (subsequent calls are no-ops).
    """
    global _handlers_registered  # noqa: PLW0603
    if _handlers_registered:
        return
    _handlers_registered = True

    bolt_app.command("/obs")(_handle_obs_command)
    bolt_app.action("approve_tool_call")(_handle_approve)
    bolt_app.action("reject_tool_call")(_handle_reject)


# ---------------------------------------------------------------------------
# /obs command dispatcher
# ---------------------------------------------------------------------------


async def _handle_obs_command(
    ack: AsyncAck,
    command: dict[str, Any],
    say: AsyncSay,
) -> None:
    """Dispatch ``/obs <subcommand> [args]`` to the appropriate handler.

    Acks immediately so Slack's 3-second timeout is never exceeded.
    All work is dispatched to a background asyncio task.

    Args:
        ack: Bolt acknowledgement callable.
        command: Slack slash command payload.
        say: Bolt ``say`` callable for posting to the channel.
    """
    await ack()
    text: str = (command.get("text") or "").strip()
    parts = text.split(None, 1)
    subcommand = parts[0].lower() if parts else ""
    args = parts[1] if len(parts) > 1 else ""

    log = logger.bind(
        slack_user_id=command.get("user_id"),
        slack_team_id=command.get("team_id"),
        subcommand=subcommand,
    )

    if subcommand == "ask":
        asyncio.create_task(_do_ask(command=command, prompt=args, say=say, log=log))
    elif subcommand == "investigate":
        asyncio.create_task(_do_investigate(command=command, prompt=args, say=say, log=log))
    elif subcommand == "link":
        asyncio.create_task(_do_link(command=command, say=say, log=log))
    else:
        await say(
            blocks=error_message(
                reason=(
                    f"Unknown subcommand `{subcommand or '<empty>'}`. "
                    "Try `/obs ask <question>`, `/obs investigate <alert>`, or `/obs link`."
                )
            ),
            text="Unknown subcommand.",
        )


# ---------------------------------------------------------------------------
# Subcommand implementations
# ---------------------------------------------------------------------------


async def _do_ask(
    command: dict[str, Any],
    prompt: str,
    say: AsyncSay,
    log: Any,
) -> None:
    """Handle ``/obs ask <prompt>``.

    Creates a new ``ask`` session in the TurnWorker queue and posts a
    "Thinking…" message with the session ID so the user can track progress.

    Args:
        command: Slack slash command payload.
        prompt: The user's question text.
        say: Bolt say callable.
        log: Bound structlog logger.
    """
    if not prompt:
        await say(
            blocks=error_message(reason="Please provide a question, e.g. `/obs ask why is checkout slow?`"),
            text="Missing prompt.",
        )
        return

    session_id = str(uuid.uuid4())
    channel: str = command.get("channel_id", "")
    thread_ts: str | None = None  # top-level post; reply thread_ts set after posting
    team_id: str = command.get("team_id", "")
    user_id: str = command.get("user_id", "")

    try:
        # Post "Thinking…" to get a thread_ts
        response = await say(
            blocks=thinking_message(session_id=session_id, prompt_preview=prompt),
            text="Thinking…",
        )
        thread_ts = response.get("ts") if response else None

        # Persist session with channel_ref so SlackNotifier can find the thread
        await _create_session_and_enqueue(
            session_id=session_id,
            session_type="ask",
            turn_input={"prompt": prompt, "user_id": user_id},
            channel=channel,
            thread_ts=thread_ts,
            team_id=team_id,
        )
        log.info("obs_ask_enqueued", session_id=session_id)
    except Exception as exc:
        log.error("obs_ask_failed", error=str(exc), exc_info=True)
        await say(
            blocks=error_message(reason=f"Failed to start session: {exc}"),
            text="Error.",
        )


async def _do_investigate(
    command: dict[str, Any],
    prompt: str,
    say: AsyncSay,
    log: Any,
) -> None:
    """Handle ``/obs investigate <alert-context>``.

    Creates a full ``investigation`` session (same as the Grafana UI Sessions page)
    and posts a "Thinking…" thread message.

    Args:
        command: Slack slash command payload.
        prompt: Alert context / investigation request text.
        say: Bolt say callable.
        log: Bound structlog logger.
    """
    if not prompt:
        await say(
            blocks=error_message(
                reason="Please provide an alert description, e.g. `/obs investigate high error rate on checkout`"
            ),
            text="Missing prompt.",
        )
        return

    session_id = str(uuid.uuid4())
    channel: str = command.get("channel_id", "")
    team_id: str = command.get("team_id", "")
    user_id: str = command.get("user_id", "")

    try:
        response = await say(
            blocks=thinking_message(session_id=session_id, prompt_preview=prompt),
            text="Starting investigation…",
        )
        thread_ts = response.get("ts") if response else None

        await _create_session_and_enqueue(
            session_id=session_id,
            session_type="investigation",
            turn_input={"prompt": prompt, "user_id": user_id},
            channel=channel,
            thread_ts=thread_ts,
            team_id=team_id,
        )
        log.info("obs_investigate_enqueued", session_id=session_id)
    except Exception as exc:
        log.error("obs_investigate_failed", error=str(exc), exc_info=True)
        await say(
            blocks=error_message(reason=f"Failed to start investigation: {exc}"),
            text="Error.",
        )


async def _do_link(
    command: dict[str, Any],
    say: AsyncSay,
    log: Any,
) -> None:
    """Handle ``/obs link`` — start the Entra identity linkage flow.

    Generates a PKCE link request and posts an ephemeral message with the
    authorization URL.

    Args:
        command: Slack slash command payload.
        say: Bolt say callable.
        log: Bound structlog logger.
    """
    slack_user_id: str = command.get("user_id", "")
    slack_team_id: str = command.get("team_id", "")

    try:
        from app.db import AsyncSessionLocal
        from harness.auth.linkage import generate_link_request

        async with AsyncSessionLocal() as db:
            link = await generate_link_request(
                slack_user_id=slack_user_id,
                slack_team_id=slack_team_id,
                db=db,
            )

        await say(
            text=(
                f":link: *Link your Grafana/Entra account*\n"
                f"Click here to authenticate: {link.auth_url}\n"
                f"_Link expires in 10 minutes._"
            ),
        )
        log.info("obs_link_url_sent", slack_user_id=slack_user_id)
    except Exception as exc:
        log.error("obs_link_failed", error=str(exc), exc_info=True)
        await say(
            blocks=error_message(reason=f"Failed to generate link URL: {exc}"),
            text="Error.",
        )


# ---------------------------------------------------------------------------
# Approval action handlers
# ---------------------------------------------------------------------------


async def _handle_approve(
    ack: AsyncAck,
    body: dict[str, Any],
    say: AsyncSay,
) -> None:
    """Handle the ``approve_tool_call`` button action.

    Acks immediately, then resumes the paused session with ``approved=True``.

    Args:
        ack: Bolt acknowledgement callable.
        body: Full Slack action payload.
        say: Bolt say callable.
    """
    await ack()
    asyncio.create_task(_do_resume(body=body, approved=True, say=say))


async def _handle_reject(
    ack: AsyncAck,
    body: dict[str, Any],
    say: AsyncSay,
) -> None:
    """Handle the ``reject_tool_call`` button action.

    Acks immediately, then resumes the paused session with ``approved=False``.

    Args:
        ack: Bolt acknowledgement callable.
        body: Full Slack action payload.
        say: Bolt say callable.
    """
    await ack()
    asyncio.create_task(_do_resume(body=body, approved=False, say=say))


async def _do_resume(
    body: dict[str, Any],
    approved: bool,
    say: AsyncSay,
) -> None:
    """Parse the action value and resume the paused session.

    The ``value`` field of the button is ``"session_id:job_id"``.

    Args:
        body: Full Slack action payload.
        approved: ``True`` to approve, ``False`` to reject.
        say: Bolt say callable for confirmation.
    """
    log = logger.bind(approved=approved)
    try:
        action = (body.get("actions") or [{}])[0]
        value: str = action.get("value", "")
        parts = value.split(":", 1)
        if len(parts) != 2:
            log.warning("obs_approval_bad_value", value=value)
            return

        session_id, _job_id = parts
        from harness.session.worker import enqueue_turn

        _new_job_id, is_busy = await enqueue_turn(
            session_id=session_id,
            session_type="investigation",
            resume_command={"approved": approved},
        )
        action_word = "approved" if approved else "rejected"
        await say(
            text=f":white_check_mark: Tool call {action_word}. Resuming session `{session_id}`…",
        )
        log.info("obs_approval_resume_enqueued", session_id=session_id, is_busy=is_busy)
    except Exception as exc:
        log.error("obs_approval_failed", error=str(exc), exc_info=True)


# ---------------------------------------------------------------------------
# Internal helpers
# ---------------------------------------------------------------------------


async def _create_session_and_enqueue(
    session_id: str,
    session_type: str,
    turn_input: dict[str, Any],
    channel: str,
    thread_ts: str | None,
    team_id: str,
) -> None:
    """Create an rca_sessions row and enqueue the first turn.

    Args:
        session_id: Pre-generated session UUID.
        session_type: Graph type (``"ask"`` or ``"investigation"``).
        turn_input: Initial turn payload.
        channel: Slack channel ID.
        thread_ts: Slack thread timestamp (may be None for top-level).
        team_id: Slack team/workspace ID.
    """
    import json
    from datetime import datetime, timezone
    from sqlalchemy import text

    from app.db import AsyncSessionLocal
    from harness.slack.channel_refs import build_slack_ref
    from harness.session.worker import enqueue_turn

    now = datetime.now(timezone.utc)
    slack_ref = build_slack_ref(channel=channel, thread_ts=thread_ts, team_id=team_id)

    async with AsyncSessionLocal() as db:
        # Upsert rca_sessions row with channel_refs
        await db.execute(
            text("""
                INSERT INTO rca_sessions
                    (id, type, status, auth_mode, initiator_channel, channel_refs, created_at, updated_at)
                VALUES
                    (:id, :type, 'pending', 'service_account', 'slack',
                     :channel_refs::jsonb, :now, :now)
                ON CONFLICT (id) DO UPDATE
                    SET channel_refs = EXCLUDED.channel_refs,
                        updated_at = EXCLUDED.updated_at
            """),
            {
                "id": session_id,
                "type": session_type,
                "channel_refs": json.dumps([slack_ref]),
                "now": now,
            },
        )
        await db.commit()

    await enqueue_turn(
        session_id=session_id,
        session_type=session_type,
        turn_input=turn_input,
    )
