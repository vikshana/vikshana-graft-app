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
        SLACK_BOT_TOKEN: Slack OAuth bot token (xoxb-...) for Bolt interactions.
        SLACK_APP_TOKEN: Slack app-level token (xapp-...) for Socket Mode.
        SLACK_SIGNING_SECRET: Slack signing secret for HTTP-mode request verification.
        IDENTITY_LINK_STATE_TTL_S: TTL (seconds) for PKCE link-request state records.
        ALERT_TRIAGE_MAX_CONCURRENT: Max concurrent auto-triage sessions (semaphore cap).
        ALERT_TRIAGE_CIRCUIT_BREAKER_THRESHOLD: Consecutive failures to open the circuit.
        ALERT_TRIAGE_CIRCUIT_BREAKER_TIMEOUT_S: Cool-down seconds before half-open probe.
        AGENT_INTERNAL_SECRET: Shared HMAC secret used by ``InternalAuthMiddleware``
            to validate ``X-Agent-Signature`` on internal requests proxied from the
            Grafana Go plugin (``pkg/plugin/internal_signer.go`` signs with the same
            value). Empty disables signature validation entirely (dev-mode
            pass-through) — ``validate_production_secrets`` refuses to start with it
            empty when ``ENVIRONMENT=production``. Must be identical on both sides
            of the proxy; see docker-compose.yaml and docs/harness-risk-review.md F4.
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

    # -------------------------------------------------------------------------
    # Slack integration (Phase 3)
    # -------------------------------------------------------------------------
    # Incoming webhook URL for simple notifications (legacy; Bolt supersedes this
    # for interactive flows but it is retained for backward compat).
    SLACK_WEBHOOK_URL: str = ""
    # OAuth bot token (xoxb-...) — required for Bolt slash commands and posting.
    SLACK_BOT_TOKEN: str = ""
    # Socket Mode app-level token (xapp-...) — required for Socket Mode (no public URL).
    SLACK_APP_TOKEN: str = ""
    # Signing secret — used to verify HTTP-mode request signatures.
    SLACK_SIGNING_SECRET: str = ""

    # Grafana organisation ID to tag onto sessions created via Slack.
    # Slack slash commands carry no Grafana org context of their own (no
    # equivalent of the X-Grafana-Org-Id header the Go gateway injects for
    # HTTP-originated sessions); a Slack app installation is assumed to
    # correspond to a single Grafana org for now. None means org_id is left
    # unset on Slack-created sessions (multi-org Slack workspaces are not
    # yet supported).
    SLACK_DEFAULT_ORG_ID: int | None = None

    # -------------------------------------------------------------------------
    # Identity linkage (Phase 3, Task 3.1)
    # -------------------------------------------------------------------------
    # TTL for PKCE state stored in identity_link_requests (seconds).
    IDENTITY_LINK_STATE_TTL_S: int = 600  # 10 minutes

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
    # Internal auth (Phase 2, hardened Phase 4 — F4/F7/F8)
    # -------------------------------------------------------------------------
    # Shared HMAC secret validated by InternalAuthMiddleware on every request
    # to /api/sessions, /api/mcp, /api/identity, and /api/rca. The Grafana Go
    # plugin gateway (pkg/plugin/internal_signer.go) must sign with this exact
    # same value — see docker-compose.yaml, which sources both sides from a
    # single AGENT_INTERNAL_SECRET entry in the root .env file.
    #
    # Empty (the default) disables signature validation entirely — acceptable
    # for local dev, refused at startup in production (see
    # validate_production_secrets below).
    AGENT_INTERNAL_SECRET: str = ""

    # -------------------------------------------------------------------------
    # Phase 1 harness settings
    # -------------------------------------------------------------------------

    # LLM provider selection
    LLM_PROVIDER: str = "anthropic"  # "anthropic" | "openai_compat"
    LLM_MODEL: str = "claude-sonnet-4-5"

    # OpenAI-compatible provider settings (only used when LLM_PROVIDER=openai_compat)
    OPENAI_API_KEY: str = ""
    OPENAI_BASE_URL: str = ""
    AZURE_OPENAI_ENDPOINT: str = ""
    AZURE_OPENAI_API_VERSION: str = "2024-02-01"

    # Skills directory — provisioned by platform admins, not user-writable
    SKILLS_DIR: str = "/skills"

    # RBAC — Grafana roles allowed to use the agent
    # Env format: RBAC_ALLOWED_ROLES='["Admin","Editor"]'
    RBAC_ALLOWED_ROLES: list[str] = ["Admin", "Editor"]

    # Query cost guard
    MAX_QUERY_RANGE_HOURS: int = 24

    # Timeout guards (seconds)
    TOOL_TIMEOUT_S: int = 30
    TURN_TIMEOUT_S: int = 120
    SESSION_TIMEOUT_S: int = 1800

    # Loop guard
    MAX_TOOL_CALLS_PER_TURN: int = 25

    # Budget guards (tokens)
    BUDGET_SESSION_TOKENS: int = 100_000
    BUDGET_USER_DAILY_TOKENS: int = 500_000
    BUDGET_GLOBAL_DAILY_TOKENS: int = 10_000_000

    # Turn worker poll interval
    TURN_WORKER_POLL_MS: int = 200

    # -------------------------------------------------------------------------
    # Alert auto-triage (Phase 3, Task 3.3)
    # -------------------------------------------------------------------------
    # Maximum number of alert sessions that can be triaged concurrently.
    ALERT_TRIAGE_MAX_CONCURRENT: int = 10
    # Number of consecutive datasource-query failures before the circuit opens.
    ALERT_TRIAGE_CIRCUIT_BREAKER_THRESHOLD: int = 5
    # Seconds to wait in OPEN state before attempting a half-open probe.
    ALERT_TRIAGE_CIRCUIT_BREAKER_TIMEOUT_S: int = 60

    # Phase 4 — Security hardening
    HARNESS_PII_REDACTION_ENABLED: bool = False

    # Phase 4 — MCP server integration
    MCP_ENCRYPTION_KEY: str = ""  # 32-byte URL-safe base64; empty = no-op (dev only)

    # Phase 4 — MCP client-manager cross-replica convergence (F10)
    # `MCPClientManager` state is per-replica in-memory; Postgres is the
    # runtime source of truth. Two independent mechanisms keep replicas
    # converged without a restart — see harness/mcp/client_manager.py.
    #
    # Bounded periodic background reconciliation interval (seconds).
    MCP_RECONCILE_INTERVAL_S: int = 30
    # Max staleness (seconds) tolerated by an API read/write before it
    # forces a synchronous reconcile ("invalidation on access") — so a
    # request landing on a replica shortly after another replica's
    # add/toggle/reconnect/delete still observes the change instead of
    # waiting for the next periodic tick. Set to 0 to disable.
    MCP_RECONCILE_TTL_S: int = 10

    # Deployment environment: "development" | "production".
    # In production, insecure default/empty encryption keys are rejected at startup.
    ENVIRONMENT: str = "development"

    # The hardcoded development default for OBO_ENCRYPTION_KEY. Startup validation
    # rejects this exact value when ENVIRONMENT=production.
    _INSECURE_OBO_KEY_DEFAULT: str = "devkey00000000000000000000000000"

    def is_production(self) -> bool:
        """Return True when running in a production deployment."""
        return self.ENVIRONMENT.strip().lower() == "production"

    def validate_production_secrets(self) -> list[str]:
        """Return a list of insecure-secret errors for a production deployment.

        Empty list means the configuration is safe. Non-empty means startup
        should abort. Only enforced when ``is_production()`` is True.

        Returns:
            List of human-readable error strings.
        """
        errors: list[str] = []
        if not self.is_production():
            return errors

        if not self.OBO_ENCRYPTION_KEY or self.OBO_ENCRYPTION_KEY == self._INSECURE_OBO_KEY_DEFAULT:
            errors.append(
                "OBO_ENCRYPTION_KEY is empty or set to the insecure development default; "
                "set a real Fernet key in production."
            )
        if self.AUTH_ENTRA_OBO_ENABLED and not self.OBO_ENCRYPTION_KEY:
            errors.append("AUTH_ENTRA_OBO_ENABLED is true but OBO_ENCRYPTION_KEY is empty.")
        if not self.MCP_ENCRYPTION_KEY:
            errors.append(
                "MCP_ENCRYPTION_KEY is empty; MCP bearer tokens would be stored in plaintext. "
                "Set a 32-byte URL-safe base64 Fernet key in production."
            )
        if not self.AGENT_INTERNAL_SECRET:
            errors.append(
                "AGENT_INTERNAL_SECRET is empty; InternalAuthMiddleware would run as a "
                "transparent pass-through, leaving /api/sessions, /api/mcp, /api/identity, "
                "and /api/rca reachable by anything with network access to this service "
                "with no signature check (see docs/harness-risk-review.md F4). Set the same "
                "shared secret here and on the Grafana Go plugin (AGENT_INTERNAL_SECRET env "
                "var) in production."
            )
        return errors


settings = Settings()
