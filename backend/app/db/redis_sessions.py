"""Helpers for Redis-backed chat session lifecycle."""

from datetime import datetime, timezone
from uuid import UUID

from app.db.redis_db import get_redis, retrieve_session_state, store_session_state
from app.models.session import PersistedSessionState, SessionState


DEFAULT_SESSION_TTL_SECONDS = 10800


def build_chat_session_id(chat_id: UUID) -> str:
    """Build the synthetic Redis session id used by the live chat stream."""
    return f"chat-{chat_id}"


async def bootstrap_chat_session(
    session_id: str,
    user_id: str | None,
    chat_id: UUID,
    user_message: str,
    ttl_seconds: int = DEFAULT_SESSION_TTL_SECONDS,
) -> SessionState:
    """Create or refresh the Redis session state for a live chat turn."""
    existing_state = await retrieve_session_state(session_id)
    now = datetime.now(timezone.utc)

    if existing_state is None:
        session_state = SessionState(
            persisted=PersistedSessionState(
                current_task_id=None,
                completed_task_ids=[],
                failed_task_ids=[],
                working_memory={
                    "chat_id": str(chat_id),
                    "user_message": user_message,
                    "status": "initializing",
                },
                token_count=0,
                plan_state=None,
                last_message_at=now,
            )
        )
    else:
        session_state = existing_state
        session_state.persisted.working_memory["chat_id"] = str(chat_id)
        session_state.persisted.working_memory["user_message"] = user_message
        session_state.persisted.working_memory["status"] = "initializing"
        session_state.persisted.last_message_at = now

    await store_session_state(session_id, session_state, ttl=ttl_seconds)

    redis_client = await get_redis()
    await redis_client.setex(f"session:{session_id}:user_id", ttl_seconds, str(user_id or "unknown"))

    return session_state