"""Context compaction — summarises old turns to stay within the model context window."""

from __future__ import annotations

import asyncio
from dataclasses import dataclass, field
from typing import Any

import structlog

from harness.llm.provider import LLMConfig, LLMProvider, Message, StopReason

logger = structlog.get_logger()

# Conservative token estimate: 4 characters ≈ 1 token
_CHARS_PER_TOKEN = 4

_COMPACTION_SUMMARY_PROMPT = """\
You are summarising an investigation transcript to free up context space.
Produce a concise summary that preserves all key findings, tool results, and conclusions.
Focus on evidence and decisions — not on the conversation mechanics.
Do NOT include tool call syntax or formatting.
"""


@dataclass
class CompactionResult:
    """Result of a compaction operation.

    Attributes:
        messages: Compacted message list.
        summary: Text of the summary block inserted (empty if no compaction).
        turns_compacted: Number of older turns that were replaced.
        tokens_saved: Estimated tokens saved.
        compaction_triggered: True if compaction actually ran.
    """

    messages: list[Message]
    summary: str = ""
    turns_compacted: int = 0
    tokens_saved: int = 0
    compaction_triggered: bool = False


def _estimate_tokens(messages: list[Message]) -> int:
    """Estimate total token count for a message list.

    Uses the rough heuristic: 4 characters ≈ 1 token.

    Args:
        messages: List of messages.

    Returns:
        Estimated token count.
    """
    total_chars = sum(len(m.content) for m in messages)
    # Add overhead for tool calls
    for m in messages:
        for tc in m.tool_calls:
            total_chars += len(str(tc.args)) + len(tc.name)
    return max(1, total_chars // _CHARS_PER_TOKEN)


class ContextCompactor:
    """Summarises older turns when the transcript exceeds a token threshold.

    Compaction is triggered when the estimated token count of the full message
    list exceeds ``threshold_ratio × model_context_limit``.

    Protected messages (never compacted):
    - The system prompt (first message with role=``system``)
    - The last ``pinned_last_turns`` non-system messages
    - Any message tagged with ``metadata.pinned=True``

    Args:
        threshold_ratio: Fraction of the context limit at which compaction fires.
        pinned_last_turns: Number of most-recent turns to always keep verbatim.
        provider: LLMProvider used to generate the summary.
            If None, a simple concatenation is used instead of an LLM call.
    """

    def __init__(
        self,
        threshold_ratio: float = 0.6,
        pinned_last_turns: int = 5,
        provider: LLMProvider | None = None,
    ) -> None:
        self._threshold_ratio = threshold_ratio
        self._pinned_last = pinned_last_turns
        self._provider = provider

    async def compact_if_needed(
        self,
        messages: list[Message],
        model_context_limit: int,
        session_id: str = "",
    ) -> CompactionResult:
        """Compact the message list if it exceeds the threshold.

        Args:
            messages: Current message list.
            model_context_limit: Model's total context window in tokens.
            session_id: Owning session (for logging and drill-down storage).

        Returns:
            CompactionResult — unchanged if below threshold.
        """
        threshold_tokens = int(model_context_limit * self._threshold_ratio)
        current_tokens = _estimate_tokens(messages)

        if current_tokens <= threshold_tokens:
            return CompactionResult(messages=list(messages), compaction_triggered=False)

        log = logger.bind(session_id=session_id)
        log.info(
            "compaction_triggered",
            current_tokens=current_tokens,
            threshold_tokens=threshold_tokens,
        )

        # Partition messages
        system_msgs = [m for m in messages if m.role == "system" and not _is_summary(m)]
        pinned_msgs = [m for m in messages if _is_pinned(m) and m.role != "system"]
        non_system = [m for m in messages if m.role != "system"]

        # Protect last N turns
        protected_tail = non_system[-self._pinned_last :] if len(non_system) > self._pinned_last else non_system
        compactable = [
            m for m in non_system[: -self._pinned_last]
            if m not in pinned_msgs and not _is_summary(m)
        ] if len(non_system) > self._pinned_last else []

        if not compactable:
            return CompactionResult(messages=list(messages), compaction_triggered=False)

        # Generate summary
        summary_text = await self._summarise(compactable)
        tokens_before = _estimate_tokens(compactable)

        # Build summary message
        summary_msg = Message(
            role="system",
            content=f"[INVESTIGATION SUMMARY — earlier turns compacted]\n{summary_text}",
        )
        # Mark as pinned summary so we don't double-compact
        summary_msg.__dict__["_is_summary"] = True

        # Reconstruct message list: system + summary + pinned + tail
        new_messages = (
            system_msgs
            + [summary_msg]
            + pinned_msgs
            + protected_tail
        )

        tokens_after = _estimate_tokens(new_messages)
        tokens_saved = max(0, tokens_before - _estimate_tokens([summary_msg]))

        log.info(
            "compaction_done",
            turns_compacted=len(compactable),
            tokens_saved=tokens_saved,
            new_token_estimate=tokens_after,
        )

        # Record metric
        try:
            from harness.observability.otel import COMPACTIONS_TOTAL
            COMPACTIONS_TOTAL.add(1, {"session_id": session_id})
        except Exception:
            pass

        return CompactionResult(
            messages=new_messages,
            summary=summary_text,
            turns_compacted=len(compactable),
            tokens_saved=tokens_saved,
            compaction_triggered=True,
        )

    async def _summarise(self, messages: list[Message]) -> str:
        """Generate a summary of the given messages.

        Args:
            messages: Messages to summarise.

        Returns:
            Summary text string.
        """
        if self._provider is None:
            # Fallback: concatenate content
            parts = []
            for msg in messages:
                if msg.content:
                    parts.append(f"[{msg.role.upper()}] {msg.content[:500]}")
            return "\n".join(parts)

        # Use LLM to produce a better summary
        config = LLMConfig(model="claude-haiku-4-5", max_tokens=1024, temperature=0.0)
        content = "\n\n".join(
            f"[{m.role.upper()}]: {m.content}" for m in messages if m.content
        )
        summary_messages = [
            Message(role="system", content=_COMPACTION_SUMMARY_PROMPT),
            Message(role="user", content=f"Transcript to summarise:\n\n{content}"),
        ]
        try:
            turn = await self._provider.complete(summary_messages, tools=None, config=config)
            return turn.content
        except Exception as exc:
            logger.warning("compaction_summary_failed", error=str(exc))
            return "\n".join(m.content[:200] for m in messages if m.content)


def _is_pinned(msg: Message) -> bool:
    """Return True if the message has been explicitly pinned."""
    return bool(msg.__dict__.get("_pinned") or getattr(msg, "_pinned", False))


def _is_summary(msg: Message) -> bool:
    """Return True if the message is a compaction summary block."""
    return bool(
        msg.__dict__.get("_is_summary")
        or (msg.role == "system" and msg.content.startswith("[INVESTIGATION SUMMARY"))
    )
