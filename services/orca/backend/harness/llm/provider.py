"""LLM Provider protocol — vendor-agnostic interface for all LLM calls.

All harness graph nodes call this protocol; never vendor SDKs directly.
This decouples the agent logic from any specific LLM provider and enables:
- Deterministic testing via FakeProvider
- Vendor swap with a single config change
- Consistent token accounting and error handling

Provider selection: ``make_provider(settings)`` factory function reads
``LLM_PROVIDER`` from settings (``anthropic`` | ``openai_compat``).
FakeProvider is only used in tests.
"""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from enum import Enum
from typing import Any, Protocol, runtime_checkable


# ---------------------------------------------------------------------------
# Data model
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class ToolSpec:
    """Description of a tool exposed to the LLM.

    Attributes:
        name: Tool name as it appears in tool calls.
        description: Human-readable description for the model.
        input_schema: JSON Schema dict describing the tool's input.
    """

    name: str
    description: str
    input_schema: dict[str, Any]


@dataclass(frozen=True)
class ToolCall:
    """A single tool call emitted by the model.

    Attributes:
        id: Unique identifier for this tool call (from the model response).
        name: Name of the tool to invoke.
        args: Arguments dict for the tool.
    """

    id: str
    name: str
    args: dict[str, Any]


@dataclass(frozen=True)
class TokenUsage:
    """Token counts reported by the provider.

    Attributes:
        input: Number of tokens in the prompt/context.
        output: Number of tokens in the completion.
        total: Sum of input + output.
    """

    input: int
    output: int
    total: int


class StopReason(str, Enum):
    """Why the model stopped generating.

    Values:
        END_TURN: Model decided to stop (natural end).
        TOOL_USE: Model wants to call a tool.
        MAX_TOKENS: Output token limit reached.
        ERROR: Provider returned an error mid-generation.
    """

    END_TURN = "end_turn"
    TOOL_USE = "tool_use"
    MAX_TOKENS = "max_tokens"
    ERROR = "error"


@dataclass
class Message:
    """A single message in the conversation.

    Attributes:
        role: ``system`` | ``user`` | ``assistant`` | ``tool``
        content: Text content of the message (may be empty for tool-use turns).
        tool_calls: Tool calls emitted by the assistant (role=``assistant`` only).
        tool_call_id: ID of the tool call this message responds to (role=``tool`` only).
        name: Tool name for tool-result messages (role=``tool`` only).
    """

    role: str
    content: str
    tool_calls: list[ToolCall] = field(default_factory=list)
    tool_call_id: str | None = None
    name: str | None = None


@dataclass
class Turn:
    """The result of a single LLM completion call.

    Attributes:
        content: Text content of the response (may be empty if tool_calls present).
        tool_calls: Tool calls requested by the model.
        usage: Token counts for this turn.
        stop_reason: Why the model stopped.
        raw: Raw provider response object (for debugging; not serialised).
    """

    content: str
    tool_calls: list[ToolCall]
    usage: TokenUsage
    stop_reason: StopReason
    raw: Any = field(default=None, compare=False, repr=False)


@dataclass(frozen=True)
class LLMConfig:
    """Per-call configuration for the LLM.

    Attributes:
        model: Model identifier string (e.g. ``claude-sonnet-4-5``).
        max_tokens: Maximum tokens in the completion.
        temperature: Sampling temperature (0.0 = deterministic).
        streaming: Whether to use streaming mode (provider must support it).
    """

    model: str
    max_tokens: int = 4096
    temperature: float = 0.0
    streaming: bool = False


# ---------------------------------------------------------------------------
# Error taxonomy
# ---------------------------------------------------------------------------


class LLMError(Exception):
    """Base class for all LLM provider errors."""


class RateLimited(LLMError):
    """Provider is rate-limiting this request.

    Attributes:
        retry_after: Suggested seconds to wait before retrying, or None.
    """

    def __init__(self, message: str = "Rate limited", retry_after: float | None = None) -> None:
        super().__init__(message)
        self.retry_after = retry_after


class ProviderUnavailable(LLMError):
    """Provider is temporarily unavailable (5xx, network error)."""


class ContextTooLong(LLMError):
    """The input context exceeds the model's context window.

    Attributes:
        token_count: Estimated token count of the input.
        limit: Model's context window limit in tokens.
    """

    def __init__(self, message: str, token_count: int, limit: int) -> None:
        super().__init__(message)
        self.token_count = token_count
        self.limit = limit


class InvalidRequest(LLMError):
    """The request is malformed (bad tool schema, invalid model name, etc.).

    Attributes:
        detail: Provider's error message.
    """

    def __init__(self, message: str, detail: str = "") -> None:
        super().__init__(message)
        self.detail = detail


# ---------------------------------------------------------------------------
# Protocol
# ---------------------------------------------------------------------------


@runtime_checkable
class LLMProvider(Protocol):
    """Vendor-agnostic interface for LLM completions.

    All harness graph nodes must call this protocol rather than any vendor
    SDK directly.  The only exception is the existing ``app/agent/rca_graph.py``
    which continues to use ``ChatAnthropic`` directly until Phase 4 retirement.
    """

    async def complete(
        self,
        messages: list[Message],
        tools: list[ToolSpec] | None,
        config: LLMConfig,
    ) -> Turn:
        """Execute a single completion and return a normalised Turn.

        Args:
            messages: Conversation history (system + user + assistant turns).
            tools: Tools to make available to the model, or None for text-only.
            config: Per-call configuration (model, max_tokens, etc.).

        Returns:
            Normalised Turn with content, tool_calls, usage, and stop_reason.

        Raises:
            RateLimited: Provider is rate-limiting.
            ProviderUnavailable: Provider returned a 5xx or network error.
            ContextTooLong: Input exceeds the model's context window.
            InvalidRequest: Malformed request (bad schema, unknown model, etc.).
        """
        ...  # pragma: no cover


# ---------------------------------------------------------------------------
# Factory
# ---------------------------------------------------------------------------


def make_provider(settings: Any) -> "LLMProvider":
    """Construct an LLMProvider from application settings.

    Reads ``LLM_PROVIDER`` from settings to select the implementation.
    FakeProvider is never returned here — it is constructed directly in tests.

    Args:
        settings: Application settings object (from ``app.config``).

    Returns:
        Configured LLMProvider instance.

    Raises:
        ValueError: If ``LLM_PROVIDER`` is not a known value.
    """
    provider = getattr(settings, "LLM_PROVIDER", "anthropic")

    if provider == "anthropic":
        from harness.llm.anthropic import AnthropicProvider
        return AnthropicProvider(
            api_key=settings.ANTHROPIC_API_KEY,
            default_model=getattr(settings, "LLM_MODEL", "claude-sonnet-4-5"),
        )
    elif provider == "openai_compat":
        from harness.llm.openai_compat import OpenAICompatProvider
        return OpenAICompatProvider(
            api_key=getattr(settings, "OPENAI_API_KEY", ""),
            base_url=getattr(settings, "OPENAI_BASE_URL", ""),
            default_model=getattr(settings, "LLM_MODEL", "gpt-4o"),
        )
    else:
        raise ValueError(
            f"Unknown LLM_PROVIDER: {provider!r}. "
            "Valid values: 'anthropic', 'openai_compat'."
        )
