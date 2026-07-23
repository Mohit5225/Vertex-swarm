"""Assemble the LLM tools[] list from loaded tool categories."""
from typing import Any

from app.services.tool_schemas import (
    DEEP_PLAN_TOOL_SPEC,
    HIL_TOOL_SPEC,
    LOAD_TOOL_CONTEXT_TOOL_SPEC,
    PLAN_TOOL_SPEC,
    SPAWN_SUBAGENT_TOOL_SPEC,
    TERMINAL_OPS_TOOL_SPEC,
    TODO_TOOL_SPEC,
    WEB_SEARCH_TOOL_SPEC,
    WORKSPACE_OPS_TOOL_SPEC,
)

_LOADABLE_TOOL_ORDER = (
    "workspace_ops",
    "terminal_ops",
    "plan_tool",
    "todo_tool",
    "web_search",
    "spawn_subagent",
    "hil_tool",
)

_LOADABLE_TOOL_SPECS: dict[str, dict[str, Any]] = {
    "workspace_ops": WORKSPACE_OPS_TOOL_SPEC,
    "terminal_ops": TERMINAL_OPS_TOOL_SPEC,
    "plan_tool": PLAN_TOOL_SPEC,
    "todo_tool": TODO_TOOL_SPEC,
    "web_search": WEB_SEARCH_TOOL_SPEC,
    "spawn_subagent": SPAWN_SUBAGENT_TOOL_SPEC,
    "hil_tool": HIL_TOOL_SPEC,
}

CORE_TOOL_SPECS: list[dict[str, Any]] = [
    LOAD_TOOL_CONTEXT_TOOL_SPEC,
]

_LOADABLE_TOOL_NAMES = frozenset(_LOADABLE_TOOL_SPECS.keys())


def resolve_loadable_tool_name(tool_name: str) -> str | None:
    """Map a tool call name to a loadable category, if any."""
    if tool_name in _LOADABLE_TOOL_NAMES:
        return tool_name
    if tool_name.startswith("workspace_ops."):
        return "workspace_ops"
    if tool_name.startswith("terminal_ops."):
        return "terminal_ops"
    return None


def build_tools_list(
    active_categories: list[str] | None,
    *,
    deep_plan_available: bool = False,
) -> list[dict[str, Any]]:
    """Return load_tool_context plus loadable tools whose category has been loaded."""
    loaded = set(active_categories or [])
    tools = list(CORE_TOOL_SPECS)
    for category in _LOADABLE_TOOL_ORDER:
        if category in loaded:
            tools.append(_LOADABLE_TOOL_SPECS[category])
    if deep_plan_available:
        tools.append(DEEP_PLAN_TOOL_SPEC)
    return tools


def is_loadable_tool_loaded(tool_name: str, active_categories: list[str]) -> bool:
    """Return whether a loadable tool's context has been loaded."""
    category = resolve_loadable_tool_name(tool_name)
    if category is None:
        return True
    return category in active_categories
