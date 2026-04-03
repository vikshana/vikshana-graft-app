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
    GRAFANA_URL: str = "http://localhost:3002"
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


settings = Settings()
