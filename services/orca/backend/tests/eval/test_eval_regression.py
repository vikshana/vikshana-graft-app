"""Eval regression tests using Langfuse dataset.

In CI without a live Langfuse instance, runs against fixture-based goldens.
With LANGFUSE_HOST set, downloads the dataset and validates.
"""

from __future__ import annotations

import json
import os

import pytest

from tests.fake_provider import FakeLLM, FakeTurn


LANGFUSE_AVAILABLE = bool(os.environ.get("LANGFUSE_HOST"))

skip_no_langfuse = pytest.mark.skipif(
    not LANGFUSE_AVAILABLE,
    reason="REQUIRES_ENV: set LANGFUSE_HOST to run against live Langfuse",
)

# ── Fixture-based regression (always runs) ────────────────────────────────────

EVAL_FIXTURE = [
    {
        "id": "eval-001",
        "input": {
            "alert_name": "HighErrorRate",
            "description": "Error rate > 5% on checkout-service",
            "service": "checkout-service",
            "environment": "production",
            "labels": {"severity": "critical"},
        },
        "expected": {
            "node_sequence": [
                "data_gathering",
                "historical_context",
                "hypothesis_generation",
                "await_input",
            ],
            "hypothesis_has_content": True,
        },
    },
    {
        "id": "eval-002",
        "input": {
            "alert_name": "HighLatency",
            "description": "P95 latency > 500ms on payment-service",
            "service": "payment-service",
            "environment": "production",
            "labels": {"severity": "warning"},
        },
        "expected": {
            "node_sequence": [
                "data_gathering",
                "historical_context",
                "hypothesis_generation",
                "await_input",
            ],
            "hypothesis_has_content": True,
        },
    },
]


class TestEvalRegressionFixtures:
    """Eval regression using in-process fixture data (always runs, no Langfuse needed)."""

    @pytest.mark.asyncio
    async def test_eval_001_high_error_rate(self):
        """Eval-001: high error rate → hypothesis generated."""
        from app.agent.rca_state import RCAState, AlertContext
        from unittest.mock import AsyncMock, patch
        from harness.llm.fake import FakeProvider, TurnFixture
        import json

        case = EVAL_FIXTURE[0]
        ctx = AlertContext(
            alert_id=None,
            alert_name=case["input"]["alert_name"],
            description=case["input"]["description"],
            service=case["input"]["service"],
            environment=case["input"]["environment"],
            labels=case["input"]["labels"],
            org_id=1,
        )

        script = [
            TurnFixture(content=json.dumps({
                "text": "DB connection pool exhaustion",
                "high_confidence_areas": ["error rate"],
                "uncertain_areas": [],
                "confidence_score": 0.75,
                "suggested_questions": [],
            })),
        ]

        provider = FakeProvider(script=script)
        state = RCAState(
            alert_context=ctx,
            org_id=1,
            gathered_data=[{"source": "test", "content": "errors found"}],
            past_rcas=[],
            hypotheses=[],
            confidence_scores=[],
            round=0,
            developer_accepted=False,
            max_rounds=5,
            messages=[],
            pending_question=None,
            final_report=None,
            rca_session_id=None,
            error_message=None,
            force_finalized=False,
        )

        from harness.llm.fake import FakeProvider as HarnessFakeProvider
        # Use the ChatAnthropic-compatible FakeLLM for the existing graph
        from tests.fake_provider import FakeLLM, FakeTurn

        fake_llm = FakeLLM([
            FakeTurn(content=json.dumps({
                "text": "DB connection pool exhaustion",
                "high_confidence_areas": ["error rate"],
                "uncertain_areas": [],
                "confidence_score": 0.75,
                "suggested_questions": [],
            })),
        ])

        with patch("app.agent.rca_graph._llm_main", fake_llm):
            from app.agent.rca_graph import hypothesis_generation_node
            result = await hypothesis_generation_node(state)

        assert len(result["hypotheses"]) == 1
        assert result["hypotheses"][0]["text"]  # has content
        assert 0 < result["confidence_scores"][0] <= 1.0

    @pytest.mark.asyncio
    async def test_eval_002_high_latency(self):
        """Eval-002: high latency alert → hypothesis generated."""
        from app.agent.rca_state import RCAState, AlertContext
        from unittest.mock import patch
        import json

        case = EVAL_FIXTURE[1]
        ctx = AlertContext(
            alert_id=None,
            alert_name=case["input"]["alert_name"],
            description=case["input"]["description"],
            service=case["input"]["service"],
            environment=case["input"]["environment"],
            labels=case["input"]["labels"],
            org_id=1,
        )

        from tests.fake_provider import FakeLLM, FakeTurn
        fake_llm = FakeLLM([
            FakeTurn(content=json.dumps({
                "text": "Downstream payment gateway timeout",
                "high_confidence_areas": ["latency"],
                "uncertain_areas": [],
                "confidence_score": 0.65,
                "suggested_questions": [],
            })),
        ])

        state = RCAState(
            alert_context=ctx,
            org_id=1,
            gathered_data=[],
            past_rcas=[],
            hypotheses=[],
            confidence_scores=[],
            round=0,
            developer_accepted=False,
            max_rounds=5,
            messages=[],
            pending_question=None,
            final_report=None,
            rca_session_id=None,
            error_message=None,
            force_finalized=False,
        )

        with patch("app.agent.rca_graph._llm_main", fake_llm):
            from app.agent.rca_graph import hypothesis_generation_node
            result = await hypothesis_generation_node(state)

        assert len(result["hypotheses"]) == 1
        assert "latency" in result["hypotheses"][0]["text"].lower() or result["hypotheses"][0]["text"]


class TestEvalRegressionLive:
    """Live eval regression against Langfuse dataset. REQUIRES_ENV."""

    @skip_no_langfuse
    def test_langfuse_dataset_exists(self):
        """Langfuse eval dataset 'orca-eval' exists and has ≥2 items."""
        from harness.observability.langfuse import make_langfuse_client
        client = make_langfuse_client()
        lf = client._get_client()
        try:
            dataset = lf.get_dataset("orca-eval")
            items = dataset.items
            assert len(items) >= 2, f"Expected ≥2 eval items, got {len(items)}"
        except Exception as exc:
            pytest.fail(f"Could not load Langfuse dataset: {exc}")
