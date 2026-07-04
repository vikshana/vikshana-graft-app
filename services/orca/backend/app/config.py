"""Application configuration loaded from environment variables via pydantic-settings."""

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    """All Orca configuration settings loaded from environment variables.

    Attributes:
        DATABASE_URL: Async PostgreSQL connection string.
        ANTHROPIC_API_KEY: Anthropic API key for Claude models.
        LANGCHAIN_TRACING_V2: Enable LangSmith tracing.
        LANGCHAIN_API_KEY: LangSmith API key.
        LANGCHAIN_PROJECT: LangSmith project name.
        SLACK_WEBHOOK_URL: Slack incoming webhook URL (optional).
        GRAFANA_URL: Grafana instance URL.
        GRAFANA_API_KEY: Grafana API key for MCP server (local dev).
        GRAFANA_ADMIN_TOKEN: Grafana admin token used by the MCP sidecar.
        GRAFANA_MCP_URL: URL of the mcp-grafana SSE sidecar (production).
        POSTGRES_MCP_URL: URL of the mcp-postgres SSE sidecar (production).
        ORCA_MAX_INVESTIGATION_STEPS: Maximum ReAct loop iterations.
        ORCA_MAX_INVESTIGATION_TOKENS: Maximum tokens in investigation phase.
        ORCA_AGENT_TIMEOUT_SECONDS: Wall-clock timeout for the full agent run.
        ORCA_MAX_ROUNDS: Maximum interactive refinement rounds before auto-finalize.
        AUTH_ENTRA_OBO_ENABLED: Enable Entra OBO token exchange (Phase 0 feature flag).
        OIDC_ISSUER: OIDC issuer URL for OBO (Entra or mock-oauth2-server).
        ENTRA_TENANT_ID: Azure AD / Entra tenant ID.
        ENTRA_CLIENT_ID: Application (client) ID for OBO exchange.
        ENTRA_CLIENT_SECRET: Client secret for OBO exchange.
        OBO_ENCRYPTION_KEY: Fernet key (32-byte or URL-safe base64) for encrypting
            refresh tokens at rest.
        LANGFUSE_PUBLIC_KEY: Langfuse project public key for eval tracking.
        LANGFUSE_SECRET_KEY: Langfuse project secret key.
        LANGFUSE_HOST: Langfuse server URL (default: cloud; override for self-hosted).
    """

    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        case_sensitive=True,
        extra="ignore",
    )

    # Database
    DATABASE_URL: str = "postgresql+asyncpg://orca:orca@localhost:5432/orca"

    # Anthropic
    ANTHROPIC_API_KEY: str = ""

    # LangSmith (optional)
    LANGCHAIN_TRACING_V2: bool = False
    LANGCHAIN_API_KEY: str = ""
    LANGCHAIN_PROJECT: str = "orca-dev"

    # Slack (optional)
    SLACK_WEBHOOK_URL: str = ""

    # Grafana
    GRAFANA_URL: str = "http://localhost:3000"
    GRAFANA_API_KEY: str = ""  # local dev fallback; production uses GRAFANA_ADMIN_TOKEN
    GRAFANA_ADMIN_TOKEN: str = ""  # used by mcp-grafana sidecar

    # MCP servers
    # Set GRAFANA_MCP_URL to enable SSE sidecar mode (production).
    # Leave unset to fall back to stdio subprocess (local dev).
    GRAFANA_MCP_URL: str = ""
    # Set POSTGRES_MCP_URL to enable SSE sidecar mode for the Postgres MCP.
    # Leave unset to fall back to stdio subprocess (local dev).
    POSTGRES_MCP_URL: str = ""

    # Agent tuning
    ORCA_MAX_INVESTIGATION_STEPS: int = 15
    ORCA_MAX_INVESTIGATION_TOKENS: int = 100_000
    ORCA_AGENT_TIMEOUT_SECONDS: int = 300
    ORCA_MAX_ROUNDS: int = 5

    # Deduplication — window (in minutes) within which identical alerts are
    # considered duplicates of the first, even if no investigation is active.
    ORCA_DEDUP_WINDOW_MINUTES: int = 30

    # -------------------------------------------------------------------------
    # Auth chain (Phase 0, Task 0.2)
    # -------------------------------------------------------------------------
    # Feature flag: set to true to activate Entra OBO as the preferred auth path.
    # When false (default), the service falls back to per-team service accounts.
    AUTH_ENTRA_OBO_ENABLED: bool = False

    # OIDC issuer for OBO exchange.
    # Dev: http://mock-oauth2-server:8080/default
    # Production: https://login.microsoftonline.com/{tenant_id}/v2.0
    OIDC_ISSUER: str = "http://localhost:9090/default"

    # Entra / Azure AD application registration
    ENTRA_TENANT_ID: str = ""
    ENTRA_CLIENT_ID: str = ""
    ENTRA_CLIENT_SECRET: str = ""

    # Fernet key for encrypting refresh tokens at rest.
    # Dev default: 32 zero bytes (base64-padded).  Override in production.
    OBO_ENCRYPTION_KEY: str = "devkey00000000000000000000000000"

    # -------------------------------------------------------------------------
    # Langfuse — LLM eval tracking (Phase 1, Task 1.6)
    # -------------------------------------------------------------------------
    LANGFUSE_PUBLIC_KEY: str = "lf-pk-dev-0000000000000000"
    LANGFUSE_SECRET_KEY: str = "lf-sk-dev-0000000000000000"
    LANGFUSE_HOST: str = "http://localhost:4100"


settings = Settings()
