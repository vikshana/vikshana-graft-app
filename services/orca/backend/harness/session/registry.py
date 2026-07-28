"""GraphRegistry — maps session types to compiled LangGraph graphs.

The registry is a simple dict of ``session_type -> graph factory``.
Factories are callables that return the compiled graph; they are called
lazily on first access so the registry can be populated at import time
before the graph is initialised.

Factories may be sync (return the graph directly, e.g. in tests: ``lambda:
mock_graph``) or **async** (e.g. ``app.agent.rca_graph.get_rca_graph``,
which lazily opens a Postgres checkpointer connection pool on first call).
Use ``get()`` for sync factories and ``aget()`` for async ones — ``aget()``
transparently handles both. Calling ``get()`` on an async factory raises a
clear ``TypeError`` instead of silently caching the un-awaited coroutine
object (see docs/harness-risk-review.md, F1: this previously caused
``TurnWorker`` to call ``coroutine.ainvoke(...)`` and fail, since a
coroutine object has no ``ainvoke`` attribute).

Usage::

    from harness.session.registry import graph_registry

    # At startup
    graph_registry.register("investigation", lambda: _compiled_graph)
    # ... or with an async factory:
    graph_registry.register("investigation", get_rca_graph)

    # At turn execution (async-safe — handles both sync and async factories)
    graph = await graph_registry.aget("investigation")
    await graph.ainvoke(state, config=...)
"""

from __future__ import annotations

import inspect
from typing import Any, Callable

import structlog

logger = structlog.get_logger()

# Type alias for the compiled graph factory
GraphFactory = Callable[[], Any]


class GraphRegistry:
    """Maps session type strings to compiled LangGraph graph instances.

    Graph factories are registered at startup and invoked lazily on first
    ``get()`` call.  The compiled graph is cached after the first call.

    Raises:
        KeyError: On ``get()`` with an unknown session type.
    """

    def __init__(self) -> None:
        self._factories: dict[str, GraphFactory] = {}
        self._cache: dict[str, Any] = {}

    def register(self, session_type: str, factory: GraphFactory) -> None:
        """Register a graph factory for a session type.

        Args:
            session_type: Logical session type string (e.g. ``"investigation"``).
            factory: Zero-arg callable that returns the compiled graph.
        """
        self._factories[session_type] = factory
        # Clear any cached entry so re-registration takes effect immediately
        self._cache.pop(session_type, None)
        logger.info("graph_registered", session_type=session_type)

    def get(self, session_type: str) -> Any:
        """Return the compiled graph for a session type (sync factories only).

        Caches the result of the factory after first call.

        Args:
            session_type: Session type string.

        Returns:
            Compiled LangGraph StateGraph.

        Raises:
            KeyError: If no factory is registered for the given type.
            TypeError: If the registered factory is async (returns an
                awaitable) — use ``await aget(...)`` instead. This is a
                deliberate hard failure rather than silently caching the
                un-awaited coroutine object (see docs/harness-risk-review.md,
                F1).
        """
        if session_type not in self._factories:
            registered = list(self._factories.keys())
            raise KeyError(
                f"No graph registered for session type {session_type!r}. "
                f"Registered types: {registered}"
            )
        if session_type not in self._cache:
            result = self._factories[session_type]()
            if inspect.isawaitable(result):
                # Defensive: never cache an un-awaited coroutine. Close it (if
                # supported) so we don't leak a "coroutine was never awaited"
                # warning, then fail loudly with actionable guidance.
                close = getattr(result, "close", None)
                if callable(close):
                    close()
                raise TypeError(
                    f"Graph factory for session type {session_type!r} is async "
                    "(returned an awaitable). Use `await graph_registry.aget(...)` "
                    "instead of the synchronous `get()`."
                )
            self._cache[session_type] = result
            logger.info("graph_cached", session_type=session_type)
        return self._cache[session_type]

    async def aget(self, session_type: str) -> Any:
        """Return the compiled graph for a session type — async-safe.

        Unlike ``get()``, this transparently awaits the factory's return
        value when it is a coroutine (async factory), so it works for both
        sync and async graph factories. This is the accessor
        ``TurnWorker._execute_turn`` uses, since the production graph
        factory (``app.agent.rca_graph.get_rca_graph``) is async (it lazily
        opens a Postgres checkpointer connection pool on first call).

        Args:
            session_type: Session type string.

        Returns:
            Compiled LangGraph StateGraph.

        Raises:
            KeyError: If no factory is registered for the given type.
        """
        if session_type not in self._factories:
            registered = list(self._factories.keys())
            raise KeyError(
                f"No graph registered for session type {session_type!r}. "
                f"Registered types: {registered}"
            )
        if session_type not in self._cache:
            result = self._factories[session_type]()
            if inspect.isawaitable(result):
                result = await result
            self._cache[session_type] = result
            logger.info("graph_cached", session_type=session_type)
        return self._cache[session_type]

    def registered_types(self) -> list[str]:
        """Return all registered session type names.

        Returns:
            List of session type strings.
        """
        return list(self._factories.keys())

    def clear(self) -> None:
        """Clear all registrations and cache.  Primarily for testing.
        """
        self._factories.clear()
        self._cache.clear()


# Module-level singleton — imported and populated at app startup
graph_registry = GraphRegistry()
