"""Anthropic LLM provider implementation.

Wraps ``langchain_anthropic.ChatAnthropic`` and translates its response
format into the normalised ``Turn`` type defined in ``harness.llm.provider``.

Handles the Anthropic-specific tool-use format (content blocks with
``type='tool_use'``) and maps HTTP errors to the provider error taxonomy.
"""

from __future__ import annotations

import structlog
from langchain_anthropic import ChatAnthropic
from langchain_core.messages import (
    AIMessage,
    BaseMessage,
    HumanMessage,
    SystemMessage,
    ToolMessage,
)

from harness.llm.provider import (
    ContextTooLong,
    InvalidRequest,
    LLMConfig,
    LLMError,
    Message,
    ProviderUnavailable,
    RateLimited,
    StopReason,
    ToolCall,
    ToolSpec,
    TokenUsage,
    Turn,
)

logger = structlog.get_logger()


def _to_langchain_messages(messages: list[Message]) -> list[BaseMessage]:
    """Convert normalised Message list to LangChain BaseMessage list.

    Args:
        messages: Normalised messages from the harness protocol.

    Returns:
        LangChain-compatible message list.
    """
    result: list[BaseMessage] = []
    for msg in messages:
        if msg.role == "system":
            result.append(SystemMessage(content=msg.content))
        elif msg.role == "user":
            result.append(HumanMessage(content=msg.content))
        elif msg.role == "assistant":
            if msg.tool_calls:
                # Build Anthropic tool-use message
                content: list[dict] = []
                if msg.content:
                    content.append({"type": "text", "text": msg.content})
                for tc in msg.tool_calls:
                    content.append({
                        "type": "tool_use",
                        "id": tc.id,
                        "name": tc.name,
                        "input": tc.args,
                    })
                result.append(AIMessage(content=content))
            else:
                result.append(AIMessage(content=msg.content))
        elif msg.role == "tool":
            result.append(
                ToolMessage(
                    content=msg.content,
                    tool_call_id=msg.tool_call_id or "",
                    name=msg.name,
                )
            )
    return result


def _extract_tool_calls(response: AIMessage) -> list[ToolCall]:
    """Extract tool calls from an Anthropic AIMessage response.

    Handles both the LangChain ``tool_calls`` attribute (list of dicts)
    and the raw Anthropic content-block format.

    Args:
        response: LangChain AIMessage from ChatAnthropic.

    Returns:
        List of normalised ToolCall objects.
    """
    tool_calls: list[ToolCall] = []

    # LangChain normalises tool calls onto response.tool_calls
    for tc in (response.tool_calls or []):
        tool_calls.append(ToolCall(
            id=tc.get("id", ""),
            name=tc.get("name", ""),
            args=tc.get("args", {}),
        ))

    return tool_calls


def _extract_stop_reason(response: AIMessage) -> StopReason:
    """Map Anthropic stop_reason to normalised StopReason.

    Args:
        response: AIMessage from ChatAnthropic.

    Returns:
        Normalised StopReason enum value.
    """
    # LangChain stores response_metadata from Anthropic
    metadata = getattr(response, "response_metadata", {}) or {}
    raw_reason = metadata.get("stop_reason", "")

    mapping = {
        "end_turn": StopReason.END_TURN,
        "tool_use": StopReason.TOOL_USE,
        "max_tokens": StopReason.MAX_TOKENS,
    }
    return mapping.get(raw_reason, StopReason.END_TURN)


def _extract_usage(response: AIMessage) -> TokenUsage:
    """Extract token counts from the Anthropic response.

    Args:
        response: AIMessage from ChatAnthropic.

    Returns:
        TokenUsage with input, output, and total counts.
    """
    metadata = getattr(response, "usage_metadata", {}) or {}
    input_tokens = metadata.get("input_tokens", 0)
    output_tokens = metadata.get("output_tokens", 0)
    return TokenUsage(
        input=input_tokens,
        output=output_tokens,
        total=input_tokens + output_tokens,
    )


def _extract_content(response: AIMessage) -> str:
    """Extract text content from an Anthropic AIMessage.

    Handles both plain string content and content-block lists.

    Args:
        response: AIMessage from ChatAnthropic.

    Returns:
        Concatenated text content string.
    """
    content = response.content
    if isinstance(content, str):
        return content
    # Content block list
    parts: list[str] = []
    if isinstance(content, list):
        for block in content:
            if isinstance(block, dict) and block.get("type") == "text":
                parts.append(block.get("text", ""))
            elif isinstance(block, str):
                parts.append(block)
    return "".join(parts)


class AnthropicProvider:
    """LLMProvider implementation wrapping ChatAnthropic.

    Args:
        api_key: Anthropic API key.
        default_model: Default model to use when config.model is not specified.
    """

    def __init__(self, api_key: str, default_model: str = "claude-sonnet-4-5") -> None:
        self._api_key = api_key
        self._default_model = default_model

    def _make_client(self, config: LLMConfig) -> ChatAnthropic:
        """Construct a ChatAnthropic instance for the given config.

        Args:
            config: LLM call configuration.

        Returns:
            Configured ChatAnthropic instance.
        """
        return ChatAnthropic(
            model=config.model or self._default_model,
            api_key=self._api_key,
            max_tokens=config.max_tokens,
            temperature=config.temperature,
        )

    async def complete(
        self,
        messages: list[Message],
        tools: list[ToolSpec] | None,
        config: LLMConfig,
    ) -> Turn:
        """Execute a completion via ChatAnthropic and return a normalised Turn.

        Args:
            messages: Conversation history.
            tools: Optional tools to make available.
            config: Per-call configuration.

        Returns:
            Normalised Turn.

        Raises:
            RateLimited: On HTTP 429.
            ProviderUnavailable: On HTTP 5xx or network error.
            ContextTooLong: When context exceeds the model window.
            InvalidRequest: On HTTP 400 or bad tool schema.
        """
        log = logger.bind(provider="anthropic", model=config.model or self._default_model)
        lc_messages = _to_langchain_messages(messages)
        client = self._make_client(config)

        if tools:
            lc_tools = [
                {
                    "name": t.name,
                    "description": t.description,
                    "input_schema": t.input_schema,
                }
                for t in tools
            ]
            bound = client.bind_tools(lc_tools)
        else:
            bound = client

        try:
            response: AIMessage = await bound.ainvoke(lc_messages)
        except Exception as exc:
            raise _map_exception(exc) from exc

        tool_calls = _extract_tool_calls(response)
        usage = _extract_usage(response)
        stop_reason = _extract_stop_reason(response)
        content = _extract_content(response)

        log.info(
            "anthropic_complete",
            input_tokens=usage.input,
            output_tokens=usage.output,
            stop_reason=stop_reason,
            tool_call_count=len(tool_calls),
        )

        return Turn(
            content=content,
            tool_calls=tool_calls,
            usage=usage,
            stop_reason=stop_reason,
            raw=response,
        )


def _map_exception(exc: Exception) -> LLMError:
    """Map a vendor exception to the normalised error taxonomy.

    Args:
        exc: Exception raised by ChatAnthropic.

    Returns:
        Appropriate LLMError subclass.
    """
    msg = str(exc).lower()

    # Anthropic SDK raises anthropic.RateLimitError (HTTP 429)
    if "rate_limit" in msg or "ratelimit" in msg or "429" in msg:
        return RateLimited(f"Anthropic rate limit: {exc}")

    # Context window overflowed
    if "context_length_exceeded" in msg or "too long" in msg or "100000" in msg:
        return ContextTooLong(f"Anthropic context too long: {exc}", token_count=0, limit=0)

    # 400 bad request
    if "400" in msg or "invalid_request" in msg or "bad request" in msg:
        return InvalidRequest(f"Anthropic invalid request: {exc}", detail=str(exc))

    # 5xx / network errors
    if any(x in msg for x in ["500", "502", "503", "504", "connection", "timeout", "network"]):
        return ProviderUnavailable(f"Anthropic unavailable: {exc}")

    return ProviderUnavailable(f"Anthropic error: {exc}")
