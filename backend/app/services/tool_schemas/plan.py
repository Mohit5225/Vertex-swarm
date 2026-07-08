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
