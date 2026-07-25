"""Planner / checker / end-layer waves and runnable-stage rules."""
from __future__ import annotations

from pathlib import Path
from typing import Any

from .artifacts import list_plan_pipeline_files, resolve_artifact_path, read_text_file
from .constants import REQUIREMENTS_REL
from .manifest import planner_stages
from .stage_registry import (
    CODE_AUDIT_REL,
    END_LAYER_STAGE_ID,
    PERF_PLAN_REL,
    SDK_AUDIT_REL,
    SECURITY_AUDIT_REL,
    SYSTEM_PLAN_REL,
    get_stage,
    is_checker_stage,
    is_planner_stage,
)

WAVE_PLANNERS = "planners"
WAVE_CHECKERS = "checkers"
WAVE_END = "end_layer"

# Artifact path → stage id that produces it (requirements always required separately)
_ARTIFACT_PRODUCER: dict[str, str] = {
    SYSTEM_PLAN_REL: "system_plan",
    SDK_AUDIT_REL: "sdk_practices_audit",
    CODE_AUDIT_REL: "code_practices_audit",
    PERF_PLAN_REL: "performance_planning",
    SECURITY_AUDIT_REL: "security_audit",
}


def stage_wave(stage_id: str) -> str | None:
    if stage_id == END_LAYER_STAGE_ID:
        return WAVE_END
    if is_planner_stage(stage_id):
        return WAVE_PLANNERS
    if is_checker_stage(stage_id):
        return WAVE_CHECKERS
    return None


def _artifact_required_for_manifest(manifest: dict[str, Any], rel: str) -> bool:
    if rel == REQUIREMENTS_REL:
        return True
    producer = _ARTIFACT_PRODUCER.get(rel)
    if producer is None:
        return False
    return producer in planner_stages(manifest)


def _completed_set(pipeline: dict[str, Any]) -> set[str]:
    completed = pipeline.get("completed_stages") or []
    if not isinstance(completed, list):
        return set()
    return {str(s) for s in completed}


def _skipped_ids(pipeline: dict[str, Any]) -> set[str]:
    skipped = pipeline.get("skipped_stages") or []
    if not isinstance(skipped, list):
        return set()
    out: set[str] = set()
    for entry in skipped:
        if isinstance(entry, dict) and entry.get("stage_id"):
            out.add(str(entry["stage_id"]))
    return out


async def _input_artifacts_ready(
    chat_dir: Path,
    stage_id: str,
    manifest: dict[str, Any],
    *,
    extra_paths: list[str] | None = None,
) -> tuple[bool, str | None]:
    stage = get_stage(stage_id)
    if stage is None:
        return False, f"unknown stage: {stage_id!r}"

    paths = list(stage.input_artifacts)
    if extra_paths:
        paths.extend(extra_paths)

    if stage.writes_in_place:
        on_disk = list_plan_pipeline_files(chat_dir)
        plan_md = [
            p
            for p in on_disk
            if p.endswith(".md")
            and p not in ("plan_pipeline/index.md", "plan_pipeline/08_correction_summary.md")
        ]
        if not plan_md:
            return False, "no planner/checker markdown exists for end-layer correction"
        return True, None

    for rel in paths:
        if not _artifact_required_for_manifest(manifest, rel):
            continue
        path = resolve_artifact_path(chat_dir, rel)
        text = await read_text_file(path)
        if text is None:
            return False, f"missing required input artifact: {rel}"

    return True, None


def _wave_complete(
    manifest: dict[str, Any],
    pipeline: dict[str, Any],
    wave: str,
) -> bool:
    completed = _completed_set(pipeline)
    skipped = _skipped_ids(pipeline)
    done = completed | skipped
    for stage_id in planner_stages(manifest):
        w = stage_wave(stage_id)
        if w != wave:
            continue
        if stage_id not in done:
            return False
    return True


async def can_run_stage(
    *,
    stage_id: str,
    manifest: dict[str, Any],
    pipeline: dict[str, Any],
    chat_dir: Path,
) -> tuple[bool, str | None]:
    """Return (ok, error_message)."""
    allowed = set(planner_stages(manifest))
    if stage_id not in allowed:
        return False, f"{stage_id!r} is not on the stage list for this pipeline."

    wave = stage_wave(stage_id)
    if wave is None:
        return False, f"{stage_id!r} is not a runnable planner/checker/end stage."

    if wave == WAVE_CHECKERS and not _wave_complete(manifest, pipeline, WAVE_PLANNERS):
        return False, "Checker jobs cannot run until all planner jobs are done or skipped."

    if wave == WAVE_END and not _wave_complete(manifest, pipeline, WAVE_CHECKERS):
        return False, "End-layer correction cannot run until all checker jobs are done or skipped."

    ready, err = await _input_artifacts_ready(chat_dir, stage_id, manifest)
    if not ready:
        return False, err

    return True, None


def required_input_artifact_paths(manifest: dict[str, Any], stage_id: str) -> list[str]:
    """Input artifact paths that must exist for this stage on the given stage list."""
    stage = get_stage(stage_id)
    if stage is None:
        return []
    return [rel for rel in stage.input_artifacts if _artifact_required_for_manifest(manifest, rel)]
