from typing import Any

DEEP_PLAN_TOOL_SPEC: dict[str, Any] = {
    "type": "function",
    "function": {
        "name": "deep_plan_tool",
        "description": (
            "Hands off to the deep planning pipeline AFTER Vertex has written "
            "plan_pipeline/01_requirements.md and plan_pipeline/00_pipeline_manifest.json. "
            "Do NOT call on the first /deep-plan turn — extract requirements first. "
            "BLOCKS until specialist planners, verification, and user approval complete. "
            "CRITICAL: All action-specific arguments MUST be nested INSIDE `payload`, not top-level."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "action": {
                    "type": "string",
                    "enum": ["start", "revise"],
                    "description": (
                        "'start' begins the pipeline after req artifacts exist. "
                        "'revise' re-runs after user rejected a prior pipeline."
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
                        "requirements_path": {
                            "type": "string",
                            "description": (
                                "Relative path under chat dir to requirements markdown. "
                                "Default: plan_pipeline/01_requirements.md"
                            ),
                        },
                        "manifest_path": {
                            "type": "string",
                            "description": (
                                "Relative path under chat dir to pipeline manifest JSON. "
                                "Default: plan_pipeline/00_pipeline_manifest.json"
                            ),
                        },
                        "scope_summary": {
                            "type": "string",
                            "description": (
                                "Optional fallback summary. Canonical requirements are in "
                                "requirements_path (01_requirements.md)."
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
