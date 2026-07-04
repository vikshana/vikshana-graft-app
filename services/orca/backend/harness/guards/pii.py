"""PII Redaction Guard — scrubs GDPR-sensitive data from tool inputs.

Enabled via ``HARNESS_PII_REDACTION_ENABLED=true`` (default: off).
Only applies to ``QUERY`` and ``WRITE`` cost-class tools; CHEAP
informational tools are passed through unchanged.

Patterns covered (GDPR Article 4 personal data categories):
  - Email addresses
  - IPv4 and IPv6 addresses
  - E.164 phone numbers
  - IBANs
  - Credit / debit card numbers (PAN)
  - SSN-like numbers (US format)
  - Grafana user ID label values
"""

from __future__ import annotations

import re
from typing import Any

import structlog
from pydantic import BaseModel

from app.config import settings
from harness.guards.types import Allow, Guard, GuardVerdict, Transform
from harness.tools.protocol import CostClass

logger = structlog.get_logger()

# ---------------------------------------------------------------------------
# PII patterns — (compiled_regex, placeholder) pairs
# ---------------------------------------------------------------------------

_PATTERNS: list[tuple[re.Pattern[str], str]] = [
    # Email — RFC 5321 local-part @ domain
    (
        re.compile(
            r"[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}",
            re.IGNORECASE,
        ),
        "[EMAIL]",
    ),
    # IPv4
    (
        re.compile(r"\b(?:\d{1,3}\.){3}\d{1,3}\b"),
        "[IP]",
    ),
    # IPv6 — full or compressed (contains at least two colon-separated hex groups)
    (
        re.compile(
            r"\b(?:[0-9a-fA-F]{1,4}:){2,7}[0-9a-fA-F]{1,4}\b"
            r"|::(?:[0-9a-fA-F]{1,4}:)*[0-9a-fA-F]{1,4}"
            r"|[0-9a-fA-F]{1,4}::(?:[0-9a-fA-F]{1,4}:)*[0-9a-fA-F]{1,4}",
            re.IGNORECASE,
        ),
        "[IP]",
    ),
    # E.164 phone number (international format, 7–15 digits)
    (
        re.compile(r"\+?[1-9]\d{6,14}\b"),
        "[PHONE]",
    ),
    # IBAN (2 alpha + 2 digit + up to 30 alphanumeric)
    (
        re.compile(r"\b[A-Z]{2}\d{2}[A-Z0-9]{4,30}\b"),
        "[IBAN]",
    ),
    # Payment card (PAN) — 16 digits, optional separators
    (
        re.compile(r"\b\d{4}[\ \-]?\d{4}[\ \-]?\d{4}[\ \-]?\d{4}\b"),
        "[CARD]",
    ),
    # US SSN — NNN-NN-NNNN or NNN NN NNNN
    (
        re.compile(r"\b\d{3}[-\ ]\d{2}[-\ ]\d{4}\b"),
        "[SSN]",
    ),
    # Grafana user ID label value
    (
        re.compile(r"grafana_user_id=\d+", re.IGNORECASE),
        "grafana_user_id=[UID]",
    ),
]


def _redact_string(value: str) -> tuple[str, list[str]]:
    """Apply all PII patterns to a string value.

    Args:
        value: Input string to redact.

    Returns:
        Tuple of (redacted_string, list_of_matched_pattern_names).
        list_of_matched_pattern_names is empty when nothing was redacted.
    """
    redacted = value
    matched: list[str] = []
    for pattern, placeholder in _PATTERNS:
        new_value, n = pattern.subn(placeholder, redacted)
        if n > 0:
            matched.extend([placeholder] * n)
            redacted = new_value
    return redacted, matched


def _redact_dict(data: dict[str, Any]) -> tuple[dict[str, Any], list[str]]:
    """Recursively redact PII from all string values in a dict.

    Args:
        data: Dictionary to traverse and redact.

    Returns:
        Tuple of (redacted_dict, flat_list_of_matched_placeholders).
    """
    result: dict[str, Any] = {}
    all_matched: list[str] = []
    for key, value in data.items():
        if isinstance(value, str):
            redacted, matched = _redact_string(value)
            result[key] = redacted
            all_matched.extend(matched)
        elif isinstance(value, dict):
            redacted_dict, matched = _redact_dict(value)
            result[key] = redacted_dict
            all_matched.extend(matched)
        elif isinstance(value, list):
            redacted_list: list[Any] = []
            for item in value:
                if isinstance(item, str):
                    redacted_item, matched = _redact_string(item)
                    redacted_list.append(redacted_item)
                    all_matched.extend(matched)
                elif isinstance(item, dict):
                    redacted_item_dict, matched = _redact_dict(item)
                    redacted_list.append(redacted_item_dict)
                    all_matched.extend(matched)
                else:
                    redacted_list.append(item)
            result[key] = redacted_list
        else:
            result[key] = value
    return result, all_matched


class PIIRedactionGuard(Guard):
    """Redacts GDPR-sensitive data from QUERY and WRITE tool inputs.

    Behaviour:
    - Returns ``Allow()`` immediately when ``HARNESS_PII_REDACTION_ENABLED``
      is ``False`` (default) — zero overhead when disabled.
    - Returns ``Allow()`` for ``CostClass.CHEAP`` tools (informational
      read-only tools that never handle user input).
    - Walks all ``str`` fields in the tool input recursively.
    - Returns ``Transform`` with redacted input if any PII pattern matched.
    - Returns ``Allow`` if no PII was found.
    """

    name = "pii_redaction"

    async def evaluate(self, tool: Any, input: BaseModel, ctx: Any) -> GuardVerdict:
        """Evaluate PII content in the tool input.

        Args:
            tool: Tool about to be called.
            input: Pydantic model representing the tool input.
            ctx: Tool context (unused).

        Returns:
            Allow, or Transform with redacted input.
        """
        if not getattr(settings, "HARNESS_PII_REDACTION_ENABLED", False):
            return Allow()

        if tool.cost_class == CostClass.CHEAP:
            return Allow()

        try:
            raw = input.model_dump()
        except Exception:
            return Allow()

        redacted, matched = _redact_dict(raw)

        if not matched:
            return Allow()

        unique_types = sorted(set(matched))
        annotation = f"PII redacted: {', '.join(unique_types)}"

        try:
            new_input = input.model_validate(redacted)
        except Exception as exc:
            logger.warning(
                "pii_guard_transform_failed",
                error=str(exc),
                tool_name=tool.name,
            )
            return Allow()

        logger.debug(
            "pii_guard_redacted",
            tool_name=tool.name,
            pattern_types=unique_types,
        )
        return Transform(new_input=new_input, annotation=annotation)
