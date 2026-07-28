"""Fernet-based encryption for MCP server tokens.

When ``MCP_ENCRYPTION_KEY`` is empty (development default), tokens are
stored as plain text.  In production, set a 32-byte URL-safe base64 key
(``Settings.validate_production_secrets`` refuses to start otherwise — see
``app/config.py``).

Decrypt failures (malformed ciphertext, or ciphertext encrypted under a key
that has since been rotated away) are a distinct, explicit failure mode from
the "no key configured" dev passthrough. They MUST NOT be treated the same
way: this module never falls back to returning ciphertext as if it were a
usable token. Callers must catch ``TokenDecryptionError`` and fail closed
(refuse to connect / refuse to use the value as a bearer token) rather than
silently sending the still-encrypted blob over the wire. See
docs/harness-risk-review.md, F9.
"""

from __future__ import annotations

import os

import structlog

logger = structlog.get_logger()


class MCPCryptoError(Exception):
    """Base class for MCP token encryption/decryption errors."""


class TokenDecryptionError(MCPCryptoError):
    """An encrypted MCP token could not be decrypted.

    Raised when ``MCP_ENCRYPTION_KEY`` is configured but decryption of a
    stored ``token_encrypted`` value fails — e.g. the ciphertext is
    malformed/truncated, or the key has been rotated since the value was
    encrypted. This is never swallowed into a ciphertext passthrough:
    callers must treat this as "no usable token" and fail closed rather
    than sending the raw ciphertext to a downstream server as a bearer
    token.
    """


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
        Encrypted token string (or plain text in dev mode, when
        ``MCP_ENCRYPTION_KEY`` is unset — see module docstring).
    """
    f = _get_fernet()
    if f is None:
        return token
    return f.encrypt(token.encode()).decode()


def decrypt_token(value: str) -> str:
    """Decrypt an encrypted token string.

    In the explicit, supported "no key configured" dev mode (``f is None``
    below — the same condition ``encrypt_token`` uses to skip encryption),
    ``value`` is returned unchanged: it was never encrypted in the first
    place, so there is nothing to decrypt and no ciphertext-vs-plaintext
    ambiguity.

    When a key **is** configured but decryption fails, this function never
    falls back to returning the (still-encrypted) input — that would hand
    callers ciphertext they could mistake for a real token (e.g. sending it
    as a bearer token to an MCP server). Instead it raises
    ``TokenDecryptionError``.

    Args:
        value: Encrypted (or plain-text in dev/no-key mode) token value.

    Returns:
        Decrypted plain-text token.

    Raises:
        TokenDecryptionError: If a key is configured but ``value`` cannot
            be decrypted (malformed ciphertext or a rotated/mismatched key).
    """
    f = _get_fernet()
    if f is None:
        return value
    try:
        return f.decrypt(value.encode()).decode()
    except Exception as exc:
        logger.error("mcp_token_decrypt_failed", error=str(exc))
        raise TokenDecryptionError(
            "Failed to decrypt MCP token: ciphertext is malformed or "
            "MCP_ENCRYPTION_KEY has been rotated since this value was "
            "encrypted. Refusing to return ciphertext as a usable token."
        ) from exc
