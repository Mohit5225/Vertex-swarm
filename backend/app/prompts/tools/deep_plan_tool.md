## DEEP PLAN TOOL GUIDANCE

Injected with `deep_plan_tool` schema **only while the session gate is open** (`/deep-plan` or HIL `planning_gate` yes). Not on ordinary turns.

### Start deep plan (this turn)

1. **`deep_plan_tool` is already callable** — do **not** `load_tool_context` for `plan_tool`, `workspace_ops`, or anything else to "prepare" deep plan.
2. Call `deep_plan_tool` with `action: "start"`, `title`, `scope_summary`, `trigger` (`user_slash_command` or `hil_confirmed_arch_shift`).
3. Copy `stated_constraints` verbatim from chat when the user gave hard rules.
4. Wait — blocks until pipeline finishes and user approves/rejects on `DeepPlanCard`.

### When NOT to call

- Small fixes → chat or `plan_tool`
- Gate not open → `deep_plan_not_available`
- Standard multi-step work without `/deep-plan` → `plan_tool`, not deep plan

### After approval

Load `todo_tool` + `workspace_ops` to execute from `plan_pipeline/index.md`. Do not call `deep_plan_tool` again unless user rejects the plan.

### Revise

`action: "revise"` with `pipeline_id` + `rejection_feedback` (requires gate open again — user must `/deep-plan` or confirm via HIL).
