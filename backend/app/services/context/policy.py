"""Context policy — defaults and load from ~/.vertex-swarm/context-policy.json."""

from __future__ import annotations

import json
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any

CONTEXT_POLICY_VERSION = 1
CONTEXT_POLICY_FILENAME = "context-policy.json"


def _clamp(value: float, minimum: float, maximum: float) -> float:
    return max(minimum, min(maximum, value))


@dataclass
class BudgetPolicy:
    max_total_tokens: int = 100_000
    reserve_for_reply_tokens: int = 8_000


@dataclass
class TextPolicy:
    compaction_enabled: bool = True
    max_history_tokens: int | None = None


@dataclass
class ImagesPolicy:
    save_max_bytes: int = 10 * 1024 * 1024
    save_max_count: int = 8
    send_max_long_edge_px: int = 1568
    send_max_bytes_per_image: int = 4 * 1024 * 1024
    send_max_count: int = 8
    max_turns_in_context: int = 1
    max_llm_rounds_with_images: int = 10
    target_tokens_per_image: int = 1100
    max_tokens_for_images_total: int = 8_000


@dataclass
class FilesPolicy:
    enabled: bool = False


@dataclass
class ContextPolicy:
    version: int = CONTEXT_POLICY_VERSION
    budget: BudgetPolicy = field(default_factory=BudgetPolicy)
    text: TextPolicy = field(default_factory=TextPolicy)
    images: ImagesPolicy = field(default_factory=ImagesPolicy)
    files: FilesPolicy = field(default_factory=FilesPolicy)


DEFAULT_CONTEXT_POLICY = ContextPolicy()


def _read_int(
    source: dict[str, Any],
    key: str,
    *,
    minimum: int,
    maximum: int,
    default: int,
) -> int:
    raw = source.get(key, default)
    if not isinstance(raw, (int, float)):
        return default
    return int(_clamp(float(raw), minimum, maximum))


def normalize_context_policy(data: Any) -> ContextPolicy:
    base = DEFAULT_CONTEXT_POLICY
    if not isinstance(data, dict):
        return ContextPolicy(
            version=base.version,
            budget=BudgetPolicy(**asdict(base.budget)),
            text=TextPolicy(**asdict(base.text)),
            images=ImagesPolicy(**asdict(base.images)),
            files=FilesPolicy(**asdict(base.files)),
        )

    budget_raw = data.get("budget") if isinstance(data.get("budget"), dict) else {}
    text_raw = data.get("text") if isinstance(data.get("text"), dict) else {}
    images_raw = data.get("images") if isinstance(data.get("images"), dict) else {}
    files_raw = data.get("files") if isinstance(data.get("files"), dict) else {}

    max_history = text_raw.get("max_history_tokens", base.text.max_history_tokens)
    if max_history is not None and not isinstance(max_history, (int, float)):
        max_history = base.text.max_history_tokens
    elif isinstance(max_history, (int, float)):
        max_history = int(_clamp(float(max_history), 1_000, 200_000))

    compaction_enabled = text_raw.get("compaction_enabled", base.text.compaction_enabled)
    if not isinstance(compaction_enabled, bool):
        compaction_enabled = base.text.compaction_enabled

    files_enabled = files_raw.get("enabled", base.files.enabled)
    if not isinstance(files_enabled, bool):
        files_enabled = base.files.enabled

    return ContextPolicy(
        version=CONTEXT_POLICY_VERSION,
        budget=BudgetPolicy(
            max_total_tokens=_read_int(
                budget_raw,
                "max_total_tokens",
                minimum=8_000,
                maximum=200_000,
                default=base.budget.max_total_tokens,
            ),
            reserve_for_reply_tokens=_read_int(
                budget_raw,
                "reserve_for_reply_tokens",
                minimum=1_000,
                maximum=32_000,
                default=base.budget.reserve_for_reply_tokens,
            ),
        ),
        text=TextPolicy(
            compaction_enabled=compaction_enabled,
            max_history_tokens=max_history,
        ),
        images=ImagesPolicy(
            save_max_bytes=_read_int(
                images_raw,
                "save_max_bytes",
                minimum=1 * 1024 * 1024,
                maximum=20 * 1024 * 1024,
                default=base.images.save_max_bytes,
            ),
            save_max_count=_read_int(
                images_raw,
                "save_max_count",
                minimum=1,
                maximum=16,
                default=base.images.save_max_count,
            ),
            send_max_long_edge_px=_read_int(
                images_raw,
                "send_max_long_edge_px",
                minimum=512,
                maximum=2048,
                default=base.images.send_max_long_edge_px,
            ),
            send_max_bytes_per_image=_read_int(
                images_raw,
                "send_max_bytes_per_image",
                minimum=256 * 1024,
                maximum=10 * 1024 * 1024,
                default=base.images.send_max_bytes_per_image,
            ),
            send_max_count=_read_int(
                images_raw,
                "send_max_count",
                minimum=1,
                maximum=16,
                default=base.images.send_max_count,
            ),
            max_turns_in_context=_read_int(
                images_raw,
                "max_turns_in_context",
                minimum=1,
                maximum=10,
                default=base.images.max_turns_in_context,
            ),
            max_llm_rounds_with_images=_read_int(
                images_raw,
                "max_llm_rounds_with_images",
                minimum=1,
                maximum=50,
                default=base.images.max_llm_rounds_with_images,
            ),
            target_tokens_per_image=_read_int(
                images_raw,
                "target_tokens_per_image",
                minimum=200,
                maximum=4_000,
                default=base.images.target_tokens_per_image,
            ),
            max_tokens_for_images_total=_read_int(
                images_raw,
                "max_tokens_for_images_total",
                minimum=500,
                maximum=32_000,
                default=base.images.max_tokens_for_images_total,
            ),
        ),
        files=FilesPolicy(enabled=files_enabled),
    )


def load_context_policy(base_path: Path | None = None) -> ContextPolicy:
    root = base_path if base_path is not None else Path.home() / ".vertex-swarm"
    policy_path = root / CONTEXT_POLICY_FILENAME
    try:
        raw = json.loads(policy_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return normalize_context_policy(None)
    return normalize_context_policy(raw)
