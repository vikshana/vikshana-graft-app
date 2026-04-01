# AGENT.md — AI Coding Agent Guidelines

This file defines the coding standards, conventions, and workflows that any AI coding agent must follow when working on the Orca codebase. These rules apply regardless of which AI agent or IDE integration is used.

---

## Principles

1. **Type safety first** — Every function has type annotations. Every data boundary uses Pydantic. No `Any` unless explicitly justified.
2. **Test everything** — Every public function has a unit test. Every API endpoint has an integration test. No untested code merges.
3. **Schema-first workflow** — When building a new feature: define the Pydantic schema → implement the logic → write the test. In that order.
4. **Async by default** — All I/O operations (database, HTTP, MCP) are async. Never use blocking calls in the FastAPI context.
5. **Explicit over implicit** — No magic. No global state. Configuration comes from `app/config.py` via environment variables. Dependencies are injected via FastAPI `Depends()`.

---

## Python Style Rules

### Type Hints

```python
# ✅ All parameters and return types annotated
async def create_rca(alert_id: uuid.UUID, session: AsyncSession) -> RCA:
    ...

# ✅ Use union syntax (Python 3.12+)
def get_error(result: dict[str, str]) -> str | None:
    ...

# ❌ Never omit types
def create_rca(alert_id, session):
    ...

# ❌ Never use Any without justification
def process(data: Any) -> Any:
    ...
```

### Docstrings

Use Google-style docstrings on all public functions and classes:

```python
async def search_similar_alerts(
    service_name: str,
    alert_name: str,
    session: AsyncSession,
    limit: int = 10,
) -> list[Alert]:
    """Search for previous alerts matching the given service and alert name.

    Performs a case-insensitive search on alert_name using trigram similarity
    and exact match on service_name.

    Args:
        service_name: The service to filter by (exact match).
        alert_name: The alert name to search for (fuzzy match).
        session: Async database session.
        limit: Maximum number of results to return.

    Returns:
        List of matching Alert records, ordered by created_at descending.
    """
```

### Error Handling

```python
# ✅ Define custom exceptions
class InvalidAlertError(Exception):
    """Raised when an alert payload is missing required labels."""
    def __init__(self, missing_labels: list[str]) -> None:
        self.missing_labels = missing_labels
        super().__init__(f"Missing required labels: {', '.join(missing_labels)}")

# ✅ Log errors with context, then re-raise or handle
try:
    result = await mcp_client.call_tool("query_prometheus", params)
except MCPError as e:
    log.error("mcp_tool_failed", tool="query_prometheus", error=str(e))
    raise

# ❌ Never swallow exceptions silently
try:
    result = await something()
except Exception:
    pass  # BAD
```

### Import Ordering

```python
# 1. Standard library
import uuid
from datetime import datetime, timezone

# 2. Third-party
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.ext.asyncio import AsyncSession
import structlog

# 3. Local (absolute imports from app.)
from app.config import settings
from app.db import get_session
from app.models.rca import RCA
from app.schemas.rca import RCAResponse
```

### Logging

```python
import structlog

logger = structlog.get_logger()

# Always bind rca_id in agent contexts
log = logger.bind(rca_id=str(rca_id))
log.info("investigation_started", service=alert_labels["service_name"])

# Use structured key-value pairs, not f-strings
# ✅
log.info("step_complete", step=3, tool="query_prometheus", tokens=1523)
# ❌
log.info(f"Step 3 complete, used query_prometheus, 1523 tokens")
```

---

## Testing Rules

### Framework

- `pytest` + `pytest-asyncio` for all tests
- Fixtures defined in `tests/conftest.py`
- Tests live alongside the code structure: `tests/unit/test_<module>.py`, `tests/integration/test_<feature>.py`

### What to Test

| What | Where | How |
|---|---|---|
| Each agent node (triage, investigate, analyze, report, publish) | `tests/unit/test_<node>_node.py` | Mock LLM responses + MCP tool calls |
| Webhook payload validation | `tests/unit/test_webhook_validation.py` | Valid payloads, missing labels, malformed JSON |
| Pydantic schema serialisation | `tests/unit/test_models.py` | Round-trip serialisation, edge cases |
| API endpoints | `tests/integration/test_rca_api.py` | Use `httpx.AsyncClient` with test DB |
| Webhook → RCA full flow | `tests/integration/test_webhook_to_rca.py` | Mock MCP + LLM, real DB |
| Grafana MCP connectivity | `tests/integration/test_grafana_mcp.py` | Live MCP server, mark `@pytest.mark.slow` |

### Test Structure

```python
import pytest
from unittest.mock import AsyncMock

from app.agent.nodes.triage import run_triage
from app.agent.state import OrcaState


@pytest.fixture
def valid_alert_state() -> OrcaState:
    """Create a minimal valid OrcaState for testing."""
    return OrcaState(
        rca_id="test-uuid",
        alert_payload={...},
        alert_labels={
            "service_name": "checkout-service",
            "deployment_environment_name": "production",
            "domain": "commerce",
            "legal_company": "acme",
            "sub_domain": "checkout",
            "system_id": "sys-001",
            "team": "checkout-team",
            "version": "1.2.3",
        },
        alert_name="HighLatency",
        # ... other fields
    )


class TestTriageNode:
    """Tests for the triage node."""

    async def test_valid_alert_passes_triage(self, valid_alert_state: OrcaState) -> None:
        """Triage should accept alerts with all required labels."""
        result = await run_triage(valid_alert_state)
        assert result["status"] == "investigating"
        assert result["severity"] in ("critical", "warning", "info")

    async def test_missing_labels_fails_triage(self, valid_alert_state: OrcaState) -> None:
        """Triage should reject alerts with missing required labels."""
        del valid_alert_state["alert_labels"]["service_name"]
        result = await run_triage(valid_alert_state)
        assert result["status"] == "failed"
        assert "service_name" in result["error_message"]
```

### Integration Tests

```python
import pytest
from httpx import AsyncClient

@pytest.mark.integration
async def test_create_rca_via_webhook(client: AsyncClient, test_db: AsyncSession) -> None:
    """POST /webhook/grafana should create an alert and trigger an RCA."""
    payload = {
        "alerts": [{
            "status": "firing",
            "labels": {
                "alertname": "HighLatency",
                "service_name": "checkout-service",
                # ... all required labels
            },
            "annotations": {"summary": "Latency is above 500ms"},
        }]
    }

    response = await client.post("/webhook/grafana", json=payload)
    assert response.status_code == 202

    data = response.json()
    assert data["rca_id"] is not None
    assert data["status"] == "triggered"
```

### Test Commands

```bash
# All tests
pytest tests/ -v

# Only unit tests
pytest tests/unit/ -v

# Only integration tests
pytest tests/integration/ -v

# Specific test file
pytest tests/unit/test_triage_node.py -v

# With coverage
pytest --cov=app --cov-report=term-missing tests/

# Exclude slow tests (live MCP connectivity)
pytest tests/ -v -m "not slow"
```

---

## File Organisation Rules

1. **One concern per file** — Don't put multiple models or schemas in one file. Each model gets `models/<name>.py`, each schema gets `schemas/<name>.py`.
2. **Agent nodes are pure functions** — Each node in `agent/nodes/` exports a single async function that takes `OrcaState` and returns `OrcaState`. No side effects beyond logging and DB writes.
3. **Prompts are markdown files** — System prompts live in `agent/prompts/*.md`, not inline in Python code. Load them at import time.
4. **MCP clients are configuration, not logic** — `agent/mcp/` files configure MCP server connections and tool allow-lists. Business logic stays in the nodes.
5. **Integration clients are thin wrappers** — `integrations/slack.py` is a thin async wrapper around the Slack webhook API. No business logic.

---

## RCA Report Template (Canonical Reference)

When working on the `report` node or report-related features, every RCA must contain these 11 sections in this order:

1. **Summary** — One-paragraph executive summary (what happened, impact, root cause)
2. **Confidence Level** — How reliable the findings are: `high` (strong evidence, multiple corroborating sources), `medium` (partial evidence, some gaps), or `low` (limited data, speculative). Includes a brief justification explaining what evidence supports or limits confidence.
3. **Alert Details** — Original alert name, labels, severity, timestamps, source dashboard
4. **Timeline** — Chronological sequence of events with timestamps
5. **Impact** — What was affected, blast radius, duration, user-facing symptoms
6. **Root Cause** — The identified root cause with evidence
7. **Contributing Factors** — Other conditions that enabled or worsened the issue
8. **Evidence** — Queries executed, metrics/logs examined, key data points
9. **Remediation** — What was done or should be done to resolve the immediate issue
10. **Actions** — Concrete follow-up items with suggested priority (P1–P4)
11. **Related Incidents** — Links to similar past RCAs from the Orca database

The report prompt template in `agent/prompts/report.md` defines the exact markdown structure. Any changes to the report format must update both the prompt and this reference.

---

## Commit Convention

Use conventional commits:

```
feat(agent): add investigate node with ReAct loop
fix(api): handle missing labels in webhook payload
test(triage): add unit tests for label validation
docs: update architecture diagram with MCP flow
chore: add structlog dependency
```

Prefixes: `feat`, `fix`, `test`, `docs`, `chore`, `refactor`, `ci`

Scope: `agent`, `api`, `models`, `schemas`, `frontend`, `demo`, `mcp`

---

## Pre-Commit Checklist

Before considering any task complete:

- [ ] All new functions have type annotations
- [ ] All new public functions have docstrings
- [ ] All new public functions have unit tests
- [ ] All new API endpoints have integration tests
- [ ] `mypy app/` passes with no errors
- [ ] `pytest tests/unit/ -v` passes
- [ ] No `print()` statements — use `structlog`
- [ ] No hardcoded values — use `app/config.py`
- [ ] Pydantic schemas defined for any new API request/response shapes
- [ ] Database model changes reflected in SQLAlchemy models (tables auto-created via `create_all()`)

