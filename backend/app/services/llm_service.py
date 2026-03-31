"""LLM service - OpenAI SDK against OpenRouter's API."""
import json
import logging
from typing import Any, AsyncIterator, Dict, List
from uuid import uuid4

from openai import AsyncOpenAI

from app.core.config import settings

logger = logging.getLogger(__name__)


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
                    "additionalProperties": True,
                },
            },
            "required": ["action", "request_id", "mode", "payload"],
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
    
    Qwen3-14B was trained on 160K trajectories using this exact structure.
    Every tool call response MUST use this wrapper to ensure model reasoning precision.
    
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

You help developers write, debug, understand, and improve code across any language or framework.

Rules you always follow:
- Reason step-by-step before answering
- Be direct and precise - no filler, no padding
- When given code, scan it for correctness, security issues, and efficiency first
- When requirements are ambiguous, ask exactly one clarifying question and stop
- Reference specific line numbers and function names when discussing code
- Prefer showing working code over describing it"""


def _build_system_prompt(workspace_skeleton: str | None = None) -> str:
    """Build system prompt and optionally inject workspace structure context."""
    if not workspace_skeleton:
        return DEVELOPER_ASSISTANT_PERSONA

    return (
        f"{DEVELOPER_ASSISTANT_PERSONA}\n\n"
        "Workspace Root: provided by extension host\n\n"
        "Project Structure:\n"
        f"{workspace_skeleton}\n\n"
        "[collapsed] folders exist but are intentionally not expanded.\n\n"
        "════════════════════════════════════════════════════════════════════════════\n"
        "WORKSPACE OPERATIONS PHILOSOPHY\n"
        "════════════════════════════════════════════════════════════════════════════\n\n"
        "workspace_ops is the single source of truth for file system mutations. It enforces\n"
        "safety invariants because file consistency is non-negotiable:\n\n"
        "1. READING IS YOUR PROOF OF STATE\n"
        "   Before modifying a file, you must read it. This is not bureaucracy—it ensures\n"
        "   you are not making decisions based on stale assumptions. The state of the file\n"
        "   may have changed since your last observation. Reading grounds your edit in reality.\n\n"
        "2. CONCURRENCY GUARDS ARE YOUR RESPONSIBILITY\n"
        "   When you apply a mutation, you must include expected_hash or expected_version.\n"
        "   This is not optional. You obtained this hash during your read. Including it\n"
        "   during apply proves that your edit is still based on the file's actual state.\n"
        "   If the hash does not match, the file changed—do not edit. Re-read and reconsider.\n\n"
        "3. PREVIEW + APPLY IS YOUR VERIFICATION LOOP\n"
        "   Mode 'preview' shows exactly what will change without committing it.\n"
        "   Use this to verify your intent is correct BEFORE mode 'apply'.\n"
        "   Preview is not optional for mutations—it is your last chance to catch mistakes.\n\n"
        "4. REQUEST_ID IS YOUR IDEMPOTENCY PROMISE\n"
        "   Every tool call has a request_id. If a network timeout occurs and your call\n"
        "   is retried, the same request_id ensures the intent is not duplicated.\n"
        "   Use stable request_ids (derived from the specific action, file, and change).\n"
        "   Not a random UUID per call.\n\n"
        "5. YOU CANNOT ASSUME CONSISTENCY\n"
        "   Two tool calls are not atomic. Code, files, and state can change between them.\n"
        "   Do not build sequences that depend on state remaining constant. Always re-check\n"
        "   before writing. This is how distributed systems work.\n\n"
        "────────────────────────────────────────────────────────────────────────────\n"
        "AVAILABLE TOOLS:\n"
        "1. workspace_ops(args: object)\n"
        "   Unified workspace tool with one action per call.\n"
        "   Required args: action, request_id, mode, payload.\n"
        "   mode: 'preview' or 'apply'.\n"
        "   Supported actions:\n"
        "   - list_dir: payload { path }\n"
        "   - search_text: payload { query, filePattern? }\n"
        "   - read_file: payload { path, startLine?, endLine? }\n"
        "   - edit_file: payload { path, edits:[{startLine,startCol,endLine,endCol,text}] }\n"
        "   - create_file: payload { path, content, overwrite? }\n"
        "   - delete_path: payload { path, recursive?, useTrash? }\n"
        "   - rename_path: payload { oldPath, newPath, overwrite? }\n\n"
        "   MUTATING ACTIONS (edit_file, create_file, delete_path, rename_path):\n"
        "   Always use 'preview' mode first to verify what will change. Then use 'apply' mode\n"
        "   with expected_hash (from your read) or expected_version. This is your contract\n"
        "   with the file system. Without it, your mutation is rejected.\n\n"
        "   REQUEST_ID STRATEGY:\n"
        "   Use stable request_ids: hash(action + file_path + operation_intent).\n"
        "   Do not generate random UUIDs. The same logical change should have the same ID\n"
        "   across retries. This enables the system to recognize and deduplicate your intent.\n\n"
        "────────────────────────────────────────────────────────────────────────────\n"
        "HANDLING CONFLICTS AND ERRORS:\n\n"
        "When a mutation fails with CONFLICT (expected_hash/expected_version mismatch):\n"
        "- The file changed since you last read it. This is not an error state—it is expected.\n"
        "- Read the file again immediately.\n"
        "- Analyze the new content and decide: does your edit still apply? Is it still valid?\n"
        "- If valid, adjust your edit (line numbers may have shifted) and re-apply with the new hash.\n"
        "- If no longer valid (changes conflict with your intent), explain to the user what changed.\n\n"
        "When a mutation fails with MISSING_CONCURRENCY_GUARD:\n"
        "- You forgot to include expected_hash or expected_version in your apply call.\n"
        "- Go back to your previous tool result from the read/preview call.\n"
        "- Extract the hash or version from that result.\n"
        "- Re-issue the apply call with that value.\n\n"
        "TOOL CALLING FORMAT:\n"
        "Use the model's structured tool-call channel for workspace_ops. Do not write tool invocation text in assistant content.\n"
        "When a tool is needed, stop after the tool call is emitted. Resume only after the tool result is injected back into context."
    )


def _get_client() -> AsyncOpenAI:
    return AsyncOpenAI(
        base_url="https://openrouter.ai/api/v1",
        api_key=settings.openrouter_api_key,
    )


# Strip the "openrouter/" prefix - OpenRouter's own API doesn't need it
def _model_name(model: str | None = None) -> str:
    model_to_use = model or settings.openrouter_model
    return model_to_use.removeprefix("openrouter/")


def _build_request_payload(
    messages: List[Dict[str, Any]],
    workspace_skeleton: str | None = None,
    model: str | None = None,
) -> Dict[str, Any]:
    full_messages: list[Any] = [
        {"role": "system", "content": _build_system_prompt(workspace_skeleton)},
        *messages,
    ]

    payload: Dict[str, Any] = {
        "model": _model_name(model),
        "messages": full_messages,
        "stream": True,
        "tools": [WORKSPACE_OPS_TOOL_SPEC],
        "tool_choice": "auto",
    }

    if settings.openrouter_reasoning_enabled:
        payload["extra_body"] = {
            "reasoning": {
                "effort": settings.openrouter_reasoning_effort,
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
    Stream a chat completion via OpenRouter using the OpenAI-compatible API.

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
) -> AsyncIterator[Dict[str, Any]]:
    """
    Stream model output as structured events.

    The model is expected to emit structured tool calls through the OpenAI-style
    tool_calls channel when workspace_ops is needed.

    Args:
        messages: Chat messages list
        workspace_skeleton: Optional workspace context
        model: Optional model override (defaults to settings.openrouter_model)

    Yields event dicts with:
      - {"type": "token", "content": "..."}
      - {"type": "thinking", "content": "..."}
      - {"type": "tool_call", "tool_call_id": "...", "tool_name": "...", "args": {...}}
    """
    client = _get_client()
    stream = await client.chat.completions.create(
        **_build_request_payload(messages, workspace_skeleton, model)
    )
    pending_tool_calls: Dict[int, Dict[str, Any]] = {}
    saw_structured_tool_call = False

    async for chunk in stream:
        if not chunk.choices:
            logger.debug("Skipping streamed chunk without choices: %s", chunk)
            continue

        delta = chunk.choices[0].delta
        if not delta:
            continue

        for reasoning_text in _extract_reasoning_fragments(delta):
            if reasoning_text.strip():
                yield {"type": "thinking", "content": reasoning_text}

        tool_call_fragments = _extract_tool_call_fragments(delta)
        if tool_call_fragments:
            saw_structured_tool_call = True
            for fragment in tool_call_fragments:
                _merge_tool_call_fragment(pending_tool_calls, fragment)
            continue

        if saw_structured_tool_call:
            continue

        for token in _extract_text_fragments(delta):
            if token:
                yield {"type": "token", "content": token}


    if saw_structured_tool_call:
        for event in _finalize_pending_tool_calls(pending_tool_calls):
            yield event
        return
