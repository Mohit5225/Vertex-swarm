"""Per-LLM-round image inclusion policy."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from app.services.context.message_parts import strip_image_parts
from app.services.context.policy import ContextPolicy


@dataclass
class RoundPrepResult:
    messages: list[dict[str, Any]]
    notification: str | None = None


def prepare_messages_for_llm_round(
    messages: list[dict[str, Any]],
    llm_round: int,
    policy: ContextPolicy,
    *,
    round_strip_notified: bool,
) -> RoundPrepResult:
    max_rounds = policy.images.max_llm_rounds_with_images
    if llm_round <= max_rounds:
        return RoundPrepResult(messages=messages)

    changed, stripped = strip_image_parts(messages)
    if not changed:
        return RoundPrepResult(messages=messages)

    notification = None
    if not round_strip_notified:
        notification = (
            f"Images removed from model context after LLM round {max_rounds} "
            "to limit vision token cost."
        )

    return RoundPrepResult(messages=stripped, notification=notification)
