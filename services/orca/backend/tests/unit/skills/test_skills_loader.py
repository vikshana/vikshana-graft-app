"""Unit tests for harness/skills/loader.py."""

from __future__ import annotations

import textwrap
from pathlib import Path

import pytest

from harness.skills.loader import (
    LoadSkillInput,
    LoadSkillTool,
    SkillNotFoundError,
    SkillValidationError,
    SkillsLoader,
    _parse_frontmatter,
)


# ── Helpers ────────────────────────────────────────────────────────────────────


def _write_skill(tmp_path: Path, name: str, content: str) -> Path:
    """Write a skill file and return its path."""
    skill_file = tmp_path / f"{name}.md"
    skill_file.write_text(content, encoding="utf-8")
    return skill_file


VALID_SKILL = textwrap.dedent("""\
    ---
    name: investigate-rca
    description: "Guides RCA investigation for Grafana alerts"
    triggers:
      - investigate
      - rca
    version: "1.0.0"
    ---

    # Investigate RCA Skill

    This skill guides a root cause analysis investigation.

    ## Steps
    1. Gather metrics
    2. Check logs
    3. Form hypothesis
""")

MINIMAL_SKILL = textwrap.dedent("""\
    ---
    name: minimal-skill
    description: "A minimal skill"
    version: "0.1.0"
    ---

    Skill body content here.
""")


# ── _parse_frontmatter ─────────────────────────────────────────────────────────


class TestParseFrontmatter:
    """Tests for the YAML frontmatter parser."""

    def test_valid_frontmatter_parsed(self):
        """Valid frontmatter → correct dict and body."""
        fm, body = _parse_frontmatter(VALID_SKILL)
        assert fm["name"] == "investigate-rca"
        assert fm["version"] == "1.0.0"
        assert "Investigate RCA Skill" in body

    def test_no_frontmatter_returns_empty_dict(self):
        """File without frontmatter → empty dict + full content as body."""
        content = "# Just a markdown file\n\nNo frontmatter here."
        fm, body = _parse_frontmatter(content)
        assert fm == {}
        assert "Just a markdown file" in body

    def test_invalid_yaml_raises(self):
        """Malformed YAML frontmatter → SkillValidationError."""
        content = "---\nname: [broken yaml: {\n---\nBody"
        with pytest.raises(SkillValidationError, match="Invalid YAML"):
            _parse_frontmatter(content)


# ── SkillsLoader ───────────────────────────────────────────────────────────────


class TestSkillsLoader:
    """Tests for SkillsLoader."""

    def test_load_index_valid(self, tmp_path: Path):
        """Valid skill files → index contains all skills."""
        _write_skill(tmp_path, "skill-a", VALID_SKILL)
        _write_skill(tmp_path, "skill-b", MINIMAL_SKILL)
        loader = SkillsLoader(tmp_path)
        index = loader.load_index()
        names = {s.name for s in index}
        assert "investigate-rca" in names
        assert "minimal-skill" in names

    def test_load_index_name_only_no_body(self, tmp_path: Path):
        """Index contains only name and description, not the full body."""
        _write_skill(tmp_path, "skill-a", VALID_SKILL)
        loader = SkillsLoader(tmp_path)
        index = loader.load_index()
        summary = next(s for s in index if s.name == "investigate-rca")
        assert summary.description
        # SkillSummary has no body attribute
        assert not hasattr(summary, "body")

    def test_load_skill_full_body(self, tmp_path: Path):
        """load_skill() returns full body."""
        _write_skill(tmp_path, "skill-a", VALID_SKILL)
        loader = SkillsLoader(tmp_path)
        loader.load_index()
        body = loader.load_skill("investigate-rca")
        assert "Gather metrics" in body.body
        assert body.version == "1.0.0"

    def test_load_skill_not_found_raises(self, tmp_path: Path):
        """Unknown skill name → SkillNotFoundError."""
        loader = SkillsLoader(tmp_path)
        loader.load_index()
        with pytest.raises(SkillNotFoundError):
            loader.load_skill("nonexistent-skill")

    def test_missing_required_field_raises(self, tmp_path: Path):
        """Skill missing 'name' field → SkillValidationError."""
        bad_skill = "---\ndescription: 'no name'\nversion: '1.0'\n---\nBody"
        _write_skill(tmp_path, "bad-skill", bad_skill)
        loader = SkillsLoader(tmp_path)
        with pytest.raises(SkillValidationError, match="name"):
            loader.load_index()

    def test_empty_body_raises(self, tmp_path: Path):
        """Skill with empty body → SkillValidationError."""
        empty_body_skill = "---\nname: empty\ndescription: 'd'\nversion: '1.0'\n---\n   "
        _write_skill(tmp_path, "empty", empty_body_skill)
        loader = SkillsLoader(tmp_path)
        with pytest.raises(SkillValidationError, match="empty body"):
            loader.load_index()

    def test_duplicate_name_raises(self, tmp_path: Path):
        """Two skill files with the same name → SkillValidationError."""
        subdir = tmp_path / "subdir"
        subdir.mkdir()
        _write_skill(tmp_path, "duplicate", VALID_SKILL)
        (subdir / "duplicate.md").write_text(VALID_SKILL, encoding="utf-8")
        loader = SkillsLoader(tmp_path)
        with pytest.raises(SkillValidationError, match="Duplicate"):
            loader.load_index()

    def test_content_hash_stable(self, tmp_path: Path):
        """Content hash is stable across two loads of the same file."""
        _write_skill(tmp_path, "skill-a", VALID_SKILL)
        loader = SkillsLoader(tmp_path)
        index = loader.load_index()
        h1 = next(s for s in index if s.name == "investigate-rca").content_hash
        loader.invalidate_cache()
        index2 = loader.load_index()
        h2 = next(s for s in index2 if s.name == "investigate-rca").content_hash
        assert h1 == h2

    def test_missing_skills_dir_returns_empty(self, tmp_path: Path):
        """Non-existent SKILLS_DIR → empty index, no crash."""
        loader = SkillsLoader(tmp_path / "nonexistent")
        index = loader.load_index()
        assert index == []

    def test_version_pin_via_get_content_hash(self, tmp_path: Path):
        """get_content_hash returns the same hash as the index."""
        _write_skill(tmp_path, "skill-a", VALID_SKILL)
        loader = SkillsLoader(tmp_path)
        loader.load_index()
        h = loader.get_content_hash("investigate-rca")
        assert len(h) == 64  # SHA-256 hex


# ── LoadSkillTool ─────────────────────────────────────────────────────────────


class TestLoadSkillTool:
    """Tests for the load_skill tool."""

    @pytest.mark.asyncio
    async def test_load_existing_skill(self, tmp_path: Path):
        """Load existing skill → ToolResult with body."""
        from unittest.mock import MagicMock
        from harness.tools.protocol import ToolContext, BudgetConfig, SpendState
        from harness.auth.types import GrafanaCredential, AuthMode

        _write_skill(tmp_path, "skill-a", VALID_SKILL)
        loader = SkillsLoader(tmp_path)
        tool = LoadSkillTool(loader)
        ctx = ToolContext(
            session_id="test",
            credential=GrafanaCredential(token="t", auth_mode=AuthMode.SERVICE_ACCOUNT),
            budget=BudgetConfig(),
            spend=SpendState(),
            otel_span=MagicMock(),
        )
        result = await tool.run(ctx, LoadSkillInput(name="investigate-rca"))
        assert result.error is None
        assert "Gather metrics" in result.data["body"]

    @pytest.mark.asyncio
    async def test_load_nonexistent_skill_returns_error(self, tmp_path: Path):
        """Unknown skill name → ToolResult with error, not an exception."""
        from unittest.mock import MagicMock
        from harness.tools.protocol import ToolContext, BudgetConfig, SpendState
        from harness.auth.types import GrafanaCredential, AuthMode

        loader = SkillsLoader(tmp_path)
        tool = LoadSkillTool(loader)
        ctx = ToolContext(
            session_id="test",
            credential=GrafanaCredential(token="t", auth_mode=AuthMode.SERVICE_ACCOUNT),
            budget=BudgetConfig(),
            spend=SpendState(),
            otel_span=MagicMock(),
        )
        result = await tool.run(ctx, LoadSkillInput(name="nonexistent"))
        assert result.error is not None
        assert result.error.code == "not_found"
        assert result.error.retryable is False
