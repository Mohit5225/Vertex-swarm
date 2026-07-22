## TERMINAL OPERATIONS TOOL GUIDANCE

terminal_ops is the unified interface for all shell execution, process management, and diagnostics.
Every call requires: `action`, `request_id`, and `payload`.

**NOT for file writes.** Creating or editing source files is `workspace_ops` (`create_file`, `edit_file`). Never use shell redirection, `echo`, `Set-Content`, `Out-File`, `tee`, or heredocs to write code files.

---

### KEY RULES

1. **DEFAULT IS HIDDEN (ALL PLATFORMS)**: `user_visible` defaults to `false`. Commands run as a hidden background child process on Windows, Linux, and macOS. Output is captured — use `get_output`. Do not open the user's VS Code terminal panel unless they explicitly need to see a long-running server.
2. **INTENT IS MANDATORY — PICK THE RIGHT ONE** (read the `intent` field description and decision matrix; do **not** default to `await_result` because it is listed first):
   - **`observe`**: `npm install`, `pip install`, `npm run build`, `pytest`, `cargo build`, any finite long job. End your turn after dispatch; wait for `[System Notification]`.
   - **`verify_start`**: `npm run dev`, `python run.py`, `uvicorn`, any dev server. Use `user_visible: true` only when the user must watch the panel.
   - **`await_result`**: ONLY sub-2-second checks (`ls`, `git status`, `--version`). **FORBIDDEN** for servers, installs, builds, and tests.
   - **Decision checklist before every `run_command`**: (1) Server / long-running? → `verify_start`. (2) Install / build / test (finite, long)? → `observe`. (3) Sub-2s read-only check? → `await_result`.
3. **`verification_needed` / `running` ARE NOT SUCCESS**: `await_result` may return `verification_needed` when a command is still running. `verify_start` / `observe` return `running` when the process survives the verify window. You **MUST** call `get_output` with the `job_id` and read the real output/exit before claiming the command worked. Never tell the user a server is up, a build passed, or a command succeeded until `get_output` (or a system notification for `observe`) confirms it.
4. **MANDATORY OBSERVATION PHASE (THE EXECUTION CONTRACT)**: When you use `run_command` with the `observe` intent, the command is dispatched and you are returned a `job_id`. For long-running commands, DO NOT poll `get_output` in a tight loop. Launch with `observe`, then STOP calling tools (end your turn). The system wakes you with a `[System Notification]` when the task completes.
5. **STATELESS TERMINAL**: **NEVER issue `cd` or `Set-Location` commands.** Always use the `cwd` parameter.
6. **NO CHAINED COMMANDS**: Do not use `&&` to chain commands, especially in PowerShell. One command per tool call.
7. **IDEMPOTENCY**: Always provide a unique `request_id` for every distinct operation.
8. **`request_id` ≠ `job_id`**: `request_id` is your idempotency label for the tool call (e.g. `"start_backend"`). `job_id` is **system-assigned** when `run_command` completes — copy it from the result's `data.job_id`. For `get_output`, `kill_job`, and `send_input`, always use that `data.job_id`. **Never** pass `request_id` as `job_id`.
9. **NON-INTERACTIVE FLAGS**: Always use `-y`, `--yes`, `--non-interactive` to prevent hangs.
10. **LOCATION INJECTION**: Every `run_command` must set `cwd` explicitly from injected workspace context — never guess paths.
11. **SURGICAL DIAGNOSTICS**: Use `get_diagnostics` for structured LSP errors — not raw shell re-reads.

---

### VISIBILITY DECISION MATRIX

| Task | `user_visible` | `intent` | Notes |
|------|----------------|----------|-------|
| `npm install`, `pip install`, `cargo build` | `false` | **`observe`** | Never `await_result`; end turn after dispatch |
| `npm run build`, `pytest`, `npm test` | `false` | **`observe`** | Read result via `get_output` after notification |
| Quick `ls`, `git status`, version checks | `false` | `await_result` | Then **must** `get_output` — dispatch alone is `verification_needed` |
| Start backend/frontend servers (`python run.py`, `npm run dev`) | `true` only if user must watch | **`verify_start`** | Never `await_result`; never claim "servers are up" without `get_output` |
| File creation / edits | **Do not use terminal** | — | Use `workspace_ops` |

**`hide: true`** is an alias for `user_visible: false`.

**`terminal_context`** is required only when `user_visible: true`.

---

### ACTIONS REFERENCE

**run_command** — Execute a shell command
- `command` (required): The shell command string
- `cwd` (required): Directory to run in
- `intent` (required):
  - `"await_result"`: **Only** sub-2-second checks. May return `verification_needed` if still running — you **must** call `get_output` before reporting outcome. **Never** use for servers, installs, builds, or tests.
  - `"verify_start"`: **Required** for long-running dev servers. Waits 2s for immediate crash; returns `running` if still alive — still verify with `get_output` before claiming the server is healthy.
  - `"observe"`: **Required** for installs, builds, tests, and other finite long work. Returns `running` after verify window if still going. End turn; wait for system notification; then `get_output`.
- `estimated_duration_seconds` (required for `observe` and `verify_start`; optional for `await_result`): Your estimate of how long the command will take. Do not omit for long jobs.
- `user_visible`: Default `false`. Set `true` only for dev servers the user must see in the VS Code terminal panel.
- `hide`: Alias for `user_visible: false`.
- `terminal_context` (required only if `user_visible: true`):
  - `name`, `purpose`, `will_use_in_future`, `future_usage_reason`, `lifecycle_action`

**get_output** — Retrieve output for a `job_id`
- `job_id` (required in payload): Copy from the prior `run_command` result `data.job_id`. **Not** the same as `request_id`. If unsure, call `list_jobs` or `get_state`.
**send_input** — Send text or Ctrl+C to a running job
**list_jobs** / **kill_job** / **cleanup_output** — Job lifecycle
**get_diagnostics** — VS Code Problems panel (LSP)
**get_state** — OS, shell, jobs, terminals

---

### EXAMPLES

**Hidden package install (preferred default):**
```json
{
  "action": "run_command",
  "request_id": "install_deps_1",
  "payload": {
    "command": "npm install",
    "cwd": "c:\\Users\\user\\project\\frontend",
    "intent": "observe",
    "user_visible": false
  }
}
```

**Hidden build:**
```json
{
  "action": "run_command",
  "request_id": "run_build_1",
  "payload": {
    "command": "npm run build",
    "cwd": "c:\\Users\\user\\project\\frontend",
    "intent": "observe",
    "user_visible": false
  }
}
```

**Visible dev server (only when user needs the panel):**
```json
{
  "action": "run_command",
  "request_id": "start_dev_server_1",
  "payload": {
    "command": "npm run dev",
    "cwd": "c:\\Users\\user\\project\\frontend",
    "intent": "verify_start",
    "user_visible": true,
    "terminal_context": {
      "name": "[Worker] frontend-dev",
      "purpose": "Running frontend dev server for user visibility",
      "will_use_in_future": true,
      "future_usage_reason": "User needs HMR logs in the terminal panel.",
      "lifecycle_action": "keep_open_long_term"
    }
  }
}
```

**Poll output after `run_command` (use `data.job_id` from the result, not `request_id`):**
```json
{
  "action": "get_output",
  "request_id": "check_backend_output_1",
  "payload": {
    "job_id": "<copy data.job_id from run_command result>"
  }
}
```

### CONTEXT-AWARE PATH CONSTRUCTION (MANDATORY)

Use injected `Terminal CWD`, `Workspace folders`, and `Operating System`:
- `win32` → `c:\\Users\\...`
- `linux` / `darwin` → `/home/...`
- Never use `/workspace/...` or other CI-style paths on the user's machine.
