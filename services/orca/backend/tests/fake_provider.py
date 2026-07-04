"""FakeProvider — deterministic LLM replay for tests and characterization.

Replays scripted responses in order, recording all prompts received.
Used in all harness tests where no real LLM calls should be made.

This is the Phase 0 preliminary version; it mimics the ChatAnthropic
interface (ainvoke / ainvoke with tool_calls) used by the existing RCA graphs.
Phase 1 Task 1.1 will replace this with the full LLMProvider protocol.
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from typing import Any
from unittest.mock import MagicMock


@dataclass
class FakeToolCall:
    """A scripted tool call to emit from a fake LLM response.

    Attributes:
        name: Tool name.
        args: Tool arguments dict.
        id: Tool call ID (auto-generated if not provided).
    """

    name: str
    args: dict[str, Any]
    id: str = ""

    def __post_init__(self) -> None:
        if not self.id:
            import uuid
            self.id = str(uuid.uuid4())


@dataclass
class FakeTurn:
    """A scripted response entry for FakeProvider.

    Attributes:
        content: Text content of the response.
        tool_calls: List of tool calls to include in the response.
        usage_tokens: Token count to report (default 100).
    """

    content: str = ""
    tool_calls: list[FakeToolCall] = field(default_factory=list)
    usage_tokens: int = 100


class FakeProviderScriptExhausted(Exception):
    """Raised when FakeProvider has no more scripted responses."""


class FakeLLM:
    """Deterministic LLM that replays a scripted sequence of responses.

    Mimics the ``ChatAnthropic`` interface (``ainvoke``) so it can be
    substituted via ``unittest.mock.patch`` in tests.

    Args:
        script: Ordered list of FakeTurn responses to replay.
    """

    def __init__(self, script: list[FakeTurn]) -> None:
        self._script = list(script)
        self._index = 0
        self._recorded_prompts: list[list[Any]] = []

    def bind_tools(self, tools: list[Any]) -> "FakeLLM":
        """Return self — tools are ignored in the fake (already scripted).

        Args:
            tools: Ignored.

        Returns:
            self, so the pattern ``llm.bind_tools(tools).ainvoke(...)`` works.
        """
        return self

    async def ainvoke(self, messages: list[Any], **kwargs: Any) -> MagicMock:
        """Return the next scripted response.

        Records the prompt for later assertion.

        Args:
            messages: List of messages sent to the LLM (recorded).
            **kwargs: Ignored.

        Returns:
            MagicMock mimicking a ChatAnthropic response object.

        Raises:
            FakeProviderScriptExhausted: If the script has run out.
        """
        self._recorded_prompts.append(list(messages))

        if self._index >= len(self._script):
            raise FakeProviderScriptExhausted(
                f"FakeProvider script exhausted after {self._index} calls. "
                "Add more FakeTurn entries to the script."
            )

        turn = self._script[self._index]
        self._index += 1

        # Build a mock that looks like a LangChain AIMessage / ChatAnthropic response
        mock = MagicMock()
        mock.content = turn.content
        mock.tool_calls = [
            {
                "name": tc.name,
                "args": tc.args,
                "id": tc.id,
            }
            for tc in turn.tool_calls
        ]
        mock.usage_metadata = {"total_tokens": turn.usage_tokens}
        return mock

    def recorded_prompts(self) -> list[list[Any]]:
        """Return all prompts recorded during the test run.

        Returns:
            List of message lists, one per ``ainvoke`` call.
        """
        return list(self._recorded_prompts)

    def remaining(self) -> int:
        """Return the number of scripted turns not yet consumed.

        Returns:
            Count of remaining turns.
        """
        return len(self._script) - self._index

    def reset(self) -> None:
        """Reset the replay index and recorded prompts (re-use the same script)."""
        self._index = 0
        self._recorded_prompts = []
