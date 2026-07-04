"""FakeProvider — deterministic LLM replay for tests.

Implements the full ``LLMProvider`` protocol. Replays scripted ``TurnFixture``
entries in order, recording every prompt received for post-run assertion.

This is the Phase 1 canonical implementation.  The Phase 0 ``FakeLLM`` in
``tests/fake_provider.py`` continues to work for backward-compat with the
existing characterization tests and the legacy ``ChatAnthropic``-shaped
interface.

Usage example::

    from harness.llm.fake import FakeProvider, TurnFixture, ToolCallFixture

    provider = FakeProvider(script=[
        TurnFixture(content="Gathering evidence..."),
        TurnFixture(
            content="",
            tool_calls=[ToolCallFixture(name="query_metrics", args={"expr": "up"})],
        ),
        TurnFixture(content="Root cause: DB connection pool exhaustion."),
    ])

    turn = await provider.complete(messages, tools=None, config=cfg)
    assert turn.content == "Gathering evidence..."

    prompts = provider.recorded_prompts()  # all prompts seen so far
"""

from __future__ import annotations

import uuid
from dataclasses import dataclass, field
from typing import Any, Callable

import structlog

from harness.llm.provider import (
    LLMConfig,
    Message,
    StopReason,
    ToolCall,
    ToolSpec,
    TokenUsage,
    Turn,
)

logger = structlog.get_logger()


class FakeProviderScriptExhausted(Exception):
    """Raised when FakeProvider.complete() is called after the script runs out.

    Never silently falls back to an empty response — exhaustion always means
    the test script needs an extra entry.
    """


@dataclass
class ToolCallFixture:
    """A tool call to include in a scripted FakeProvider response.

    Attributes:
        name: Tool name.
        args: Arguments dict.
        id: Tool call ID; auto-generated if empty.
    """

    name: str
    args: dict[str, Any] = field(default_factory=dict)
    id: str = ""

    def __post_init__(self) -> None:
        if not self.id:
            self.id = str(uuid.uuid4())


@dataclass
class TurnFixture:
    """A scripted response to emit from FakeProvider.

    Can also be a callable ``(messages) -> TurnFixture`` for dynamic responses.

    Attributes:
        content: Text content of the response.
        tool_calls: Tool calls to include (triggers TOOL_USE stop reason).
        input_tokens: Reported input token count.
        output_tokens: Reported output token count.
        stop_reason: Override stop reason (inferred from tool_calls if not set).
    """

    content: str = ""
    tool_calls: list[ToolCallFixture] = field(default_factory=list)
    input_tokens: int = 50
    output_tokens: int = 50
    stop_reason: StopReason | None = None


# A script entry is either a TurnFixture or a callable that takes the
# incoming messages and returns a TurnFixture (for dynamic responses).
ScriptEntry = TurnFixture | Callable[[list[Message]], TurnFixture]


class FakeProvider:
    """Deterministic LLM provider that replays a scripted sequence of turns.

    Fully implements the ``LLMProvider`` protocol.  All calls are synchronous
    internally (no real I/O); they are only ``async`` to satisfy the protocol.

    Args:
        script: Ordered list of ``TurnFixture`` (or callables) to replay.
        provider_shape: ``"anthropic"`` or ``"openai"`` — controls how the
            response is shaped for swap-test assertions.
    """

    def __init__(
        self,
        script: list[ScriptEntry],
        provider_shape: str = "anthropic",
    ) -> None:
        self._script = list(script)
        self._index = 0
        self._recorded: list[list[Message]] = []
        self._provider_shape = provider_shape

    async def complete(
        self,
        messages: list[Message],
        tools: list[ToolSpec] | None,
        config: LLMConfig,
    ) -> Turn:
        """Return the next scripted turn and record the prompt.

        Args:
            messages: Conversation history (recorded verbatim).
            tools: Available tools (recorded but not used in scripted response).
            config: LLM configuration (recorded but not used).

        Returns:
            Turn built from the next script entry.

        Raises:
            FakeProviderScriptExhausted: When the script is empty.
        """
        self._recorded.append(list(messages))

        if self._index >= len(self._script):
            raise FakeProviderScriptExhausted(
                f"FakeProvider script exhausted after {self._index} calls. "
                f"Add a TurnFixture entry for call #{self._index + 1}."
            )

        entry = self._script[self._index]
        self._index += 1

        # Resolve callable entries
        fixture: TurnFixture
        if callable(entry):
            fixture = entry(messages)
        else:
            fixture = entry

        # Build tool calls
        tool_calls = [
            ToolCall(id=tc.id, name=tc.name, args=tc.args)
            for tc in fixture.tool_calls
        ]

        # Infer stop reason
        if fixture.stop_reason is not None:
            stop_reason = fixture.stop_reason
        elif tool_calls:
            stop_reason = StopReason.TOOL_USE
        else:
            stop_reason = StopReason.END_TURN

        usage = TokenUsage(
            input=fixture.input_tokens,
            output=fixture.output_tokens,
            total=fixture.input_tokens + fixture.output_tokens,
        )

        return Turn(
            content=fixture.content,
            tool_calls=tool_calls,
            usage=usage,
            stop_reason=stop_reason,
            raw={"provider_shape": self._provider_shape, "script_index": self._index - 1},
        )

    # ── Inspection helpers ────────────────────────────────────────────────────

    def recorded_prompts(self) -> list[list[Message]]:
        """Return a copy of all prompts recorded so far.

        Returns:
            List of message-lists, one per ``complete()`` call made.
        """
        return [list(p) for p in self._recorded]

    def recorded_prompt_texts(self) -> list[list[str]]:
        """Return the content strings of all recorded prompts (for assertion).

        Returns:
            List of (list of message content strings), one per call.
        """
        return [
            [m.content for m in prompt]
            for prompt in self._recorded
        ]

    def remaining(self) -> int:
        """Return the number of script entries not yet consumed.

        Returns:
            Count of remaining turns.
        """
        return len(self._script) - self._index

    def reset(self) -> None:
        """Reset the replay index and clear recorded prompts.

        Allows re-using the same script across multiple test invocations.
        """
        self._index = 0
        self._recorded = []

    def all_prompt_content(self) -> str:
        """Return all recorded prompt content as a single concatenated string.

        Useful for red-team assertions (search for forbidden strings).

        Returns:
            All message content joined with newlines.
        """
        parts: list[str] = []
        for prompt in self._recorded:
            for msg in prompt:
                parts.append(msg.content)
        return "\n".join(parts)
