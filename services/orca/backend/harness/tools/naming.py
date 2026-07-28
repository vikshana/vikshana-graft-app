"""LLM-safe tool name aliasing.

Registry tool names (``harness.tools.registry.ToolRegistry`` keys) are not
guaranteed to satisfy the character/length constraints that LLM
function-calling APIs (OpenAI, Anthropic) impose on tool/function names —
typically ``^[a-zA-Z0-9_-]{1,64}$``. In particular, MCP-qualified names
(``mcp:{org_id}:{server_name}:{tool_name}`` — see
``harness.mcp.models.DiscoveredTool.qualified_name``) use ``:`` as a
separator specifically to keep two different orgs' same-named servers from
colliding in the shared registry (F12), and can exceed 64 characters for
long server/tool names — neither of which the registry key itself needs to
worry about, but the *wire* name presented to the LLM absolutely does.

``build_wire_aliases`` computes a collision-safe, LLM-safe alias for every
real tool name in a batch (typically one org's visible tool set for a
single turn — see ``harness.tools.bridge.GuardedToolExecutor``) plus the
reverse mapping needed to resolve an LLM-issued tool call back to the real,
registry-scoped tool name. See docs/harness-risk-review.md, F1.
"""

from __future__ import annotations

import hashlib
import re

_UNSAFE_CHARS_RE = re.compile(r"[^a-zA-Z0-9_-]")

MAX_WIRE_NAME_LEN = 64
"""Longest tool/function name most LLM function-calling APIs accept
(OpenAI's ``tools[].function.name`` limit; Anthropic's is more lenient but
this is the more restrictive, and therefore safe, common denominator)."""

_HASH_LEN = 10


def sanitize_tool_name(name: str) -> str:
    """Replace every character outside ``[a-zA-Z0-9_-]`` with ``_``.

    Args:
        name: Real registry tool name (any string).

    Returns:
        A name containing only characters LLM tool-calling APIs accept.
        May still exceed ``MAX_WIRE_NAME_LEN`` — see ``build_wire_aliases``
        for truncation and collision handling, which this function
        intentionally does not perform (it is a pure, order-independent
        transform reused by the batch builder below).
    """
    return _UNSAFE_CHARS_RE.sub("_", name)


def _content_hash(name: str) -> str:
    """Short, stable hash of a real tool name used to disambiguate collisions."""
    return hashlib.sha256(name.encode("utf-8")).hexdigest()[:_HASH_LEN]


def _fit_with_hash_suffix(candidate: str, real_name: str) -> str:
    """Truncate ``candidate`` to fit ``MAX_WIRE_NAME_LEN`` with a hash suffix.

    Args:
        candidate: Sanitised candidate alias (may already fit or not).
        real_name: Original real tool name — hashed for the suffix so the
            result is stable and deterministic for a given real name.

    Returns:
        A ``<=MAX_WIRE_NAME_LEN``-char string ending in ``_{10-char-hash}``.
    """
    suffix = "_" + _content_hash(real_name)
    return candidate[: MAX_WIRE_NAME_LEN - len(suffix)] + suffix


def build_wire_aliases(real_names: list[str]) -> tuple[dict[str, str], dict[str, str]]:
    """Compute collision-safe, ``<=64``-char, LLM-safe aliases for tool names.

    Every input name gets exactly one alias; two different input names
    never alias to the same wire name — a short content hash of the
    original name is appended to disambiguate whenever sanitisation and/or
    length truncation would otherwise make two distinct real names collide
    on the same wire alias.

    Args:
        real_names: Real registry tool names to alias (e.g. every tool
            visible to one org for the current turn, from
            ``registry.all_tools()``). Duplicates are ignored (idempotent).

    Returns:
        ``(alias_to_real, real_to_alias)`` — pass the LLM-issued tool-call
        name through ``alias_to_real`` to recover the real, registry-scoped
        tool name; pass a real tool name through ``real_to_alias`` to find
        the wire-safe name to expose to the LLM.
    """
    alias_to_real: dict[str, str] = {}
    real_to_alias: dict[str, str] = {}

    for real_name in real_names:
        if real_name in real_to_alias:
            continue  # duplicate input — already aliased

        candidate = sanitize_tool_name(real_name)
        if len(candidate) > MAX_WIRE_NAME_LEN:
            candidate = _fit_with_hash_suffix(candidate, real_name)

        if candidate in alias_to_real:
            # A different real name already claimed this exact alias
            # (sanitisation and/or truncation collapsed two distinct real
            # names onto the same wire string) — disambiguate
            # deterministically using a hash of *this* real name.
            candidate = _fit_with_hash_suffix(sanitize_tool_name(real_name), real_name)
            while candidate in alias_to_real:
                # Only reachable if that hash-suffixed alias is itself
                # already taken by yet another real name — astronomically
                # unlikely (a second, independent SHA-256 collision), but
                # never silently drop a tool: keep re-hashing until unique.
                candidate = _content_hash(candidate + real_name)

        alias_to_real[candidate] = real_name
        real_to_alias[real_name] = candidate

    return alias_to_real, real_to_alias
