from typing import Any

TERMINAL_OPS_TOOL_SPEC: dict[str, Any] = {
    "type": "function",
    "function": {
        "name": "terminal_ops",
        "description": "Execute terminal commands, manage processes, and get diagnostics. CRITICAL: All action-specific arguments (like command, cwd, intent, user_visible, job_id, terminal_context) MUST be strictly nested INSIDE the `payload` object, not at the top level.",
        "parameters": {
            "type": "object",
            "properties": {
                "action": {
                    "type": "string",
                    "enum": [
                        "run_command",
                        "send_input",
                        "get_output",
                        "get_diagnostics",
                        "get_state",
                        "list_jobs",
                        "kill_job",
                        "cleanup_output",
                        "list_processes",
                        "kill_process",
                        "list_terminals",
                        "new_terminal",
                        "kill_terminal",
                    ],
                    "description": "The terminal action to perform.",
                },
                "request_id": {
                    "type": "string",
                    "description": "Stable idempotency key for retries of the same tool call. NOT a job lookup key — do not pass this as payload.job_id in get_output.",
                },
                "mode": {
                    "type": "string",
                    "enum": ["blocking", "background"],
                    "description": "Deprecated. Use `intent` inside payload instead. Whether to wait for completion (blocking) or run in background (background). Defaults to blocking.",
                },
                "payload": {
                    "type": "object",
                    "description": "Arguments for the action. CRITICAL: You must provide a valid `terminal_context` object inside this payload when action is 'run_command' and user_visible is true.",
                    "properties": {
                        "job_id": {
                            "type": "string",
                            "description": "Required for get_output, kill_job, send_input, cleanup_output. Copy from run_command result data.job_id — NOT the same as request_id.",
                        },
                        "tool_call_id": {
                            "type": "string",
                            "description": "Deprecated fallback for job_id.",
                        },
                        "command": {
                            "type": "string",
                            "description": "The shell command to run. Required for run_command.",
                        },
                        "cwd": {
                            "type": "string",
                            "description": "The directory to run the command in. Defaults to workspace root. Required for run_command.",
                        },
                        "intent": {
                            "type": "string",
                            "enum": ["await_result", "verify_start", "observe"],
                            "description": "REQUIRED on every run_command. Read all three options before choosing — do NOT default to await_result because it is first. 'await_result': ONLY for very fast checks (ls, git status, --version) — may return verification_needed until you confirm via get_output; NEVER for servers, installs, builds, or tests. 'verify_start': REQUIRED for long-running dev servers (npm run dev, python run.py, uvicorn, etc.) — waits 2s for immediate crash, returns running if still alive. 'observe': REQUIRED for finite long work (npm install, pip install, npm run build, pytest) — end your turn; wait for system notification."
                        },
                        "user_visible": {
                            "type": "boolean",
                            "description": "Defaults to false (hidden background child process on all platforms). Set true ONLY when the user must see the process in the VS Code terminal panel — e.g. an interactive dev server they asked to watch. Never use true for installs, builds, tests, diagnostics, or file creation."
                        },
                        "hide": {
                            "type": "boolean",
                            "description": "Alias for user_visible=false. When true, runs the command as a hidden background child process instead of showing a VS Code terminal."
                        },
                        "estimated_duration_seconds": {
                            "type": "integer",
                            "description": "Estimated time this command will take in seconds. REQUIRED for observe and verify_start intents. Optional for await_result."
                        },
                        "terminal_context": {
                            "type": "object",
                            "description": "Mandatory lifecycle and context declaration for this terminal. If unsure about lifecycle, default to keep_open_long_term.",
                            "properties": {
                                "name": {
                                    "type": "string",
                                    "description": "The exact name of the terminal to use or create."
                                },
                                "purpose": {
                                    "type": "string",
                                    "description": "The explicit current purpose of this terminal (e.g. 'Running frontend dev server')."
                                },
                                "will_use_in_future": {
                                    "type": "boolean",
                                    "description": "Set to true if you plan to reuse this terminal later, false if it is single-use."
                                },
                                "future_usage_reason": {
                                    "type": "string",
                                    "description": "If yes, explain why you need it later. If no, explain why it can be discarded."
                                },
                                "lifecycle_action": {
                                    "type": "string",
                                    "enum": ["auto_delete_after_command", "keep_open_long_term"],
                                    "description": "If 'auto_delete_after_command', the system will automatically dispose of the terminal when the command finishes. If 'keep_open_long_term', it remains open until the user or you explicitly delete it."
                                }
                            },
                            "required": ["name", "purpose", "will_use_in_future", "future_usage_reason", "lifecycle_action"],
                            "additionalProperties": False
                        },
                        "terminal_name": {
                            "type": "string",
                            "description": "Target terminal name for actions like new_terminal, kill_terminal.",
                        },
                        "input_text": {
                            "type": "string",
                            "description": "Raw text or control character (e.g. \\u0003 for Ctrl+C) to send. Required for send_input.",
                        },
                        "interrupt": {
                            "type": "boolean",
                            "description": "If true, sends Ctrl+C (SIGINT) equivalent to the running job. Used with send_input."
                        },
                        "offset": {
                            "type": "integer",
                            "description": "The character offset to read from in get_output. Useful for paginated reads."
                        },
                        "max_chars": {
                            "type": "integer",
                            "description": "The maximum number of characters to return in get_output."
                        },
                        "pid": {
                            "type": "integer",
                            "description": "Process ID to target. Deprecated.",
                        }
                    },
                    "additionalProperties": True,
                },
            },
            "required": ["action", "request_id", "payload"],
            "additionalProperties": False,
        },
    },
}
