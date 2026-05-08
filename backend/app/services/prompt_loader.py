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
SUPPORTED_CATEGORIES: list[str] = ["workspace_ops", "terminal_ops"]


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


def build_injected_guidance(active_categories: list[str]) -> str:
    """Build the combined guidance block to prepend to the system prompt.

    Called on every turn from chat.py once categories are known for this session.
    Returns an empty string if no categories are active yet.
    """
    if not active_categories:
        return ""

    loaded = load_categories(active_categories)
    if not loaded:
        return ""

    sections: list[str] = []
    for category in active_categories:
        prose = loaded.get(category)
        if prose:
            sections.append(prose)

    return "\n\n---\n\n".join(sections)
