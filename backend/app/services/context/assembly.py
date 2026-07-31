"""Assemble chat history into LLM messages with optional image parts."""

from __future__ import annotations

import logging
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from app.services.context.image_encoding import EncodedImage, encode_image_file
from app.services.context.message_parts import build_user_content
from app.services.context.paths import resolve_attachment_path
from app.services.context.policy import ContextPolicy

logger = logging.getLogger(__name__)


@dataclass
class AssemblyResult:
    messages: list[dict[str, Any]]
    notifications: list[str] = field(default_factory=list)


def _attachment_records(message: dict[str, Any]) -> list[dict[str, Any]]:
    raw = message.get("attachments")
    if not isinstance(raw, list):
        return []
    return [item for item in raw if isinstance(item, dict)]


def _eligible_image_user_indices(
    history_raw: list[dict[str, Any]],
    max_turns_in_context: int,
) -> set[int]:
    if max_turns_in_context < 1:
        return set()

    indices: list[int] = []
    for index, message in enumerate(history_raw):
        if message.get("role") != "user":
            continue
        if not _attachment_records(message):
            continue
        indices.append(index)

    return set(indices[-max_turns_in_context:])


def _encode_attachments_for_message(
    chat_dir: Path,
    attachments: list[dict[str, Any]],
    policy: ContextPolicy,
) -> tuple[list[EncodedImage], list[str]]:
    notifications: list[str] = []
    encoded: list[EncodedImage] = []
    limited = attachments[: policy.images.send_max_count]

    if len(attachments) > len(limited):
        dropped = len(attachments) - len(limited)
        notifications.append(
            f"Dropped {dropped} image(s): exceeds send limit of {policy.images.send_max_count} per message."
        )

    for attachment in limited:
        relative_path = attachment.get("relativePath")
        filename = attachment.get("filename") or attachment.get("id") or "image"
        if not isinstance(relative_path, str):
            notifications.append(f"Skipped image {filename}: missing path metadata.")
            continue
        try:
            path = resolve_attachment_path(chat_dir, relative_path)
            if not path.is_file():
                notifications.append(f"Skipped image {filename}: file not found on disk.")
                continue
            encoded.append(encode_image_file(path, policy.images))
        except Exception as exc:
            logger.warning("failed to encode attachment %s: %s", filename, exc)
            notifications.append(f"Skipped image {filename}: {exc}")

    total_tokens = sum(item.estimated_tokens for item in encoded)
    if total_tokens <= policy.images.max_tokens_for_images_total:
        return encoded, notifications

    kept: list[EncodedImage] = []
    running = 0
    for item in encoded:
        if running + item.estimated_tokens > policy.images.max_tokens_for_images_total:
            notifications.append("Dropped an image: exceeded image token budget.")
            continue
        kept.append(item)
        running += item.estimated_tokens

    return kept, notifications


def _history_content(
    message: dict[str, Any],
    *,
    chat_dir: Path,
    policy: ContextPolicy,
    include_images: bool,
    notifications: list[str],
) -> str | list[dict[str, Any]]:
    role = message.get("role")
    text = message.get("content")
    text_value = text if isinstance(text, str) else ""

    attachments = _attachment_records(message)
    if role == "user" and include_images and attachments:
        encoded, notes = _encode_attachments_for_message(chat_dir, attachments, policy)
        notifications.extend(notes)
        if encoded:
            return build_user_content(text_value, [item.data_uri for item in encoded])

    if text_value.strip():
        return text_value
    if role == "assistant":
        return "[Executed workspace tools]"
    if attachments:
        return text_value
    return "[Empty message]"


def assemble_history_messages(
    history_raw: list[dict[str, Any]],
    chat_dir: Path,
    policy: ContextPolicy,
) -> AssemblyResult:
    notifications: list[str] = []
    eligible = _eligible_image_user_indices(
        history_raw,
        policy.images.max_turns_in_context,
    )

    messages: list[dict[str, Any]] = []
    for index, message in enumerate(history_raw):
        role = message.get("role")
        if role not in {"user", "assistant", "system"}:
            continue

        content = _history_content(
            message,
            chat_dir=chat_dir,
            policy=policy,
            include_images=index in eligible,
            notifications=notifications,
        )
        messages.append({"role": role, "content": content})

    return AssemblyResult(messages=messages, notifications=notifications)
