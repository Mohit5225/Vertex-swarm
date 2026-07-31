"""Prompt loader — reads tool guidance prose from markdown files and caches them in memory.

Files live in app/prompts/tools/<category>.md.
Loaded once at first access per process. No I/O on subsequent calls.
"""
import logging
from pathlib import Path
from typing import Optional

logger = logging.getLogger(__name__)

_PROMPTS_DIR = Path(__file__).parent.parent / "prompts" / "tools"

# In-process cache: category -> prose string
_cache: dict[str, str] = {}

# Canonical list of supported categories
SUPPORTED_CATEGORIES: list[str] = [
    "workspace_ops",
    "terminal_ops",
    "plan_tool",
    "todo_tool",
    "web_search",
    "spawn_subagent",
    "hil_tool",
]

# One-line descriptions — mirrored from TOOL CATALOG in llm_service.py
CATEGORY_DESCRIPTIONS: dict[str, str] = {
    "workspace_ops": (
        "File operations: read, search, list, create, edit, rename, delete. "
        "Never write source files via the terminal."
    ),
    "terminal_ops": (
        "Shell commands, builds, tests, lint, git, installs, and diagnostics."
    ),
    "plan_tool": (
        "Present an implementation plan and wait for user approval before invasive changes."
    ),
    "todo_tool": "Drive the persistent execution checklist widget.",
    "web_search": "Look up external docs, APIs, errors, or version-specific facts not in the repo.",
    "spawn_subagent": (
        "Parallel or isolated deliverables via child agents — not for routine one-file edits."
    ),
    "hil_tool": (
        "Structured multiple-choice questions via an inline card; blocks until the user answers."
    ),
}


def load_category(category: str) -> Optional[str]:
    """Return the guidance prose for a tool category.

    Returns None if the category is unknown or the file is missing.
    """
    if category in _cache:
        return _cache[category]

    if category not in SUPPORTED_CATEGORIES:
        logger.warning("prompt_loader: unknown category requested: %s", category)
        return None

    file_path = _PROMPTS_DIR / f"{category}.md"
    if not file_path.exists():
        logger.error("prompt_loader: guidance file missing: %s", file_path)
        return None

    try:
        prose = file_path.read_text(encoding="utf-8").strip()
        _cache[category] = prose
        logger.info("prompt_loader: loaded category=%s chars=%d", category, len(prose))
        return prose
    except OSError as exc:
        logger.error("prompt_loader: failed to read %s: %s", file_path, exc)
        return None


def load_categories(categories: list[str]) -> dict[str, str]:
    """Load multiple categories at once. Returns only the ones that succeeded."""
    result: dict[str, str] = {}
    for category in categories:
        prose = load_category(category)
        if prose is not None:
            result[category] = prose
    return result


def build_already_loaded_tools_block(active_categories: list[str]) -> str:
    """Summarize which tool categories are already loaded for this session."""
    if not active_categories:
        return ""

    lines = [
        "## ALREADY LOADED TOOLS",
        (
            "These categories are already active. Their schemas are in tools[] and "
            "full usage guidance follows below. Do NOT call load_tool_context for them again."
        ),
        "",
    ]
    for category in active_categories:
        description = CATEGORY_DESCRIPTIONS.get(category, "Loaded tool category.")
        lines.append(f"- {category}: {description}")
    return "\n".join(lines)


def build_injected_guidance(active_categories: list[str]) -> str:
    """Build the combined guidance block to prepend to the system prompt.

    Called on every LLM round once categories are known for this session.
    Returns an empty string if no categories are active yet.
    """
    if not active_categories:
        return ""

    notice = build_already_loaded_tools_block(active_categories)
    loaded = load_categories(active_categories)
    if not loaded:
        return notice

    sections: list[str] = [notice]
    for category in active_categories:
        prose = loaded.get(category)
        if prose:
            sections.append(prose)

    return "\n\n---\n\n".join(sections)


_DEEP_PLAN_GUIDANCE_CACHE: str | None = None
_REQ_EXTRACTION_CACHE: str | None = None
_CATALOG_GUIDE_CACHE: str | None = None
_DEEP_PLAN_DIR = Path(__file__).parent.parent / "prompts" / "deep_plan"


def load_req_extraction_guidance() -> str | None:
    """Additive req-phase instructions — injected with gate open, before handoff."""
    global _REQ_EXTRACTION_CACHE
    if _REQ_EXTRACTION_CACHE is not None:
        return _REQ_EXTRACTION_CACHE
    file_path = _DEEP_PLAN_DIR / "req_extraction.md"
    if not file_path.exists():
        logger.error("prompt_loader: req_extraction guidance missing: %s", file_path)
        return None
    try:
        _REQ_EXTRACTION_CACHE = file_path.read_text(encoding="utf-8").strip()
        return _REQ_EXTRACTION_CACHE
    except OSError as exc:
        logger.error("prompt_loader: failed to read %s: %s", file_path, exc)
        return None


def load_catalog_guide() -> str | None:
    """Stage routing guide for req phase (Vertex only)."""
    global _CATALOG_GUIDE_CACHE
    if _CATALOG_GUIDE_CACHE is not None:
        return _CATALOG_GUIDE_CACHE
    file_path = _DEEP_PLAN_DIR / "catalog_guide.md"
    if not file_path.exists():
        logger.error("prompt_loader: catalog_guide missing: %s", file_path)
        return None
    try:
        _CATALOG_GUIDE_CACHE = file_path.read_text(encoding="utf-8").strip()
        return _CATALOG_GUIDE_CACHE
    except OSError as exc:
        logger.error("prompt_loader: failed to read %s: %s", file_path, exc)
        return None


def load_deep_plan_gate_guidance() -> str | None:
    """Req extraction + catalog + deep_plan_tool usage when gate is open."""
    sections: list[str] = []
    for loader in (load_req_extraction_guidance, load_catalog_guide, load_deep_plan_tool_guidance):
        prose = loader()
        if prose:
            sections.append(prose)
    if not sections:
        return None
    return "\n\n---\n\n".join(sections)


def load_deep_plan_tool_guidance() -> str | None:
    """Usage guidance for deep_plan_tool — injected when session gate opens."""
    global _DEEP_PLAN_GUIDANCE_CACHE
    if _DEEP_PLAN_GUIDANCE_CACHE is not None:
        return _DEEP_PLAN_GUIDANCE_CACHE

    file_path = _PROMPTS_DIR / "deep_plan_tool.md"
    if not file_path.exists():
        logger.error("prompt_loader: deep_plan_tool guidance missing: %s", file_path)
        return None
    try:
        _DEEP_PLAN_GUIDANCE_CACHE = file_path.read_text(encoding="utf-8").strip()
        return _DEEP_PLAN_GUIDANCE_CACHE
    except OSError as exc:
        logger.error("prompt_loader: failed to read %s: %s", file_path, exc)
        return None
