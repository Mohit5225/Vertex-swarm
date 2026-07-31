"""Safe path resolution for chat attachment files."""

from __future__ import annotations

from pathlib import Path

ATTACHMENTS_DIR_NAME = "attachments"


def chat_directory(base_path: Path, chat_id: str) -> Path:
    return base_path / "chats" / chat_id


def attachments_root(chat_dir: Path) -> Path:
    return chat_dir / ATTACHMENTS_DIR_NAME


def resolve_attachment_path(chat_dir: Path, relative_path: str) -> Path:
    """Resolve a relative attachment path and ensure it stays under attachments/."""
    if not relative_path or not isinstance(relative_path, str):
        raise ValueError("Attachment path is required.")

    normalized = relative_path.replace("\\", "/").lstrip("/")
    if normalized.startswith("..") or "/../" in f"/{normalized}/":
        raise ValueError(f"Invalid attachment path: {relative_path}")

    rel = Path(normalized)
    if rel.is_absolute():
        raise ValueError(f"Attachment path must be relative: {relative_path}")

    root = attachments_root(chat_dir).resolve()
    candidate = (chat_dir / rel).resolve()

    try:
        candidate.relative_to(root)
    except ValueError as exc:
        raise ValueError(f"Attachment path escapes attachments root: {relative_path}") from exc

    return candidate
