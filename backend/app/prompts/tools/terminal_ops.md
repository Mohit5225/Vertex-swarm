## TERMINAL OPERATIONS TOOL GUIDANCE

terminal_ops is the unified interface for all shell execution, process management, and diagnostics.
Every call requires: action. Most actions accept additional arguments shown below.

---

### KEY RULES

1. **RELENTLESS VERIFICATION**: After every file edit, run the appropriate build or test command to verify correctness.
2. **NON-INTERACTIVE FLAGS**: Always use `-y`, `--yes`, `--non-interactive` flags to prevent terminal hangs.
3. **LOCATION INJECTION**: Every `run_command` call accepts a `cwd` parameter. The system performs `cd` to this directory before your command. Always set `cwd` explicitly for monorepo operations.
4. **BACKGROUND PROCESSES**: For dev servers or file watchers, use `mode='background'`. Use `wait_for_pattern` to pause until the server is ready (e.g., pattern `"Ready|Listening|started"`). Use `list_processes` to track PIDs. Use `kill_process` to stop them without closing the terminal.
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

---

### EXAMPLE: Starting a dev server and waiting for it to be ready

```
terminal_ops({
  action: "run_command",
  command: "npm run dev",
  cwd: "/workspace/frontend",
  mode: "background",
  wait_for_pattern: "ready|listening|started on port",
  terminal_name: "Dev Server"
})
```

The tool returns as soon as the pattern matches. The server keeps running. Track its PID with `list_processes`.
