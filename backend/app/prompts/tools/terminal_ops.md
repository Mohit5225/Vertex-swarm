## TERMINAL OPERATIONS TOOL GUIDANCE

terminal_ops is the unified interface for all shell execution, process management, and diagnostics.
Every call requires: `action`, `request_id`, and `payload`.

**NOT for file writes.** Creating or editing source files is `workspace_ops` (`create_file`, `edit_file`). Never use shell redirection, `echo`, `Set-Content`, `Out-File`, `tee`, or heredocs to write code files.

---

### KEY RULES

1. **DEFAULT IS HIDDEN (ALL PLATFORMS)**: `user_visible` defaults to `false`. Commands run as a hidden background child process on Windows, Linux, and macOS. Output is captured — use `get_output`. Do not open the user's VS Code terminal panel unless they explicitly need to see a long-running server.
2. **MANDATORY OBSERVATION PHASE (THE EXECUTION CONTRACT)**: When you use `run_command` with the `observe` intent, the command is dispatched and you are returned a `job_id`. For long-running commands, DO NOT poll `get_output` in a tight loop. Launch with `observe`, then STOP calling tools (end your turn). The system wakes you with a `[System Notification]` when the task completes.
3. **STATELESS TERMINAL**: **NEVER issue `cd` or `Set-Location` commands.** Always use the `cwd` parameter.
4. **NO CHAINED COMMANDS**: Do not use `&&` to chain commands, especially in PowerShell. One command per tool call.
5. **IDEMPOTENCY**: Always provide a unique `request_id` for every distinct operation.
6. **NON-INTERACTIVE FLAGS**: Always use `-y`, `--yes`, `--non-interactive` to prevent hangs.
7. **LOCATION INJECTION**: Every `run_command` must set `cwd` explicitly from injected workspace context — never guess paths.
8. **SURGICAL DIAGNOSTICS**: Use `get_diagnostics` for structured LSP errors — not raw shell re-reads.

---

### VISIBILITY DECISION MATRIX

| Task | `user_visible` | `intent` | Notes |
|------|----------------|----------|-------|
| `npm install`, `pip install`, `cargo build` | `false` | `observe` | Hidden on all OSes; never pollute user terminal |
| `npm run build`, `pytest`, `npm test` | `false` | `observe` | Read result via `get_output` after notification |
| Quick `ls`, `git status`, version checks | `false` | `await_result` | Poll `get_output` once or twice |
| Dev server user asked to watch (`npm run dev`) | `true` | `verify_start` | Requires `terminal_context`; only when user needs the panel |
| File creation / edits | **Do not use terminal** | — | Use `workspace_ops` |

**`hide: true`** is an alias for `user_visible: false`.

**`terminal_context`** is required only when `user_visible: true`.

---

### ACTIONS REFERENCE

**run_command** — Execute a shell command
- `command` (required): The shell command string
- `cwd` (required): Directory to run in
- `intent` (required):
  - `"await_result"`: Very fast commands (< 2 seconds). Poll `get_output` briefly.
  - `"verify_start"`: Long-running servers. Waits 2s for immediate crash, then returns.
  - `"observe"`: Long-running finite work (installs, builds, tests). End turn; wait for system notification.
- `user_visible`: Default `false`. Set `true` only for dev servers the user must see in the VS Code terminal panel.
- `hide`: Alias for `user_visible: false`.
- `terminal_context` (required only if `user_visible: true`):
  - `name`, `purpose`, `will_use_in_future`, `future_usage_reason`, `lifecycle_action`

**get_output** — Retrieve output for a `job_id`
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

### CONTEXT-AWARE PATH CONSTRUCTION (MANDATORY)

Use injected `Terminal CWD`, `Workspace folders`, and `Operating System`:
- `win32` → `c:\\Users\\...`
- `linux` / `darwin` → `/home/...`
- Never use `/workspace/...` or other CI-style paths on the user's machine.
