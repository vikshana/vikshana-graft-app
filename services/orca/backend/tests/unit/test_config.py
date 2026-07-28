"""Unit tests for app/config.py — Settings.validate_production_secrets().

Covers docs/harness-risk-review.md F8 (OBO/MCP encryption keys) and the
AGENT_INTERNAL_SECRET production requirement added alongside F4/F7 hardening:
InternalAuthMiddleware must not be able to silently run as a pass-through in
a production deployment.

Each test constructs a fresh `Settings(...)` instance with explicit keyword
arguments rather than mutating the module-level `settings` singleton or the
process environment — pydantic-settings gives explicit init kwargs the
highest precedence, so these tests are fully isolated from whatever the
runner's actual environment/.env file contains.
"""

from __future__ import annotations

from app.config import Settings


def _prod_settings(**overrides: object) -> Settings:
    """Build a `Settings` instance with all production secrets valid by
    default, so each test only needs to override the one field it's
    exercising."""
    base: dict[str, object] = {
        "ENVIRONMENT": "production",
        "OBO_ENCRYPTION_KEY": "a-real-32-byte-fernet-key-not-the-dev-default",
        "MCP_ENCRYPTION_KEY": "a-real-32-byte-fernet-key-for-mcp-tokens",
        "AGENT_INTERNAL_SECRET": "a-real-shared-hmac-secret",
    }
    base.update(overrides)
    return Settings(**base)  # type: ignore[arg-type]


class TestIsProduction:
    def test_default_is_not_production(self):
        assert Settings().is_production() is False

    def test_production_case_insensitive(self):
        assert Settings(ENVIRONMENT="Production").is_production() is True
        assert Settings(ENVIRONMENT="PRODUCTION").is_production() is True

    def test_development_is_not_production(self):
        assert Settings(ENVIRONMENT="development").is_production() is False


class TestValidateProductionSecretsDevelopment:
    def test_development_never_errors_even_with_empty_secrets(self):
        """Non-production environments are never gated — dev/test must keep
        working with no secrets configured at all."""
        settings = Settings(
            ENVIRONMENT="development",
            OBO_ENCRYPTION_KEY="",
            MCP_ENCRYPTION_KEY="",
            AGENT_INTERNAL_SECRET="",
        )
        assert settings.validate_production_secrets() == []


class TestValidateProductionSecretsAgentInternalSecret:
    """AGENT_INTERNAL_SECRET is required in production — an empty value would
    let InternalAuthMiddleware silently pass every request through with no
    signature check (docs/harness-risk-review.md F4)."""

    def test_all_secrets_valid_passes(self):
        assert _prod_settings().validate_production_secrets() == []

    def test_empty_agent_internal_secret_rejected(self):
        settings = _prod_settings(AGENT_INTERNAL_SECRET="")
        errors = settings.validate_production_secrets()
        assert len(errors) == 1
        assert "AGENT_INTERNAL_SECRET" in errors[0]

    def test_error_message_mentions_protected_prefixes_or_pass_through(self):
        settings = _prod_settings(AGENT_INTERNAL_SECRET="")
        (error,) = settings.validate_production_secrets()
        assert "pass-through" in error or "signature" in error

    def test_only_agent_internal_secret_error_when_others_valid(self):
        """Sanity check: the new check is independent of the pre-existing
        OBO/MCP checks — fixing only AGENT_INTERNAL_SECRET should leave
        exactly zero errors when the other two are already valid."""
        settings = _prod_settings(AGENT_INTERNAL_SECRET="")
        errors = settings.validate_production_secrets()
        assert not any("OBO_ENCRYPTION_KEY" in e for e in errors)
        assert not any("MCP_ENCRYPTION_KEY" in e for e in errors)


class TestValidateProductionSecretsCombinations:
    """All three production secret checks (OBO, MCP, AGENT_INTERNAL) are
    independent and additive — verify they can fire together."""

    def test_all_three_empty_reports_three_errors(self):
        settings = Settings(
            ENVIRONMENT="production",
            OBO_ENCRYPTION_KEY="",
            MCP_ENCRYPTION_KEY="",
            AGENT_INTERNAL_SECRET="",
        )
        errors = settings.validate_production_secrets()
        assert len(errors) == 3

    def test_dev_default_obo_key_still_rejected_alongside_agent_secret(self):
        """Regression guard for F8: the hardcoded dev default must still be
        rejected even after adding the AGENT_INTERNAL_SECRET check."""
        settings = _prod_settings(
            OBO_ENCRYPTION_KEY="devkey00000000000000000000000000",
            AGENT_INTERNAL_SECRET="",
        )
        errors = settings.validate_production_secrets()
        assert len(errors) == 2
        assert any("OBO_ENCRYPTION_KEY" in e for e in errors)
        assert any("AGENT_INTERNAL_SECRET" in e for e in errors)
