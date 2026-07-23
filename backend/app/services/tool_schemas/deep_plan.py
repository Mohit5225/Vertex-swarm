from typing import Any

DEEP_PLAN_TOOL_SPEC: dict[str, Any] = {
    "type": "function",
    "function": {
        "name": "deep_plan_tool",
        "description": (
            "Starts the multi-stage deep planning pipeline (sub-agents research requirements, "
            "architecture, frontend, audits, gaps). Only available when the user typed /deep-plan "
            "or confirmed via hil_tool on an architectural shift. Do NOT use for small patches — "
            "use plan_tool instead. BLOCKS until the pipeline finishes and the user approves or "
            "rejects the plan. CRITICAL: All action-specific arguments MUST be nested INSIDE "
            "`payload`, not top-level."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "action": {
                    "type": "string",
                    "enum": ["start", "revise"],
                    "description": (
                        "'start' begins a new deep planning pipeline. "
                        "'revise' re-runs after user rejected a prior pipeline — requires "
                        "payload.pipeline_id and payload.rejection_feedback."
                    ),
                },
                "request_id": {
                    "type": "string",
                    "description": "Correlation id for logging/tracing.",
                },
                "payload": {
                    "type": "object",
                    "properties": {
                        "pipeline_id": {
                            "type": "string",
                            "description": "Required for action='revise'. Omit for action='start'.",
                        },
                        "title": {
                            "type": "string",
                            "description": "Short human title, e.g. 'Neon to Supabase migration'.",
                        },
                        "scope_summary": {
                            "type": "string",
                            "description": (
                                "Your understanding of what the user wants — 2–6 sentences. "
                                "Facts the user already stated only."
                            ),
                        },
                        "trigger": {
                            "type": "string",
                            "enum": ["user_slash_command", "hil_confirmed_arch_shift"],
                            "description": (
                                "user_slash_command when /deep-plan was used; "
                                "hil_confirmed_arch_shift when user confirmed via hil_tool."
                            ),
                        },
                        "stated_constraints": {
                            "type": "array",
                            "items": {"type": "string"},
                            "description": "Hard constraints from chat — verbatim, not inferred.",
                        },
                        "rejection_feedback": {
                            "type": "string",
                            "description": "Required for action='revise'.",
                        },
                    },
                    "additionalProperties": False,
                },
            },
            "required": ["action", "request_id", "payload"],
            "additionalProperties": False,
        },
    },
}
