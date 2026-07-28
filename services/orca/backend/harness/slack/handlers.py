"""Slack Bolt command and action handlers for the observability agent.

All handlers are registered on the shared ``bolt_app`` from ``harness.slack.app``
via the ``register_handlers()`` function, which is idempotent (called once at
module import from ``harness/slack/__init__.py``).

Slash command: ``/obs <subcommand> [args]``

Supported subcommands:
  ask <prompt>          — Not implemented yet; replies with a rejection
                           message pointing at `investigate` (see
                           docs/harness-risk-review.md, F1 — no `"ask"`
                           graph is registered in
                           `harness.session.registry.graph_registry`).
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

    ``ask`` sessions are not implemented yet: only ``session_type="investigation"``
    is registered in ``harness.session.registry.graph_registry`` (see
    ``app/main.py``) — there is no ``"ask"`` graph. Previously this handler
    enqueued a turn job for ``session_type="ask"`` anyway, which the
    ``TurnWorker`` can never execute: ``graph_registry.aget("ask")`` raises
    ``KeyError`` deep inside ``_execute_turn``, the job is marked
    ``failed``, and the Slack user is left staring at an unresolved
    "Thinking…" message forever with no feedback (see
    docs/harness-risk-review.md, F1). Reject up front instead, with a
    clear message pointing at the supported ``/obs investigate`` subcommand.

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

    log.info("obs_ask_rejected_unsupported")
    await say(
        blocks=error_message(
            reason=(
                "`/obs ask` is not supported yet. Use `/obs investigate <alert description>` "
                "to start a structured investigation instead."
            )
        ),
        text="`/obs ask` is not supported yet — try `/obs investigate` instead.",
    )


def _build_slack_investigation_state(prompt: str, org_id: int | None) -> dict[str, Any]:
    """Build a complete ``RCAState``-shaped initial turn input for a Slack investigation.

    ``harness.session.worker.TurnWorker._execute_turn`` passes this dict
    straight to ``graph.ainvoke(turn_input, ...)`` for a fresh invocation.
    The interactive RCA graph's nodes index required keys directly (e.g.
    ``state["alert_context"]``, ``state["round"]``) rather than via
    ``.get(...)`` with a default, so a partial payload — as previously sent
    here (only ``{"prompt": ..., "user_id": ...}`` at the top level, with no
    ``alert_context`` wrapper at all) — raises a bare ``KeyError`` on the
    very first node the first time the graph runs. The ``TurnWorker`` can
    only surface that as a generic failed job with no feedback posted back
    to the Slack thread (see docs/harness-risk-review.md, F1). This mirrors
    the equivalent, already-fixed builder in
    ``harness.triage.auto_triage._build_initial_rca_state`` and
    ``app.agent.rca_state.RCAState``.

    Args:
        prompt: The developer's alert-description / investigation prompt
            text from ``/obs investigate <prompt>``.
        org_id: Grafana organisation ID to scope MCP tool calls to (Slack
            investigations use ``settings.SLACK_DEFAULT_ORG_ID`` — there is
            no per-request Grafana org header at this layer).

    Returns:
        A dict satisfying every required key of
        ``app.agent.rca_state.RCAState``.
    """
    from app.config import settings

    alert_context: dict[str, Any] = {
        "alert_id": None,
        "alert_name": "Slack investigation",
        "description": prompt,
        "service": None,
        "environment": None,
        "labels": {},
        "org_id": org_id,
    }

    return {
        "alert_context": alert_context,
        "org_id": org_id,
        "gathered_data": [],
        "past_rcas": [],
        "hypotheses": [],
        "confidence_scores": [],
        "round": 0,
        "developer_accepted": False,
        "max_rounds": settings.ORCA_MAX_ROUNDS,
        "messages": [],
        "pending_question": None,
        "final_report": None,
        "rca_session_id": None,
        "error_message": None,
        "force_finalized": False,
        "tool_call_count": 0,
        "investigation_started_at": None,
    }


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

        from app.config import settings

        await _create_session_and_enqueue(
            session_id=session_id,
            session_type="investigation",
            turn_input=_build_slack_investigation_state(
                prompt, org_id=settings.SLACK_DEFAULT_ORG_ID
            ),
            channel=channel,
            thread_ts=thread_ts,
            team_id=team_id,
            slack_user_id=user_id,
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


async def _resolve_slack_initiator_user_id(
    slack_user_id: str,
    slack_team_id: str,
    db: Any,
) -> str | None:
    """Resolve the internal harness user id linked to a Slack user, if any.

    Looks up the ``identities`` table for a ``provider='slack'`` row whose
    ``provider_subject`` matches ``{team_id}:{user_id}`` — the same
    composite subject the Entra linkage flow writes in
    ``harness.auth.linkage.complete_link``. This is what lets
    ``rca_sessions.initiator_user_id`` be populated for Slack-created
    sessions so the write-approval check
    (``decided_by_user_id == sessions.initiator_user_id``, see
    ``harness.guards.guards.WriteGuard``) can recognise the Slack user who
    started the session.

    Args:
        slack_user_id: Slack user ID (e.g. ``U01234567``).
        slack_team_id: Slack workspace/team ID (e.g. ``T01234567``).
        db: Async DB session.

    Returns:
        The linked ``users.id`` UUID string, or ``None`` if this Slack user
        has not completed ``/obs link`` yet.
    """
    from sqlalchemy import text

    result = await db.execute(
        text("""
            SELECT user_id FROM identities
            WHERE provider = 'slack' AND provider_subject = :subject
        """),
        {"subject": f"{slack_team_id}:{slack_user_id}"},
    )
    row = result.fetchone()
    return str(row.user_id) if row else None


async def _create_session_and_enqueue(
    session_id: str,
    session_type: str,
    turn_input: dict[str, Any],
    channel: str,
    thread_ts: str | None,
    team_id: str,
    slack_user_id: str = "",
) -> None:
    """Create an rca_sessions row and enqueue the first turn.

    Args:
        session_id: Pre-generated session UUID.
        session_type: Graph type (``"ask"`` or ``"investigation"``).
        turn_input: Initial turn payload.
        channel: Slack channel ID.
        thread_ts: Slack thread timestamp (may be None for top-level).
        team_id: Slack team/workspace ID.
        slack_user_id: Slack user ID of the command's caller, used to
            resolve ``initiator_user_id`` via identity linkage. Empty
            string (default) leaves ``initiator_user_id`` unset.
    """
    import json
    from datetime import datetime, timezone
    from sqlalchemy import text

    from app.config import settings
    from app.db import AsyncSessionLocal
    from harness.slack.channel_refs import build_slack_ref
    from harness.session.worker import enqueue_turn

    now = datetime.now(timezone.utc)
    slack_ref = build_slack_ref(channel=channel, thread_ts=thread_ts, team_id=team_id)
    org_id = settings.SLACK_DEFAULT_ORG_ID

    async with AsyncSessionLocal() as db:
        initiator_user_id: str | None = None
        if slack_user_id:
            initiator_user_id = await _resolve_slack_initiator_user_id(
                slack_user_id=slack_user_id, slack_team_id=team_id, db=db
            )

        # Upsert rca_sessions row with channel_refs, org_id, and
        # initiator_user_id — previously these last two were never included
        # in the INSERT at all, so Slack-created sessions silently had no
        # org scoping and no resolvable initiator even when a link existed
        # (see docs/harness-risk-review.md, F1).
        await db.execute(
            text("""
                INSERT INTO rca_sessions
                    (id, type, status, auth_mode, initiator_channel,
                     initiator_user_id, org_id, channel_refs, created_at, updated_at)
                VALUES
                    (:id, :type, 'pending', 'service_account', 'slack',
                     :initiator_user_id, :org_id, :channel_refs::jsonb, :now, :now)
                ON CONFLICT (id) DO UPDATE
                    SET channel_refs = EXCLUDED.channel_refs,
                        initiator_user_id = EXCLUDED.initiator_user_id,
                        org_id = EXCLUDED.org_id,
                        updated_at = EXCLUDED.updated_at
            """),
            {
                "id": session_id,
                "type": session_type,
                "initiator_user_id": initiator_user_id,
                "org_id": org_id,
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
