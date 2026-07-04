"""OTel instrumentation for the harness — spans, metrics, and span decorators."""

from __future__ import annotations

import functools
import time
from collections.abc import Callable
from typing import Any

import structlog
from opentelemetry import metrics, trace
from opentelemetry.trace import StatusCode

logger = structlog.get_logger()

# ---------------------------------------------------------------------------
# Tracer and meter — obtained from the OTel SDK configured at startup
# ---------------------------------------------------------------------------

_tracer = trace.get_tracer("harness", schema_url="https://opentelemetry.io/schemas/1.23.1")
_meter = metrics.get_meter("harness", schema_url="https://opentelemetry.io/schemas/1.23.1")

# ---------------------------------------------------------------------------
# Metric instruments
# ---------------------------------------------------------------------------

TOKENS_PER_SESSION = _meter.create_histogram(
    "agent.tokens_per_session",
    unit="token",
    description="Total tokens used per session",
)

COST_PER_SESSION = _meter.create_histogram(
    "agent.cost_per_session",
    unit="usd",
    description="Estimated cost in USD per session",
)

TOOL_CALLS_TOTAL = _meter.create_counter(
    "agent.tool_calls_total",
    description="Total tool calls, labelled by tool_name and status",
)

GUARD_DENIALS_TOTAL = _meter.create_counter(
    "agent.guard_denials_total",
    description="Guard denial count, labelled by guard_name and code",
)

COMPACTIONS_TOTAL = _meter.create_counter(
    "agent.compactions_total",
    description="Context compaction count",
)

TURN_LATENCY = _meter.create_histogram(
    "agent.turn_latency_seconds",
    unit="s",
    description="Turn execution latency in seconds (excluding LLM time)",
)

# ---------------------------------------------------------------------------
# Span decorator
# ---------------------------------------------------------------------------


def trace_span(
    name: str,
    attributes: dict[str, Any] | None = None,
) -> Callable:
    """Decorator that wraps an async function in an OTel span.

    Usage::

        @trace_span("agent.turn", attributes={"component": "worker"})
        async def _claim_and_execute(self, ...):
            ...

    Args:
        name: Span name.
        attributes: Static span attributes to set at span creation.

    Returns:
        Async decorator.
    """
    def decorator(fn: Callable) -> Callable:
        @functools.wraps(fn)
        async def wrapper(*args: Any, **kwargs: Any) -> Any:
            with _tracer.start_as_current_span(name) as span:
                if attributes:
                    for k, v in attributes.items():
                        span.set_attribute(k, v)
                try:
                    result = await fn(*args, **kwargs)
                    span.set_status(StatusCode.OK)
                    return result
                except Exception as exc:
                    span.record_exception(exc)
                    span.set_status(StatusCode.ERROR, str(exc))
                    raise
        return wrapper
    return decorator


def record_llm_usage(
    span: Any,
    provider: str,
    model: str,
    input_tokens: int,
    output_tokens: int,
) -> None:
    """Record GenAI semconv attributes on an OTel span.

    Args:
        span: Active OTel span.
        provider: Provider name (e.g. ``"anthropic"``).
        model: Model name (e.g. ``"claude-sonnet-4-5"``).
        input_tokens: Prompt token count.
        output_tokens: Completion token count.
    """
    try:
        span.set_attribute("gen_ai.system", provider)
        span.set_attribute("gen_ai.model", model)
        span.set_attribute("gen_ai.usage.input_tokens", input_tokens)
        span.set_attribute("gen_ai.usage.output_tokens", output_tokens)
    except Exception:
        pass  # span may be a no-op


def get_current_span() -> Any:
    """Return the currently active OTel span.

    Returns:
        Active span, or a no-op span if none is active.
    """
    return trace.get_current_span()
