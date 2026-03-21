# ⚡ VERTEX SWARM PROJECT STATUS AUDIT — March 2026

**Comprehensive mapping of what's been built vs. Roadmap & Project Overview**

---

## 📋 SECTION 1: PHASE-BY-PHASE COMPLETION MAPPING

### **PHASE 1: Data Foundation (Week 1)** — **~70% COMPLETE**

#### ✅ DONE
- FastAPI skeleton with lifespan event handlers (`app/main.py` fully implemented)
- Pydantic models: `Agent`, `Task`, `Session`, `NorthStar`, `AgentDefinitionSchema`
- Postgres async engine via Neon (connection pooling, create_all works)
- Redis client with serialization (`app/infrastructure/cache/`)
- Session model with TTL fields (`session_id`, `user_id`, `last_message_at`, `agent_status`, `archived_at`)
- AgentVitalityTracker framework (`app/infrastructure/heartbeat/agent_vitality.py`)
- SessionArchivalJob framework (`app/infrastructure/jobs/archival_job.py`)
- Background job initialization in lifespan (startup → Redis → Vitality → Archival)

#### ❌ MISSING
- LLM-based working memory compression (`compress_working_memory()` has placeholder comment, no actual LLM call)
- Session archival actually tested with 3-hour TTL enforcement (code exists, no integration test)
- Hard size cap enforcement on working memory before compression triggers

#### ⚠️ CONCERN
- Archival job is initialized globally but no evidence it's actually running or tested
- Redis serialization framework exists but not validated under load

---

### **PHASE 2: User Management + Auth (Week 1-2)** — **~80% COMPLETE**

#### ✅ DONE
- Neon Auth JWT verification (`app/auth/core.py` — EdDSA/OKP key support)
- JWKS caching with TTL (1 hour default, configurable)
- FastAPI dependency injection (`get_current_user` middleware)
- Token validation on all protected endpoints
- **Tests: 17 passing**
  - `test_jwks_reachable()`
  - `test_jwt_signature_validation()`
  - `test_eddsa_algorithm_support()`
  - `test_verify_endpoint_with_valid_jwt()`

#### ❌ MISSING
- User registration endpoint (not in endpoints.py)
- Login flow (JWT generation at first sign-in)
- Session token persistence (where is the JWT stored after OAuth?)

#### ⚠️ CONTRADICTION
**Critical:** OAuth flow was **completely refactored** from spec:
- **Spec says:** `GET /authorize?client_id=...` → `POST /token?code=...` (standard OAuth 2.0)
- **Neon Auth actually does:** `POST /sign-in/social` (internal endpoint) + browser verifier pattern
- Repo memory confirms: "Extension-host raw `/authorize` + `/token` flow was stale"
- **Current status:** Refactored to use `neon_auth_session_verifier` in browser callback
- **Missing:** Observable flow in extension.ts — where is verifier exchange happening?

---

### **PHASE 3: ReAct Loop — CLI-Testable (Weeks 2-3)** — **~30% COMPLETE**

#### ✅ PARTIAL
- `app/services/llm_service.py` exists with `stream_chat_completion()`
- Tool registry structure in models (Task.tools_required array)
- Pydantic models for agents exist

#### ❌ MISSING (CRITICAL)
- **No CLI agent runner exists**
- **No actual ReAct loop** (LLM → JSON → tool extraction → execution → append result → loop)
- **No tool execution engine** (registered tools not callable)
- **No state persistence between iterations** (each LLM call is isolated, no loop context)
- **No token budget enforcement** (spending 100% of tokens without warning)
- **No hard max iteration cap**

#### ❌ MISSING: THE RESUME TEST (Hard Gate in Roadmap)
**Roadmap says:** "Interrupt the CLI agent, restart it, verify it resumes from saved state. If it can't resume in CLI, it will never recover from an SSE stream drop."

**Status:** This test does NOT exist. No CLI agent to interrupt.

**Impact:** 🚨 **This blocks Phase 6 (Event Streaming). You cannot safely stream events from an agent that cannot resume.**

---

### **PHASE 4: Context Retrieval Engine (Week 3)** — **0% COMPLETE — NOT STARTED**

#### ❌ MISSING
- Grep tool (pattern search across workspace)
- Probability narrowing (LLM selects top N candidates)
- Paginated read tool (fetch exact line ranges)
- No deterministic pipeline tested

---

### **PHASE 5: Reducer + Orchestrator — CLI-Testable (Weeks 3-4)** — **~5% COMPLETE**

#### ✅ PARTIAL
- Task model has `dependencies` field (edge list ready)
- Session model has `plan_state` for decomposed plan

#### ❌ MISSING (CRITICAL FOR CONCURRENCY)
- **No Redis Streams FIFO queue** (where do task completion events go?)
- **No reducer function** (`Apply_Event_To_State` does not exist)
- **No orchestrator** (superintendent that watches dependency graph)
- **No NetworkX cycle detection** (circular dependencies not validated before execution)
- **No concurrent load test** ("Spawn 5 agents simultaneously" test does not exist)
- **No lightweight graph executor** (nodes = tasks, edges = dependencies)

#### ⚠️ CONCERN
- Task model has a deprecated enum: `RETRY_COUNT = "retry_count"` (should be a field, not a status)
- No supervisor that listens for completion events and activates next eligible nodes

**Impact:** 🚨 **No multi-task orchestration exists. Every agent is solo. Parallel execution is impossible.**

---

### **PHASE 6: Event Streaming (SSE) + HTTP Control (Weeks 4-5)** — **~40% COMPLETE**

#### ✅ PARTIAL
- SSE endpoint exists: `GET /api/v1/sessions/{session_id}/stream`
- Bearer token auth on streaming requests
- Streaming response class configured
- `/api/v1/sessions` POST creates sessionId and stores in Redis
- HTTP control endpoints mentioned in spec (cancel, message)

#### ❌ ISSUE: STREAMING IS HARDCODED MOCK
```python
# Current event_generator() in stream_session():
yield f"data: {json.dumps({'id': 'evt-1', 'type': 'status', 'content': f'Calling model {settings.openrouter_model}...'})}
```
This is **not agent output**. It's a fake "running..." message. Then it calls OpenRouter once and returns.

#### ❌ MISSING: REDIS STREAMS BUFFERING
- No Redis Stream `session:{session_id}:events` exists
- No event persistence across SSE disconnects
- No `Last-Event-ID` header recovery mechanism
- All events are ephemeral in-memory

#### ❌ CRITICAL GAP: HOW DO AGENT EVENTS REACH SSE?
- Phase 3 (ReAct CLI) doesn't exist
- So there are no agent events to stream
- **Current flow:** User calls `/sessions/{id}/stream` → backend calls OpenRouter once → returns response
- **Should be:** Agent running → emits completion events to Redis → SSE reads from Redis → yields to client

#### ⚠️ TIMING VIOLATION
- Spec says Phase 6 comes AFTER Phase 5 (Orchestrator)
- But SSE was built before orchestrator exists
- Current SSE is synchronous (calls LLM, waits, returns)
- Real SSE needs async agent running independently while streaming events

---

### **PHASE 7: VS Code Extension + Live UI (Weeks 5-7)** — **~50% COMPLETE**

#### ✅ DONE
- TypeScript builds without errors (`npm run build` → 13.5 kB)
- Extension.ts activation logic (TokenManager, OAuthHandler, sidebar provider)
- Webview provider registered (`VertexSwarmSidebarProvider`)
- React components: LoginPanel, ChatPanel, InputArea, MessageRenderer, ConfirmDialog
- Zustand store (authStore) for state management
- Logout command registered
- CSS + Tailwind configured (tailwind.config.ts)

#### ❌ NOT TESTED YET
- Full extension launch in VS Code (F5 debug mode)
- OAuth flow completion (needs Neon Auth CLIENT_ID / CLIENT_SECRET)
- SSE event subscription in frontend (no visible event listener code)

#### ❌ MISSING: EVENT SUBSCRIPTION LOGIC
**Question:** When the user starts an agent, how does the frontend react to incoming SSE events?

Webview has chatId, sessionId from backend... but I don't see code that:
- Opens SSE stream with `session_id`
- Listens to incoming events
- Updates message feed in real-time

**Expected:** `useEffect` subscribes to `/sessions/{sessionId}/stream`, reads SSE events, appends to message array.

**Actual:** No visible SSE subscription in ChatPanel.tsx.

#### ⚠️ GAP: BACKEND-FRONTEND EVENT BRIDGE
- Backend streams events ✅
- Frontend renders events ❓ (unclear)
- Connection: SSE stream URL not visible in frontend code

---

### **PHASE 8: Sandbox + Autonomous Mode (Weeks 7-9)** — **0% COMPLETE — NOT STARTED**

#### ❌ MISSING
- Docker container lifecycle manager
- Shadow workspace cloning
- Patch generation (git diff)
- WorkspaceEdit injection (vscode.workspace.applyEdit)
- Merge conflict detection
- Garbage collection (active + passive)
- No snapshots stored in Postgres before mutations

---

### **PHASE 9: MCP Integration + Secrets Broker (Week 9)** — **0% COMPLETE — NOT STARTED**

#### ❌ MISSING
- MCP Python SDK adapter
- Tool registry integration
- Vault credential scoping
- TTL token lifecycle management

---

### **PHASE 10: Evaluators + HITL Escalation (Weeks 9-10)** — **0% COMPLETE — NOT STARTED**

#### ❌ MISSING
- FunctionalEvaluator, SecurityEvaluator, RegressionEvaluator
- Escalation nodes in dependency graph
- Freeze scope isolation (parallel branches continue)
- Escalation budget enforcement (max 3)

---

### **PHASE 11: Observability + Tool Anomaly Detection (Weeks 10-11)** — **~10% COMPLETE**

#### ✅ PARTIAL
- Loguru mentioned in tech stack
- OpenTelemetry + Prometheus config exists in requirements
- Settings configured for log level

#### ❌ MISSING
- Actual trace spans per ReAct step
- Tool success/failure metrics
- Anomaly detection layers 1, 2, 3
- No instrumentation in running code

---

### **PHASE 12: Continuous Planner + Polish (Weeks 11-12)** — **0% COMPLETE — NOT STARTED**

#### ❌ MISSING
- Event subscription loop (listens to Redis Streams)
- Continuous replanning on task failure
- North Star validation on re-decomposition
- Result summarization UI

---

---

## 🚨 SECTION 2: CRITICAL CONTRADICTIONS & ARCHITECTURAL FLAWS

### **1. HARD GATE MISSING: Resume Test Not Implemented (BLOCKS EVERYTHING)**

**Spec states (Roadmap, Phase 3):**
> "The Resume Test is a hard gate at Phase 3. Interrupt the CLI agent, restart it, verify it resumes. If it can't resume in CLI, it will never recover from an SSE stream drop."

**Reality:**
- No CLI agent exists to interrupt
- No resume test implemented
- Phase 6 (Event Streaming) was started anyway

**Impact:**
- 🔴 **CRITICAL:** SSE recovery (Last-Event-ID mechanism) is untested
- If real agent crashes mid-execution, you have no proof it can resume from saved session state
- This is a distributed system reliability guarantee you're building without validation

**Fix Required:** Implement Phase 3 ReAct loop + resume test before any more SSE work.

---

### **2. Event Streaming Disconnected from Real Agent Execution**

**Spec says (Phase 6):**
> "SSE Stream Format: event: agent_step, id: 12345, data: {type: "thought", content: "reading file..."}"

**Reality:**
```python
# Current stream_session() in sessions.py:
yield f"data: {json.dumps({'id': 'evt-1', 'type': 'status', 'content': f'Calling model...'})}
# Then:
yield f"data: {json.dumps({'type': 'output', 'content': response})}"
```

- Emits mock status
- Calls OpenRouter once (blocking wait ~2 seconds)
- Returns final response
- **No agent loop running**
- **No tool calls emitted**
- **No Redis Streams FIFO**

**Impact:**
- 🔴 **CRITICAL:** What you have is a "call LLM once" endpoint, not a streaming agent engine
- When Phase 3 (ReAct loop) is built, SSE will need a complete rewrite to consume from Redis Streams instead of calling LLM directly

**Fix Required:** After Phase 3 exists, refactor stream_session() to:
1. Load agent execution loop from Redis Streams
2. Emit each stored event (not mock events)
3. Implement Last-Event-ID recovery

---

### **3. Orchestrator Doesn't Exist — No Multi-Task Execution**

**Spec says (Phase 5):**
> "Reducer: A dedicated Apply_Event_To_State function pulls one event, adds payload to working memory, saves state. Processing one event at a time makes race conditions impossible."

**Reality:**
- Task model exists with `dependencies` field ✅
- But NO code executes the dependency graph
- NO code listens for task completion events
- NO code applies events to shared state
- NO concurrent load test__ exists

**Impact:**
- 🔴 **CRITICAL:** Every agent runs in isolation. No parallel execution.
- User submits a plan with 5 independent tasks → they run sequentially (wasteful)
- No supervisor validates that Agent B finished before Agent C starts (dependency graph ignored)

**Example of Missing Code:**
```python
# Does not exist:
class Reducer:
    async def apply_event_to_state(event: TaskCompletionEvent) -> None:
        # Load working memory
        # Append event payload
        # Validate constraints
        # Save state
        
class Orchestrator:
    async def execute_graph(tasks: List[Task]) -> None:
        # Fire ready nodes
        # Listen for completion events in Redis
        # Activate next eligible nodes
```

**Fix Required:** Implement full Phase 5 before autonomous mode (Phase 8). Cannot safely parallelize without this.

---

### **4. OAuth Flow Was Quietly Refactored — No Visible New Code**

**Spec says (Project Overview):**
> "Session JWT token (obtained from Neon Auth via OAuth 2) is stored securely in the Extension's SecretStorage"

**Repo memory says:**
> "Extension now finishes verifier exchange in the browser callback page on localhost, then posts the session token back to the extension"

**Reality:**
- Spec describes standard OAuth 2.0 (`/authorize` → `/token`)
- Actual Neon Auth uses: `POST /sign-in/social` → returns provider URL → browser verifier flow → callback posts token
- **No code visible in extension.ts showing verifier exchange**
- TokenManager stores token, but **where does token come from?**

**Mystery:**
```typescript
// extension.ts shows:
const oauthHandler = new OAuthHandler(tokenManager, context);

// But OAuthHandler.ts is not shown. Does it:
// 1. Call /sign-in/social?
// 2. Open browser to provider init URL?
// 3. Listen on localhost callback?
// 4. Exchange verifier?
```

**Impact:**
- 🔴 **MEDIUM:** OAuth flow works (tests pass) but the mechanics in the extension are undocumented
- If OAuth breaks, you won't clearly see why (verifier flow is non-standard)

**Fix Required:** Document the Neon Auth flow in oauth-handler.ts with explicit verifier exchange comments. Test full OAuth flow (requires Neon Auth credentials).

---

### **5. Frontend Doesn't Subscribe to SSE Events**

**Spec says (Phase 7):**
> "Active Control Panel during execution: live log stream, progress indicator, token usage meter, runtime clock"

**Reality:**
```typescript
// App.tsx:
const App: React.FC = () => {
  const { isAuthenticated, initializeExtensionBridge } = useAuthStore()
  return isAuthenticated ? <ChatPanel /> : <LoginPanel />
}

// ChatPanel.tsx: Not shown, but suspected to have:
// - Message list
// - Input area
// ❌ But where is SSE subscription?
```

**Missing Code (Expected):**
```typescript
useEffect(() => {
  if (!sessionId) return
  
  const eventSource = new EventSource(`/api/v1/sessions/${sessionId}/stream`, {
    headers: { Authorization: `Bearer ${token}` }
  })
  
  eventSource.onmessage = (event) => {
    const data = JSON.parse(event.data)
    setMessages(prev => [...prev, data])
  }
  
  return () => eventSource.close()
}, [sessionId, token])
```

**Impact:**
- 🟡 **MEDIUM:** Frontend is UI-ready but the real-time event binding is missing
- Symptom: User clicks "Run Agent" → nothing appears in chat (events aren't rendered)

**Fix Required:** Add SSE event subscription in ChatPanel.tsx. Test by running backend and watching events appear.

---

### **6. Working Memory Compression Is Stubbed (Phase 1)**

**Spec says:**
> "If working memory exceeds threshold, the supervisor compresses it via LLM summarization before passing to next agent"

**Code in session_store.py:**
```python
async def compress_working_memory(working_memory: Dict) -> Dict:
    """
    TODO: Compress via LLM (Phase 2: actual LLM; MVP: placeholder)
    """
    # placeholder
    return working_memory
```

**Impact:**
- 🟡 **LOW:** Won't break execution now (MVP doesn't hit memory limits)
- But long-running sessions will eventually hit cap and fail silently

**Fix Required:** Implement LLM compression when real multi-task plans run (aroundPhase 5-6).

---

### **7. Async/Await Thread Blocking Assumptions Not Verified**

**Spec says (Project Overview):**
> "Thread Non-Blocking: The VS Code Extension Host remains reactive. The cursor blinks, and the IDE is fully usable because the initial handshake is asynchronous."

**Reality:**
```python
# sessions.py — stream_session():
full_response = ""
async for chunk in stream_chat_completion(api_key, model, messages):
    full_response += chunk
    yield f"data: {json.dumps({'type': 'output_chunk', 'content': chunk})}"
```

This is streaming the LLM response, which is good. But when Phase 3 exists (ReAct loop), you'll have:
```python
while iteration < max_iterations:
    response = await llm_call()  # OK, async
    tool_name, args = parse_json(response)  # OK, sync
    result = execute_tool(tool_name, args)  # ⚠️ If tool is subprocess call, it blocks!
```

**Issue:**
- If `execute_tool()` runs `subprocess.run()` (synchronous), the event loop blocks
- FastAPI can't process other requests while this agent's subprocess runs
- This violates the "thread non-blocking" guarantee

**Impact:**
- 🟡 **MEDIUM:** Won't notice until you test with 2+ concurrent agents
- Symptom: One agent runs a 5-second subprocess → all other SSE streams freeze

**Fix Required:** Wrap subprocess execution in `asyncio.to_thread()` or use `asyncio.create_subprocess_exec()`.

---

### **8. No Clear Separation: MVP vs. Phase 8 (Sandbox)**

**Spec says:**
> "Phase 8+: ALL execution state persists. No ephemeral loss on disconnect. [PHASE 8+] Buffered token stream for LLM response (sandbox context)"

**But EphemeralSessionState exists in Session model now:**
```python
class EphemeralSessionState(BaseModel):
    in_flight_tool_call: Optional[Dict[str, Any]] = None  # [PHASE 8+]
    streaming_buffer: List[str] = Field(default_factory=list)  # [PHASE 8+]
```

**Issue:**
- Model is forward-declared (good) but comments suggest it's not used in Phase 1-7
- When Phase 8 starts (sandbox mode), how does this field change behavior?
- No clear boundary marker

**Impact:**
- 🟡 **LOW:** Doesn't break current work, but adds cognitive load

**Fix Required:** Add a feature flag `PHASE_8_SANDBOX_ENABLED` or remove ephemeral fields from Phase 1-7 models entirely. Write them back in Phase 8.

---

### **9. Configuration Secrets Not Wired (Vault, Credentials)**

**Spec says:**
> "Agent requests scoped token with TTL from secrets broker at runtime. Child agents never persist credentials in memory."

**Reality:**
- Settings.openrouter_api_key is stored in `.env`
- No Vault integration exists
- No credential scoping per agent
- No TTL token revocation

**Impact:**
- 🔴 **CRITICAL FOR PRODUCTION:** Long-lived credentials in memory = credential leak risk
- When Phase 9 (MCP) brings external tools (GitHub, etc.), credentials will be unscoped

**Fix Required:** Implement Vault integration in Phase 9, but draft credential scoping contract now.

---

### **10. Session TTL Archival Job: Status Unknown**

**Spec says (Phase 1):**
> "Every 5 minutes, scan for sessions where `last_message_at > 3 hours` AND `agent_status == INACTIVE`. Archive to Postgres."

**Code exists:**
```python
# app/infrastructure/jobs/archival_job.py
# Initialized in lifespan ✅
```

**But.**
- No log evidence archival is running (check test output)
- No integration test: create session 3 hours old with agent_status=INACTIVE, verify it archives
- No test for recovery: archive → reconnect → load from Postgres

**Impact:**
- 🟡 **MEDIUM:** If archival silently fails, Redis fills up with dead sessions
- Symptom: Memory leaks, no obvious cause

**Fix Required:** Test archival job end-to-end. Create the missing test.

---

---

## 📊 COMPLETION SUMMARY TABLE

| Phase | Task | Roadmap | Reality | Status | Blocker? |
|-------|------|---------|---------|--------|----------|
| 1 | Data Models + DB | ✅ | ✅ | 70% | No |
| 2 | User Auth | ✅ | ~80% | PARTIAL | ❓ OAuth docs |
| 3 | ReAct Loop (CLI) | ✅ | ❌ | 30% | **YES** 🔴 |
| 4 | Context Engine | ✅ | ❌ | 0% | Depends on 3 |
| 5 | Orchestrator | ✅ | ❌ | 5% | **YES** 🔴 |
| 6 | Event Streaming | ✅ | ~40% | PARTIAL | Depends on 3,5 |
| 7 | Extension UI | ✅ | ~50% | PARTIAL | Depends on 6 |
| 8 | Sandbox | ✅ | ❌ | 0% | Depends on 3,5 |
| 9 | MCP | ✅ | ❌ | 0% | Depends on 8 |
| 10 | Evaluators | ✅ | ❌ | 0% | Depends on 8 |
| 11 | Observability | ✅ | ❌ | 10% | Depends on 3,5 |
| 12 | Planner | ✅ | ❌ | 0% | Depends on 5,11 |

**Critical Path Blockers:**
1. 🔴 **Phase 3 (ReAct CLI)** — Everything downstream waits for this
2. 🔴 **Phase 5 (Orchestrator)** — Multi-task execution impossible without this
3. 🟡 **Phase 6 refactor** — SSE must be relinked to real agent events (after 3)

---

## ✅ IMMEDIATE ACTION ITEMS (Next Steps)

### **WEEK 1-2: Finish Phase 3 (ReAct Loop)**
1. Implement CLI agent runner: `python -m app.agents.react_loop --task "..."`
2. Wire tool registry to actual execution
3. **Implement and gate the Resume Test** (interrupt → reconnect → state matches)
4. Test token budget enforcement

### **WEEK 2-3: Implement Phase 5 (Orchestrator)**
1. Build FIFO task completion event queue (Redis Streams)
2. Implement Reducer: `apply_event_to_state()`
3. Implement Orchestrator: dependency graph executor
4. Test concurrent load (spawn 5 agents, verify state integrity)

### **WEEK 3: Refactor Phase 6 (SSE)**
1. Relink `stream_session()` to Redis Streams (not mock)
2. Implement Last-Event-ID recovery
3. Remove the LLM call from SSE (events come from agent, not direct LLM)

### **WEEK 3-4: Test Extension E2E**
1. Launch extension with F5 (requires Neon Auth credentials)
2. Add SSE event subscription in ChatPanel.tsx
3. Test full flow: auth → create session → start agent → watch events appear

### **Documentation Debt**
1. Document Neon Auth verifier flow in oauth-handler.ts
2. Create test for session archival (3-hour TTL)
3. Add inline comments marking [PHASE 8+] code that's inactive

---

## 🎯 FINAL ASSESSMENT

**You have a solid foundation (Phases 1-2), but critical execution logic is missing.**

- ✅ Database + Auth framework ready
- ✅ Extension UI ready to receive events
- ❌ **Agent execution engine doesn't exist yet**
- ❌ **Multi-task orchestration missing**
- ❌ **Event streaming decoupled from real execution**

**Right now, if a user submits a task:**
1. Session is created in Redis ✅
2. SSE stream is opened ✅
3. Backend calls OpenRouter once 🟡 (not a ReAct loop)
4. Response is returned 🟡 (no tool execution)
5. Session is abandoned 🟡 (gets archived after 3 hours)

**What's missing to be "real":**
- Actual multi-step agent reasoning
- Multi-task dependency graph execution
- Tool execution inside sandbox
- User-facing patch injection

**ETA to Phase 8 (Sandbox) at current velocity:** ~8-10 more weeks (total 16 weeks)

**Recommendation:** Lock Phase 1-2 as "stable", dedicate the next 4 weeks to Phases 3-5, then Extension UI will have real agent events to display.

---

*Audit conducted: March 10, 2026 | Baseline: Roadmap + Project Overview vs. Implementation Code*
