from typing import Any

SPAWN_SUBAGENT_TOOL_SPEC: dict[str, Any] = {
    "type": "function",
    "function": {
        "name": "spawn_subagent",
        "description": (
            "Spawn an isolated child agent for a scoped task. Blocks until the subagent returns or times out. "
            "When the user asks to spawn subagents, CALL THIS TOOL — do not rewrite their deliverable yourself. "
            "Valid uses: (1) user explicitly requested subagents, (2) parallel independent workstreams "
            "(use worktree_path when mutating in parallel), (3) large research or plan-doc work that should stay "
            "out of parent context — the child may read AND write the paths named in prompt. "
            "Do not use for routine one-file edits, or for installs/builds (use terminal_ops with user_visible:false). "
            "After loading this tool, call it promptly with a complete prompt; do not reload tools instead of spawning."
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
                    "description": "Maximum execution time in seconds (default 600, max 900). Use 600–900 for large plan documents.",
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
