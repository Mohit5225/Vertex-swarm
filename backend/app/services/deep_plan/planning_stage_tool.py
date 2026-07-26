"""run_planning_stage tool — Vertex spawns one pipeline worker via JSON tool call."""
from __future__ import annotations

import logging
from typing import Any, TYPE_CHECKING

from .gates import read_session_state
from .harness import STAGE_LABELS
from .manifest import planner_stages
from .pipeline_state import (
    STATUS_FAILED,
    TERMINAL_STATUSES,
    read_pipeline_record,
    record_stage_completed,
    record_stage_failed,
    record_stage_running,
    record_stage_skipped,
)
from .runner import read_prior_artifacts, run_stage
from .stage_registry import get_stage
from .stage_waves import can_run_stage, required_input_artifact_paths

if TYPE_CHECKING:
    from .orchestrator import DeepPlanOrchestrator

logger = logging.getLogger(__name__)


def _stage_already_skipped(pipeline: dict[str, Any], stage_id: str) -> bool:
    skipped = pipeline.get("skipped_stages") or []
    if not isinstance(skipped, list):
        return False
    return any(
        isinstance(entry, dict) and entry.get("stage_id") == stage_id for entry in skipped
    )


async def execute_run_planning_stage(
    deep_o: DeepPlanOrchestrator,
    *,
    stage_id: str,
    pipeline_id: str,
    manifest: dict[str, Any],
    requirements_path: str,
    spawn_tool_call_id: str | None = None,
) -> tuple[str, str, dict[str, Any] | None]:
    """Run one stage on Vertex's behalf. Returns (status, content, data)."""
    stage_id = str(stage_id or "").strip()
    pipeline_id = str(pipeline_id or "").strip()

    if not stage_id or not pipeline_id:
        return ("error", "stage_id and pipeline_id are required.", {"error_code": "validation_error"})

    if deep_o._parent.is_run_cancel_requested(deep_o._pipeline_run_id):
        return (
            "error",
            "Deep plan aborted by user.",
            {"error_code": "pipeline_aborted"},
        )

    session_state = await read_session_state(deep_o._parent, deep_o._chat_id)
    pipeline = read_pipeline_record(session_state.get("working_memory", {}))
    if not isinstance(pipeline, dict):
        return ("error", "No active deep plan pipeline in session.", {"error_code": "no_pipeline"})

    pipeline_status = str(pipeline.get("status") or "")
    if pipeline_status in TERMINAL_STATUSES:
        return (
            "error",
            f"Pipeline is no longer running (status={pipeline_status!r}).",
            {"error_code": "pipeline_not_running", "status": pipeline_status},
        )

    failed = pipeline.get("failed_stage")
    if isinstance(failed, dict) and failed.get("stage_id"):
        return (
            "error",
            f"Pipeline already failed at stage {failed.get('stage_id')!r}: "
            f"{failed.get('reason') or 'stage failed'}",
            {
                "error_code": "pipeline_failed",
                "stage_id": failed.get("stage_id"),
                "reason": failed.get("reason"),
            },
        )

    if pipeline_status == STATUS_FAILED:
        return (
            "error",
            "Pipeline has failed. Do not call further stages.",
            {"error_code": "pipeline_failed"},
        )

    session_pipeline_id = str(pipeline.get("pipeline_id") or "")
    if session_pipeline_id != pipeline_id:
        return (
            "error",
            f"pipeline_id mismatch: session has {session_pipeline_id!r}, got {pipeline_id!r}.",
            {"error_code": "pipeline_id_mismatch"},
        )

    completed = pipeline.get("completed_stages") or []
    if isinstance(completed, list) and stage_id in completed:
        return (
            "success",
            f"Stage {stage_id!r} already completed.",
            {"stage_id": stage_id, "status": "completed", "idempotent": True},
        )

    if _stage_already_skipped(pipeline, stage_id):
        return (
            "success",
            f"Stage {stage_id!r} already skipped.",
            {"stage_id": stage_id, "status": "skipped", "idempotent": True},
        )

    stage_def = get_stage(stage_id)
    if stage_def is None:
        reason = "legacy_or_unknown_stage"
        await record_stage_skipped(deep_o._parent, deep_o._chat_id, stage_id, reason)
        await deep_o.emit_stage(pipeline_id, stage_id, "skipped", reason=reason)
        return (
            "success",
            f"Stage {stage_id!r} skipped: not a current worker stage (legacy id on stage list).",
            {"stage_id": stage_id, "status": "skipped", "reason": reason},
        )

    allowed = set(planner_stages(manifest))
    if stage_id not in allowed:
        return (
            "error",
            f"stage_id {stage_id!r} is not a planner stage in the stage list JSON.",
            {"error_code": "invalid_stage"},
        )

    pending = pipeline.get("pending_stages") or []
    if isinstance(pending, list) and stage_id in pending:
        if pipeline.get("current_stage") == stage_id:
            return (
                "error",
                f"Stage {stage_id!r} is already running.",
                {"error_code": "stage_already_running", "stage_id": stage_id},
            )
    elif isinstance(pending, list) and not pending:
        return (
            "error",
            f"No pending planner stages; {stage_id!r} was already handled.",
            {"error_code": "stage_not_pending", "stage_id": stage_id},
        )
    else:
        return (
            "error",
            f"Stage {stage_id!r} is not pending for this pipeline.",
            {"error_code": "stage_not_pending", "stage_id": stage_id},
        )

    runnable, run_err = await can_run_stage(
        stage_id=stage_id,
        manifest=manifest,
        pipeline=pipeline,
        chat_dir=deep_o.chat_dir,
    )
    if not runnable:
        return (
            "error",
            run_err or f"Stage {stage_id!r} cannot run yet.",
            {"error_code": "stage_not_ready"},
        )

    label = STAGE_LABELS.get(stage_id, stage_id)
    await record_stage_running(deep_o._parent, deep_o._chat_id, stage_id)
    await deep_o.emit_stage(pipeline_id, stage_id, "running", label=label)

    if deep_o._parent.is_run_cancel_requested(deep_o._pipeline_run_id):
        return (
            "error",
            "Deep plan aborted by user.",
            {"error_code": "pipeline_aborted"},
        )

    prior_artifacts: dict[str, str] = {}
    artifact_paths = required_input_artifact_paths(manifest, stage_id)
    if artifact_paths:
        prior_artifacts = await read_prior_artifacts(
            deep_o.chat_dir,
            paths=artifact_paths,
        )

    result = await run_stage(
        deep_o,
        pipeline_id=pipeline_id,
        stage_id=stage_id,
        manifest=manifest,
        requirements_path=requirements_path,
        prior_artifacts=prior_artifacts,
        spawn_tool_call_id=spawn_tool_call_id,
    )

    if deep_o._parent.is_run_cancel_requested(deep_o._pipeline_run_id):
        return (
            "error",
            "Deep plan aborted by user.",
            {"error_code": "pipeline_aborted"},
        )

    if not result.ok or not result.output_rel:
        reason = result.error or "stage_run_failed"
        await record_stage_failed(deep_o._parent, deep_o._chat_id, stage_id, reason)
        await deep_o.emit_stage(pipeline_id, stage_id, "failed", label=label, reason=reason)
        return (
            "error",
            f"Stage {stage_id!r} failed: {reason}",
            {"error_code": "stage_failed", "stage_id": stage_id, "reason": reason},
        )

    preview = (result.content or "")[:2000] if result.content else None
    await deep_o.emit_artifact_saved(
        pipeline_id=pipeline_id,
        stage_id=stage_id,
        path=result.output_rel,
        content_preview=preview,
    )
    await record_stage_completed(deep_o._parent, deep_o._chat_id, stage_id)
    await deep_o.emit_stage(pipeline_id, stage_id, "completed", label=label)

    return (
        "success",
        f"Stage {stage_id!r} completed. Artifact: {result.output_rel}",
        {
            "stage_id": stage_id,
            "status": "completed",
            "path": result.output_rel,
        },
    )
