## TERMINAL OPERATIONS TOOL GUIDANCE

terminal_ops is the unified interface for all shell execution, process management, and diagnostics.
Every call requires: `action`, `request_id`, `mode`, and `payload`.

---

### KEY RULES

1. **MANDATORY OBSERVATION PHASE (THE EXECUTION CONTRACT)**: Execution Lifecycle: Planning Phase → Execution Phase → Observation Phase → Reasoning Phase. You MUST NOT skip Observation. Never assume a command succeeded just because it was issued. You MUST read the `exit_code` and `output_tail` returned in the Execution Object before claiming a task is done. Commands are intentions; successful observations are facts.
2. **STATELESS TERMINAL**: Treat the terminal as entirely stateless. **NEVER issue `cd` or `Set-Location` commands.** Always use the tool's `cwd` parameter to route your command. Relying on past `cd` state will cause failures when terminals restart or fallback processes are used.
3. **NO CHAINED COMMANDS**: **Do not use `&&` to chain commands**, especially in PowerShell. Emit separate tool calls for individual commands. This ensures isolated retry loops, distinct memory entries, and prevents parsing errors.
4. **IDEMPOTENCY**: Always provide a unique `request_id` for every distinct operation.
5. **RELENTLESS VERIFICATION**: After every file edit, run the appropriate build or test command to verify correctness.
6. **NON-INTERACTIVE FLAGS**: Always use `-y`, `--yes`, `--non-interactive` flags to prevent terminal hangs.
7. **LOCATION INJECTION**: Every `run_command` call accepts a `cwd` parameter inside the `payload`. The system handles the directory state before your command. Always set `cwd` explicitly.
8. **BACKGROUND PROCESSES**: For dev servers or file watchers, use `mode='background'` with `wait_for_pattern` (e.g. `"ready|listening|started"`). The tool returns as soon as the pattern matches and the server keeps running. If background mode fails, diagnose the actual error — do NOT fall back to `mode='blocking'` for a process that does not exit on its own. Blocking a non-terminating process will freeze the session for up to 360 seconds.
9. **SURGICAL DIAGNOSTICS**: If a build fails, use `get_diagnostics` to get structured errors from the VS Code Problems panel — do not just re-read raw shell output.

---

### ACTIONS REFERENCE

**run_command** — Execute a shell command
- `command` (required): The shell command string
- `cwd` (required): Directory to run in
- `mode`: `"blocking"` (default, waits for completion) | `"background"` (returns immediately with PID)
- `timeout_seconds`: Max wait time for blocking mode (default: 360)
- `wait_for_pattern`: Regex string. If provided with a background process, the tool waits until this pattern appears in stdout/stderr before returning. Case-insensitive.
- `terminal_context` (required): Deterministic intent declaration object:
  - `name`: Exact name for this terminal. Be contextual (e.g. `"[Worker] backend"`).
  - `purpose`: The explicit current purpose of this terminal.
  - `will_use_in_future`: Boolean indicating if you plan to reuse this terminal later.
  - `future_usage_reason`: String explaining why it is needed later, or why it can be discarded.
  - `lifecycle_action`: `"auto_delete_after_command"` (system auto-disposes terminal when command finishes) or `"keep_open_long_term"` (terminal remains open). If unsure, default to `"keep_open_long_term"`.

**send_input** — Send text or control characters to a running terminal
- `terminal_name`: Target terminal name
- `input_text`: Raw text or control character (e.g., `"\u0003"` for Ctrl+C)

**get_output** — Retrieve recent terminal output
- `tool_call_id` (required): The specific tool_call_id returned in the run_command Execution Object metadata.

**get_diagnostics** — Pull structured errors from the VS Code Problems panel (LSP-native)
- No additional payload required

**get_state** — Get OS, shell family, CWD, and active execution strategy
- No additional payload required

**list_processes** — List all background processes started by the agent (amnesia protection)
- No additional payload required

**kill_process** — Kill a background process by PID
- `pid` (required): The process ID to terminate

**list_terminals** — List all open terminal instances
- No additional payload required

**new_terminal** — Create a new named terminal
- `terminal_name`: Name for the new terminal

**kill_terminal** — Close a terminal and clean up its processes
- `terminal_name`: Terminal to close

### CONTEXT-AWARE PATH CONSTRUCTION (MANDATORY)

Your context block includes `Active Terminals State`, `Terminal CWD`, `Workspace folders`, and `Operating System`. Always use these as your source of truth for paths and terminal names:

- **DO**: `"cwd": "c:\\Users\\user\\project\\frontend"` — taken directly from workspace context
- **DON'T**: `"cwd": "/workspace/frontend"` — this is a Docker/CI default that does not exist on the user's machine

Path separators follow the OS in your context:
- `win32` → backslash `\` (e.g. `C:\Users\...`)
- `linux` / `darwin` → forward slash `/`

---

### EXAMPLE: Starting a dev server and waiting for it to be ready

```json
{
  "action": "run_command",
  "request_id": "start_dev_server_456",
  "mode": "background",
  "payload": {
    "command": "npm run dev",
    "cwd": "c:\\Users\\user\\project\\frontend",
    "wait_for_pattern": "ready|listening|started on port",
    "terminal_context": {
      "name": "[Worker] frontend-dev",
      "purpose": "Running frontend dev server",
      "will_use_in_future": true,
      "future_usage_reason": "I will need this terminal running continuously for HMR.",
      "lifecycle_action": "keep_open_long_term"
    }
  }
}
```

### EXAMPLE: Running a short-lived diagnostic command

```json
{
  "action": "run_command",
  "request_id": "check_directory_789",
  "mode": "blocking",
  "payload": {
    "command": "dir",
    "cwd": "c:\\Users\\user\\project",
    "terminal_context": {
      "name": "[Temp] dir-check",
      "purpose": "Checking directory contents",
      "will_use_in_future": false,
      "future_usage_reason": "This is a one-off command. Terminal is not needed after execution.",
      "lifecycle_action": "auto_delete_after_command"
    }
  }
}
```

The tool enforces deterministic behavior based on your context. When `auto_delete_after_command` is specified, the terminal is physically destroyed the millisecond the command ends to prevent clutter.
