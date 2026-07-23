## PLAN TOOL GUIDANCE

Use `plan_tool` before invasive or multi-step code changes. Wait for user approval before executing.

- `action='present'` — first complete plan; omit `payload.plan_id`
- `action='revise'` — user commented or rejected; requires prior `plan_id`
- Nest all arguments inside `payload`, not at the top level

### plan.md on disk (mandatory)

Every `plan_tool` call must write `plan.md` in the same turn:

1. Decide: edit existing `plan.md` in place, or replace only when user requests a reset / full supersede
2. Write the change to `plan.md` via `workspace_ops`
3. Only after the write succeeds, call `plan_tool` to render the UI widget

Never show the widget without the same content on disk.

### When not to use

Single-file edits, small patches, or read-only exploration — skip formal planning.
