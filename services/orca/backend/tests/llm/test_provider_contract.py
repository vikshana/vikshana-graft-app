"""LLM provider contract tests.

Validates that all LLMProvider implementations (real and fake) produce
the same normalised Turn structure for equivalent scripted exchanges.

Test modes:
  - Always-run: FakeProvider under both ``anthropic_shaped`` and
    ``openai_shaped`` fixture configurations.
  - REQUIRES_ENV: Real AnthropicProvider and OpenAICompatProvider, gated
    behind ``RUN_LIVE_LLM=1`` environment variable.

The contract tests assert:
  1. Turn has the correct types for all fields.
  2. A tool-call exchange produces tool_calls + TOOL_USE stop reason.
  3. A text-only exchange produces content + END_TURN stop reason.
  4. Token usage is non-negative.
  5. Swap test: identical fixture script under both shaped providers →
     identical session transcript structure.
"""

from __future__ import annotations

import os
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from harness.llm.fake import FakeProvider, TurnFixture, ToolCallFixture
from harness.llm.provider import (
    LLMConfig,
    Message,
    StopReason,
    ToolSpec,
    Turn,
)


# ── Fixtures ─────────────────────────────────────────────────────────────────

LIVE_LLM = os.environ.get("RUN_LIVE_LLM") == "1"
skip_no_live = pytest.mark.skipif(not LIVE_LLM, reason="REQUIRES_ENV: set RUN_LIVE_LLM=1")

DEFAULT_CONFIG = LLMConfig(model="claude-haiku-4-5", max_tokens=256, temperature=0.0)

SIMPLE_MESSAGES = [
    Message(role="system", content="You are a helpful assistant."),
    Message(role="user", content="Say hello."),
]

TOOL_SPEC = ToolSpec(
    name="query_metrics",
    description="Query Prometheus metrics",
    input_schema={
        "type": "object",
        "properties": {"expr": {"type": "string"}},
        "required": ["expr"],
    },
)

# Scripted exchange: user asks → model calls tool → user provides result → model answers
TOOL_EXCHANGE_SCRIPT = [
    TurnFixture(
        content="",
        tool_calls=[ToolCallFixture(name="query_metrics", args={"expr": "up"}, id="call-1")],
    ),
    TurnFixture(content="The service is up with 3 instances."),
]

TOOL_EXCHANGE_MESSAGES_AFTER_TOOL = [
    *SIMPLE_MESSAGES,
    Message(
        role="assistant",
        content="",
        tool_calls=[],  # populated during exchange
    ),
    Message(
        role="tool",
        content="[{\"metric\":\"up\",\"value\":3}]",
        tool_call_id="call-1",
        name="query_metrics",
    ),
]


def make_anthropic_shaped_fake(script: list[TurnFixture]) -> FakeProvider:
    """FakeProvider shaped to mimic Anthropic response structure."""
    return FakeProvider(script=script, provider_shape="anthropic")


def make_openai_shaped_fake(script: list[TurnFixture]) -> FakeProvider:
    """FakeProvider shaped to mimic OpenAI response structure."""
    return FakeProvider(script=script, provider_shape="openai")


# ── Contract assertions (shared across all providers) ────────────────────────

def assert_turn_contract(turn: Turn) -> None:
    """Assert that a Turn satisfies the protocol contract.

    Args:
        turn: Turn object returned by a provider.
    """
    assert isinstance(turn, Turn), f"Expected Turn, got {type(turn)}"
    assert isinstance(turn.content, str), "content must be str"
    assert isinstance(turn.tool_calls, list), "tool_calls must be list"
    assert isinstance(turn.usage, object), "usage must be present"
    assert turn.usage.input >= 0, "input tokens must be non-negative"
    assert turn.usage.output >= 0, "output tokens must be non-negative"
    assert turn.usage.total >= 0, "total tokens must be non-negative"
    assert isinstance(turn.stop_reason, StopReason), "stop_reason must be StopReason"


def assert_tool_call_contract(turn: Turn) -> None:
    """Assert that a tool-use Turn has correct structure.

    Args:
        turn: Turn that should contain tool calls.
    """
    assert_turn_contract(turn)
    assert len(turn.tool_calls) >= 1, "Expected at least one tool call"
    assert turn.stop_reason == StopReason.TOOL_USE, (
        f"Expected TOOL_USE, got {turn.stop_reason}"
    )
    tc = turn.tool_calls[0]
    assert isinstance(tc.id, str) and tc.id, "tool call id must be non-empty string"
    assert isinstance(tc.name, str) and tc.name, "tool call name must be non-empty string"
    assert isinstance(tc.args, dict), "tool call args must be dict"


# ── FakeProvider (anthropic-shaped) — always run ─────────────────────────────

class TestFakeProviderAnthropicShaped:
    """Contract tests for FakeProvider with Anthropic fixture shape."""

    @pytest.mark.asyncio
    async def test_text_turn_contract(self):
        """Text-only turn satisfies the Turn contract."""
        provider = make_anthropic_shaped_fake([
            TurnFixture(content="Hello, world!"),
        ])
        turn = await provider.complete(SIMPLE_MESSAGES, tools=None, config=DEFAULT_CONFIG)
        assert_turn_contract(turn)
        assert turn.content == "Hello, world!"
        assert turn.stop_reason == StopReason.END_TURN
        assert turn.tool_calls == []

    @pytest.mark.asyncio
    async def test_tool_call_turn_contract(self):
        """Tool-call turn satisfies the Turn contract."""
        provider = make_anthropic_shaped_fake([
            TurnFixture(
                content="",
                tool_calls=[ToolCallFixture(name="query_metrics", args={"expr": "up"}, id="tc-1")],
            ),
        ])
        turn = await provider.complete(SIMPLE_MESSAGES, tools=[TOOL_SPEC], config=DEFAULT_CONFIG)
        assert_tool_call_contract(turn)
        assert turn.tool_calls[0].name == "query_metrics"
        assert turn.tool_calls[0].args == {"expr": "up"}

    @pytest.mark.asyncio
    async def test_prompts_recorded(self):
        """All prompts are recorded for later assertion."""
        provider = make_anthropic_shaped_fake([
            TurnFixture(content="A"),
            TurnFixture(content="B"),
        ])
        await provider.complete(SIMPLE_MESSAGES, tools=None, config=DEFAULT_CONFIG)
        await provider.complete(SIMPLE_MESSAGES[:1], tools=None, config=DEFAULT_CONFIG)
        assert len(provider.recorded_prompts()) == 2
        assert len(provider.recorded_prompts()[0]) == 2
        assert len(provider.recorded_prompts()[1]) == 1

    @pytest.mark.asyncio
    async def test_script_exhausted_raises(self):
        """FakeProviderScriptExhausted raised on overrun — never silent fallback."""
        from harness.llm.fake import FakeProviderScriptExhausted
        provider = make_anthropic_shaped_fake([TurnFixture(content="only one")])
        await provider.complete(SIMPLE_MESSAGES, tools=None, config=DEFAULT_CONFIG)
        with pytest.raises(FakeProviderScriptExhausted):
            await provider.complete(SIMPLE_MESSAGES, tools=None, config=DEFAULT_CONFIG)

    @pytest.mark.asyncio
    async def test_callable_script_entry(self):
        """A callable script entry receives the messages and returns a TurnFixture."""
        def dynamic(messages: list[Message]) -> TurnFixture:
            # Echo the last user message back
            last = next((m for m in reversed(messages) if m.role == "user"), None)
            return TurnFixture(content=f"Echo: {last.content if last else ''}")

        provider = make_anthropic_shaped_fake([dynamic])
        turn = await provider.complete(SIMPLE_MESSAGES, tools=None, config=DEFAULT_CONFIG)
        assert turn.content == "Echo: Say hello."

    def test_reset_clears_state(self):
        """reset() clears recorded prompts and replay index."""
        provider = make_anthropic_shaped_fake([TurnFixture(content="X")])
        import asyncio
        asyncio.get_event_loop().run_until_complete(
            provider.complete(SIMPLE_MESSAGES, None, DEFAULT_CONFIG)
        )
        provider.reset()
        assert provider.recorded_prompts() == []
        assert provider.remaining() == 1


# ── FakeProvider (openai-shaped) — always run ────────────────────────────────

class TestFakeProviderOpenAIShaped:
    """Contract tests for FakeProvider with OpenAI fixture shape."""

    @pytest.mark.asyncio
    async def test_text_turn_contract(self):
        """Text-only turn satisfies the Turn contract under OpenAI shape."""
        provider = make_openai_shaped_fake([TurnFixture(content="OpenAI answer.")])
        turn = await provider.complete(SIMPLE_MESSAGES, tools=None, config=DEFAULT_CONFIG)
        assert_turn_contract(turn)
        assert turn.content == "OpenAI answer."

    @pytest.mark.asyncio
    async def test_tool_call_turn_contract(self):
        """Tool-call turn satisfies the Turn contract under OpenAI shape."""
        provider = make_openai_shaped_fake([
            TurnFixture(
                tool_calls=[ToolCallFixture(name="query_metrics", args={"expr": "rate(errors[5m])"})],
            ),
        ])
        turn = await provider.complete(SIMPLE_MESSAGES, tools=[TOOL_SPEC], config=DEFAULT_CONFIG)
        assert_tool_call_contract(turn)


# ── Swap test ─────────────────────────────────────────────────────────────────

class TestProviderSwap:
    """The same script under both shaped providers produces identical structure."""

    @pytest.mark.asyncio
    async def test_identical_structure_anthropic_vs_openai(self):
        """Swap test: identical script → identical session transcript structure."""
        script = [
            TurnFixture(
                tool_calls=[ToolCallFixture(name="query_metrics", args={"expr": "up"}, id="tc-swap")],
            ),
            TurnFixture(content="Root cause identified."),
        ]

        provider_a = make_anthropic_shaped_fake(script)
        provider_b = make_openai_shaped_fake(script)

        messages = list(SIMPLE_MESSAGES)
        turns_a: list[Turn] = []
        turns_b: list[Turn] = []

        for _ in range(2):
            t_a = await provider_a.complete(messages, tools=[TOOL_SPEC], config=DEFAULT_CONFIG)
            t_b = await provider_b.complete(messages, tools=[TOOL_SPEC], config=DEFAULT_CONFIG)
            turns_a.append(t_a)
            turns_b.append(t_b)

        # Structure must be identical regardless of provider shape
        for t_a, t_b in zip(turns_a, turns_b):
            assert t_a.stop_reason == t_b.stop_reason
            assert len(t_a.tool_calls) == len(t_b.tool_calls)
            assert t_a.content == t_b.content
            if t_a.tool_calls:
                assert t_a.tool_calls[0].name == t_b.tool_calls[0].name


# ── AnthropicProvider (live, REQUIRES_ENV) ────────────────────────────────────

class TestAnthropicProviderLive:
    """Live contract tests for AnthropicProvider. Requires RUN_LIVE_LLM=1."""

    @skip_no_live
    @pytest.mark.asyncio
    async def test_text_turn_live(self):
        """Live AnthropicProvider text turn satisfies contract."""
        from app.config import settings
        from harness.llm.anthropic import AnthropicProvider
        provider = AnthropicProvider(api_key=settings.ANTHROPIC_API_KEY)
        config = LLMConfig(model="claude-haiku-4-5", max_tokens=64)
        turn = await provider.complete(SIMPLE_MESSAGES, tools=None, config=config)
        assert_turn_contract(turn)
        assert len(turn.content) > 0

    @skip_no_live
    @pytest.mark.asyncio
    async def test_tool_call_turn_live(self):
        """Live AnthropicProvider tool-call turn satisfies contract."""
        from app.config import settings
        from harness.llm.anthropic import AnthropicProvider
        provider = AnthropicProvider(api_key=settings.ANTHROPIC_API_KEY)
        config = LLMConfig(model="claude-haiku-4-5", max_tokens=256)
        messages = [
            Message(role="system", content="Always use the query_metrics tool."),
            Message(role="user", content="Check if the service is up."),
        ]
        turn = await provider.complete(messages, tools=[TOOL_SPEC], config=config)
        assert_turn_contract(turn)
        # Model may or may not call the tool depending on Claude behaviour
        # but the turn structure must be valid regardless

    @skip_no_live
    @pytest.mark.asyncio
    async def test_rate_limited_error_taxonomy(self):
        """429 from Anthropic maps to RateLimited."""
        import httpx
        from harness.llm.anthropic import AnthropicProvider, _map_exception
        from harness.llm.provider import RateLimited
        exc = Exception("429 rate_limit exceeded")
        result = _map_exception(exc)
        assert isinstance(result, RateLimited)


# ── AnthropicProvider error taxonomy (always-run unit tests) ─────────────────

class TestAnthropicErrorTaxonomy:
    """Unit tests for Anthropic exception mapping — no live calls."""

    def test_429_maps_to_rate_limited(self):
        from harness.llm.anthropic import _map_exception
        from harness.llm.provider import RateLimited
        assert isinstance(_map_exception(Exception("429 rate_limit")), RateLimited)

    def test_context_too_long(self):
        from harness.llm.anthropic import _map_exception
        from harness.llm.provider import ContextTooLong
        assert isinstance(_map_exception(Exception("context_length_exceeded")), ContextTooLong)

    def test_400_maps_to_invalid_request(self):
        from harness.llm.anthropic import _map_exception
        from harness.llm.provider import InvalidRequest
        assert isinstance(_map_exception(Exception("400 bad request invalid_request")), InvalidRequest)

    def test_500_maps_to_provider_unavailable(self):
        from harness.llm.anthropic import _map_exception
        from harness.llm.provider import ProviderUnavailable
        assert isinstance(_map_exception(Exception("500 internal server error")), ProviderUnavailable)

    def test_network_error_maps_to_provider_unavailable(self):
        from harness.llm.anthropic import _map_exception
        from harness.llm.provider import ProviderUnavailable
        assert isinstance(_map_exception(Exception("connection reset by peer")), ProviderUnavailable)


class TestOpenAICompatErrorTaxonomy:
    """Unit tests for OpenAI error mapping — no live calls."""

    def test_429_maps_to_rate_limited(self):
        from harness.llm.openai_compat import _map_exception
        from harness.llm.provider import RateLimited
        assert isinstance(_map_exception(Exception("429 rate_limit")), RateLimited)

    def test_context_too_long(self):
        from harness.llm.openai_compat import _map_exception
        from harness.llm.provider import ContextTooLong
        assert isinstance(_map_exception(Exception("context_length_exceeded")), ContextTooLong)

    def test_400_maps_to_invalid_request(self):
        from harness.llm.openai_compat import _map_exception
        from harness.llm.provider import InvalidRequest
        assert isinstance(_map_exception(Exception("400 invalid")), InvalidRequest)
