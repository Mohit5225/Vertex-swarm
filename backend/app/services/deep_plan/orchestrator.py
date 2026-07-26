"""DeepPlanOrchestrator — pipeline harness after Vertex req handoff."""
from __future__ import annotations

import asyncio
import logging
from typing import Any, TYPE_CHECKING

import aiofiles

from .artifacts import normalize_rel_path, validate_handoff
from .constants import MANIFEST_REL, REQUIREMENTS_REL
from .gates import clear_deep_plan_pipeline, read_session_state, set_deep_plan_pipeline
from .harness import PipelineHarness, new_pipeline_id, utc_now_iso
from .manifest import planner_stages
from .pipeline_vertex import run_vertex_pipeline_turn
from .pipeline_state import (
    STATUS_ABORTED,
    STATUS_APPROVED,
    STATUS_FAILED,
    STATUS_REJECTED,
    build_initial_pipeline_record,
    read_pipeline_record,
    set_pipeline_awaiting_approval,
    set_pipeline_terminal_status,
)

if TYPE_CHECKING:
    from app.orchestrator import LLMOrchestrator

logger = logging.getLogger(__name__)


def _ui_trigger(trigger: str) -> str:
    return "vertex_hil" if trigger == "hil_confirmed_arch_shift" else "user_slash"


class DeepPlanOrchestrator:
    def __init__(
        self,
        parent: LLMOrchestrator,
        *,
        chat_id: str,
        message_id: str,
        session_id: str,
        emit_trace_and_push: Any,
        build_event: Any,
        workspace_roots: list[str] | None = None,
        parent_run_id: str | None = None,
    ) -> None:
        self._parent = parent
        self._chat_id = chat_id
        self._message_id = message_id
        self._session_id = session_id
        self._emit = emit_trace_and_push
        self._build_event = build_event
        self._workspace_roots = workspace_roots or []
        self._parent_run_id = parent_run_id
        self._pipeline_run_id: str | None = None

    @property
    def chat_dir(self):
        return self._parent.file_store.chats_path / self._chat_id

    async def emit_stage(
        self,
        pipeline_id: str,
        stage_id: str,
        status: str,
        *,
        label: str | None = None,
        reason: str | None = None,
    ) -> None:
        metadata: dict[str, Any] = {
            "pipeline_id": pipeline_id,
            "stage_id": stage_id,
            "status": status,
        }
        if label:
            metadata["label"] = label
        if reason:
            metadata["reason"] = reason
        await self._emit(
            self._build_event(
                "deep_plan_stage_status",
                metadata=metadata,
                chat_id=self._chat_id,
                message_id=self._message_id,
            )
        )

    async def write_artifact(self, relative_path: str, content: str) -> None:
        target = self.chat_dir / relative_path.replace("\\", "/")
        target.parent.mkdir(parents=True, exist_ok=True)
        async with aiofiles.open(target, mode="w", encoding="utf-8") as handle:
            await handle.write(content)

    async def emit_artifact_saved(
        self,
        *,
        pipeline_id: str,
        stage_id: str,
        path: str,
        content_preview: str | None = None,
    ) -> None:
        metadata: dict[str, Any] = {
            "pipeline_id": pipeline_id,
            "stage_id": stage_id,
            "path": path,
        }
        if content_preview is not None:
            metadata["content_preview"] = content_preview[:2000]
        await self._emit(
            self._build_event(
                "deep_plan_artifact_saved",
                metadata=metadata,
                chat_id=self._chat_id,
                message_id=self._message_id,
            )
        )

    async def emit_worker_trace(
        self,
        stage_id: str,
        event: dict[str, Any],
        *,
        spawn_tool_call_id: str | None = None,
    ) -> None:
        """Route ephemeral worker tool traces to the handoff message."""
        event_type = event.get("type")
        metadata = dict(event.get("metadata") or {})
        if event_type not in ("hil_question", "hil_resolved"):
            if event_type == "status" and metadata.get("phase") in {
                "calling_model",
                "resuming_after_tool",
                "preparing_context",
            }:
                metadata["phase"] = "subagent_progress"
                if not event.get("content"):
                    event = {**event, "content": "Generating…"}
            metadata["subagent_trace"] = True
            if spawn_tool_call_id:
                metadata["subagent_spawn_tool_call_id"] = spawn_tool_call_id
            metadata["subagent_task_type"] = f"deep_plan:{stage_id}"
        metadata["deep_plan_stage_id"] = stage_id
        metadata["deep_plan_worker"] = True
        tagged = {
            **event,
            "chat_id": self._chat_id,
            "message_id": self._message_id,
            "session_id": self._session_id,
            "metadata": metadata,
        }
        await self._emit(tagged)

    async def run(
        self,
        *,
        action: str,
        payload: dict[str, Any],
    ) -> tuple[str, str, dict[str, Any] | None]:
        if action == "revise":
            return (
                "error",
                "deep_plan revise is not implemented yet. Start a new /deep-plan after reject.",
                {"error_code": "not_implemented"},
            )

        if action != "start":
            return ("error", f"Unsupported deep_plan_tool action: {action!r}", {"error_code": "validation_error"})

        title = str(payload.get("title") or "Deep plan").strip()
        requirements_path = normalize_rel_path(
            payload.get("requirements_path"),
            REQUIREMENTS_REL,
        )
        manifest_path = normalize_rel_path(payload.get("manifest_path"), MANIFEST_REL)

        req_meta, manifest, errors = await validate_handoff(
            self.chat_dir,
            requirements_path=requirements_path,
            manifest_path=manifest_path,
            workspace_roots=self._workspace_roots,
        )
        if errors or manifest is None:
            return (
                "error",
                "Requirement handoff invalid. Finish req extraction before deep_plan_tool(start).\n"
                + "\n".join(f"- {e}" for e in errors),
                {"error_code": "handoff_invalid", "errors": errors},
            )

        manifest_pipeline_id = str(manifest.get("pipeline_id") or "").strip()
        pipeline_id = manifest_pipeline_id or new_pipeline_id(self._chat_id)
        trigger = str(payload.get("trigger") or "user_slash_command")

        await set_deep_plan_pipeline(
            self._parent,
            self._chat_id,
            build_initial_pipeline_record(
                pipeline_id=pipeline_id,
                pending_stages=planner_stages(manifest),
                trigger=trigger,
                manifest_path=manifest_path,
                requirements_path=requirements_path,
                started_at=utc_now_iso(),
            ),
        )

        await self._emit(
            self._build_event(
                "deep_plan_mode_active",
                metadata={
                    "trigger": _ui_trigger(trigger),
                    "phase": "pipeline_running",
                    "stage_label": "Pipeline running",
                    "pipeline_id": pipeline_id,
                },
                chat_id=self._chat_id,
                message_id=self._message_id,
            )
        )
        await self.emit_stage(
            pipeline_id,
            "requirement_extraction",
            "completed",
            label="Requirement extraction",
        )

        harness = PipelineHarness(self)
        try:
            planner_ok, planner_err = await run_vertex_pipeline_turn(
                self,
                pipeline_id=pipeline_id,
                manifest=manifest,
                manifest_path=manifest_path,
                requirements_path=requirements_path,
            )
        except asyncio.CancelledError:
            await clear_deep_plan_pipeline(self._parent, self._chat_id)
            raise
        if not planner_ok:
            session_state = await read_session_state(self._parent, self._chat_id)
            pipeline_record = read_pipeline_record(session_state.get("working_memory", {}))
            failed_stage = None
            failure_reason = planner_err
            if isinstance(pipeline_record, dict):
                if str(pipeline_record.get("status")) == STATUS_ABORTED:
                    await clear_deep_plan_pipeline(self._parent, self._chat_id)
                    return (
                        "error",
                        "Deep plan aborted by user.",
                        {"error_code": "pipeline_aborted", "pipeline_id": pipeline_id},
                    )
                failed = pipeline_record.get("failed_stage")
                if isinstance(failed, dict):
                    failed_stage = failed.get("stage_id")
                    failure_reason = failed.get("reason") or planner_err
            await set_pipeline_terminal_status(
                self._parent,
                self._chat_id,
                STATUS_FAILED,
            )
            return (
                "error",
                f"Deep plan pipeline failed: {failure_reason}",
                {
                    "error_code": "stage_failed",
                    "pipeline_id": pipeline_id,
                    "stage_id": failed_stage,
                    "reason": failure_reason,
                },
            )

        index_rel = await harness.run_assembly(
            pipeline_id=pipeline_id,
            title=title,
            manifest=manifest,
            requirements_path=requirements_path,
        )

        await self._emit(
            self._build_event(
                "deep_plan_ready",
                metadata={"pipeline_id": pipeline_id, "index_path": index_rel},
                chat_id=self._chat_id,
                message_id=self._message_id,
            )
        )
        await set_pipeline_awaiting_approval(self._parent, self._chat_id)
        await self._emit(
            self._build_event(
                "deep_plan_mode_active",
                metadata={
                    "trigger": _ui_trigger(trigger),
                    "phase": "awaiting_approval",
                    "stage_label": "Awaiting approval",
                    "pipeline_id": pipeline_id,
                },
                chat_id=self._chat_id,
                message_id=self._message_id,
            )
        )
        await self._emit(
            self._build_event(
                "deep_plan_permission_request",
                metadata={"pipeline_id": pipeline_id, "title": title},
                chat_id=self._chat_id,
                message_id=self._message_id,
            )
        )

        approval = await self._parent.wait_for_deep_plan_approval(pipeline_id)
        if approval is None:
            await set_pipeline_terminal_status(self._parent, self._chat_id, STATUS_ABORTED)
            await clear_deep_plan_pipeline(self._parent, self._chat_id)
            return (
                "error",
                "Timed out waiting for deep plan approval.",
                {"error_code": "pipeline_timeout", "pipeline_id": pipeline_id},
            )

        if approval.get("aborted"):
            await set_pipeline_terminal_status(self._parent, self._chat_id, STATUS_ABORTED)
            await clear_deep_plan_pipeline(self._parent, self._chat_id)
            return (
                "error",
                "Deep plan aborted by user.",
                {"error_code": "pipeline_aborted", "pipeline_id": pipeline_id},
            )

        if not approval.get("approved"):
            feedback = str(approval.get("rejection_feedback") or "")
            await set_pipeline_terminal_status(
                self._parent,
                self._chat_id,
                STATUS_REJECTED,
                rejection_feedback=feedback,
            )
            await clear_deep_plan_pipeline(self._parent, self._chat_id)
            return (
                "success",
                "Deep plan rejected by user.",
                {
                    "pipeline_id": pipeline_id,
                    "approved": False,
                    "rejection_feedback": feedback,
                },
            )

        artifact_paths = [requirements_path, manifest_path, index_rel]
        await set_pipeline_terminal_status(self._parent, self._chat_id, STATUS_APPROVED)
        await clear_deep_plan_pipeline(self._parent, self._chat_id)
        return (
            "success",
            "Deep plan approved. Execute from plan_pipeline/index.md.",
            {
                "pipeline_id": pipeline_id,
                "approved": True,
                "index_path": index_rel,
                "artifact_paths": artifact_paths,
            },
        )
