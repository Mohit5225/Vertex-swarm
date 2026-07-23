## TODO TOOL GUIDANCE

Tracks execution via a persistent checklist widget in the UI.

- Call after plan approval, or for any task with 3+ distinct steps
- `action='init'` — create the full list once; every item starts `pending`
- `action='update'` — resend the **entire** list with updated statuses (full replacement, not a diff)
- Mark exactly one item `in_progress` at a time; mark it `done` before starting the next
- Keep stable `id` values and the same order across updates
- Do not paste the full checklist into normal assistant prose — update the widget with this tool
- When all items are `done`, ask the user for permission to clear the widget; use `action='clear'` if they approve

Nest all arguments inside `payload`, not at the top level.
