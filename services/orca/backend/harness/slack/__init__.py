"""harness/slack — Slack Bolt integration for the observability agent.

Public symbols:
  bolt_app                 — The configured ``AsyncApp`` instance.
  create_socket_mode_handler() — Factory for ``AsyncSocketModeHandler``.
  register_handlers()      — Idempotent handler registration (called on import).
"""

from harness.slack.app import bolt_app, create_socket_mode_handler
from harness.slack.handlers import register_handlers

register_handlers()

__all__ = ["bolt_app", "create_socket_mode_handler", "register_handlers"]
