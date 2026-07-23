"""DeepPlanOrchestrator — internal pipeline (Phase 1: stub)."""
from __future__ import annotations

import logging
from datetime import datetime, timezone
from typing import Any, TYPE_CHECKING
from uuid import uuid4

if TYPE_CHECKING:
    from app.orchestrator import LLMOrchestrator

logger = logging.getLogger(__name__)

_APPROVAL_TIMEOUT_SECONDS = 86_400


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
    ) -> None:
        self._parent = parent
        self._chat_id = chat_id
        self._message_id = message_id
        self._session_id = session_id
        self._emit = emit_trace_and_push
        self._build_event = build_event

    async def run(
        self,
        *,
        action: str,
        payload: dict[str, Any],
    ) -> tuple[str, str, dict[str, Any] | None]:
        if action == "revise":
            return (
                "error",
                "deep_plan revise is not implemented yet (Phase 2). Start a new pipeline with action='start'.",
                {"error_code": "not_implemented"},
            )

        if action != "start":
            return ("error", f"Unsupported deep_plan_tool action: {action!r}", {"error_code": "validation_error"})

        title = str(payload.get("title") or "Deep plan").strip()
        scope_summary = str(payload.get("scope_summary") or "").strip()
        pipeline_id = f"dplan_{self._chat_id}_{uuid4().hex[:12]}"

        await self._emit(
            self._build_event(
                "deep_plan_started",
                metadata={"pipeline_id": pipeline_id, "title": title},
                chat_id=self._chat_id,
                message_id=self._message_id,
            )
        )
        await self._emit(
            self._build_event(
                "deep_plan_stage_status",
                metadata={
                    "pipeline_id": pipeline_id,
                    "stage_id": "stub_pipeline",
                    "status": "running",
                    "label": "Stub pipeline (Phase 1)",
                },
                chat_id=self._chat_id,
                message_id=self._message_id,
            )
        )

        index_body = self._build_stub_index(pipeline_id, title, scope_summary, payload)
        index_rel = "plan_pipeline/index.md"
        await self._write_artifact(index_rel, index_body)

        await self._emit(
            self._build_event(
                "deep_plan_stage_status",
                metadata={
                    "pipeline_id": pipeline_id,
                    "stage_id": "stub_pipeline",
                    "status": "completed",
                },
                chat_id=self._chat_id,
                message_id=self._message_id,
            )
        )
        await self._emit(
            self._build_event(
                "deep_plan_ready",
                metadata={"pipeline_id": pipeline_id, "index_path": index_rel},
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
            return (
                "error",
                "Timed out waiting for deep plan approval.",
                {"error_code": "pipeline_timeout", "pipeline_id": pipeline_id},
            )

        if not approval.get("approved"):
            feedback = str(approval.get("rejection_feedback") or "")
            return (
                "success",
                "Deep plan rejected by user.",
                {
                    "pipeline_id": pipeline_id,
                    "approved": False,
                    "rejection_feedback": feedback,
                },
            )

        return (
            "success",
            "Deep plan approved by user. Pipeline complete (stub).",
            {
                "pipeline_id": pipeline_id,
                "approved": True,
                "index_path": index_rel,
                "artifact_paths": [index_rel],
            },
        )

    def _build_stub_index(
        self,
        pipeline_id: str,
        title: str,
        scope_summary: str,
        payload: dict[str, Any],
    ) -> str:
        constraints = payload.get("stated_constraints") or []
        constraint_lines = ""
        if isinstance(constraints, list) and constraints:
            constraint_lines = "\n".join(f"- {c}" for c in constraints if isinstance(c, str))

        now = datetime.now(timezone.utc).isoformat()
        return f"""# {title}

> **Phase 1 stub** — full stage agents not implemented yet.

- **pipeline_id:** `{pipeline_id}`
- **generated_at:** {now}

## Scope (from main agent)

{scope_summary or "_No scope_summary provided._"}

## Stated constraints

{constraint_lines or "_None._"}

## Next steps (after approval)

1. Main agent loads `todo_tool` + `workspace_ops`.
2. Derive execution steps from this index (stub content until Phase 2+ fills artifacts).

## Artifacts (planned)

| File | Status |
|------|--------|
| `01_requirements.md` | Phase 2 |
| `02_system_plan.md` | Phase 2 |
| `03_frontend_plan.md` | Phase 2 |
| `00_pipeline_manifest.json` | Phase 2 |
"""

    async def _write_artifact(self, relative_path: str, content: str) -> None:
        chat_dir = self._parent.file_store.chats_path / self._chat_id
        target = chat_dir / relative_path
        target.parent.mkdir(parents=True, exist_ok=True)
        import aiofiles

        async with aiofiles.open(target, mode="w", encoding="utf-8") as handle:
            await handle.write(content)
