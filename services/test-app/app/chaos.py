from dataclasses import dataclass
from typing import Literal

ChaosMode = Literal["error", "latency", "exception"]


@dataclass
class ChaosState:
    enabled: bool = False
    mode: ChaosMode | None = None


_state = ChaosState()


def get_state() -> ChaosState:
    return _state


def enable(mode: ChaosMode) -> None:
    _state.enabled = True
    _state.mode = mode


def disable() -> None:
    _state.enabled = False
    _state.mode = None
