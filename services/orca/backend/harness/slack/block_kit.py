"""Block Kit message builders for the Slack observability agent.

All functions return a ``list[dict]`` suitable for the Slack ``blocks``
parameter in ``chat_postMessage`` / ``chat_update`` calls.  They are
pure functions with no side-effects so they can be tested in isolation.

Block Kit reference: https://api.slack.com/block-kit/building
"""

from __future__ import annotations

from typing import Any


def thinking_message(session_id: str, prompt_preview: str = "") -> list[dict[str, Any]]:
    """Return a "Thinking…" status Block Kit message.

    Args:
        session_id: The investigation session ID (shown in footer for traceability).
        prompt_preview: First 120 chars of the user's prompt (optional).

    Returns:
        A list of Slack Block Kit block dicts.
    """
    preview = (prompt_preview[:120] + "…") if len(prompt_preview) > 120 else prompt_preview
    blocks: list[dict[str, Any]] = [
        {
            "type": "section",
            "text": {
                "type": "mrkdwn",
                "text": ":hourglass_flowing_sand: *Thinking…*\n"
                + (f"> {preview}" if preview else ""),
            },
        },
        {
            "type": "context",
            "elements": [
                {
                    "type": "mrkdwn",
                    "text": f"Session `{session_id}`",
                }
            ],
        },
    ]
    return blocks


def tool_call_message(
    tool_name: str,
    args_preview: str,
    session_id: str,
) -> list[dict[str, Any]]:
    """Return a Block Kit message describing an in-flight tool call.

    Args:
        tool_name: Name of the tool being called (e.g. ``query_prometheus``).
        args_preview: Short string representation of the tool arguments.
        session_id: Session ID for the footer.

    Returns:
        A list of Slack Block Kit block dicts.
    """
    safe_args = (args_preview[:200] + "…") if len(args_preview) > 200 else args_preview
    return [
        {
            "type": "section",
            "text": {
                "type": "mrkdwn",
                "text": f":wrench: *Tool call:* `{tool_name}`\n```{safe_args}```",
            },
        },
        {
            "type": "context",
            "elements": [{"type": "mrkdwn", "text": f"Session `{session_id}`"}],
        },
    ]


def approval_prompt(
    tool_name: str,
    args_preview: str,
    session_id: str,
    job_id: str,
) -> list[dict[str, Any]]:
    """Return a Block Kit approval prompt with Approve / Reject action buttons.

    The button ``value`` fields carry ``session_id:job_id`` so the action
    handler can reconstruct the approval context without extra lookups.

    Args:
        tool_name: Tool that requires approval.
        args_preview: Short representation of proposed arguments.
        session_id: Session ID.
        job_id: Turn job ID to resume after approval.

    Returns:
        A list of Slack Block Kit block dicts.
    """
    safe_args = (args_preview[:200] + "…") if len(args_preview) > 200 else args_preview
    action_value = f"{session_id}:{job_id}"
    return [
        {
            "type": "section",
            "text": {
                "type": "mrkdwn",
                "text": (
                    f":warning: *Approval required*\n"
                    f"The agent wants to call *`{tool_name}`*:\n"
                    f"```{safe_args}```"
                ),
            },
        },
        {
            "type": "actions",
            "elements": [
                {
                    "type": "button",
                    "text": {"type": "plain_text", "text": "Approve"},
                    "style": "primary",
                    "action_id": "approve_tool_call",
                    "value": action_value,
                },
                {
                    "type": "button",
                    "text": {"type": "plain_text", "text": "Reject"},
                    "style": "danger",
                    "action_id": "reject_tool_call",
                    "value": action_value,
                },
            ],
        },
        {
            "type": "context",
            "elements": [{"type": "mrkdwn", "text": f"Session `{session_id}`"}],
        },
    ]


def final_answer_message(
    answer_text: str,
    session_id: str,
    confidence: str = "",
) -> list[dict[str, Any]]:
    """Return a Block Kit message with the agent's final answer.

    Args:
        answer_text: Markdown-formatted answer text.
        session_id: Session ID for the footer.
        confidence: Optional confidence level (high/medium/low).

    Returns:
        A list of Slack Block Kit block dicts.
    """
    # Slack mrkdwn has a 3000-char limit per text block; truncate gracefully.
    truncated = answer_text
    if len(truncated) > 2900:
        truncated = truncated[:2900] + "\n\n_[truncated — see full report in Graft]_"

    confidence_badge = ""
    if confidence:
        emoji = {"high": ":large_green_circle:", "medium": ":large_yellow_circle:", "low": ":red_circle:"}.get(
            confidence.lower(), ":white_circle:"
        )
        confidence_badge = f" {emoji} Confidence: *{confidence}*"

    blocks: list[dict[str, Any]] = [
        {
            "type": "section",
            "text": {
                "type": "mrkdwn",
                "text": f":white_check_mark: *Investigation complete*{confidence_badge}\n\n{truncated}",
            },
        },
        {
            "type": "context",
            "elements": [{"type": "mrkdwn", "text": f"Session `{session_id}`"}],
        },
    ]
    return blocks


def error_message(reason: str, session_id: str = "") -> list[dict[str, Any]]:
    """Return a Block Kit error message.

    Args:
        reason: Human-readable description of the error.
        session_id: Optional session ID for the footer.

    Returns:
        A list of Slack Block Kit block dicts.
    """
    blocks: list[dict[str, Any]] = [
        {
            "type": "section",
            "text": {
                "type": "mrkdwn",
                "text": f":x: *Error:* {reason}",
            },
        },
    ]
    if session_id:
        blocks.append(
            {
                "type": "context",
                "elements": [{"type": "mrkdwn", "text": f"Session `{session_id}`"}],
            }
        )
    return blocks
