"""
Session persistence layer — handles archival from Redis to Postgres.

Lazy archival pattern:
- During execution: all state lives in Redis (hot)
- At 3-hour + inactive boundary: compress, archive to Postgres (cold)
- Clear from Redis after successful Postgres write
"""
import json
import logging
from datetime import datetime, timezone
from typing import Any, Dict, Optional

from app.db.redis_db import get_redis, serialize_session_state, deserialize_session_state
from app.models.session import Session
from app.db.postgres import AsyncSessionLocal

logger = logging.getLogger(__name__)


async def compress_working_memory(working_memory: Dict[str, Any]) -> Dict[str, str]:
    """
    Compress working memory for cold storage in Postgres archive.
    
    Returns:
        {
            "original": json serialized original working memory,
            "compressed": LLM-summarized narrative (Phase 2: for now, just json dump)
        }
    
    Phase 2: Integrate with LLM for semantic compression.
    For MVP, we store original in JSON form.
    """
    original_json = json.dumps(working_memory, default=str)
    
    # TODO: Phase 2 — invoke LLM summarization
    # For now, store both as the same (planning to add LLM compression later)
    compressed_text = f"[SUMMARY PENDING LLM] {len(original_json)} bytes of working memory archived"
    
    return {
        "original": original_json,
        "compressed": compressed_text,
    }


async def archive_session(
    session_id: str,
    reason: str = "inactivity",
) -> bool:
    """
    Archive a session from Redis to Postgres.
    
    Flow:
    1. Load full session state from Redis (using existing deserialize function)
    2. Extract and compress working_memory
    3. Write to Postgres archived_sessions table
    4. If successful, delete from Redis
    5. Return True on success, False on failure
    
    Args:
        session_id: Session ID to archive
        reason: "inactivity" or "completion"
    
    Returns:
        bool: True if archived successfully, False otherwise
    """
    redis = await get_redis()
    if not redis:
        logger.error(f"Redis not initialized. Cannot archive session {session_id}")
        return False
    
    try:
        orphan_index_keys = [
            f"session:{session_id}:last_message_at",
            f"session:{session_id}:agent_status",
            f"session:{session_id}:last_heartbeat_response",
            f"session:{session_id}:archived_at",
            f"session:{session_id}:user_id",
        ]

        # Step 1: Load session state from Redis
        # Try to load from persisted key (where it's actually stored)
        from app.db.redis_db import retrieve_session_state
        session_state = await retrieve_session_state(session_id)
        
        if not session_state:
            await redis.delete(*orphan_index_keys)
            logger.info(
                "Session %s not found in Redis persisted state. Cleared orphaned index keys.",
                session_id,
            )
            return True
        
        # Step 2: Compress working memory
        wm_compressed = await compress_working_memory(session_state.persisted.working_memory)

        # Step 3: Write to Postgres archived_sessions table
        from app.db.postgres.models import ArchivedSessionORM
        raw_user_id = await redis.get(f"session:{session_id}:user_id")
        user_id = raw_user_id if raw_user_id else "unknown"

        async with AsyncSessionLocal() as postgres_session:
            async with postgres_session.begin():
                archived_record = ArchivedSessionORM(
                    session_id=session_id,
                    user_id=user_id,
                    working_memory_original=wm_compressed["original"],
                    working_memory_compressed=wm_compressed["compressed"],
                    archived_reason=reason,
                )
                postgres_session.add(archived_record)

        logger.info(f"Archived session {session_id} to Postgres (user={user_id}, reason={reason})")
        
        # Step 4: Clear from Redis (conditional on Postgres success)
        # In production, use transaction; for now, delete after successful archival
        keys_to_delete = [
            f"session:{session_id}",
            f"session:{session_id}:persisted",
            f"session:{session_id}:ephemeral",
            f"session:{session_id}:lock",
            f"session:{session_id}:working_memory",
            f"session:{session_id}:task_graph",
            f"session:{session_id}:messages",
            *orphan_index_keys,
        ]
        
        for key in keys_to_delete:
            await redis.delete(key)
        
        logger.info(f"Successfully archived session {session_id} to Postgres and cleared Redis")
        return True
    
    except Exception as exc:
        logger.error(f"Failed to archive session {session_id}: {exc}", exc_info=True)
        return False


async def retrieve_archived_session(session_id: str) -> Optional[Dict[str, Any]]:
    """
    Retrieve an archived session from Postgres.
    
    Used when user reconnects after 3+ hour window — load from cold storage.
    Returns the archived record with original working memory + compressed summary.
    
    Phase 2: Will query actual Postgres table once ORM is finalized.
    """
    # TODO: Implement once Postgres schema is defined
    logger.info(f"Retrieving archived session {session_id} from Postgres")
    return None


async def resume_archived_session(session_id: str) -> bool:
    """
    Resume an archived session: reload from Postgres to Redis with stale-context warning.
    
    Phase 2: Implement full recovery path.
    """
    archived = await retrieve_archived_session(session_id)
    if not archived:
        logger.warning(f"Archived session {session_id} not found in Postgres")
        return False
    
    # TODO: Re-hydrate into Redis with context-stale flag
    logger.info(f"Resuming archived session {session_id}")
    return True
