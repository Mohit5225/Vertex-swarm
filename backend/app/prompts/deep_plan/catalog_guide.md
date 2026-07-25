# Deep plan — stage selection guide (Vertex req phase)

> Injected during **req extraction** (gate open) so Vertex can write `00_pipeline_manifest.json`.  
> Pipeline execution uses wave order in `pipeline_orchestration.md` + `run_planning_stage` — not this file at runtime.

## Always run

- `requirement_extraction` — HIL for scale, surfaces (frontend-only vs full-stack), constraints
- `assembly` — produce `plan_pipeline/index.md`

## Surfaces

| User intent | Include | Skip |
|-------------|---------|------|
| Frontend-only (UI, styling, component work) | `frontend_plan` | `system_plan`, `sdk_practices_audit`, `code_practices_audit`, `performance_planning` |
| Backend / API / migration | `system_plan` | optional `frontend_plan` if no UI |
| Full-stack | `system_plan` + `frontend_plan` | — |

## Scale / performance (from HIL)

| `scale_tier` | `performance_planning` |
|--------------|--------------------------|
| `small` (hobby, &lt;100 concurrent) | **Skip** unless user explicitly wants perf headroom |
| `medium` | Include if backend exists |
| `large` | Include when backend exists |

**Never** include `performance_planning` without `system_plan` and `sdk_practices_audit` first.

## Frontend strategy

| Situation | Stages |
|-----------|--------|
| One clear UI direction | `frontend_plan` only |
| Two viable architecture/UI forks | `frontend_plan_a` + `frontend_plan_b` (end `correction` pass merges if both ran) |

Do not use dual frontend for trivial UI tweaks.

## Audit chain (backend work)

When `system_plan` runs, typical order:

1. `system_plan`
2. `sdk_practices_audit` — libs match official docs
3. `code_practices_audit` — repo conventions
4. `performance_planning` — only if scale/HIL warrants
5. `security_audit` — auth, exposure, migration risk
6. `correction` — **mandatory end coherence pass** (always include on deep plan lists)

## Output

Write `00_pipeline_manifest.json` with `requested_stages`, `rationale`, and fields from HIL answers.
