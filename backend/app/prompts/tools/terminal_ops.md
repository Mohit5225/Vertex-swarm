## TERMINAL OPERATIONS TOOL GUIDANCE

terminal_ops is the unified interface for all shell execution, process management, and diagnostics.
Every call requires: action. Most actions accept additional arguments shown below.

---

### KEY RULES

1. **RELENTLESS VERIFICATION**: After every file edit, run the appropriate build or test command to verify correctness.
2. **NON-INTERACTIVE FLAGS**: Always use `-y`, `--yes`, `--non-interactive` flags to prevent terminal hangs.
3. **LOCATION INJECTION**: Every `run_command` call accepts a `cwd` parameter. The system performs `cd` to this directory before your command. Always set `cwd` explicitly for monorepo operations.
4. **BACKGROUND PROCESSES**: For dev servers or file watchers, use `mode='background'` with `wait_for_pattern` (e.g. `"ready|listening|started"`). The tool returns as soon as the pattern matches and the server keeps running. If background mode fails, diagnose the actual error — do NOT fall back to `mode='blocking'` for a process that does not exit on its own. Blocking a non-terminating process will freeze the session for up to 360 seconds.
5. **SURGICAL DIAGNOSTICS**: If a build fails, use `get_diagnostics` to get structured errors from the VS Code Problems panel — do not just re-read raw shell output.

---

### ACTIONS REFERENCE

**run_command** — Execute a shell command
- `command` (required): The shell command string
- `cwd` (required): Directory to run in
- `mode`: `"blocking"` (default, waits for completion) | `"background"` (returns immediately with PID)
- `timeout_seconds`: Max wait time for blocking mode (default: 360)
- `wait_for_pattern`: Regex string. If provided with a background process, the tool waits until this pattern appears in stdout/stderr before returning. Case-insensitive.
- `terminal_name`: Named terminal instance (default: `"Vertex Worker"`)

**send_input** — Send text or control characters to a running terminal
- `terminal_name`: Target terminal
- `input_text`: Raw text or control character (e.g., `"\u0003"` for Ctrl+C)

**get_output** — Retrieve recent terminal output
- `since_command_id`: Only return output after this command ID

**get_diagnostics** — Pull structured errors from the VS Code Problems panel (LSP-native)
- No additional args required

**get_state** — Get OS, shell family, CWD, and active execution strategy
- No additional args required

**list_processes** — List all background processes started by the agent (amnesia protection)
- No additional args required

**kill_process** — Kill a background process by PID
- `pid` (required): The process ID to terminate

**list_terminals** — List all open terminal instances
- No additional args required

**new_terminal** — Create a new named terminal
- `terminal_name`: Name for the new terminal

**kill_terminal** — Close a terminal and clean up its processes
- `terminal_name`: Terminal to close

### CONTEXT-AWARE PATH CONSTRUCTION (MANDATORY)

Your context block includes `Terminal CWD`, `Workspace folders`, and `Operating System`. Always use these as your source of truth for paths:

- **DO**: `"cwd": "c:\\Users\\user\\project\\frontend"` — taken directly from workspace context
- **DON'T**: `"cwd": "/workspace/frontend"` — this is a Docker/CI default that does not exist on the user's machine

Path separators follow the OS in your context:
- `win32` → backslash `\` (e.g. `C:\Users\...`)
- `linux` / `darwin` → forward slash `/`

---

### EXAMPLE: Starting a dev server and waiting for it to be ready

```
// Terminal CWD from context: "c:\Users\user\project"
// OS from context: win32

terminal_ops({
  action: "run_command",
  command: "npm run dev",
  cwd: "c:\\Users\\user\\project\\frontend",   // ← derived from context, not guessed
  mode: "background",
  wait_for_pattern: "ready|listening|started on port",
  terminal_name: "Dev Server"
})
```

The tool returns as soon as the pattern matches. The server keeps running. Track its PID with `list_processes`.

