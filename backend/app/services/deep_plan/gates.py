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
    await persist_session_state(orchestrator, chat_id, state)
    logger.info("deep_plan_requested set chat_id=%s", chat_id)


async def set_deep_plan_confirmed(orchestrator: LLMOrchestrator, chat_id: str) -> None:
    state = await read_session_state(orchestrator, chat_id)
    working_memory = state.setdefault("working_memory", {})
    working_memory[DEEP_PLAN_CONFIRMED_KEY] = True
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


async def consume_deep_plan_gate(orchestrator: LLMOrchestrator, chat_id: str) -> None:
    """Clear gate after deep_plan_tool runs — avoid paying schema+guidance every later turn."""
    state = await read_session_state(orchestrator, chat_id)
    working_memory = state.setdefault("working_memory", {})
    working_memory.pop(DEEP_PLAN_REQUESTED_KEY, None)
    working_memory.pop(DEEP_PLAN_CONFIRMED_KEY, None)
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
