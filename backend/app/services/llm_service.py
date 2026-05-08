"""LLM service - OpenAI SDK against the active OpenAI-compatible provider."""
import asyncio
import json
import logging
import time
from typing import Any, AsyncIterator, Dict, List
from uuid import uuid4

from openai import AsyncOpenAI

from app.core.config import settings

logger = logging.getLogger(__name__)
context_logger = logging.getLogger("app.context")

_glm_rate_limiter = asyncio.Semaphore(1)
_glm_last_call_time = 0.0
_glm_rate_limit_seconds = 70
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


WORKSPACE_OPS_TOOL_SPEC: dict[str, Any] = {
    "type": "function",
    "function": {
        "name": "workspace_ops",
        "description": "Perform one workspace operation against the repository.",
        "parameters": {
            "type": "object",
            "properties": {
                "action": {
                    "type": "string",
                    "enum": [
                        "list_dir",
                        "search_text",
                        "read_file",
                        "edit_file",
                        "create_file",
                        "delete_path",
                        "rename_path",
                    ],
                },
                "request_id": {
                    "type": "string",
                    "description": "Stable idempotency key for retries of the same tool call.",
                },
                "mode": {
                    "type": "string",
                    "enum": ["preview", "apply"],
                },
                "payload": {
                    "type": "object",
                    "description": "Arguments for the action.\n- list_dir: {'path': string} (use '.' for root)\n- search_text: {'query': string, 'filePattern'?: string, 'useRegex'?: boolean} (searches CONTENT, not filenames)\n- read_file: {'path': string, 'startLine'?: number, 'endLine'?: number}\n- edit_file: {'path': string, 'edits': array, 'expected_hash': string}\n- create_file: {'path': string, 'content': string}\n- delete_path: {'path': string}\n- rename_path: {'oldPath': string, 'newPath': string}",
                    "properties": {
                        "path": {
                            "type": "string",
                            "description": "The file or directory path. Use '.' or '/' for the root directory. Required for list_dir, read_file, edit_file, create_file, delete_path."
                        },
                        "query": {
                            "type": "string",
                            "description": "The text or regex inside file contents to search for. Required for search_text. DO NOT use this to just search for file names."
                        },
                        "filePattern": {
                            "type": "string",
                            "description": "Glob pattern to limit search_text, e.g. '**/*.py'."
                        },
                        "useRegex": {
                            "type": "boolean",
                            "description": "Whether query is a regex pattern in search_text."
                        },
                        "edits": {
                            "type": "array",
                            "description": "Array of edits. Required for edit_file."
                        },
                        "content": {
                            "type": "string",
                            "description": "File content. Required for create_file."
                        },
                        "oldPath": {
                            "type": "string"
                        },
                        "newPath": {
                            "type": "string"
                        }
                    },
                    "additionalProperties": True,
                },
            },
            "required": ["action", "request_id", "mode", "payload"],
            "additionalProperties": False,
        },
    },
}

TERMINAL_OPS_TOOL_SPEC: dict[str, Any] = {
    "type": "function",
    "function": {
        "name": "terminal_ops",
        "description": "Execute terminal commands, manage processes, and get diagnostics.",
        "parameters": {
            "type": "object",
            "properties": {
                "action": {
                    "type": "string",
                    "enum": [
                        "run_command",
                        "send_input",
                        "get_output",
                        "get_diagnostics",
                        "get_state",
                        "list_processes",
                        "kill_process",
                        "list_terminals",
                        "new_terminal",
                        "kill_terminal",
                    ],
                    "description": "The terminal action to perform.",
                },
                "command": {
                    "type": "string",
                    "description": "The shell command to run. Required for run_command.",
                },
                "cwd": {
                    "type": "string",
                    "description": "The directory to run the command in. Defaults to workspace root. Required for run_command.",
                },
                "mode": {
                    "type": "string",
                    "enum": ["blocking", "background"],
                    "description": "Whether to wait for completion (blocking) or run in background (returns PID). Defaults to blocking.",
                },
                "terminal_name": {
                    "type": "string",
                    "description": "Name of the terminal instance to use. Defaults to 'Vertex Worker'.",
                },
                "timeout_seconds": {
                    "type": "integer",
                    "description": "Max time to wait for a blocking command. Default 360.",
                },
                "input_text": {
                    "type": "string",
                    "description": "Raw text or control character (e.g. \\u0003 for Ctrl+C) to send. Required for send_input.",
                },
                "pid": {
                    "type": "integer",
                    "description": "Process ID to target. Required for kill_process.",
                },
                "wait_for_pattern": {
                    "type": "string",
                    "description": "Optional regex pattern. If provided, the command will run in the background, and the tool will pause until this pattern is detected in the output stream before returning.",
                },
                "since_command_id": {
                    "type": "string",
                    "description": "Filter output to only show text emitted after this command ID in get_output.",
                },
            },
            "required": ["action"],
            "additionalProperties": False,
        },
    },
}

LOAD_TOOL_CONTEXT_TOOL_SPEC: dict[str, Any] = {
    "type": "function",
    "function": {
        "name": "load_tool_context",
        "description": "Load detailed usage guidance for one or more tool categories into your context before using them. Call this FIRST, before using workspace_ops or terminal_ops, to get the full instructions for each tool suite you need. Load all required categories in a single call.",
        "parameters": {
            "type": "object",
            "properties": {
                "categories": {
                    "type": "array",
                    "items": {
                        "type": "string",
                        "enum": ["workspace_ops", "terminal_ops"],
                    },
                    "description": "The tool categories to load. Load all categories you expect to need in one call.",
                }
            },
            "required": ["categories"],
            "additionalProperties": False,
        },
    },
}


def wrap_tool_response_codeforge(
    tool_name: str,
    tool_status: str,
    tool_content: str,
    error_code: str | None = None
) -> str:
    """
    Wrap tool result in CodeForge-compatible format.

    Every tool call response MUST use this wrapper to keep structured tool output
    consistent across model backends.
    
    Args:
        tool_name: e.g., "workspace_ops"
        tool_status: "success" or "error"
        tool_content: The actual output (file content, grep results, bash output, etc.)
        error_code: Optional error identifier (e.g., "ENOENT", "RANGE_TOO_LARGE")
    
    Returns:
        XML-wrapped response matching CodeForge training format
    """
    response_data = {
        "output": tool_content,
        "exit_code": 0 if tool_status == "success" else 1,
    }
    
    if error_code:
        response_data["error_code"] = error_code
    
    return (
        f"<tool_response>\n"
        f"{json.dumps(response_data)}\n"
        f"</tool_response>"
    )


DEVELOPER_ASSISTANT_PERSONA = """You are Vertex, a sharp expert developer assistant embedded directly inside VS Code.

You are an AUTONOMOUS, GOAL-DRIVEN AGENT. Your purpose is to accomplish the user's tasks by intelligently chaining tools until the goal is fully achieved.

CORE EXECUTION MINDSET:
1. TASK DECONSTRUCTION: Break the task into logical steps before acting.
2. LOAD TOOLS FIRST: Before using workspace_ops or terminal_ops, call load_tool_context with every category you will need. Load all at once in a single call. You only need to do this once per session — guidance persists automatically.
3. CONTINUOUS EXECUTION: Do not wait for the user between steps. Use tools to gather information and apply changes.
4. ADAPTIVE ROUTING: After every tool result: if it succeeded, take the next step; if it failed, pivot strategy immediately. Never retry the same failed call twice.
5. RELENTLESS FORWARD MOMENTUM: After EVERY tool result, you MUST take the next logical action or provide the final answer. Never produce an empty turn.

AVAILABLE TOOL CATEGORIES:
- workspace_ops: file reading, editing, searching, creating, deleting, renaming
- terminal_ops: shell commands, process management, diagnostics

Rules you always follow:
- Reason step-by-step before acting
- NEVER GUESS TOOL SYNTAX. Call load_tool_context first to get exact instructions.
- Be direct and precise — no filler, no padding
- Reference specific line numbers and function names when discussing code
- Prefer showing working code over describing it
- NEVER return an empty or silent response"""


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


def _get_client() -> AsyncOpenAI:
    base_url = _normalize_base_url(settings.llm_base_url)
    return AsyncOpenAI(
        base_url=base_url,
        api_key=settings.llm_api_key,
    )


def _normalize_base_url(base_url: str) -> str:
    normalized_base_url = base_url.strip().rstrip("/")

    if not normalized_base_url:
        return "https://api.us-west-2.modal.direct/v1"

    chat_completions_suffix = "/chat/completions"
    if normalized_base_url.endswith(chat_completions_suffix):
        normalized_base_url = normalized_base_url[: -len(chat_completions_suffix)]

    return normalized_base_url.rstrip("/")


def _model_name(model: str | None = None) -> str:
    return model or settings.llm_model


def _build_request_payload(
    messages: List[Dict[str, Any]],
    workspace_skeleton: str | None = None,
    model: str | None = None,
    active_tool_guidance: str | None = None,
) -> Dict[str, Any]:
    full_messages: list[Any] = [
        {"role": "system", "content": _build_system_prompt(workspace_skeleton, active_tool_guidance)},
        *messages,
    ]

    payload: Dict[str, Any] = {
        "model": _model_name(model),
        "messages": full_messages,
        "stream": True,
        "tools": [WORKSPACE_OPS_TOOL_SPEC, TERMINAL_OPS_TOOL_SPEC, LOAD_TOOL_CONTEXT_TOOL_SPEC],
        "tool_choice": "auto",
    }

    if settings.llm_reasoning_enabled:
        payload["extra_body"] = {
            "reasoning": {
                "effort": settings.llm_reasoning_effort,
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
            logger.warning("Ignoring malformed structured tool call arguments: %s", arguments_text)
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
    client = _get_client()
    stream = await client.chat.completions.create(
        **_build_request_payload(messages, workspace_skeleton)
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
        model: Optional model override (defaults to settings.llm_model)

    Yields event dicts with:
      - {"type": "token", "content": "..."}
      - {"type": "thinking", "content": "..."}
      - {"type": "tool_call", "tool_call_id": "...", "tool_name": "...", "args": {...}}
    """
    global _glm_last_call_time
    
    client = _get_client()
    payload = _build_request_payload(messages, workspace_skeleton, model, active_tool_guidance)
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
        async with _glm_rate_limiter:
            elapsed = time.monotonic() - _glm_last_call_time
            if elapsed < _glm_rate_limit_seconds:
                wait_time = _glm_rate_limit_seconds - elapsed
                logger.info("🔄 %s-second rate limit delay started (waiting %.1f seconds)", _glm_rate_limit_seconds, wait_time)
                await asyncio.sleep(wait_time)
                logger.info("✅ %s-second rate limit delay finished, proceeding with LLM call", _glm_rate_limit_seconds)
            stream = await client.chat.completions.create(**payload)
            _glm_last_call_time = time.monotonic()
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
                fragment_chars = sum(len(fragment) for fragment in text_fragments)
                total_text_chars += fragment_chars
                logger.info(
                    "LLM stream chunk #%d text_fragments=%d text_chars=%d cumulative_text_chars=%d",
                    chunk_count,
                    len(text_fragments),
                    fragment_chars,
                    total_text_chars,
                )

            for token in text_fragments:
                if token:
                    text_fragment_count += 1
                    yield {"type": "token", "content": token}
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
