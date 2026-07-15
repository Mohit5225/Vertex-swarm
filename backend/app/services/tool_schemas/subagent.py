from typing import Any

SPAWN_SUBAGENT_TOOL_SPEC: dict[str, Any] = {
    "type": "function",
    "function": {
        "name": "spawn_subagent",
        "description": "Spawn a subagent to perform a complex, isolated task. Use this to delegate work that requires significant context or multi-step execution. The tool will block and wait for the subagent to complete, returning its final result.",
        "parameters": {
            "type": "object",
            "properties": {
                "prompt": {
                    "type": "string",
                    "description": "The detailed instructions and context for the subagent to execute."
                },
                "task_type": {
                    "type": "string",
                    "description": "A short category for the task (e.g. 'research', 'refactor', 'test')."
                },
                "timeout": {
                    "type": "integer",
                    "description": "Maximum execution time in seconds (default 300, max 900)."
                }
            },
            "required": ["prompt", "task_type"],
            "additionalProperties": False
        }
    }
}
