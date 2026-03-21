"""Tool result ingestion endpoints."""
import json
import logging
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import select

from app.auth.dependencies import AuthenticatedUser, get_current_user
from app.db.postgres.connection import AsyncSessionLocal
from app.db.postgres.models import ChatORM, MessageORM
from app.db.redis_db import get_redis, tool_result_stream_key
from app.schemas.tool import ToolResultSchema, ToolResultAckSchema

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/v1/tools", tags=["tools"])


@router.post("/result", response_model=ToolResultAckSchema)
async def receive_tool_result(
    result: ToolResultSchema,
    user: AuthenticatedUser = Depends(get_current_user),
):
    """
    Receive structured tool output from extension host.

    Validation chain:
    1) Authenticated user owns chat_id
    2) message_id belongs to chat_id
    3) session_id (if active in Redis) matches authenticated user
    """

    try:
        chat_uuid = UUID(result.chat_id)
    except ValueError as exc:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="Invalid chat_id format",
        ) from exc

    try:
        message_uuid = UUID(result.message_id)
    except ValueError as exc:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="Invalid message_id format",
        ) from exc

    async with AsyncSessionLocal() as db:
        chat_query = await db.execute(
            select(ChatORM).where(
                ChatORM.chat_id == chat_uuid,
                ChatORM.user_id == user.user_id,
            )
        )
        chat = chat_query.scalar_one_or_none()

        if chat is None:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="Chat does not belong to the authenticated user",
            )

        message_query = await db.execute(
            select(MessageORM).where(
                MessageORM.message_id == message_uuid,
                MessageORM.chat_id == chat_uuid,
            )
        )
        message = message_query.scalar_one_or_none()

        if message is None:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="Message does not belong to the specified chat",
            )

    redis_client = await get_redis()

    # If session ownership is known in Redis, enforce user binding to prevent cross-user result injection.
    session_owner_key = f"session:{result.session_id}:user_id"
    session_owner = await redis_client.get(session_owner_key)
    if session_owner and session_owner != user.user_id:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Session does not belong to the authenticated user",
        )

    stream_key = tool_result_stream_key(
        result.session_id,
        result.chat_id,
        result.message_id,
        result.tool_call_id,
    )
    await redis_client.xadd(stream_key, {"payload": json.dumps(result.model_dump(mode='json'))})
    await redis_client.expire(stream_key, 3600)

    logger.info(
        "Stored tool result: tool=%s tool_call_id=%s session_id=%s chat_id=%s message_id=%s status=%s",
        result.tool_name,
        result.tool_call_id,
        result.session_id,
        result.chat_id,
        result.message_id,
        result.status,
    )

    return ToolResultAckSchema(status="received", tool_call_id=result.tool_call_id)
