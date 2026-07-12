"""Chat endpoints - create chats, send messages with LLM streaming, load history."""
import json
import logging
from datetime import datetime, timezone
from typing import Any, Optional
from uuid import UUID, uuid4

from fastapi import APIRouter, Depends, HTTPException, status, Request
import asyncio
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
from sqlalchemy import desc, select



from app.auth.dependencies import AuthenticatedUser, get_current_user
from app.core.config import settings
from app.db.postgres.connection import AsyncSessionLocal
from app.db.postgres.models import ChatORM, MessageORM
from app.db.redis_db import get_redis, retrieve_session_state, store_session_state, tool_result_stream_key
from app.db.redis_sessions import bootstrap_chat_session, build_chat_session_id

logger = logging.getLogger(__name__)

ACTIVE_AGENT_TASKS: dict[str, asyncio.Task] = {}

from app.orchestrator import run_agent_loop

router = APIRouter(prefix="/api/v1/chats", tags=["chats"])


class CreateChatRequest(BaseModel):
    title: Optional[str] = None
    ide_context_enabled: bool = False


class SendMessageRequest(BaseModel):
    content: str
    workspace_skeleton: Optional[str] = None
    ide_context_enabled: Optional[bool] = None
    request_context: Optional[dict[str, Any]] = None


class UpdateIdeContextRequest(BaseModel):
    enabled: bool


















@router.post("", status_code=status.HTTP_201_CREATED)
async def create_chat(
    req: CreateChatRequest,
    user: AuthenticatedUser = Depends(get_current_user),
):
    async with AsyncSessionLocal() as db:
        chat = ChatORM(
            user_id=user.user_id,
            title=req.title,
            ide_context_enabled=req.ide_context_enabled,
        )
        db.add(chat)
        await db.commit()
        await db.refresh(chat)

    return {
        "chatId": str(chat.chat_id),
        "title": chat.title,
        "ideContextEnabled": chat.ide_context_enabled,
        "createdAt": chat.created_at.isoformat(),
        "updatedAt": chat.updated_at.isoformat(),
    }


@router.get("")
async def list_chats(user: AuthenticatedUser = Depends(get_current_user)):
    async with AsyncSessionLocal() as db:
        result = await db.execute(
            select(ChatORM)
            .where(ChatORM.user_id == user.user_id)
            .order_by(desc(ChatORM.updated_at))
        )
        chats = result.scalars().all()

    return [
        {
            "chatId": str(c.chat_id),
            "title": c.title,
            "ideContextEnabled": c.ide_context_enabled,
            "createdAt": c.created_at.isoformat(),
            "updatedAt": c.updated_at.isoformat(),
        }
        for c in chats
    ]





@router.post("/{chat_id}/messages", status_code=status.HTTP_202_ACCEPTED)
async def send_message(
    chat_id: UUID,
    req: SendMessageRequest,
    user: AuthenticatedUser = Depends(get_current_user),
):
    async with AsyncSessionLocal() as db:
        chat_result = await db.execute(
            select(ChatORM).where(
                ChatORM.chat_id == chat_id,
                ChatORM.user_id == user.user_id,
            )
        )
        chat = chat_result.scalar_one_or_none()

    if not chat:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Chat not found")

    synthetic_session_id = build_chat_session_id(chat_id)

    await bootstrap_chat_session(
        synthetic_session_id,
        user.user_id,
        chat_id,
        req.content,
    )

    session_state = await retrieve_session_state(synthetic_session_id)
    existing_tool_memory = None
    existing_active_categories: list[str] = []
    if session_state is not None:
        existing_tool_memory = session_state.persisted.working_memory.get("tool_memory")
        raw_cats = session_state.persisted.working_memory.get("active_tool_categories", [])
        if isinstance(raw_cats, list):
            existing_active_categories = [c for c in raw_cats if isinstance(c, str)]

    logger.info(
        "message received user_id=%s chat_id=%s session_id=%s ide_context_enabled=%s",
        user.user_id,
        chat_id,
        synthetic_session_id,
        req.ide_context_enabled,
    )

    async with AsyncSessionLocal() as db:
        logger.info(
            "persisting user message user_id=%s chat_id=%s session_id=%s",
            user.user_id,
            chat_id,
            synthetic_session_id,
        )
        user_msg = MessageORM(
            chat_id=chat_id,
            role="user",
            content=req.content,
        )
        db.add(user_msg)

        chat_row = await db.get(ChatORM, chat_id)
        if chat_row:
            if req.ide_context_enabled is not None:
                chat_row.ide_context_enabled = req.ide_context_enabled
                logger.info(
                    "ide_context toggle loaded chat_id=%s enabled=%s",
                    chat_id,
                    req.ide_context_enabled,
                )

            if not chat_row.title:
                normalized_title = " ".join(req.content.split())
                chat_row.title = normalized_title[:80] if normalized_title else "Untitled chat"

        await db.commit()
        await db.refresh(user_msg)
        request_message_id = str(user_msg.message_id)

    async def _run_agent_loop_with_cleanup():
        try:
            await run_agent_loop(
                user_id=user.user_id,
                chat_id=chat_id,
                synthetic_session_id=synthetic_session_id,
                request_message_id=request_message_id,
                req_ide_context_enabled=req.ide_context_enabled,
                req_request_context=req.request_context,
                req_workspace_skeleton=req.workspace_skeleton,
                existing_active_categories=existing_active_categories,
                existing_tool_memory=existing_tool_memory,
            )
        finally:
            if ACTIVE_AGENT_TASKS.get(str(chat_id)) == asyncio.current_task():
                del ACTIVE_AGENT_TASKS[str(chat_id)]

    task = asyncio.create_task(_run_agent_loop_with_cleanup())
    ACTIVE_AGENT_TASKS[str(chat_id)] = task
    
    return {"status": "accepted", "message_id": request_message_id}


@router.get("/{chat_id}/messages/{message_id}/stream", response_class=StreamingResponse)
async def stream_chat_events_from_redis(
    chat_id: UUID,
    message_id: str,
    request: Request,
    user: AuthenticatedUser = Depends(get_current_user),
):
    # Verify chat access
    async with AsyncSessionLocal() as db:
        chat_result = await db.execute(
            select(ChatORM).where(
                ChatORM.chat_id == chat_id,
                ChatORM.user_id == user.user_id,
            )
        )
        chat = chat_result.scalar_one_or_none()
        if not chat:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Chat not found")

    last_id = request.headers.get("Last-Event-ID", "0")
    stream_key = f"message-events:{message_id}"
    
    async def sse_generator():
        redis_client = await get_redis()
        current_id = last_id
        
        while True:
            if await request.is_disconnected():
                logger.info("SSE client disconnected chat_id=%s message_id=%s", chat_id, message_id)
                break
                
            try:
                # Block for up to 5 seconds
                stream_entries = await redis_client.xread(
                    {stream_key: current_id},
                    count=10,
                    block=5000,
                )
                
                if stream_entries:
                    for _, entries in stream_entries:
                        for entry_id, payload in entries:
                            current_id = entry_id
                            if b"payload" in payload:
                                # Data payload
                                data_str = payload[b"payload"].decode("utf-8")
                                yield f"id: {entry_id.decode('utf-8')}\ndata: {data_str}\n\n"
                                
                                # Check if it's a terminal event
                                try:
                                    parsed = json.loads(data_str)
                                    if parsed.get("type") in ("done", "error", "finished"):
                                        return
                                except json.JSONDecodeError:
                                    pass
                            elif "payload" in payload: # String keys
                                data_str = payload["payload"]
                                yield f"id: {entry_id}\ndata: {data_str}\n\n"
                                
                                try:
                                    parsed = json.loads(data_str)
                                    if parsed.get("type") in ("done", "error", "finished"):
                                        return
                                except json.JSONDecodeError:
                                    pass
                else:
                    # Keep connection alive during long tool executions to prevent upstream proxies from timing out
                    yield ": keepalive\n\n"
                            
            except asyncio.CancelledError:
                break
            except Exception as e:
                logger.error("Error reading redis stream chat_id=%s message_id=%s: %s", chat_id, message_id, e)
                yield f"data: {json.dumps({'type': 'error', 'content': 'Stream read error'})}\n\n"
                break

    return StreamingResponse(
        sse_generator(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",
        },
    )


@router.get("/{chat_id}/messages")
async def get_messages(
    chat_id: UUID,
    user: AuthenticatedUser = Depends(get_current_user),
):
    async with AsyncSessionLocal() as db:
        chat_result = await db.execute(
            select(ChatORM).where(
                ChatORM.chat_id == chat_id,
                ChatORM.user_id == user.user_id,
            )
        )
        chat = chat_result.scalar_one_or_none()

        if not chat:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Chat not found")

        msg_result = await db.execute(
            select(MessageORM)
            .where(MessageORM.chat_id == chat_id)
            .order_by(MessageORM.created_at)
        )
        messages = msg_result.scalars().all()

    return {
        "chatId": str(chat.chat_id),
        "ideContextEnabled": chat.ide_context_enabled,
        "messages": [
            {
                "messageId": str(m.message_id),
                "role": m.role,
                "content": m.content,
                "events": m.events,
                "createdAt": m.created_at.isoformat(),
            }
            for m in messages
        ],
    }


@router.patch("/{chat_id}/ide-context")
async def update_chat_ide_context(
    chat_id: UUID,
    req: UpdateIdeContextRequest,
    user: AuthenticatedUser = Depends(get_current_user),
):
    async with AsyncSessionLocal() as db:
        chat_result = await db.execute(
            select(ChatORM).where(
                ChatORM.chat_id == chat_id,
                ChatORM.user_id == user.user_id,
            )
        )
        chat = chat_result.scalar_one_or_none()

        if not chat:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Chat not found")

        chat.ide_context_enabled = req.enabled
        chat.updated_at = datetime.now(timezone.utc)
        await db.commit()
        await db.refresh(chat)

    return {
        "chatId": str(chat.chat_id),
        "ideContextEnabled": chat.ide_context_enabled,
        "updatedAt": chat.updated_at.isoformat(),
    }


class CancelRequest(BaseModel):
    reason: Optional[str] = None


@router.post("/{chat_id}/cancel")
async def cancel_chat_stream(
    chat_id: UUID,
    req: CancelRequest = None,
    user: AuthenticatedUser = Depends(get_current_user),
):
    """
    Cancel an active chat stream and record the cancellation in conversation history.
    This creates a system message so the LLM is aware the user cancelled the operation
    when it reconstructs conversation context on the next message.
    """
    reason = req.reason if req else None
    
    async with AsyncSessionLocal() as db:
        chat_result = await db.execute(
            select(ChatORM).where(
                ChatORM.chat_id == chat_id,
                ChatORM.user_id == user.user_id,
            )
        )
        chat = chat_result.scalar_one_or_none()

        if not chat:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Chat not found")

        # Record cancellation as a system message so LLM knows it happened
        # This ensures context is maintained across page reloads and reconnects
        cancellation_message = MessageORM(
            chat_id=chat_id,
            role="system",
            content=f"User cancelled the operation. Reason: {reason or 'No reason provided'}",
            events=[
                {
                    "id": f"evt-cancel-{datetime.now(timezone.utc).timestamp()}",
                    "type": "status",
                    "content": "User cancelled the operation.",
                    "timestamp": int(datetime.now(timezone.utc).timestamp() * 1000),
                    "metadata": {
                        "phase": "cancelled",
                        "cancelledBy": "user",
                        "reason": reason or "user-requested",
                    },
                }
            ],
        )
        db.add(cancellation_message)
        await db.commit()

    task = ACTIVE_AGENT_TASKS.get(str(chat_id))
    if task and not task.done():
        logger.info("Cancelling active agent task for chat_id=%s", chat_id)
        task.cancel()

    logger.info(
        "chat stream cancelled user_id=%s chat_id=%s reason=%s message_id=%s",
        user.user_id,
        chat_id,
        reason or "user-requested",
        cancellation_message.message_id,
    )

    return {
        "chatId": str(chat_id),
        "status": "cancelled",
        "message": "Stream cancellation recorded. The LLM will be aware of this in the next message.",
    }


@router.delete("/{chat_id}/messages/truncate-after/{message_id}", status_code=status.HTTP_200_OK)
async def truncate_messages_after(
    chat_id: UUID,
    message_id: UUID,
    user: AuthenticatedUser = Depends(get_current_user),
):
    """
    Delete all messages that come AFTER the given message_id in this chat.
    Used by the Edit Message flow: the user edits message N, so we delete
    messages N+1, N+2, ... from the DB so the next send_message call builds
    a clean history from message N onward.

    Returns the sessionId (Redis key) so the extension can restore the
    matching snapshot without re-deriving it.
    """
    async with AsyncSessionLocal() as db:
        # Verify chat ownership
        chat_result = await db.execute(
            select(ChatORM).where(
                ChatORM.chat_id == chat_id,
                ChatORM.user_id == user.user_id,
            )
        )
        chat = chat_result.scalar_one_or_none()
        if not chat:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Chat not found")

        # Find the anchor message
        anchor_result = await db.execute(
            select(MessageORM).where(
                MessageORM.message_id == message_id,
                MessageORM.chat_id == chat_id,
            )
        )
        anchor = anchor_result.scalar_one_or_none()
        if not anchor:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Message not found")

        anchor_created_at = anchor.created_at

        # Delete all messages created strictly after the anchor
        delete_result = await db.execute(
            delete(MessageORM).where(
                MessageORM.chat_id == chat_id,
                MessageORM.created_at >= anchor_created_at,
            )
        )
        deleted_count = delete_result.rowcount

        # Update chat.updated_at
        chat.updated_at = datetime.now(timezone.utc)
        await db.commit()

    session_id = build_chat_session_id(chat_id)

    logger.info(
        "messages truncated user_id=%s chat_id=%s anchor_message_id=%s deleted_count=%s",
        user.user_id,
        chat_id,
        message_id,
        deleted_count,
    )

    return {
        "chatId": str(chat_id),
        "messageId": str(message_id),
        "sessionId": session_id,
        "deletedCount": deleted_count,
    }
