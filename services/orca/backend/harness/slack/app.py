"""Slack Bolt app instance and Socket Mode handler factory.

The module creates a single ``AsyncApp`` and exposes a factory for creating
an ``AsyncSocketModeHandler``.  The app is only active when
``SLACK_BOT_TOKEN`` is non-empty; the factory only starts a Socket Mode
connection when ``SLACK_APP_TOKEN`` is non-empty.  Both conditions are
checked at runtime so the application starts cleanly in CI and dev
environments without Slack credentials.

Usage in lifespan (app/main.py)::

    if settings.SLACK_APP_TOKEN:
        from harness.slack.app import create_socket_mode_handler
        _slack_handler = create_socket_mode_handler()
        asyncio.create_task(_slack_handler.start_async())

    # On shutdown:
    if _slack_handler is not None:
        await _slack_handler.close_async()
"""

from __future__ import annotations

import structlog
from slack_bolt.async_app import AsyncApp

from app.config import settings

logger = structlog.get_logger()

# ---------------------------------------------------------------------------
# App singleton — created regardless of token presence so that handler
# registration code (which runs at import) can always bind to it.
# The underlying Slack SDK will error only when a method is actually invoked
# without a valid token, not at construction time.
# ---------------------------------------------------------------------------

bolt_app = AsyncApp(
    token=settings.SLACK_BOT_TOKEN or "xoxb-placeholder",
    signing_secret=settings.SLACK_SIGNING_SECRET or "placeholder-signing-secret",
)


def create_socket_mode_handler():  # type: ignore[return]
    """Return an ``AsyncSocketModeHandler`` for the configured ``bolt_app``.

    Returns:
        ``AsyncSocketModeHandler`` bound to ``bolt_app`` and ``SLACK_APP_TOKEN``.

    Raises:
        ValueError: If ``SLACK_APP_TOKEN`` is not set.
    """
    from slack_bolt.adapter.socket_mode.async_handler import AsyncSocketModeHandler

    if not settings.SLACK_APP_TOKEN:
        raise ValueError(
            "SLACK_APP_TOKEN must be set to use Socket Mode. "
            "Set it in .env or as an environment variable."
        )
    logger.info("slack_socket_mode_handler_creating")
    return AsyncSocketModeHandler(bolt_app, settings.SLACK_APP_TOKEN)
