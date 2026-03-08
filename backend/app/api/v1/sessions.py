"""Session endpoints (Phase 3) — Create sessions and stream agent responses via SSE"""
import json
import logging
import uuid
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, status
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from app.auth.dependencies import AuthenticatedUser, get_current_user
from app.core.config import settings
from app.infrastructure.cache import store_session_state, retrieve_session_state, get_redis
from app.models.session import SessionState
from app.services.llm_service import stream_chat_completion

router = APIRouter(prefix="/api/v1/sessions", tags=["sessions"])
logger = logging.getLogger(__name__)


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
            "last_message_at": datetime.now(timezone.utc),
        }
    )
    
    # Store in Redis (expires in 3 hours)
    await store_session_state(session_id, session_state, ttl=10800)

    # Store user_id separately so archival job can attribute the archived record
    redis_client = await get_redis()
    await redis_client.setex(f"session:{session_id}:user_id", 10800, user.user_id)

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
    Stream a real LLM response for the session via Server-Sent Events (SSE).

    Event types:
    - "status": Lifecycle status messages
    - "output": Final model response to user
    - "error": Execution error

    Flow:
    1. Load session from Redis and verify user ownership
    2. Call the configured OpenRouter model
    3. Emit the final response when generation completes
    
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

    redis_client = await get_redis()
    owner_user_id = await redis_client.get(f"session:{session_id}:user_id")
    if owner_user_id and owner_user_id != user.user_id:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="You do not have access to this session",
        )

    # SessionState.persisted is a Pydantic model, not a dict.
    user_message = session_state.persisted.working_memory.get("user_message", "test")
    
    async def event_generator():
        """Generate SSE events backed by OpenRouter instead of mock tool traces."""
        try:
            if not settings.openrouter_api_key:
                raise RuntimeError("OpenRouter is not configured on the backend")

            session_state.persisted.working_memory["status"] = "running"
            await store_session_state(session_id, session_state, ttl=10800)

            yield f"data: {json.dumps({'id': 'evt-1', 'type': 'status', 'content': f'Calling model {settings.openrouter_model}...'})}\n\n"

            full_response = ""
            async for token in stream_chat_completion(
                [{"role": "user", "content": user_message}]
            ):
                full_response += token

            if not full_response.strip():
                raise RuntimeError("OpenRouter returned an empty response")

            session_state.persisted.working_memory["status"] = "completed"
            session_state.persisted.working_memory["assistant_response"] = full_response
            session_state.persisted.last_message_at = datetime.now(timezone.utc)
            await store_session_state(session_id, session_state, ttl=10800)

            yield f"data: {json.dumps({'id': 'evt-2', 'type': 'output', 'content': full_response})}\n\n"

        except Exception as e:
            error_msg = str(e)
            logger.error("Session stream failed for %s: %s", session_id, error_msg, exc_info=True)
            session_state.persisted.working_memory["status"] = "failed"
            session_state.persisted.working_memory["last_error"] = error_msg
            await store_session_state(session_id, session_state, ttl=10800)
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

