"""Circuit breaker for protecting downstream datasource calls.

Implements the standard three-state circuit breaker pattern:

    CLOSED  → calls pass through; failure count increments on error.
    OPEN    → calls are rejected immediately (CircuitBreakerOpenError).
              After ``timeout_s`` seconds the breaker moves to HALF_OPEN.
    HALF_OPEN → the next call is a probe.
              Success → CLOSED (reset counter).
              Failure → OPEN (reset timer).

The breaker is asyncio-safe: state transitions are protected by an
``asyncio.Lock`` to prevent TOCTOU races under concurrent load.

Usage::

    breaker = CircuitBreaker(threshold=5, timeout_s=60)

    try:
        result = await breaker.check_and_call(my_coroutine())
    except CircuitBreakerOpenError:
        # Circuit is open — return cached/fallback response
        ...
"""

from __future__ import annotations

import asyncio
import time
from collections.abc import Callable
from enum import Enum, auto
from typing import Any, Awaitable, TypeVar

import structlog

logger = structlog.get_logger()

T = TypeVar("T")


class CircuitState(Enum):
    """Circuit breaker states."""

    CLOSED = auto()
    OPEN = auto()
    HALF_OPEN = auto()


class CircuitBreakerOpenError(Exception):
    """Raised when a call is attempted while the circuit is OPEN."""

    def __init__(self, seconds_remaining: float = 0.0) -> None:
        self.seconds_remaining = seconds_remaining
        super().__init__(
            f"Circuit is OPEN — retry in {seconds_remaining:.1f}s"
            if seconds_remaining > 0
            else "Circuit is OPEN"
        )


class CircuitBreaker:
    """Async-safe three-state circuit breaker.

    Args:
        threshold: Number of consecutive failures before opening the circuit.
        timeout_s: Seconds to wait in OPEN state before probing (HALF_OPEN).
        name: Optional name for log context.
    """

    def __init__(
        self,
        threshold: int = 5,
        timeout_s: int = 60,
        name: str = "default",
    ) -> None:
        self._threshold = threshold
        self._timeout_s = timeout_s
        self._name = name
        self._state = CircuitState.CLOSED
        self._failure_count = 0
        self._opened_at: float | None = None
        self._lock = asyncio.Lock()

    @property
    def state(self) -> CircuitState:
        """Current circuit state (may be stale — use ``check_and_call`` for accurate state)."""
        return self._state

    @property
    def failure_count(self) -> int:
        """Current consecutive failure count."""
        return self._failure_count

    async def check_and_call(self, coro_fn: Callable[[], Awaitable[T]]) -> T:
        """Execute the coroutine produced by *coro_fn* if the circuit allows it.

        Accepts a **zero-argument callable** (factory) rather than a pre-created
        coroutine.  This prevents coroutine-leak warnings: if the circuit is OPEN
        the factory is never called, so no coroutine object is created and nothing
        goes un-awaited.

        Automatically transitions state based on success/failure:
        - Success: resets failure counter (stays/transitions to CLOSED).
        - Failure: increments counter; opens circuit on threshold.

        Args:
            coro_fn: Zero-arg callable that returns an awaitable when called.
                     Example: ``lambda: my_coro(arg1, arg2)``

        Returns:
            The result of ``await coro_fn()``.

        Raises:
            CircuitBreakerOpenError: If the circuit is OPEN and the
                cool-down period has not elapsed.
        """
        async with self._lock:
            await self._maybe_half_open()
            if self._state == CircuitState.OPEN:
                remaining = self._seconds_until_half_open()
                logger.warning(
                    "circuit_breaker_rejected",
                    name=self._name,
                    seconds_remaining=remaining,
                )
                raise CircuitBreakerOpenError(seconds_remaining=remaining)

        try:
            result = await coro_fn()
            await self._on_success()
            return result
        except Exception:
            await self._on_failure()
            raise

    async def _maybe_half_open(self) -> None:
        """Transition OPEN → HALF_OPEN if the timeout has elapsed.

        Must be called while holding ``self._lock``.
        """
        if self._state == CircuitState.OPEN and self._opened_at is not None:
            elapsed = time.monotonic() - self._opened_at
            if elapsed >= self._timeout_s:
                self._state = CircuitState.HALF_OPEN
                logger.info("circuit_breaker_half_open", name=self._name)

    def _seconds_until_half_open(self) -> float:
        """Return seconds remaining until the circuit moves to HALF_OPEN."""
        if self._opened_at is None:
            return 0.0
        elapsed = time.monotonic() - self._opened_at
        return max(0.0, self._timeout_s - elapsed)

    async def _on_success(self) -> None:
        """Record a success and reset the breaker if needed."""
        async with self._lock:
            self._failure_count = 0
            if self._state in (CircuitState.HALF_OPEN, CircuitState.OPEN):
                self._state = CircuitState.CLOSED
                self._opened_at = None
                logger.info("circuit_breaker_closed", name=self._name)

    async def _on_failure(self) -> None:
        """Record a failure and open the circuit if the threshold is reached."""
        async with self._lock:
            self._failure_count += 1
            log = logger.bind(name=self._name, failures=self._failure_count)

            if self._state == CircuitState.HALF_OPEN:
                # Probe failed — back to OPEN
                self._state = CircuitState.OPEN
                self._opened_at = time.monotonic()
                log.warning("circuit_breaker_probe_failed_reopened")
            elif self._failure_count >= self._threshold:
                self._state = CircuitState.OPEN
                self._opened_at = time.monotonic()
                log.warning(
                    "circuit_breaker_opened",
                    threshold=self._threshold,
                )
            else:
                log.debug("circuit_breaker_failure_recorded")

    def reset(self) -> None:
        """Force reset the breaker to CLOSED state (for testing / manual recovery)."""
        self._state = CircuitState.CLOSED
        self._failure_count = 0
        self._opened_at = None
