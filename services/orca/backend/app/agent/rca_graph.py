"""Interactive RCA LangGraph — interrupt/resume design.

Graph shape
-----------
    start
      ↓
    data_gathering        (mcp-grafana: Loki, Prometheus, dashboards)
      ↓
    historical_context    (pgvector: top-5 similar past RCAs)
      ↓
    hypothesis_generation (LLM: produce hypothesis + suggested questions)
      ↓
    await_input           (interrupt() — pauses, surfaces hypothesis to developer)
      ↓ (on Command(resume=…))
    ┌─ should_continue ──────────────────────────────────────────────────────┐
    │  developer_accepted     → finalize                                     │
    │  round >= max_rounds    → force_finalize                               │
    │  otherwise              → refine → hypothesis_generation → await_input │
    └────────────────────────────────────────────────────────────────────────┘
      ↓
    finalize / force_finalize  (write rca_sessions + rca_embeddings)
      ↓
    END

The graph is compiled with a ``AsyncPostgresSaver`` checkpointer so that
thread state persists across HTTP requests.  Each RCA session is identified
by a ``thread_id`` (UUID) embedded in the LangGraph config.

Key design constraints (from rca-architecture-brief.md):
- ``developer_accepted`` is the ONLY real exit gate.
- Confidence scores are informational; never used in routing.
- Hypothesis trail is append-only (full audit log).
- org_id is threaded through state for MCP tool scoping.
"""

import json
import uuid
from datetime import datetime, timezone
from typing import Any, AsyncGenerator, Literal

import structlog
from langchain_anthropic import ChatAnthropic
from langchain_core.messages import AIMessage, BaseMessage, HumanMessage, SystemMessage
from langgraph.checkpoint.postgres.aio import AsyncPostgresSaver
from langgraph.graph import END, StateGraph
from langgraph.types import interrupt
from psycopg_pool import AsyncConnectionPool

from app.agent.mcp.grafana_client import get_grafana_tools
from app.agent.mcp.postgres_client import get_postgres_tools
from app.agent.rca_state import AlertContext, Hypothesis, RCAState
from app.config import settings
from app.db import AsyncSessionLocal

logger = structlog.get_logger()

# Module-level compiled graph (initialized once on first call)
_compiled_graph: Any | None = None
_checkpointer: AsyncPostgresSaver | None = None
_connection_pool: AsyncConnectionPool | None = None


def _pg_conn_string(database_url: str) -> str:
    """Strip SQLAlchemy driver prefix to get a psycopg3-compatible connection string.

    Args:
        database_url: SQLAlchemy DATABASE_URL (e.g. postgresql+asyncpg://...).

    Returns:
        Plain postgresql:// connection string for psycopg3.
    """
    return (
        database_url
        .replace("postgresql+asyncpg://", "postgresql://")
        .replace("postgresql+psycopg://", "postgresql://")
    )


async def init_rca_graph() -> Any:
    """Initialise the compiled RCA graph with a Postgres checkpointer.

    Must be called once during application startup (e.g. in the FastAPI
    lifespan).  Subsequent calls are idempotent — the cached graph is returned.

    Returns:
        Compiled LangGraph StateGraph ready for invocation and streaming.
    """
    global _compiled_graph, _checkpointer, _connection_pool  # noqa: PLW0603

    if _compiled_graph is not None:
        return _compiled_graph

    conn_string = _pg_conn_string(settings.DATABASE_URL)
    _connection_pool = AsyncConnectionPool(
        conninfo=conn_string,
        max_size=5,
        kwargs={"autocommit": True, "prepare_threshold": 0},
        open=False,
    )
    await _connection_pool.open()
    _checkpointer = AsyncPostgresSaver(_connection_pool)
    await _checkpointer.setup()

    _compiled_graph = build_rca_graph(_checkpointer)
    logger.info("rca_graph_initialised")
    return _compiled_graph


async def get_rca_graph() -> Any:
    """Return the cached compiled RCA graph, initialising if needed.

    Returns:
        Compiled LangGraph StateGraph.

    Raises:
        RuntimeError: If the graph has not been initialised yet.
    """
    if _compiled_graph is None:
        return await init_rca_graph()
    return _compiled_graph


# ---------------------------------------------------------------------------
# LLM instances
# ---------------------------------------------------------------------------

_llm_fast = ChatAnthropic(
    model="claude-haiku-4-5",
    api_key=settings.ANTHROPIC_API_KEY,
    max_tokens=2048,
)

_llm_main = ChatAnthropic(
    model="claude-sonnet-4-5",
    api_key=settings.ANTHROPIC_API_KEY,
    max_tokens=8192,
)


# ---------------------------------------------------------------------------
# Node: data_gathering
# ---------------------------------------------------------------------------

async def data_gathering_node(state: RCAState) -> dict[str, Any]:
    """Query Grafana datasources via MCP to gather evidence.

    Uses the org-scoped mcp-grafana client to query Loki logs,
    Prometheus metrics, and dashboard state for the alert context.

    Args:
        state: Current RCA state.

    Returns:
        Partial state update with ``gathered_data`` populated.
    """
    log = logger.bind(node="data_gathering", org_id=state.get("org_id"))
    ctx = state["alert_context"]
    org_id = state.get("org_id")

    log.info("data_gathering_start", alert_name=ctx["alert_name"])

    try:
        tools = await get_grafana_tools(org_id=org_id)
    except RuntimeError as exc:
        log.error("data_gathering_mcp_unavailable", error=str(exc))
        return {"gathered_data": [], "error_message": str(exc)}

    # Build a data-gathering prompt using available tools
    tool_names = [t.name for t in tools]
    prompt = f"""You are investigating a Grafana alert. Use the available tools to gather evidence.

Alert: {ctx['alert_name']}
Description: {ctx['description']}
Service: {ctx.get('service', 'unknown')}
Environment: {ctx.get('environment', 'unknown')}
Labels: {json.dumps(ctx['labels'], indent=2)}

Available tools: {', '.join(tool_names)}

Gather relevant logs, metrics, and dashboard data. Be systematic — check:
1. Recent error rates and latency from Prometheus
2. Error logs from Loki
3. Related dashboards for context
4. Active alerts

Return a JSON summary of all gathered data points."""

    llm_with_tools = _llm_main.bind_tools(tools)
    messages = [SystemMessage(content=prompt)]

    gathered_data: list[dict[str, Any]] = []
    for _step in range(settings.ORCA_MAX_INVESTIGATION_STEPS):
        response = await llm_with_tools.ainvoke(messages)
        messages.append(response)

        if not response.tool_calls:
            # LLM finished gathering
            gathered_data.append({
                "source": "llm_summary",
                "content": response.content,
                "timestamp": datetime.now(timezone.utc).isoformat(),
            })
            break

        # Execute tool calls
        from langchain_core.messages import ToolMessage
        for tool_call in response.tool_calls:
            tool = next((t for t in tools if t.name == tool_call["name"]), None)
            if tool is None:
                result = f"Tool {tool_call['name']} not available"
            else:
                try:
                    result = await tool.ainvoke(tool_call["args"])
                except Exception as exc:
                    result = f"Tool error: {exc}"

            gathered_data.append({
                "source": tool_call["name"],
                "args": tool_call["args"],
                "result": str(result)[:2000],  # cap individual results
                "timestamp": datetime.now(timezone.utc).isoformat(),
            })
            messages.append(
                ToolMessage(content=str(result), tool_call_id=tool_call["id"])
            )

    log.info("data_gathering_complete", data_points=len(gathered_data))
    return {"gathered_data": gathered_data}


# ---------------------------------------------------------------------------
# Node: historical_context
# ---------------------------------------------------------------------------

async def historical_context_node(state: RCAState) -> dict[str, Any]:
    """Retrieve similar past RCAs via pgvector semantic search.

    Embeds the alert description and queries ``rca_embeddings`` for the
    top-5 nearest hypotheses.  These are injected into the hypothesis
    generation prompt to give the agent institutional memory.

    Args:
        state: Current RCA state.

    Returns:
        Partial state update with ``past_rcas`` populated.
    """
    log = logger.bind(node="historical_context")
    ctx = state["alert_context"]

    try:
        from app.agent.historical_context import gather_historical_context
        past_rcas = await gather_historical_context(ctx)
        log.info("historical_context_complete", past_rca_count=len(past_rcas))
        return {"past_rcas": past_rcas}
    except Exception as exc:
        # Non-fatal — proceed without historical context
        log.warning("historical_context_failed", error=str(exc))
        return {"past_rcas": []}


# ---------------------------------------------------------------------------
# Node: hypothesis_generation
# ---------------------------------------------------------------------------

async def hypothesis_generation_node(state: RCAState) -> dict[str, Any]:
    """Generate or refine a hypothesis based on gathered data and Q&A history.

    On round 0: generates the initial hypothesis from gathered evidence.
    On subsequent rounds: refines based on the developer's follow-up question.

    Args:
        state: Current RCA state.

    Returns:
        Partial state update appending a new Hypothesis and confidence score.
    """
    log = logger.bind(node="hypothesis_generation", round=state["round"])
    ctx = state["alert_context"]
    gathered = state.get("gathered_data", [])
    past_rcas = state.get("past_rcas", [])
    messages = state.get("messages", [])
    hypotheses = state.get("hypotheses", [])

    # Build context string from gathered data
    evidence_text = "\n\n".join(
        f"**{d['source']}**: {d.get('result', d.get('content', ''))}"
        for d in gathered[:20]  # cap at 20 data points in prompt
    )

    # Build historical context string
    history_text = ""
    if past_rcas:
        history_text = "\n\n## Similar Past RCAs\n" + "\n".join(
            f"- [{r.get('alert_type', 'unknown')}] {r.get('final_hypothesis', '')[:200]}"
            for r in past_rcas[:5]
        )

    # Build Q&A transcript
    qa_text = ""
    if messages:
        qa_text = "\n\n## Developer Q&A So Far\n" + "\n".join(
            f"{'Developer' if isinstance(m, HumanMessage) else 'Agent'}: {m.content}"
            for m in messages[-10:]  # last 10 turns
        )

    # Include previous hypotheses for context
    prev_hypotheses_text = ""
    if hypotheses:
        prev_hypotheses_text = f"\n\n## Previous Hypothesis (Round {state['round'] - 1})\n{hypotheses[-1]['text']}"

    system_prompt = f"""You are an expert SRE performing root cause analysis.

## Alert Context
Alert: {ctx['alert_name']}
Description: {ctx['description']}
Service: {ctx.get('service', 'unknown')}
Environment: {ctx.get('environment', 'unknown')}

## Gathered Evidence
{evidence_text}
{history_text}
{prev_hypotheses_text}
{qa_text}

Based on this evidence, generate a hypothesis about the root cause.
Respond with a JSON object:
{{
  "text": "clear, specific hypothesis statement",
  "high_confidence_areas": ["area 1", "area 2"],
  "uncertain_areas": ["area 1", "area 2"],
  "confidence_score": 0.0 to 1.0,
  "suggested_questions": ["question 1", "question 2", "question 3"]
}}"""

    response = await _llm_main.ainvoke([SystemMessage(content=system_prompt)])

    # Parse response
    try:
        content = response.content
        if "```json" in content:
            content = content.split("```json")[1].split("```")[0].strip()
        elif "```" in content:
            content = content.split("```")[1].split("```")[0].strip()
        data = json.loads(content)
    except (json.JSONDecodeError, IndexError, KeyError) as exc:
        log.warning("hypothesis_parse_failed", error=str(exc))
        data = {
            "text": str(response.content),
            "high_confidence_areas": [],
            "uncertain_areas": ["Could not parse structured response"],
            "confidence_score": 0.3,
            "suggested_questions": [],
        }

    hypothesis: Hypothesis = {
        "text": data.get("text", ""),
        "high_confidence_areas": data.get("high_confidence_areas", []),
        "uncertain_areas": data.get("uncertain_areas", []),
        "suggested_questions": data.get("suggested_questions", []),
    }
    confidence = float(data.get("confidence_score", 0.5))

    new_hypotheses = list(state.get("hypotheses", [])) + [hypothesis]
    new_scores = list(state.get("confidence_scores", [])) + [confidence]

    log.info(
        "hypothesis_generated",
        round=state["round"],
        confidence=confidence,
        text_preview=hypothesis["text"][:100],
    )

    return {
        "hypotheses": new_hypotheses,
        "confidence_scores": new_scores,
    }


# ---------------------------------------------------------------------------
# Node: await_input (breakpoint)
# ---------------------------------------------------------------------------

async def await_input_node(state: RCAState) -> dict[str, Any]:
    """Pause the graph and surface the current hypothesis to the developer.

    Calls LangGraph's ``interrupt()`` which checkpoints state and raises
    ``GraphInterrupt``.  The graph resumes when ``Command(resume=…)`` is sent.

    The resume payload must be one of:
    - ``{"message": "developer question"}`` — refines hypothesis
    - ``{"developer_accepted": True}`` — finalises the RCA

    Args:
        state: Current RCA state.

    Returns:
        Partial state update based on the developer's response.
    """
    hypothesis = state["hypotheses"][-1] if state.get("hypotheses") else None
    confidence = state["confidence_scores"][-1] if state.get("confidence_scores") else 0.0

    # Surface to developer via interrupt()
    resume_value = interrupt({
        "hypothesis": hypothesis,
        "confidence": confidence,
        "round": state["round"],
        "suggested_questions": hypothesis.get("suggested_questions", []) if hypothesis else [],
    })

    # Process the resume payload
    if resume_value.get("developer_accepted"):
        return {"developer_accepted": True}

    message = resume_value.get("message", "")
    new_messages = list(state.get("messages", []))
    if message:
        new_messages.append(HumanMessage(content=message))

    return {
        "messages": new_messages,
        "pending_question": message,
        "round": state["round"] + 1,
    }


# ---------------------------------------------------------------------------
# Node: refine
# ---------------------------------------------------------------------------

async def refine_node(state: RCAState) -> dict[str, Any]:
    """Generate an agent response to the developer's follow-up question.

    Calls the LLM with the current hypothesis + developer question to
    produce a brief focused response, then returns to hypothesis_generation
    for a full hypothesis update.

    Args:
        state: Current RCA state.

    Returns:
        Partial state update adding the agent's response to messages.
    """
    log = logger.bind(node="refine", round=state["round"])
    question = state.get("pending_question", "")
    hypothesis = state["hypotheses"][-1] if state.get("hypotheses") else None

    if not question:
        return {}

    log.info("refine_start", question_preview=question[:80])

    # Try to gather additional targeted data
    org_id = state.get("org_id")
    additional_data: list[dict[str, Any]] = []
    try:
        tools = await get_grafana_tools(org_id=org_id)
        llm_with_tools = _llm_main.bind_tools(tools)
        refine_prompt = f"""You're refining an RCA investigation based on a developer question.

Current hypothesis: {hypothesis['text'] if hypothesis else 'None'}

Developer question: {question}

Use tools to gather more specific evidence to answer this question.
Focus on the specific aspect the developer is asking about."""

        messages = [SystemMessage(content=refine_prompt)]
        for _step in range(5):  # limited iterations for refine
            response = await llm_with_tools.ainvoke(messages)
            messages.append(response)
            if not response.tool_calls:
                additional_data.append({
                    "source": "refine_response",
                    "content": str(response.content),
                    "timestamp": datetime.now(timezone.utc).isoformat(),
                })
                break
            from langchain_core.messages import ToolMessage
            for tool_call in response.tool_calls:
                tool = next((t for t in tools if t.name == tool_call["name"]), None)
                result = await tool.ainvoke(tool_call["args"]) if tool else "Tool not found"
                additional_data.append({
                    "source": tool_call["name"],
                    "args": tool_call["args"],
                    "result": str(result)[:1500],
                    "timestamp": datetime.now(timezone.utc).isoformat(),
                })
                messages.append(ToolMessage(content=str(result), tool_call_id=tool_call["id"]))
    except Exception as exc:
        log.warning("refine_tool_call_failed", error=str(exc))
        additional_data.append({"source": "error", "content": str(exc)})

    # Generate agent response to developer question
    agent_response = additional_data[-1].get("content", "") if additional_data else ""
    new_messages = list(state.get("messages", []))
    if agent_response:
        new_messages.append(AIMessage(content=agent_response))

    # Merge additional data into gathered_data
    merged_data = list(state.get("gathered_data", [])) + additional_data

    log.info("refine_complete", additional_data_points=len(additional_data))

    return {
        "gathered_data": merged_data,
        "messages": new_messages,
        "pending_question": None,
    }


# ---------------------------------------------------------------------------
# Node: finalize
# ---------------------------------------------------------------------------

async def finalize_node(state: RCAState) -> dict[str, Any]:
    """Write the accepted RCA to rca_sessions and rca_embeddings.

    Generates the final report from the accepted hypothesis + full transcript,
    persists it to Postgres, and writes embeddings for future historical context.

    Args:
        state: Current RCA state.

    Returns:
        Partial state update with ``final_report`` and ``rca_session_id``.
    """
    log = logger.bind(node="finalize")
    hypothesis = state["hypotheses"][-1] if state.get("hypotheses") else None
    confidence = state["confidence_scores"][-1] if state.get("confidence_scores") else 0.0
    ctx = state["alert_context"]
    force = state.get("force_finalized", False)

    # Build the final report
    report = await _build_final_report(state, hypothesis, confidence, force)
    log.info("final_report_built", force_finalized=force)

    # Persist to rca_sessions
    rca_session_id = await _persist_rca_session(state, report, hypothesis, confidence)
    log.info("rca_session_persisted", rca_session_id=rca_session_id)

    # Write embeddings for future historical context
    if rca_session_id:
        await _write_embeddings(rca_session_id, hypothesis, state.get("messages", []), report)

    return {
        "final_report": report,
        "rca_session_id": rca_session_id,
    }


async def force_finalize_node(state: RCAState) -> dict[str, Any]:
    """Force-finalise when max_rounds is reached without developer acceptance.

    Same as finalize but sets ``force_finalized=True`` so the report includes
    a warning that the agent hit the round ceiling.

    Args:
        state: Current RCA state.

    Returns:
        Partial state update delegating to finalize_node.
    """
    logger.bind(node="force_finalize").warning(
        "max_rounds_reached",
        round=state["round"],
        max_rounds=state["max_rounds"],
    )
    updated = dict(state)
    updated["force_finalized"] = True
    return await finalize_node(updated)


# ---------------------------------------------------------------------------
# Routing
# ---------------------------------------------------------------------------

def should_continue(state: RCAState) -> Literal["finalize", "force_finalize", "refine"]:
    """Route after await_input based on developer decision and round count.

    Args:
        state: Current RCA state (after developer input was injected).

    Returns:
        Next node name: "finalize", "force_finalize", or "refine".
    """
    if state.get("developer_accepted"):
        return "finalize"
    if state.get("round", 0) >= state.get("max_rounds", settings.ORCA_MAX_ROUNDS):
        return "force_finalize"
    return "refine"


# ---------------------------------------------------------------------------
# Graph construction
# ---------------------------------------------------------------------------

def build_rca_graph(checkpointer: AsyncPostgresSaver) -> Any:
    """Construct and compile the interactive RCA StateGraph.

    Args:
        checkpointer: Async Postgres checkpointer for thread state persistence.

    Returns:
        Compiled StateGraph ready for invocation and streaming.
    """
    graph: StateGraph = StateGraph(RCAState)

    graph.add_node("data_gathering", data_gathering_node)
    graph.add_node("historical_context", historical_context_node)
    graph.add_node("hypothesis_generation", hypothesis_generation_node)
    graph.add_node("await_input", await_input_node)
    graph.add_node("refine", refine_node)
    graph.add_node("finalize", finalize_node)
    graph.add_node("force_finalize", force_finalize_node)

    graph.set_entry_point("data_gathering")
    graph.add_edge("data_gathering", "historical_context")
    graph.add_edge("historical_context", "hypothesis_generation")
    graph.add_edge("hypothesis_generation", "await_input")

    graph.add_conditional_edges(
        "await_input",
        should_continue,
        {
            "finalize": "finalize",
            "force_finalize": "force_finalize",
            "refine": "refine",
        },
    )

    graph.add_edge("refine", "hypothesis_generation")
    graph.add_edge("finalize", END)
    graph.add_edge("force_finalize", END)

    return graph.compile(checkpointer=checkpointer)


# ---------------------------------------------------------------------------
# Helper: build final report
# ---------------------------------------------------------------------------

async def _build_final_report(
    state: RCAState,
    hypothesis: Hypothesis | None,
    confidence: float,
    force_finalized: bool,
) -> dict[str, Any]:
    """Generate the structured final RCA report from state."""
    ctx = state["alert_context"]
    messages = state.get("messages", [])
    hypotheses = state.get("hypotheses", [])
    scores = state.get("confidence_scores", [])

    qa_transcript = "\n".join(
        f"{'Developer' if isinstance(m, HumanMessage) else 'Agent'}: {m.content}"
        for m in messages
    )

    prompt = f"""Generate a comprehensive RCA report in JSON format.

Alert: {ctx['alert_name']}
Service: {ctx.get('service', 'unknown')}

Final Hypothesis: {hypothesis['text'] if hypothesis else 'Unknown'}
Confidence: {confidence:.0%}
Rounds: {state.get('round', 0)}
Force finalized: {force_finalized}

Q&A Transcript:
{qa_transcript or 'No Q&A rounds.'}

Return JSON:
{{
  "executive_summary": "...",
  "root_cause": "...",
  "contributing_factors": ["..."],
  "timeline": ["..."],
  "impact_assessment": "...",
  "recommendations": ["..."],
  "confidence_assessment": "...",
  "developer_override": {json.dumps(force_finalized or (confidence < 0.6 and state.get('developer_accepted', False)))},
  "hypothesis_trail": {json.dumps([h['text'] for h in hypotheses])},
  "confidence_scores": {json.dumps(scores)},
  "report_markdown": "# RCA Report\\n\\n..."
}}"""

    response = await _llm_main.ainvoke([SystemMessage(content=prompt)])
    try:
        content = response.content
        if "```json" in content:
            content = content.split("```json")[1].split("```")[0].strip()
        report = json.loads(content)
    except (json.JSONDecodeError, IndexError):
        report = {
            "executive_summary": str(response.content)[:500],
            "root_cause": hypothesis["text"] if hypothesis else "Unknown",
            "contributing_factors": [],
            "timeline": [],
            "impact_assessment": "",
            "recommendations": [],
            "confidence_assessment": f"{confidence:.0%}",
            "developer_override": force_finalized,
            "hypothesis_trail": [h["text"] for h in hypotheses],
            "confidence_scores": scores,
            "report_markdown": str(response.content),
        }

    return report


# ---------------------------------------------------------------------------
# Helper: persist rca_session
# ---------------------------------------------------------------------------

async def _persist_rca_session(
    state: RCAState,
    report: dict[str, Any],
    hypothesis: Hypothesis | None,
    confidence: float,
) -> str | None:
    """Write the finalised RCA to the rca_sessions table."""
    from app.models.rca_session import RCASession

    session_id = str(uuid.uuid4())
    ctx = state["alert_context"]
    messages = state.get("messages", [])

    async with AsyncSessionLocal() as db:
        try:
            session = RCASession(
                id=session_id,
                thread_id=None,  # set by caller if available
                alert_id=ctx.get("alert_id"),
                alert_type=ctx["alert_name"],
                service=ctx.get("service"),
                environment=ctx.get("environment"),
                org_id=state.get("org_id"),
                rounds=state.get("round", 0),
                final_confidence=confidence,
                developer_override=state.get("force_finalized", False) or (
                    confidence < 0.6 and state.get("developer_accepted", False)
                ),
                final_hypothesis=hypothesis["text"] if hypothesis else None,
                final_report=report,
                hypothesis_trail=[h["text"] for h in state.get("hypotheses", [])],
                started_at=datetime.now(timezone.utc),
                accepted_at=datetime.now(timezone.utc),
            )
            db.add(session)
            await db.commit()
            return session_id
        except Exception as exc:
            logger.error("rca_session_persist_failed", error=str(exc))
            return None


# ---------------------------------------------------------------------------
# Helper: write embeddings
# ---------------------------------------------------------------------------

async def _write_embeddings(
    rca_session_id: str,
    hypothesis: Hypothesis | None,
    messages: list[BaseMessage],
    report: dict[str, Any],
) -> None:
    """Write pgvector embeddings for the RCA to support future historical context."""
    from app.models.rca_embedding import RCAEmbedding
    from app.agent.historical_context import embed_text

    async with AsyncSessionLocal() as db:
        try:
            chunks: list[tuple[str, str]] = []
            if hypothesis:
                chunks.append(("hypothesis", hypothesis["text"]))
            for i in range(0, len(messages) - 1, 2):
                if i + 1 < len(messages):
                    qa = f"Q: {messages[i].content}\nA: {messages[i+1].content}"
                    chunks.append(("qa_turn", qa))
            if report.get("report_markdown"):
                chunks.append(("final_report", str(report["report_markdown"])[:2000]))

            for chunk_type, content in chunks:
                try:
                    embedding = await embed_text(content)
                    row = RCAEmbedding(
                        id=str(uuid.uuid4()),
                        rca_id=rca_session_id,
                        chunk_type=chunk_type,
                        content=content,
                        embedding=embedding,
                    )
                    db.add(row)
                except Exception as exc:
                    logger.warning("embedding_failed", chunk_type=chunk_type, error=str(exc))

            await db.commit()
        except Exception as exc:
            logger.error("embeddings_write_failed", error=str(exc))
