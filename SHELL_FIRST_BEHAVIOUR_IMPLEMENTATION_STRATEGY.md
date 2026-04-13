# Shell First Behaviour Implementation Strategy

## 1. Purpose

This document defines the full implementation strategy for shell-first search behavior in the extension, including:

- How `search_text` in extension tooling moves from manual file scan to shell command execution.
- How shell operations are emitted live to frontend chat timeline.
- What backend changes are required now versus optional next phase changes.
- How to keep reliability, safety, and cross-platform behavior while preserving Codex-like transparency.

This is based on current code in:

- `extension/src/tools/file-system-service.ts`
- `extension/src/tools/tool-executor.ts`
- `extension/src/chat-runtime.ts`
- `extension/src/sse-client/stream.ts`
- `extension/frontend/src/store/chatStore.ts`
- `extension/frontend/src/components/AgentTimeline.tsx`
- `extension/frontend/src/lib/trace.ts`
- `backend/app/api/v1/chat.py`
- `backend/app/schemas/tool.py`

## 2. Current Baseline (Verified)

### 2.1 Search implementation today

In `extension/src/tools/file-system-service.ts`, `search_text` currently calls `grep_workspace(query, filePattern, context)`.

Current `grep_workspace` behavior:

1. Uses `vscode.workspace.findFiles`.
2. Reads each file with `workspace.fs.readFile`.
3. Splits into lines and does `includes` match.
4. Returns plain `file:line:snippet` list.

Current hard limits include:

- `maxGrepResults = 50`
- `maxGrepFileScanBytes = 500000`

This is not shell-first and does not expose live command execution.

### 2.2 Event streaming today

Current event flow:

1. Backend SSE emits events (`status`, `thinking`, `token`, `tool_call`, `tool_result`).
2. Extension normalizes SSE in `extension/src/sse-client/stream.ts`.
3. Extension posts events to webview in `extension/src/chat-runtime.ts`.
4. Frontend store ingests events in `frontend/src/store/authStore.ts` and `chatStore.ts`.
5. Timeline renders event summaries/details in `AgentTimeline.tsx` and `lib/trace.ts`.

There is no dedicated shell command event type yet.

### 2.3 Request context today

`chat-participant.ts` currently sends:

- active file path/language/selection
- active terminal name
- workspace folders

No shell type and no terminal output stream are currently captured.

## 3. Target Product Behavior

We want Codex-like shell-first discovery behavior such as:

- `rg --files . | rg -i "northstar|north_star|north star"`
- `rg -n -i "north\\s*star|northstar" .`

and we want it visible in chat UI as live operational steps.

### 3.1 High-level goals

1. `search_text` executes shell command plans first.
2. Shell command and progress are visible live in frontend timeline.
3. Search still returns deterministic tool result payload for backend/LLM loop.
4. If shell path fails, fallback path is deterministic and safe.
5. WE NEED TO PRESENT SHELL 

## 4. Architecture Decision

## 4.1 Decision A: Shell-first inside extension host

Primary path:

- Execute shell commands from extension host for `search_text`.
- Keep this inside `workspace_ops` tool action.

Reason:

- Matches Codex-like behavior.
- Keeps command execution next to filesystem context and existing tool contract.

## 4.2 Decision B: Live shell event emission from extension runtime

For v1, emit live shell events directly from extension to frontend webview.

Reason:

- No backend protocol change required for immediate live UX.
- Lowest latency for command start/output/end display.

## 4.3 Decision C: Backend remains authoritative for final tool result

Final `ToolResult` still goes through `/api/v1/tools/result`.

Reason:

- Preserves existing LLM tool loop and session isolation path.
- No change to tool result persistence protocol required for base rollout.

## 5. Detailed Implementation Plan

## 5.1 Extension: search_text shell-first engine

Target file: `extension/src/tools/file-system-service.ts`

### 5.1.1 Add search payload parser

Add parser for v1 fields under `payload`:

- `query` (required)
- `exactMatch` (default false)
- `filePattern` (default `**/*`)
- `includeGlobs` (optional)
- `excludeGlobs` (default list)
- `caseSensitive` (default false)
- `maxResults` (fixed to 20)
- `maxSearchCalls` (fixed to 2)
- `timeoutMs` (fixed to 20000)
- `variantsEnabled` (default true unless exactMatch=true)
- `maxSynonymTerms` (fixed to 4)
- `includeSearchPlan` (default true)

Even if caller passes different values, enforce fixed caps for `maxResults`, `maxSearchCalls`, `timeoutMs`, `maxSynonymTerms`.

### 5.1.2 Regex safety policy

Before command generation:

- If `exactMatch=true`, escape user text and do literal-safe search only.
- If regex mode:
  - block backreferences: `\\1`, `\\2`, etc.
  - block lookbehind: `(?<=`, `(?<!)`
  - block nested unbounded quantifiers patterns like `(.*)+`, `(.+)+`
  - enforce:
    - max pattern length 180
    - max alternation terms 12
    - max wildcard segments 6
- If blocked or invalid, downgrade pass to escaped literal search.

### 5.1.3 Pass planner (max 2 passes)

Pass 1: precision pattern from query.

Pass 2: expanded variants if allowed and still under result limit.

Return plan metadata:

- pass index
- generated pattern
- term variants used
- downgraded-to-literal flag

### 5.1.4 Shell command builder

Build shell command text plus executable strategy per shell family:

- PowerShell
- bash/zsh
- cmd (fallback)

The command should include:

- recursive search root `.`
- line numbers
- case flags
- glob include/exclude
- max result cap

Example command patterns:

PowerShell:

- `rg --files . | rg -i "northstar|north_star|north star"`
- `rg -n -i "north\\s*star|northstar" .`

POSIX shell:

- `rg --files . | rg -i 'northstar|north_star|north star'`
- `rg -n -i 'north\\s*star|northstar' .`

Implementation detail:

- Construct shell-safe escaped command strings per shell adapter.
- Keep generated display command exactly what frontend should show.

### 5.1.5 Command execution and timeout

Add helper:

- `runShellCommand(commandPlan, cwd, timeoutMs)`

Requirements:

- hard timeout with process kill at 20000 ms
- capture stdout/stderr
- capture exit code and duration
- bounded output buffer
- parse hit lines in `path:line:text` format

### 5.1.6 Fallback path

Fallback order:

1. shell execution failure / timeout / missing rg
2. fallback to existing in-process scan logic

Return metadata field `backendUsed`:

- `shell` or `manual_fallback`

### 5.1.7 Final result envelope

`content`:

- newline-joined `path:line:snippet` capped to 20

`data`:

- request parameters used
- per pass execution details
- total duration
- total raw hits and deduped hits
- unique files matched
- limit hit flag
- shell command display list

## 5.2 Extension: live shell event emission

### 5.2.1 New event types

Extend event union in:

- `extension/src/types/index.ts`
- `extension/frontend/src/store/chatStore.ts`
- `frontend/src/store/authStore.ts` (restore mapping type unions)

Add types:

- `shell_op_start`
- `shell_op_output`
- `shell_op_end`

Metadata shape:

- `op_id`
- `tool_call_id`
- `shell_type`
- `cwd`
- `command`
- `pass_index`
- `stream` (`stdout` or `stderr` for output events)
- `exit_code` and `duration_ms` (end event)

### 5.2.2 Progress emitter wiring

Current `FileSystemService` has no event callback.

Add progress callback flow:

1. Define `ToolExecutionProgressEmitter` interface.
2. Pass emitter from `chat-runtime -> tool-executor -> file-system-service`.
3. During shell command run, emit:
   - start event before spawn
   - output chunk events while reading stdout/stderr
   - end event after completion/timeout

### 5.2.3 Runtime posting to webview

In `chat-runtime.ts`, post local shell events using existing bridge:

- `this.post({ type: 'event', payload: sessionEvent })`

This lets UI show shell operations immediately without waiting for backend.

## 5.3 Frontend timeline rendering

### 5.3.1 trace logic

Update `frontend/src/lib/trace.ts`:

- title mapping:
  - `shell_op_start` -> `Shell Command Started`
  - `shell_op_output` -> `Shell Output`
  - `shell_op_end` -> `Shell Command Finished`
- summary generation from metadata
- detail rendering for command text, output chunk, exit status

### 5.3.2 timeline visuals

Update `frontend/src/components/AgentTimeline.tsx`:

- event icon/color mapping for shell events
- shell output detail blocks with monospaced style
- collapse behavior for repeated output chunks

### 5.3.3 store behavior

Update `chatStore.ts` append rules:

- do not merge shell output with assistant markdown response
- keep shell ops in process timeline only
- still allow `output` token stream to build final response content

## 5.4 Backend changes needed

## 5.4.1 Required backend changes for v1

Strictly required for shell-first + live UI in current single-client webview flow:

- None.

Reason:

- Live shell events can be emitted locally by extension directly to webview.
- Final tool result contract already supports structured `data`.

## 5.4.2 Recommended backend changes (v1.5)

If we want persistence/replay/cross-client consistency:

1. Add optional shell trace persistence in tool result `data`.
2. In `backend/app/api/v1/chat.py`, optionally project shell trace entries into stored `events` for replay.
3. Add explicit event type allowlist expansion for shell event categories in frontend hydration mapping.

## 5.4.3 Optional backend changes (v2 full duplex)

For true backend-mediated live shell streaming:

1. New endpoint: `/api/v1/tools/progress`.
2. Redis progress stream keyed by session/chat/message/tool_call.
3. `chat.py` wait loop multiplexes progress events and final tool_result.
4. SSE forwards progress events to frontend.

This is more complex but gives multi-client synchronized live shell output.

## 6. Shell Type Awareness Strategy

We should support shell awareness without hard dependency on reading user terminal output.

### 6.1 Detection priority

1. extension host platform (Windows vs Linux/macOS)
2. VS Code terminal default profile settings
3. active terminal metadata name
4. fallback defaults:
   - Windows: PowerShell
   - Linux/macOS: bash

### 6.2 Why this works

- For command generation, shell family matters mostly for quoting and pipes.
- We do not need full terminal scrollback access to run deterministic commands.

### 6.3 Context propagation

Extend request context payload to include optional shell descriptor:

- `activeTerminal.shellType`
- `activeTerminal.profileName`

Backend can include this in system context text for model routing.

## 7. Security and Reliability Guardrails

1. Never concatenate raw user input directly into shell command string without shell-specific escaping.
2. Enforce command timeout (20000 ms).
3. Enforce max output bytes and max parsed results (20).
4. Keep per-pass command count max 2.
5. Strip or mask sensitive absolute paths before UI display if needed.
6. Log command, duration, exit code, truncation status.

## 8. End-to-End Sequence

1. Model issues `workspace_ops` `search_text` tool_call.
2. Extension receives tool_call in `chat-runtime.ts`.
3. `tool-executor` invokes `file-system-service`.
4. `file-system-service` builds pass plan and shell command.
5. Extension emits `shell_op_start` to frontend.
6. Shell command runs; output chunks emit `shell_op_output`.
7. Completion emits `shell_op_end`.
8. Parsed/deduped hits returned as final `ToolResult`.
9. Tool result posted to backend `/api/v1/tools/result`.
10. Backend resumes LLM and continues SSE.

## 9. File-by-File Change List

## 9.1 Extension host

- `extension/src/tools/file-system-service.ts`
  - new shell-first search engine, planner, safety validation, fallback
- `extension/src/tools/tool-executor.ts`
  - progress emitter plumbing
- `extension/src/chat-runtime.ts`
  - local event emission for shell ops
- `extension/src/types/index.ts`
  - new session event types and shell metadata typing
- `extension/src/request-context.ts`
  - optional shell descriptor propagation

## 9.2 Frontend

- `extension/frontend/src/store/chatStore.ts`
  - event type union and storage behavior
- `extension/frontend/src/store/authStore.ts`
  - hydration type support for new events
- `extension/frontend/src/lib/trace.ts`
  - title/summary/detail mapping for shell events
- `extension/frontend/src/components/AgentTimeline.tsx`
  - visual rendering for shell operation lifecycle

## 9.3 Backend (minimum + optional)

Minimum required now:

- no mandatory backend file changes

Recommended next:

- `backend/app/api/v1/chat.py`
  - optional replay/persist of shell trace details
- `backend/app/schemas/tool.py`
  - no required type changes for current loose `data`, optional docs updates

## 10. Testing Strategy

## 10.1 Unit tests

1. shell command builder per shell type.
2. regex safety validator block/downgrade behavior.
3. output parser for `path:line:text` format.
4. dedupe and max-results capping.

## 10.2 Integration tests (extension)

1. `search_text` with exact match.
2. `search_text` with variants enabled.
3. timeout path returns stable error result.
4. fallback path triggers when shell path fails.
5. shell events emitted in correct order:
   - start -> output* -> end.

## 10.3 UI tests

1. timeline renders shell start/output/end nicely.
2. shell output does not corrupt assistant markdown response.
3. replay of persisted events still renders correctly.

## 11. Rollout Plan

Phase 1:

- implement shell-first search in extension
- emit local shell events
- no backend protocol changes

Phase 2:

- add shell descriptor in request context
- improve model prompt guidance for shell-specific command generation

Phase 3:

- optional backend progress stream endpoint for fully synchronized live shell events

## 12. Acceptance Criteria

1. `search_text` uses shell-first execution path by default.
2. Commands are visible in timeline live with command text and output.
3. Search results match existing contract (`file:line:snippet`) capped to 20.
4. Timeout and fallback paths are deterministic and logged.
5. Existing tool result ingestion and LLM continuation remain stable.

## 13. Known Constraints

1. Shell integration differs by platform and terminal profile.
2. Access to arbitrary historical terminal scrollback is limited by VS Code APIs.
3. For deterministic behavior, extension-managed command execution is preferred over scraping existing interactive terminal state.

## 14. Implementation Start Checklist

1. Add event/type scaffolding first.
2. Implement shell-first command planner and runner in `file-system-service.ts`.
3. Wire live event emitter from runtime to frontend.
4. Update timeline rendering.
5. Add tests for safety, timeout, and fallback.
6. Run extension test and manual smoke run on Windows PowerShell.

## 15. Codebase-Verified Execution Timeline (April 2026)

This section captures the practical implementation timeline based on verified current code paths.

### 15.1 Current reality snapshot

Verified current behavior:

1. `search_text` still routes through in-process `grep_workspace` file scanning.
2. `grep_workspace` still does file-by-file reads (`findFiles` + `readFile` + line scan).
3. Event unions currently do not include dedicated shell lifecycle events.
4. Backend tool result contract already supports flexible `data` payloads.
5. V1 live shell UX can be extension-local without mandatory backend protocol changes.

### 15.2 Time estimate bands

MVP (rg search only, no shell timeline, no bundled binaries):

- 150 to 220 minutes

Production rollout (bundled binaries + shell timeline + fallback + tests):

- 420 to 600 minutes (one focused implementation day)

### 15.3 Minute-level phase breakdown

Phase 1 (0-35 minutes): Search contract hardening

- Add strict `search_text` payload normalization and capped limits in `workspace_ops` search path.
- Enforce fixed caps even if model sends larger values.
- Preserve existing idempotency and request contract behavior.

Phase 2 (35-140 minutes): Replace manual scan with rg execution engine

- Replace internal implementation of `grep_workspace` in `extension/src/tools/file-system-service.ts`.
- Add command planner, shell-safe argument building, timeout, max buffer, and structured parsing.
- Treat ripgrep exit code `1` as valid no-match result (not runtime failure).
- Preserve deterministic final `file:line:snippet` output and result cap.

Phase 3 (140-205 minutes): Bundle and resolve rg binaries

- Add bundled ripgrep binaries per platform under extension assets.
- Add binary resolution order:
  1. bundled binary
  2. system `rg`
  3. manual in-process fallback
- Add startup/runtime validation (`--version`) for resolved binary.
- Ensure packaged extension includes binary assets.

Phase 4 (205-285 minutes): Local shell progress event pipeline

- Add new event types:
  - `shell_op_start`
  - `shell_op_output`
  - `shell_op_end`
- Add emitter interface wiring:
  - `chat-runtime -> tool-executor -> file-system-service`
- Emit start/output/end around command execution and stream chunks.
- Post these events directly to webview via existing local bridge.

Phase 5 (285-355 minutes): Frontend event handling and timeline rendering

- Extend event type unions and hydration support in stores.
- Update append behavior so shell output does not merge into assistant markdown response content.
- Add trace mapping (title, summary, detail) for shell lifecycle events.
- Add timeline visual treatment for shell start/output/end blocks.

Phase 6 (355-455 minutes): Tests and failure-path validation

- Add/extend extension tests for:
  1. shell command builder per platform
  2. regex safety downgrade path
  3. parser and dedupe logic
  4. timeout behavior
  5. fallback behavior
  6. event order (`start -> output* -> end`)
- Keep existing workspace ops contract tests passing.

Phase 7 (455-600 minutes): Cross-platform and packaging hardening

- Validate Windows PowerShell command path and quoting.
- Validate Linux/macOS execute permissions and command invocation.
- Validate packaged VSIX contains binaries and launches correctly.
- Run full manual smoke for tool call -> extension execution -> tool result loop.

## 16. Exact Code Touchpoints for This Rollout

Extension host (mandatory):

1. `extension/src/tools/file-system-service.ts`
  - replace manual grep execution path
  - add rg runner, planner, parser, fallback, and metadata
2. `extension/src/tools/tool-executor.ts`
  - add optional progress emitter plumbing
3. `extension/src/chat-runtime.ts`
  - create and route local shell progress session events
4. `extension/src/types/index.ts`
  - extend session event union and shell metadata shape
5. `extension/src/sse-client/stream.ts`
  - keep event normalization compatibility with new event types

Frontend (mandatory for live shell UX):

1. `extension/frontend/src/store/chatStore.ts`
  - shell event storage behavior and response-content isolation
2. `extension/frontend/src/store/authStore.ts`
  - hydration type support for new event categories
3. `extension/frontend/src/lib/trace.ts`
  - shell event title/summary/detail logic
4. `extension/frontend/src/components/AgentTimeline.tsx`
  - shell lifecycle visual rendering

Packaging/build (mandatory when bundling binaries):

1. `extension/package.json`
  - scripts for packaging/asset inclusion validation
2. `extension/vite.config.ts`
  - verify build output keeps binary assets accessible

Backend (optional for v1, recommended later):

1. `backend/app/api/v1/chat.py`
  - optional persisted shell replay projection
2. `backend/app/schemas/tool.py`
  - optional schema docs update for shell trace metadata

## 17. Policy and Product Positioning

1. `findTextInFiles` is not required for this design.
2. The solution is extension-host shell execution plus deterministic output parsing.
3. This avoids expensive per-file read scanning for broad discovery queries.
4. LLM reads should remain targeted (`read_file`) after `search_text` narrows coordinates.

## 18. Delivery Gates (Do Not Skip)

Gate A: Engine correctness

- rg path returns stable `file:line:snippet` output
- timeout and no-match semantics verified
- fallback path deterministic

Gate B: UX transparency

- shell start/output/end visible live in timeline
- shell output cannot corrupt final assistant markdown response

Gate C: Contract stability

- final tool result still posts through existing `/api/v1/tools/result`
- no regression in session/chat/message/tool_call scoping

Gate D: Ship readiness

- extension package contains binaries
- Windows smoke run completed
- contract tests pass
