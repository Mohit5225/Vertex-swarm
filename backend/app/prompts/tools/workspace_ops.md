## WORKSPACE OPERATIONS TOOL GUIDANCE

> **TOOL NAME IS EXACTLY `workspace_ops`**. The JSON key must be `"tool_name": "workspace_ops"`. Any other string will be rejected with a DEPRECATED_TOOL error.

workspace_ops is the single source of truth for all file system operations.
Every call requires: action, request_id, mode, payload.

---

### HASH-BASED CONCURRENCY PROTOCOL (MANDATORY)

Your mutations MUST include `expected_hash`. This is your contract with the file system.

**STEP 1: READ THE FILE(S)**
Determine if you need to read a single file or multiple files.

*Option A: Single File Read (`read_file`)*
- Use when: You know exactly which file you need to edit, or you only need to look at one file.
- Action: `read_file`, mode: `preview`, payload: `{ path }`
- Hash Handling: The response JSON contains `data.current_hash`. Extract and save this hash.

*Option B: Bulk File Read (`bulk_files_read`)*
- Use when: You need to read multiple related files to understand the broader context, cross-reference imports, or plan cross-file changes.
- Flexibility & Limits: You have the choice to read exactly the files you need, from 2 up to a STRICT maximum of 5 files simultaneously. Be strategic with your choice to avoid context bloat. There is also a global limit of 100KB for the total batch. If the combined file sizes exceed 100KB, the result will be truncated and you must fall back to single `read_file` calls.
- Action: `bulk_files_read`, mode: `preview`, payload: `{ paths: ["path/1.py", "path/2.py"] }`
- Hash Handling: The response contains an array at `data.files`. EACH file object in that array contains its own `current_hash`. You MUST map the hash to the specific file. When you later call `edit_file` for `path/1.py`, use the hash specifically returned for `path/1.py`.

- CRITICAL: A `current_hash` is ALWAYS present in a successful read response. Do NOT use a placeholder. Do NOT skip this step. Do NOT proceed to edit without a real hash string.

**STEP 2: PLAN YOUR EDIT**
- Decide what to change. Keep the exact hash string in memory — you will paste it verbatim.

**STEP 3: APPLY THE EDIT**
- Call workspace_ops with action: `edit_file`, mode: `apply`
- payload: `{ path, edits: [...], expected_hash: "<the exact hash string from Step 1>" }`
- NEVER omit expected_hash. NEVER write a placeholder like `<hash_placeholder>`. NEVER fabricate a hash. NEVER reuse a stale hash.

**STEP 4: CHECK THE RESULT**
- `{ "status": "success" }` → done.
- `{ "error_code": "HASH_CONFLICT" }` → file changed since your read. The response includes `conflict.current_version` with the current hash. Re-read the file (Step 1) to get the latest content and hash, then retry the edit.
- `{ "error_code": "MISSING_CONCURRENCY_GUARD" }` → you forgot expected_hash or used a placeholder. Go back to your last read_file response, read `data.current_hash`, and include it now.
- `{ "error_code": "CONFLICTING_CONCURRENCY_GUARDS" }` → you sent both expected_hash and expected_version. Use only expected_hash.

---

### CODE DISCOVERY PROTOCOL (GREP FIRST, READ SECOND)

| Query Type | What To Do |
|---|---|
| Read a single file | use `workspace_ops` with action: `read_file` directly. Ideal for focused changes. |
| Read multiple related files | use `workspace_ops` with action: `bulk_files_read`. Ideal when you need to understand cross-file dependencies or make coordinated edits across 2-5 files. |
| Find function / class / symbol | use `workspace_ops` with action: `search_text` first (costs ~20 tokens), then action: `read_file` or `bulk_files_read` on the returned lines/files |
| Broad feature exploration | use `workspace_ops` with action: `list_dir` → action: `search_text` with regex → action: `bulk_files_read` on key files |
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

### `workspace_ops` ACTIONS REFERENCE

*You must invoke the `workspace_ops` tool and provide one of these as the `action` parameter.*

- action: `list_dir` | payload `{ path }` — use `"."` for root
- action: `search_text` | payload `{ query, variants?, filePattern?, useRegex? }` — for file CONTENTS only, not filenames
- action: `read_file` | payload `{ path, startLine?, endLine? }`
- action: `bulk_files_read` | payload `{ paths: ["path1", "path2"] }` — Bulk read up to 5 files at once. Each returned file object contains its own `current_hash` and `content`. Use this when you need to read multiple files together. If the batch exceeds 100KB, it will be truncated.
- action: `edit_file` | payload `{ path, edits:[...], expected_hash }` — always mode: apply
  - Each edit: `{ startLine, startCol, endLine, endCol, text }`
  - **ALL coordinates are 1-indexed.** The first character of the first line is `startLine:1, startCol:1`.
  - `startCol:0` or `endCol:0` are **INVALID** — they will always be rejected.
  - Insert before line content: `startCol:1, endCol:1` (zero-width range at line start)
  - Append after last line (file has N lines): `startLine:N+1, startCol:1, endLine:N+1, endCol:1`
  - Example — prepend a new function after line 18: `{ startLine:19, startCol:1, endLine:19, endCol:1, text:"\n@app.get(...)\n" }`
- action: `create_file` | payload `{ path, content, overwrite? }`
- action: `delete_path` | payload `{ path, recursive?, useTrash? }`
- action: `rename_path` | payload `{ oldPath, newPath, overwrite? }`

---

### REQUEST_ID RULES

Use stable request_ids derived from the action + file path + intent — not random UUIDs.
The same logical change across retries must have the same request_id. This is your idempotency guarantee.

---

### HANDLING ERRORS

- Never retry a failed action with the same arguments.
- If HASH_CONFLICT: re-read, get new hash, retry.
- If MISSING_CONCURRENCY_GUARD: find `data.current_hash` from your last `workspace_ops` result (action `read_file` or per-file hash from `bulk_files_read`) and include it as `expected_hash`.
- If a tool returns empty or unexpected data twice: stop and report to user. Do not loop.
