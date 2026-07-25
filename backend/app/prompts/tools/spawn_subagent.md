## SPAWN SUBAGENT GUIDANCE

Spawn a child agent when the user asks for subagents, or when independent deliverables can run in parallel. The child blocks the parent until it returns (or times out).

### Valid uses

1. **User explicitly asked to spawn / use subagents** — do it. Call `spawn_subagent`; do not substitute yourself writing the files.
2. Parallel independent workstreams — each write/edit stream should use its own `worktree_path` when mutating the same tree in parallel.
3. Large research or a large plan doc that would bloat parent context — child may **read and write** the deliverable paths named in `prompt`.

### Do not use for

- Routine single-file edits you can finish in one or two `workspace_ops` calls yourself
- Package installs, builds, tests, git → `terminal_ops` with `user_visible: false`
- Working around terminal visibility — use `user_visible: false` instead

### How to call it

- Put the full task in `prompt`: paths to read, paths to write, constraints, and what “done” means.
- Set `task_type` to a short label (e.g. `system-architecture-plan`).
- Set `timeout` high enough for the deliverable (plan docs often need `600`–`900`; default is 600).
- After loading `spawn_subagent`, **call it in the same turn or the next tool turn**. Do not reload tools, re-read the repo, or narrate “let me spawn…” without a tool call.

### Inheritance

Subagents inherit the parent's loaded tool categories. Do not reload categories the parent already loaded unless the child needs a new one.
