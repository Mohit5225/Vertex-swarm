from typing import Any

LOAD_TOOL_CONTEXT_TOOL_SPEC: dict[str, Any] = {
    "type": "function",
    "function": {
        "name": "load_tool_context",
        "description": "Loads detailed usage guidance for tool categories into your context. Call this first, before workspace_ops or terminal_ops, to receive the full usage instructions. Load all required categories in one call.",
        "parameters": {
            "type": "object",
            "properties": {
                "categories": {
                    "type": "array",
                    "items": {
                        "type": "string",
                        "enum": ["workspace_ops", "terminal_ops"],
                    },
                    "description": "The tool categories to load. Load all categories you expect to need in one call.",
                }
            },
            "required": ["categories"],
            "additionalProperties": False,
        },
    },
}
