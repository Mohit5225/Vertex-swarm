"""Select which history messages fit in the text token budget."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from app.services.context.budget import estimate_text_tokens


@dataclass(frozen=True)
class TextSelectionResult:
    """Positions into the filtered valid-history list that should be sent."""

    selected_positions: frozenset[int]
    omitted_count: int


def estimate_history_message_text_tokens(message: dict[str, Any]) -> int:
    role = message.get("role")
    content = message.get("content")
    if isinstance(content, str) and content.strip():
        return estimate_text_tokens(content)
    if role == "assistant":
        return estimate_text_tokens("[Executed workspace tools]")
    return estimate_text_tokens("[Empty message]")


def select_history_positions(
    token_costs: list[int],
    text_budget: int,
) -> TextSelectionResult:
    """Walk newest → oldest; always keep the latest message."""
    count = len(token_costs)
    if count == 0:
        return TextSelectionResult(frozenset(), 0)

    selected: set[int] = set()
    used = 0
    for position in range(count - 1, -1, -1):
        cost = token_costs[position]
        if position == count - 1:
            selected.add(position)
            used += cost
            continue
        if used + cost > text_budget:
            break
        selected.add(position)
        used += cost

    omitted = count - len(selected)
    return TextSelectionResult(frozenset(selected), omitted)


def compaction_notice(omitted_count: int) -> str:
    if omitted_count <= 0:
        return ""
    noun = "message" if omitted_count == 1 else "messages"
    return (
        f"Context compacted: {omitted_count} older {noun} "
        "were omitted from this request."
    )
