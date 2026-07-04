"""Tests for harness/slack/block_kit.py — pure Block Kit builder functions."""

from __future__ import annotations

import pytest

from harness.slack.block_kit import (
    approval_prompt,
    error_message,
    final_answer_message,
    thinking_message,
    tool_call_message,
)


class TestThinkingMessage:
    def test_returns_list_of_dicts(self):
        blocks = thinking_message(session_id="sess-001")
        assert isinstance(blocks, list)
        assert all(isinstance(b, dict) for b in blocks)

    def test_contains_session_id_in_context(self):
        blocks = thinking_message(session_id="sess-abc")
        block_text = str(blocks)
        assert "sess-abc" in block_text

    def test_prompt_preview_truncated_at_120_chars(self):
        long_prompt = "x" * 200
        blocks = thinking_message(session_id="s", prompt_preview=long_prompt)
        block_text = str(blocks)
        assert "x" * 200 not in block_text  # truncated
        assert "…" in block_text

    def test_short_prompt_not_truncated(self):
        blocks = thinking_message(session_id="s", prompt_preview="short prompt")
        assert "short prompt" in str(blocks)


class TestToolCallMessage:
    def test_contains_tool_name(self):
        blocks = tool_call_message("query_prometheus", "{range: '1h'}", "s1")
        assert "query_prometheus" in str(blocks)

    def test_long_args_truncated(self):
        long_args = "a" * 300
        blocks = tool_call_message("tool", long_args, "s1")
        assert "a" * 300 not in str(blocks)
        assert "…" in str(blocks)

    def test_session_id_in_context(self):
        blocks = tool_call_message("tool", "args", "my-session-id")
        assert "my-session-id" in str(blocks)


class TestApprovalPrompt:
    def test_contains_approve_and_reject_actions(self):
        blocks = approval_prompt("create_silence", "{}", "sess-1", "job-1")
        block_text = str(blocks)
        assert "approve_tool_call" in block_text
        assert "reject_tool_call" in block_text

    def test_value_contains_session_and_job(self):
        blocks = approval_prompt("tool", "args", "SESSION-X", "JOB-Y")
        block_text = str(blocks)
        assert "SESSION-X:JOB-Y" in block_text

    def test_contains_tool_name(self):
        blocks = approval_prompt("create_annotation", "{}", "s", "j")
        assert "create_annotation" in str(blocks)

    def test_long_args_truncated(self):
        blocks = approval_prompt("tool", "a" * 300, "s", "j")
        assert "a" * 300 not in str(blocks)


class TestFinalAnswerMessage:
    def test_contains_answer_text(self):
        blocks = final_answer_message("Root cause is X.", "s1")
        assert "Root cause is X." in str(blocks)

    def test_truncates_long_answer(self):
        long = "x" * 3000
        blocks = final_answer_message(long, "s1")
        block_text = str(blocks)
        assert "truncated" in block_text

    def test_confidence_level_shown(self):
        blocks = final_answer_message("answer", "s1", confidence="high")
        assert "high" in str(blocks).lower()

    def test_session_id_in_context(self):
        blocks = final_answer_message("answer", "sess-final")
        assert "sess-final" in str(blocks)


class TestErrorMessage:
    def test_contains_reason(self):
        blocks = error_message("Something went wrong")
        assert "Something went wrong" in str(blocks)

    def test_session_id_shown_when_provided(self):
        blocks = error_message("err", session_id="sess-err")
        assert "sess-err" in str(blocks)

    def test_no_session_id_block_when_empty(self):
        blocks = error_message("err", session_id="")
        # Should have fewer blocks (no context block)
        assert len(blocks) == 1
