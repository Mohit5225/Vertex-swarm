import json
import logging
from datetime import datetime, timezone
from typing import Any, Optional
from uuid import uuid4

import asyncio
# pyrefly: ignore [missing-import]
from openai import RateLimitError, APIError


from app.config import WorkerConfig
from app.nats_client import NATSClient
from app.file_store import FileStore
from app.stdio_transport import StdioTransport


from app.schemas.tool import ToolResultSchema
from app.services.llm_service import stream_chat_events, format_tool_response
from app.services.tool_memory import build_tool_memory_from_trace_events, format_tool_memory_for_prompt
from app.services.tool_registry import build_tools_list, is_loadable_tool_loaded, resolve_loadable_tool_name
from app.services.prompt_loader import build_injected_guidance, load_categories, SUPPORTED_CATEGORIES
from app.services.hil_support import validate_hil_ask_payload, normalize_hil_questions, enrich_hil_answers
from app.services.deep_plan import (
    DeepPlanOrchestrator,
    apply_session_start_flags,
    consume_deep_plan_gate,
    is_deep_plan_available,
    planning_gate_answers_confirm_deep_plan,
    read_deep_plan_phase,
    read_session_state,
    resolve_deep_plan_gate,
    set_deep_plan_confirmed,
)
from app.services.deep_plan.gates import DEEP_PLAN_CONFIRMED_KEY
from app.services.deep_plan.artifacts import normalize_rel_path, validate_handoff
from app.services.deep_plan.constants import MANIFEST_REL, REQUIREMENTS_REL
from app.services.websearch import search_web
from app.utils.token_profiler import TokenProfiler
from app.services.llm_service import DEVELOPER_ASSISTANT_PERSONA
logger = logging.getLogger(__name__)

# How long hil_tool waits for session/hil_respond before failing the tool call.
_HIL_RESPONSE_TIMEOUT_SECONDS = 86_400


class _PendingHilSession:
    """One blocked hil_tool call — queue receives answers from session/hil_respond."""

    __slots__ = ("queue", "chat_id", "message_id", "tool_call_id", "emit_trace_and_push", "hil_context")

    def __init__(
        self,
        *,
        chat_id: str,
        message_id: str,
        tool_call_id: str,
        emit_trace_and_push: Any,
        hil_context: str | None = None,
    ) -> None:
        self.queue: asyncio.Queue = asyncio.Queue()
        self.chat_id = chat_id
        self.message_id = message_id
        self.tool_call_id = tool_call_id
        self.emit_trace_and_push = emit_trace_and_push
        self.hil_context = hil_context


class LLMOrchestrator:
    def __init__(self, config: WorkerConfig, nats: NATSClient):
        self.config = config
        self.nats = nats
        self.file_store = FileStore(config.base_path)
        self.stdio = StdioTransport()
        self.active_tool_queues: dict[str, asyncio.Queue] = {}
        self.job_completion_queues: dict[str, list[dict[str, Any]]] = {}
        # hil_session_id → blocked ask; only one pending HIL per chat at a time (v1).
        self.pending_hil_sessions: dict[str, _PendingHilSession] = {}
        # pipeline_id → approval queue for deep_plan_tool
        self.pending_deep_plan_approvals: dict[str, asyncio.Queue] = {}
        # chat_id → active deep plan pipeline context for run_planning_stage
        self.active_pipeline_by_chat: dict[str, dict[str, Any]] = {}
        # chat_id set when user aborts during pipeline_running (cooperative cancel)
        self.pipeline_abort_by_chat: set[str] = set()

    def request_pipeline_abort(self, chat_id: str) -> None:
        self.pipeline_abort_by_chat.add(str(chat_id))

    def is_pipeline_abort_requested(self, chat_id: str) -> bool:
        return str(chat_id) in self.pipeline_abort_by_chat

    def clear_pipeline_abort(self, chat_id: str) -> None:
        self.pipeline_abort_by_chat.discard(str(chat_id))

    async def wait_for_deep_plan_approval(
        self,
        pipeline_id: str,
        timeout_seconds: int = 86_400,
    ) -> dict[str, Any] | None:
        queue: asyncio.Queue = asyncio.Queue()
        self.pending_deep_plan_approvals[pipeline_id] = queue
        try:
            result = await asyncio.wait_for(queue.get(), timeout=timeout_seconds)
            if isinstance(result, dict):
                return result
            return None
        except asyncio.TimeoutError:
            return None
        finally:
            self.pending_deep_plan_approvals.pop(pipeline_id, None)

    async def handle_planning_approve(self, pipeline_id: str) -> tuple[bool, str]:
        queue = self.pending_deep_plan_approvals.get(pipeline_id)
        if queue is None:
            return False, "Unknown or expired pipeline_id"
        await queue.put({"approved": True})
        return True, "ok"

    async def handle_planning_reject(
        self,
        pipeline_id: str,
        rejection_feedback: str,
    ) -> tuple[bool, str]:
        queue = self.pending_deep_plan_approvals.get(pipeline_id)
        if queue is None:
            return False, "Unknown or expired pipeline_id"
        await queue.put({"approved": False, "rejection_feedback": rejection_feedback})
        return True, "ok"

    async def handle_abort_deep_plan(self, chat_id: str) -> tuple[bool, str, bool]:
        """Returns (ok, message, hard_cancel). hard_cancel=True → cancel active session task."""
        from app.services.deep_plan import abort_deep_plan_req
        from app.services.deep_plan.gates import abort_deep_plan_pipeline

        ok, message, pipeline_id, hard_cancel = await abort_deep_plan_pipeline(self, chat_id)
        if ok:
            if pipeline_id:
                queue = self.pending_deep_plan_approvals.get(pipeline_id)
                if queue is not None:
                    await queue.put({"approved": False, "aborted": True})
            return True, "ok", hard_cancel

        if await abort_deep_plan_req(self, chat_id):
            return True, "ok", False
        return False, message or "pipeline_running", False

    def enqueue_job_completion(self, chat_id: str, payload: dict[str, Any]) -> None:
        self.job_completion_queues.setdefault(chat_id, []).append(payload)

    def drain_job_completions(self, chat_id: str) -> list[dict[str, Any]]:
        return self.job_completion_queues.pop(chat_id, [])

    def clear_job_completions(self, chat_id: str) -> None:
        self.job_completion_queues.pop(chat_id, None)

    def _begin_tool_result_wait(self, tool_call_id: str) -> asyncio.Queue:
        """Register a result queue before emitting tool_call to the extension."""
        queue: asyncio.Queue = asyncio.Queue()
        self.active_tool_queues[tool_call_id] = queue
        return queue

    async def _finish_tool_result_wait(
        self,
        tool_call_id: str,
        queue: asyncio.Queue,
        timeout_seconds: int = 360,
    ) -> ToolResultSchema | None:
        try:
            return await asyncio.wait_for(queue.get(), timeout=timeout_seconds)
        except asyncio.TimeoutError:
            return None
        finally:
            self.active_tool_queues.pop(tool_call_id, None)

    async def _wait_for_tool_result(
        self,
        tool_call_id: str,
        timeout_seconds: int = 360,
    ) -> ToolResultSchema | None:
        queue = self._begin_tool_result_wait(tool_call_id)
        return await self._finish_tool_result_wait(tool_call_id, queue, timeout_seconds)

    async def _notify_extension_abort_session_tools(self, session_id: str) -> None:
        """Tell the extension host to cancel in-flight tools for a nested session."""
        if not self.stdio:
            return
        await self.stdio.write_message(
            {
                "jsonrpc": "2.0",
                "method": "tool/abort",
                "params": {"session_id": session_id},
            }
        )

    async def handle_tool_result(self, result: ToolResultSchema) -> None:
        tool_call_id = result.tool_call_id
        if tool_call_id in self.active_tool_queues:
            await self.active_tool_queues[tool_call_id].put(result)
        else:
            logger.warning(f"Received tool result for unknown tool_call_id: {tool_call_id}")

    async def handle_hil_respond(
        self,
        hil_session_id: str,
        answers: list[dict[str, Any]],
    ) -> tuple[bool, str]:
        """Resolve a blocked hil_tool call. Called from session/hil_respond RPC."""
        pending = self.pending_hil_sessions.get(hil_session_id)
        if pending is None:
            return False, "Unknown or expired hil_session_id"

        # Emit hil_resolved so the inline card updates in place (persisted on the message).
        resolved_event = _build_event(
            "hil_resolved",
            metadata={
                "hil_session_id": hil_session_id,
                "answers": answers,
                "status": "resolved",
            },
            chat_id=pending.chat_id,
            message_id=pending.message_id,
        )
        await pending.emit_trace_and_push(resolved_event)

        # Unblock the waiting _execute_tool_call coroutine.
        await pending.queue.put(answers)
        return True, "ok"

    async def _wait_for_hil_response(
        self,
        hil_session_id: str,
        timeout_seconds: int = _HIL_RESPONSE_TIMEOUT_SECONDS,
    ) -> list[dict[str, Any]] | None:
        pending = self.pending_hil_sessions.get(hil_session_id)
        if pending is None:
            return None
        try:
            answers = await asyncio.wait_for(pending.queue.get(), timeout=timeout_seconds)
            if isinstance(answers, list):
                return answers
            return None
        except asyncio.TimeoutError:
            return None
        finally:
            self.pending_hil_sessions.pop(hil_session_id, None)

    async def handle_session_start(self, chat_id: str, message: str, context: dict) -> None:
        await _run_agent_loop_impl(self, chat_id, message, context)


def _event_timestamp_ms() -> int:
    return int(datetime.now(timezone.utc).timestamp() * 1000)


def _build_event(
    event_type: str,
    *,
    content: str | None = None,
    metadata: dict[str, Any] | None = None,
    **extra: Any,
) -> dict[str, Any]:
    event: dict[str, Any] = {
        "id": f"evt-{uuid4().hex[:12]}",
        "type": event_type,
        "timestamp": _event_timestamp_ms(),
    }
    if content is not None:
        event["content"] = content
    if metadata:
        event["metadata"] = metadata
    event.update(extra)
    return event


def _compute_turn_duration_ms(trace_events: list[dict[str, Any]]) -> int | None:
    if not trace_events:
        return None

    start_ts = trace_events[0].get("timestamp")
    end_ts = trace_events[-1].get("timestamp")
    if not isinstance(start_ts, (int, float)) or not isinstance(end_ts, (int, float)):
        return None

    return max(0, int(end_ts) - int(start_ts))


def _preview(value: str, limit: int = 180) -> str:
    normalized = " ".join(value.split())
    if len(normalized) <= limit:
        return normalized
    return f"{normalized[: limit - 3]}..."


def _is_hil_tool_call(call: dict[str, Any]) -> bool:
    return call.get("tool_name") == "hil_tool"


def _is_deep_plan_tool_call(call: dict[str, Any]) -> bool:
    return call.get("tool_name") == "deep_plan_tool"


def _is_run_planning_stage_call(call: dict[str, Any]) -> bool:
    return call.get("tool_name") == "run_planning_stage"


def _build_job_completion_message(payload: dict[str, Any]) -> dict[str, str]:
    job_id = payload.get("job_id", "unknown")
    exit_code = payload.get("exit_code")
    output_tail = payload.get("output_tail") or ""
    command = payload.get("command") or ""
    status_message = payload.get("status_message") or payload.get("status") or "completed"
    content = (
        "[System Notification: Background terminal job finished]\n"
        f"job_id: {job_id}\n"
        f"command: {command}\n"
        f"exit_code: {exit_code}\n"
        f"status: {status_message}\n"
        f"output_tail:\n{output_tail}\n"
        "Use terminal_ops -> get_output for full output if needed."
    )
    return {"role": "system", "content": content}


def _assistant_tool_call_message(
    assistant_turn_content: str,
    tool_name: str,
    tool_call_id: str,
    tool_args: dict[str, Any],
    assistant_reasoning_content: str = "",
) -> dict[str, Any]:
    tool_call_arguments = json.dumps(tool_args, separators=(",", ":"), sort_keys=True)
    assistant_message: dict[str, Any] = {
        "role": "assistant",
        "content": assistant_turn_content,
        "tool_calls": [
            {
                "id": tool_call_id,
                "type": "function",
                "function": {
                    "name": tool_name,
                    "arguments": tool_call_arguments,
                },
            }
        ],
    }
    if not assistant_turn_content:
        assistant_message["content"] = None
        
    if assistant_reasoning_content:
        assistant_message["reasoning_content"] = assistant_reasoning_content
        
    return assistant_message


def _assistant_tool_call_message_multi(
    assistant_turn_content: str,
    tool_calls: list[dict[str, Any]],
    assistant_reasoning_content: str = "",
) -> dict[str, Any]:
    """Build an assistant message carrying multiple parallel tool call requests.

    The OpenAI chat completions API allows a single assistant turn to request
    multiple tool calls simultaneously.  All of those call descriptors must
    live inside the same ``tool_calls`` list so the subsequent ``tool``
    messages can be matched back by ``tool_call_id``.
    """
    assistant_message: dict[str, Any] = {
        "role": "assistant",
        "content": assistant_turn_content or None,
        "tool_calls": [
            {
                "id": call["tool_call_id"],
                "type": "function",
                "function": {
                    "name": call["tool_name"],
                    "arguments": json.dumps(call["args"], separators=(",", ":"), sort_keys=True),
                },
            }
            for call in tool_calls
        ],
    }
    if assistant_reasoning_content:
        assistant_message["reasoning_content"] = assistant_reasoning_content
    return assistant_message


def _build_request_context_message(request_context: dict[str, Any] | None) -> str | None:
    if not request_context:
        return None

    lines: list[str] = ["VS Code request context:"]

    active_file = request_context.get("activeFile")
    if isinstance(active_file, dict):
        file_path = active_file.get("path")
        if isinstance(file_path, str) and file_path:
            lines.append(f"Active file: {file_path}")

        language_id = active_file.get("languageId")
        if isinstance(language_id, str) and language_id:
            lines.append(f"Language: {language_id}")

        selection = active_file.get("selection")
        if isinstance(selection, dict):
            selection_text = selection.get("text")
            if isinstance(selection_text, str) and selection_text.strip():
                lines.append("Selection:")
                lines.append(_preview(selection_text, 500))

    active_terminal = request_context.get("activeTerminal")
    if isinstance(active_terminal, dict):
        terminal_name = active_terminal.get("name")
        if isinstance(terminal_name, str) and terminal_name:
            lines.append(f"Active terminal: {terminal_name}")

        shell = active_terminal.get("shell")
        if isinstance(shell, str) and shell:
            lines.append(f"Terminal shell: {shell}")

        cwd = active_terminal.get("cwd")
        if isinstance(cwd, str) and cwd:
            lines.append(f"Terminal CWD: {cwd}")

        process_id = active_terminal.get("processId")
        if isinstance(process_id, int):
            lines.append(f"Terminal process id: {process_id}")

    active_terminals = request_context.get("activeTerminals")
    if isinstance(active_terminals, list) and active_terminals:
        lines.append("Active Terminals State:")
        for t in active_terminals:
            if isinstance(t, dict):
                t_name = t.get("name", "unknown")
                t_purpose = t.get("purpose", "unknown")
                t_busy = t.get("isBusy", False)
                lines.append(f"- [Name: \"{t_name}\"] (Busy: {t_busy}) Purpose: \"{t_purpose}\"")

    os_platform = request_context.get("os")
    if isinstance(os_platform, str) and os_platform:
        lines.append(f"Operating System: {os_platform}")

    workspace_folders = request_context.get("workspaceFolders")
    if isinstance(workspace_folders, list):
        folder_names = [folder for folder in workspace_folders if isinstance(folder, str) and folder]
        if folder_names:
            lines.append("Workspace folders:")
            lines.extend(f"- {folder}" for folder in folder_names[:10])

    if len(lines) == 1:
        return None

    return "\n".join(lines)


def _log_trace_event(
    user_id: str | None,
    chat_id: str,
    session_id: str,
    message_id: str,
    event: dict[str, Any],
) -> None:
    safe_user_id = user_id or "unknown"
    event_type = str(event.get("type", "unknown"))
    content = str(event.get("content", ""))

    if event_type == "thinking":
        logger.info(
            "thinking trace user_id=%s chat_id=%s session_id=%s message_id=%s preview=%s",
            safe_user_id,
            chat_id,
            session_id,
            message_id,
            _preview(content),
        )
        return

    if event_type == "status":
        logger.info(
            "status update user_id=%s chat_id=%s session_id=%s message_id=%s status=%s",
            safe_user_id,
            chat_id,
            session_id,
            message_id,
            _preview(content),
        )
        return

    if event_type == "tool_call":
        logger.info(
            "tool requested user_id=%s chat_id=%s session_id=%s message_id=%s tool_call_id=%s tool_name=%s args=%s",
            safe_user_id,
            chat_id,
            session_id,
            message_id,
            event.get("tool_call_id"),
            event.get("tool_name"),
            json.dumps(event.get("args", {}), sort_keys=True),
        )
        return

    if event_type == "tool_result":
        logger.info(
            "tool result received user_id=%s chat_id=%s session_id=%s message_id=%s tool_call_id=%s tool_name=%s status=%s execution_time_ms=%s",
            safe_user_id,
            chat_id,
            session_id,
            message_id,
            event.get("tool_call_id"),
            event.get("tool_name"),
            event.get("status"),
            event.get("execution_time_ms"),
        )
        return

    if event_type == "error":
        logger.error(
            "stream error event user_id=%s chat_id=%s session_id=%s message_id=%s error=%s",
            safe_user_id,
            chat_id,
            session_id,
            message_id,
            _preview(content),
        )



# ---------------------------------------------------------------------------
# Tool call helpers
# ---------------------------------------------------------------------------

def _is_load_tool_context_call(call: dict[str, Any]) -> bool:
    tool_name = call.get("tool_name", "")
    return tool_name in ("load_tool_context", "workspace_ops.load_tool_context")


async def _reject_if_tool_not_loaded(
    *,
    tool_name: str,
    tool_call_id: str,
    tool_args: dict[str, Any],
    active_categories_holder: list[list[str]],
    synthetic_session_id: str,
    chat_id: str,
    request_message_id: str,
    emit_trace_and_push: Any,
    extension_execute: bool = False,
) -> tuple[str, str, str, str, str | None, dict[str, Any] | None] | None:
    """Return an error result tuple when a loadable tool was called without loaded context."""
    loadable_category = resolve_loadable_tool_name(tool_name)
    if loadable_category is None or is_loadable_tool_loaded(tool_name, active_categories_holder[0]):
        return None

    result_content = (
        f"Error: {loadable_category} context is not loaded. "
        f"Call load_tool_context with ['{loadable_category}'] first — that loads the tool schema and usage guidance together."
    )
    tool_event = _build_event(
        "tool_call",
        metadata={"phase": "tool_requested", "extension_execute": extension_execute},
        tool_call_id=tool_call_id,
        tool_name=tool_name,
        args=tool_args,
        session_id=synthetic_session_id,
        chat_id=str(chat_id),
        message_id=request_message_id,
    )
    await emit_trace_and_push(tool_event)
    error_event = _build_event(
        "tool_result",
        metadata={"phase": "tool_result", "status": "error", "error_code": "tool_not_loaded"},
        status="error",
        content=result_content,
        error_code="tool_not_loaded",
        tool_call_id=tool_call_id,
    )
    await emit_trace_and_push(error_event)
    return (tool_call_id, tool_name, result_content, "error", "tool_not_loaded", None)

# ---------------------------------------------------------------------------
# _execute_tool_call
# ---------------------------------------------------------------------------
# A standalone coroutine that handles exactly ONE tool call event produced by
# the LLM.  It is designed to be awaited via asyncio.gather so that several
# tool calls requested in the same LLM turn can run concurrently.
#
# Returns a (tool_call_id, tool_name, result_content, result_status,
# error_code) tuple so the caller can build tool-role messages without any
# shared mutable state.
# ---------------------------------------------------------------------------

async def _execute_tool_call(
    orchestrator: "LLMOrchestrator",
    event: dict[str, Any],
    *,
    # ── context forwarded from the parent agent loop ──────────────────────
    user_id: str,
    chat_id: str,
    synthetic_session_id: str,
    request_message_id: str,
    req_workspace_skeleton: str | None,
    existing_active_categories: list[str],
    context: dict,
    # ── callbacks so we can push UI events without sharing mutable state ──
    emit_trace_and_push: Any,
    build_status_event: Any,
    # ── mutable shared state (load_tool_context updates these) ───────────
    active_tool_guidance_holder: list[str | None],  # [0] is the current value
    active_categories_holder: list[list[str]],       # [0] is the current list
    deep_plan_available_holder: list[bool] | None = None,
) -> tuple[str, str, str, str, str | None, dict[str, Any] | None]:
    """Execute a single tool call and return its result tuple.

    Designed to run concurrently with other _execute_tool_call coroutines via
    asyncio.gather, except load_tool_context which must finish before other
    tools in the same LLM turn can rely on loaded categories.
    """
    tool_name: str = event.get("tool_name", "")
    tool_call_id: str = event.get("tool_call_id", "")
    tool_args: dict[str, Any] = event.get("args", {})
    if not isinstance(tool_args, dict):
        tool_args = {}

    # ── load_tool_context ──────────────────────────────────────────────────
    if tool_name in ("load_tool_context", "workspace_ops.load_tool_context"):
        requested = tool_args.get("categories", [])
        if not isinstance(requested, list):
            requested = []
        valid = [c for c in requested if c in SUPPORTED_CATEGORIES]

        loaded_prose = load_categories(valid)
        newly_loaded = list(loaded_prose.keys())

        merged = list(dict.fromkeys(active_categories_holder[0] + newly_loaded))
        active_categories_holder[0] = merged
        active_tool_guidance_holder[0] = build_injected_guidance(merged) or None

        try:
            state_str = await orchestrator.nats.kv_get("SESSIONS", f"session.{chat_id}")
            if state_str:
                state = json.loads(state_str)
                if "working_memory" not in state:
                    state["working_memory"] = {}
                state["working_memory"]["active_tool_categories"] = merged
                await orchestrator.nats.kv_set("SESSIONS", f"session.{chat_id}", json.dumps(state))
                await orchestrator.file_store.write_session(chat_id, state)
        except Exception:
            logger.exception("Failed to persist active_tool_categories session_id=%s", synthetic_session_id)

        if newly_loaded:
            await emit_trace_and_push(
                _build_event(
                    "status",
                    metadata={"phase": "tools_loaded", "categories": newly_loaded},
                    session_id=synthetic_session_id,
                    chat_id=str(chat_id),
                    message_id=request_message_id,
                )
            )

        combined_prose = "\n\n---\n\n".join(loaded_prose.values())
        if newly_loaded:
            result_content = (
                f"Loaded tools: {', '.join(newly_loaded)}. "
                f"Schemas and usage guidance are ready.\n\n{combined_prose}"
            )
        elif active_categories_holder[0]:
            result_content = f"Already loaded: {', '.join(active_categories_holder[0])}."
        else:
            result_content = "No tool categories loaded."
        return (tool_call_id, tool_name, result_content, "success", None, None)

    not_loaded = await _reject_if_tool_not_loaded(
        tool_name=tool_name,
        tool_call_id=tool_call_id,
        tool_args=tool_args,
        active_categories_holder=active_categories_holder,
        synthetic_session_id=synthetic_session_id,
        chat_id=chat_id,
        request_message_id=request_message_id,
        emit_trace_and_push=emit_trace_and_push,
        extension_execute=resolve_loadable_tool_name(tool_name) in ("workspace_ops", "terminal_ops"),
    )
    if not_loaded is not None:
        return not_loaded

    # ── hil_tool ──────────────────────────────────────────────────────────
    # Blocks the agent until session/hil_respond delivers answers (not a chat message).
    if tool_name == "hil_tool":
        validation_error, error_code = validate_hil_ask_payload(tool_args)

        tool_event = _build_event(
            "tool_call",
            metadata={"phase": "tool_requested", "extension_execute": False},
            tool_call_id=tool_call_id,
            tool_name=tool_name,
            args=tool_args,
            session_id=synthetic_session_id,
            chat_id=str(chat_id),
            message_id=request_message_id,
        )
        await emit_trace_and_push(tool_event)

        if validation_error:
            error_event = _build_event(
                "tool_result",
                metadata={"phase": "tool_result", "status": "error", "error_code": error_code},
                status="error",
                content=validation_error,
                error_code=error_code,
                tool_call_id=tool_call_id,
            )
            await emit_trace_and_push(error_event)
            return (tool_call_id, tool_name, validation_error, "error", error_code, None)

        # One pending HIL per chat — concurrent asks would route answers to the wrong agent.
        if orchestrator.pending_hil_sessions:
            busy_msg = "Another HIL question is already pending. Wait for the user to answer it first."
            error_event = _build_event(
                "tool_result",
                metadata={"phase": "tool_result", "status": "error", "error_code": "hil_already_pending"},
                status="error",
                content=busy_msg,
                error_code="hil_already_pending",
                tool_call_id=tool_call_id,
            )
            await emit_trace_and_push(error_event)
            return (tool_call_id, tool_name, busy_msg, "error", "hil_already_pending", None)

        payload = tool_args.get("payload", {})
        questions = normalize_hil_questions(payload.get("questions", []))
        hil_session_id = f"hil_{uuid4().hex[:12]}"
        agent_label = str(payload.get("agent_label", "")).strip()
        hil_context = payload.get("context")

        orchestrator.pending_hil_sessions[hil_session_id] = _PendingHilSession(
            chat_id=str(chat_id),
            message_id=request_message_id,
            tool_call_id=tool_call_id,
            emit_trace_and_push=emit_trace_and_push,
            hil_context=str(hil_context) if hil_context is not None else None,
        )

        # hil_question drives HilQuestionCard in the webview (persisted on message.events).
        await emit_trace_and_push(
            _build_event(
                "hil_question",
                metadata={
                    "hil_session_id": hil_session_id,
                    "agent_label": agent_label,
                    "context": hil_context,
                    "questions": questions,
                    "current_index": 1,
                    "total": len(questions),
                    "status": "pending",
                },
                chat_id=str(chat_id),
                message_id=request_message_id,
            )
        )
        await emit_trace_and_push(
            build_status_event("HIL card active — answer to continue", "hil_card")
        )

        raw_answers = await orchestrator._wait_for_hil_response(hil_session_id)
        if raw_answers is None:
            timeout_msg = "Timed out waiting for HIL response."
            error_event = _build_event(
                "tool_result",
                metadata={"phase": "tool_result", "status": "error", "error_code": "hil_timeout"},
                status="error",
                content=timeout_msg,
                error_code="hil_timeout",
                tool_call_id=tool_call_id,
            )
            await emit_trace_and_push(error_event)
            return (tool_call_id, tool_name, timeout_msg, "error", "hil_timeout", None)

        enriched = enrich_hil_answers(questions, raw_answers)
        if hil_context == "planning_gate" and planning_gate_answers_confirm_deep_plan(enriched):
            await set_deep_plan_confirmed(orchestrator, str(chat_id))
            if deep_plan_available_holder is not None:
                deep_plan_available_holder[0] = True
            await emit_trace_and_push(
                _build_event(
                    "deep_plan_mode_active",
                    metadata={
                        "trigger": "vertex_hil",
                        "phase": "requirement_extraction",
                        "stage_label": "Requirement extraction",
                    },
                    chat_id=str(chat_id),
                    message_id=request_message_id,
                )
            )
            await emit_trace_and_push(
                _build_event(
                    "deep_plan_started",
                    metadata={
                        "trigger": "vertex_hil",
                        "phase": "requirement_extraction",
                        "stage_id": "requirement_extraction",
                        "title": "Deep plan",
                    },
                    chat_id=str(chat_id),
                    message_id=request_message_id,
                )
            )
        result_content = "User answered HIL questions."
        tool_data = {"hil_session_id": hil_session_id, "answers": enriched}
        success_event = _build_event(
            "tool_result",
            metadata={"phase": "tool_result", "status": "success"},
            status="success",
            content=result_content,
            tool_call_id=tool_call_id,
            data=tool_data,
        )
        await emit_trace_and_push(success_event)
        return (tool_call_id, tool_name, result_content, "success", None, tool_data)

    # ── run_planning_stage (Vertex pipeline orchestration only) ───────────
    if tool_name == "run_planning_stage":
        tool_event = _build_event(
            "tool_call",
            metadata={"phase": "tool_requested", "extension_execute": False},
            tool_call_id=tool_call_id,
            tool_name=tool_name,
            args=tool_args,
            session_id=synthetic_session_id,
            chat_id=str(chat_id),
            message_id=request_message_id,
        )
        await emit_trace_and_push(tool_event)

        pipeline_ctx = orchestrator.active_pipeline_by_chat.get(str(chat_id))
        if not pipeline_ctx:
            err = (
                "run_planning_stage is only available while deep_plan_tool is running "
                "the planner pipeline."
            )
            error_event = _build_event(
                "tool_result",
                metadata={"phase": "tool_result", "status": "error", "error_code": "no_pipeline_context"},
                status="error",
                content=err,
                error_code="no_pipeline_context",
                tool_call_id=tool_call_id,
            )
            await emit_trace_and_push(error_event)
            return (tool_call_id, tool_name, err, "error", "no_pipeline_context", None)

        from app.services.deep_plan.planning_stage_tool import execute_run_planning_stage

        deep_o = pipeline_ctx["deep_o"]
        result_status, result_content, tool_data = await execute_run_planning_stage(
            deep_o,
            stage_id=str(tool_args.get("stage_id") or ""),
            pipeline_id=str(tool_args.get("pipeline_id") or ""),
            manifest=pipeline_ctx["manifest"],
            requirements_path=pipeline_ctx["requirements_path"],
        )
        is_error = result_status == "error"
        success_event = _build_event(
            "tool_result",
            metadata={
                "phase": "tool_result",
                "status": "error" if is_error else "success",
                **({"error_code": (tool_data or {}).get("error_code")} if is_error else {}),
            },
            status="error" if is_error else "success",
            content=result_content,
            tool_call_id=tool_call_id,
            data=tool_data,
            **({"error_code": (tool_data or {}).get("error_code")} if is_error and tool_data else {}),
        )
        await emit_trace_and_push(success_event)
        error_code = (tool_data or {}).get("error_code") if is_error else None
        return (
            tool_call_id,
            tool_name,
            result_content,
            result_status,
            error_code,
            tool_data,
        )

    # ── deep_plan_tool ────────────────────────────────────────────────────
    if tool_name == "deep_plan_tool":
        deep_available = (
            deep_plan_available_holder[0]
            if deep_plan_available_holder is not None
            else False
        )
        tool_event = _build_event(
            "tool_call",
            metadata={"phase": "tool_requested", "extension_execute": False},
            tool_call_id=tool_call_id,
            tool_name=tool_name,
            args=tool_args,
            session_id=synthetic_session_id,
            chat_id=str(chat_id),
            message_id=request_message_id,
        )
        await emit_trace_and_push(tool_event)

        if not deep_available:
            err = (
                "deep_plan_tool is not available. User must type /deep-plan or confirm deep "
                "planning via hil_tool (planning_gate) first."
            )
            error_event = _build_event(
                "tool_result",
                metadata={"phase": "tool_result", "status": "error", "error_code": "deep_plan_not_available"},
                status="error",
                content=err,
                error_code="deep_plan_not_available",
                tool_call_id=tool_call_id,
            )
            await emit_trace_and_push(error_event)
            return (tool_call_id, tool_name, err, "error", "deep_plan_not_available", None)

        action = tool_args.get("action")
        payload = tool_args.get("payload", {})
        if not isinstance(payload, dict):
            payload = {}

        if str(action) == "start":
            try:
                requirements_path = normalize_rel_path(
                    payload.get("requirements_path"),
                    REQUIREMENTS_REL,
                )
                manifest_path = normalize_rel_path(
                    payload.get("manifest_path"),
                    MANIFEST_REL,
                )
            except ValueError as exc:
                err = str(exc)
                error_event = _build_event(
                    "tool_result",
                    metadata={"phase": "tool_result", "status": "error", "error_code": "handoff_invalid"},
                    status="error",
                    content=err,
                    error_code="handoff_invalid",
                    tool_call_id=tool_call_id,
                )
                await emit_trace_and_push(error_event)
                return (tool_call_id, tool_name, err, "error", "handoff_invalid", None)

            chat_dir = orchestrator.file_store.chats_path / str(chat_id)
            _, _, handoff_errors = await validate_handoff(
                chat_dir,
                requirements_path=requirements_path,
                manifest_path=manifest_path,
            )
            if handoff_errors:
                err = (
                    "Requirement handoff invalid. Complete req extraction first "
                    "(01_requirements.md + 00_pipeline_manifest.json).\n"
                    + "\n".join(f"- {e}" for e in handoff_errors)
                )
                error_event = _build_event(
                    "tool_result",
                    metadata={"phase": "tool_result", "status": "error", "error_code": "handoff_invalid"},
                    status="error",
                    content=err,
                    error_code="handoff_invalid",
                    tool_call_id=tool_call_id,
                    data={"errors": handoff_errors},
                )
                await emit_trace_and_push(error_event)
                return (tool_call_id, tool_name, err, "error", "handoff_invalid", {"errors": handoff_errors})

        await emit_trace_and_push(
            build_status_event("Deep planning pipeline running...", "deep_plan_running")
        )

        await consume_deep_plan_gate(orchestrator, str(chat_id))
        if deep_plan_available_holder is not None:
            deep_plan_available_holder[0] = False

        runner = DeepPlanOrchestrator(
            orchestrator,
            chat_id=str(chat_id),
            message_id=request_message_id,
            session_id=synthetic_session_id,
            emit_trace_and_push=emit_trace_and_push,
            build_event=_build_event,
        )
        try:
            status, content, data = await runner.run(action=str(action), payload=payload)
        except asyncio.CancelledError:
            if orchestrator.is_pipeline_abort_requested(str(chat_id)):
                content = "Deep plan aborted by user."
                data = {"error_code": "pipeline_aborted"}
                status = "error"
            else:
                raise
            result_status = "error"
            error_code = (data or {}).get("error_code", "pipeline_aborted")
            result_event = _build_event(
                "tool_result",
                metadata={"phase": "tool_result", "status": result_status, "error_code": error_code},
                status=result_status,
                content=content,
                error_code=error_code,
                tool_call_id=tool_call_id,
                data=data,
            )
            await emit_trace_and_push(result_event)
            raise
        result_status = "success" if status == "success" else "error"
        error_code = None if status == "success" else (data or {}).get("error_code", "pipeline_error")
        result_event = _build_event(
            "tool_result",
            metadata={"phase": "tool_result", "status": result_status, "error_code": error_code},
            status=result_status,
            content=content,
            error_code=error_code,
            tool_call_id=tool_call_id,
            data=data,
        )
        await emit_trace_and_push(result_event)
        return (tool_call_id, tool_name, content, result_status, error_code, data)

    # ── plan_tool ─────────────────────────────────────────────────────────
    if tool_name == "plan_tool":
        action = tool_args.get("action")
        payload = tool_args.get("payload", {})

        tool_event = _build_event(
            "tool_call",
            metadata={"phase": "tool_requested"},
            tool_call_id=tool_call_id,
            tool_name=tool_name,
            args=tool_args,
            session_id=synthetic_session_id,
            chat_id=str(chat_id),
            message_id=request_message_id,
        )
        await emit_trace_and_push(tool_event)

        if action == "revise" and not payload.get("plan_id"):
            result_content = "Error: 'revise' action requires a 'plan_id' in the payload."
            error_event = _build_event("tool_result", metadata={"phase": "tool_result", "status": "error", "error_code": "validation_error"}, status="error", content=result_content, error_code="validation_error", tool_call_id=tool_call_id)
            await emit_trace_and_push(error_event)
            return (tool_call_id, tool_name, result_content, "error", "validation_error", None)

        if action == "present" and payload.get("plan_id"):
            result_content = "Error: 'present' action must NOT include a 'plan_id' in the payload."
            error_event = _build_event("tool_result", metadata={"phase": "tool_result", "status": "error", "error_code": "validation_error"}, status="error", content=result_content, error_code="validation_error", tool_call_id=tool_call_id)
            await emit_trace_and_push(error_event)
            return (tool_call_id, tool_name, result_content, "error", "validation_error", None)

        title = payload.get("title", "Implementation Plan")
        plan_markdown = payload.get("plan_markdown", "")
        new_plan_id = payload.get("plan_id") if action == "revise" else f"plan_{chat_id}_{request_message_id}"

        await emit_trace_and_push(_build_event("plan_permission_request", reason=title, title=title, action=action, plan_id=new_plan_id))

        chunk_size = 4000
        for i in range(0, len(plan_markdown), chunk_size):
            chunk = plan_markdown[i:i + chunk_size]
            await orchestrator.stdio.write_event(chat_id, _build_event("plan_chunk", content=chunk))

        await orchestrator.stdio.write_event(chat_id, _build_event("plan_ready", plan_id=new_plan_id))

        result_content = "Plan presented to user. Waiting for user approval."
        success_event = _build_event("tool_result", metadata={"phase": "tool_result", "status": "success"}, status="success", content=result_content, tool_call_id=tool_call_id)
        await emit_trace_and_push(success_event)
        return (tool_call_id, tool_name, result_content, "success", None, None)

    # ── todo_tool ─────────────────────────────────────────────────────────
    if tool_name == "todo_tool":
        action = tool_args.get("action")
        payload = tool_args.get("payload", {})

        tool_event = _build_event(
            "tool_call",
            metadata={"phase": "tool_requested"},
            tool_call_id=tool_call_id,
            tool_name=tool_name,
            args=tool_args,
            session_id=synthetic_session_id,
            chat_id=str(chat_id),
            message_id=request_message_id,
        )
        await emit_trace_and_push(tool_event)

        todos = payload.get("todos", [])
        if action == "init":
            await emit_trace_and_push(_build_event("todo_init", metadata={"plan_id": payload.get("plan_id"), "items": todos}))
        elif action == "update":
            await emit_trace_and_push(_build_event("todo_update", metadata={"items": todos}))
        elif action == "clear":
            await emit_trace_and_push(_build_event("todo_clear", metadata={}))

        result_content = "Todo list updated successfully."
        success_event = _build_event("tool_result", metadata={"phase": "tool_result", "status": "success"}, status="success", content=result_content, tool_call_id=tool_call_id)
        await emit_trace_and_push(success_event)
        return (tool_call_id, tool_name, result_content, "success", None, None)

    # ── web_search ────────────────────────────────────────────────────────
    if tool_name == "web_search":
        query = tool_args.get("query")
        num_results = tool_args.get("num_results", 5)

        tool_event = _build_event(
            "tool_call",
            metadata={"phase": "tool_requested"},
            tool_call_id=tool_call_id,
            tool_name=tool_name,
            args=tool_args,
            session_id=synthetic_session_id,
            chat_id=str(chat_id),
            message_id=request_message_id,
        )
        await emit_trace_and_push(tool_event)

        logger.info("Executing web_search for query: %s", query)
        await emit_trace_and_push(build_status_event(f"Searching web for '{query}'...", "searching_web"))

        try:
            results_list = await search_web(query, orchestrator.config.exa_key, num_results=num_results)
            result_content = json.dumps(results_list, ensure_ascii=False)
            logger.info("Web search successful for query: %s", query)
            success_event = _build_event("tool_result", metadata={"phase": "tool_result", "status": "success"}, status="success", content="Web search successful", tool_call_id=tool_call_id)
            await emit_trace_and_push(success_event)
            return (tool_call_id, tool_name, result_content, "success", None, None)
        except Exception as e:
            logger.error("Web search failed: %s", e, exc_info=True)
            result_content = f"Web search failed: {str(e)}"
            error_event = _build_event("tool_result", metadata={"phase": "tool_result", "status": "error", "error_code": "search_error"}, status="error", content=result_content, error_code="search_error", tool_call_id=tool_call_id)
            await emit_trace_and_push(error_event)
            return (tool_call_id, tool_name, result_content, "error", "search_error", None)

    # ── spawn_subagent ────────────────────────────────────────────────────
    if tool_name == "spawn_subagent":
        prompt = tool_args.get("prompt")
        task_type = tool_args.get("task_type")
        worktree_path = tool_args.get("worktree_path")

        agent_id = uuid4().hex

        raw_timeout = tool_args.get("timeout", 600)
        try:
            spawn_timeout = int(raw_timeout)
        except (TypeError, ValueError):
            spawn_timeout = 600
        spawn_timeout = min(max(spawn_timeout, 30), 900)

        tool_event = _build_event(
            "tool_call",
            metadata={"phase": "tool_requested", "extension_execute": False},
            tool_call_id=tool_call_id,
            tool_name=tool_name,
            args=tool_args,
            session_id=synthetic_session_id,
            chat_id=str(chat_id),
            message_id=request_message_id,
        )
        await emit_trace_and_push(tool_event)

        logger.info("Spawning subagent %s for task: %s worktree: %s", agent_id, task_type, worktree_path)
        spawning_status = build_status_event(
            f"Starting subagent ({task_type})…",
            "subagent_started",
        )
        spawning_meta = dict(spawning_status.get("metadata") or {})
        spawning_meta.update(
            {
                "subagent_trace": True,
                "subagent_spawn_tool_call_id": tool_call_id,
                "subagent_id": agent_id,
            }
        )
        if task_type:
            spawning_meta["subagent_task_type"] = str(task_type)
        spawning_status["metadata"] = spawning_meta
        await emit_trace_and_push(spawning_status)

        async def subagent_trace_emit(event: dict[str, Any]) -> None:
            """Route nested subagent activity to the parent message trace."""
            event_type = event.get("type")
            metadata = dict(event.get("metadata") or {})
            if event_type not in ("hil_question", "hil_resolved"):
                # Nested runs suppress streamed tokens; surface model-wait status so the
                # panel does not freeze on the last explore row for minutes.
                if event_type == "status" and metadata.get("phase") in {
                    "calling_model",
                    "resuming_after_tool",
                    "preparing_context",
                }:
                    metadata["phase"] = "subagent_progress"
                    if not event.get("content"):
                        event = {**event, "content": "Generating…"}
                metadata["subagent_trace"] = True
                metadata["subagent_id"] = agent_id
                metadata["subagent_spawn_tool_call_id"] = tool_call_id
                if task_type:
                    metadata["subagent_task_type"] = str(task_type)
            parent_event = {
                **event,
                "chat_id": str(chat_id),
                "message_id": request_message_id,
                "session_id": synthetic_session_id,
                "metadata": metadata,
            }
            await emit_trace_and_push(parent_event)

        async def emit_spawn_failure_trace(content: str, error_code: str) -> None:
            fail_event = _build_event(
                "error",
                content=content,
                metadata={
                    "phase": error_code,
                    "subagent_trace": True,
                    "subagent_spawn_tool_call_id": tool_call_id,
                    "subagent_id": agent_id,
                    **({"subagent_task_type": str(task_type)} if task_type else {}),
                },
                session_id=synthetic_session_id,
                chat_id=str(chat_id),
                message_id=request_message_id,
            )
            await emit_trace_and_push(fail_event)

        subagent_session_id = f"sess_{agent_id}"
        try:
            current_depth = context.get("depth", 0)
            if current_depth >= 5:
                raise Exception("Maximum subagent depth of 5 reached.")

            inherited_categories = list(active_categories_holder[0] or [])
            subagent_context: dict[str, Any] = {
                "user_id": user_id,
                "synthetic_session_id": subagent_session_id,
                "request_message_id": f"msg_{uuid4().hex[:12]}",
                "ide_context_enabled": False,
                "workspace_skeleton": req_workspace_skeleton,
                "active_tool_categories": inherited_categories,
                "task_type": task_type,
                "parent_id": str(chat_id),
                "depth": current_depth + 1,
                "ephemeral_run": True,
                "external_trace_emit": subagent_trace_emit,
            }
            if worktree_path:
                subagent_context["worktree_path"] = worktree_path

            subagent_result = await asyncio.wait_for(
                _run_agent_loop_impl(
                    orchestrator,
                    agent_id,
                    str(prompt or ""),
                    subagent_context,
                ),
                timeout=spawn_timeout,
            )

            logger.info("Subagent %s completed.", agent_id)
            success_event = _build_event("tool_result", metadata={"phase": "tool_result", "status": "success"}, status="success", content=f"Subagent finished. Result: {subagent_result}", tool_call_id=tool_call_id)
            await emit_trace_and_push(success_event)
            return (tool_call_id, tool_name, subagent_result, "success", None, None)
        except asyncio.TimeoutError:
            await orchestrator._notify_extension_abort_session_tools(subagent_session_id)
            result_content = (
                f"Subagent timed out after {spawn_timeout}s "
                f"(task_type={task_type!r}). Partial work may exist; do not silently rewrite — "
                f"re-spawn with a higher timeout or a narrower prompt."
            )
            logger.error("Subagent %s timed out after %ss", agent_id, spawn_timeout)
            await emit_spawn_failure_trace(result_content, "subagent_timeout")
            error_event = _build_event(
                "tool_result",
                metadata={"phase": "tool_result", "status": "error", "error_code": "subagent_timeout"},
                status="error",
                content=result_content,
                error_code="subagent_timeout",
                tool_call_id=tool_call_id,
            )
            await emit_trace_and_push(error_event)
            return (tool_call_id, tool_name, result_content, "error", "subagent_timeout", None)
        except asyncio.CancelledError:
            await orchestrator._notify_extension_abort_session_tools(subagent_session_id)
            raise
        except Exception as e:
            logger.error("Subagent %s failed: %s", agent_id, e, exc_info=True)
            result_content = f"Subagent crashed with exception: {str(e)}"
            await emit_spawn_failure_trace(result_content, "subagent_error")
            error_event = _build_event("tool_result", metadata={"phase": "tool_result", "status": "error", "error_code": "subagent_error"}, status="error", content=result_content, error_code="subagent_error", tool_call_id=tool_call_id)
            await emit_trace_and_push(error_event)
            return (tool_call_id, tool_name, result_content, "error", "subagent_error", None)

    # ── workspace_ops / terminal_ops (extension-side tools) ───────────────
    # Emit the tool_call event; the VS Code extension picks it up, executes
    # the tool, and sends back a tool/result notification which is routed
    # into orchestrator.active_tool_queues[tool_call_id] by handle_tool_result.
    tool_event = _build_event(
        "tool_call",
        metadata={"phase": "tool_requested"},
        tool_call_id=tool_call_id,
        tool_name=tool_name,
        args=tool_args,
        session_id=synthetic_session_id,
        chat_id=str(chat_id),
        message_id=request_message_id,
    )
    # Register the result queue before emitting tool_call so fast extension tools
    # (e.g. list_dir) cannot return before the waiter exists.
    tool_result_queue = orchestrator._begin_tool_result_wait(tool_call_id)
    try:
        await emit_trace_and_push(tool_event)
        await emit_trace_and_push(
            build_status_event(
                f"Waiting for {tool_name} result from the extension...",
                "awaiting_tool_result",
            )
        )
        tool_result = await orchestrator._finish_tool_result_wait(
            tool_call_id,
            tool_result_queue,
        )
    except Exception:
        orchestrator.active_tool_queues.pop(tool_call_id, None)
        raise

    if tool_result is None:
        timeout_content = f"Timed out waiting for tool result: {tool_name}"
        logger.error(timeout_content)
        await emit_trace_and_push(
            _build_event(
                "error",
                content=timeout_content,
                metadata={"phase": "tool_timeout"},
                session_id=synthetic_session_id,
                chat_id=str(chat_id),
                message_id=request_message_id,
            )
        )
        return (tool_call_id, tool_name, timeout_content, "error", "tool_timeout", None)

    tool_result_event = _build_event(
        "tool_result",
        metadata={
            "phase": "tool_result",
            "status": tool_result.status,
            "execution_time_ms": tool_result.execution_time_ms,
            "error_code": tool_result.error_code,
        },
        **tool_result.model_dump(),
    )
    await emit_trace_and_push(tool_result_event)
    await emit_trace_and_push(
        build_status_event(
            f"Tool result received from {tool_name}. Continuing reasoning...",
            "tool_result_received",
        )
    )

    return (
        tool_call_id,
        tool_result.tool_name,
        tool_result.content,
        tool_result.status,
        tool_result.error_code,
        None,
    )


async def _run_agent_loop_impl(
    orchestrator: "LLMOrchestrator",
    chat_id: str,
    message: str,
    context: dict,
) -> str:
    user_id = context.get("user_id", "local_user")
    synthetic_session_id = context.get("synthetic_session_id", f"sess_{chat_id}")
    request_message_id = context.get("request_message_id", f"msg_{uuid4().hex[:12]}")
    req_ide_context_enabled = context.get("ide_context_enabled", True)
    ephemeral_run = bool(context.get("ephemeral_run"))
    deep_plan_stage_id = context.get("deep_plan_stage_id")
    deep_plan_pipeline_mode = bool(context.get("deep_plan_pipeline_mode"))
    external_trace_emit = context.get("external_trace_emit")
    req_request_context_raw = context.get("request_context", None)
    req_request_context = req_request_context_raw
    
    req_workspace_skeleton = context.get("workspace_skeleton", None)

    await apply_session_start_flags(
        orchestrator,
        chat_id,
        deep_plan_requested=bool(context.get("deep_plan_requested")) and not ephemeral_run,
    )

    session_state = await read_session_state(orchestrator, chat_id)
    working_memory = session_state.get("working_memory", {}) if isinstance(session_state, dict) else {}
    if context.get("deep_plan_requested"):
        working_memory = {**working_memory, "deep_plan_requested": True}

    state_str = await orchestrator.nats.kv_get("SESSIONS", f"session.{chat_id}")
    existing_active_categories = context.get("active_tool_categories", [])
    existing_tool_memory = {}
    if state_str:
        state = json.loads(state_str)
        if "working_memory" in state and "active_tool_categories" in state["working_memory"]:
            # Merge context inherited categories with session persisted categories
            existing_active_categories = list(dict.fromkeys(existing_active_categories + state["working_memory"]["active_tool_categories"]))
        existing_tool_memory = state.get("working_memory", {}).get("tool_memory", {})
        if isinstance(state.get("working_memory"), dict):
            working_memory = {**working_memory, **state["working_memory"]}

    if not ephemeral_run:
        await orchestrator.file_store.append_message(
            chat_id, "user", message, message_id=request_message_id
        )
        history_raw = await orchestrator.file_store.read_messages(chat_id)
    else:
        history_raw = []

    llm_messages = []
    for m in history_raw:
        content = m.get("content")
        role = m.get("role")
        if not content:
            content = "[Executed workspace tools]" if role == "assistant" else "[Empty message]"
        llm_messages.append({"role": role, "content": content})
    request_context_message = _build_request_context_message(req_request_context)
    tool_memory_message = format_tool_memory_for_prompt(existing_tool_memory)

    # Build guidance from already-loaded categories for this session
    active_tool_guidance: str | None = build_injected_guidance(existing_active_categories) or None

    system_context_messages: list[dict[str, str]] = []
    if request_context_message:
        system_context_messages.append({"role": "system", "content": request_context_message})
    if tool_memory_message:
        system_context_messages.append({"role": "system", "content": tool_memory_message})
        
    task_type = context.get("task_type")
    if task_type and deep_plan_pipeline_mode:
        system_context_messages.append({
            "role": "system",
            "content": (
                f"Task: {task_type}\n"
                "You are Vertex orchestrating the deep plan pipeline. "
                "Use run_planning_stage tool calls only."
            ),
        })
    elif task_type:
        inherited = existing_active_categories or []
        inherit_note = (
            f"Already loaded tool categories (do NOT call load_tool_context for these): {', '.join(inherited)}.\n"
            if inherited
            else ""
        )
        system_context_messages.append({
            "role": "system",
            "content": (
                f"Task Category: {task_type}\n"
                "You are running as a specialized subagent focusing on this specific task type. "
                "Focus ONLY on this task. Use tools to produce the deliverable (read and write as needed). "
                "Return your final comprehensive result to the parent orchestrator when complete.\n"
                f"{inherit_note}"
                "Do not narrate plans without calling tools. Prefer writing the deliverable over long prose."
            ),
        })

    stage_system_preamble = context.get("stage_system_preamble")
    if isinstance(stage_system_preamble, str) and stage_system_preamble.strip():
        system_context_messages.append({
            "role": "system",
            "content": stage_system_preamble.strip(),
        })

    worktree_path = context.get("worktree_path")
    if worktree_path:
        system_context_messages.append({
            "role": "system",
            "content": (
                f"Worktree Root: {worktree_path}\n"
                "You are operating inside a dedicated git worktree. ALL file read/write operations "
                "MUST be scoped to this path. Do not access files outside this root."
            ),
        })

    deep_plan_gate_open = (
        not ephemeral_run
        and not deep_plan_stage_id
        and not deep_plan_pipeline_mode
        and resolve_deep_plan_gate(
            working_memory,
            this_turn_deep_plan_requested=bool(context.get("deep_plan_requested")),
        )
    )
    if deep_plan_gate_open:
        system_context_messages.append({
            "role": "system",
            "content": (
                "DEEP PLAN GATE OPEN (requirement phase): You remain Vertex. Req-extraction instructions "
                "are in your system context. Explore the repo (load workspace_ops, hil_tool, web_search). "
                "Write plan_pipeline/01_requirements.md and plan_pipeline/00_pipeline_manifest.json "
                "before calling deep_plan_tool(start). Do NOT call deep_plan_tool until both files exist. "
                "Do NOT use plan_tool for this path."
            ),
        })

    if system_context_messages:
        llm_messages = [
            *system_context_messages,
            *llm_messages,
        ]

    if ephemeral_run and (message or "").strip():
        llm_messages.append({"role": "user", "content": message})

    if tool_memory_message:
        mutation_count = len(existing_tool_memory.get("completed_mutations", [])) if isinstance(existing_tool_memory, dict) else 0
        logger.info(
            "tool memory injected user_id=%s chat_id=%s session_id=%s message_id=%s mutation_count=%s",
            user_id,
            chat_id,
            synthetic_session_id,
            request_message_id,
            mutation_count,
        )

    logger.info(
        "context loaded chat_id=%s message_id=%s history_messages=%s",
        chat_id,
        request_message_id,
        len(llm_messages),
    )

    full_response = ""
    trace_events: list[dict[str, Any]] = []
    run_failed = False
    llm_round = 0
    in_plan_mode = False
    plan_buffer = ""

    async def push_event(event: dict[str, Any]) -> None:
        await orchestrator.stdio.write_event(chat_id, event)
        
    async def emit_trace_and_push(event: dict[str, Any]) -> None:
        if not external_trace_emit:
            trace_events.append(event)
        _log_trace_event(
            user_id,
            chat_id,
            synthetic_session_id,
            request_message_id,
            event,
        )
        if external_trace_emit:
            await external_trace_emit(event)
        else:
            await push_event(event)

    def build_status_event(content: str, phase: str) -> dict[str, Any]:
        return _build_event(
            "status",
            content=content,
            metadata={"phase": phase},
            session_id=synthetic_session_id,
            chat_id=str(chat_id),
            message_id=request_message_id,
        )

    # Holders allow _execute_tool_call (running concurrently via gather) to
    # read and update shared guidance state without needing class-level locks.
    # load_tool_context is the only writer; it is never called in parallel
    # with itself because the LLM will only call it once per turn.
    active_tool_guidance_holder: list[str | None] = [active_tool_guidance]
    active_categories_holder: list[list[str]] = [existing_active_categories]
    deep_plan_available_holder: list[bool] = [
        False
        if ephemeral_run or deep_plan_stage_id or deep_plan_pipeline_mode
        else resolve_deep_plan_gate(
            working_memory,
            this_turn_deep_plan_requested=bool(context.get("deep_plan_requested")),
        )
    ]
    deep_plan_pipeline_mode_holder: list[bool] = [deep_plan_pipeline_mode]

    if bool(context.get("deep_plan_requested")) and not ephemeral_run and not deep_plan_stage_id:
        title_guess = (message or "").strip()[:120] or "Deep plan"
        await emit_trace_and_push(
            _build_event(
                "deep_plan_mode_active",
                metadata={
                    "trigger": "user_slash",
                    "phase": "requirement_extraction",
                    "stage_label": "Requirement extraction",
                },
                chat_id=str(chat_id),
                message_id=request_message_id,
            )
        )
        await emit_trace_and_push(
            _build_event(
                "deep_plan_started",
                metadata={
                    "trigger": "user_slash",
                    "phase": "requirement_extraction",
                    "stage_id": "requirement_extraction",
                    "title": title_guess,
                },
                chat_id=str(chat_id),
                message_id=request_message_id,
            )
        )
        await emit_trace_and_push(
            _build_event(
                "deep_plan_stage_status",
                metadata={
                    "stage_id": "requirement_extraction",
                    "status": "running",
                    "label": "Requirement extraction",
                },
                chat_id=str(chat_id),
                message_id=request_message_id,
            )
        )
    elif (
        not ephemeral_run
        and not deep_plan_stage_id
        and is_deep_plan_available(working_memory)
        and read_deep_plan_phase(working_memory) == "req"
    ):
        ui_trigger = (
            "vertex_hil" if working_memory.get(DEEP_PLAN_CONFIRMED_KEY) else "user_slash"
        )
        await emit_trace_and_push(
            _build_event(
                "deep_plan_mode_active",
                metadata={
                    "trigger": ui_trigger,
                    "phase": "requirement_extraction",
                    "stage_label": "Requirement extraction",
                },
                chat_id=str(chat_id),
                message_id=request_message_id,
            )
        )

    profiler = TokenProfiler(request_message_id)
    profiler.log_constant("dev_persona", DEVELOPER_ASSISTANT_PERSONA)
    profiler.log_constant(
        "tool_schemas",
        json.dumps(build_tools_list(existing_active_categories, deep_plan_available=deep_plan_available_holder[0])),
    )
    profiler.log_constant("ide_context", request_context_message)
    profiler.log_constant("workspace_skeleton", req_workspace_skeleton)
    profiler.log_constant("tool_memory", tool_memory_message)
    profiler.log_constant("active_tool_guidance", active_tool_guidance)

    try:
        await emit_trace_and_push(build_status_event("Preparing conversation context...", "preparing_context"))

        while True:
            llm_round += 1

            if deep_plan_pipeline_mode and orchestrator.is_pipeline_abort_requested(str(chat_id)):
                run_failed = True
                await emit_trace_and_push(
                    _build_event(
                        "status",
                        content="Deep plan pipeline aborted by user.",
                        metadata={"phase": "deep_plan_aborted"},
                        session_id=synthetic_session_id,
                        chat_id=str(chat_id),
                        message_id=request_message_id,
                    )
                )
                raise asyncio.CancelledError()

            if deep_plan_stage_id and orchestrator.is_pipeline_abort_requested(str(chat_id)):
                run_failed = True
                await emit_trace_and_push(
                    _build_event(
                        "status",
                        content="Deep plan pipeline aborted by user.",
                        metadata={"phase": "deep_plan_aborted", "stage_id": deep_plan_stage_id},
                        session_id=synthetic_session_id,
                        chat_id=str(chat_id),
                        message_id=request_message_id,
                    )
                )
                raise asyncio.CancelledError()

            if deep_plan_pipeline_mode:
                from app.services.deep_plan.constants import MAX_DEEP_PLAN_PIPELINE_LLM_ROUNDS

                max_pipeline_rounds = int(
                    context.get("max_pipeline_llm_rounds", MAX_DEEP_PLAN_PIPELINE_LLM_ROUNDS)
                )
                if llm_round > max_pipeline_rounds:
                    run_failed = True
                    await emit_trace_and_push(
                        _build_event(
                            "error",
                            content=(
                                f"Deep plan pipeline orchestration exceeded {max_pipeline_rounds} "
                                "LLM rounds. Stop retrying and report the last tool error."
                            ),
                            metadata={"phase": "pipeline_round_limit", "error_code": "pipeline_round_limit"},
                            session_id=synthetic_session_id,
                            chat_id=str(chat_id),
                            message_id=request_message_id,
                        )
                    )
                    break

            for completion in orchestrator.drain_job_completions(chat_id):
                llm_messages.append(_build_job_completion_message(completion))

            assistant_turn_content = ""
            assistant_reasoning_content = ""
            tool_call_requested = False
            stream_aborted = False

            status_text = (
                f"Calling model {orchestrator.config.llm_model}..."
                if llm_round == 1
                else "Continuing with tool result..."
            )
            status_phase = "calling_model" if llm_round == 1 else "resuming_after_tool"
            await emit_trace_and_push(build_status_event(status_text, status_phase))

            llm_context_log_base = {
                "user_id": user_id,
                "chat_id": str(chat_id),
                "session_id": synthetic_session_id,
                "message_id": request_message_id,
                "llm_round": llm_round,
                "ide_context_enabled": req_ide_context_enabled,
                "workspace_skeleton_included": bool(req_workspace_skeleton),
                "workspace_skeleton_len": len(req_workspace_skeleton) if req_workspace_skeleton else 0,
                "request_context_included": bool(req_request_context),
                "llm_message_count": len(llm_messages),
                "last_message_role": llm_messages[-1].get("role") if llm_messages else None,
            }

            profiler.log_payload_snapshot(llm_round, llm_messages)

            # Try primary model, fallback to secondary on rate limit
            try:
                stream_iterator = stream_chat_events(
                    llm_messages,
                    config=orchestrator.config,
                    workspace_skeleton=req_workspace_skeleton,
                    context_log_metadata={
                        **llm_context_log_base,
                        "model": orchestrator.config.llm_model,
                        "is_fallback": False,
                    },
                    active_tool_guidance=active_tool_guidance_holder[0],
                    active_categories=active_categories_holder[0],
                    deep_plan_available=deep_plan_available_holder[0],
                    deep_plan_pipeline_mode=deep_plan_pipeline_mode_holder[0],
                )
            except RateLimitError:
                logger.warning(
                    "Primary model rate-limited, switching to fallback user_id=%s chat_id=%s session_id=%s message_id=%s primary=%s fallback=%s",
                    user_id,
                    chat_id,
                    synthetic_session_id,
                    request_message_id,
                    orchestrator.config.llm_model,
                    orchestrator.config.llm_fallback_model,
                )
                await emit_trace_and_push(build_status_event("Primary model rate-limited, switching to fallback...", "fallback_model"))
                stream_iterator = stream_chat_events(
                    llm_messages,
                    config=orchestrator.config,
                    workspace_skeleton=req_workspace_skeleton,
                    model=orchestrator.config.llm_fallback_model,
                    context_log_metadata={
                        **llm_context_log_base,
                        "model": orchestrator.config.llm_fallback_model,
                        "is_fallback": True,
                    },
                    active_tool_guidance=active_tool_guidance_holder[0],
                    active_categories=active_categories_holder[0],
                    deep_plan_available=deep_plan_available_holder[0],
                    deep_plan_pipeline_mode=deep_plan_pipeline_mode_holder[0],
                )

            # ── Phase 1: drain the full LLM stream ────────────────────────────────
            # Collect ALL tool_call events before executing any of them.
            collected_tool_calls: list[dict[str, Any]] = []

            try:
                async for event in stream_iterator:
                    event_type = event.get("type")

                    if event_type == "usage":
                        usage_content = event.get("content")
                        if isinstance(usage_content, dict):
                            profiler.log_api_usage(llm_round, usage_content)
                        continue

                    if event_type == "token":
                        token = str(event.get("content", ""))
                        if not token:
                            continue

                        if in_plan_mode:
                            plan_buffer += token
                            await push_event(_build_event("plan_chunk", content=token))
                            continue

                        assistant_turn_content += token
                        full_response += token
                        if not external_trace_emit:
                            await push_event(
                                _build_event(
                                    "token",
                                    content=token,
                                    metadata={"phase": "assistant_output"},
                                )
                            )
                        continue

                    if event_type == "thinking":
                        thinking_content = str(event.get("content", ""))
                        if not thinking_content:
                            continue

                        assistant_reasoning_content += thinking_content

                        if not thinking_content.strip():
                            continue

                        await emit_trace_and_push(_build_event("thinking", content=thinking_content, metadata={"phase": "reasoning"}, session_id=synthetic_session_id, chat_id=str(chat_id), message_id=request_message_id))
                        continue

                    if event_type == "tool_call":
                        tool_name_evt = event.get("tool_name")
                        tool_call_id_evt = event.get("tool_call_id")
                        tool_args_evt = event.get("args")

                        if not isinstance(tool_name_evt, str) or not isinstance(tool_call_id_evt, str):
                            logger.warning("Skipping malformed tool_call event: %s", event)
                            continue
                        
                        collected_tool_calls.append({
                            "tool_name": tool_name_evt,
                            "tool_call_id": tool_call_id_evt,
                            "args": tool_args_evt,
                        })
                        continue

                if stream_aborted:
                    break

            except Exception as stream_exc:
                error_details = str(stream_exc)
                if isinstance(stream_exc, APIError):
                    logger.error(
                        "LLM stream API error for chat %s: message=%s type=%s code=%s body=%s",
                        chat_id,
                        stream_exc.message,
                        stream_exc.type,
                        stream_exc.code,
                        json.dumps(stream_exc.body) if stream_exc.body else None,
                        exc_info=True,
                    )
                    error_details = stream_exc.message or error_details
                else:
                    logger.error("LLM stream error for chat %s:\n%s", chat_id, stream_exc, exc_info=True)
                if not orchestrator.config.llm_key.strip():
                    error_details = "LLM API key is missing. Open Settings and configure your provider key."
                run_failed = True
                stream_aborted = True
                await emit_trace_and_push(
                    _build_event(
                        "error",
                        content=f"LLM stream failed: {error_details}",
                        metadata={"phase": "stream_error"},
                        session_id=synthetic_session_id,
                        chat_id=str(chat_id),
                        message_id=request_message_id,
                    )
                )

            if stream_aborted:
                break

            # ── Phase 2: execute all collected tool calls concurrently ────────────
            if collected_tool_calls:
                logger.info(
                    "executing %d tool call(s) concurrently user_id=%s chat_id=%s llm_round=%s tools=%s",
                    len(collected_tool_calls),
                    user_id,
                    chat_id,
                    llm_round,
                    [c.get("tool_name") for c in collected_tool_calls],
                )

                # Sync updated guidance/categories back from holders after each turn
                # (load_tool_context may have updated them during this round)
                existing_active_categories = active_categories_holder[0]
                active_tool_guidance = active_tool_guidance_holder[0]

                # Build the single assistant message that carries ALL tool calls
                llm_messages.append(
                    _assistant_tool_call_message_multi(
                        assistant_turn_content,
                        collected_tool_calls,
                        assistant_reasoning_content,
                    )
                )

                # load_tool_context must run before other tools in the same turn
                # so loaded categories are visible to parallel execution tools.
                # hil_tool blocks on user input — never run it in parallel with other tools.
                async def _invoke_tool_call(call: dict[str, Any]):
                    return await _execute_tool_call(
                        orchestrator,
                        call,
                        user_id=user_id,
                        chat_id=chat_id,
                        synthetic_session_id=synthetic_session_id,
                        request_message_id=request_message_id,
                        req_workspace_skeleton=req_workspace_skeleton,
                        existing_active_categories=existing_active_categories,
                        context=context,
                        emit_trace_and_push=emit_trace_and_push,
                        build_status_event=build_status_event,
                        active_tool_guidance_holder=active_tool_guidance_holder,
                        active_categories_holder=active_categories_holder,
                        deep_plan_available_holder=deep_plan_available_holder,
                    )

                load_calls = [c for c in collected_tool_calls if _is_load_tool_context_call(c)]
                hil_calls = [c for c in collected_tool_calls if _is_hil_tool_call(c)]
                planning_stage_calls = [
                    c for c in collected_tool_calls if _is_run_planning_stage_call(c)
                ]
                deep_plan_calls = [c for c in collected_tool_calls if _is_deep_plan_tool_call(c)]
                other_calls = [
                    c
                    for c in collected_tool_calls
                    if not _is_load_tool_context_call(c)
                    and not _is_hil_tool_call(c)
                    and not _is_run_planning_stage_call(c)
                    and not _is_deep_plan_tool_call(c)
                ]

                results_by_id: dict[str, Any] = {}
                for call in load_calls:
                    results_by_id[call["tool_call_id"]] = await _invoke_tool_call(call)

                if planning_stage_calls:
                    from app.services.deep_plan.constants import PARALLEL_SPAWN_STAGGER_SECONDS

                    stagger_tasks: list[asyncio.Task] = []
                    for index, call in enumerate(planning_stage_calls):
                        if index > 0:
                            await asyncio.sleep(PARALLEL_SPAWN_STAGGER_SECONDS)
                        stagger_tasks.append(
                            asyncio.create_task(_invoke_tool_call(call))
                        )
                    stagger_results = await asyncio.gather(
                        *stagger_tasks,
                        return_exceptions=True,
                    )
                    for call, raw_result in zip(planning_stage_calls, stagger_results):
                        results_by_id[call["tool_call_id"]] = raw_result

                if other_calls:
                    other_results = await asyncio.gather(
                        *[_invoke_tool_call(call) for call in other_calls],
                        return_exceptions=True,
                    )
                    for call, raw_result in zip(other_calls, other_results):
                        results_by_id[call["tool_call_id"]] = raw_result

                for call in hil_calls:
                    results_by_id[call["tool_call_id"]] = await _invoke_tool_call(call)

                for call in deep_plan_calls:
                    results_by_id[call["tool_call_id"]] = await _invoke_tool_call(call)

                gather_results = [results_by_id[call["tool_call_id"]] for call in collected_tool_calls]

                # Append one tool-role message per result
                for call, raw_result in zip(collected_tool_calls, gather_results):
                    tc_id = call["tool_call_id"]
                    tc_name = call["tool_name"]

                    if isinstance(raw_result, BaseException):
                        # Unhandled exception from within _execute_tool_call
                        logger.error(
                            "Unhandled exception from tool %s tool_call_id=%s: %s",
                            tc_name, tc_id, raw_result, exc_info=raw_result,
                        )
                        result_content = f"Tool {tc_name} failed with unhandled exception: {raw_result}"
                        llm_messages.append({
                            "role": "tool",
                            "tool_call_id": tc_id,
                            "content": format_tool_response(
                                tool_status="error",
                                tool_content=result_content,
                                error_code="unhandled_exception",
                            ),
                        })
                    else:
                        # raw_result is (tool_call_id, tool_name, content, status, error_code, tool_data)
                        _tc_id, _tc_name, content, status, error_code, tool_data = raw_result
                        profiler.log_turn(llm_round, f"tool_output_{_tc_name}", content)
                        llm_messages.append({
                            "role": "tool",
                            "tool_call_id": tc_id,
                            "content": format_tool_response(
                                tool_status=status,
                                tool_content=content,
                                error_code=error_code,
                                tool_data=tool_data,
                            ),
                        })

                # Sync guidance holders back after all tools have run
                existing_active_categories = active_categories_holder[0]
                active_tool_guidance = active_tool_guidance_holder[0]

                profiler.log_turn(llm_round, "assistant_answer", assistant_turn_content)
                profiler.log_turn(llm_round, "assistant_reasoning", assistant_reasoning_content)
                tool_call_requested = True

            if tool_call_requested:
                logger.info(
                    "resuming llm user_id=%s chat_id=%s session_id=%s message_id=%s",
                    user_id,
                    chat_id,
                    synthetic_session_id,
                    request_message_id,
                )
                continue

            if not assistant_turn_content.strip():
                assistant_turn_content = "[Internal system note: the model returned an empty text response or only emitted state tags.]"

            llm_messages.append(
                {
                    "role": "assistant",
                    "content": assistant_turn_content,
                }
            )

            if assistant_turn_content.startswith("[Internal system note"):
                run_failed = True
                empty_response_message = (
                    "Model stream completed without a final assistant answer after tool execution."
                    if llm_round > 1
                    else "Model stream completed without a visible assistant answer."
                )
                await emit_trace_and_push(
                    _build_event(
                        "error",
                        content=empty_response_message,
                        metadata={"phase": "empty_response"},
                        session_id=synthetic_session_id,
                        chat_id=str(chat_id),
                        message_id=request_message_id,
                    )
                )
            else:
                profiler.log_turn(llm_round, "assistant_answer", assistant_turn_content)
                profiler.log_turn(llm_round, "assistant_reasoning", assistant_reasoning_content)
                # Nested runs suppress streaming tokens; emit the final answer into the
                # external trace so AgentTracePanel / worker panels show the conclusion.
                if external_trace_emit and assistant_turn_content.strip():
                    await emit_trace_and_push(
                        _build_event(
                            "output",
                            content=assistant_turn_content.strip(),
                            metadata={"appendMode": "block", "phase": "assistant_output"},
                            session_id=synthetic_session_id,
                            chat_id=str(chat_id),
                            message_id=request_message_id,
                        )
                    )
                await emit_trace_and_push(build_status_event("Final answer ready.", "completed"))

            pending_completions = orchestrator.drain_job_completions(chat_id)
            if pending_completions:
                for completion in pending_completions:
                    llm_messages.append(_build_job_completion_message(completion))
                continue

            break
    except asyncio.CancelledError:
        nested_run = ephemeral_run or deep_plan_pipeline_mode or bool(deep_plan_stage_id)
        if nested_run:
            raise
        run_failed = True
        logger.info("Agent loop cancelled for chat %s", chat_id)
        if orchestrator.is_pipeline_abort_requested(str(chat_id)):
            await emit_trace_and_push(
                _build_event(
                    "status",
                    content="Deep plan aborted by user.",
                    metadata={"phase": "deep_plan_aborted"},
                    session_id=synthetic_session_id,
                    chat_id=str(chat_id),
                    message_id=request_message_id,
                )
            )
            orchestrator.clear_pipeline_abort(str(chat_id))
        else:
            await emit_trace_and_push(
                _build_event(
                    "status",
                    content="User cancelled the operation.",
                    metadata={"phase": "cancelled", "cancelledBy": "user"},
                    session_id=synthetic_session_id,
                    chat_id=str(chat_id),
                    message_id=request_message_id,
                )
            )
        # Do NOT re-raise so we fall through and persist the partial response/trace to DB
    except Exception as exc:
        run_failed = True
        error_details = str(exc)
        
        # Log provider error details for debugging
        if isinstance(exc, APIError):
            logger.error(
                "LLM stream API error for chat %s: message=%s type=%s code=%s body=%s provider_request_headers=%s",
                chat_id,
                exc.message,
                exc.type,
                exc.code,
                json.dumps(exc.body) if exc.body else None,
                exc.request.headers if exc.request else None,
                exc_info=True,
            )
            # Log the request payload that was sent
            logger.error(
                "Request payload for failed chat %s llm_round=%s: messages_count=%s last_message_role=%s workspace_skeleton_len=%s",
                chat_id,
                llm_round,
                len(llm_messages),
                llm_messages[-1].get("role") if llm_messages else None,
                len(req_workspace_skeleton) if req_workspace_skeleton else 0,
            )
        else:
            logger.error("LLM stream error for chat %s: %s", chat_id, error_details, exc_info=True)
        
        await emit_trace_and_push(
            _build_event(
                "error",
                content=f"LLM stream failed: {error_details}",
                metadata={"phase": "stream_exception"},
                session_id=synthetic_session_id,
                chat_id=str(chat_id),
                message_id=request_message_id,
            )
        )

    if not ephemeral_run:
        await orchestrator.file_store.append_message(
            chat_id,
            "assistant",
            full_response,
            events=trace_events,
            message_id=f"msg_{uuid4().hex[:12]}",
            turn_duration_ms=_compute_turn_duration_ms(trace_events),
        )

    logger.info(
        "final response completed user_id=%s chat_id=%s session_id=%s message_id=%s failed=%s trace_events=%s response_chars=%s response_preview=%s",
        user_id,
        chat_id,
        synthetic_session_id,
        request_message_id,
        run_failed,
        len(trace_events),
        len(full_response),
        _preview(full_response) if full_response else "",
    )

    if not ephemeral_run:
        try:
            state_str = await orchestrator.nats.kv_get("SESSIONS", f"session.{chat_id}")
            if not state_str:
                logger.warning(
                    "tool memory persistence skipped session missing user_id=%s chat_id=%s session_id=%s message_id=%s",
                    user_id,
                    chat_id,
                    synthetic_session_id,
                    request_message_id,
                )
            else:
                state = json.loads(state_str)
                if "working_memory" not in state:
                    state["working_memory"] = {}
                previous_tool_memory = state["working_memory"].get("tool_memory")
                updated_tool_memory = build_tool_memory_from_trace_events(
                    previous_tool_memory, trace_events
                )
                state["working_memory"]["tool_memory"] = updated_tool_memory
                await orchestrator.nats.kv_set(
                    "SESSIONS", f"session.{chat_id}", json.dumps(state)
                )
                await orchestrator.file_store.write_session(chat_id, state)

                logger.info(
                    "tool memory persisted user_id=%s chat_id=%s session_id=%s message_id=%s mutation_count=%s",
                    user_id,
                    chat_id,
                    synthetic_session_id,
                    request_message_id,
                    len(updated_tool_memory.get("completed_mutations", [])),
                )
        except Exception:
            logger.exception(
                "tool memory persistence failed user_id=%s chat_id=%s session_id=%s message_id=%s",
                user_id,
                chat_id,
                synthetic_session_id,
                request_message_id,
            )

    profiler.dump(str(orchestrator.file_store.chats_path / chat_id / "logs"))
    if not ephemeral_run:
        try:
            await push_event({"type": "done", "messageId": request_message_id})
        except Exception:
            logger.exception("Failed to push done event")

    return full_response

