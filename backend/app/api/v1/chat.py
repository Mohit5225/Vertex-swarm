"""Chat endpoints — create chats, send messages with LLM streaming, load history."""
import json
import logging
from datetime import datetime, timezone
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, status
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
from sqlalchemy import select, desc
from typing import Optional

from app.auth.dependencies import AuthenticatedUser, get_current_user
from app.db.postgres.connection import AsyncSessionLocal
from app.db.postgres.models import ChatORM, MessageORM
from app.services.llm_service import stream_chat_completion

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/v1/chats", tags=["chats"])


class CreateChatRequest(BaseModel):
    title: Optional[str] = None


class SendMessageRequest(BaseModel):
    content: str


# ============================================================================
# POST /api/v1/chats — Create a new chat
# ============================================================================

@router.post("", status_code=status.HTTP_201_CREATED)
async def create_chat(
    req: CreateChatRequest,
    user: AuthenticatedUser = Depends(get_current_user),
):
    async with AsyncSessionLocal() as db:
        chat = ChatORM(user_id=user.user_id, title=req.title)
        db.add(chat)
        await db.commit()
        await db.refresh(chat)

    return {
        "chatId": str(chat.chat_id),
        "title": chat.title,
        "createdAt": chat.created_at.isoformat(),
        "updatedAt": chat.updated_at.isoformat(),
    }


# ============================================================================
# GET /api/v1/chats — List all chats for the authenticated user
# ============================================================================

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
            "createdAt": c.created_at.isoformat(),
            "updatedAt": c.updated_at.isoformat(),
        }
        for c in chats
    ]


# ============================================================================
# POST /api/v1/chats/{chat_id}/messages — Send message, stream LLM response
# ============================================================================

@router.post("/{chat_id}/messages", response_class=StreamingResponse)
async def send_message(
    chat_id: UUID,
    req: SendMessageRequest,
    user: AuthenticatedUser = Depends(get_current_user),
):
    # Verify chat belongs to this user before starting stream
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

    async def event_stream():
        # Phase 1: persist user message + load history for LLM context
        async with AsyncSessionLocal() as db:
            user_msg = MessageORM(
                chat_id=chat_id,
                role="user",
                content=req.content,
            )
            db.add(user_msg)

            chat_row = await db.get(ChatORM, chat_id)
            if chat_row and not chat_row.title:
                normalized_title = " ".join(req.content.split())
                chat_row.title = normalized_title[:80] if normalized_title else "Untitled chat"

            await db.commit()
            await db.refresh(user_msg)

            history_result = await db.execute(
                select(MessageORM)
                .where(MessageORM.chat_id == chat_id)
                .order_by(MessageORM.created_at)
            )
            history = history_result.scalars().all()

        llm_messages = [{"role": m.role, "content": m.content} for m in history]

        # Phase 2: stream tokens from OpenRouter
        full_response = ""
        try:
            async for token in stream_chat_completion(llm_messages):
                full_response += token
                yield f"data: {json.dumps({'type': 'token', 'content': token})}\n\n"
        except Exception as exc:
            error_details = str(exc)
            logger.error(f"LLM stream error for chat {chat_id}: {error_details}", exc_info=True)
            yield f"data: {json.dumps({'type': 'error', 'content': f'LLM stream failed: {error_details}'})}\n\n"
            return

        # Phase 3: persist assistant message + bump chat updated_at
        async with AsyncSessionLocal() as db:
            asst_msg = MessageORM(
                chat_id=chat_id,
                role="assistant",
                content=full_response,
            )
            db.add(asst_msg)

            # Refresh chat updated_at so list ordering stays correct
            chat_row = await db.get(ChatORM, chat_id)
            if chat_row:
                chat_row.updated_at = datetime.now(timezone.utc)

            await db.commit()
            await db.refresh(asst_msg)

        yield f"data: {json.dumps({'type': 'done', 'messageId': str(asst_msg.message_id)})}\n\n"

    return StreamingResponse(
        event_stream(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",
        },
    )


# ============================================================================
# GET /api/v1/chats/{chat_id}/messages — Load full message history
# ============================================================================

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

    return [
        {
            "messageId": str(m.message_id),
            "role": m.role,
            "content": m.content,
            "events": m.events,
            "createdAt": m.created_at.isoformat(),
        }
        for m in messages
    ]
