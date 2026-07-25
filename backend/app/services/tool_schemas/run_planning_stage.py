from typing import Any

RUN_PLANNING_STAGE_TOOL_SPEC: dict[str, Any] = {
    "type": "function",
    "function": {
        "name": "run_planning_stage",
        "description": (
            "Run one deep-plan specialist stage (e.g. system_plan). "
            "Vertex pipeline orchestration only — call once per stage from "
            "00_pipeline_manifest.json in order. Blocks until the worker finishes "
            "and writes its plan_pipeline/*.md artifact."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "stage_id": {
                    "type": "string",
                    "description": (
                        "Stage id from requested_stages in plan_pipeline/00_pipeline_manifest.json "
                        "(e.g. system_plan, sdk_practices_audit). Not requirement_extraction or assembly."
                    ),
                },
                "pipeline_id": {
                    "type": "string",
                    "description": "pipeline_id from the stage list JSON and session notebook.",
                },
            },
            "required": ["stage_id", "pipeline_id"],
            "additionalProperties": False,
        },
    },
}
