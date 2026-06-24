"""Tool memory helpers for mutation-only working memory across prompt boundaries."""

from collections import deque
from typing import Any

MUTATION_RETENTION_LIMIT = 15
RESULT_TRIM_LIMIT = 400

# Classify tools at registration time. Ephemeral reads are intentionally dropped.
TOOL_MEMORY_POLICY: dict[str, str] = {
    # Ephemeral/read operations
    "read_file": "ephemeral",
    "bulk_files_read": "ephemeral",
    "list_dir": "ephemeral",
    "git_status": "ephemeral",
    "git_diff": "ephemeral",
    "grep_file": "ephemeral",
    "search_codebase": "ephemeral",
    "search_text": "ephemeral",
    "api_call_read": "ephemeral",
    "get_file_metadata": "ephemeral",
    # Mutation operations
    "create_file": "mutation",
    "write_file": "mutation",
    "edit_file": "mutation",
    "delete_file": "mutation",
    "delete_path": "mutation",
    "rename_file": "mutation",
    "rename_path": "mutation",
    "move_file": "mutation",
    "run_command": "mutation",
    "run_terminal": "mutation",
    "git_commit": "mutation",
    "git_checkout": "mutation",
    "install_package": "mutation",
    "api_call_write": "mutation",
}


def _first_non_empty_str(*values: Any) -> str | None:
    for value in values:
        if isinstance(value, str):
            trimmed = value.strip()
            if trimmed:
                return trimmed
    return None


def _trim_result(value: str, limit: int = RESULT_TRIM_LIMIT) -> str:
    normalized = " ".join(value.split())
    if len(normalized) <= limit:
        return normalized

    suffix = "...[truncated]"
    return f"{normalized[: limit - len(suffix)]}{suffix}"


def _coerce_tool_memory_entries(tool_memory_obj: Any) -> list[dict[str, str]]:
    if not isinstance(tool_memory_obj, dict):
        return []

    raw_entries = tool_memory_obj.get("completed_mutations")
    if not isinstance(raw_entries, list):
        return []

    sanitized_entries: list[dict[str, str]] = []
    for raw_entry in raw_entries:
        if not isinstance(raw_entry, dict):
            continue

        tool = _first_non_empty_str(raw_entry.get("tool"))
        status = _first_non_empty_str(raw_entry.get("status")) or "success"
        target = _first_non_empty_str(raw_entry.get("target")) or "unknown-target"
        result_trimmed = _first_non_empty_str(raw_entry.get("result_trimmed")) or ""

        if not tool:
            continue

        sanitized_entries.append(
            {
                "tool": tool,
                "target": target,
                "status": status,
                "result_trimmed": _trim_result(result_trimmed),
            }
        )

    return sanitized_entries


def _extract_action(tool_result_event: dict[str, Any], tool_call_event: dict[str, Any]) -> str | None:
    action = _first_non_empty_str(tool_result_event.get("action"))
    if action:
        return action

    args = tool_call_event.get("args")
    if not isinstance(args, dict):
        return None

    payload = args.get("payload")
    payload_dict = payload if isinstance(payload, dict) else {}

    return _first_non_empty_str(args.get("action"), payload_dict.get("action"))


def _extract_target(
    action: str | None,
    tool_result_event: dict[str, Any],
    tool_call_event: dict[str, Any],
) -> str:
    args = tool_call_event.get("args")
    args_dict = args if isinstance(args, dict) else {}

    payload = args_dict.get("payload")
    payload_dict = payload if isinstance(payload, dict) else {}

    data = tool_result_event.get("data")
    data_dict = data if isinstance(data, dict) else {}

    if action in {"create_file", "write_file", "edit_file", "delete_file", "delete_path", "read_file"}:
        return (
            _first_non_empty_str(
                payload_dict.get("path"),
                args_dict.get("path"),
                data_dict.get("path"),
                data_dict.get("target"),
            )
            or "unknown-target"
        )

    if action == "list_dir":
        return (
            _first_non_empty_str(
                payload_dict.get("path"),
                args_dict.get("path"),
                payload_dict.get("dirPath"),
                args_dict.get("dirPath"),
            )
            or "unknown-target"
        )

    if action in {"rename_file", "rename_path", "move_file"}:
        old_path = _first_non_empty_str(
            payload_dict.get("oldPath"),
            payload_dict.get("old_path"),
            args_dict.get("oldPath"),
            args_dict.get("old_path"),
        )
        new_path = _first_non_empty_str(
            payload_dict.get("newPath"),
            payload_dict.get("new_path"),
            args_dict.get("newPath"),
            args_dict.get("new_path"),
        )

        if old_path and new_path:
            return f"{old_path} -> {new_path}"

        return old_path or new_path or "unknown-target"

    if action in {"run_command", "run_terminal"}:
        return (
            _first_non_empty_str(
                payload_dict.get("command"),
                args_dict.get("command"),
                payload_dict.get("cmd"),
                args_dict.get("cmd"),
            )
            or "unknown-target"
        )

    if action == "install_package":
        return (
            _first_non_empty_str(
                payload_dict.get("package"),
                args_dict.get("package"),
                payload_dict.get("name"),
                args_dict.get("name"),
            )
            or "unknown-target"
        )

    summary_fallback = _first_non_empty_str(
        tool_result_event.get("summary"),
        tool_result_event.get("content"),
    )
    return summary_fallback or "unknown-target"


def _extract_new_mutation_entries(trace_events: list[dict[str, Any]]) -> list[dict[str, str]]:
    tool_calls_by_id: dict[str, dict[str, Any]] = {}
    mutation_entries: list[dict[str, str]] = []

    for event in trace_events:
        if not isinstance(event, dict):
            continue

        event_type = event.get("type")
        if event_type == "tool_call":
            tool_call_id = _first_non_empty_str(event.get("tool_call_id"))
            if tool_call_id:
                tool_calls_by_id[tool_call_id] = event
            continue

        if event_type != "tool_result":
            continue

        status = _first_non_empty_str(event.get("status"))
        if status != "success":
            continue

        tool_call_id = _first_non_empty_str(event.get("tool_call_id")) or ""
        tool_call_event = tool_calls_by_id.get(tool_call_id, {})

        action = _extract_action(event, tool_call_event)
        tool_name = _first_non_empty_str(event.get("tool_name"))
        policy_key = action or tool_name
        if not policy_key:
            continue

        if TOOL_MEMORY_POLICY.get(policy_key) != "mutation":
            continue

        target = _extract_target(action, event, tool_call_event)
        result_source = _first_non_empty_str(event.get("summary"), event.get("content")) or ""

        mutation_entries.append(
            {
                "tool": policy_key,
                "target": target,
                "status": "success",
                "result_trimmed": _trim_result(result_source),
            }
        )

    return mutation_entries


def build_tool_memory_from_trace_events(
    existing_tool_memory: Any,
    trace_events: list[dict[str, Any]],
) -> dict[str, list[dict[str, str]]]:
    existing_entries = _coerce_tool_memory_entries(existing_tool_memory)
    mutation_window: deque[dict[str, str]] = deque(existing_entries, maxlen=MUTATION_RETENTION_LIMIT)

    for new_entry in _extract_new_mutation_entries(trace_events):
        mutation_window.append(new_entry)

    return {"completed_mutations": list(mutation_window)}


def format_tool_memory_for_prompt(tool_memory_obj: Any) -> str | None:
    completed_mutations = _coerce_tool_memory_entries(tool_memory_obj)
    if not completed_mutations:
        return None

    lines = [
        "Previous response memory - changes made:",
        "The following mutation operations already changed the workspace:",
    ]

    for index, mutation in enumerate(completed_mutations, start=1):
        lines.append(
            f"{index}. tool={mutation['tool']}; target={mutation['target']}; "
            f"status={mutation['status']}; result={mutation['result_trimmed']}"
        )

    lines.append("Do not repeat these changes unless the user explicitly asks for it.")
    lines.append("Re-read files before making new edits to avoid stale context.")

    return "\n".join(lines)
