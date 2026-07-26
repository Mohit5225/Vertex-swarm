"""Artifact paths, validation, and assembly helpers."""
from __future__ import annotations

import logging
import shutil
from pathlib import Path
from typing import Any

from .constants import ARTIFACT_ROOT, INDEX_REL, MANIFEST_REL, REQUIREMENTS_REL
from .manifest import parse_manifest_json

logger = logging.getLogger(__name__)

_MIN_REQUIREMENTS_CHARS = 200
_REQUIRED_REQUIREMENTS_MARKERS = (
    "# ",
    "## ",
)


def _artifact_marker_index(path: str) -> int:
    lowered = path.replace("\\", "/").lower()
    return lowered.find(f"{ARTIFACT_ROOT.lower()}/")


def normalize_rel_path(relative: str | None, default: str) -> str:
    raw = (relative or default).replace("\\", "/").strip()
    marker = _artifact_marker_index(raw)
    if marker > 0:
        # workspace_ops writes under the repo; deep_plan_tool reads chat storage.
        # Accept absolute paths like c:/proj/plan_pipeline/01_requirements.md.
        raw = raw[marker:]
    raw = raw.lstrip("/")
    if ".." in raw.split("/"):
        raise ValueError(f"invalid path: {relative!r}")
    if not raw.startswith(f"{ARTIFACT_ROOT}/"):
        raise ValueError(
            f"artifact path must be under {ARTIFACT_ROOT}/ (got {relative!r})"
        )
    return raw


def resolve_artifact_path(chat_dir: Path, relative: str) -> Path:
    rel = normalize_rel_path(relative, relative)
    target = chat_dir / rel
    chat_resolved = chat_dir.resolve()
    target_resolved = target.resolve()
    if target_resolved != chat_resolved and chat_resolved not in target_resolved.parents:
        raise ValueError(f"artifact path escapes chat dir: {relative!r}")
    return target


def sync_plan_pipeline_from_workspace(
    workspace_roots: list[str],
    chat_dir: Path,
) -> list[str]:
    """Copy plan_pipeline/ from open workspace folders into chat storage.

    workspace_ops writes artifacts under the VS Code workspace root; deep_plan_tool
    validates under ~/.vertex-swarm/chats/<chat_id>/plan_pipeline/.
    """
    copied: list[str] = []
    dest_root = chat_dir / ARTIFACT_ROOT
    for root_str in workspace_roots:
        src_root = Path(root_str) / ARTIFACT_ROOT
        if not src_root.is_dir():
            continue
        for src_path in sorted(src_root.rglob("*")):
            if not src_path.is_file():
                continue
            rel = src_path.relative_to(src_root)
            dest = dest_root / rel
            dest.parent.mkdir(parents=True, exist_ok=True)
            if not dest.exists() or src_path.stat().st_mtime > dest.stat().st_mtime:
                shutil.copy2(src_path, dest)
                copied.append(str((Path(ARTIFACT_ROOT) / rel).as_posix()))
    if copied:
        logger.info(
            "Synced plan_pipeline from workspace to chat dir chat_id=%s files=%s",
            chat_dir.name,
            copied,
        )
    return copied


def workspace_roots_from_context(context: dict[str, Any] | None) -> list[str]:
    if not isinstance(context, dict):
        return []
    req_ctx = context.get("request_context")
    if not isinstance(req_ctx, dict):
        return []
    folders = req_ctx.get("workspaceFolders")
    if not isinstance(folders, list):
        return []
    return [folder for folder in folders if isinstance(folder, str) and folder.strip()]


async def read_text_file(path: Path) -> str | None:
    if not path.is_file():
        return None
    try:
        return path.read_text(encoding="utf-8")
    except OSError:
        return None


def validate_requirements_content(content: str) -> tuple[bool, list[str]]:
    errors: list[str] = []
    text = content.strip()
    if len(text) < _MIN_REQUIREMENTS_CHARS:
        errors.append(
            f"01_requirements.md too short ({len(text)} chars); "
            f"expected substantive requirements (min {_MIN_REQUIREMENTS_CHARS})"
        )
    if not any(marker in content for marker in _REQUIRED_REQUIREMENTS_MARKERS):
        errors.append("01_requirements.md must use markdown headings (# / ##)")
    lower = content.lower()
    if "integration" not in lower and "cross-surface" not in lower:
        errors.append(
            "01_requirements.md should include an Integration / cross-surface section"
        )
    return len(errors) == 0, errors


async def validate_handoff(
    chat_dir: Path,
    *,
    requirements_path: str,
    manifest_path: str,
    workspace_roots: list[str] | None = None,
) -> tuple[dict[str, Any] | None, dict[str, Any] | None, list[str]]:
    """Return (requirements_meta, manifest_dict, errors)."""
    if workspace_roots:
        sync_plan_pipeline_from_workspace(workspace_roots, chat_dir)

    errors: list[str] = []
    try:
        req_path = resolve_artifact_path(chat_dir, requirements_path)
        man_path = resolve_artifact_path(chat_dir, manifest_path)
    except ValueError as exc:
        return None, None, [str(exc)]

    req_content = await read_text_file(req_path)
    if req_content is None:
        errors.append(f"requirements file missing: {requirements_path}")
        req_meta = None
    else:
        ok, req_errors = validate_requirements_content(req_content)
        if not ok:
            errors.extend(req_errors)
        req_meta = {
            "path": requirements_path,
            "absolute": str(req_path),
            "content": req_content,
        }

    man_content = await read_text_file(man_path)
    if man_content is None:
        errors.append(f"manifest file missing: {manifest_path}")
        manifest = None
    else:
        manifest, man_errors = parse_manifest_json(man_content)
        if man_errors:
            errors.extend(man_errors)

    return req_meta, manifest, errors


def build_index_markdown(
    *,
    pipeline_id: str,
    title: str,
    manifest: dict[str, Any],
    requirements_path: str,
    artifact_files: list[str],
    pipeline_record: dict[str, Any] | None = None,
) -> str:
    rationale = manifest.get("rationale", "")
    requested = manifest.get("requested_stages") or []
    skipped = manifest.get("skipped_stages") or {}
    completed_stage_ids = set()
    skipped_worker_stages: list[dict[str, Any]] = []
    pipeline_status = ""
    if isinstance(pipeline_record, dict):
        completed_stage_ids = set(pipeline_record.get("completed_stages") or [])
        raw_skipped = pipeline_record.get("skipped_stages") or []
        if isinstance(raw_skipped, list):
            skipped_worker_stages = [s for s in raw_skipped if isinstance(s, dict)]
        pipeline_status = str(pipeline_record.get("status") or "")

    lines = [
        f"# Deep plan — {title}",
        "",
        f"- **pipeline_id:** `{pipeline_id}`",
        f"- **manifest pipeline_id:** `{manifest.get('pipeline_id', '')}`",
        "",
        "## How to read this plan",
        "",
        "- `[confirmed]` — user or HIL",
        "- `[best_guess]` — verify before relying",
        "- `[default]` — standard practice",
        "",
        "## Rationale",
        "",
        rationale,
        "",
        "## Requirements",
        "",
        f"Start at [`{requirements_path}`]({requirements_path}).",
        "",
        "## Artifact index",
        "",
        "| File | Status |",
        "|------|--------|",
    ]
    worker_output_by_stage = {
        "system_plan": "plan_pipeline/02_system_plan.md",
    }
    completed_paths = set()
    for stage_id in completed_stage_ids:
        rel = worker_output_by_stage.get(stage_id)
        if rel:
            completed_paths.add(rel)

    for rel in sorted(artifact_files):
        if rel in completed_paths or rel.endswith(".md") or rel.endswith(".json"):
            status = "ready"
        else:
            status = "—"
        lines.append(f"| `{rel}` | {status} |")

    if skipped_worker_stages:
        lines.extend(["", "## Worker stages skipped at runtime", ""])
        for entry in skipped_worker_stages:
            stage_id = entry.get("stage_id", "?")
            reason = entry.get("reason", "")
            lines.append(f"- **{stage_id}:** {reason}")

    lines.extend(
        [
            "",
            "## Requested stages",
            "",
            ", ".join(f"`{s}`" for s in requested),
            "",
            "## Skipped stages (manifest)",
            "",
        ]
    )
    if isinstance(skipped, dict) and skipped:
        for stage_id, reason in skipped.items():
            lines.append(f"- **{stage_id}:** {reason}")
    else:
        lines.append("_None._")

    lines.extend(
        [
            "",
            "## Pipeline status",
            "",
            f"Session status: `{pipeline_status or 'running'}`."
            + (
                f" Completed workers: {', '.join(f'`{s}`' for s in sorted(completed_stage_ids))}."
                if completed_stage_ids
                else " No worker stages completed yet."
            ),
            "",
            "## After approval",
            "",
            "Vertex loads `todo_tool` + `workspace_ops` and executes from this index and linked artifacts.",
            "",
        ]
    )
    return "\n".join(lines)


def list_plan_pipeline_files(chat_dir: Path) -> list[str]:
    root = chat_dir / "plan_pipeline"
    if not root.is_dir():
        return []
    out: list[str] = []
    for path in sorted(root.rglob("*")):
        if path.is_file():
            out.append(str(path.relative_to(chat_dir)).replace("\\", "/"))
    return out
