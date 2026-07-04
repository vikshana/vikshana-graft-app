"""GraphRegistry — maps session types to compiled LangGraph graphs.

The registry is a simple dict of ``session_type -> graph factory``.
Factories are callables that return the compiled graph; they are called
lazily on first access so the registry can be populated at import time
before the graph is initialised.

Usage::

    from harness.session.registry import graph_registry

    # At startup
    graph_registry.register("investigation", lambda: _compiled_graph)

    # At turn execution
    graph = graph_registry.get("investigation")
    await graph.ainvoke(state, config=...)
"""

from __future__ import annotations

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
        """Return the compiled graph for a session type.

        Caches the result of the factory after first call.

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
            self._cache[session_type] = self._factories[session_type]()
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
