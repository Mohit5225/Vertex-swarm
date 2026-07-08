from typing import Any

TODO_TOOL_SPEC: dict[str, Any] = {
    "type": "function",
    "function": {
        "name": "todo_tool",
        "description": (
            "Tracks and updates the execution checklist derived from an approved plan. Only call this "
            "after the user has approved a plan_tool call (or for any task requiring 3+ distinct steps even "
            "without a formal plan). action='init' creates the full checklist once, at the start of "
            "execution — every item status='pending'. action='update' resends the ENTIRE list with "
            "statuses changed; this is always a full replacement, never a partial patch. Mark exactly one "
            "item 'in_progress' at a time; mark it 'done' before starting the next. This tool drives a "
            "persistent execution widget in the UI, so keep the same item ids/order across updates and "
            "update the widget with this tool instead of restating the checklist in normal assistant prose. CRITICAL: All "
            "action-specific arguments MUST be nested INSIDE the `payload` object, not at the top level."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "action": {
                    "type": "string",
                    "enum": ["init", "update"],
                },
                "request_id": {
                    "type": "string",
                    "description": "Correlation id for logging/tracing. Not a dedup key — present/revise and init/update are full-replacement and already safe to retry.",
                },
                "payload": {
                    "type": "object",
                    "properties": {
                        "plan_id": {
                            "type": "string",
                            "description": (
                                "The plan_id this checklist was derived from. Required for action='init'. "
                                "Omit if there was no formal plan_tool call (small multi-step task)."
                            ),
                        },
                        "todos": {
                            "type": "array",
                            "description": "Full task list — complete replacement every call, not a diff. Aim for 3-15 meaningful steps; do not split into micro-tasks.",
                            "items": {
                                "type": "object",
                                "properties": {
                                    "id": {"type": "string", "description": "Stable 4-char id, unchanged across updates."},
                                    "content": {"type": "string", "description": "Imperative task description."},
                                    "activeForm": {"type": "string", "description": "Present-continuous form shown while in_progress."},
                                    "status": {
                                        "type": "string",
                                        "enum": ["pending", "in_progress", "done"],
                                    },
                                },
                                "required": ["id", "content", "activeForm", "status"],
                                "additionalProperties": False,
                            },
                        },
                    },
                    "required": ["todos"],
                    "additionalProperties": False,
                },
            },
            "required": ["action", "request_id", "payload"],
            "additionalProperties": False,
        },
    },
}
