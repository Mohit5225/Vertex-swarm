"""LLM service - OpenAI SDK against the active OpenAI-compatible provider."""
import asyncio
import json
import logging
import time
from typing import Any, AsyncIterator, Dict, List
from uuid import uuid4

from openai import AsyncOpenAI

from app.core.config import settings

logger = logging.getLogger(__name__)
context_logger = logging.getLogger("app.context")

_glm_rate_limiter = asyncio.Semaphore(1)
_glm_last_call_time = 0.0
_glm_rate_limit_seconds = 70
_context_log_sequence = 0


def _next_context_log_sequence() -> int:
    global _context_log_sequence
    _context_log_sequence += 1
    return _context_log_sequence


def _log_llm_context_snapshot(
    payload: Dict[str, Any],
    context_log_metadata: Dict[str, Any] | None = None,
) -> None:
    """Persist the exact LLM request context for post-run debugging."""
    snapshot = {
        "sequence": _next_context_log_sequence(),
        "metadata": context_log_metadata or {},
        "payload": payload,
    }
    context_logger.info("LLM_CONTEXT %s", json.dumps(snapshot, ensure_ascii=False, default=str))


WORKSPACE_OPS_TOOL_SPEC: dict[str, Any] = {
    "type": "function",
    "function": {
        "name": "workspace_ops",
        "description": "Perform one workspace operation against the repository.",
        "parameters": {
            "type": "object",
            "properties": {
                "action": {
                    "type": "string",
                    "enum": [
                        "list_dir",
                        "search_text",
                        "read_file",
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
                },
                "payload": {
                    "type": "object",
                    "description": "Arguments for the action.\n- list_dir: {'path': string} (use '.' for root)\n- search_text: {'query': string, 'filePattern'?: string, 'useRegex'?: boolean} (searches CONTENT, not filenames)\n- read_file: {'path': string, 'startLine'?: number, 'endLine'?: number}\n- edit_file: {'path': string, 'edits': array, 'expected_hash': string}\n- create_file: {'path': string, 'content': string}\n- delete_path: {'path': string}\n- rename_path: {'oldPath': string, 'newPath': string}",
                    "properties": {
                        "path": {
                            "type": "string",
                            "description": "The file or directory path. Use '.' or '/' for the root directory. Required for list_dir, read_file, edit_file, create_file, delete_path."
                        },
                        "query": {
                            "type": "string",
                            "description": "The text or regex inside file contents to search for. Required for search_text. DO NOT use this to just search for file names."
                        },
                        "filePattern": {
                            "type": "string",
                            "description": "Glob pattern to limit search_text, e.g. '**/*.py'."
                        },
                        "useRegex": {
                            "type": "boolean",
                            "description": "Whether query is a regex pattern in search_text."
                        },
                        "edits": {
                            "type": "array",
                            "description": "Array of edits. Required for edit_file."
                        },
                        "content": {
                            "type": "string",
                            "description": "File content. Required for create_file."
                        },
                        "oldPath": {
                            "type": "string"
                        },
                        "newPath": {
                            "type": "string"
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
                "command": {
                    "type": "string",
                    "description": "The shell command to run. Required for run_command.",
                },
                "cwd": {
                    "type": "string",
                    "description": "The directory to run the command in. Defaults to workspace root. Required for run_command.",
                },
                "mode": {
                    "type": "string",
                    "enum": ["blocking", "background"],
                    "description": "Whether to wait for completion (blocking) or run in background (returns PID). Defaults to blocking.",
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
            "required": ["action"],
            "additionalProperties": False,
        },
    },
}


def wrap_tool_response_codeforge(
    tool_name: str,
    tool_status: str,
    tool_content: str,
    error_code: str | None = None
) -> str:
    """
    Wrap tool result in CodeForge-compatible format.

    Every tool call response MUST use this wrapper to keep structured tool output
    consistent across model backends.
    
    Args:
        tool_name: e.g., "workspace_ops"
        tool_status: "success" or "error"
        tool_content: The actual output (file content, grep results, bash output, etc.)
        error_code: Optional error identifier (e.g., "ENOENT", "RANGE_TOO_LARGE")
    
    Returns:
        XML-wrapped response matching CodeForge training format
    """
    response_data = {
        "output": tool_content,
        "exit_code": 0 if tool_status == "success" else 1,
    }
    
    if error_code:
        response_data["error_code"] = error_code
    
    return (
        f"<tool_response>\n"
        f"{json.dumps(response_data)}\n"
        f"</tool_response>"
    )


DEVELOPER_ASSISTANT_PERSONA = """You are Vertex, a sharp expert developer assistant embedded directly inside VS Code.

You are an AUTONOMOUS, GOAL-DRIVEN AGENT. Your purpose is not just to answer questions, but to actively accomplish the user's tasks by intelligently chaining tools together until the goal is fully achieved.

CORE EXECUTION MINDSET:
1. TASK DECONSTRUCTION: When given a task (whether it's writing code, debugging a complex issue, or exploring a new codebase), break it down into logical execution steps mentally.
2. CONTINUOUS EXECUTION: Do not expect the user to hold your hand. If you need information, use a tool to get it. If you need to make changes, use tools to apply them.
3. ADAPTIVE ROUTING: Evaluate every tool result immediately. 
   - Did it succeed? Move to the next step of your plan.
   - Did it fail or return unexpected data? Pivot your strategy, try different tools, or gather more context.
4. RELENTLESS FORWARD MOMENTUM: Never stop in the middle of a task unless you are genuinely blocked and need user input. After EVERY tool result, you MUST take the next logical action—either executing another tool to continue your plan, or providing the final comprehensive deliverable to the user.

Rules you always follow:
- Reason step-by-step before answering or taking action
- NEVER GUESS TOOL SYNTAX. If you are unsure, look closely at the action requirements.
- list_dir REQUIRES a valid path parameter (e.g. "." or "src"). DO NOT send empty strings.
- search_text is ONLY for searching file CONTENTS (code, functions, strings). DO NOT use it to search for file names. For filenames, rely on list_dir or your injected workspace context.
- STOP RETRYING FAILED ACTIONS: If a tool call fails or returns empty twice, DO NOT retry the same action. Pivot your strategy immediately. Treat errors as a signal to change course.
- VERIFY WITH CALLERS: When asked to explain a file, you must first read the file, and then immediately use search_text to find where its primary classes/functions are used in the broader codebase to verify its actual context.
- Be direct and precise - no filler, no padding
- When given code, scan it for correctness, security issues, and efficiency first
- Reference specific line numbers and function names when discussing code
- Prefer showing working code over describing it
- NEVER return an empty or silent response. Every turn must contain a tool invocation to continue the workflow, OR your reasoning and next steps, OR the final answer.

TERMINAL OPERATIONS & VERIFICATION PROTOCOL:
1. RELENTLESS VERIFICATION: After every file edit (edit_file), you MUST verify your changes by running the appropriate build or test command (e.g., 'npm test', 'pytest', 'go test', 'cargo build').
2. NON-INTERACTIVE FLAGS: Always use non-interactive flags (e.g., '-y', '--yes', '--non-interactive') to prevent the terminal from hanging on confirmation prompts.
3. LOCATION INJECTION: Every terminal_ops call accepts a 'cwd' parameter. The system automatically performs a 'cd' to this directory before your command. You can rely on this for monorepo operations.
4. BACKGROUND PROCESSES: For dev servers or watchers, use mode='background'. Use 'wait_for_pattern' to pause execution until a specific regex matches the output stream before moving to the next step. Use 'list_processes' to track their PIDs and 'kill_process' to stop them surgically.
5. SURGICAL DIAGNOSTICS: If a build fails, use 'get_diagnostics' to pull high-fidelity errors from the VS Code Problems panel instead of just reading raw shell output."""


def _build_system_prompt(workspace_skeleton: str | None = None) -> str:
    """Build system prompt and optionally inject workspace structure context."""
    if not workspace_skeleton:
        return DEVELOPER_ASSISTANT_PERSONA

    return (
        f"{DEVELOPER_ASSISTANT_PERSONA}\n\n"
        "Workspace Root: provided by extension host\n\n"
        "Project Structure:\n"
        f"{workspace_skeleton}\n\n"
        "[collapsed] folders exist but are intentionally not expanded.\n\n"
        "════════════════════════════════════════════════════════════════════════════\n"
        "WORKSPACE OPERATIONS PHILOSOPHY\n"
        "════════════════════════════════════════════════════════════════════════════\n\n"
        "workspace_ops is the single source of truth for file system mutations. It enforces\n"
        "safety invariants because file consistency is non-negotiable.\n\n"
        "⚠️  HASH-BASED CONCURRENCY PROTOCOL: MANDATORY ENFORCEMENT\n\n"
        "Your job: Every mutation MUST include expected_hash (or expected_version).\n"
        "The hash is your CONTRACT with the file system:\n"
        "  Hash = 'This is what I believe the file contains RIGHT NOW'\n"
        "If the actual file is different, the system REJECTS your edit.\n\n"
        "THE HASHING WORKFLOW (YOU MUST FOLLOW THIS EXACTLY):\n\n"
        "STEP 1: READ THE FILE\n"
        "  Action: read_file\n"
        "  Mode: preview\n"
        "  Payload: { path }\n"
        "  YOU MUST: Extract and STORE the response field 'current_hash'\n"
        "  Example response:\n"
        "    {\n"
        "      \"status\": \"success\",\n"
        "      \"content\": \"file content...\",\n"
        "      \"data\": {\n"
        "        \"current_hash\": \"fnv1a-a1b2c3d4-24\"\n"
        "      }\n"
        "    }\n"
        "  CRITICAL: Save 'fnv1a-a1b2c3d4-24' in your context. You WILL use it in Step 3.\n\n"
        "STEP 2: ANALYZE & PLAN\n"
        "  Decide what edits to make to the file content.\n"
        "  Keep the hash from Step 1 in your mind.\n\n"
        "STEP 3: APPLY THE EDIT\n"
        "  Action: edit_file\n"
        "  Mode: apply (NOT preview)\n"
        "  Payload: {\n"
        "    \"path\": \"file/path\",\n"
        "    \"edits\": [...],\n"
        "    \"expected_hash\": \"fnv1a-a1b2c3d4-24\"  <-- HASH FROM STEP 1\n"
        "  }\n"
        "  CRITICAL: The expected_hash MUST match what you got in Step 1.\n"
        "  DO NOT:                                     DO:\n"
        "  ❌ Omit expected_hash from payload         ✅ Always include it\n"
        "  ❌ Make up a hash                          ✅ Use hash from read response\n"
        "  ❌ Use old hash from previous file read    ✅ Use hash from MOST RECENT read\n"
        "  ❌ Continue if hash is missing             ✅ Stop and log error\n\n"
        "STEP 4: CHECK THE RESULT\n"
        "  Success cases:\n"
        "    Response: { \"status\": \"success\", \"applied\": true }\n"
        "    -> File is now modified. Your edit worked.\n\n"
        "  Conflict cases (FILE CHANGED):\n"
        "    Response: {\n"
        "      \"status\": \"error\",\n"
        "      \"error_code\": \"HASH_CONFLICT\",\n"
        "      \"conflict\": {\n"
        "        \"expected_version\": \"fnv1a-a1b2c3d4-24\",\n"
        "        \"current_version\": \"fnv1a-xyz789ab-30\"\n"
        "      }\n"
        "    }\n"
        "    YOUR ACTION: Go back to STEP 1. Re-read the file completely.\n"
        "    Get the NEW current_hash from the re-read response.\n"
        "    Analyze: Does my edit still make sense with the new content?\n"
        "    If yes: Go to Step 3 again with the NEW hash.\n"
        "    If no: Tell the user the file changed and your edit is no longer valid.\n\n"
        "  Guard error (YOU FORGOT THE HASH):\n"
        "    Response: {\n"
        "      \"status\": \"error\",\n"
        "      \"error_code\": \"MISSING_CONCURRENCY_GUARD\"\n"
        "    }\n"
        "    YOUR ACTION: FATAL ERROR. You did not include expected_hash.\n"
        "    Go back to your STEP 1 response. Extract the hash from 'data.current_hash'.\n"
        "    Retry STEP 3 immediately with that hash in the payload.\n\n"
        "RULES YOU MUST FOLLOW:\n\n"
        "1. NEVER skip Step 1 (read)\n"
        "   You CANNOT assume you know file content. Always read first.\n"
        "   Other agents/users/editors may have changed the file since last read.\n\n"
        "2. NEVER omit expected_hash in Step 3\n"
        "   This is not optional. It is REQUIRED by the protocol.\n"
        "   Including expected_hash proves your edit is based on current file state.\n\n"
        "3. NEVER ignore HASH_CONFLICT\n"
        "   When conflict occurs, ALWAYS re-read (go to Step 1).\n"
        "   Do not retry with the same hash.\n"
        "   Do not give up silently.\n"
        "4. NEVER use preview mode for Step 3\n"
        "   Preview is for checking. Apply is for committing.\n"
        "   Both need the hash, but only apply actually writes.\n\n"
        "5. NEVER assume file position/line numbers are stable\n"
        "   If HASH_CONFLICT occurs, line numbers may have shifted.\n"
        "   Re-read to find the correct line numbers for your edit.\n\n"
        "EXAMPLE OF CORRECT WORKFLOW:\n\n"
        "1. Agent: workspace_ops(read_file, path='app.ts')\n"
        "   Result: content='let x=5', current_hash='fnv1a-abc123-10'\n"
        "   Agent stores: hash='fnv1a-abc123-10'\n\n"
        "2. Agent thinks: 'I need to change x=5 to x=10'\n\n"
        "3. Agent: workspace_ops(edit_file, path='app.ts', expected_hash='fnv1a-abc123-10',\n"
        "                         edits=[{find: '=5', replace: '=10'}])\n"
        "   Result: status='success', applied=true\n"
        "   Agent: File changed successfully.\n\n"
        "EXAMPLE OF INCORRECT WORKFLOW (WILL FAIL):\n\n"
        "1. Agent: workspace_ops(read_file, path='app.ts')\n"
        "   Result: content='let x=5', current_hash='fnv1a-abc123-10'\n"
        "   Agent: (IGNORES the hash)\n\n"
        "2. Agent thinks: 'I need to change x=5 to x=10'\n\n"
        "3. Agent: workspace_ops(edit_file, path='app.ts',\n"
        "                         edits=[{find: '=5', replace: '=10'}])\n"
        "                         (NO expected_hash!)\n"
        "   Result: status='error', error_code='MISSING_CONCURRENCY_GUARD'\n"
        "   Agent: FAILED. You must include expected_hash.\n\n"
        "════════════════════════════════════════════════════════════════════════════\n\n"
        "NON-HASH RULES:\n\n"
        "1. REQUEST_ID IS YOUR IDEMPOTENCY PROMISE\n"
        "   Every tool call has a request_id. If a network timeout occurs and your call\n"
        "   is retried, the same request_id ensures the intent is not duplicated.\n"
        "   Use stable request_ids (derived from the specific action, file, and change).\n"
        "   Not a random UUID per call.\n\n"
        "2. YOU CANNOT ASSUME CONSISTENCY\n"
        "   Two tool calls are not atomic. Code, files, and state can change between them.\n"
        "   Do not build sequences that depend on state remaining constant. Always re-check\n"
        "   before writing. This is how distributed systems work.\n\n"
        "════════════════════════════════════════════════════════════════════════════\n"
        "CODE DISCOVERY PROTOCOL (MANDATORY SEARCH ROUTING)\n"
        "════════════════════════════════════════════════════════════════════════════\n\n"
        "To minimize tokens and find code FAST, ALWAYS follow this discovery routing logic.\n"
        "The key principle: GREP FIRST, READ SECOND.\n\n"
        "ROUTING RULES BY QUERY TYPE:\n\n"
        "1. EXPLICIT FILE READS (User says: 'Read file X' or 'Show me app.ts')\n"
        "   → Skip search. Use read_file(path=X) directly.\n"
        "   → Example user input: 'Read src/config.py'\n"
        "   → Your action: read_file(path='src/config.py', startLine=1, endLine=100)\n\n"
        "2. SYMBOL LOOKUPS (User asks: 'Find function X', 'Where is class Y', 'Show me validateConcurrencyGuard')\n"
        "   → ALWAYS use search_text(query='exact_symbol_name') FIRST (costs ~20 tokens)\n"
        "   → MANDATORY: ALWAYS generate variants for non-builtin symbols using the form:\n"
        "     search_text(query='validateConcurrencyGuard', variants=['validateConcurrencyGuard', 'validate_concurrency_guard', 'ConcurrencyGuard'])\n"
        "     This enables searching across naming conventions (camelCase, snake_case, abbreviated forms).\n"
        "   → Get back file:line:content format (identifies exact location)\n"
        "   → THEN use read_file on the lines returned (costs ~70 tokens)\n"
        "   → Example flow:\n"
        "       User: 'Fix the bug in validateConcurrencyGuard'\n"
        "       Step 1: search_text(query='validateConcurrencyGuard', variants=['validateConcurrencyGuard', 'validate_concurrency_guard', 'ConcurrencyGuard']) \n"
        "               → Returns: 'file-system-service.ts:860: private validateConcurrencyGuard('\n"
        "       Step 2: read_file(path='file-system-service.ts', startLine=850, endLine=920)\n"
        "               → Get full function with context\n"
        "       Total cost: ~90 tokens vs 300+ tokens (3-5 blind reads)\n\n"
        "3. BROAD FEATURE EXPLORATION (User asks: 'How does authentication work?', 'Explain the session flow')\n"
        "   → First: list_dir(path='relevant_folder') to see structure (e.g., 'app/auth')\n"
        "   → Second: search_text with regex patterns (e.g., 'class.*Auth', 'def.*login') to find key files\n"
        "   → Third: read_file on lines 1-100 (imports, interfaces, docstrings) of key files\n"
        "   → Build mental model BEFORE deep dives\n"
        "   → Example flow:\n"
        "       User: 'How does authentication work?'\n"
        "       Step 1: list_dir(path='app/auth') → see: core.py, routes/, dependencies.py, middleware.py\n"
        "       Step 2: search_text(query='class.*Auth|def.*authenticate|jwt', useRegex=true, filePattern='app/auth/**')\n"
        "               → see 15 key locations using regex patterns\n"
        "       Step 3: read_file(path='app/auth/core.py', startLine=1, endLine=100) +\n"
        "               read_file(path='app/auth/routes/auth.py', startLine=1, endLine=100)\n"
        "       → User understands the architecture\n\n"
        "4. REFACTORING / FIND ALL REFERENCES (User says: 'All places that call stream_chat_events', 'Find imports of X')\n"
        "   → Use search_text(query='function_name(', filePattern='**/*') to get all call sites at once\n"
        "   → For each result, read minimal context (5 lines before/after using line numbers)\n"
        "   → This prevents missing references\n"
        "   → Example flow:\n"
        "       User: 'We need to update function X signature everywhere'\n"
        "       Step 1: search_text(query='stream_chat_events(', filePattern='**/*.py')\n"
        "               → Returns 8 call sites with exact line numbers\n"
        "       Step 2: For each line, read_file(path=file, startLine=line-5, endLine=line+5)\n"
        "               → See each call in context\n"
        "       → User can now refactor all 8 locations\n\n"
        "COST PRINCIPLE:\n"
        "  search_text token cost: ~20 tokens (returns file:line:content)\n"
        "  read_file token cost: ~70 tokens per file (actual code)\n"
        "  GREP-FIRST: 20 + 70 = 90 tokens\n"
        "  BLIND READS (no grep): 200 + 200 + 200 = 600 tokens\n"
        "  Savings: 87% token reduction\n\n"
        "CAUTIONARY NOTES:\n"
        "  - Do NOT use search_text for ambiguous keywords like 'error', 'handle', 'data' → too much noise\n"
        "  - DO use search_text for: function names, class names, specific imports, patterns like 'class.*Error'\n"
        "  - Do NOT grep if user explicitly said 'Read file X'\n"
        "  - DO ask for clarification if user query is too vague ('How does it work?' without a topic)\n\n"
        "────────────────────────────────────────────────────────────────────────────\n"
        "AVAILABLE TOOLS:\n"
        "1. workspace_ops(args: object)\n"
        "   Unified workspace tool with one action per call.\n"
        "   Required args: action, request_id, mode, payload.\n"
        "   mode: 'preview' or 'apply'.\n"
        "   Supported actions:\n"
        "   - list_dir: payload { path } → Explore folder structure\n"
        "   - search_text: payload { query, variants?, filePattern?, useRegex? } → DISCOVERY TOOL: Find symbols/patterns across workspace\n"
        "                  Use BEFORE read_file to locate code (grep-first protocol)\n"
        "                  SEMANTIC SYNONYMS (MANDATORY): For ANY non-builtin symbol, ALWAYS provide variants array with:\n"
        "                    - variants[0] = original query (e.g., 'validateConcurrencyGuard')\n"
        "                    - variants[1] = snake_case variant (e.g., 'validate_concurrency_guard')\n"
        "                    - variants[2] = abbreviated/related variant (e.g., 'ConcurrencyGuard' or 'concurrency_check')\n"
        "                  The extension will automatically search naming variants (snake_case, camelCase, etc) for each.\n"
        "                  REGEX SUPPORT: Set useRegex=true to use regex patterns instead of fixed-string matching.\n"
        "                  Example: search_text(query='(async|await).*function', useRegex=true) finds async functions.\n"
        "                  SEARCH RESULT TRIAGE: search_text output is grouped by PRIMARY and SYNONYM variants.\n"
        "                  If PRIMARY has hits, read PRIMARY lines first and avoid synonym reads unless still needed.\n"
        "                  If PRIMARY has zero hits, read SYNONYM lines and explicitly state that interpretation in your reasoning.\n"
        "   - read_file: payload { path, startLine?, endLine? } → Pull actual file content (targeted read after grep)\n"
        "   - edit_file: payload { path, edits:[{startLine,startCol,endLine,endCol,text}] } → Mutate files with hash guard\n"
        "   - create_file: payload { path, content, overwrite? } → Create new files\n"
        "   - delete_path: payload { path, recursive?, useTrash? } → Delete files/folders\n"
        "   - rename_path: payload { oldPath, newPath, overwrite? } → Rename/move files\n\n"
        "   MUTATING ACTIONS (edit_file, create_file, delete_path, rename_path):\n"
        "   Always use 'preview' mode first to verify what will change. Then use 'apply' mode\n"
        "   with expected_hash (from your read) or expected_version. This is your contract\n"
        "   with the file system. Without it, your mutation is rejected.\n\n"
        "   REQUEST_ID STRATEGY:\n"
        "   Use stable request_ids: hash(action + file_path + operation_intent).\n"
        "   Do not generate random UUIDs. The same logical change should have the same ID\n"
        "   across retries. This enables the system to recognize and deduplicate your intent.\n\n"
        "────────────────────────────────────────────────────────────────────────────\n"
        "HANDLING CONFLICTS AND ERRORS:\n\n"
        "ERROR: HASH_CONFLICT\n"
        "  This means: The file changed since you last read it.\n"
        "  Response:\n"
        "    {\n"
        "      \"status\": \"error\",\n"
        "      \"error_code\": \"HASH_CONFLICT\",\n"
        "      \"conflict\": {\n"
        "        \"expected_version\": \"fnv1a-old-hash-here\",\n"
        "        \"current_version\": \"fnv1a-new-hash-here\"\n"
        "      }\n"
        "    }\n"
        "  What to do:\n"
        "    1. Immediately read the file again (go back to STEP 1)\n"
        "    2. Update your understanding of file content\n"
        "    3. Re-evaluate: Is my edit still valid? Does it still make sense?\n"
        "    4. If valid: Adjust line numbers if needed, go to STEP 3 with NEW hash\n"
        "    5. If invalid: Stop and tell user the file changed and conflict can't be resolved\n"
        "ERROR: MISSING_CONCURRENCY_GUARD\n"
        "  This means: You forgot to include expected_hash in your edit_file apply call.\n"
        "  Response:\n"
        "    {\n"
        "      \"status\": \"error\",\n"
        "      \"error_code\": \"MISSING_CONCURRENCY_GUARD\"\n"
        "    }\n"
        "  What to do:\n"
        "    1. Go back to your last read_file response\n"
        "    2. Find the field: data.current_hash\n"
        "    3. Extract the hash value (e.g., 'fnv1a-abc123-24')\n"
        "    4. Immediately retry the edit_file call with expected_hash included\n"
        "    5. If you can't find the hash, re-read the file first\n\n"
        "ERROR: CONFLICTING_CONCURRENCY_GUARDS\n"
        "  This means: You sent both expected_hash AND expected_version but they don't match.\n"
        "  Response:\n"
        "    {\n"
        "      \"status\": \"error\",\n"
        "      \"error_code\": \"CONFLICTING_CONCURRENCY_GUARDS\"\n"
        "    }\n"
        "  What to do:\n"
        "    1. Check your latest read_file response\n"
        "    2. Only use ONE guard: either expected_hash OR expected_version\n"
        "    3. Prefer expected_hash (it comes from the 'current_hash' field)\n"
        "    4. Retry with only one of them\n\n"
        "WHEN FILE OPERATIONS TAKE MULTIPLE STEPS:\n"
        "  If you need to read multiple files or make multiple edits:\n"
        "  - EACH edit needs its own read first with its own hash\n"
        "  - Do not reuse a hash from one file for another file\n"
        "  - Do not reuse a hash from an old read for a new edit\n"
        "  - Always re-read before every edit to get the current hash\n\n"
        "TOOL CALLING FORMAT & EXECUTION LOOP:\n"
        "Use the model's structured tool-call channel for workspace_ops. Do not write tool invocation text in assistant content.\n"
        "1. Identify the overarching goal from the user.\n"
        "2. Execute the necessary tool call(s) for the current step.\n"
        "3. When you receive the tool_result in the subsequent turn, YOU MUST NOT STOP.\n"
        "4. Evaluate the result immediately:\n"
        "   - If the task is incomplete, emit the next required tool call natively.\n"
        "   - If the task is finished entirely, write your final conversational summary to the user.\n"
        "Never output an empty turn after receiving a tool result. You are the architect of the operation; drive it to completion."
    )


def _get_client() -> AsyncOpenAI:
    base_url = _normalize_base_url(settings.llm_base_url)
    return AsyncOpenAI(
        base_url=base_url,
        api_key=settings.llm_api_key,
    )


def _normalize_base_url(base_url: str) -> str:
    normalized_base_url = base_url.strip().rstrip("/")

    if not normalized_base_url:
        return "https://api.us-west-2.modal.direct/v1"

    chat_completions_suffix = "/chat/completions"
    if normalized_base_url.endswith(chat_completions_suffix):
        normalized_base_url = normalized_base_url[: -len(chat_completions_suffix)]

    return normalized_base_url.rstrip("/")


def _model_name(model: str | None = None) -> str:
    return model or settings.llm_model


def _build_request_payload(
    messages: List[Dict[str, Any]],
    workspace_skeleton: str | None = None,
    model: str | None = None,
) -> Dict[str, Any]:
    full_messages: list[Any] = [
        {"role": "system", "content": _build_system_prompt(workspace_skeleton)},
        *messages,
    ]

    payload: Dict[str, Any] = {
        "model": _model_name(model),
        "messages": full_messages,
        "stream": True,
        "tools": [WORKSPACE_OPS_TOOL_SPEC, TERMINAL_OPS_TOOL_SPEC],
        "tool_choice": "auto",
    }

    if settings.llm_reasoning_enabled:
        payload["extra_body"] = {
            "reasoning": {
                "effort": settings.llm_reasoning_effort,
            }
        }

    return payload


def _delta_attr(delta: Any, attr_name: str) -> Any:
    if isinstance(delta, dict):
        return delta.get(attr_name)
    return getattr(delta, attr_name, None)


def _tool_attr(value: Any, attr_name: str) -> Any:
    if isinstance(value, dict):
        return value.get(attr_name)
    return getattr(value, attr_name, None)


def _extract_text_fragments(delta: Any) -> List[str]:
    text_fragments: List[str] = []
    content = _delta_attr(delta, "content")

    if isinstance(content, str):
        return [content]

    if isinstance(content, list):
        for part in content:
            text = getattr(part, "text", None)
            if isinstance(text, str) and text:
                text_fragments.append(text)
                continue

            if isinstance(part, dict):
                part_text = part.get("text")
                if isinstance(part_text, str) and part_text:
                    text_fragments.append(part_text)

    fallback_text = _delta_attr(delta, "text")
    if isinstance(fallback_text, str) and fallback_text:
        text_fragments.append(fallback_text)

    return text_fragments


def _extract_reasoning_fragments(delta: Any) -> List[str]:
    reasoning_fragments: List[str] = []

    for attr_name in ("reasoning", "reasoning_content", "reasoning_text", "thinking"):
        value = _delta_attr(delta, attr_name)

        if isinstance(value, str) and value:
            reasoning_fragments.append(value)
            continue

        if isinstance(value, list):
            for part in value:
                text = getattr(part, "text", None)
                if isinstance(text, str) and text:
                    reasoning_fragments.append(text)
                    continue

                if isinstance(part, dict):
                    part_text = part.get("text")
                    if isinstance(part_text, str) and part_text:
                        reasoning_fragments.append(part_text)

    if not reasoning_fragments:
        reasoning_details = _delta_attr(delta, "reasoning_details")
        if isinstance(reasoning_details, list):
            for item in reasoning_details:
                if not isinstance(item, dict):
                    continue
                for summary in item.get("summary", []):
                    if isinstance(summary, str) and summary:
                        reasoning_fragments.append(summary)

    return reasoning_fragments


def _extract_tool_call_fragments(delta: Any) -> List[Dict[str, Any]]:
    tool_call_fragments: List[Dict[str, Any]] = []
    tool_calls = _delta_attr(delta, "tool_calls")

    if not isinstance(tool_calls, list):
        return tool_call_fragments

    for tool_call in tool_calls:
        function_call = _tool_attr(tool_call, "function")
        tool_call_fragments.append(
            {
                "index": _tool_attr(tool_call, "index"),
                "tool_call_id": _tool_attr(tool_call, "id"),
                "tool_name": _tool_attr(function_call, "name"),
                "arguments": _tool_attr(function_call, "arguments"),
            }
        )

    return tool_call_fragments


def _merge_tool_call_fragment(
    pending_tool_calls: Dict[int, Dict[str, Any]],
    fragment: Dict[str, Any],
) -> None:
    fragment_index = fragment.get("index")
    tool_call_index = fragment_index if isinstance(fragment_index, int) else 0

    pending_tool_call = pending_tool_calls.setdefault(
        tool_call_index,
        {
            "tool_call_id": "",
            "tool_name": "",
            "arguments": "",
        },
    )

    tool_call_id = fragment.get("tool_call_id")
    if isinstance(tool_call_id, str) and tool_call_id:
        pending_tool_call["tool_call_id"] = tool_call_id

    tool_name = fragment.get("tool_name")
    if isinstance(tool_name, str) and tool_name:
        pending_tool_call["tool_name"] = tool_name

    arguments = fragment.get("arguments")
    if isinstance(arguments, str) and arguments:
        pending_tool_call["arguments"] += arguments


def _finalize_pending_tool_calls(
    pending_tool_calls: Dict[int, Dict[str, Any]],
) -> List[Dict[str, Any]]:
    tool_call_events: List[Dict[str, Any]] = []

    for tool_call_index in sorted(pending_tool_calls):
        pending_tool_call = pending_tool_calls[tool_call_index]
        tool_name = pending_tool_call.get("tool_name")
        if not isinstance(tool_name, str) or not tool_name:
            continue

        tool_call_id = pending_tool_call.get("tool_call_id")
        if not isinstance(tool_call_id, str) or not tool_call_id:
            tool_call_id = f"tc_{uuid4().hex[:12]}"

        arguments_text = str(pending_tool_call.get("arguments", "")).strip()
        try:
            arguments = json.loads(arguments_text) if arguments_text else {}
        except json.JSONDecodeError:
            logger.warning("Ignoring malformed structured tool call arguments: %s", arguments_text)
            continue

        if not isinstance(arguments, dict):
            arguments = {}

        tool_call_events.append(
            {
                "type": "tool_call",
                "tool_call_id": tool_call_id,
                "tool_name": tool_name,
                "args": arguments,
            }
        )

    return tool_call_events


async def stream_chat_completion(
    messages: List[Dict[str, Any]],
    workspace_skeleton: str | None = None,
) -> AsyncIterator[str]:
    """
    Stream a chat completion via an OpenAI-compatible API.

    Args:
        messages: List of {"role": "user"|"assistant", "content": "..."} dicts
                  in chronological order.

    Yields:
        Token chunks (str) as they stream from the model.
    """
    client = _get_client()
    stream = await client.chat.completions.create(
        **_build_request_payload(messages, workspace_skeleton)
    )

    async for chunk in stream:
        if not chunk.choices:
            logger.debug("Skipping streamed chunk without choices: %s", chunk)
            continue

        delta = chunk.choices[0].delta
        if not delta:
            continue

        for text in _extract_text_fragments(delta):
            yield text


async def stream_chat_events(
    messages: List[Dict[str, Any]],
    workspace_skeleton: str | None = None,
    model: str | None = None,
    context_log_metadata: Dict[str, Any] | None = None,
) -> AsyncIterator[Dict[str, Any]]:
    """
    Stream model output as structured events.

    The model is expected to emit structured tool calls through the OpenAI-style
    tool_calls channel when workspace_ops is needed.

    Args:
        messages: Chat messages list
        workspace_skeleton: Optional workspace context
        model: Optional model override (defaults to settings.llm_model)

    Yields event dicts with:
      - {"type": "token", "content": "..."}
      - {"type": "thinking", "content": "..."}
      - {"type": "tool_call", "tool_call_id": "...", "tool_name": "...", "args": {...}}
    """
    global _glm_last_call_time
    
    client = _get_client()
    payload = _build_request_payload(messages, workspace_skeleton, model)
    _log_llm_context_snapshot(payload, context_log_metadata)
    
    # Log request details for debugging
    logger.info(
        "Initiating LLM stream: model=%s messages_count=%s has_tools=%s has_reasoning=%s has_extra_body=%s",
        payload.get("model"),
        len(payload.get("messages", [])),
        bool(payload.get("tools")),
        bool(payload.get("reasoning")),
        bool(payload.get("extra_body")),
    )
    
    # Log message roles to debug the conversation structure
    msg_roles = [m.get("role") for m in payload.get("messages", [])]
    logger.debug(
        "Message structure: roles=%s system_prompt_len=%s",
        msg_roles,
        len(payload.get("messages", [{}])[0].get("content", "")) if payload.get("messages") else 0,
    )
    
    try:
        async with _glm_rate_limiter:
            elapsed = time.monotonic() - _glm_last_call_time
            if elapsed < _glm_rate_limit_seconds:
                wait_time = _glm_rate_limit_seconds - elapsed
                logger.info("🔄 %s-second rate limit delay started (waiting %.1f seconds)", _glm_rate_limit_seconds, wait_time)
                await asyncio.sleep(wait_time)
                logger.info("✅ %s-second rate limit delay finished, proceeding with LLM call", _glm_rate_limit_seconds)
            stream = await client.chat.completions.create(**payload)
            _glm_last_call_time = time.monotonic()
        logger.debug("LLM stream established successfully")
    except Exception as stream_init_exc:
        logger.error(
            "Failed to initiate LLM stream: %s",
            str(stream_init_exc),
            exc_info=True,
        )
        raise
    
    pending_tool_calls: Dict[int, Dict[str, Any]] = {}
    saw_structured_tool_call = False
    chunk_count = 0
    text_fragment_count = 0
    thinking_fragment_count = 0
    tool_call_fragment_count = 0
    total_text_chars = 0
    stream_started_at = time.monotonic()

    try:
        async for chunk in stream:
            chunk_count += 1
            if not chunk.choices:
                logger.debug("Skipping streamed chunk without choices: %s", chunk)
                continue

            delta = chunk.choices[0].delta
            if not delta:
                continue

            reasoning_fragments = _extract_reasoning_fragments(delta)
            if reasoning_fragments:
                logger.info(
                    "LLM stream chunk #%d reasoning_fragments=%d reasoning_chars=%d",
                    chunk_count,
                    len(reasoning_fragments),
                    sum(len(fragment) for fragment in reasoning_fragments),
                )

            for reasoning_text in reasoning_fragments:
                if reasoning_text.strip():
                    thinking_fragment_count += 1
                    yield {"type": "thinking", "content": reasoning_text}

            tool_call_fragments = _extract_tool_call_fragments(delta)
            if tool_call_fragments:
                saw_structured_tool_call = True
                tool_call_fragment_count += len(tool_call_fragments)
                logger.info(
                    "LLM stream chunk #%d tool_call_fragments=%d",
                    chunk_count,
                    len(tool_call_fragments),
                )
                for fragment in tool_call_fragments:
                    _merge_tool_call_fragment(pending_tool_calls, fragment)
                continue

            if saw_structured_tool_call:
                continue

            text_fragments = _extract_text_fragments(delta)
            if text_fragments:
                fragment_chars = sum(len(fragment) for fragment in text_fragments)
                total_text_chars += fragment_chars
                logger.info(
                    "LLM stream chunk #%d text_fragments=%d text_chars=%d cumulative_text_chars=%d",
                    chunk_count,
                    len(text_fragments),
                    fragment_chars,
                    total_text_chars,
                )

            for token in text_fragments:
                if token:
                    text_fragment_count += 1
                    yield {"type": "token", "content": token}
    except Exception as stream_exc:
        logger.error(
            "LLM stream iteration failed after %d chunks: %s",
            chunk_count,
            str(stream_exc),
            exc_info=True,
        )
        raise

    logger.info(
        "LLM stream summary chunks=%d text_fragments=%d thinking_fragments=%d tool_call_fragments=%d total_text_chars=%d elapsed_seconds=%.3f saw_structured_tool_call=%s",
        chunk_count,
        text_fragment_count,
        thinking_fragment_count,
        tool_call_fragment_count,
        total_text_chars,
        time.monotonic() - stream_started_at,
        saw_structured_tool_call,
    )

    if saw_structured_tool_call:
        for event in _finalize_pending_tool_calls(pending_tool_calls):
            yield event
        return
