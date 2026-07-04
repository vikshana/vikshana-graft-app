"""Fernet-based encryption for MCP server tokens.

When ``MCP_ENCRYPTION_KEY`` is empty (development default), tokens are
stored as plain text.  In production, set a 32-byte URL-safe base64 key.
"""

from __future__ import annotations

import os

import structlog

logger = structlog.get_logger()


def _get_fernet() -> "Fernet | None":  # type: ignore[name-defined]
    key = os.environ.get("MCP_ENCRYPTION_KEY", "")
    if not key:
        return None
    try:
        from cryptography.fernet import Fernet
        return Fernet(key.encode() if isinstance(key, str) else key)
    except Exception as exc:
        logger.warning("mcp_fernet_init_failed", error=str(exc))
        return None


def encrypt_token(token: str) -> str:
    """Encrypt a token string.  Returns plain text if key is not configured.

    Args:
        token: Plain-text token to encrypt.

    Returns:
        Encrypted token string (or plain text in dev mode).
    """
    f = _get_fernet()
    if f is None:
        return token
    return f.encrypt(token.encode()).decode()


def decrypt_token(value: str) -> str:
    """Decrypt an encrypted token string.  Returns value unchanged if no key.

    Args:
        value: Encrypted (or plain-text in dev) token value.

    Returns:
        Decrypted plain-text token.
    """
    f = _get_fernet()
    if f is None:
        return value
    try:
        return f.decrypt(value.encode()).decode()
    except Exception as exc:
        logger.error("mcp_token_decrypt_failed", error=str(exc))
        return value
