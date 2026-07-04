"""Helpers for building and parsing Slack channel references stored in
``rca_sessions.channel_refs`` JSONB.

A ``channel_refs`` value is a list of channel-reference dicts, one per
notified channel/thread.  Currently only ``"slack"`` refs are produced by
this module; the schema is open to future additions (e.g. ``"teams"``).

Schema of a Slack channel ref::

    {
        "type": "slack",
        "channel": "C01234567",      # Slack channel ID
        "thread_ts": "1234567.890",  # Thread timestamp (None for top-level)
        "team_id": "T01234567"       # Slack workspace ID
    }
"""

from __future__ import annotations

from typing import Any


def build_slack_ref(
    channel: str,
    thread_ts: str | None,
    team_id: str,
) -> dict[str, Any]:
    """Return a Slack channel-reference dict for storage in ``channel_refs``.

    Args:
        channel: Slack channel ID.
        thread_ts: Thread timestamp, or ``None`` for top-level messages.
        team_id: Slack workspace/team ID.

    Returns:
        A channel reference dict with ``type="slack"``.
    """
    return {
        "type": "slack",
        "channel": channel,
        "thread_ts": thread_ts,
        "team_id": team_id,
    }


def parse_slack_refs(channel_refs: list[dict[str, Any]] | None) -> list[dict[str, Any]]:
    """Filter and return only the Slack-type refs from *channel_refs*.

    Args:
        channel_refs: Raw ``channel_refs`` value from the database
            (may be ``None`` or an empty list).

    Returns:
        List of Slack channel reference dicts (may be empty).
    """
    if not channel_refs:
        return []
    return [ref for ref in channel_refs if ref.get("type") == "slack"]


def merge_ref(
    existing: list[dict[str, Any]] | None,
    new_ref: dict[str, Any],
) -> list[dict[str, Any]]:
    """Return *existing* with *new_ref* appended (deduped by channel+thread_ts).

    Args:
        existing: Current ``channel_refs`` list from the database.
        new_ref: New channel reference to add.

    Returns:
        Updated list with *new_ref* included at most once.
    """
    refs = list(existing or [])
    # Deduplicate by (type, channel, thread_ts)
    key = (new_ref.get("type"), new_ref.get("channel"), new_ref.get("thread_ts"))
    for ref in refs:
        if (ref.get("type"), ref.get("channel"), ref.get("thread_ts")) == key:
            return refs  # already present
    refs.append(new_ref)
    return refs
