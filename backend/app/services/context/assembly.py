"""Assemble chat history into LLM messages with optional image parts."""

from __future__ import annotations

import logging
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from app.services.context.budget import compute_text_budget
from app.services.context.image_encoding import EncodedImage, encode_image_file
from app.services.context.message_parts import build_user_content
from app.services.context.paths import resolve_attachment_path
from app.services.context.policy import ContextPolicy
from app.services.context.text_selection import (
    compaction_notice,
    estimate_history_message_text_tokens,
    select_history_positions,
)

logger = logging.getLogger(__name__)

_VALID_ROLES = frozenset({"user", "assistant", "system"})


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


def _estimate_image_tokens_for_history(
    history_raw: list[dict[str, Any]],
    chat_dir: Path,
    policy: ContextPolicy,
    eligible: set[int],
    notifications: list[str],
) -> int:
    total = 0
    for index in sorted(eligible):
        message = history_raw[index]
        attachments = _attachment_records(message)
        if not attachments:
            continue
        encoded, notes = _encode_attachments_for_message(chat_dir, attachments, policy)
        notifications.extend(notes)
        total += sum(item.estimated_tokens for item in encoded)
    return total


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


def _valid_history_entries(
    history_raw: list[dict[str, Any]],
) -> list[tuple[int, dict[str, Any]]]:
    return [
        (index, message)
        for index, message in enumerate(history_raw)
        if message.get("role") in _VALID_ROLES
    ]


def assemble_history_messages(
    history_raw: list[dict[str, Any]],
    chat_dir: Path,
    policy: ContextPolicy,
    *,
    reserved_overhead_tokens: int = 0,
) -> AssemblyResult:
    notifications: list[str] = []
    entries = _valid_history_entries(history_raw)
    if not entries:
        return AssemblyResult(messages=[], notifications=notifications)

    eligible = _eligible_image_user_indices(
        history_raw,
        policy.images.max_turns_in_context,
    )

    selected_indices: set[int]
    if policy.text.compaction_enabled:
        image_tokens_used = _estimate_image_tokens_for_history(
            history_raw,
            chat_dir,
            policy,
            eligible,
            notifications,
        )
        text_budget = compute_text_budget(
            max_total_tokens=policy.budget.max_total_tokens,
            reserve_for_reply_tokens=policy.budget.reserve_for_reply_tokens,
            reserved_overhead_tokens=reserved_overhead_tokens,
            image_tokens_used=image_tokens_used,
            max_history_tokens=policy.text.max_history_tokens,
        )
        token_costs = [
            estimate_history_message_text_tokens(message)
            for _, message in entries
        ]
        selection = select_history_positions(token_costs, text_budget)
        selected_indices = {
            entries[position][0] for position in selection.selected_positions
        }
        notice = compaction_notice(selection.omitted_count)
        if notice:
            notifications.append(notice)
            logger.info(
                "context compaction omitted=%s text_budget=%s image_tokens=%s reserved_overhead=%s",
                selection.omitted_count,
                text_budget,
                image_tokens_used,
                reserved_overhead_tokens,
            )
    else:
        selected_indices = {index for index, _ in entries}

    messages: list[dict[str, Any]] = []
    for index, message in entries:
        if index not in selected_indices:
            continue

        role = message.get("role")
        content = _history_content(
            message,
            chat_dir=chat_dir,
            policy=policy,
            include_images=index in eligible,
            notifications=notifications,
        )
        messages.append({"role": role, "content": content})

    return AssemblyResult(messages=messages, notifications=notifications)
