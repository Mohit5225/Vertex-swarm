"""Helpers for multimodal OpenAI-style message content."""

from __future__ import annotations

from copy import deepcopy
from typing import Any


def build_user_content(text: str | None, image_data_uris: list[str]) -> str | list[dict[str, Any]]:
    parts: list[dict[str, Any]] = []
    cleaned = (text or "").strip()
    if cleaned:
        parts.append({"type": "text", "text": cleaned})
    for uri in image_data_uris:
        parts.append({"type": "image_url", "image_url": {"url": uri}})

    if not parts:
        return ""
    if len(parts) == 1 and parts[0].get("type") == "text":
        return parts[0]["text"]
    return parts


def message_has_image_parts(message: dict[str, Any]) -> bool:
    content = message.get("content")
    if not isinstance(content, list):
        return False
    return any(
        isinstance(part, dict) and part.get("type") == "image_url"
        for part in content
    )


def strip_image_parts(messages: list[dict[str, Any]]) -> tuple[bool, list[dict[str, Any]]]:
    """Return a copy of messages with image_url parts removed from user content."""
    changed = False
    result: list[dict[str, Any]] = []

    for message in messages:
        content = message.get("content")
        if not isinstance(content, list):
            result.append(message)
            continue

        kept: list[dict[str, Any]] = []
        removed_images = False
        for part in content:
            if isinstance(part, dict) and part.get("type") == "image_url":
                removed_images = True
                continue
            kept.append(part)

        if not removed_images:
            result.append(message)
            continue

        changed = True
        updated = deepcopy(message)
        if not kept:
            updated["content"] = "[Image attachment omitted from model context]"
        elif len(kept) == 1 and kept[0].get("type") == "text":
            updated["content"] = kept[0]["text"]
        else:
            updated["content"] = kept
        result.append(updated)

    return changed, result
