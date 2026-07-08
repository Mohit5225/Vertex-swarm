from typing import Any

WEB_SEARCH_TOOL_SPEC: dict[str, Any] = {
    "type": "function",
    "function": {
        "name": "web_search",
        "description": "Perform a web search using Exa API to find information, documentation, or code examples. Retrieves highlights.",
        "parameters": {
            "type": "object",
            "properties": {
                "query": {
                    "type": "string",
                    "description": "The search query."
                },
                "num_results": {
                    "type": "integer",
                    "description": "Number of results to return (max 10, default 5)."
                }
            },
            "required": ["query"],
            "additionalProperties": False
        }
    }
}
