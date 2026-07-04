"""OpenAI-compatible LLM provider implementation.

Covers any endpoint that speaks the OpenAI Chat Completions API:
- Azure OpenAI
- vLLM (self-hosted)
- OpenAI API directly

Wraps ``langchain_openai.ChatOpenAI`` and translates to the normalised Turn.
"""

from __future__ import annotations

import structlog

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


class OpenAICompatProvider:
    """LLMProvider implementation for any OpenAI-compatible endpoint.

    Args:
        api_key: API key (required for OpenAI/Azure; may be any string for vLLM).
        base_url: Base URL for the endpoint (e.g. ``http://localhost:8000/v1``).
            Leave empty for the default OpenAI endpoint.
        default_model: Default model name.
        azure_endpoint: Azure OpenAI endpoint URL (optional; triggers Azure mode).
        azure_api_version: Azure API version string (optional).
    """

    def __init__(
        self,
        api_key: str,
        base_url: str = "",
        default_model: str = "gpt-4o",
        azure_endpoint: str = "",
        azure_api_version: str = "",
    ) -> None:
        self._api_key = api_key
        self._base_url = base_url
        self._default_model = default_model
        self._azure_endpoint = azure_endpoint
        self._azure_api_version = azure_api_version

    def _make_client(self, config: LLMConfig) -> object:
        """Construct a LangChain OpenAI client for the given config.

        Args:
            config: LLM call configuration.

        Returns:
            ChatOpenAI or AzureChatOpenAI instance.
        """
        model = config.model or self._default_model

        if self._azure_endpoint:
            from langchain_openai import AzureChatOpenAI
            return AzureChatOpenAI(
                azure_endpoint=self._azure_endpoint,
                api_key=self._api_key,
                api_version=self._azure_api_version or "2024-02-01",
                azure_deployment=model,
                max_tokens=config.max_tokens,
                temperature=config.temperature,
            )

        from langchain_openai import ChatOpenAI
        kwargs: dict = dict(
            model=model,
            api_key=self._api_key,
            max_tokens=config.max_tokens,
            temperature=config.temperature,
        )
        if self._base_url:
            kwargs["base_url"] = self._base_url
        return ChatOpenAI(**kwargs)

    async def complete(
        self,
        messages: list[Message],
        tools: list[ToolSpec] | None,
        config: LLMConfig,
    ) -> Turn:
        """Execute a completion via an OpenAI-compatible endpoint.

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
            InvalidRequest: On HTTP 400.
        """
        from langchain_core.messages import (
            AIMessage,
            HumanMessage,
            SystemMessage,
            ToolMessage,
        )

        log = logger.bind(provider="openai_compat", model=config.model or self._default_model)

        # Convert messages
        lc_messages = []
        for msg in messages:
            if msg.role == "system":
                lc_messages.append(SystemMessage(content=msg.content))
            elif msg.role == "user":
                lc_messages.append(HumanMessage(content=msg.content))
            elif msg.role == "assistant":
                if msg.tool_calls:
                    tc_dicts = [
                        {"id": tc.id, "name": tc.name, "args": tc.args}
                        for tc in msg.tool_calls
                    ]
                    ai_msg = AIMessage(content=msg.content, tool_calls=tc_dicts)
                    lc_messages.append(ai_msg)
                else:
                    lc_messages.append(AIMessage(content=msg.content))
            elif msg.role == "tool":
                lc_messages.append(
                    ToolMessage(
                        content=msg.content,
                        tool_call_id=msg.tool_call_id or "",
                        name=msg.name,
                    )
                )

        client = self._make_client(config)

        if tools:
            openai_tools = [
                {
                    "type": "function",
                    "function": {
                        "name": t.name,
                        "description": t.description,
                        "parameters": t.input_schema,
                    },
                }
                for t in tools
            ]
            bound = client.bind_tools(openai_tools)
        else:
            bound = client

        try:
            response: AIMessage = await bound.ainvoke(lc_messages)
        except Exception as exc:
            raise _map_exception(exc) from exc

        # Extract tool calls
        tool_calls = [
            ToolCall(id=tc.get("id", ""), name=tc.get("name", ""), args=tc.get("args", {}))
            for tc in (response.tool_calls or [])
        ]

        # Extract usage
        usage_meta = getattr(response, "usage_metadata", {}) or {}
        input_tokens = usage_meta.get("input_tokens", 0)
        output_tokens = usage_meta.get("output_tokens", 0)
        usage = TokenUsage(input=input_tokens, output=output_tokens, total=input_tokens + output_tokens)

        # Extract stop reason
        meta = getattr(response, "response_metadata", {}) or {}
        finish = meta.get("finish_reason", "stop")
        stop_reason = {
            "stop": StopReason.END_TURN,
            "tool_calls": StopReason.TOOL_USE,
            "length": StopReason.MAX_TOKENS,
        }.get(finish, StopReason.END_TURN)

        content = response.content if isinstance(response.content, str) else ""

        log.info(
            "openai_compat_complete",
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
        exc: Exception raised by the OpenAI client.

    Returns:
        Appropriate LLMError subclass.
    """
    msg = str(exc).lower()
    if "429" in msg or "rate_limit" in msg:
        return RateLimited(f"OpenAI rate limit: {exc}")
    if "context_length" in msg or "maximum context" in msg:
        return ContextTooLong(f"OpenAI context too long: {exc}", token_count=0, limit=0)
    if "400" in msg or "invalid" in msg:
        return InvalidRequest(f"OpenAI invalid request: {exc}", detail=str(exc))
    return ProviderUnavailable(f"OpenAI provider error: {exc}")
