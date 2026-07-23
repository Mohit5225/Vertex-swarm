## SPAWN SUBAGENT GUIDANCE

**Last resort.** Default to doing the work yourself with `workspace_ops` and hidden `terminal_ops`.

### Valid uses

1. Parallel independent workstreams — each needs its own `worktree_path`
2. Large read-only research that would bloat parent context
3. User explicitly requested a separate exploration branch

### Do not use for

- File creation or editing → `workspace_ops`
- Package installs, builds, tests, git → `terminal_ops` with `user_visible: false`
- Routine sequential plan steps
- Because another tool feels slow

Never spawn to work around terminal visibility — use `user_visible: false` instead.

Subagents inherit the parent's loaded tool categories.
