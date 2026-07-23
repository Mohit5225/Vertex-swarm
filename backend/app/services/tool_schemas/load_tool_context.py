from typing import Any

LOAD_TOOL_CONTEXT_TOOL_SPEC: dict[str, Any] = {
    "type": "function",
    "function": {
        "name": "load_tool_context",
        "description": (
            "Loads tool context for one or more categories: usage guidance and the tool "
            "schema become available together. You cannot call a tool until its category "
            "is loaded. "
            "CRITICAL: Do NOT call this for meta questions, capability checks, or exploration. "
            "Load only when you will immediately use that category. Default: load nothing. "
            "Never load workspace_ops or terminal_ops just to answer what tools exist."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "categories": {
                    "type": "array",
                    "items": {
                        "type": "string",
                        "enum": [
                            "workspace_ops",
                            "terminal_ops",
                            "plan_tool",
                            "todo_tool",
                            "web_search",
                            "spawn_subagent",
                            "hil_tool",
                        ],
                    },
                    "description": (
                        "Tool categories to load. Only categories you will use in this task — "
                        "one minimum set, no extras. Do not load terminal_ops for file-only work. "
                        "Do not load anything if the user only asked a question you can answer in chat."
                    ),
                }
            },
            "required": ["categories"],
            "additionalProperties": False,
        },
    },
}
