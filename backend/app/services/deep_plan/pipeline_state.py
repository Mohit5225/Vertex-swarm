"""Mutable deep-plan pipeline record stored in session working memory."""
from __future__ import annotations

import logging
from typing import Any, TYPE_CHECKING

if TYPE_CHECKING:
    from app.orchestrator import LLMOrchestrator

from .gates import DEEP_PLAN_PIPELINE_KEY, persist_session_state, read_session_state

logger = logging.getLogger(__name__)

STATUS_RUNNING = "running"
STATUS_AWAITING_APPROVAL = "awaiting_approval"
STATUS_FAILED = "failed"
STATUS_APPROVED = "approved"
STATUS_REJECTED = "rejected"
STATUS_ABORTED = "aborted"

TERMINAL_STATUSES = frozenset(
    {STATUS_FAILED, STATUS_APPROVED, STATUS_REJECTED, STATUS_ABORTED}
)


def build_initial_pipeline_record(
    *,
    pipeline_id: str,
    pending_stages: list[str],
    trigger: str,
    manifest_path: str,
    requirements_path: str,
    started_at: str,
) -> dict[str, Any]:
    return {
        "pipeline_id": pipeline_id,
        "status": STATUS_RUNNING,
        "current_stage": None,
        "started_at": started_at,
        "artifact_root": "plan_pipeline/",
        "trigger": trigger,
        "manifest_path": manifest_path,
        "requirements_path": requirements_path,
        "pending_stages": list(pending_stages),
        "completed_stages": [],
        "skipped_stages": [],
        "failed_stage": None,
    }


def read_pipeline_record(working_memory: dict[str, Any] | None) -> dict[str, Any] | None:
    wm = working_memory or {}
    pipeline = wm.get(DEEP_PLAN_PIPELINE_KEY)
    return pipeline if isinstance(pipeline, dict) else None


def pipeline_snapshot_for_ui(pipeline: dict[str, Any] | None) -> dict[str, Any] | None:
    """Shape sent to the webview on chat open for deep-plan UI hydration."""
    if not isinstance(pipeline, dict):
        return None
    status = str(pipeline.get("status") or "")
    if status in TERMINAL_STATUSES and status not in (STATUS_AWAITING_APPROVAL,):
        # Cleared after terminal states in normal flow; keep if still present.
        pass

    trigger = str(pipeline.get("trigger") or "user_slash_command")
    ui_trigger = "vertex_hil" if trigger == "hil_confirmed_arch_shift" else "user_slash"

    phase = "off"
    stage_label = ""
    status_value = str(pipeline.get("status") or "")
    current_stage = pipeline.get("current_stage")

    if status_value == STATUS_AWAITING_APPROVAL:
        phase = "awaiting_approval"
        stage_label = "Awaiting approval"
    elif status_value == STATUS_RUNNING:
        phase = "pipeline_running"
        if isinstance(current_stage, str) and current_stage:
            stage_label = current_stage.replace("_", " ").title()
        else:
            stage_label = "Pipeline running"
    elif status_value in TERMINAL_STATUSES:
        return None

    if status_value not in (STATUS_RUNNING, STATUS_AWAITING_APPROVAL):
        return None

    return {
        "active": True,
        "trigger": ui_trigger,
        "phase": phase,
        "stage_label": stage_label,
        "pipeline_id": pipeline.get("pipeline_id"),
        "status": status_value,
        "current_stage": current_stage,
        "pending_stages": list(pipeline.get("pending_stages") or []),
        "completed_stages": list(pipeline.get("completed_stages") or []),
        "skipped_stages": list(pipeline.get("skipped_stages") or []),
        "failed_stage": pipeline.get("failed_stage"),
    }


async def _update_pipeline(
    orchestrator: LLMOrchestrator,
    chat_id: str,
    mutator: Any,
) -> dict[str, Any] | None:
    state = await read_session_state(orchestrator, chat_id)
    working_memory = state.setdefault("working_memory", {})
    pipeline = working_memory.get(DEEP_PLAN_PIPELINE_KEY)
    if not isinstance(pipeline, dict):
        return None
    mutator(pipeline)
    working_memory[DEEP_PLAN_PIPELINE_KEY] = pipeline
    await persist_session_state(orchestrator, chat_id, state)
    return pipeline


async def record_stage_running(
    orchestrator: LLMOrchestrator,
    chat_id: str,
    stage_id: str,
) -> None:
    def _mutate(pipeline: dict[str, Any]) -> None:
        pipeline["current_stage"] = stage_id
        if pipeline.get("status") == STATUS_RUNNING:
            pipeline["status"] = STATUS_RUNNING

    await _update_pipeline(orchestrator, chat_id, _mutate)


async def record_stage_completed(
    orchestrator: LLMOrchestrator,
    chat_id: str,
    stage_id: str,
) -> None:
    def _mutate(pipeline: dict[str, Any]) -> None:
        completed = pipeline.setdefault("completed_stages", [])
        if stage_id not in completed:
            completed.append(stage_id)
        pending = pipeline.get("pending_stages")
        if isinstance(pending, list) and stage_id in pending:
            pipeline["pending_stages"] = [s for s in pending if s != stage_id]
        pipeline["current_stage"] = stage_id

    await _update_pipeline(orchestrator, chat_id, _mutate)


async def record_stage_skipped(
    orchestrator: LLMOrchestrator,
    chat_id: str,
    stage_id: str,
    reason: str,
) -> None:
    def _mutate(pipeline: dict[str, Any]) -> None:
        skipped = pipeline.setdefault("skipped_stages", [])
        skipped.append({"stage_id": stage_id, "reason": reason})
        pending = pipeline.get("pending_stages")
        if isinstance(pending, list) and stage_id in pending:
            pipeline["pending_stages"] = [s for s in pending if s != stage_id]
        pipeline["current_stage"] = stage_id

    await _update_pipeline(orchestrator, chat_id, _mutate)


async def record_stage_failed(
    orchestrator: LLMOrchestrator,
    chat_id: str,
    stage_id: str,
    reason: str,
) -> None:
    def _mutate(pipeline: dict[str, Any]) -> None:
        pipeline["status"] = STATUS_FAILED
        pipeline["failed_stage"] = {"stage_id": stage_id, "reason": reason}
        pending = pipeline.get("pending_stages")
        if isinstance(pending, list) and stage_id in pending:
            pipeline["pending_stages"] = [s for s in pending if s != stage_id]
        pipeline["current_stage"] = stage_id

    await _update_pipeline(orchestrator, chat_id, _mutate)


async def set_pipeline_awaiting_approval(
    orchestrator: LLMOrchestrator,
    chat_id: str,
) -> None:
    def _mutate(pipeline: dict[str, Any]) -> None:
        pipeline["status"] = STATUS_AWAITING_APPROVAL
        pipeline["current_stage"] = "awaiting_approval"
        pipeline["pending_stages"] = []

    await _update_pipeline(orchestrator, chat_id, _mutate)


async def set_pipeline_terminal_status(
    orchestrator: LLMOrchestrator,
    chat_id: str,
    status: str,
    *,
    rejection_feedback: str | None = None,
) -> None:
    if status not in TERMINAL_STATUSES:
        raise ValueError(f"invalid terminal pipeline status: {status!r}")

    def _mutate(pipeline: dict[str, Any]) -> None:
        pipeline["status"] = status
        if rejection_feedback is not None:
            pipeline["rejection_feedback"] = rejection_feedback

    await _update_pipeline(orchestrator, chat_id, _mutate)
