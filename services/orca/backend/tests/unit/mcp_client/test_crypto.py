"""Unit tests for MCP token encryption."""

from __future__ import annotations

import os
from unittest.mock import patch


class TestCrypto:
    def test_encrypt_decrypt_roundtrip_with_key(self) -> None:
        # Generate a valid Fernet key
        from cryptography.fernet import Fernet
        key = Fernet.generate_key().decode()
        with patch.dict(os.environ, {"MCP_ENCRYPTION_KEY": key}):
            from importlib import reload
            import harness.mcp.crypto as crypto_mod
            reload(crypto_mod)
            encrypted = crypto_mod.encrypt_token("my-secret-token")
            assert encrypted != "my-secret-token"
            decrypted = crypto_mod.decrypt_token(encrypted)
            assert decrypted == "my-secret-token"

    def test_no_key_passthrough(self) -> None:
        with patch.dict(os.environ, {"MCP_ENCRYPTION_KEY": ""}):
            from importlib import reload
            import harness.mcp.crypto as crypto_mod
            reload(crypto_mod)
            assert crypto_mod.encrypt_token("plain") == "plain"
            assert crypto_mod.decrypt_token("plain") == "plain"
