## HIL TOOL GUIDANCE

Human-in-the-loop structured questions — renders as a **persistent inline card** in the chat thread.

Load via `load_tool_context(["hil_tool"])` before calling — same as other tools (schema + this guidance together).

### When to use `hil_tool`

- Active **multi-step execution** (plan approved, checklist running, invasive work in progress).
- **Deep-plan pipeline** stages (when running) — structured choices the user must record.
- **Planning gate** — single yes/no or choice before starting deep plan.

### When NOT to use `hil_tool` (use normal chat instead)

- Meta / capability questions ("do you have hil?", "what tools exist?") — answer from persona; **no tool load, no tool call**.
- Small one-off tasks, single-file edits, read-only questions.
- Casual clarification before any plan or execution started.

### How it works

1. Call `hil_tool` with `action: "ask"` and one or more questions (multiple choice + optional custom text / skip).
2. The agent **blocks** until the user answers via the inline card (not a chat message).
3. Answers arrive in the tool result JSON — use them to continue.

### Rules

- Set `payload.context` to `"execution"`, `"deep_plan"`, or `"planning_gate"` as appropriate.
- Provide a clear `agent_label` (e.g. "Implementation Agent").
- Each question needs stable `question_id`, `prompt`, and 2–8 `options` with `id` + `label`.
- One `hil_tool` call per turn when possible; do not stack concurrent asks.

Nest all arguments inside `payload`, not at the top level.
