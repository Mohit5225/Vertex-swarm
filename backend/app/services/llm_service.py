"""LLM service - OpenAI SDK against the active OpenAI-compatible provider."""
import asyncio
import json
import logging
import re
import time
from typing import Any, AsyncIterator, Dict, List
from uuid import uuid4

from openai import AsyncOpenAI

from app.config import WorkerConfig
from app.services.tool_schemas import WORKSPACE_OPS_TOOL_SPEC, TERMINAL_OPS_TOOL_SPEC, LOAD_TOOL_CONTEXT_TOOL_SPEC, PLAN_TOOL_SPEC, TODO_TOOL_SPEC, WEB_SEARCH_TOOL_SPEC, SPAWN_SUBAGENT_TOOL_SPEC

logger = logging.getLogger(__name__)
context_logger = logging.getLogger("app.context")

_rate_limiters: dict[str, asyncio.Semaphore] = {}
_last_call_times: dict[str, float] = {}
_rate_limit_seconds = 5

def _get_rate_limiter(api_key: str) -> asyncio.Semaphore:
    if api_key not in _rate_limiters:
        _rate_limiters[api_key] = asyncio.Semaphore(1)
    return _rate_limiters[api_key]
_context_log_sequence = 0


def _next_context_log_sequence() -> int:
    global _context_log_sequence
    _context_log_sequence += 1
    return _context_log_sequence


def _log_llm_context_snapshot(
    payload: Dict[str, Any],
    context_log_metadata: Dict[str, Any] | None = None,
) -> None:
    """Persist the exact LLM request context for post-run debugging."""
    snapshot = {
        "sequence": _next_context_log_sequence(),
        "metadata": context_log_metadata or {},
        "payload": payload,
    }
    context_logger.info("LLM_CONTEXT %s", json.dumps(snapshot, ensure_ascii=False, default=str))



def format_tool_response(
    tool_status: str,
    tool_content: str,
    error_code: str | None = None,
    tool_data: dict | list | str | int | float | bool | None = None,
    tool_conflict: dict | None = None
) -> str:
    """
    Format tool result as a standard JSON string.
    """
    response_data = {
        "status": tool_status,
        "content": tool_content,
    }
    
    if error_code:
        response_data["error_code"] = error_code
    if tool_data is not None:
        response_data["data"] = tool_data
    if tool_conflict is not None:
        response_data["conflict"] = tool_conflict
    
    return json.dumps(response_data, ensure_ascii=False)


DEVELOPER_ASSISTANT_PERSONA = """You are Vertex, a sharp expert developer assistant embedded directly inside VS Code.

Your purpose is to accomplish the user's tasks by intelligently chaining tools until the goal is fully achieved.

CORE EXECUTION MINDSET:
1. SCAN YOUR CONTEXT FIRST: Before every task, read what you've been given — Operating System, Terminal CWD, workspace folder paths, active file, shell type. This is ground truth. Use it directly. Never substitute training-data defaults (like /workspace/ or Linux-style paths) when the real values are already in your context.
2. TASK DECONSTRUCTION: Break the task into logical steps before acting.
3. CRITICAL: LOAD TOOL INSTRUCTIONS FIRST: Your very first action must always be to call `load_tool_context` with all categories you need. Without it, the tool schemas are too complex to use correctly and your calls will fail.
4. CONTINUOUS EXECUTION: Do not wait for the user between steps. Use tools to gather information and apply changes.
5. CRITICAL TOOL OBSERVATION: After every tool call, you must state in one sentence what the tool actually returned before taking any further action. Never assume a result, file, or output exists unless a tool call has confirmed it in this turn.
If a tool result contradicts your plan, the result takes priority — stop and adjust, do not proceed as planned. If a tool call fails or returns something unexpected,
stop and report it instead of continuing as if it succeeded. Take one action at a time, and before each action, name which prior tool result justifies it. Do not report a task as complete unless a tool result directly confirms it , DO NOT ASSSUME THE RESULT IF YOU HAVE NOT CONFIRMED SOMETHING EXPLICITLY WITH TOOL RESULT TREAT TASK AS UNVERIFIED.
6. ADAPTIVE ROUTING: After every tool result: if it succeeded, take the next step; if it failed, pivot strategy immediately. Never retry the same failed call twice.
7. RELENTLESS FORWARD MOMENTUM: After EVERY tool result, you MUST take the next logical action or provide the final answer. Never produce an empty turn.
8. CIRCUIT BREAKER: If a tool returns empty or unexpected data twice, or if you encounter the same error code twice, STOP and ask the user for clarification. Do not keep looping with alternative tools or "creative" path guesses.

CONTEXT USAGE RULES:
- Operating System is in your context. Use it to determine path separators (\\ on win32, / on Linux/macOS), shell commands, and executable names.
- Workspace folder paths and Terminal CWD are in your context. Use them as the base for any `cwd` argument — never guess or construct paths from scratch.
- Active file path tells you the language, project, and location. Use it to avoid redundant exploration.
- When context answers your question, act on it. Do not query the filesystem to re-discover what you already know.
- VERIFICATION IS FAILURE: Never call get_state or pwd to "verify" the context you've already been given. Trust the injected block implicitly.

TRUST-FIRST INFORMATION POLICY:
- Injected context (OS, shell, CWD, workspace folders, active file) is authoritative. Use it confidently without verification. Only reach for a tool to re-fetch this information if acting on the injected value produced a concrete failure.
- Before running any read action (e.g., terminal_ops get_state, or workspace_ops search/read/list actions), scan your conversation history first. If a prior result in this conversation already answered the same question, use that result directly. Do not re-run the action.
- The workspace skeleton shows the top 4 levels of the project. It is sufficient for high-level navigation and architectural awareness. Use list_dir from workspace tools only when you need contents at a deeper level that the skeleton does not show.
- When something fails, reason about WHAT specifically failed before deciding how to adapt. Diagnose the actual error, not a generic fallback assumption.

think what the task requires.
focus on what context already provides.
if something is clearly ambigious you can ask user about what is confusion and ask for clarifcation before proceeding.
but if issue is something which you can solve yourself with your intelligence , context , tools you may try to solve the confusion coming from lack of context ,that does not mean fix the issues of codebase on your own or make changes in codebase without explicit approval , just reason about what could be source of confusion
AVAILABLE TOOL CATEGORIES (Require load_tool_context first):
- workspace_ops: file reading, editing, searching, creating, deleting, renaming
- terminal_ops: shell commands, process management, diagnostics

STANDALONE TOOLS (Self-contained, use directly without load_tool_context):
- plan_tool: MUST be used to present an implementation plan before making invasive/multi-step code changes. You must wait for the user to approve the plan before proceeding.
- todo_tool: MUST be used after plan approval (or for any multi-step task) to track execution progress. Initialize all steps as 'pending', then update them one by one to 'in_progress' and 'done' as you work. Keep the same todo ids/order across updates because the UI reuses one persistent progress widget from that data. When the checklist is completely finished, you MUST explicitly ask the user for permission to kill/clear the widget. If they approve, use action='clear'.

Rules you always follow:
- Reason step-by-step before acting
- For workspace_ops and terminal_ops, NEVER GUESS TOOL SYNTAX. You MUST call `load_tool_context` first to get the exact rules.
- For plan_tool and todo_tool, the schemas are self-contained. Use them directly based on their descriptions.
- Once todo_tool is active, do not paste the full checklist into normal assistant prose; update the persistent widget with todo_tool and keep the conversational response focused on findings, requests, or results.
- Be direct and precise — no filler, no padding
- Reference specific line numbers and function names when discussing code
- Prefer showing working code over describing it
- NEVER return an empty or silent response
- devotedly follow the correct tool related rules so tools can be executed do not hallucinate tool schemas and tool rules
"""
def _build_system_prompt(
    workspace_skeleton: str | None = None,
    active_tool_guidance: str | None = None,
) -> str:
    """Build system prompt, injecting workspace context and any loaded tool guidance."""
    parts = [DEVELOPER_ASSISTANT_PERSONA]

    if active_tool_guidance:
        parts.append(active_tool_guidance)

    if not workspace_skeleton:
        return "\n\n".join(parts)

    workspace_block = (
        "Workspace Root: provided by extension host\n\n"
        "Project Structure:\n"
        f"{workspace_skeleton}\n"
        "[collapsed] folders exist but are intentionally not expanded."
    )
    parts.append(workspace_block)
    return "\n\n".join(parts)


def _get_client(base_url: str, api_key: str) -> AsyncOpenAI:
    normalized_base_url = _normalize_base_url(base_url)
    return AsyncOpenAI(
        base_url=normalized_base_url,
        api_key=api_key,
        max_retries=3,
    )


def _normalize_base_url(base_url: str) -> str:
    normalized_base_url = base_url.strip().rstrip("/")

    if not normalized_base_url:
        raise ValueError("LLM base URL is empty or unconfigured")

    chat_completions_suffix = "/chat/completions"
    if normalized_base_url.endswith(chat_completions_suffix):
        normalized_base_url = normalized_base_url[: -len(chat_completions_suffix)]

    return normalized_base_url.rstrip("/")


def _model_name(config: WorkerConfig, model: str | None = None) -> str:
    return model or config.llm_model


def _build_request_payload(
    messages: List[Dict[str, Any]],
    config: WorkerConfig,
    workspace_skeleton: str | None = None,
    model: str | None = None,
    active_tool_guidance: str | None = None,
) -> Dict[str, Any]:
    full_messages: list[Any] = [
        {"role": "system", "content": _build_system_prompt(workspace_skeleton, active_tool_guidance)},
        *messages,
    ]

    payload: Dict[str, Any] = {
        "model": _model_name(config, model),
        "messages": full_messages,
        "stream": True,
        "tools": [
            WORKSPACE_OPS_TOOL_SPEC, 
            TERMINAL_OPS_TOOL_SPEC, 
            LOAD_TOOL_CONTEXT_TOOL_SPEC,
            PLAN_TOOL_SPEC,
            TODO_TOOL_SPEC,
            WEB_SEARCH_TOOL_SPEC,
            SPAWN_SUBAGENT_TOOL_SPEC
        ],
        "tool_choice": "auto",
    }

    if config.llm_reasoning_enabled:
        payload["extra_body"] = {
            "thinking": {
                "type": "enabled",
            }
        }

    return payload


def _delta_attr(delta: Any, attr_name: str) -> Any:
    if isinstance(delta, dict):
        return delta.get(attr_name)
    return getattr(delta, attr_name, None)


def _tool_attr(value: Any, attr_name: str) -> Any:
    if isinstance(value, dict):
        return value.get(attr_name)
    return getattr(value, attr_name, None)


def _extract_text_fragments(delta: Any) -> List[str]:
    text_fragments: List[str] = []
    content = _delta_attr(delta, "content")

    if isinstance(content, str):
        return [content]

    if isinstance(content, list):
        for part in content:
            text = getattr(part, "text", None)
            if isinstance(text, str) and text:
                text_fragments.append(text)
                continue

            if isinstance(part, dict):
                part_text = part.get("text")
                if isinstance(part_text, str) and part_text:
                    text_fragments.append(part_text)

    fallback_text = _delta_attr(delta, "text")
    if isinstance(fallback_text, str) and fallback_text:
        text_fragments.append(fallback_text)

    return text_fragments


def _extract_reasoning_fragments(delta: Any) -> List[str]:
    reasoning_fragments: List[str] = []

    for attr_name in ("reasoning", "reasoning_content", "reasoning_text", "thinking"):
        value = _delta_attr(delta, attr_name)

        if isinstance(value, str) and value:
            reasoning_fragments.append(value)
            continue

        if isinstance(value, list):
            for part in value:
                text = getattr(part, "text", None)
                if isinstance(text, str) and text:
                    reasoning_fragments.append(text)
                    continue

                if isinstance(part, dict):
                    part_text = part.get("text")
                    if isinstance(part_text, str) and part_text:
                        reasoning_fragments.append(part_text)

    if not reasoning_fragments:
        reasoning_details = _delta_attr(delta, "reasoning_details")
        if isinstance(reasoning_details, list):
            for item in reasoning_details:
                if not isinstance(item, dict):
                    continue
                for summary in item.get("summary", []):
                    if isinstance(summary, str) and summary:
                        reasoning_fragments.append(summary)

    return reasoning_fragments


def _extract_tool_call_fragments(delta: Any) -> List[Dict[str, Any]]:
    tool_call_fragments: List[Dict[str, Any]] = []
    tool_calls = _delta_attr(delta, "tool_calls")

    if not isinstance(tool_calls, list):
        return tool_call_fragments

    for tool_call in tool_calls:
        function_call = _tool_attr(tool_call, "function")
        tool_call_fragments.append(
            {
                "index": _tool_attr(tool_call, "index"),
                "tool_call_id": _tool_attr(tool_call, "id"),
                "tool_name": _tool_attr(function_call, "name"),
                "arguments": _tool_attr(function_call, "arguments"),
            }
        )

    return tool_call_fragments


def _merge_tool_call_fragment(
    pending_tool_calls: Dict[int, Dict[str, Any]],
    fragment: Dict[str, Any],
) -> None:
    fragment_index = fragment.get("index")
    tool_call_index = fragment_index if isinstance(fragment_index, int) else 0

    pending_tool_call = pending_tool_calls.setdefault(
        tool_call_index,
        {
            "tool_call_id": "",
            "tool_name": "",
            "arguments": "",
        },
    )

    tool_call_id = fragment.get("tool_call_id")
    if isinstance(tool_call_id, str) and tool_call_id:
        pending_tool_call["tool_call_id"] = tool_call_id

    tool_name = fragment.get("tool_name")
    if isinstance(tool_name, str) and tool_name:
        pending_tool_call["tool_name"] = tool_name

    arguments = fragment.get("arguments")
    if isinstance(arguments, str) and arguments:
        pending_tool_call["arguments"] += arguments


def _finalize_pending_tool_calls(
    pending_tool_calls: Dict[int, Dict[str, Any]],
) -> List[Dict[str, Any]]:
    tool_call_events: List[Dict[str, Any]] = []

    for tool_call_index in sorted(pending_tool_calls):
        pending_tool_call = pending_tool_calls[tool_call_index]
        tool_name = pending_tool_call.get("tool_name")
        if not isinstance(tool_name, str) or not tool_name:
            continue

        tool_call_id = pending_tool_call.get("tool_call_id")
        if not isinstance(tool_call_id, str) or not tool_call_id:
            tool_call_id = f"tc_{uuid4().hex[:12]}"

        arguments_text = str(pending_tool_call.get("arguments", "")).strip()
        try:
            arguments = json.loads(arguments_text) if arguments_text else {}
        except json.JSONDecodeError:
            logger.warning("Yielding malformed structured tool call arguments to agent: %s", arguments_text)
            tool_call_events.append(
                {
                    "type": "tool_call",
                    "tool_call_id": tool_call_id,
                    "tool_name": tool_name,
                    "args": {"__schema_error__": "JSONDecodeError: Malformed JSON arguments", "raw_text": arguments_text},
                }
            )
            continue

        if not isinstance(arguments, dict):
            arguments = {}

        tool_call_events.append(
            {
                "type": "tool_call",
                "tool_call_id": tool_call_id,
                "tool_name": tool_name,
                "args": arguments,
            }
        )

    return tool_call_events


async def stream_chat_completion(
    messages: List[Dict[str, Any]],
    config: WorkerConfig,
    workspace_skeleton: str | None = None,
) -> AsyncIterator[str]:
    """
    Stream a chat completion via an OpenAI-compatible API.

    Args:
        messages: List of {"role": "user"|"assistant", "content": "..."} dicts
                  in chronological order.

    Yields:
        Token chunks (str) as they stream from the model.
    """
    api_key = config.llm_key
    
    client = _get_client(base_url=config.llm_base_url, api_key=api_key)
    stream = await client.chat.completions.create(
        **_build_request_payload(messages, config, workspace_skeleton)
    )

    async for chunk in stream:
        if not chunk.choices:
            logger.debug("Skipping streamed chunk without choices: %s", chunk)
            continue

        delta = chunk.choices[0].delta
        if not delta:
            continue

        for text in _extract_text_fragments(delta):
            yield text


async def stream_chat_events(
    messages: List[Dict[str, Any]],
    config: WorkerConfig,
    workspace_skeleton: str | None = None,
    model: str | None = None,
    context_log_metadata: Dict[str, Any] | None = None,
    active_tool_guidance: str | None = None,
) -> AsyncIterator[Dict[str, Any]]:
    """
    Stream model output as structured events.

    The model is expected to emit structured tool calls through the OpenAI-style
    tool_calls channel when workspace_ops is needed.

    Args:
        messages: Chat messages list
        workspace_skeleton: Optional workspace context
        model: Optional model override (defaults to config.llm_model)

    Yields event dicts with:
      - {"type": "token", "content": "..."}
      - {"type": "thinking", "content": "..."}
      - {"type": "tool_call", "tool_call_id": "...", "tool_name": "...", "args": {...}}
    """
    api_key = config.llm_key
    
    rate_limiter = _get_rate_limiter(api_key)
    client = _get_client(base_url=config.llm_base_url, api_key=api_key)
    logger.info("Using LLM key from config")
    
    payload = _build_request_payload(messages, config, workspace_skeleton, model, active_tool_guidance)
    _log_llm_context_snapshot(payload, context_log_metadata)
    
    # Log request details for debugging
    logger.info(
        "Initiating LLM stream: model=%s messages_count=%s has_tools=%s has_reasoning=%s has_extra_body=%s",
        payload.get("model"),
        len(payload.get("messages", [])),
        bool(payload.get("tools")),
        bool(payload.get("reasoning")),
        bool(payload.get("extra_body")),
    )
    
    # Log message roles to debug the conversation structure
    msg_roles = [m.get("role") for m in payload.get("messages", [])]
    logger.debug(
        "Message structure: roles=%s system_prompt_len=%s",
        msg_roles,
        len(payload.get("messages", [{}])[0].get("content", "")) if payload.get("messages") else 0,
    )
    
    try:
        async with rate_limiter:
            last_call_time = _last_call_times.get(api_key, 0.0)
            elapsed = time.monotonic() - last_call_time
            if elapsed < _rate_limit_seconds:
                wait_time = _rate_limit_seconds - elapsed
                logger.info("🔄 %s-second rate limit delay started (waiting %.1f seconds)", _rate_limit_seconds, wait_time)
                await asyncio.sleep(wait_time)
                logger.info("✅ %s-second rate limit delay finished, proceeding with LLM call", _rate_limit_seconds)
            stream = await client.chat.completions.create(**payload)
            _last_call_times[api_key] = time.monotonic()
        logger.debug("LLM stream established successfully")
    except Exception as stream_init_exc:
        logger.error(
            "Failed to initiate LLM stream: %s",
            str(stream_init_exc),
            exc_info=True,
        )
        raise
    
    pending_tool_calls: Dict[int, Dict[str, Any]] = {}
    saw_structured_tool_call = False
    chunk_count = 0
    text_fragment_count = 0
    thinking_fragment_count = 0
    tool_call_fragment_count = 0
    total_text_chars = 0
    stream_started_at = time.monotonic()

    try:
        async for chunk in stream:
            chunk_count += 1
            if not chunk.choices:
                logger.debug("Skipping streamed chunk without choices: %s", chunk)
                continue

            delta = chunk.choices[0].delta
            if not delta:
                continue

            reasoning_fragments = _extract_reasoning_fragments(delta)
            if reasoning_fragments:
                logger.info(
                    "LLM stream chunk #%d reasoning_fragments=%d reasoning_chars=%d",
                    chunk_count,
                    len(reasoning_fragments),
                    sum(len(fragment) for fragment in reasoning_fragments),
                )

            for reasoning_text in reasoning_fragments:
                if reasoning_text.strip():
                    thinking_fragment_count += 1
                    yield {"type": "thinking", "content": reasoning_text}

            tool_call_fragments = _extract_tool_call_fragments(delta)
            if tool_call_fragments:
                saw_structured_tool_call = True
                tool_call_fragment_count += len(tool_call_fragments)
                logger.info(
                    "LLM stream chunk #%d tool_call_fragments=%d",
                    chunk_count,
                    len(tool_call_fragments),
                )
                for fragment in tool_call_fragments:
                    _merge_tool_call_fragment(pending_tool_calls, fragment)
                continue

            if saw_structured_tool_call:
                continue

            text_fragments = _extract_text_fragments(delta)
            if text_fragments:
                for fragment in text_fragments:
                    total_text_chars += len(fragment)
                    text_fragment_count += 1
                    yield {"type": "token", "content": fragment}
    except Exception as stream_exc:
        logger.error(
            "LLM stream iteration failed after %d chunks: %s",
            chunk_count,
            str(stream_exc),
            exc_info=True,
        )
        raise

    logger.info(
        "LLM stream summary chunks=%d text_fragments=%d thinking_fragments=%d tool_call_fragments=%d total_text_chars=%d elapsed_seconds=%.3f saw_structured_tool_call=%s",
        chunk_count,
        text_fragment_count,
        thinking_fragment_count,
        tool_call_fragment_count,
        total_text_chars,
        time.monotonic() - stream_started_at,
        saw_structured_tool_call,
    )

    if saw_structured_tool_call:
        for event in _finalize_pending_tool_calls(pending_tool_calls):
            yield event
        return
