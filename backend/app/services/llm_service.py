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
        "safety invariants because file consistency is non-negotiable.\n\n"
        "⚠️  HASH-BASED CONCURRENCY PROTOCOL: MANDATORY ENFORCEMENT\n\n"
        "Your job: Every mutation MUST include expected_hash (or expected_version).\n"
        "The hash is your CONTRACT with the file system:\n"
        "  Hash = 'This is what I believe the file contains RIGHT NOW'\n"
        "If the actual file is different, the system REJECTS your edit.\n\n"
        "THE HASHING WORKFLOW (YOU MUST FOLLOW THIS EXACTLY):\n\n"
        "STEP 1: READ THE FILE\n"
        "  Action: read_file\n"
        "  Mode: preview\n"
        "  Payload: { path }\n"
        "  YOU MUST: Extract and STORE the response field 'current_hash'\n"
        "  Example response:\n"
        "    {\n"
        "      \"status\": \"success\",\n"
        "      \"content\": \"file content...\",\n"
        "      \"data\": {\n"
        "        \"current_hash\": \"fnv1a-a1b2c3d4-24\"\n"
        "      }\n"
        "    }\n"
        "  CRITICAL: Save 'fnv1a-a1b2c3d4-24' in your context. You WILL use it in Step 3.\n\n"
        "STEP 2: ANALYZE & PLAN\n"
        "  Decide what edits to make to the file content.\n"
        "  Keep the hash from Step 1 in your mind.\n\n"
        "STEP 3: APPLY THE EDIT\n"
        "  Action: edit_file\n"
        "  Mode: apply (NOT preview)\n"
        "  Payload: {\n"
        "    \"path\": \"file/path\",\n"
        "    \"edits\": [...],\n"
        "    \"expected_hash\": \"fnv1a-a1b2c3d4-24\"  <-- HASH FROM STEP 1\n"
        "  }\n"
        "  CRITICAL: The expected_hash MUST match what you got in Step 1.\n"
        "  DO NOT:                                     DO:\n"
        "  ❌ Omit expected_hash from payload         ✅ Always include it\n"
        "  ❌ Make up a hash                          ✅ Use hash from read response\n"
        "  ❌ Use old hash from previous file read    ✅ Use hash from MOST RECENT read\n"
        "  ❌ Continue if hash is missing             ✅ Stop and log error\n\n"
        "STEP 4: CHECK THE RESULT\n"
        "  Success cases:\n"
        "    Response: { \"status\": \"success\", \"applied\": true }\n"
        "    -> File is now modified. Your edit worked.\n\n"
        "  Conflict cases (FILE CHANGED):\n"
        "    Response: {\n"
        "      \"status\": \"error\",\n"
        "      \"error_code\": \"HASH_CONFLICT\",\n"
        "      \"conflict\": {\n"
        "        \"expected_version\": \"fnv1a-a1b2c3d4-24\",\n"
        "        \"current_version\": \"fnv1a-xyz789ab-30\"\n"
        "      }\n"
        "    }\n"
        "    YOUR ACTION: Go back to STEP 1. Re-read the file completely.\n"
        "    Get the NEW current_hash from the re-read response.\n"
        "    Analyze: Does my edit still make sense with the new content?\n"
        "    If yes: Go to Step 3 again with the NEW hash.\n"
        "    If no: Tell the user the file changed and your edit is no longer valid.\n\n"
        "  Guard error (YOU FORGOT THE HASH):\n"
        "    Response: {\n"
        "      \"status\": \"error\",\n"
        "      \"error_code\": \"MISSING_CONCURRENCY_GUARD\"\n"
        "    }\n"
        "    YOUR ACTION: FATAL ERROR. You did not include expected_hash.\n"
        "    Go back to your STEP 1 response. Extract the hash from 'data.current_hash'.\n"
        "    Retry STEP 3 immediately with that hash in the payload.\n\n"
        "RULES YOU MUST FOLLOW:\n\n"
        "1. NEVER skip Step 1 (read)\n"
        "   You CANNOT assume you know file content. Always read first.\n"
        "   Other agents/users/editors may have changed the file since last read.\n\n"
        "2. NEVER omit expected_hash in Step 3\n"
        "   This is not optional. It is REQUIRED by the protocol.\n"
        "   Including expected_hash proves your edit is based on current file state.\n\n"
        "3. NEVER ignore HASH_CONFLICT\n"
        "   When conflict occurs, ALWAYS re-read (go to Step 1).\n"
        "   Do not retry with the same hash.\n"
        "   Do not give up silently.\n"
        "4. NEVER use preview mode for Step 3\n"
        "   Preview is for checking. Apply is for committing.\n"
        "   Both need the hash, but only apply actually writes.\n\n"
        "5. NEVER assume file position/line numbers are stable\n"
        "   If HASH_CONFLICT occurs, line numbers may have shifted.\n"
        "   Re-read to find the correct line numbers for your edit.\n\n"
        "EXAMPLE OF CORRECT WORKFLOW:\n\n"
        "1. Agent: workspace_ops(read_file, path='app.ts')\n"
        "   Result: content='let x=5', current_hash='fnv1a-abc123-10'\n"
        "   Agent stores: hash='fnv1a-abc123-10'\n\n"
        "2. Agent thinks: 'I need to change x=5 to x=10'\n\n"
        "3. Agent: workspace_ops(edit_file, path='app.ts', expected_hash='fnv1a-abc123-10',\n"
        "                         edits=[{find: '=5', replace: '=10'}])\n"
        "   Result: status='success', applied=true\n"
        "   Agent: File changed successfully.\n\n"
        "EXAMPLE OF INCORRECT WORKFLOW (WILL FAIL):\n\n"
        "1. Agent: workspace_ops(read_file, path='app.ts')\n"
        "   Result: content='let x=5', current_hash='fnv1a-abc123-10'\n"
        "   Agent: (IGNORES the hash)\n\n"
        "2. Agent thinks: 'I need to change x=5 to x=10'\n\n"
        "3. Agent: workspace_ops(edit_file, path='app.ts',\n"
        "                         edits=[{find: '=5', replace: '=10'}])\n"
        "                         (NO expected_hash!)\n"
        "   Result: status='error', error_code='MISSING_CONCURRENCY_GUARD'\n"
        "   Agent: FAILED. You must include expected_hash.\n\n"
        "════════════════════════════════════════════════════════════════════════════\n\n"
        "NON-HASH RULES:\n\n"
        "1. REQUEST_ID IS YOUR IDEMPOTENCY PROMISE\n"
        "   Every tool call has a request_id. If a network timeout occurs and your call\n"
        "   is retried, the same request_id ensures the intent is not duplicated.\n"
        "   Use stable request_ids (derived from the specific action, file, and change).\n"
        "   Not a random UUID per call.\n\n"
        "2. YOU CANNOT ASSUME CONSISTENCY\n"
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
        "ERROR: HASH_CONFLICT\n"
        "  This means: The file changed since you last read it.\n"
        "  Response:\n"
        "    {\n"
        "      \"status\": \"error\",\n"
        "      \"error_code\": \"HASH_CONFLICT\",\n"
        "      \"conflict\": {\n"
        "        \"expected_version\": \"fnv1a-old-hash-here\",\n"
        "        \"current_version\": \"fnv1a-new-hash-here\"\n"
        "      }\n"
        "    }\n"
        "  What to do:\n"
        "    1. Immediately read the file again (go back to STEP 1)\n"
        "    2. Update your understanding of file content\n"
        "    3. Re-evaluate: Is my edit still valid? Does it still make sense?\n"
        "    4. If valid: Adjust line numbers if needed, go to STEP 3 with NEW hash\n"
        "    5. If invalid: Stop and tell user the file changed and conflict can't be resolved\n"
        "ERROR: MISSING_CONCURRENCY_GUARD\n"
        "  This means: You forgot to include expected_hash in your edit_file apply call.\n"
        "  Response:\n"
        "    {\n"
        "      \"status\": \"error\",\n"
        "      \"error_code\": \"MISSING_CONCURRENCY_GUARD\"\n"
        "    }\n"
        "  What to do:\n"
        "    1. Go back to your last read_file response\n"
        "    2. Find the field: data.current_hash\n"
        "    3. Extract the hash value (e.g., 'fnv1a-abc123-24')\n"
        "    4. Immediately retry the edit_file call with expected_hash included\n"
        "    5. If you can't find the hash, re-read the file first\n\n"
        "ERROR: CONFLICTING_CONCURRENCY_GUARDS\n"
        "  This means: You sent both expected_hash AND expected_version but they don't match.\n"
        "  Response:\n"
        "    {\n"
        "      \"status\": \"error\",\n"
        "      \"error_code\": \"CONFLICTING_CONCURRENCY_GUARDS\"\n"
        "    }\n"
        "  What to do:\n"
        "    1. Check your latest read_file response\n"
        "    2. Only use ONE guard: either expected_hash OR expected_version\n"
        "    3. Prefer expected_hash (it comes from the 'current_hash' field)\n"
        "    4. Retry with only one of them\n\n"
        "WHEN FILE OPERATIONS TAKE MULTIPLE STEPS:\n"
        "  If you need to read multiple files or make multiple edits:\n"
        "  - EACH edit needs its own read first with its own hash\n"
        "  - Do not reuse a hash from one file for another file\n"
        "  - Do not reuse a hash from an old read for a new edit\n"
        "  - Always re-read before every edit to get the current hash\n\n"
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
