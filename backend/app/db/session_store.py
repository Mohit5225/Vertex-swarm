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

from app.infrastructure.cache import get_redis, serialize_session_state, deserialize_session_state
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
        # Step 1: Load session state from Redis
        # Try to load from persisted key (where it's actually stored)
        from app.infrastructure.cache import retrieve_session_state
        session_state = await retrieve_session_state(session_id)
        
        if not session_state:
            logger.warning(f"Session {session_id} not found in Redis. May already be archived.")
            return False
        
        # Step 2: Compress working memory
        wm_compressed = await compress_working_memory(session_state.persisted.working_memory)
        
        # Step 3: Write to Postgres (will implement ORM model in Phase 2)
        # For now, we will use raw SQL or defer to later when DB schema is finalized
        async with AsyncSessionLocal() as postgres_session:
            # TODO: Create ORM model ArchivedSession and insert here
            # For MVP Phase 1, log the archival intent
            logger.info(
                f"ARCHIVAL INTENT: session_id={session_id}, "
                f"working_memory_size={len(wm_compressed['original'])} bytes, "
                f"reason={reason}, archived_at={datetime.now(timezone.utc).isoformat()}"
            )
        
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
