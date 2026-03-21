# Tool Execution Concurrency Model

## Problem Statement

**Multi-user concurrent tool execution requires strict isolation.**

Scenario: User A and User B both send messages to Vertex Swarm simultaneously. Both trigger `grep_workspace("AuthService")`.

```
User A:  session_id=sess-alice, chat_id=chat-001, message_id=msg-001
User B:  session_id=sess-bob, chat_id=chat-002, message_id=msg-002

Both exec: grep_workspace(query="AuthService")
```

**Expected Behavior:**
- Both get the SAME grep results (file system is read-only, shared)
- Each user's result is ISOLATED by `session_id + message_id`
- User A's LLM context includes ONLY User A's tool results
- User B's LLM context includes ONLY User B's tool results
- No cross-contamination between sessions

**Enforcement Point:** Backend validates `user_id` matches `session_id` before returning tool result.

---

## Tool Result Structure (Object, Not String)

Every tool returns a **structured ToolResult object** carrying full execution context.

```typescript
export interface ToolResult {
  // Identity
  tool_name: string;                 // 'grep_workspace', 'read_file_paginated', 'list_dir'
  tool_call_id: string;              // unique per invocation (UUID)
  
  // Isolation
  session_id: string;                // user session ID from JWT
  chat_id: string;                   // current chat within session
  message_id: string;                // which LLM turn requested the tool
  
  // Payload
  status: 'success' | 'error' | 'timeout';
  content: string;                   // actual output (grep results, file content, etc.)
  
  // Observability (Phase 11: Anomaly Detection)
  execution_time_ms: number;         // elapsed time (for performance tracking)
  error_code?: string;               // specific error classification: 'ENOENT', 'TIMEOUT', 'GREP_ERROR', 'READ_ERROR', 'RANGE_TOO_LARGE', 'FILE_TOO_LARGE', 'UNKNOWN_TOOL', 'EXECUTION_ERROR'
}
```

### Why Structured Objects?

1. **Session Binding:** Tool results carry `session_id`, `chat_id`, `message_id`. Backend can validate ownership.
2. **Anomaly Detection:** `execution_time_ms` + `error_code` enable Phase 11 tool health tracking (statistical windows, quarantine mode, root cause classification).
3. **Result Re-Injection:** LLM receives complete metadata alongside content (not just strings).
4. **Debugging:** Each tool call has a unique `tool_call_id` for tracing in logs.

---

## Session / Message Context Binding

### ToolContext (Extension)

Carries session/message binding for every tool execution.

```typescript
export interface ToolContext {
  tool_call_id: string;              // unique ID for this specific invocation
  session_id: string;                // user session (from JWT)
  chat_id: string;                   // current chat
  message_id: string;                // which LLM turn requested the tool
}
```

### Flow: From LLM Response to Tool Execution

**Step 1: LLM generates tool call**
```
Backend calls OpenRouter LLM with system prompt + workspace skeleton + message history

LLM response:
{
  "type": "tool_call",
  "tool_name": "grep_workspace",
  "args": { "query": "authenticate", "filePattern": "src/**" }
}
```

**Step 2: Backend extracts tool call, creates request packet**
```python
# Backend (Python)
tool_call = extract_tool_call(llm_response)
request = ToolExecutionRequest(
    tool_call_id="tc-" + uuid.uuid4(),
    tool_name=tool_call["tool_name"],
    args=tool_call["args"],
    session_id=current_session.session_id,
    chat_id=current_chat.chat_id,
    message_id=current_message.message_id,
    user_id=get_current_user().user_id,  # For validation
)

# Send to extension via SSE event
sse_event = {
    "type": "tool_call",
    "payload": request  # includes session_id, chat_id, message_id
}
```

**Step 3: Extension receives tool call, executes in context**
```typescript
// Extension (TypeScript)
async handle(message: {
    type: 'tool_call',
    tool_call_id: string,
    tool_name: string,
    args: Record<string, unknown>,
    session_id: string,     // from backend
    chat_id: string,        // from backend
    message_id: string,     // from backend
}) {
    const context: ToolContext = {
        tool_call_id: message.tool_call_id,
        session_id: message.session_id,
        chat_id: message.chat_id,
        message_id: message.message_id,
    };
    
    // Execute tool with context
    const toolResult = await grep_workspace(
        message.args.query,
        message.args.filePattern,
        context
    );
    // toolResult includes session_id, chat_id, message_id
    
    // POST back to backend
    await fetch(`${BACKEND_URL}/api/v1/tools/result`, {
        method: 'POST',
        body: JSON.stringify(toolResult)
    });
}
```

**Step 4: Backend receives tool result, validates ownership, injects into LLM context**
```python
# Backend (Python)
@router.post("/api/v1/tools/result")
async def receive_tool_result(result: ToolResult, user: AuthenticatedUser):
    # VALIDATION: Verify user owns the session
    session = await get_session(result.session_id)
    if session.user_id != user.user_id:
        raise Forbidden("Tool result from different user's session")
    
    # VALIDATION: Verify message belongs to this session
    message = await get_message(result.message_id)
    if message.chat_id != result.chat_id:
        raise BadRequest("Message doesn't belong to this chat")
    
    # ISOLATION: Accumulate in per-message context (not global)
    message.tool_results.append(result)
    
    # RE-INJECTION: Form LLM context from accumulated results
    tool_context = format_tool_results_for_llm(message.tool_results)
    
    # Continue LLM generation with tool result in context
    next_llm_input = {
        "role": "assistant",
        "content": f"Previous tool result:\n{result.content}\n\nContinuing..."
    }
```

---

## Message-Based Tool Execution State Machine

For each user message, maintain a **per-message tool execution context**.

```python
class MessageToolExecutionContext:
    """Per-message tool execution tracking"""
    message_id: str
    session_id: str
    chat_id: str
    user_id: str
    
    # Accumulate results as tools are called
    tool_calls_made: List[str] = []        # list of tool_call_ids in order
    tool_results: Dict[str, ToolResult] = {} # keyed by tool_call_id
    
    def add_tool_result(self, result: ToolResult):
        """Append tool result, maintaining isolation"""
        # Only accept results for this message
        if result.message_id != self.message_id:
            raise ValueError("Tool result belongs to different message")
        self.tool_results[result.tool_call_id] = result
        self.tool_calls_made.append(result.tool_call_id)
    
    def get_accumulated_context(self) -> str:
        """Format all tool results for LLM re-injection"""
        context = ""
        for tool_call_id in self.tool_calls_made:
            result = self.tool_results[tool_call_id]
            context += f"""
Tool: {result.tool_name}
Call ID: {result.tool_call_id}
Status: {result.status}
Execution Time: {result.execution_time_ms}ms
{'-' * 60}
{result.content}

"""
        return context
```

### Execution Flow Per Message

```
1. User sends message to /chats/{chat_id}/messages

2. Backend creates:
   context = MessageToolExecutionContext(
       message_id=new_uuid(),
       session_id=user_session.session_id,
       chat_id=chat_id,
       user_id=user.user_id
   )

3. Backend calls LLM with system prompt + skeleton + message history

4. LLM returns response (may include tool_call or final answer)

5. IF tool_call:
   a. Build ToolExecutionRequest with session_id, chat_id, message_id
   b. Send via SSE event to extension
   c. Extension executes tool, returns ToolResult
   d. Backend receives ToolResult, validates ownership
   e. Add to context.tool_results
   f. Format accumulated context
   g. Re-inject to LLM: "Previous tool returned: ..."
   h. Call LLM again (loop back to step 4)

6. ELSE (no more tool_calls):
   a. Final LLM response ready
   b. Persist message to Postgres WITH all accumulated tool_results
   c. Stream complete
```

---

## Concurrent Safety Guarantees

### File System (Shared Read-Only)

All three tools read from the file system. This is safe for concurrency:
- File system is read-only
- Multiple readers never conflict
- No locks needed

```
Session A reads /src/auth.ts:42
Session B reads /src/auth.ts:42
  ↓
Both get identical content — no race condition
Each result isolated by session_id + message_id
```

### Session State (Isolated by ID)

Each session's tool results live in a dedicated key-value namespace:

```python
# Backend (Python)
# Store per-message tool results (temporary, during message processing)
await redis.hset(
    f"message:{message_id}:tool_results",
    f"tool_{tool_call_id}",
    result.model_dump_json()
)

# Result is scoped by message_id and session_id
# User 1's message:msg-001 never sees User 2's message:msg-002 results
```

### LLM Context (Never Cross-Contaminates)

Each chat message has its own LLM context array:

```python
# Backend (Python)
chat_message = {
    "message_id": msg_id,
    "role": "user",
    "content": user_input,
    "tool_results": []  # accumulated per-message
}

# When tool returns, append ONLY to this message
chat_message["tool_results"].append(tool_result)

# LLM re-injection uses ONLY this message's tool results
llm_input = [
    {"role": "system", "content": system_prompt},
    {"role": "user", "content": history...},
    {"role": "assistant", "content": accumulated_tool_context},  # from THIS message only
]
```

### Validation Layer (Backend Enforces Isolation)

Every tool result endpoint validates:

```python
@router.post("/api/v1/tools/result")
async def receive_tool_result(
    result: ToolResult,
    user: AuthenticatedUser = Depends(get_current_user)
):
    # 1. Verify user owns the session
    session = await redis.get(f"session:{result.session_id}")
    if not session or session.user_id != user.user_id:
        raise HTTPException(status_code=403, detail="Forbidden")
    
    # 2. Verify chat belongs to session
    chat = await postgres.get_chat(result.chat_id)
    if chat.session_id != result.session_id:
        raise HTTPException(status_code=400, detail="Chat doesn't belong to session")
    
    # 3. Verify message belongs to chat
    message = await postgres.get_message(result.message_id)
    if message.chat_id != result.chat_id:
        raise HTTPException(status_code=400, detail="Message doesn't belong to chat")
    
    # Passed all checks → accumulate result
    message_context = await get_message_tool_context(result.message_id)
    message_context.add_tool_result(result)
```

---

## Backend Endpoint: `/api/v1/tools/result`

**Purpose:** Receive tool execution results from extension.

**Request:**
```json
POST /api/v1/tools/result
Authorization: Bearer {JWT}
Content-Type: application/json

{
  "tool_name": "grep_workspace",
  "tool_call_id": "tc-uuid-001",
  "session_id": "sess-alice",
  "chat_id": "chat-001",
  "message_id": "msg-001",
  "status": "success",
  "content": "src/auth.ts:42: export function authenticate(...)",
  "execution_time_ms": 145,
  "error_code": null,
  "cache_hit": false,
  "workspace_skeleton_version": "v1-1710761234000"
}
```

**Response:**
```json
{
  "status": "received",
  "tool_call_id": "tc-uuid-001",
  "next_step": "continue_llm"  // or "handle_error" if validation failed
}
```

**Implementation (Python):**
```python
from fastapi import APIRouter, Depends, HTTPException, status
from app.auth.dependencies import get_current_user, AuthenticatedUser
from app.models.tool import ToolResult  # Pydantic model

router = APIRouter(prefix="/api/v1/tools", tags=["tools"])

@router.post("/result")
async def receive_tool_result(
    result: ToolResult,
    user: AuthenticatedUser = Depends(get_current_user)
):
    """
    Receive tool result from extension and validate ownership.
    Accumulate in per-message context for LLM re-injection.
    """
    # Validate ownership at all levels
    session = await redis.hgetall(f"session:{result.session_id}")
    if not session or session.get("user_id") != user.user_id:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Session belongs to different user"
        )
    
    chat = await postgres.execute(
        select(ChatORM).where(ChatORM.chat_id == result.chat_id)
    )
    if not chat or chat.session_id != result.session_id:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Chat doesn't belong to this session"
        )
    
    message = await postgres.execute(
        select(MessageORM).where(MessageORM.message_id == result.message_id)
    )
    if not message or message.chat_id != result.chat_id:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Message doesn't belong to this chat"
        )
    
    # Validation passed → accumulate tool result
    message_context = await redis.hgetall(f"message:{result.message_id}:context")
    if not message_context:
        message_context = {}
    
    message_context[f"tool_{result.tool_call_id}"] = result.model_dump_json()
    await redis.hset(
        f"message:{result.message_id}:context",
        mapping=message_context
    )
    
    # Log for Phase 11 anomaly detection
    await log_tool_execution({
        "tool_name": result.tool_name,
        "session_id": result.session_id,
        "status": result.status,
        "execution_time_ms": result.execution_time_ms,
        "error_code": result.error_code,
    })
    
    return {
        "status": "received",
        "tool_call_id": result.tool_call_id,
        "next_step": "continue_llm"
    }
```

---

## Integration Checklist

Before building tools, ensure:

- [ ] **ToolResult type** added to `extension/src/types/index.ts` with all fields
- [ ] **ToolContext type** added to `extension/src/types/index.ts`
- [ ] **All three tools** return ToolResult (not string)
- [ ] **ToolExecutor.handle()** passes context to every tool call
- [ ] **Backend endpoint** `POST /api/v1/tools/result` exists and validates ownership
- [ ] **Session validation** enforces `user_id` matches `session_id`
- [ ] **Chat validation** enforces `chat_id` belongs to `session_id`
- [ ] **Message validation** enforces `message_id` belongs to `chat_id`
- [ ] **Per-message accumulation** — tool results don't bleed between messages
- [ ] **Error codes** are specific ('ENOENT', 'TIMEOUT', 'READ_ERROR', etc.)
- [ ] **Execution time tracking** enabled for Phase 11 anomaly detection

---

## Worked Example: Two Concurrent Users

### User A (alice@example.com)

```
1. alice sends: "How does authentication work?"
   
2. Backend:
   - session_id: sess-alice
   - chat_id: chat-001
   - message_id: msg-001
   - Calls LLM
   
3. LLM wants to search for auth code:
   {
     "tool_name": "grep_workspace",
     "args": {"query": "authenticate"}
   }
   
4. Backend sends SSE event to alice's extension:
   {
     "type": "tool_call",
     "tool_call_id": "tc-001",
     "tool_name": "grep_workspace",
     "args": {"query": "authenticate"},
     "session_id": "sess-alice",
     "chat_id": "chat-001",
     "message_id": "msg-001"
   }
   
5. alice's extension executes grep:
   - Searches workspace (shared read-only)
   - Returns: src/auth.ts:42, src/auth.ts:78, ...
   
6. alice's extension POSTs result to /api/v1/tools/result:
   {
     "tool_name": "grep_workspace",
     "tool_call_id": "tc-001",
     "session_id": "sess-alice",
     "chat_id": "chat-001",
     "message_id": "msg-001",
     "status": "success",
     "content": "src/auth.ts:42: export function authenticate...",
     "execution_time_ms": 120
   }
   
7. Backend validates:
   ✓ user.user_id == session.user_id (alice == alice)
   ✓ chat.session_id == request.session_id
   ✓ message.chat_id == request.chat_id
   
8. Backend injects into alice's LLM context:
   "Tool grep_workspace returned: src/auth.ts:42..."
   
9. LLM continues (may call more tools or finalize answer)
```

### User B (bob@example.com) — Simultaneously

```
1. bob sends: "Show me the login endpoint"
   
2. Backend:
   - session_id: sess-bob
   - chat_id: chat-002
   - message_id: msg-002
   - Calls LLM
   
3. LLM wants the same search:
   {
     "tool_name": "grep_workspace",
     "args": {"query": "authenticate"}
   }
   
4. Backend sends SSE event to bob's extension:
   {
     "type": "tool_call",
     "tool_call_id": "tc-002",
     "tool_name": "grep_workspace",
     "args": {"query": "authenticate"},
     "session_id": "sess-bob",    ← DIFFERENT SESSION
     "chat_id": "chat-002",        ← DIFFERENT CHAT
     "message_id": "msg-002"       ← DIFFERENT MESSAGE
   }
   
5. bob's extension executes grep:
   - Searches workspace (same files as alice)
   - Returns: src/auth.ts:42, src/auth.ts:78, ... (identical content)
   
6. bob's extension POSTs result:
   {
     "tool_name": "grep_workspace",
     "tool_call_id": "tc-002",
     "session_id": "sess-bob",
     "chat_id": "chat-002",
     "message_id": "msg-002",
     "status": "success",
     "content": "src/auth.ts:42: export function authenticate...",
     "execution_time_ms": 125
   }
   
7. Backend validates:
   ✓ user.user_id == session.user_id (bob == bob)
   ✓ chat.session_id == request.session_id
   ✓ message.chat_id == request.chat_id
   
8. Backend injects into bob's LLM context:
   "Tool grep_workspace returned: src/auth.ts:42..."
   
   NOTE: bob's LLM ONLY sees bob's tool result, never alice's
   
9. LLM continues for bob
```

### Result

| Aspect | Alice | Bob |
|--------|-------|-----|
| Session ID | sess-alice | sess-bob |
| Chat ID | chat-001 | chat-002 |
| Message ID | msg-001 | msg-002 |
| File System Read | Same directory | Same directory |
| Grep Result | `src/auth.ts:42...` | `src/auth.ts:42...` |
| Tool Call ID | tc-001 | tc-002 |
| LLM Context | Contains alice's tool results | Contains bob's tool results |
| Cross-Contamination | ✓ Zero | ✓ Zero |

---

## Observability & Phase 11 Integration

Tool execution is fully instrumented for:

1. **Tool Health Tracking (Phase 11)**
   - Every tool call logs: tool_name, status, execution_time_ms, error_code
   - Enables rolling window anomaly detection, quarantine mode, root cause classification

2. **Debugging & Tracing**
   - Each tool_call_id is unique across all sessions
   - Audit trail: which user called which tool, when, with what result
   - error_code enables automated diagnosis (ENOENT, TIMEOUT, GREP_ERROR, READ_ERROR, etc.)
