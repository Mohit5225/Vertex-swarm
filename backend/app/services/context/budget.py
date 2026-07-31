"""Token estimation for context budgeting."""

from __future__ import annotations

import math
from typing import Any

try:
    import tiktoken
except ImportError:  # pragma: no cover
    tiktoken = None  # type: ignore[assignment]

_IMAGE_TILE_SIZE = 512
_IMAGE_BASE_TOKENS = 85
_IMAGE_PER_TILE_TOKENS = 85


def _get_encoder():
    if tiktoken is None:
        return None
    try:
        return tiktoken.get_encoding("cl100k_base")
    except Exception:
        return None


def estimate_text_tokens(text: str | None) -> int:
    if not text:
        return 0
    encoder = _get_encoder()
    if encoder is None:
        return max(1, len(text) // 4)
    try:
        return len(encoder.encode(text))
    except Exception:
        return max(1, len(text) // 4)


def _fit_dimensions(width: int, height: int) -> tuple[int, int]:
    if width <= 0 or height <= 0:
        return 1, 1

    long_edge = max(width, height)
    short_edge = min(width, height)

    if long_edge > 2048:
        scale = 2048 / long_edge
        width = max(1, int(width * scale))
        height = max(1, int(height * scale))
        long_edge = max(width, height)
        short_edge = min(width, height)

    if short_edge > 768:
        scale = 768 / short_edge
        width = max(1, int(width * scale))
        height = max(1, int(height * scale))

    return width, height


def estimate_image_tokens(width: int, height: int) -> int:
    """OpenAI-style tile estimate after resize-to-fit rules."""
    fitted_w, fitted_h = _fit_dimensions(width, height)
    tiles_w = math.ceil(fitted_w / _IMAGE_TILE_SIZE)
    tiles_h = math.ceil(fitted_h / _IMAGE_TILE_SIZE)
    tile_count = max(1, tiles_w * tiles_h)
    return _IMAGE_BASE_TOKENS + tile_count * _IMAGE_PER_TILE_TOKENS


def message_content_text(content: Any) -> str:
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts: list[str] = []
        for part in content:
            if not isinstance(part, dict):
                continue
            if part.get("type") == "text" and isinstance(part.get("text"), str):
                parts.append(part["text"])
        return "\n".join(parts)
    return ""
