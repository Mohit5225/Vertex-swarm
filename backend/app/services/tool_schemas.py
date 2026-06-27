from typing import Any

WORKSPACE_OPS_TOOL_SPEC: dict[str, Any] = {
    "type": "function",
    "function": {
        "name": "workspace_ops",
        "description": "Single unified tool that dispatches all file system operations via an 'action' field. Set action to one of: list_dir, search_text, read_file, bulk_files_read, edit_file, create_file, delete_path, rename_path. Every call requires action, request_id, mode, and payload.",
        "parameters": {
            "type": "object",
            "properties": {
                "action": {
                    "type": "string",
                    "enum": [
                        "list_dir",
                        "search_text",
                        "read_file",
                        "bulk_files_read",
                        "edit_file",
                        "create_file",
                        "delete_path",
                        "rename_path",
                    ],
                },
                "request_id": {
                    "type": "string",
                    "description": "Stable idempotency key for retries of the same tool call.",
                },
                "mode": {
                    "type": "string",
                    "enum": ["preview", "apply"],
                    "description": "Use 'preview' to see what would happen, 'apply' to execute the change."
                },
                "payload": {
                    "type": "object",
                    "description": "Arguments for the action.",
                    "properties": {
                        "path": {
                            "type": "string",
                            "description": "The file or directory path. Use '.' or '/' for the root directory."
                        },
                        "paths": {
                            "type": "array",
                            "items": {"type": "string"},
                            "description": "Array of file paths to read. Required for bulk_files_read."
                        },
                        "query": {
                            "type": "string",
                            "description": "The text or regex inside file contents to search for. Required for search_text."
                        },
                        "multiple_queries": {
                            "type": "array",
                            "items": {"type": "string"},
                            "description": "Array of extra search terms. Use this to search for multiple unrelated terms in a single call to save roundtrips (e.g. ['7999', 'localhost'])."
                        },
                        "filePattern": {
                            "type": "string",
                            "description": "Glob pattern to limit search, e.g. '**/*.py'."
                        },
                        "useRegex": {
                            "type": "boolean",
                            "description": "Whether query is a regex pattern."
                        },
                        "edits": {
                            "type": "array",
                            "description": (
                                "Array of search-and-replace edit blocks. Required for edit_file. "
                                "Each object: {targetContent, replacementContent, startLine, endLine, allowMultiple}. "
                                "- targetContent: The exact string of code to replace, including exact whitespace and indentation. "
                                "- replacementContent: The new code to drop in. "
                                "CRITICAL: Do NOT use placeholders like `// ... rest of code` in replacementContent. Every character in targetContent will be replaced. Placeholders will permanently corrupt the file. "
                                "CRITICAL: Keep targetContent as narrow as possible. Do NOT target an entire 50-line function just to change one variable inside it. Target only the exact lines that need changing to avoid accidentally deleting surrounding code. "
                                "- startLine/endLine: 1-indexed boundaries to limit the search. The tool searches for targetContent ONLY within these lines. "
                                "- allowMultiple: boolean. If false, the tool throws an error if targetContent appears more than once in the range."
                            ),
                            "items": {
                                "type": "object",
                                "properties": {
                                    "targetContent": {"type": "string"},
                                    "replacementContent": {"type": "string"},
                                    "startLine": {"type": "integer"},
                                    "endLine": {"type": "integer"},
                                    "allowMultiple": {"type": "boolean", "default": False}
                                },
                                "required": ["targetContent", "replacementContent", "startLine", "endLine"],
                                "additionalProperties": False,
                            }
                        },
                        "expected_hash": {
                            "type": "string",
                            "description": "The hash of the file content before the edit. Required for edit_file."
                        },
                        "content": {
                            "type": "string",
                            "description": "Full file content. Required for create_file."
                        },
                        "overwrite": {
                            "type": "boolean",
                            "description": "Whether to overwrite existing files. Used in create_file and rename_path."
                        },
                        "recursive": {
                            "type": "boolean",
                            "description": "Whether to perform operation recursively. Required for delete_path on directories."
                        },
                        "useTrash": {
                            "type": "boolean",
                            "description": "Whether to move deleted path to trash instead of permanent deletion."
                        },
                        "oldPath": {
                            "type": "string",
                            "description": "Source path for rename_path."
                        },
                        "newPath": {
                            "type": "string",
                            "description": "Destination path for rename_path."
                        }
                    },
                    "additionalProperties": True,
                },
            },
            "required": ["action", "request_id", "mode", "payload"],
            "additionalProperties": False,
        },
    },
}

TERMINAL_OPS_TOOL_SPEC: dict[str, Any] = {
    "type": "function",
    "function": {
        "name": "terminal_ops",
        "description": "Execute terminal commands, manage processes, and get diagnostics.",
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
                    "description": "Arguments for the action.",
                    "properties": {
                        "command": {
                            "type": "string",
                            "description": "The shell command to run. Required for run_command.",
                        },
                        "cwd": {
                            "type": "string",
                            "description": "The directory to run the command in. Defaults to workspace root. Required for run_command.",
                        },
                        "terminal_name": {
                            "type": "string",
                            "description": "Name of the terminal instance to use. Defaults to 'Vertex Worker'.",
                        },
                        "timeout_seconds": {
                            "type": "integer",
                            "description": "Max time to wait for a blocking command. Default 360.",
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
