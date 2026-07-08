from typing import Any

TERMINAL_OPS_TOOL_SPEC: dict[str, Any] = {
    "type": "function",
    "function": {
        "name": "terminal_ops",
        "description": "Execute terminal commands, manage processes, and get diagnostics. CRITICAL: All action-specific arguments (like command, cwd, tool_call_id, terminal_context) MUST be strictly nested INSIDE the `payload` object, not at the top level.",
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
                    "description": "Stable idempotency key for retries of the same tool call.",
                },
                "mode": {
                    "type": "string",
                    "enum": ["blocking", "background"],
                    "description": "Whether to wait for completion (blocking) or run in background (background). Defaults to blocking.",
                },
                "payload": {
                    "type": "object",
                    "description": "Arguments for the action. CRITICAL: You must provide a valid `terminal_context` object inside this payload when action is 'run_command'.",
                    "properties": {
                        "tool_call_id": {
                            "type": "string",
                            "description": "The tool_call_id of the command you want to retrieve output for. Required for get_output.",
                        },
                        "command": {
                            "type": "string",
                            "description": "The shell command to run. Required for run_command.",
                        },
                        "cwd": {
                            "type": "string",
                            "description": "The directory to run the command in. Defaults to workspace root. Required for run_command.",
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
                        "timeout_seconds": {
                            "type": "integer",
                            "description": "Max time to wait for a blocking command. Default 360.",
                        },
                        "terminal_name": {
                            "type": "string",
                            "description": "Target terminal name for actions like send_input, new_terminal, kill_terminal.",
                        },
                        "input_text": {
                            "type": "string",
                            "description": "Raw text or control character (e.g. \\u0003 for Ctrl+C) to send. Required for send_input.",
                        },
                        "pid": {
                            "type": "integer",
                            "description": "Process ID to target. Required for kill_process.",
                        },
                        "wait_for_pattern": {
                            "type": "string",
                            "description": "Optional regex pattern. If provided, the command will run in the background, and the tool will pause until this pattern is detected in the output stream before returning.",
                        },
                        "since_command_id": {
                            "type": "string",
                            "description": "Filter output to only show text emitted after this command ID in get_output.",
                        },
                    },
                    "additionalProperties": True,
                },
            },
            "required": ["action", "request_id", "mode", "payload"],
            "additionalProperties": False,
        },
    },
}
