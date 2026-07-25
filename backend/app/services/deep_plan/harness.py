"""Deep plan pipeline — assembly and shared stage labels."""
from __future__ import annotations

import logging
from datetime import datetime, timezone
from typing import Any, TYPE_CHECKING
from uuid import uuid4

from .artifacts import build_index_markdown, list_plan_pipeline_files
from .constants import INDEX_REL
from .gates import read_session_state
from .pipeline_state import read_pipeline_record, record_stage_running

if TYPE_CHECKING:
    from .orchestrator import DeepPlanOrchestrator

logger = logging.getLogger(__name__)

# Human labels for stream UI
STAGE_LABELS: dict[str, str] = {
    "system_plan": "System plan",
    "frontend_plan": "Frontend plan",
    "frontend_plan_a": "Frontend plan (variant A)",
    "frontend_plan_b": "Frontend plan (variant B)",
    "frontend_merge": "Frontend merge",
    "sdk_practices_audit": "SDK practices audit",
    "code_practices_audit": "Code practices audit",
    "performance_planning": "Performance planning",
    "security_audit": "Security audit",
    "correction": "Plan coherence pass",
    "assembly": "Assembly",
}


class PipelineHarness:
    """Post-planner assembly only — planner stages run via Vertex run_planning_stage tool calls."""

    def __init__(self, orchestrator: DeepPlanOrchestrator) -> None:
        self._o = orchestrator

    async def run_assembly(
        self,
        *,
        pipeline_id: str,
        title: str,
        manifest: dict[str, Any],
        requirements_path: str,
    ) -> str:
        await record_stage_running(self._o._parent, self._o._chat_id, "assembly")
        await self._o.emit_stage(pipeline_id, "assembly", "running", label=STAGE_LABELS["assembly"])
        chat_dir = self._o.chat_dir
        artifact_files = list_plan_pipeline_files(chat_dir)
        session_state = await read_session_state(self._o._parent, self._o._chat_id)
        pipeline_record = read_pipeline_record(session_state.get("working_memory", {}))
        body = build_index_markdown(
            pipeline_id=pipeline_id,
            title=title,
            manifest=manifest,
            requirements_path=requirements_path,
            artifact_files=artifact_files,
            pipeline_record=pipeline_record,
        )
        await self._o.write_artifact(INDEX_REL, body)
        await self._o.emit_stage(pipeline_id, "assembly", "completed")
        return INDEX_REL


def new_pipeline_id(chat_id: str) -> str:
    return f"dplan_{chat_id}_{uuid4().hex[:12]}"


def utc_now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()
