"""Tests for harness/triage/dedup_adapter.py — OrcaDedupAdapter."""

from __future__ import annotations

import uuid
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from harness.triage.dedup_adapter import OrcaDedupAdapter, DedupPort


class TestDedupPortProtocol:
    def test_orca_adapter_satisfies_protocol(self):
        """OrcaDedupAdapter satisfies the DedupPort Protocol."""
        adapter = OrcaDedupAdapter()
        assert isinstance(adapter, DedupPort)


class TestOrcaDedupAdapterComputeFingerprint:
    async def test_delegates_to_app_agent_dedup(self):
        """compute_fingerprint delegates to app.agent.dedup.compute_fingerprint."""
        expected = "a" * 64
        adapter = OrcaDedupAdapter()

        # Patch the actual function in the source module (lazy import resolves there)
        with patch("app.agent.dedup.compute_fingerprint", return_value=expected):
            result = await adapter.compute_fingerprint("HighLatency", {"service": "checkout"})

        assert result == expected

    async def test_fingerprint_is_hex_string(self):
        """compute_fingerprint returns a 64-char hex string."""
        adapter = OrcaDedupAdapter()

        with patch("app.agent.dedup.compute_fingerprint") as mock_fn:
            mock_fn.return_value = "b" * 64
            result = await adapter.compute_fingerprint("Alert", {})

        assert len(result) == 64


class TestOrcaDedupAdapterFindCanonical:
    async def test_returns_none_when_no_canonical_rca(self):
        """find_canonical returns None when find_canonical_rca returns None."""
        adapter = OrcaDedupAdapter()
        mock_db = AsyncMock()

        with patch("app.agent.dedup.find_canonical_rca", return_value=None) as mock_fn:
            result = await adapter.find_canonical("fingerprint-abc", mock_db)

        assert result is None

    async def test_returns_rca_id_string_when_found(self):
        """find_canonical returns the RCA UUID as a string when found."""
        adapter = OrcaDedupAdapter()
        mock_db = AsyncMock()
        mock_rca = MagicMock()
        mock_rca.id = uuid.UUID("12345678-1234-1234-1234-123456789abc")

        with patch("app.agent.dedup.find_canonical_rca", return_value=mock_rca):
            result = await adapter.find_canonical("fp-xyz", mock_db)

        assert result == "12345678-1234-1234-1234-123456789abc"


class TestOrcaDedupAdapterRecordDuplicate:
    async def test_delegates_to_record_duplicate(self):
        """record_duplicate delegates to app.agent.dedup.record_duplicate."""
        adapter = OrcaDedupAdapter()
        mock_db = AsyncMock()
        canonical_id = str(uuid.uuid4())
        alert_id = uuid.uuid4()

        with patch("app.agent.dedup.record_duplicate", new_callable=AsyncMock) as mock_fn:
            await adapter.record_duplicate(canonical_id, alert_id, mock_db)

        mock_fn.assert_awaited_once()
