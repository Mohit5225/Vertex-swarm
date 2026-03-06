"""Session endpoints (Phase 3) — Create sessions and stream agent responses via SSE"""
import asyncio
import json
import uuid
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, status
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from app.models.session import Session, SessionState
from app.services.auth_dependency import AuthenticatedUser, get_current_user
from app.infrastructure.cache import store_session_state, retrieve_session_state

router = APIRouter(prefix="/api/v1/sessions", tags=["sessions"])


class CreateSessionRequest(BaseModel):
    """Request to create a new session"""
    message: str


@router.post(
    "",
    status_code=status.HTTP_201_CREATED,
    response_model=dict,
    summary="Create a new session",
    description="Initialize a new session and return sessionId for streaming responses"
)
async def create_session(
    req: CreateSessionRequest,
    user: AuthenticatedUser = Depends(get_current_user)
):
    """
    Create a new session for the authenticated user.
    
    Flow:
    1. Generate unique session_id and run_id
    2. Store session state in Redis (TTL: 3 hours)
    3. Return sessionId for subsequent stream requests
    
    Args:
        req: CreateSessionRequest with user message
        user: Current authenticated user from JWT
    
    Returns:
        {
            "sessionId": "sess-xxx",
            "runId": "run-xxx",
            "createdAt": "2025-03-05T12:34:56Z"
        }
    """
    session_id = f"sess-{uuid.uuid4().hex[:16]}"
    run_id = f"run-{uuid.uuid4().hex[:16]}"
    
    # Create session state with initial message
    session_state = SessionState(
        persisted={
            "current_task_id": None,
            "completed_task_ids": [],
            "failed_task_ids": [],
            "working_memory": {
                "user_message": req.message,
                "status": "initializing"
            },
            "token_count": 0,
            "plan_state": None,
        }
    )
    
    # Store in Redis (expires in 3 hours)
    await store_session_state(session_id, session_state)
    
    return {
        "sessionId": session_id,
        "runId": run_id,
        "createdAt": datetime.now(timezone.utc).isoformat(),
    }


@router.get(
    "/{session_id}/stream",
    status_code=status.HTTP_200_OK,
    response_class=StreamingResponse,
    summary="Stream session responses via SSE",
    description="Returns server-sent events (SSE) for agent execution trace and results"
)
async def stream_session(
    session_id: str,
    user: AuthenticatedUser = Depends(get_current_user)
):
    """
    Stream agent execution events via Server-Sent Events (SSE).
    
    Phase 3 Implementation: Mock streaming with realistic event sequence.
    Future: Replace with actual agent execution subprocess.
    
    Event types:
    - "thinking": Agent's reasoning trace
    - "tool_call": Calling external tool with args
    - "tool_result": Return value from tool
    - "output": Final agent response to user
    - "error": Execution error
    
    Flow:
    1. Load session from Redis (verify user ownership)
    2. Stream mock events every 500ms (realistic delay)
    3. Close stream when events exhaust
    
    Args:
        session_id: Session ID to stream from
        user: Current authenticated user (verify ownership)
    
    Returns:
        StreamingResponse with Content-Type: text/event-stream
    """
    # Verify session exists and belongs to user
    session_state = await retrieve_session_state(session_id)
    if not session_state:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Session {session_id} not found"
        )
    
    # Get user message from session
    user_message = session_state.persisted.get("working_memory", {}).get("user_message", "test")
    
    async def event_generator():
        """Generate SSE events."""
        try:
            # Event 1: Thinking trace
            await asyncio.sleep(0.5)
            yield f"data: {json.dumps({'id': 'evt-1', 'type': 'thinking', 'content': f'Analyzing user request: {user_message}'})}\n\n"
            
            # Event 2: Tool call (simulated)
            await asyncio.sleep(0.5)
            yield f"data: {json.dumps({'id': 'evt-2', 'type': 'tool_call', 'toolName': 'search', 'args': {'query': user_message}})}\n\n"
            
            # Event 3: Tool result
            await asyncio.sleep(0.5)
            yield f"data: {json.dumps({'id': 'evt-3', 'type': 'tool_result', 'content': f'Found 5 results for: {user_message}'})}\n\n"
            
            # Event 4: Thinking continued
            await asyncio.sleep(0.5)
            yield f"data: {json.dumps({'id': 'evt-4', 'type': 'thinking', 'content': 'Synthesizing results into response...'})}\n\n"
            
            # Event 5: Final output
            await asyncio.sleep(0.5)
            output_text = f"Based on your request '{user_message}', here are the key findings:\n\n1. **Finding 1**: Description of result\n2. **Finding 2**: Another important point\n3. **Finding 3**: Final insight"
            yield f"data: {json.dumps({'id': 'evt-5', 'type': 'output', 'content': output_text})}\n\n"
            
            # Signal completion
            await asyncio.sleep(0.3)
            
        except Exception as e:
            error_msg = str(e)
            yield f"data: {json.dumps({'id': 'evt-error', 'type': 'error', 'content': f'Stream error: {error_msg}'})}\n\n"
    
    return StreamingResponse(
        event_generator(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",  # Disable proxy buffering in nginx/apache
        }
    )


__all__ = ["router"]

