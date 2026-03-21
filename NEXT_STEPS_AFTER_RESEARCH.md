# Next Steps After Architecture Review

## What Is True Right Now

- Postgres is the durable source of truth for chats, chat history, and archived session records.
- Redis is the short-lived execution layer for active session state, working memory, and transient tool orchestration data.
- The current file-system tool layer is implemented.
- The current backend can emit `tool_call` events and accept tool results.
- The missing piece is not tool execution itself. The missing piece is deterministic pause, wait, reinject, and resume behavior for the running LLM turn.

## Redis vs Postgres Boundary

### Keep In Postgres

- Chat rows and chat history.
- `ide_context_enabled` as the durable chat setting.
- Archived sessions and replayable state.

### Keep In Redis

- Active session state.
- Working memory.
- In-flight tool execution state.
- Short-lived event buffering.

### Recommended Rule

- Do not move durable chat configuration into Redis as the primary source of truth.
- If you want faster reads for an active chat, you can mirror the latest value into Redis as a cache, but Postgres must remain authoritative.
- `ide_context_enabled` is a chat property, not an execution scratchpad. It should be stored in Postgres and optionally cached in Redis only for active-session speed.

## Main Gap To Fix

The current system still does not complete the full tool loop.

Flow that exists now:

1. Backend streams model output.
2. Backend emits `tool_call`.
3. Extension executes the tool.
4. Extension POSTs the result back.

Flow that is still missing:

1. Backend pauses the running turn when a tool is requested.
2. Backend waits for the matching tool result.
3. Backend reads that result back from Redis.
4. Backend injects the result into the same message context.
5. Backend resumes generation and keeps streaming the final answer.

Without that controller loop, tool execution is orphaned and the UI looks broken even when the tool itself worked.

## UI Behavior To Add

- Show tool usage as a collapsible activity row in the chat stream.
- Make tool events readable even if the user never expands them.
- Keep raw token streaming visible as the default answer path.
- Show structured statuses like `receiving user message`, `planning`, `tool requested`, `tool running`, `tool result received`, `final answer streaming`.

## Logging To Add In Backend

The backend should log structured lifecycle events for every user turn:

- message received
- user and chat identifiers resolved
- context toggle state loaded
- plan or intent inferred
- tool usage decided or skipped
- tool execution started
- tool execution finished
- tool result accepted
- LLM resumed
- final response completed

These logs should be clean and sequential so the backend terminal becomes the real execution trace.

## Priority Work Order

1. Add the tool-result wait/resume controller in the backend chat flow.
2. Store and consume tool results by correlation keys such as `session_id`, `chat_id`, `message_id`, and `tool_call_id`.
3. Add structured backend logging for the full turn lifecycle.
4. Add a collapsible tool-activity lane in the webview UI.
5. Keep `ide_context_enabled` in Postgres as the authoritative chat setting, and only mirror it in Redis if a later performance reason exists.
6. Add tests for the pause/resume loop, the tool-result reinjection path, and the chat toggle loading path.

## Implementation Note

The correct design is not “move everything to Redis.”

The correct design is:

- Postgres for durable chat truth.
- Redis for active execution truth.
- Backend controller logic that joins the two.

That is what will make the UI stop looking like random tool spam and start looking like a real agent loop.