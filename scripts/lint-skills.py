#!/usr/bin/env python3
"""lint-skills.py — validate all skill files in SKILLS_DIR.

Usage:
    python scripts/lint-skills.py [--skills-dir /path/to/skills]

Exits with code 0 on success, 1 if any skill fails validation.
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path


def main() -> int:
    """Run skill validation and report results.

    Returns:
        Exit code (0 = all valid, 1 = failures found).
    """
    parser = argparse.ArgumentParser(description="Validate Graft skill files")
    parser.add_argument(
        "--skills-dir",
        default=None,
        help="Path to skills directory (default: SKILLS_DIR env var or /skills)",
    )
    args = parser.parse_args()

    if args.skills_dir:
        skills_dir = Path(args.skills_dir)
    else:
        import os
        skills_dir = Path(os.environ.get("SKILLS_DIR", "/skills"))

    if not skills_dir.exists():
        print(f"ERROR: Skills directory does not exist: {skills_dir}")
        return 1

    # Add backend to path so we can import harness
    backend_dir = Path(__file__).parent.parent / "services" / "orca" / "backend"
    if backend_dir.exists():
        sys.path.insert(0, str(backend_dir))

    try:
        from harness.skills.loader import SkillsLoader, SkillValidationError
    except ImportError:
        print("ERROR: Cannot import harness.skills.loader — run from the repo root")
        return 1

    loader = SkillsLoader(skills_dir)
    failures: list[str] = []

    skill_files = list(skills_dir.rglob("*.md"))
    if not skill_files:
        print(f"WARNING: No .md files found in {skills_dir}")
        return 0

    print(f"Checking {len(skill_files)} skill file(s) in {skills_dir} ...")

    try:
        index = loader.load_index()
        print(f"  ✓ All {len(index)} skills passed validation")
        for summary in sorted(index, key=lambda s: s.name):
            print(f"    - {summary.name} v{summary.version}: {summary.description[:60]}")
        return 0
    except SkillValidationError as exc:
        print(f"  ✗ Validation failed: {exc}")
        return 1


if __name__ == "__main__":
    sys.exit(main())
