"""Guard pipeline types — verdict union and decision dataclass."""

from __future__ import annotations

import time
from dataclasses import dataclass, field
from typing import Any

from pydantic import BaseModel


@dataclass(frozen=True)
class Allow:
    """Guard allows the tool call to proceed."""


@dataclass(frozen=True)
class Deny:
    """Guard denies the tool call.

    Attributes:
        reason: Human-readable explanation.
        code: Machine-readable code (rbac, cost, budget, timeout, loop, write).
    """

    reason: str
    code: str


@dataclass(frozen=True)
class ApprovalRequired:
    """Guard requires explicit human approval before the tool may execute.

    Attributes:
        payload: The tool call payload to present to the approver.
        reason: Human-readable reason for requiring approval.
    """

    payload: dict[str, Any]
    reason: str = "Write operation requires approval"


@dataclass(frozen=True)
class Transform:
    """Guard transforms the tool input (e.g. clamps time range).

    Attributes:
        new_input: Replacement Pydantic model instance.
        annotation: Description of the transformation applied.
    """

    new_input: BaseModel
    annotation: str


# Union type for guard verdicts
GuardVerdict = Allow | Deny | ApprovalRequired | Transform


@dataclass
class GuardDecision:
    """The decision record for a single guard's evaluation.

    Attributes:
        guard_name: Name of the guard that produced this decision.
        verdict: The verdict (Allow, Deny, ApprovalRequired, or Transform).
        duration_ms: Wall-clock time the guard took to evaluate.
        audit_attrs: Extra key-value attributes for the audit log.
    """

    guard_name: str
    verdict: GuardVerdict
    duration_ms: float = 0.0
    audit_attrs: dict[str, Any] = field(default_factory=dict)


class Guard:
    """Base class for all guard implementations.

    Subclasses must implement ``async evaluate(tool, input, ctx) -> GuardVerdict``.
    """

    name: str = "base_guard"

    async def evaluate(
        self,
        tool: Any,
        input: BaseModel,
        ctx: Any,
    ) -> GuardVerdict:
        """Evaluate whether this tool call should proceed.

        Args:
            tool: Tool instance (has name, cost_class, etc.).
            input: Validated Pydantic input for the tool.
            ctx: ToolContext with session, credential, budget, spend.

        Returns:
            GuardVerdict — Allow, Deny, ApprovalRequired, or Transform.
        """
        raise NotImplementedError  # pragma: no cover
