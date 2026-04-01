"""SSE streaming helper for the interactive RCA graph.

Converts ``graph.astream_events()`` output into Server-Sent Events (SSE)
formatted strings suitable for use with FastAPI's ``StreamingResponse``.

Event types emitted
-------------------
- ``step``        — an agent node started or produced output
- ``hypothesis``  — a new hypothesis is available (from hypothesis_generation node)
- ``tool_call``   — an MCP tool was called (name + args)
- ``tool_result`` — result of an MCP tool call
- ``interrupt``   — graph paused at await_input; includes hypothesis + suggested questions
- ``done``        — graph finished (either at interrupt or at END)
- ``error``       — an error occurred during streaming

Each event is formatted as::

    data: {JSON payload}\\n\\n

The ``data`` field is a JSON-encoded ``RCAStreamEvent`` dict.
"""

import json
from typing import Any, AsyncGenerator

import structlog
from langgraph.types import Command

logger = structlog.get_logger()


def _sse(event_type: str, data: dict[str, Any]) -> str:
    """Format a single SSE event string.

    Args:
        event_type: Logical event type (step, hypothesis, interrupt, done, error).
        data: JSON-serialisable payload dict.

    Returns:
        SSE-formatted string ending with double newline.
    """
    payload = json.dumps({"type": event_type, **data})
    return f"data: {payload}\n\n"


async def stream_rca_start(
    graph: Any,
    initial_state: dict[str, Any],
    thread_id: str,
) -> AsyncGenerator[str, None]:
    """Stream events from the initial graph run until the first interrupt.

    Runs the graph from the beginning and streams node execution events
    until the graph pauses at ``await_input``.  Yields SSE events
    describing the data_gathering, historical_context, and hypothesis_generation
    steps.

    Args:
        graph: Compiled LangGraph StateGraph with checkpointer.
        initial_state: Initial RCAState dict.
        thread_id: LangGraph thread ID for checkpointing.

    Yields:
        SSE-formatted event strings.
    """
    config = {"configurable": {"thread_id": thread_id}}
    log = logger.bind(thread_id=thread_id, operation="start")

    # Emit thread_id immediately so the client can track the session
    # even before the first agent step completes.
    yield _sse("session_created", {"thread_id": thread_id})

    try:
        async for event in graph.astream_events(
            initial_state,
            config=config,
            version="v2",
        ):
            event_name: str = event.get("event", "")
            node_name: str = event.get("name", "")
            data: dict[str, Any] = event.get("data", {})

            # Node started
            if event_name == "on_chain_start" and node_name in (
                "data_gathering", "historical_context", "hypothesis_generation"
            ):
                yield _sse("step", {"node": node_name, "status": "started"})

            # Node completed
            elif event_name == "on_chain_end" and node_name in (
                "data_gathering", "historical_context"
            ):
                yield _sse("step", {"node": node_name, "status": "complete"})

            # Hypothesis generated
            elif event_name == "on_chain_end" and node_name == "hypothesis_generation":
                output = data.get("output", {})
                hypotheses = output.get("hypotheses", [])
                scores = output.get("confidence_scores", [])
                if hypotheses and scores:
                    yield _sse("hypothesis", {
                        "hypothesis": hypotheses[-1],
                        "confidence": scores[-1],
                    })
                yield _sse("step", {"node": node_name, "status": "complete"})

            # Tool call (MCP)
            elif event_name == "on_tool_start":
                yield _sse("tool_call", {
                    "tool": node_name,
                    "args": data.get("input", {}),
                })

            # Tool result
            elif event_name == "on_tool_end":
                output_str = str(data.get("output", ""))[:500]
                yield _sse("tool_result", {
                    "tool": node_name,
                    "result_preview": output_str,
                })

            # Graph interrupted at await_input
            elif event_name == "on_chain_end" and node_name == "__interrupt__":
                interrupt_value = data.get("output", {})
                yield _sse("interrupt", {
                    "thread_id": thread_id,
                    "hypothesis": interrupt_value.get("hypothesis"),
                    "confidence": interrupt_value.get("confidence"),
                    "round": interrupt_value.get("round", 0),
                    "suggested_questions": interrupt_value.get("suggested_questions", []),
                })
                yield _sse("done", {"reason": "awaiting_input"})
                return

    except Exception as exc:
        log.error("stream_rca_start_failed", error=str(exc))
        yield _sse("error", {"message": str(exc)})

    yield _sse("done", {"reason": "complete"})


async def stream_rca_refine(
    graph: Any,
    thread_id: str,
    message: str,
) -> AsyncGenerator[str, None]:
    """Stream events from resuming the graph with a developer message.

    Resumes the graph using ``Command(resume={"message": message})`` and
    streams the refine + hypothesis_generation steps until the next interrupt.

    Args:
        graph: Compiled LangGraph StateGraph with checkpointer.
        thread_id: LangGraph thread ID for the existing session.
        message: Developer's follow-up question or observation.

    Yields:
        SSE-formatted event strings.
    """
    config = {"configurable": {"thread_id": thread_id}}
    log = logger.bind(thread_id=thread_id, operation="refine")
    log.info("stream_refine_start", message_preview=message[:80])

    command = Command(resume={"message": message})

    try:
        async for event in graph.astream_events(
            command,
            config=config,
            version="v2",
        ):
            event_name: str = event.get("event", "")
            node_name: str = event.get("name", "")
            data: dict[str, Any] = event.get("data", {})

            if event_name == "on_chain_start" and node_name in ("refine", "hypothesis_generation"):
                yield _sse("step", {"node": node_name, "status": "started"})

            elif event_name == "on_chain_end" and node_name == "refine":
                yield _sse("step", {"node": node_name, "status": "complete"})

            elif event_name == "on_chain_end" and node_name == "hypothesis_generation":
                output = data.get("output", {})
                hypotheses = output.get("hypotheses", [])
                scores = output.get("confidence_scores", [])
                if hypotheses and scores:
                    yield _sse("hypothesis", {
                        "hypothesis": hypotheses[-1],
                        "confidence": scores[-1],
                    })
                yield _sse("step", {"node": node_name, "status": "complete"})

            elif event_name == "on_tool_start":
                yield _sse("tool_call", {
                    "tool": node_name,
                    "args": data.get("input", {}),
                })

            elif event_name == "on_tool_end":
                output_str = str(data.get("output", ""))[:500]
                yield _sse("tool_result", {
                    "tool": node_name,
                    "result_preview": output_str,
                })

            elif event_name == "on_chain_end" and node_name == "__interrupt__":
                interrupt_value = data.get("output", {})
                yield _sse("interrupt", {
                    "hypothesis": interrupt_value.get("hypothesis"),
                    "confidence": interrupt_value.get("confidence"),
                    "round": interrupt_value.get("round", 0),
                    "suggested_questions": interrupt_value.get("suggested_questions", []),
                })
                yield _sse("done", {"reason": "awaiting_input"})
                return

    except Exception as exc:
        log.error("stream_refine_failed", error=str(exc))
        yield _sse("error", {"message": str(exc)})

    yield _sse("done", {"reason": "complete"})
