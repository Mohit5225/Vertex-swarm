## DEEP PLAN TOOL GUIDANCE

Injected with `deep_plan_tool` schema **only while the session gate is open** (`/deep-plan` or HIL `planning_gate` yes). Requirement-extraction instructions are injected separately — read those first.

### Phase 1 — Requirement extraction (before this tool)

1. Load `workspace_ops`, `hil_tool`, `web_search` as needed — explore the repo and ask global HIL questions.
2. Write **`plan_pipeline/01_requirements.md`** (with integration / cross-surface section).
3. Write **`plan_pipeline/00_pipeline_manifest.json`** per `catalog_guide.md`.
4. **Do not** call this tool until both files exist on disk.

### Phase 2 — Hand off (`action: "start"`)

Call `deep_plan_tool` with:

- `title` — short human title
- `trigger` — `user_slash_command` or `hil_confirmed_arch_shift`
- `requirements_path` — default `plan_pipeline/01_requirements.md`
- `manifest_path` — default `plan_pipeline/00_pipeline_manifest.json`
- `stated_constraints` — verbatim hard rules from chat (optional if already in 01)
- `scope_summary` — optional; **01_requirements.md is the canonical handoff**

Then wait — blocks until specialist pipeline + user approval on `DeepPlanCard`.

### When NOT to call

- Before `01` + manifest exist → validation error; finish req extraction first
- Small fixes → `plan_tool`
- Gate not open → `deep_plan_not_available`

### After approval

Load `todo_tool` + `workspace_ops` to execute from `plan_pipeline/index.md`.

### Revise

`action: "revise"` with `pipeline_id` + `rejection_feedback` (not implemented yet).
