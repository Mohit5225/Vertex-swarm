from typing import Any

WORKSPACE_OPS_TOOL_SPEC: dict[str, Any] = {
    "type": "function",
    "function": {
        "name": "workspace_ops",
        "description": "Single unified tool that dispatches all file system operations via an 'action' field. Set action to one of: list_dir, search_text, read_file, bulk_files_read, edit_file, create_file, delete_path, rename_path. Every call requires action, request_id, mode, and payload. CRITICAL: All action-specific arguments (like paths, query, edits) MUST be strictly nested INSIDE the `payload` object, not at the top level.",
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
                                "CRITICAL: targetContent MUST match the file EXACTLY. Watch out for: missing/extra empty lines, indentation shifts (spaces vs tabs), and missing trailing spaces. ALWAYS read the file first to perfectly copy the text. "
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
                        "files": {
                            "type": "array",
                            "description": "Array of files or folders to create. Required for create_file. Limit: max 5 files and max 1 folder per turn. Proactively think in good folder/file practices like good naming, standardized folder structures, etc.",
                            "items": {
                                "type": "object",
                                "properties": {
                                    "path": {"type": "string", "description": "The file or directory path."},
                                    "content": {"type": "string", "description": "Full file content. Omit or leave empty if creating a folder."}
                                },
                                "required": ["path"]
                            }
                        },
                        "content": {
                            "type": "string",
                            "description": "Full file content. (Legacy, use files array for create_file)."
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
