from typing import Any

SPAWN_SUBAGENT_TOOL_SPEC: dict[str, Any] = {
    "type": "function",
    "function": {
        "name": "spawn_subagent",
        "description": (
            "Spawn an isolated child agent for a narrowly scoped task. Blocks until the subagent returns. "
            "USE SPARINGLY — default to doing the work yourself with workspace_ops and hidden terminal_ops. "
            "Valid uses: (1) parallel independent workstreams where each needs its own git worktree_path, "
            "(2) large read-only research that would bloat parent context, "
            "(3) user explicitly requested a separate exploration branch. "
            "DO NOT use for: file creation/editing (use workspace_ops), package installs or builds (use hidden terminal_ops), "
            "routine sequential plan steps, or because another tool feels slow. "
            "Never spawn a subagent to work around terminal visibility — use user_visible:false instead."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "prompt": {
                    "type": "string",
                    "description": "Detailed instructions and context for the subagent. Include paths, constraints, and the exact deliverable expected back.",
                },
                "task_type": {
                    "type": "string",
                    "description": "Short category label (e.g. 'parallel-refactor', 'research'). Not a substitute for a clear prompt.",
                },
                "timeout": {
                    "type": "integer",
                    "description": "Maximum execution time in seconds (default 300, max 900).",
                },
                "worktree_path": {
                    "type": "string",
                    "description": (
                        "Absolute path to an isolated git worktree. REQUIRED when spawning multiple subagents in parallel "
                        "so they do not conflict. Omit only for read-only research with no file mutations."
                    ),
                },
            },
            "required": ["prompt", "task_type"],
            "additionalProperties": False,
        },
    },
}
