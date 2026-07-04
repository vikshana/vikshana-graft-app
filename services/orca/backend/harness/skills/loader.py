"""Skills loader — reads SKILL.md files with YAML frontmatter from SKILLS_DIR.

Skills are provisioned by platform admins (not user-writable).
The loader:
  1. Parses ``---`` YAML frontmatter from each SKILL.md file.
  2. Builds a lean index (name + description only) for system prompt injection.
  3. Returns the full body only when the ``load_skill`` tool is called.
  4. Records content hashes for session reproducibility (``skill_version_pins``).

Frontmatter format::

    ---
    name: investigate-rca
    description: "Guides an RCA investigation for Grafana alerts"
    triggers:
      - investigate
      - rca
    version: "1.0.0"
    ---

    Full skill body markdown here...
"""

from __future__ import annotations

import hashlib
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import structlog
import yaml
from pydantic import BaseModel

from harness.tools.protocol import CostClass, ToolContext, ToolResult, ToolError

logger = structlog.get_logger()


# ---------------------------------------------------------------------------
# Data models
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class SkillSummary:
    """Lightweight skill descriptor for the system prompt index.

    Attributes:
        name: Unique skill name.
        description: One-sentence description for the model index.
        version: Skill version string.
        content_hash: SHA-256 hex digest of the full file content.
    """

    name: str
    description: str
    version: str
    content_hash: str


@dataclass(frozen=True)
class SkillBody:
    """Full skill content returned by ``load_skill``.

    Attributes:
        name: Unique skill name.
        description: One-sentence description.
        version: Skill version string.
        body: Full markdown content (everything after the frontmatter).
        content_hash: SHA-256 hex digest of the full file content.
    """

    name: str
    description: str
    version: str
    body: str
    content_hash: str


class SkillValidationError(Exception):
    """Raised when a skill file fails validation."""


class SkillNotFoundError(Exception):
    """Raised when a requested skill name is not found in SKILLS_DIR."""


# ---------------------------------------------------------------------------
# SkillsLoader
# ---------------------------------------------------------------------------


class SkillsLoader:
    """Loads and validates skills from a directory of SKILL.md files.

    Skills are expected to follow the naming convention:
    ``<name>/SKILL.md`` or just ``<name>.md`` inside ``SKILLS_DIR``.
    The loader discovers all ``.md`` files recursively.

    Args:
        skills_dir: Path to the directory containing skill files.
    """

    def __init__(self, skills_dir: Path) -> None:
        self._dir = skills_dir
        self._index: dict[str, SkillSummary] | None = None

    def load_index(self) -> list[SkillSummary]:
        """Load and return the skill index (name + description only).

        Results are cached in memory.  Re-call after provisioning new skills.

        Returns:
            List of SkillSummary objects for all valid skills in SKILLS_DIR.

        Raises:
            SkillValidationError: If any skill file fails validation.
        """
        if self._index is not None:
            return list(self._index.values())

        self._index = {}
        if not self._dir.exists():
            logger.warning("skills_dir_not_found", path=str(self._dir))
            return []

        for skill_file in sorted(self._dir.rglob("*.md")):
            try:
                summary = self._load_summary(skill_file)
                if summary.name in self._index:
                    raise SkillValidationError(
                        f"Duplicate skill name {summary.name!r} in {skill_file}"
                    )
                self._index[summary.name] = summary
                logger.debug("skill_loaded", name=summary.name, version=summary.version)
            except SkillValidationError:
                raise
            except Exception as exc:
                raise SkillValidationError(
                    f"Failed to load skill from {skill_file}: {exc}"
                ) from exc

        logger.info("skills_index_built", count=len(self._index))
        return list(self._index.values())

    def load_skill(self, name: str) -> SkillBody:
        """Load the full body of a named skill.

        Args:
            name: Skill name (from frontmatter).

        Returns:
            SkillBody with full markdown content.

        Raises:
            SkillNotFoundError: If the skill is not in the index.
        """
        if self._index is None:
            self.load_index()

        assert self._index is not None
        if name not in self._index:
            raise SkillNotFoundError(
                f"Skill {name!r} not found. "
                f"Available skills: {sorted(self._index.keys())}"
            )

        # Find the file again by re-scanning (ensures fresh content)
        for skill_file in self._dir.rglob("*.md"):
            try:
                fm, body = _parse_frontmatter(skill_file.read_text(encoding="utf-8"))
                if fm.get("name") == name:
                    content = skill_file.read_text(encoding="utf-8")
                    return SkillBody(
                        name=name,
                        description=str(fm.get("description", "")),
                        version=str(fm.get("version", "0.0.0")),
                        body=body,
                        content_hash=_sha256(content),
                    )
            except Exception:
                continue

        raise SkillNotFoundError(f"Skill file for {name!r} no longer exists")

    def get_content_hash(self, name: str) -> str:
        """Return the content hash for a skill (for ``skill_version_pins``).

        Args:
            name: Skill name.

        Returns:
            SHA-256 hex digest string.

        Raises:
            SkillNotFoundError: If the skill is not found.
        """
        if self._index is None:
            self.load_index()
        assert self._index is not None
        if name not in self._index:
            raise SkillNotFoundError(f"Skill {name!r} not found")
        return self._index[name].content_hash

    def invalidate_cache(self) -> None:
        """Clear the in-memory index (force reload on next access)."""
        self._index = None

    def _load_summary(self, skill_file: Path) -> SkillSummary:
        """Parse a single skill file and return a SkillSummary.

        Args:
            skill_file: Path to the skill markdown file.

        Returns:
            SkillSummary for the skill.

        Raises:
            SkillValidationError: If required fields are missing or YAML is invalid.
        """
        content = skill_file.read_text(encoding="utf-8")
        fm, body = _parse_frontmatter(content)
        _validate_frontmatter(fm, skill_file)

        if not body.strip():
            raise SkillValidationError(
                f"Skill {skill_file} has an empty body (no content after frontmatter)"
            )

        return SkillSummary(
            name=str(fm["name"]),
            description=str(fm.get("description", "")),
            version=str(fm.get("version", "0.0.0")),
            content_hash=_sha256(content),
        )


# ---------------------------------------------------------------------------
# LoadSkillTool — registered as a cheap Tool in the ToolRegistry
# ---------------------------------------------------------------------------


class LoadSkillInput(BaseModel):
    """Input for the load_skill tool."""

    name: str


class LoadSkillTool:
    """Tool that loads the full body of a named skill on demand.

    Registered as ``cost_class=CHEAP`` — no guard costs, no approval needed.
    The skill index is injected into the system prompt; full bodies are loaded
    lazily via this tool.
    """

    name = "load_skill"
    description = (
        "Load the full instructions for a named skill. "
        "The skill index lists available skills; call this to get the full "
        "content of a specific skill before beginning investigation."
    )
    input_schema = LoadSkillInput
    cost_class = CostClass.CHEAP

    def __init__(self, loader: SkillsLoader) -> None:
        self._loader = loader

    async def run(self, ctx: ToolContext, input: LoadSkillInput) -> ToolResult:
        """Return the full body of the named skill.

        Args:
            ctx: Tool context (unused).
            input: Validated LoadSkillInput with skill name.

        Returns:
            ToolResult with the full skill body as ``{"name": ..., "body": ...}``.
        """
        try:
            body = self._loader.load_skill(input.name)
            return ToolResult(
                data={"name": body.name, "version": body.version, "body": body.body},
                source="internal",
            )
        except SkillNotFoundError as exc:
            return ToolResult(
                data=None,
                error=ToolError(code="not_found", message=str(exc), retryable=False),
            )


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _parse_frontmatter(content: str) -> tuple[dict[str, Any], str]:
    """Parse YAML frontmatter from a markdown string.

    Args:
        content: Full file content including optional ``---`` frontmatter.

    Returns:
        Tuple of (frontmatter_dict, body_string).
        Returns empty dict + full content if no frontmatter is present.

    Raises:
        SkillValidationError: If the YAML is malformed.
    """
    content = content.strip()
    if not content.startswith("---"):
        return {}, content

    lines = content.split("\n")
    # Find the closing ---
    end_idx = None
    for i, line in enumerate(lines[1:], start=1):
        if line.strip() == "---":
            end_idx = i
            break

    if end_idx is None:
        return {}, content

    yaml_str = "\n".join(lines[1:end_idx])
    body = "\n".join(lines[end_idx + 1:]).strip()

    try:
        fm = yaml.safe_load(yaml_str) or {}
    except yaml.YAMLError as exc:
        raise SkillValidationError(f"Invalid YAML frontmatter: {exc}") from exc

    return fm, body


def _validate_frontmatter(fm: dict[str, Any], path: Path) -> None:
    """Validate that required frontmatter fields are present.

    Args:
        fm: Parsed frontmatter dict.
        path: File path for error messages.

    Raises:
        SkillValidationError: If required fields are missing or empty.
    """
    required = ("name", "description", "version")
    for field in required:
        if field not in fm or not str(fm[field]).strip():
            raise SkillValidationError(
                f"Skill {path}: missing or empty required frontmatter field {field!r}"
            )


def _sha256(content: str) -> str:
    """Compute SHA-256 hex digest of a string.

    Args:
        content: String to hash.

    Returns:
        64-character hex digest.
    """
    return hashlib.sha256(content.encode()).hexdigest()


# ---------------------------------------------------------------------------
# Module-level singleton
# ---------------------------------------------------------------------------


def make_skills_loader() -> SkillsLoader:
    """Construct a SkillsLoader from application settings.

    Returns:
        Configured SkillsLoader pointed at ``settings.SKILLS_DIR``.
    """
    from app.config import settings
    skills_dir = Path(getattr(settings, "SKILLS_DIR", "/skills"))
    return SkillsLoader(skills_dir)
