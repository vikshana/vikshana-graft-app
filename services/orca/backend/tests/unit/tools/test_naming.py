"""Unit tests for harness.tools.naming — LLM-safe tool name aliasing (F1).

MCP-qualified registry names (``mcp:{org_id}:{server}:{tool}``) use ``:``
as a separator and can exceed 64 characters — neither of which most LLM
function-calling APIs accept in a tool/function name. These tests prove
``build_wire_aliases`` always produces a safe, collision-free, ``<=64``-char
alias for every real name and a correct reverse mapping back to it.
"""

from __future__ import annotations

import re

from harness.tools.naming import (
    MAX_WIRE_NAME_LEN,
    build_wire_aliases,
    sanitize_tool_name,
)

_SAFE_NAME_RE = re.compile(r"^[a-zA-Z0-9_-]{1,64}$")


class TestSanitizeToolName:
    def test_replaces_unsafe_characters_with_underscore(self) -> None:
        assert sanitize_tool_name("mcp:1:github:search_issues") == "mcp_1_github_search_issues"

    def test_leaves_already_safe_names_untouched(self) -> None:
        assert sanitize_tool_name("query_prometheus") == "query_prometheus"

    def test_handles_multiple_kinds_of_unsafe_characters(self) -> None:
        assert sanitize_tool_name("tool.name/with spaces!") == "tool_name_with_spaces_"


class TestBuildWireAliases:
    def test_safe_name_aliases_to_itself(self) -> None:
        alias_to_real, real_to_alias = build_wire_aliases(["query_prometheus"])
        assert real_to_alias["query_prometheus"] == "query_prometheus"
        assert alias_to_real["query_prometheus"] == "query_prometheus"

    def test_every_alias_matches_llm_safe_pattern(self) -> None:
        names = [
            "mcp:1:github:search_issues",
            "mcp:2:github:search_issues",
            "query_prometheus",
            "a" * 100,  # pathologically long real name
            "weird name/with:many:bad*chars!!",
        ]
        _, real_to_alias = build_wire_aliases(names)
        for real_name, alias in real_to_alias.items():
            assert _SAFE_NAME_RE.match(alias), f"{alias!r} (from {real_name!r}) is not LLM-safe"
            assert len(alias) <= MAX_WIRE_NAME_LEN

    def test_alias_reverses_back_to_the_exact_real_name(self) -> None:
        names = ["mcp:1:github:search_issues", "mcp:2:jira:search_issues", "query_prometheus"]
        alias_to_real, real_to_alias = build_wire_aliases(names)
        for real_name in names:
            alias = real_to_alias[real_name]
            assert alias_to_real[alias] == real_name

    def test_colliding_orgs_with_the_same_server_and_tool_name_stay_distinct(self) -> None:
        """Two orgs both naming their MCP server "github" produce qualified
        names that already differ only by the org_id segment
        (``mcp:1:github:search_issues`` vs ``mcp:2:github:search_issues``,
        see harness.mcp.models.DiscoveredTool.qualified_name, F12) — the
        wire alias must preserve that distinction, never collapsing two
        different orgs' tools onto the same alias (org isolation)."""
        names = ["mcp:1:github:search_issues", "mcp:2:github:search_issues"]
        alias_to_real, real_to_alias = build_wire_aliases(names)
        assert real_to_alias["mcp:1:github:search_issues"] != real_to_alias["mcp:2:github:search_issues"]
        assert len(alias_to_real) == 2

    def test_long_names_that_sanitize_to_the_same_prefix_still_get_distinct_aliases(self) -> None:
        """Two distinct real names long enough that naive truncation to 64
        chars would collide must still resolve to two distinct, correctly
        reversible aliases."""
        long_prefix = "mcp:1:some-really-long-server-name-that-is-quite-verbose:tool"
        name_a = long_prefix + "_alpha_variant_one"
        name_b = long_prefix + "_alpha_variant_two"
        alias_to_real, real_to_alias = build_wire_aliases([name_a, name_b])

        alias_a = real_to_alias[name_a]
        alias_b = real_to_alias[name_b]
        assert alias_a != alias_b
        assert alias_to_real[alias_a] == name_a
        assert alias_to_real[alias_b] == name_b
        assert len(alias_a) <= MAX_WIRE_NAME_LEN
        assert len(alias_b) <= MAX_WIRE_NAME_LEN

    def test_duplicate_input_names_are_idempotent(self) -> None:
        alias_to_real, real_to_alias = build_wire_aliases(["query_prometheus", "query_prometheus"])
        assert len(real_to_alias) == 1
        assert len(alias_to_real) == 1

    def test_empty_input_returns_empty_maps(self) -> None:
        alias_to_real, real_to_alias = build_wire_aliases([])
        assert alias_to_real == {}
        assert real_to_alias == {}
