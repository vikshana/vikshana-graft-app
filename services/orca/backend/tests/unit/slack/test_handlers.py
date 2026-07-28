"""Tests for harness/slack/handlers.py — /obs command and action handlers.

Uses the Bolt AsyncSlackRequestHandler to simulate inbound Slack payloads
without a real workspace.
"""

from __future__ import annotations

import json
from typing import Any
from unittest.mock import AsyncMock, MagicMock, patch

import pytest


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


@pytest.fixture(autouse=True)
def _reset_handler_registration():
    """Reset the _handlers_registered flag before each test so handlers can
    be cleanly re-registered on a fresh bolt_app mock."""
    import harness.slack.handlers as h
    original = h._handlers_registered
    h._handlers_registered = False
    yield
    h._handlers_registered = original


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _make_obs_command(text: str, user_id: str = "U001", channel_id: str = "C001", team_id: str = "T001") -> dict[str, Any]:
    return {
        "command": "/obs",
        "text": text,
        "user_id": user_id,
        "channel_id": channel_id,
        "team_id": team_id,
    }


# ---------------------------------------------------------------------------
# /obs dispatcher
# ---------------------------------------------------------------------------


class TestObsCommandDispatcher:
    async def test_unknown_subcommand_returns_error(self):
        """An unknown subcommand results in an error message."""
        from harness.slack.handlers import _handle_obs_command

        ack = AsyncMock()
        say = AsyncMock()

        await _handle_obs_command(
            ack=ack,
            command=_make_obs_command("unknown-sub"),
            say=say,
        )

        ack.assert_awaited_once()
        say.assert_awaited_once()
        call_kwargs = say.call_args.kwargs or say.call_args[1]
        blocks = call_kwargs.get("blocks", [])
        assert any("Unknown subcommand" in str(b) for b in blocks)

    async def test_empty_text_returns_error(self):
        """Empty /obs text returns error."""
        from harness.slack.handlers import _handle_obs_command

        ack = AsyncMock()
        say = AsyncMock()

        await _handle_obs_command(
            ack=ack,
            command=_make_obs_command(""),
            say=say,
        )

        ack.assert_awaited_once()
        say.assert_awaited_once()

    async def test_ack_called_before_say(self):
        """ack() must be called before any say() to satisfy 3-second guarantee."""
        from harness.slack.handlers import _handle_obs_command

        call_order: list[str] = []

        async def tracking_ack():
            call_order.append("ack")

        async def tracking_say(*a, **kw):
            call_order.append("say")
            return {"ts": "1234.5678"}

        with patch("harness.slack.handlers.asyncio.create_task"):
            await _handle_obs_command(
                ack=tracking_ack,
                command=_make_obs_command("ask hello"),
                say=tracking_say,
            )

        assert call_order[0] == "ack"


# ---------------------------------------------------------------------------
# /obs ask
# ---------------------------------------------------------------------------


class TestObsAsk:
    async def test_ask_without_prompt_returns_error(self):
        """``/obs ask`` with no text replies with an error."""
        from harness.slack.handlers import _do_ask

        say = AsyncMock()
        log = MagicMock()
        log.info = MagicMock()
        log.error = MagicMock()

        await _do_ask(
            command=_make_obs_command("ask"),
            prompt="",
            say=say,
            log=log,
        )

        say.assert_awaited_once()
        call = say.call_args.kwargs or say.call_args[1]
        # Error message should contain some indicator of missing input
        block_str = str(call.get("blocks", [])) + str(call.get("text", ""))
        assert any(word in block_str.lower() for word in ("question", "missing", "provide", "error"))

    async def test_ask_with_prompt_rejects_as_unsupported(self):
        """``/obs ask <prompt>`` is not implemented — no ``"ask"`` graph is
        registered (only ``"investigation"``, see app/main.py), so this
        must reject up front with a clear message rather than enqueuing a
        turn job the TurnWorker can never execute (F1: previously this
        silently failed deep inside `_execute_turn` with no feedback to
        the Slack thread)."""
        from harness.slack.handlers import _do_ask

        say = AsyncMock(return_value={"ts": "111.222"})
        log = MagicMock()
        log.info = MagicMock()
        log.error = MagicMock()

        with patch(
            "harness.slack.handlers._create_session_and_enqueue", new_callable=AsyncMock
        ) as mock_enqueue:
            await _do_ask(
                command=_make_obs_command("ask"),
                prompt="why is checkout slow?",
                say=say,
                log=log,
            )

        # Never enqueues a turn for the unsupported "ask" session type.
        mock_enqueue.assert_not_called()

        say.assert_awaited_once()
        call = say.call_args.kwargs or say.call_args[1]
        block_str = str(call.get("blocks", [])) + str(call.get("text", ""))
        assert "not supported" in block_str.lower()
        assert "investigate" in block_str.lower()


# ---------------------------------------------------------------------------
# /obs investigate — full RCAState (F1)
# ---------------------------------------------------------------------------


class TestBuildSlackInvestigationState:
    """`_build_slack_investigation_state` must produce every key
    `app.agent.rca_state.RCAState` and the interactive RCA graph's nodes
    require — a partial dict (as previously built: just `{"prompt":
    ..., "user_id": ...}`) raises a bare `KeyError` the first time
    `data_gathering_node` runs (`state["alert_context"]`), which the
    TurnWorker can only surface as a generic failed job with no feedback
    posted back to the Slack thread (see docs/harness-risk-review.md, F1).
    """

    def test_state_has_every_required_rca_state_key(self):
        from app.agent.rca_state import RCAState
        from harness.slack.handlers import _build_slack_investigation_state

        state = _build_slack_investigation_state("checkout errors spiking", org_id=7)

        for key in RCAState.__required_keys__:
            assert key in state, f"missing required RCAState key: {key!r}"

    def test_alert_context_is_populated_from_the_prompt(self):
        from harness.slack.handlers import _build_slack_investigation_state

        state = _build_slack_investigation_state("checkout errors spiking", org_id=7)

        assert state["alert_context"]["description"] == "checkout errors spiking"
        assert state["alert_context"]["alert_name"]
        assert state["alert_context"]["labels"] == {}
        assert state["org_id"] == 7
        assert state["alert_context"]["org_id"] == 7

    def test_loop_and_round_control_fields_are_initialised(self):
        """These are exactly the direct-index accesses data_gathering_node,
        hypothesis_generation_node, and should_continue perform."""
        from harness.slack.handlers import _build_slack_investigation_state

        state = _build_slack_investigation_state("why is checkout slow?", org_id=None)

        assert state["round"] == 0
        assert state["developer_accepted"] is False
        assert state["max_rounds"] > 0
        assert state["hypotheses"] == []
        assert state["confidence_scores"] == []
        assert state["gathered_data"] == []
        assert state["messages"] == []
        assert state["tool_call_count"] == 0
        assert state["investigation_started_at"] is None


class TestObsInvestigate:
    async def test_investigate_enqueues_a_full_rca_state_not_a_partial_dict(self) -> None:
        """The turn_input handed to `_create_session_and_enqueue` (and from
        there straight into `graph.ainvoke(turn_input, ...)`) must be a
        complete RCAState — not the old `{"prompt": ..., "user_id": ...}`
        partial dict that crashed `data_gathering_node` on
        `state["alert_context"]`."""
        from app.agent.rca_state import RCAState
        from harness.slack.handlers import _do_investigate

        say = AsyncMock(return_value={"ts": "555.666"})
        log = MagicMock()
        log.info = MagicMock()
        log.error = MagicMock()

        with patch(
            "harness.slack.handlers._create_session_and_enqueue", new_callable=AsyncMock
        ) as mock_enqueue:
            await _do_investigate(
                command=_make_obs_command("investigate high error rate on checkout"),
                prompt="high error rate on checkout",
                say=say,
                log=log,
            )

        mock_enqueue.assert_awaited_once()
        call_kwargs = mock_enqueue.call_args.kwargs
        assert call_kwargs["session_type"] == "investigation"
        turn_input = call_kwargs["turn_input"]
        for key in RCAState.__required_keys__:
            assert key in turn_input, f"missing required RCAState key: {key!r}"
        assert turn_input["alert_context"]["description"] == "high error rate on checkout"

    async def test_investigate_without_prompt_returns_error_and_does_not_enqueue(self) -> None:
        from harness.slack.handlers import _do_investigate

        say = AsyncMock()
        log = MagicMock()
        log.info = MagicMock()
        log.error = MagicMock()

        with patch(
            "harness.slack.handlers._create_session_and_enqueue", new_callable=AsyncMock
        ) as mock_enqueue:
            await _do_investigate(
                command=_make_obs_command("investigate"),
                prompt="",
                say=say,
                log=log,
            )

        mock_enqueue.assert_not_called()
        say.assert_awaited_once()


# ---------------------------------------------------------------------------
# Approval actions
# ---------------------------------------------------------------------------


class TestApprovalActions:
    async def test_approve_acks_and_enqueues_resume(self):
        """approve_tool_call acks and calls enqueue_turn with approved=True."""
        from harness.slack.handlers import _handle_approve

        ack = AsyncMock()
        say = AsyncMock()
        body = {
            "actions": [{"action_id": "approve_tool_call", "value": "sess-abc:job-xyz"}]
        }

        with (
            patch("harness.slack.handlers.asyncio.create_task") as mock_create_task,
        ):
            await _handle_approve(ack=ack, body=body, say=say)

        ack.assert_awaited_once()
        mock_create_task.assert_called_once()

    async def test_reject_acks_and_dispatches_task(self):
        """reject_tool_call acks and dispatches a background task."""
        from harness.slack.handlers import _handle_reject

        ack = AsyncMock()
        say = AsyncMock()
        body = {
            "actions": [{"action_id": "reject_tool_call", "value": "sess-abc:job-xyz"}]
        }

        with patch("harness.slack.handlers.asyncio.create_task") as mock_create_task:
            await _handle_reject(ack=ack, body=body, say=say)

        ack.assert_awaited_once()
        mock_create_task.assert_called_once()


# ---------------------------------------------------------------------------
# register_handlers
# ---------------------------------------------------------------------------


class TestRegisterHandlers:
    def test_register_handlers_is_idempotent(self):
        """Calling register_handlers twice does not double-register."""
        import harness.slack.handlers as h

        with patch.object(h.bolt_app, "command") as mock_cmd:
            mock_cmd.return_value = lambda f: f  # decorator passthrough

            h.register_handlers()
            h.register_handlers()  # second call should be no-op

        # command() called exactly once (not twice)
        assert mock_cmd.call_count == 1


# ---------------------------------------------------------------------------
# _create_session_and_enqueue — org_id / initiator_user_id persistence (F1)
# ---------------------------------------------------------------------------


class _FakeDB:
    """Minimal async DB double recording every `execute()` call's SQL + params."""

    def __init__(self, fetchone_result: Any = None) -> None:
        self.executed: list[tuple[str, dict]] = []
        self._fetchone_result = fetchone_result
        self.committed = False

    async def execute(self, stmt: Any, params: dict | None = None) -> MagicMock:
        self.executed.append((str(stmt), params or {}))
        result = MagicMock()
        result.fetchone = MagicMock(return_value=self._fetchone_result)
        return result

    async def commit(self) -> None:
        self.committed = True

    async def __aenter__(self) -> "_FakeDB":
        return self

    async def __aexit__(self, *args: Any) -> None:
        pass


class TestCreateSessionAndEnqueuePersistsOrgAndInitiator:
    """F1 fix: Slack-created sessions must persist org_id and
    initiator_user_id — previously neither column was included in the
    INSERT at all, so both were silently lost even when resolvable."""

    async def test_insert_includes_org_id_and_initiator_user_id_params(self) -> None:
        from harness.slack.handlers import _create_session_and_enqueue

        fake_db = _FakeDB()

        with (
            patch("app.db.AsyncSessionLocal", return_value=fake_db),
            patch("app.config.settings.SLACK_DEFAULT_ORG_ID", 99),
            patch(
                "harness.slack.handlers._resolve_slack_initiator_user_id",
                new=AsyncMock(return_value="user-uuid-123"),
            ),
            patch("harness.session.worker.enqueue_turn", new=AsyncMock()),
        ):
            await _create_session_and_enqueue(
                session_id="sess-1",
                session_type="ask",
                turn_input={"prompt": "why?"},
                channel="C1",
                thread_ts=None,
                team_id="T1",
                slack_user_id="U1",
            )

        insert_call = next(
            (stmt, params) for stmt, params in fake_db.executed if "INSERT INTO rca_sessions" in stmt
        )
        _stmt, params = insert_call
        assert params["initiator_user_id"] == "user-uuid-123"
        assert params["org_id"] == 99
        assert fake_db.committed is True

    async def test_no_slack_user_id_leaves_initiator_user_id_none(self) -> None:
        """When the caller has no Slack user id to resolve (e.g. a system-
        originated call), initiator_user_id is explicitly None rather than
        silently omitted."""
        from harness.slack.handlers import _create_session_and_enqueue

        fake_db = _FakeDB()

        with (
            patch("app.db.AsyncSessionLocal", return_value=fake_db),
            patch("app.config.settings.SLACK_DEFAULT_ORG_ID", None),
            patch("harness.session.worker.enqueue_turn", new=AsyncMock()),
        ):
            await _create_session_and_enqueue(
                session_id="sess-2",
                session_type="ask",
                turn_input={},
                channel="C1",
                thread_ts=None,
                team_id="T1",
            )

        _stmt, params = next(
            (stmt, params) for stmt, params in fake_db.executed if "INSERT INTO rca_sessions" in stmt
        )
        assert params["initiator_user_id"] is None
        assert params["org_id"] is None

    async def test_unlinked_slack_user_still_creates_session_with_none_initiator(self) -> None:
        """A Slack user who has not completed /obs link yet still gets a
        session created — just without a resolvable initiator_user_id."""
        from harness.slack.handlers import _create_session_and_enqueue

        fake_db = _FakeDB(fetchone_result=None)  # no matching identity row

        with (
            patch("app.db.AsyncSessionLocal", return_value=fake_db),
            patch("harness.session.worker.enqueue_turn", new=AsyncMock()),
        ):
            await _create_session_and_enqueue(
                session_id="sess-3",
                session_type="investigation",
                turn_input={},
                channel="C1",
                thread_ts=None,
                team_id="T1",
                slack_user_id="U-unlinked",
            )

        _stmt, params = next(
            (stmt, params) for stmt, params in fake_db.executed if "INSERT INTO rca_sessions" in stmt
        )
        assert params["initiator_user_id"] is None


class TestResolveSlackInitiatorUserId:
    async def test_returns_linked_user_id(self) -> None:
        from harness.slack.handlers import _resolve_slack_initiator_user_id

        row = MagicMock()
        row.user_id = "linked-user-uuid"
        fake_db = _FakeDB(fetchone_result=row)

        result = await _resolve_slack_initiator_user_id(
            slack_user_id="U1", slack_team_id="T1", db=fake_db
        )
        assert result == "linked-user-uuid"
        # Confirms the composite subject format matches harness.auth.linkage.
        _stmt, params = fake_db.executed[0]
        assert params["subject"] == "T1:U1"

    async def test_returns_none_when_not_linked(self) -> None:
        from harness.slack.handlers import _resolve_slack_initiator_user_id

        fake_db = _FakeDB(fetchone_result=None)
        result = await _resolve_slack_initiator_user_id(
            slack_user_id="U-unlinked", slack_team_id="T1", db=fake_db
        )
        assert result is None
