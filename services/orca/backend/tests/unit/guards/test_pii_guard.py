"""Unit tests for PIIRedactionGuard."""

from __future__ import annotations

from typing import Any
from unittest.mock import patch

import pytest
from pydantic import BaseModel

from harness.guards.pii import PIIRedactionGuard, _redact_string
from harness.guards.types import Allow, Transform
from harness.tools.protocol import CostClass


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


class _SimpleTool:
    def __init__(self, cost_class: CostClass) -> None:
        self.name = "test_tool"
        self.cost_class = cost_class


class _Input(BaseModel):
    expr: str = ""
    label: str = ""
    nested: dict[str, Any] = {}


def _make_ctx() -> Any:
    return None


async def _eval(
    tool_cost: CostClass,
    enabled: bool = True,
    **kwargs: Any,
) -> Any:
    guard = PIIRedactionGuard()
    tool = _SimpleTool(tool_cost)
    inp = _Input(**kwargs)
    with patch("harness.guards.pii.settings") as mock_settings:
        mock_settings.HARNESS_PII_REDACTION_ENABLED = enabled
        return await guard.evaluate(tool, inp, _make_ctx())


# ---------------------------------------------------------------------------
# Feature flag
# ---------------------------------------------------------------------------


class TestFeatureFlag:
    async def test_disabled_flag_allows_everything(self) -> None:
        verdict = await _eval(CostClass.QUERY, enabled=False, expr="user@example.com")
        assert isinstance(verdict, Allow)

    async def test_cheap_tool_always_allows(self) -> None:
        verdict = await _eval(CostClass.CHEAP, enabled=True, expr="user@example.com")
        assert isinstance(verdict, Allow)


# ---------------------------------------------------------------------------
# Email
# ---------------------------------------------------------------------------


class TestEmailRedaction:
    async def test_email_in_expr_is_redacted(self) -> None:
        verdict = await _eval(CostClass.QUERY, expr="filter by user=alice@example.com")
        assert isinstance(verdict, Transform)
        assert "[EMAIL]" in verdict.annotation
        assert "alice@example.com" not in verdict.new_input.expr  # type: ignore[union-attr]

    async def test_no_email_allows(self) -> None:
        verdict = await _eval(CostClass.QUERY, expr="rate(http_requests_total[5m])")
        assert isinstance(verdict, Allow)

    async def test_multiple_emails_all_redacted(self) -> None:
        _, matched = _redact_string("a@a.com and b@b.org")
        assert len(matched) == 2


# ---------------------------------------------------------------------------
# IPv4
# ---------------------------------------------------------------------------


class TestIPv4Redaction:
    async def test_ipv4_in_label_is_redacted(self) -> None:
        verdict = await _eval(CostClass.QUERY, label="src_ip=192.168.1.100")
        assert isinstance(verdict, Transform)
        assert "[IP]" in verdict.annotation

    async def test_no_ip_allows(self) -> None:
        verdict = await _eval(CostClass.QUERY, label="service=checkout")
        assert isinstance(verdict, Allow)


# ---------------------------------------------------------------------------
# IPv6
# ---------------------------------------------------------------------------


class TestIPv6Redaction:
    @pytest.mark.parametrize("ipv6", [
        "2001:db8::1",
        "fe80:0000:0000:0000:0204:61ff:fe9d:f156",
    ])
    def test_ipv6_pattern_matches(self, ipv6: str) -> None:
        _, matched = _redact_string(f"host={ipv6}")
        assert matched  # at least one pattern matched


# ---------------------------------------------------------------------------
# Phone
# ---------------------------------------------------------------------------


class TestPhoneRedaction:
    async def test_e164_phone_redacted(self) -> None:
        verdict = await _eval(CostClass.WRITE, expr="contact +447911123456 for support")
        assert isinstance(verdict, Transform)
        assert "[PHONE]" in verdict.annotation


# ---------------------------------------------------------------------------
# IBAN
# ---------------------------------------------------------------------------


class TestIBANRedaction:
    def test_iban_pattern_matches(self) -> None:
        _, matched = _redact_string("iban=GB29NWBK60161331926819")
        assert "[IBAN]" in matched


# ---------------------------------------------------------------------------
# Credit card
# ---------------------------------------------------------------------------


class TestCardRedaction:
    @pytest.mark.parametrize("card", [
        "4111111111111111",
        "4111-1111-1111-1111",
        "4111 1111 1111 1111",
    ])
    def test_card_formats_matched(self, card: str) -> None:
        _, matched = _redact_string(card)
        assert matched


# ---------------------------------------------------------------------------
# SSN
# ---------------------------------------------------------------------------


class TestSSNRedaction:
    def test_ssn_format_matched(self) -> None:
        _, matched = _redact_string("ssn=123-45-6789")
        assert "[SSN]" in matched


# ---------------------------------------------------------------------------
# Grafana user ID
# ---------------------------------------------------------------------------


class TestGrafanaUIDRedaction:
    async def test_grafana_user_id_label_redacted(self) -> None:
        verdict = await _eval(CostClass.QUERY, expr="grafana_user_id=42")
        assert isinstance(verdict, Transform)
        assert "[UID]" in verdict.new_input.expr  # type: ignore[union-attr]


# ---------------------------------------------------------------------------
# Nested dict redaction
# ---------------------------------------------------------------------------


class TestNestedRedaction:
    async def test_nested_dict_values_redacted(self) -> None:
        verdict = await _eval(
            CostClass.QUERY,
            nested={"filters": {"email": "bad@evil.com"}},
        )
        assert isinstance(verdict, Transform)

    async def test_clean_nested_dict_allows(self) -> None:
        verdict = await _eval(
            CostClass.QUERY,
            nested={"service": "checkout", "env": "prod"},
        )
        assert isinstance(verdict, Allow)


# ---------------------------------------------------------------------------
# No PII — passthrough
# ---------------------------------------------------------------------------


class TestNoPII:
    async def test_clean_query_input_allows(self) -> None:
        verdict = await _eval(
            CostClass.QUERY,
            expr="sum(rate(http_requests_total{job='api'}[5m]))",
            label="env=production",
        )
        assert isinstance(verdict, Allow)
