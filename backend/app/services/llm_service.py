"""LLM service - OpenAI SDK against OpenRouter's API."""
import json
import logging
import re
from typing import Any, AsyncIterator, Dict, List
from uuid import uuid4

from openai import AsyncOpenAI

from app.core.config import settings

logger = logging.getLogger(__name__)

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
        "[collapsed] folders exist but are intentionally not expanded.\n"
        "Use list_dir(path), grep_workspace(query, filePattern?), and "
        "read_file_paginated(path, startLine, endLine) when needed.\n\n"
        "When you decide to use a tool, emit exactly one <tool>{...}</tool> block and stop. "
        "Do not emit <tool_call>, <function=...>, or <parameter=...> tags. "
        "Do not continue the answer until the tool result is returned and injected back into context."
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
    messages: List[Dict[str, str]],
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


async def stream_chat_completion(
    messages: List[Dict[str, str]],
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
    messages: List[Dict[str, str]],
    workspace_skeleton: str | None = None,
    model: str | None = None,
) -> AsyncIterator[Dict[str, Any]]:
    """
    Stream model output as structured events.

    Supported model control block formats:
      <tool>{"name": "grep_workspace", "tool_call_id": "tc_123", "args": {...}}</tool>
      <tool_call><function=grep_workspace><parameter=query>foo</parameter></function></tool_call>

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
    streamed_buffer = ""
    holdback_chars = max(len("<tool>"), len("<tool_call>")) - 1

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

        for token in _extract_text_fragments(delta):
            streamed_buffer += token

            for event in _drain_buffered_events(streamed_buffer, is_final=False):
                if event["type"] == "__remaining_buffer__":
                    streamed_buffer = str(event["content"])
                else:
                    yield event

            if (
                "<tool>" not in streamed_buffer
                and "<tool_call>" not in streamed_buffer
                and len(streamed_buffer) > holdback_chars
            ):
                emit_text = streamed_buffer[:-holdback_chars]
                if emit_text:
                    yield {"type": "token", "content": emit_text}
                streamed_buffer = streamed_buffer[-holdback_chars:]

    for event in _drain_buffered_events(streamed_buffer, is_final=True):
        if event["type"] != "__remaining_buffer__":
            yield event


def _drain_buffered_events(buffer: str, is_final: bool) -> List[Dict[str, Any]]:
    """Extract token/tool_call events from buffered model text."""
    events: List[Dict[str, Any]] = []
    working = buffer

    while True:
        tool_start_positions = [
            ("json", working.find("<tool>")),
            ("xml", working.find("<tool_call>")),
        ]
        valid_start_positions = [
            (tool_type, start_index)
            for tool_type, start_index in tool_start_positions
            if start_index != -1
        ]

        if not valid_start_positions:
            if is_final and working:
                events.append({"type": "token", "content": working})
                working = ""
            break

        tool_type, start_index = min(valid_start_positions, key=lambda item: item[1])

        if start_index > 0:
            leading_text = working[:start_index]
            if leading_text:
                events.append({"type": "token", "content": leading_text})
            working = working[start_index:]

        closing_tag = "</tool>" if tool_type == "json" else "</tool_call>"
        opening_tag_length = len("<tool>") if tool_type == "json" else len("<tool_call>")
        end_index = working.find(closing_tag)
        if end_index == -1:
            break

        tool_block_text = working[opening_tag_length:end_index].strip()
        working = working[end_index + len(closing_tag):]

        parsed_tool_call = (
            _parse_tool_call(tool_block_text)
            if tool_type == "json"
            else _parse_legacy_tool_call(tool_block_text)
        )
        if parsed_tool_call is None:
            events.append({
                "type": "token",
                "content": (
                    f"<tool>{tool_block_text}</tool>"
                    if tool_type == "json"
                    else f"<tool_call>{tool_block_text}</tool_call>"
                ),
            })
            continue

        events.append(parsed_tool_call)

    events.append({"type": "__remaining_buffer__", "content": working})
    return events


def _parse_tool_call(tool_json_text: str) -> Dict[str, Any] | None:
    """Parse a tool call JSON object embedded in model output."""
    try:
        payload = json.loads(tool_json_text)
    except json.JSONDecodeError:
        logger.warning("Ignoring malformed tool JSON: %s", tool_json_text)
        return None

    if not isinstance(payload, dict):
        return None

    tool_name = payload.get("name") or payload.get("tool_name")
    if not isinstance(tool_name, str) or not tool_name:
        return None

    tool_call_id = payload.get("tool_call_id")
    if not isinstance(tool_call_id, str) or not tool_call_id:
        tool_call_id = f"tc_{uuid4().hex[:12]}"

    args = payload.get("args")
    if not isinstance(args, dict):
        args = {}

    return {
        "type": "tool_call",
        "tool_call_id": tool_call_id,
        "tool_name": tool_name,
        "args": args,
    }


def _parse_legacy_tool_call(tool_markup_text: str) -> Dict[str, Any] | None:
    """Parse XML-ish tool call markup emitted by some models."""
    function_match = re.search(
        r"<function=([^>\s]+)>\s*(.*?)\s*</function>",
        tool_markup_text,
        re.IGNORECASE | re.DOTALL,
    )
    if not function_match:
        logger.warning("Ignoring malformed legacy tool markup: %s", tool_markup_text)
        return None

    tool_name = function_match.group(1).strip()
    function_body = function_match.group(2)
    raw_parameters = re.findall(
        r"<parameter=([^>\s]+)>\s*(.*?)\s*</parameter>",
        function_body,
        re.IGNORECASE | re.DOTALL,
    )
    args = {
        parameter_name.strip(): _coerce_tool_arg(parameter_value)
        for parameter_name, parameter_value in raw_parameters
        if parameter_name.strip()
    }

    return {
        "type": "tool_call",
        "tool_call_id": f"tc_{uuid4().hex[:12]}",
        "tool_name": tool_name,
        "args": args,
    }


def _coerce_tool_arg(raw_value: str) -> Any:
    value = raw_value.strip()
    if not value:
        return ""

    lowered = value.lower()
    if lowered == "true":
        return True
    if lowered == "false":
        return False

    if re.fullmatch(r"-?\d+", value):
        return int(value)

    if re.fullmatch(r"-?\d+\.\d+", value):
        return float(value)

    if value.startswith("{") or value.startswith("["):
        try:
            return json.loads(value)
        except json.JSONDecodeError:
            return value

    return value
