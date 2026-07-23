from typing import Any

HIL_TOOL_SPEC: dict[str, Any] = {
    "type": "function",
    "function": {
        "name": "hil_tool",
        "description": (
            "Ask the user structured multiple-choice questions via the HIL card UI. "
            "BLOCKS until the user answers (or skips). "
            "ONLY during active execution (todo checklist running) or an active deep-plan "
            "pipeline — not for small one-off tasks (use inline chat instead). "
            "CRITICAL: All arguments inside `payload`, not top-level."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "action": {
                    "type": "string",
                    "enum": ["ask"],
                    "description": "Present one or more questions. Backend blocks until resolved.",
                },
                "request_id": {
                    "type": "string",
                    "description": "Correlation id for logging.",
                },
                "payload": {
                    "type": "object",
                    "properties": {
                        "context": {
                            "type": "string",
                            "enum": ["execution", "deep_plan", "planning_gate"],
                            "description": (
                                "execution: todo checklist active. "
                                "deep_plan: inside DeepPlanOrchestrator stage. "
                                "planning_gate: main-agent arch-shift deep-plan yes/no only."
                            ),
                        },
                        "agent_label": {
                            "type": "string",
                            "description": "Shown in card header, e.g. 'Implementation Agent'.",
                        },
                        "pipeline_id": {
                            "type": "string",
                            "description": "Required when context=deep_plan.",
                        },
                        "stage_id": {
                            "type": "string",
                            "description": "Optional stage slug, e.g. requirement_extraction.",
                        },
                        "questions": {
                            "type": "array",
                            "minItems": 1,
                            "maxItems": 10,
                            "description": (
                                "One or more questions. UI shows pager (1 of N) when length > 1."
                            ),
                            "items": {
                                "type": "object",
                                "properties": {
                                    "question_id": {
                                        "type": "string",
                                        "description": "Stable id, e.g. q_animation_style.",
                                    },
                                    "prompt": {
                                        "type": "string",
                                        "description": "Question text shown to user.",
                                    },
                                    "options": {
                                        "type": "array",
                                        "minItems": 2,
                                        "maxItems": 8,
                                        "items": {
                                            "type": "object",
                                            "properties": {
                                                "id": {"type": "string"},
                                                "label": {"type": "string"},
                                            },
                                            "required": ["id", "label"],
                                            "additionalProperties": False,
                                        },
                                    },
                                    "allow_custom": {
                                        "type": "boolean",
                                        "description": "Show free-text answer. Default true.",
                                    },
                                    "allow_skip": {
                                        "type": "boolean",
                                        "description": "Show Skip for this question. Default true.",
                                    },
                                },
                                "required": ["question_id", "prompt", "options"],
                                "additionalProperties": False,
                            },
                        },
                    },
                    "required": ["context", "agent_label", "questions"],
                    "additionalProperties": False,
                },
            },
            "required": ["action", "request_id", "payload"],
            "additionalProperties": False,
        },
    },
}
