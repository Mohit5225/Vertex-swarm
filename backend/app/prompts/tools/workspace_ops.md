## WORKSPACE OPERATIONS TOOL GUIDANCE

workspace_ops is the single source of truth for all file system operations.
Every call requires: action, request_id, mode, payload.

---

### HASH-BASED CONCURRENCY PROTOCOL (MANDATORY)

Your mutations MUST include `expected_hash`. This is your contract with the file system.

**STEP 1: READ THE FILE**
- action: read_file, request_id: "<unique-id-for-this-read>", mode: preview, payload: { path }
- Extract and store `data.current_hash` from the response. Example: `"fnv1a-a1b2c3d4-24"`

**STEP 2: PLAN YOUR EDIT**
- Decide what to change. Keep the hash in memory.

**STEP 3: APPLY THE EDIT**
- action: edit_file, request_id: "<unique-id-for-this-edit>", mode: apply
- payload: { path, edits: [...], expected_hash: "<hash from Step 1>" }
- NEVER omit expected_hash. NEVER fabricate a hash. NEVER reuse a stale hash.

**STEP 4: CHECK THE RESULT**
- `{ "status": "success" }` → done.
- `{ "error_code": "HASH_CONFLICT" }` → file changed. Go back to Step 1. Re-read. Get new hash.
- `{ "error_code": "MISSING_CONCURRENCY_GUARD" }` → you forgot expected_hash. Find the hash from your last read response and retry immediately.
- `{ "error_code": "CONFLICTING_CONCURRENCY_GUARDS" }` → you sent both expected_hash and expected_version. Use only one.

---

### CODE DISCOVERY PROTOCOL (GREP FIRST, READ SECOND)

| Query Type | What To Do |
|---|---|
| User says "Read file X" | use `workspace_ops` with action: `read_file` directly — skip search |
| Find function / class / symbol | use `workspace_ops` with action: `search_text` first (costs ~20 tokens), then action: `read_file` on the returned lines |
| Broad feature exploration | use `workspace_ops` with action: `list_dir` → action: `search_text` with regex → action: `read_file` on key files |
| Find all call sites | use `workspace_ops` with action: `search_text` and payload: `{query: 'fn_name(', filePattern: '**/*.py'}` |

For any non-builtin symbol, ALWAYS provide variants:
```json
{
  "action": "search_text",
  "request_id": "<derived-from-action-and-query>",
  "mode": "<preview-or-apply>",
  "payload": {
    "query": "validateConcurrencyGuard",
    "variants": ["validateConcurrencyGuard", "validate_concurrency_guard", "ConcurrencyGuard"]
  }
}
```

Token cost: `workspace_ops` action `search_text` ~20 tokens, action `read_file` ~70 tokens. Blind reads = 600 tokens. Always grep first.

---

### ACTIONS REFERENCE

- **list_dir**: payload `{ path }` — use `"."` for root
- **search_text**: payload `{ query, variants?, filePattern?, useRegex? }` — for file CONTENTS only, not filenames
- **read_file**: payload `{ path, startLine?, endLine? }`
- **edit_file**: payload `{ path, edits:[{startLine,startCol,endLine,endCol,text}], expected_hash }` — always mode: apply
- **create_file**: payload `{ path, content, overwrite? }`
- **delete_path**: payload `{ path, recursive?, useTrash? }`
- **rename_path**: payload `{ oldPath, newPath, overwrite? }`

---

### REQUEST_ID RULES

Use stable request_ids derived from the action + file path + intent — not random UUIDs.
The same logical change across retries must have the same request_id. This is your idempotency guarantee.

---

### HANDLING ERRORS

- Never retry a failed action with the same arguments.
- If HASH_CONFLICT: re-read, get new hash, retry.
- If MISSING_CONCURRENCY_GUARD: find the hash from your last `read_file` action response and include it.
- If a tool returns empty or unexpected data twice: stop and report to user. Do not loop.
