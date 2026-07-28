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

Query-language fields (``expr``, ``query``) are intentionally never
mutated — see ``_QUERY_LANGUAGE_FIELDS`` below (harness-risk-review.md, F15).

Fail-closed policy: this guard handles security-sensitive redaction, so any
internal failure (unable to inspect the input, or unable to validate the
redacted input) returns ``Deny`` rather than ``Allow``. Silently letting a
tool call through un-redacted because the guard itself broke would defeat
the guard's purpose (harness-risk-review.md, F16).
"""

from __future__ import annotations

import re
from typing import Any

import structlog
from pydantic import BaseModel

from app.config import settings
from harness.guards.types import Allow, Deny, Guard, GuardVerdict, Transform
from harness.tools.protocol import CostClass

logger = structlog.get_logger()

# ---------------------------------------------------------------------------
# Query-language fields — never mutated by redaction
# ---------------------------------------------------------------------------
#
# ``expr`` (PromQL/LogQL) and ``query`` (e.g. Pyroscope label selector) hold
# raw executable query syntax. Regex-substituting a matched IP/email/number
# inside these strings silently changes what the query executes against the
# datasource — e.g. `up{instance="10.0.0.5:9100"}` would become
# `up{instance="[IP]:9100"}`, which is syntactically valid PromQL but a
# completely different (almost certainly empty-result) query. That is a
# correctness and security footgun: the mutated query silently executes
# instead of failing loudly. See harness-risk-review.md, F15.
#
# PII-looking content in these fields is still detected for audit
# visibility (a warning is logged, without echoing the raw matched value)
# but the field value itself is left untouched.
_QUERY_LANGUAGE_FIELDS: frozenset[str] = frozenset({"expr", "query"})

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

    Keys listed in ``_QUERY_LANGUAGE_FIELDS`` are never mutated — see the
    module docstring. If PII-looking content is found in one of those
    fields, it is logged (without the matched value) but the field is
    passed through unchanged and does not contribute to the returned
    ``matched`` list (it must never trigger a ``Transform`` on its own).

    Args:
        data: Dictionary to traverse and redact.

    Returns:
        Tuple of (redacted_dict, flat_list_of_matched_placeholders).
    """
    result: dict[str, Any] = {}
    all_matched: list[str] = []
    for key, value in data.items():
        if key in _QUERY_LANGUAGE_FIELDS:
            result[key] = value
            if isinstance(value, str):
                _, would_match = _redact_string(value)
                if would_match:
                    logger.warning(
                        "pii_guard_query_field_not_redacted",
                        field=key,
                        pattern_types=sorted(set(would_match)),
                    )
            continue
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
    - Walks all ``str`` fields in the tool input recursively, except
      ``_QUERY_LANGUAGE_FIELDS`` (``expr``, ``query``), which are never
      mutated because doing so would silently change what the query
      executes against the datasource (harness-risk-review.md, F15).
    - Returns ``Transform`` with redacted input if any PII pattern matched
      outside of the excluded fields.
    - Returns ``Allow`` if no (non-excluded) PII was found.
    - Returns ``Deny`` (fails closed) if the guard cannot safely inspect
      the input or cannot validate the redacted result — never silently
      falls back to ``Allow`` on its own internal errors.
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
        except Exception as exc:
            # Fail closed: if we can't even inspect the input for PII, we
            # cannot certify it is safe to pass through un-redacted.
            logger.error(
                "pii_guard_dump_failed",
                error=str(exc),
                tool_name=getattr(tool, "name", "unknown"),
            )
            return Deny(
                reason="PII guard could not inspect tool input; failing closed.",
                code="pii_guard_error",
            )

        redacted, matched = _redact_dict(raw)

        if not matched:
            return Allow()

        unique_types = sorted(set(matched))
        annotation = f"PII redacted: {', '.join(unique_types)}"

        try:
            new_input = input.model_validate(redacted)
        except Exception as exc:
            # Fail closed: PII was detected but the redacted payload could
            # not be re-validated. Falling back to Allow() here would send
            # the *original*, un-redacted, PII-bearing input through —
            # exactly the outcome this guard exists to prevent.
            logger.error(
                "pii_guard_transform_failed",
                error=str(exc),
                tool_name=tool.name,
            )
            return Deny(
                reason=(
                    "PII redaction produced an invalid tool input; failing "
                    "closed to avoid leaking unredacted content."
                ),
                code="pii_guard_error",
            )

        logger.debug(
            "pii_guard_redacted",
            tool_name=tool.name,
            pattern_types=unique_types,
        )
        return Transform(new_input=new_input, annotation=annotation)
