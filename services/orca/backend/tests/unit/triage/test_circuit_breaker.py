"""Tests for harness/triage/circuit_breaker.py."""

from __future__ import annotations

import asyncio
import time

import pytest

from harness.triage.circuit_breaker import (
    CircuitBreaker,
    CircuitBreakerOpenError,
    CircuitState,
)


class TestCircuitBreakerClosed:
    async def test_successful_call_passes_through(self):
        """A successful coroutine call returns its result when CLOSED."""
        breaker = CircuitBreaker(threshold=3, timeout_s=60)

        async def ok() -> str:
            return "done"

        result = await breaker.check_and_call(lambda: ok())
        assert result == "done"
        assert breaker.state == CircuitState.CLOSED

    async def test_failure_increments_counter(self):
        """Each failure increments the failure count."""
        breaker = CircuitBreaker(threshold=5, timeout_s=60)

        async def fail():
            raise RuntimeError("boom")

        for _ in range(3):
            with pytest.raises(RuntimeError):
                await breaker.check_and_call(lambda: fail())

        assert breaker.failure_count == 3
        assert breaker.state == CircuitState.CLOSED

    async def test_threshold_failures_opens_circuit(self):
        """Exactly threshold failures opens the circuit."""
        breaker = CircuitBreaker(threshold=3, timeout_s=60)

        async def fail():
            raise RuntimeError("boom")

        for _ in range(3):
            with pytest.raises(RuntimeError):
                await breaker.check_and_call(lambda: fail())

        assert breaker.state == CircuitState.OPEN

    async def test_success_resets_failure_count(self):
        """A success resets the consecutive failure counter."""
        breaker = CircuitBreaker(threshold=5, timeout_s=60)

        async def fail():
            raise RuntimeError("boom")

        async def ok():
            return "ok"

        for _ in range(3):
            with pytest.raises(RuntimeError):
                await breaker.check_and_call(lambda: fail())

        await breaker.check_and_call(lambda: ok())
        assert breaker.failure_count == 0
        assert breaker.state == CircuitState.CLOSED


class TestCircuitBreakerOpen:
    async def test_open_circuit_rejects_calls(self):
        """Calls are rejected immediately when the circuit is OPEN."""
        breaker = CircuitBreaker(threshold=1, timeout_s=60)

        async def fail():
            raise RuntimeError("boom")

        with pytest.raises(RuntimeError):
            await breaker.check_and_call(lambda: fail())

        assert breaker.state == CircuitState.OPEN

        async def ok():
            return "ok"

        with pytest.raises(CircuitBreakerOpenError):
            await breaker.check_and_call(lambda: ok())

    async def test_open_error_has_seconds_remaining(self):
        """CircuitBreakerOpenError carries a positive seconds_remaining."""
        breaker = CircuitBreaker(threshold=1, timeout_s=60)

        async def fail():
            raise RuntimeError

        with pytest.raises(RuntimeError):
            await breaker.check_and_call(lambda: fail())

        async def ok():
            return None

        with pytest.raises(CircuitBreakerOpenError) as exc_info:
            await breaker.check_and_call(lambda: ok())

        assert exc_info.value.seconds_remaining > 0


class TestCircuitBreakerHalfOpen:
    async def test_transitions_to_half_open_after_timeout(self):
        """After timeout_s, the circuit moves from OPEN to HALF_OPEN."""
        breaker = CircuitBreaker(threshold=1, timeout_s=0)

        async def fail():
            raise RuntimeError

        with pytest.raises(RuntimeError):
            await breaker.check_and_call(lambda: fail())

        assert breaker.state == CircuitState.OPEN

        # Simulate timeout elapsed by manually patching _opened_at
        breaker._opened_at = time.monotonic() - 1  # 1 second ago, timeout=0

        async def ok():
            return "probed"

        result = await breaker.check_and_call(lambda: ok())
        assert result == "probed"
        assert breaker.state == CircuitState.CLOSED

    async def test_half_open_failure_reopens_circuit(self):
        """A failure in HALF_OPEN state reopens the circuit."""
        breaker = CircuitBreaker(threshold=1, timeout_s=0)

        async def fail():
            raise RuntimeError("boom")

        with pytest.raises(RuntimeError):
            await breaker.check_and_call(lambda: fail())

        # Force to HALF_OPEN
        breaker._state = CircuitState.HALF_OPEN

        with pytest.raises(RuntimeError):
            await breaker.check_and_call(lambda: fail())

        assert breaker.state == CircuitState.OPEN


class TestCircuitBreakerReset:
    def test_reset_clears_all_state(self):
        """reset() returns the breaker to CLOSED with zero failures."""
        breaker = CircuitBreaker(threshold=1, timeout_s=60)
        breaker._state = CircuitState.OPEN
        breaker._failure_count = 5
        breaker._opened_at = time.monotonic()

        breaker.reset()

        assert breaker.state == CircuitState.CLOSED
        assert breaker.failure_count == 0
