"""Vertex pipeline turn — orchestrates stages via run_planning_stage tool calls."""
from __future__ import annotations

import json
import logging
from pathlib import Path
from typing import Any, TYPE_CHECKING

from .gates import read_session_state
from .manifest import planner_stages
from .pipeline_state import read_pipeline_record

if TYPE_CHECKING:
    from .orchestrator import DeepPlanOrchestrator

logger = logging.getLogger(__name__)

_PROMPT_PATH = (
    Path(__file__).parent.parent.parent / "prompts" / "deep_plan" / "pipeline_orchestration.md"
)


def _load_pipeline_orchestration_prompt() -> str:
    if _PROMPT_PATH.is_file():
        return _PROMPT_PATH.read_text(encoding="utf-8").strip()
    return "You are Vertex. Call run_planning_stage for each planner stage in order."


def build_pipeline_vertex_message(
    *,
    pipeline_id: str,
    manifest: dict[str, Any],
    manifest_path: str,
    requirements_path: str,
    pipeline_record: dict[str, Any] | None,
) -> str:
    planner_ids = planner_stages(manifest)
    notebook = pipeline_record if isinstance(pipeline_record, dict) else {}
    return (
        f"# Run deep plan pipeline\n\n"
        f"**pipeline_id:** `{pipeline_id}`\n\n"
        f"**Stage list file:** `{manifest_path}`\n\n"
        f"**Requirements file:** `{requirements_path}`\n\n"
        f"**Planner stages (in order):** {', '.join(planner_ids)}\n\n"
        f"**Session notebook (pipeline state):**\n\n"
        f"```json\n{json.dumps(notebook, indent=2)}\n```\n\n"
        f"Call `run_planning_stage` for each planner stage above, in order, using pipeline_id "
        f"`{pipeline_id}`. When all are completed or skipped, reply: `PIPELINE_PLANNERS_DONE`."
    )


async def run_vertex_pipeline_turn(
    deep_o: DeepPlanOrchestrator,
    *,
    pipeline_id: str,
    manifest: dict[str, Any],
    manifest_path: str,
    requirements_path: str,
) -> tuple[bool, str | None]:
    """Run Vertex agent loop with run_planning_stage only. Returns (ok, error_message)."""
    from app.orchestrator import _run_agent_loop_impl

    session_state = await read_session_state(deep_o._parent, deep_o._chat_id)
    pipeline_record = read_pipeline_record(session_state.get("working_memory", {}))

    message = build_pipeline_vertex_message(
        pipeline_id=pipeline_id,
        manifest=manifest,
        manifest_path=manifest_path,
        requirements_path=requirements_path,
        pipeline_record=pipeline_record,
    )

    parent = deep_o._parent
    parent.active_pipeline_by_chat[deep_o._chat_id] = {
        "deep_o": deep_o,
        "manifest": manifest,
        "manifest_path": manifest_path,
        "requirements_path": requirements_path,
        "pipeline_id": pipeline_id,
        "agent_run_id": deep_o._pipeline_run_id,
    }

    try:
        await _run_agent_loop_impl(
            parent,
            deep_o._chat_id,
            message,
            {
                "user_id": "vertex",
                "synthetic_session_id": deep_o._session_id,
                "request_message_id": deep_o._message_id,
                "ide_context_enabled": False,
                "ephemeral_run": True,
                "deep_plan_pipeline_mode": True,
                "external_trace_emit": deep_o._emit,
                "pipeline_id": pipeline_id,
                "stage_system_preamble": _load_pipeline_orchestration_prompt(),
                "task_type": "deep_plan:pipeline_orchestration",
            },
        )
    finally:
        parent.active_pipeline_by_chat.pop(deep_o._chat_id, None)

    session_after = await read_session_state(deep_o._parent, deep_o._chat_id)
    pipeline_after = read_pipeline_record(session_after.get("working_memory", {}))
    if not isinstance(pipeline_after, dict):
        return False, "Pipeline state missing after Vertex orchestration turn."

    failed = pipeline_after.get("failed_stage")
    if isinstance(failed, dict) and failed.get("stage_id"):
        return False, str(failed.get("reason") or "stage failed")

    pending = pipeline_after.get("pending_stages") or []
    if isinstance(pending, list) and pending:
        return (
            False,
            f"Pipeline incomplete: pending stages remain: {', '.join(pending)}. "
            "Vertex must call run_planning_stage for each.",
        )

    return True, None
