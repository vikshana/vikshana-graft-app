"""Unit tests for MCP token encryption.

Covers the F9 fix: ``decrypt_token`` must never return ciphertext on
decrypt failure (malformed ciphertext, or a rotated/mismatched key). The
only passthrough (plaintext-in, plaintext-out) mode is the explicit,
supported dev mode where ``MCP_ENCRYPTION_KEY`` is unset entirely.

Note: these tests deliberately avoid ``importlib.reload()``. ``crypto.py``
reads ``MCP_ENCRYPTION_KEY`` from ``os.environ`` fresh on every call (see
``_get_fernet``), so ``patch.dict(os.environ, ...)`` alone is sufficient —
no reload is needed. Reloading the module would create *new*
``TokenDecryptionError``/``MCPCryptoError`` class objects that no longer
match the ones already imported by ``harness.mcp.client_manager`` (and any
other caller) at collection time, silently breaking their
``except TokenDecryptionError`` clauses across the test session.
"""

from __future__ import annotations

import os
from unittest.mock import patch

import pytest

import harness.mcp.crypto as crypto_mod


class TestCrypto:
    def test_encrypt_decrypt_roundtrip_with_key(self) -> None:
        # Generate a valid Fernet key
        from cryptography.fernet import Fernet
        key = Fernet.generate_key().decode()
        with patch.dict(os.environ, {"MCP_ENCRYPTION_KEY": key}):
            encrypted = crypto_mod.encrypt_token("my-secret-token")
            assert encrypted != "my-secret-token"
            decrypted = crypto_mod.decrypt_token(encrypted)
            assert decrypted == "my-secret-token"

    def test_no_key_passthrough(self) -> None:
        """Explicit, supported dev mode: no key configured at all.

        This is the only case where decrypt_token may return its input
        unchanged — it is distinguishable from a real decrypt failure
        because no Fernet instance is ever constructed (``_get_fernet()``
        returns None), so there is no ciphertext/key mismatch to hide.
        """
        with patch.dict(os.environ, {"MCP_ENCRYPTION_KEY": ""}):
            assert crypto_mod.encrypt_token("plain") == "plain"
            assert crypto_mod.decrypt_token("plain") == "plain"

    def test_malformed_ciphertext_raises_and_does_not_return_ciphertext(self) -> None:
        """A key IS configured, but the stored value is not valid Fernet
        ciphertext (e.g. truncated/corrupted in storage). Must raise, and
        the exception must never carry the ciphertext back out as if it
        were a usable token."""
        from cryptography.fernet import Fernet
        key = Fernet.generate_key().decode()
        malformed = "not-a-real-fernet-token"
        with patch.dict(os.environ, {"MCP_ENCRYPTION_KEY": key}):
            with pytest.raises(crypto_mod.TokenDecryptionError):
                crypto_mod.decrypt_token(malformed)

    def test_key_rotation_raises_and_does_not_return_ciphertext(self) -> None:
        """Token was encrypted under key A; the running process now has
        key B (rotation). Decrypting with the wrong key must raise, not
        silently hand back the original ciphertext."""
        from cryptography.fernet import Fernet
        key_a = Fernet.generate_key().decode()
        key_b = Fernet.generate_key().decode()

        with patch.dict(os.environ, {"MCP_ENCRYPTION_KEY": key_a}):
            encrypted = crypto_mod.encrypt_token("my-secret-token")

        with patch.dict(os.environ, {"MCP_ENCRYPTION_KEY": key_b}):
            with pytest.raises(crypto_mod.TokenDecryptionError):
                crypto_mod.decrypt_token(encrypted)

    def test_decrypt_failure_exception_is_typed_and_distinct_from_no_key_mode(self) -> None:
        """TokenDecryptionError is a distinct, catchable type so callers can
        tell "key configured but decrypt failed" apart from any other
        failure and fail closed specifically on it."""
        from cryptography.fernet import Fernet
        key = Fernet.generate_key().decode()
        with patch.dict(os.environ, {"MCP_ENCRYPTION_KEY": key}):
            assert issubclass(crypto_mod.TokenDecryptionError, crypto_mod.MCPCryptoError)
            try:
                crypto_mod.decrypt_token("garbage")
                pytest.fail("expected TokenDecryptionError")
            except crypto_mod.TokenDecryptionError as exc:
                # The exception message must not embed the raw ciphertext
                # as if it were a returned/usable value.
                assert "garbage" not in str(exc)
