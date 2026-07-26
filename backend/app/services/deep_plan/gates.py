"""Session flags that unlock deep_plan_tool (not load_tool_context)."""
from __future__ import annotations

import json
import logging
from typing import Any, TYPE_CHECKING

if TYPE_CHECKING:
    from app.orchestrator import LLMOrchestrator

logger = logging.getLogger(__name__)

DEEP_PLAN_REQUESTED_KEY = "deep_plan_requested"
DEEP_PLAN_CONFIRMED_KEY = "deep_plan_confirmed"
DEEP_PLAN_PHASE_KEY = "deep_plan_phase"
DEEP_PLAN_PIPELINE_KEY = "deep_plan_pipeline"

PHASE_REQ = "req"
PHASE_PIPELINE = "pipeline"
PHASE_IDLE = "idle"

# Option ids that open gate B when context=planning_gate
_PLANNING_GATE_YES_IDS = frozenset(
    {
        "yes",
        "deep_plan_yes",
        "yes_deep_planning",
        "run_deep_plan",
    }
)


async def read_session_state(orchestrator: LLMOrchestrator, chat_id: str) -> dict[str, Any]:
    state: dict[str, Any] = {}
    try:
        state_str = await orchestrator.nats.kv_get("SESSIONS", f"session.{chat_id}")
        if state_str:
            state = json.loads(state_str)
    except Exception:
        logger.exception("Failed to read session from NATS chat_id=%s", chat_id)

    if not state:
        file_state = await orchestrator.file_store.read_session(chat_id)
        if isinstance(file_state, dict):
            state = file_state
    return state


async def persist_session_state(orchestrator: LLMOrchestrator, chat_id: str, state: dict[str, Any]) -> None:
    try:
        await orchestrator.nats.kv_set("SESSIONS", f"session.{chat_id}", json.dumps(state))
    except Exception:
        logger.exception("Failed to persist session to NATS chat_id=%s", chat_id)
    try:
        await orchestrator.file_store.write_session(chat_id, state)
    except Exception:
        logger.exception("Failed to persist session file chat_id=%s", chat_id)


async def apply_session_start_flags(
    orchestrator: LLMOrchestrator,
    chat_id: str,
    *,
    deep_plan_requested: bool,
) -> None:
    if not deep_plan_requested:
        return
    state = await read_session_state(orchestrator, chat_id)
    working_memory = state.setdefault("working_memory", {})
    working_memory[DEEP_PLAN_REQUESTED_KEY] = True
    if working_memory.get(DEEP_PLAN_PHASE_KEY) != PHASE_PIPELINE:
        working_memory[DEEP_PLAN_PHASE_KEY] = PHASE_REQ
    await persist_session_state(orchestrator, chat_id, state)
    logger.info("deep_plan_requested set chat_id=%s", chat_id)


async def set_deep_plan_confirmed(orchestrator: LLMOrchestrator, chat_id: str) -> None:
    state = await read_session_state(orchestrator, chat_id)
    working_memory = state.setdefault("working_memory", {})
    working_memory[DEEP_PLAN_CONFIRMED_KEY] = True
    if working_memory.get(DEEP_PLAN_PHASE_KEY) != PHASE_PIPELINE:
        working_memory[DEEP_PLAN_PHASE_KEY] = PHASE_REQ
    await persist_session_state(orchestrator, chat_id, state)
    logger.info("deep_plan_confirmed set chat_id=%s", chat_id)


def read_deep_plan_flags(working_memory: dict[str, Any] | None) -> dict[str, bool]:
    wm = working_memory or {}
    return {
        "deep_plan_requested": bool(wm.get(DEEP_PLAN_REQUESTED_KEY)),
        "deep_plan_confirmed": bool(wm.get(DEEP_PLAN_CONFIRMED_KEY)),
    }


def is_deep_plan_available(working_memory: dict[str, Any] | None) -> bool:
    """True when session has a pending deep-plan gate (schema + instructions may inject)."""
    flags = read_deep_plan_flags(working_memory)
    return flags["deep_plan_requested"] or flags["deep_plan_confirmed"]


def resolve_deep_plan_gate(
    working_memory: dict[str, Any] | None,
    *,
    this_turn_deep_plan_requested: bool,
) -> bool:
    """Inject deep_plan_tool schema + guidance only when gate is open this turn."""
    if this_turn_deep_plan_requested:
        return True
    return is_deep_plan_available(working_memory)


def read_deep_plan_phase(working_memory: dict[str, Any] | None) -> str:
    wm = working_memory or {}
    phase = wm.get(DEEP_PLAN_PHASE_KEY)
    if phase in (PHASE_REQ, PHASE_PIPELINE, PHASE_IDLE):
        return str(phase)
    if is_deep_plan_available(wm):
        return PHASE_REQ
    return PHASE_IDLE


async def set_deep_plan_phase(orchestrator: LLMOrchestrator, chat_id: str, phase: str) -> None:
    if phase not in (PHASE_REQ, PHASE_PIPELINE, PHASE_IDLE):
        raise ValueError(f"invalid deep plan phase: {phase!r}")
    state = await read_session_state(orchestrator, chat_id)
    working_memory = state.setdefault("working_memory", {})
    working_memory[DEEP_PLAN_PHASE_KEY] = phase
    await persist_session_state(orchestrator, chat_id, state)


async def set_deep_plan_pipeline(
    orchestrator: LLMOrchestrator,
    chat_id: str,
    pipeline: dict[str, Any],
) -> None:
    state = await read_session_state(orchestrator, chat_id)
    working_memory = state.setdefault("working_memory", {})
    working_memory[DEEP_PLAN_PIPELINE_KEY] = pipeline
    await persist_session_state(orchestrator, chat_id, state)


async def clear_deep_plan_pipeline(orchestrator: LLMOrchestrator, chat_id: str) -> None:
    state = await read_session_state(orchestrator, chat_id)
    working_memory = state.setdefault("working_memory", {})
    working_memory.pop(DEEP_PLAN_PIPELINE_KEY, None)
    working_memory[DEEP_PLAN_PHASE_KEY] = PHASE_IDLE
    await persist_session_state(orchestrator, chat_id, state)


async def abort_deep_plan_req(orchestrator: LLMOrchestrator, chat_id: str) -> bool:
    """Clear req-phase gate when user exits deep plan UI.

    During pipeline run (workers): no-op.
    While awaiting final approval: use abort_deep_plan_pipeline instead.
    """
    state = await read_session_state(orchestrator, chat_id)
    working_memory = state.setdefault("working_memory", {})
    if working_memory.get(DEEP_PLAN_PHASE_KEY) == PHASE_PIPELINE:
        return False
    working_memory.pop(DEEP_PLAN_REQUESTED_KEY, None)
    working_memory.pop(DEEP_PLAN_CONFIRMED_KEY, None)
    working_memory[DEEP_PLAN_PHASE_KEY] = PHASE_IDLE
    await persist_session_state(orchestrator, chat_id, state)
    logger.info("deep_plan req aborted by user chat_id=%s", chat_id)
    return True


async def abort_deep_plan_pipeline(
    orchestrator: LLMOrchestrator,
    chat_id: str,
) -> tuple[bool, str, str | None, bool]:
    """Abort during pipeline run or while awaiting DeepPlanCard approval.

    Returns (ok, message, pipeline_id, hard_cancel). hard_cancel is True when the
    active session task should be cancelled immediately (pipeline_running).
    """
    from .pipeline_state import (
        STATUS_ABORTED,
        STATUS_AWAITING_APPROVAL,
        STATUS_RUNNING,
        read_pipeline_record,
        set_pipeline_terminal_status,
    )

    state = await read_session_state(orchestrator, chat_id)
    working_memory = state.setdefault("working_memory", {})
    pipeline = read_pipeline_record(working_memory)
    if not isinstance(pipeline, dict):
        return False, "no_active_pipeline", None, False

    pipeline_id = str(pipeline.get("pipeline_id") or "")
    status = str(pipeline.get("status") or "")

    if status == STATUS_AWAITING_APPROVAL:
        return True, "ok", pipeline_id or None, False

    if status == STATUS_RUNNING:
        await set_pipeline_terminal_status(orchestrator, chat_id, STATUS_ABORTED)
        run_id = orchestrator.pipeline_run_by_chat.get(str(chat_id))
        if run_id:
            await orchestrator.cancel_agent_run(run_id, reason="user")
        logger.info(
            "deep_plan pipeline targeted-abort requested chat_id=%s pipeline_id=%s",
            chat_id,
            pipeline_id,
        )
        return True, "ok", pipeline_id or None, False

    return False, "no_active_pipeline", None, False


async def consume_deep_plan_gate(orchestrator: LLMOrchestrator, chat_id: str) -> None:
    """Clear gate flags after successful handoff — pipeline phase continues separately."""
    state = await read_session_state(orchestrator, chat_id)
    working_memory = state.setdefault("working_memory", {})
    working_memory.pop(DEEP_PLAN_REQUESTED_KEY, None)
    working_memory.pop(DEEP_PLAN_CONFIRMED_KEY, None)
    working_memory[DEEP_PLAN_PHASE_KEY] = PHASE_PIPELINE
    await persist_session_state(orchestrator, chat_id, state)
    logger.info("deep_plan gate consumed chat_id=%s", chat_id)


def planning_gate_answers_confirm_deep_plan(answers: list[dict[str, Any]]) -> bool:
    for answer in answers:
        if not isinstance(answer, dict):
            continue
        if answer.get("type") == "option":
            option_id = str(answer.get("option_id", "")).lower()
            if option_id in _PLANNING_GATE_YES_IDS:
                return True
            label = str(answer.get("label", "")).lower()
            if "yes" in label and "deep" in label:
                return True
        if answer.get("type") == "custom":
            text = str(answer.get("text", "")).lower()
            if "yes" in text and ("deep" in text or "pipeline" in text):
                return True
    return False
