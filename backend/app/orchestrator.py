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
from app.services.prompt_loader import build_injected_guidance, load_categories, SUPPORTED_CATEGORIES
from app.services.websearch import search_web
from app.utils.token_profiler import TokenProfiler
from app.services.llm_service import DEVELOPER_ASSISTANT_PERSONA
from app.services.tool_schemas import WORKSPACE_OPS_TOOL_SPEC, TERMINAL_OPS_TOOL_SPEC, LOAD_TOOL_CONTEXT_TOOL_SPEC, PLAN_TOOL_SPEC, TODO_TOOL_SPEC, WEB_SEARCH_TOOL_SPEC
logger = logging.getLogger(__name__)


class LLMOrchestrator:
    def __init__(self, config: WorkerConfig, nats: NATSClient):
        self.config = config
        self.nats = nats
        self.file_store = FileStore(config.base_path)
        self.stdio = StdioTransport()
        self.active_tool_queues: dict[str, asyncio.Queue] = {}

    async def _wait_for_tool_result(
        self,
        tool_call_id: str,
        timeout_seconds: int = 360,
    ) -> ToolResultSchema | None:
        queue = asyncio.Queue()
        self.active_tool_queues[tool_call_id] = queue
        try:
            return await asyncio.wait_for(queue.get(), timeout=timeout_seconds)
        except asyncio.TimeoutError:
            return None
        finally:
            self.active_tool_queues.pop(tool_call_id, None)

    async def handle_tool_result(self, result: ToolResultSchema) -> None:
        tool_call_id = result.tool_call_id
        if tool_call_id in self.active_tool_queues:
            await self.active_tool_queues[tool_call_id].put(result)
        else:
            logger.warning(f"Received tool result for unknown tool_call_id: {tool_call_id}")

    async def spawn_subagent(self, prompt: str, task_type: str, timeout: int, depth: int) -> str:
        reply = await self.nats.request(
            "spawn.request",
            {"prompt": prompt, "task_type": task_type, "timeout": timeout, "depth": depth},
            timeout=5.0
        )
        response = json.loads(reply.data)
        return response["agent_id"]

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


def _preview(value: str, limit: int = 180) -> str:
    normalized = " ".join(value.split())
    if len(normalized) <= limit:
        return normalized
    return f"{normalized[: limit - 3]}..."


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



async def _run_agent_loop_impl(
    orchestrator: LLMOrchestrator,
    chat_id: str,
    message: str,
    context: dict,
):
    user_id = context.get("user_id", "local_user")
    synthetic_session_id = context.get("synthetic_session_id", f"sess_{chat_id}")
    request_message_id = context.get("request_message_id", f"msg_{uuid4().hex[:12]}")
    req_ide_context_enabled = context.get("ide_context_enabled", True)
    
    req_request_context_raw = context.get("request_context", None)
    req_request_context = req_request_context_raw
    
    req_workspace_skeleton = context.get("workspace_skeleton", None)
    
    state_str = await orchestrator.nats.kv_get("SESSIONS", f"session.{chat_id}")
    existing_active_categories = []
    existing_tool_memory = {}
    if state_str:
        state = json.loads(state_str)
        existing_active_categories = state.get("working_memory", {}).get("active_tool_categories", [])
        existing_tool_memory = state.get("working_memory", {})

    await orchestrator.file_store.append_message(chat_id, "user", message)
    history_raw = await orchestrator.file_store.read_messages(chat_id)

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

    if system_context_messages:
        llm_messages = [
            *system_context_messages,
            *llm_messages,
        ]

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
        trace_events.append(event)
        _log_trace_event(
            user_id,
            chat_id,
            synthetic_session_id,
            request_message_id,
            event,
        )
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

    profiler = TokenProfiler(request_message_id)
    profiler.log_constant("dev_persona", DEVELOPER_ASSISTANT_PERSONA)
    profiler.log_constant("tool_schemas", json.dumps([
        WORKSPACE_OPS_TOOL_SPEC, 
        TERMINAL_OPS_TOOL_SPEC, 
        LOAD_TOOL_CONTEXT_TOOL_SPEC,
        PLAN_TOOL_SPEC,
        TODO_TOOL_SPEC,
        WEB_SEARCH_TOOL_SPEC
    ]))
    profiler.log_constant("ide_context", request_context_message)
    profiler.log_constant("workspace_skeleton", req_workspace_skeleton)
    profiler.log_constant("tool_memory", tool_memory_message)
    profiler.log_constant("active_tool_guidance", active_tool_guidance)

    try:
        await emit_trace_and_push(build_status_event("Preparing conversation context...", "preparing_context"))

        while True:
            llm_round += 1
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
                    active_tool_guidance=active_tool_guidance,
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
                await emit_trace_and_push(
                    build_status_event(
                        f"Primary model rate-limited, switching to fallback...",
                        "fallback_model",
                    )
                )
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
                    active_tool_guidance=active_tool_guidance,
                )

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

                        await emit_trace_and_push(
                            _build_event(
                                "thinking",
                                content=thinking_content,
                                metadata={"phase": "reasoning"},
                                session_id=synthetic_session_id,
                                chat_id=str(chat_id),
                                message_id=request_message_id,
                            )
                        )
                        continue

                    if event_type == "tool_call":
                        tool_name = event.get("tool_name")
                        tool_call_id = event.get("tool_call_id")
                        tool_args = event.get("args")

                        if not isinstance(tool_name, str) or not isinstance(tool_call_id, str):
                            logger.warning("Skipping malformed tool_call event: %s", event)
                            continue

                        if not isinstance(tool_args, dict):
                            tool_args = {}

                        # ΓöÇΓöÇ load_tool_context interception ΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇ
                        # This tool is handled entirely on the backend.
                        # No round-trip to the extension needed.
                        # Some models hallucinate a dotted variant; normalise it here.
                        if tool_name in ("load_tool_context", "workspace_ops.load_tool_context"):
                            requested = tool_args.get("categories", [])
                            if not isinstance(requested, list):
                                requested = []
                            valid = [c for c in requested if c in SUPPORTED_CATEGORIES]

                            # Load and persist new categories into session
                            loaded_prose = load_categories(valid)
                            newly_loaded = list(loaded_prose.keys())

                            # Merge with already-active categories
                            merged = list(dict.fromkeys(existing_active_categories + newly_loaded))
                            existing_active_categories = merged
                            active_tool_guidance = build_injected_guidance(merged) or None

                            # Persist to NATS and FileStore immediately so next turn auto-injects
                            try:
                                state_str = await orchestrator.nats.kv_get("SESSIONS", f"session.{chat_id}")
                                if state_str:
                                    state = json.loads(state_str)
                                    if "working_memory" not in state: state["working_memory"] = {}
                                    state["working_memory"]["active_tool_categories"] = merged
                                    await orchestrator.nats.kv_set("SESSIONS", f"session.{chat_id}", json.dumps(state))
                                    await orchestrator.file_store.write_session(chat_id, state)
                            except Exception:
                                logger.exception("Failed to persist active_tool_categories session_id=%s", synthetic_session_id)

                            # Emit ephemeral UI notification
                            if newly_loaded:
                                label = ", ".join(c.replace("_", " ").title() for c in newly_loaded)
                                await emit_trace_and_push(
                                    build_status_event(
                                        f"Loaded {label} guidance",
                                        "tool_context_loaded",
                                    )
                                )

                            # Build a combined prose result to give to the LLM
                            combined_prose = "\n\n---\n\n".join(loaded_prose.values())
                            result_content = (
                                f"Tool guidance loaded for: {', '.join(newly_loaded)}.\n\n{combined_prose}"
                                if newly_loaded
                                else f"No new categories loaded. Already active: {', '.join(existing_active_categories) or 'none'}."
                            )

                            llm_messages.append(
                                _assistant_tool_call_message(
                                    assistant_turn_content,
                                    tool_name,
                                    tool_call_id,
                                    tool_args,
                                    assistant_reasoning_content,
                                )
                            )
                            llm_messages.append(
                                {
                                    "role": "tool",
                                    "tool_call_id": tool_call_id,
                                    "content": format_tool_response(
                                         tool_status="success",
                                         tool_content=result_content,
                                     ),
                                }
                            )
                            tool_call_requested = True
                            break
                        # ΓöÇΓöÇ end load_tool_context ΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇ

                        # ΓöÇΓöÇ plan_tool interception ΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇ
                        if tool_name == "plan_tool":
                            action = tool_args.get("action")
                            payload = tool_args.get("payload", {})
                            
                            # 1. Emit tool_call to trace so UI shows the accordion
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
                                llm_messages.append(_assistant_tool_call_message(assistant_turn_content, tool_name, tool_call_id, tool_args, assistant_reasoning_content))
                                llm_messages.append({"role": "tool", "tool_call_id": tool_call_id, "content": format_tool_response(tool_status="error", tool_content=result_content, error_code="validation_error")})
                                tool_call_requested = True
                                break
                            elif action == "present" and payload.get("plan_id"):
                                result_content = "Error: 'present' action must NOT include a 'plan_id' in the payload."
                                error_event = _build_event("tool_result", metadata={"phase": "tool_result", "status": "error", "error_code": "validation_error"}, status="error", content=result_content, error_code="validation_error", tool_call_id=tool_call_id)
                                await emit_trace_and_push(error_event)
                                llm_messages.append(_assistant_tool_call_message(assistant_turn_content, tool_name, tool_call_id, tool_args, assistant_reasoning_content))
                                llm_messages.append({"role": "tool", "tool_call_id": tool_call_id, "content": format_tool_response(tool_status="error", tool_content=result_content, error_code="validation_error")})
                                tool_call_requested = True
                                break
                            
                            title = payload.get("title", "Implementation Plan")
                            plan_markdown = payload.get("plan_markdown", "")
                            new_plan_id = payload.get("plan_id") if action == "revise" else f"plan_{chat_id}_{request_message_id}"
                            
                            # 2. Emit plan_permission_request to trace so it persists in DB
                            await emit_trace_and_push(_build_event("plan_permission_request", reason=title, title=title, action=action, plan_id=new_plan_id))
                            
                            # 3. Chunk markdown (only needs push_event, handled by extension runtime)
                            chunk_size = 4000
                            for i in range(0, len(plan_markdown), chunk_size):
                                chunk = plan_markdown[i:i+chunk_size]
                                await push_event(_build_event("plan_chunk", content=chunk))
                            
                            await push_event(_build_event("plan_ready", plan_id=new_plan_id))
                            
                            # 4. Emit tool_result to close the UI accordion
                            result_content = "Plan presented to user. Waiting for user approval."
                            success_event = _build_event("tool_result", metadata={"phase": "tool_result", "status": "success"}, status="success", content=result_content, tool_call_id=tool_call_id)
                            await emit_trace_and_push(success_event)
                            
                            llm_messages.append(_assistant_tool_call_message(assistant_turn_content, tool_name, tool_call_id, tool_args, assistant_reasoning_content))
                            llm_messages.append({"role": "tool", "tool_call_id": tool_call_id, "content": format_tool_response(tool_status="success", tool_content=result_content)})
                            
                            tool_call_requested = True
                            break
                        # ΓöÇΓöÇ end plan_tool ΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇ

                        # ΓöÇΓöÇ todo_tool interception ΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇ
                        if tool_name == "todo_tool":
                            action = tool_args.get("action")
                            payload = tool_args.get("payload", {})
                            
                            # 1. Emit tool_call
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
                                
                            # 2. Emit tool_result
                            result_content = "Todo list updated successfully."
                            success_event = _build_event("tool_result", metadata={"phase": "tool_result", "status": "success"}, status="success", content=result_content, tool_call_id=tool_call_id)
                            await emit_trace_and_push(success_event)
                            
                            llm_messages.append(_assistant_tool_call_message(assistant_turn_content, tool_name, tool_call_id, tool_args, assistant_reasoning_content))
                            llm_messages.append({"role": "tool", "tool_call_id": tool_call_id, "content": format_tool_response(tool_status="success", tool_content=result_content)})
                            
                            tool_call_requested = True
                            break
                        # ΓöÇΓöÇ end todo_tool ΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇ

                        # ΓöÇΓöÇ web_search interception ΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇ
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

                            logger.info(f"Executing web_search for query: {query}")
                            await emit_trace_and_push(build_status_event(f"Searching web for '{query}'...", "searching_web"))

                            try:
                                results_list = await search_web(query, orchestrator.config.exa_key, num_results=num_results)
                                result_content = json.dumps(results_list, ensure_ascii=False)
                                logger.info(f"Web search successful for query: {query}")
                                success_event = _build_event("tool_result", metadata={"phase": "tool_result", "status": "success"}, status="success", content="Web search successful", tool_call_id=tool_call_id)
                                await emit_trace_and_push(success_event)
                                
                                llm_messages.append(_assistant_tool_call_message(assistant_turn_content, tool_name, tool_call_id, tool_args, assistant_reasoning_content))
                                llm_messages.append({"role": "tool", "tool_call_id": tool_call_id, "content": format_tool_response(tool_status="success", tool_content=result_content)})
                                
                                tool_call_requested = True
                                break
                            except Exception as e:
                                logger.error(f"Web search failed: {e}", exc_info=True)
                                result_content = f"Web search failed: {str(e)}"
                                error_event = _build_event("tool_result", metadata={"phase": "tool_result", "status": "error", "error_code": "search_error"}, status="error", content=result_content, error_code="search_error", tool_call_id=tool_call_id)
                                await emit_trace_and_push(error_event)
                                llm_messages.append(_assistant_tool_call_message(assistant_turn_content, tool_name, tool_call_id, tool_args, assistant_reasoning_content))
                                llm_messages.append({"role": "tool", "tool_call_id": tool_call_id, "content": format_tool_response(tool_status="error", tool_content=result_content, error_code="search_error")})
                                tool_call_requested = True
                                break
                        # ΓöÇΓöÇ end web_search ΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇ

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

                        await emit_trace_and_push(
                            build_status_event(
                                f"Waiting for {tool_name} result from the extension...",
                                "awaiting_tool_result",
                            )
                        )

                        tool_result = await orchestrator._wait_for_tool_result(
                            tool_call_id,
                        )

                        if tool_result is None:
                            run_failed = True
                            stream_aborted = True
                            await emit_trace_and_push(
                                _build_event(
                                    "error",
                                    content=f"Timed out waiting for tool result: {tool_name}",
                                    metadata={"phase": "tool_timeout"},
                                    session_id=synthetic_session_id,
                                    chat_id=str(chat_id),
                                    message_id=request_message_id,
                                )
                            )
                            break

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

                        profiler.log_turn(llm_round, "assistant_answer", assistant_turn_content)
                        profiler.log_turn(llm_round, "assistant_reasoning", assistant_reasoning_content)
                        profiler.log_turn(llm_round, f"tool_output_{tool_name}", tool_result.content)

                        llm_messages.append(
                            _assistant_tool_call_message(
                                assistant_turn_content,
                                tool_name,
                                tool_call_id,
                                tool_args,
                                assistant_reasoning_content,
                            )
                        )
                    
                        llm_messages.append(
                            {
                                "role": "tool",
                                "tool_call_id": tool_call_id,
                                "content": format_tool_response(
                                    tool_status=tool_result.status,
                                    tool_content=tool_result.content,
                                    error_code=tool_result.error_code,
                                    tool_data=tool_result.data,
                                    tool_conflict=tool_result.conflict,
                                ),
                            }
                        )

                        tool_call_requested = True
                        break

                if stream_aborted:
                    break

            except Exception as stream_exc:
                logger.error("LLM stream error for chat %s:\n%s", chat_id, stream_exc, exc_info=True)
                run_failed = True
                stream_aborted = True
                await emit_trace_and_push(_build_event("error", content="The LLM connection was unexpectedly dropped. Please try again.", metadata={"phase": "stream_error"}, session_id=synthetic_session_id, chat_id=str(chat_id), message_id=request_message_id))

            if stream_aborted:
                break
                


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
                await emit_trace_and_push(build_status_event("Final answer ready.", "completed"))
            break
    except asyncio.CancelledError:
        run_failed = True
        logger.info("Agent loop cancelled for chat %s", chat_id)
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

    await orchestrator.file_store.append_message(chat_id, "assistant", full_response, events=trace_events)

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
            if "working_memory" not in state: state["working_memory"] = {}
            previous_tool_memory = state["working_memory"].get("tool_memory")
            updated_tool_memory = build_tool_memory_from_trace_events(previous_tool_memory, trace_events)
            state["working_memory"]["tool_memory"] = updated_tool_memory
            await orchestrator.nats.kv_set("SESSIONS", f"session.{chat_id}", json.dumps(state))
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
    try:
        await push_event({"type": "done", "messageId": request_message_id})
    except Exception:
        logger.exception("Failed to push done event")

