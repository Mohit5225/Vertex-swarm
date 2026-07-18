## WORKSPACE OPERATIONS TOOL GUIDANCE

> **TOOL NAME IS EXACTLY `workspace_ops`**. The JSON key must be `"tool_name": "workspace_ops"`. Any other string will be rejected with a DEPRECATED_TOOL error.

workspace_ops is the single source of truth for all file system operations.
Every call requires: action, request_id, mode, payload.

**Never write files via the terminal.** Do not use `echo`, `Set-Content`, `Out-File`, `tee`, or heredocs in `terminal_ops` to create or edit source files. Use `create_file` and `edit_file` here instead — they are faster, hash-safe, and do not open the user's terminal.

---

### HASH-BASED CONCURRENCY PROTOCOL (MANDATORY)

Your mutations MUST include `expected_hash`. This is your contract with the file system.

**STEP 1: READ THE FILE(S)**
Determine your reading strategy based on the overall objective. Sequential reading (one-by-one) is slow and inefficient.

*Option A: Bulk File Read (`bulk_files_read`) — **RECOMMENDED FOR SPEED***
- Use when: Your overall task objective implies you will need the context of multiple files. Since you already have the folder structure, group your reads together to minimize latency.
- Flexibility & Limits: You are heavily encouraged to batch your file reads in intelligent batches (up to 5 files at once). The total batch has a 100KB limit; if exceeded, the result is truncated, so group files strategically.
- Action: `bulk_files_read`, mode: `preview`, payload: `{ paths: ["path/1.py", "path/2.py"] }`
- Hash Handling: The response contains an array at `data.files`. EACH file object contains its own `current_hash`. Map the hash to the specific file for editing.

*Option B: Single File Read (`read_file`)*
- Use when: You are **certain** that you need only ONE specific file for the overall objective, or you need to paginate through a single massive file that would otherwise break the 100KB bulk limit.
- Action: `read_file`, mode: `preview`, payload: `{ path, startLine?, endLine? }`
- Hash Handling: The response JSON contains `data.current_hash`. Extract and save this hash.

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

### CODE DISCOVERY PROTOCOL (MANDATORY GREP FIRST, READ SECOND)

**CRITICAL HARD CONSTRAINT: YOU MUST USE `search_text` FIRST.**
Unless you already know the exact file and line numbers you need to modify, you are **STRICTLY PROHIBITED** from using `read_file` or `bulk_files_read` to explore code.

Why `search_text` is your most important tool:
1. **Precise Line Numbers:** It gives you the exact lines where a function, class, or symbol lives. You need this to edit the file accurately anyway.
2. **Token Efficiency:** A single `search_text` call costs ~20 tokens. A blind `read_file` or `bulk_files_read` costs hundreds or thousands of tokens, bloats your context, and degrades your intelligence.
3. **Targeted Context:** Reading full files fills your memory with irrelevant code. Search text gives you exactly the relevant snippets across the codebase instantly.
4. **Prevents Guessing:** Never guess where a function is located based on directory names. Always grep for it.

| Query Type | What To Do |
|---|---|
| Find function / class / symbol | **MANDATORY**: use `workspace_ops` action `search_text` first to locate code. Then use `read_file` or `bulk_files_read` ONLY on the targeted returned files. |
| Broad feature exploration | `list_dir` → `search_text` with regex → `bulk_files_read` ONLY on the key files discovered. |
| Find all call sites | use `search_text` with payload: `{query: 'fn_name(', filePattern: '**/*.py'}` |
| Task requires multiple files | **ONLY** if you ALREADY KNOW the exact paths beforehand, use `bulk_files_read`. |
| Task requires only one file | **ONLY** if you ALREADY KNOW the exact path beforehand, use `read_file`. |

To save roundtrips, search for multiple unrelated terms at once by providing `multiple_queries`:
```json
{
  "action": "search_text",
  "request_id": "<derived-from-action-and-query>",
  "mode": "<preview-or-apply>",
  "payload": {
    "query": "7999",
    "multiple_queries": ["localhost", "validateConcurrencyGuard"]
  }
}
```

---

### `workspace_ops` ACTIONS REFERENCE

*You must invoke the `workspace_ops` tool and provide one of these as the `action` parameter.*

- action: `list_dir` | payload `{ path }` — use `"."` for root
- action: `search_text` | payload `{ query, multiple_queries?, filePattern?, useRegex? }` — for file CONTENTS only, not filenames
- action: `read_file` | payload `{ path, startLine?, endLine? }`
- action: `bulk_files_read` | payload `{ paths: ["path1", "path2"] }` — Bulk read up to 5 files at once. Each returned file object contains its own `current_hash` and `content`. Use this when you need to read multiple files together. If the batch exceeds 100KB, it will be truncated.
- action: `edit_file` | payload `{ path, edits:[...], expected_hash }` — always mode: apply
  - Each edit: `{ targetContent, replacementContent, startLine, endLine, allowMultiple? }`
  - `targetContent`: The exact string of code currently in the file to replace. Must include exact whitespace/indentation.
  - `replacementContent`: The new code to drop in.
  - **CRITICAL**: Do NOT use placeholders like `// ... rest of code` in `replacementContent`. Every character in `targetContent` will be deleted and replaced. Placeholders will permanently corrupt the file.
  - **CRITICAL**: Keep `targetContent` as narrow as possible. Do NOT target an entire 50-line function just to change one variable inside it. Target only the exact lines that need changing to avoid accidentally deleting surrounding code.
  - `startLine` & `endLine`: 1-indexed boundaries to limit the search to a specific area of the file.
  - `allowMultiple`: Boolean (default false). Set to true if `targetContent` appears multiple times in the range and you want to replace all of them.
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
- If `EDIT_RETRY_BLOCKED`: you must run a discovery call before retrying `edit_file` on that path. Qualifying calls: `read_file` or `bulk_files_read` on that path, `search_text` that returns hits for that path, or a successful `create_file` / `delete_path` / `rename_path` that touches that path. Blind retries are rejected server-side.
- If HASH_CONFLICT: re-read, get new hash, retry.
- If MISSING_CONCURRENCY_GUARD: find `data.current_hash` from your last `workspace_ops` result (action `read_file` or per-file hash from `bulk_files_read`) and include it as `expected_hash`.
- If a tool returns empty or unexpected data twice: stop and report to user. Do not loop.
