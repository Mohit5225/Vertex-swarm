## TERMINAL OPERATIONS TOOL GUIDANCE

terminal_ops is the unified interface for all shell execution, process management, and diagnostics.
Every call requires: `action`, `request_id`, and `payload`.

---

### KEY RULES

1. **MANDATORY OBSERVATION PHASE (THE EXECUTION CONTRACT)**: The system is asynchronous and non-blocking. When you use `run_command` with the `observe` intent, the command is dispatched and you are returned a `job_id`. For long-running commands, DO NOT poll `get_output` in a tight loop. Instead, launch the command with `observe` intent and STOP calling tools (end your turn). The system will automatically wake you up with a `[System Notification]` when the task completes. Use `await_result` ONLY for very fast commands (< 2 seconds) where you immediately need the output by polling `get_output` once or twice.
2. **STATELESS TERMINAL**: Treat the terminal as entirely stateless. **NEVER issue `cd` or `Set-Location` commands.** Always use the tool's `cwd` parameter to route your command. Relying on past `cd` state will cause failures.
3. **NO CHAINED COMMANDS**: **Do not use `&&` to chain commands**, especially in PowerShell. Emit separate tool calls for individual commands. This ensures isolated retry loops, distinct memory entries, and prevents parsing errors.
4. **IDEMPOTENCY**: Always provide a unique `request_id` for every distinct operation.
5. **RELENTLESS VERIFICATION**: After every file edit, run the appropriate build or test command to verify correctness.
6. **NON-INTERACTIVE FLAGS**: Always use `-y`, `--yes`, `--non-interactive` flags to prevent terminal hangs. If a command does hang waiting for input, use `send_input` to provide it or abort it.
7. **LOCATION INJECTION**: Every `run_command` call accepts a `cwd` parameter inside the `payload`. Always set `cwd` explicitly.
8. **BACKGROUND PROCESSES**: For dev servers or file watchers, use `intent="verify_start"`. The system will wait 2 seconds to ensure the process doesn't immediately crash, and then return success while it runs in the background.
9. **SURGICAL DIAGNOSTICS**: If a build fails, use `get_diagnostics` to get structured errors from the VS Code Problems panel — do not just re-read raw shell output.

---

### ACTIONS REFERENCE

**run_command** — Execute a shell command
- `command` (required): The shell command string
- `cwd` (required): Directory to run in
- `intent` (required):
  - `"await_result"`: For very fast finite commands (< 2 seconds) like `ls` or `cat`. You must poll `get_output` to await completion.
  - `"verify_start"`: For long-running servers. Waits 2 seconds to verify it doesn't crash immediately, then returns.
  - `"observe"`: For long-running finite commands (e.g., tests, builds, installations). Launch it, then stop calling tools to go idle. The system will send you a background event when it completes, at which point you can call `get_output` to read the final result.
- `user_visible`: `true` to show in VS Code terminal panel (default), `false` to run entirely hidden in the background.
- `estimated_duration_seconds`: Help the system orchestrate polling frequency (optional).
- `terminal_context` (required if user_visible is true):
  - `name`: Exact name for this terminal. Be contextual (e.g. `"[Worker] backend"`).
  - `purpose`: The explicit current purpose of this terminal.
  - `will_use_in_future`: Boolean indicating if you plan to reuse this terminal later.
  - `future_usage_reason`: String explaining why it is needed later, or why it can be discarded.
  - `lifecycle_action`: `"auto_delete_after_command"` or `"keep_open_long_term"`.

**get_output** — Retrieve output and status for a job
- `job_id` (required): The job ID returned from `run_command`.
- `offset`: Character offset to start reading from (for pagination of long logs).
- `max_chars`: Max characters to return.

**send_input** — Send text or interrupt to a running job
- `job_id` (required): Target job ID.
- `input_text`: Raw text to send.
- `interrupt`: `true` to send a SIGINT (Ctrl+C) to the job.

**list_jobs** — List all tracked terminal jobs and their status.

**kill_job** — Kill a job by its ID
- `job_id` (required): The job ID to terminate.

**cleanup_output** — Forcibly clear a job from the output buffer and stop tracking it.

**get_diagnostics** — Pull structured errors from the VS Code Problems panel (LSP-native).

**get_state** — Get OS, shell family, CWD, active jobs, and terminals.

**list_terminals** — List all open terminal instances.

**new_terminal** — Create a new named terminal
- `terminal_name`: Name for the new terminal.

**kill_terminal** — Close a terminal and clean up its processes
- `terminal_name`: Terminal to close.

### CONTEXT-AWARE PATH CONSTRUCTION (MANDATORY)

Your context block includes `Terminal CWD`, `Workspace folders`, and `Operating System`. Always use these as your source of truth for paths:

- **DO**: `"cwd": "c:\\Users\\user\\project\\frontend"` — taken directly from workspace context
- **DON'T**: `"cwd": "/workspace/frontend"` — this is a Docker/CI default that does not exist on the user's machine

Path separators follow the OS in your context:
- `win32` → backslash `\` (e.g. `C:\Users\...`)
- `linux` / `darwin` → forward slash `/`

---

### EXAMPLE: Standard Finite Command (Build)

1. Issue the command:
```json
{
  "action": "run_command",
  "request_id": "run_build_1",
  "payload": {
    "command": "npm run build",
    "cwd": "c:\\Users\\user\\project\\frontend",
    "intent": "await_result",
    "user_visible": true,
    "terminal_context": {
      "name": "[Temp] build",
      "purpose": "Running build",
      "will_use_in_future": false,
      "future_usage_reason": "One-off build.",
      "lifecycle_action": "auto_delete_after_command"
    }
  }
}
```
*Wait for response containing `job_id: "job_xyz"`.*

2. Poll for completion:
```json
{
  "action": "get_output",
  "request_id": "poll_build_1",
  "payload": {
    "job_id": "job_xyz"
  }
}
```
*Wait for response. If you used `await_result` for a fast command and `status` is still "running", repeat `get_output`. If you used `observe` for a long command, STOP calling tools until the system notifies you it is completed, then call `get_output` once to check `exit_code` and output.*

### EXAMPLE: Starting a dev server

```json
{
  "action": "run_command",
  "request_id": "start_dev_server_456",
  "payload": {
    "command": "npm run dev",
    "cwd": "c:\\Users\\user\\project\\frontend",
    "intent": "verify_start",
    "user_visible": true,
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
