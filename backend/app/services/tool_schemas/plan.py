from typing import Any

PLAN_TOOL_SPEC: dict[str, Any] = {
    "type": "function",
    "function": {
        "name": "plan_tool",
        "description": (
            "Presents an implementation plan to the user for approval before making invasive/multi-step "
            "code changes. Use action='present' the first time you have a complete plan ready. Use "
            "action='revise' if the user commented on or rejected a previous plan and you are submitting "
            "a corrected version — requires the prior plan_id. Do NOT use this tool for single-file edits, "
            "plan.md is a persistent, single-source document per chat unless the user explicitly starts a new project or requests a full replacement. For any modification, addition, or removal of scope: - Locate the relevant existing section(s) in plan.md - Edit those sections in place (append new items under the correct heading, strike/remove specific completed or invalidated items, update changed items) - Never generate a new plan.md file for incremental changes Only create a new plan.md when the user explicitly requests a major refactor/reset you must infer when having old plan md create problem then only create new , or when the existing plan is being fully superseded. In that case, replace the old file's contents — do not create a second file."
            "Every invocation of the plan tool MUST perform a file write to plan.md in the same turn — no exceptions, no silent skips. "
            "Enforce this as a hard sequence, not a best-effort behavior: "
            "1. Determine whether this is a modification to existing plan.md (edit in place "
            "   per rule above) or a new plan.md (only under the reset conditions above) "
            "2. Write the corresponding change to plan.md "
            "3. Only after the file write succeeds, call the plan tool to render the UI widget "
            "The plan tool call and the plan.md write are not independent actions — treat "
            "them as one atomic step. Never present an inline plan to the user via the "
            "widget without the same content existing in plan.md on disk. "
            "small patches, or read-only exploration. CRITICAL: All action-specific arguments MUST be "
            "nested INSIDE the `payload` object, not at the top level."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "action": {
                    "type": "string",
                    "enum": ["present", "revise"],
                    "description": "'revise' requires payload.plan_id; 'present' must omit it. Harness rejects any call where these disagree — never infer intent from a mismatch."
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
                            "description": "Required for action='revise'. The plan_id from the previous plan_tool call being revised. Omit for action='present'.",
                        },
                        "title": {
                            "type": "string",
                            "description": "Short title for the plan.",
                        },
                        "plan_markdown": {
                            "type": "string",
                            "description": (
                                "Full plan content in markdown, full replacement each call — do not diff "
                                "against a previous version. Structure with clear headers: Goal, "
                                "Approach, Files affected, Steps, Risks/open questions."
                            ),
                        },
                    },
                    "required": ["title", "plan_markdown"],
                    "additionalProperties": False,
                },
            },
            "required": ["action", "request_id", "payload"],
            "additionalProperties": False,
        },
    },
}
