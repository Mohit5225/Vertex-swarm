"""
Background job: Session archival on 3-hour + inactive boundary.

Runs every 5 minutes. Scans for sessions where:
- last_message_at > 3 hours ago (10800 seconds)
- agent_status == "INACTIVE"
- archived_at is NULL (not already archived)

Then archives to Postgres and clears Redis.
"""
import asyncio
import logging
import time
from typing import Optional

from app.db.redis_db import get_redis
from app.db.session_store import archive_session

logger = logging.getLogger(__name__)

# Job configuration
ARCHIVAL_JOB_INTERVAL_SECONDS = 300  # 5 minutes (same as heartbeat interval)
INACTIVITY_WINDOW_SECONDS = 10800  # 3 hours


class SessionArchivalJob:
    """
    Background job for archiving inactive sessions.
    """
    
    def __init__(self):
        self.redis = None
        self._job_task: Optional[asyncio.Task] = None
    
    async def initialize(self):
        """Initialize Redis connection"""
        self.redis = await get_redis()
        if not self.redis:
            logger.error("Redis not available for archival job")
    
    async def scan_and_archive(self) -> int:
        """
        Scan all sessions for archival candidates and archive them.
        
        Returns:
            int: Number of sessions archived
        """
        if not self.redis:
            logger.warning("Redis not available in scan_and_archive")
            return 0
        
        archived_count = 0
        current_time = time.time()
        archival_cutoff = current_time - INACTIVITY_WINDOW_SECONDS
        
        try:
            logger.debug(f"Scanning for expired sessions (cutoff: {archival_cutoff})")
            
            # Find all session keys
            session_ids = set()
            async for key in self.redis.scan_iter("session:*:last_message_at"):
                # Extract session_id from key: "session:{session_id}:last_message_at"
                parts = key.split(":")
                if len(parts) >= 2:
                    session_ids.add(parts[1])
            
            if not session_ids:
                logger.debug("No sessions found for archival check")
                return 0
            
            logger.info(f"Found {len(session_ids)} sessions for archival evaluation")
            
            for session_id in session_ids:
                try:
                    # Check last_message_at
                    last_msg_str = await self.redis.get(f"session:{session_id}:last_message_at")
                    if not last_msg_str:
                        continue
                    
                    last_message_time = int(float(last_msg_str))
                    
                    # Check agent_status
                    agent_status = await self.redis.get(f"session:{session_id}:agent_status")
                    if agent_status and agent_status.lower() != "inactive":
                        continue  # Agent is still active, don't archive
                    
                    # Check archived_at (if already archived, skip)
                    archived_at = await self.redis.get(f"session:{session_id}:archived_at")
                    if archived_at:
                        continue  # Already archived
                    
                    # Evaluate: is this session eligible for archival?
                    if last_message_time <= archival_cutoff:
                        logger.info(
                            f"Archiving session {session_id}: "
                            f"last_message {(current_time - last_message_time)/3600:.1f} hours ago, "
                            f"agent_status={agent_status}"
                        )
                        
                        # Perform archival
                        success = await archive_session(session_id, reason="inactivity")
                        if success:
                            archived_count += 1
                        else:
                            logger.error(f"Failed to archive session {session_id}")
                
                except Exception as exc:
                    logger.error(f"Error processing session {session_id}: {exc}", exc_info=True)
            
            if archived_count > 0:
                logger.info(f"Archival job completed: {archived_count} sessions archived")
            else:
                logger.debug("Archival job completed: no sessions archived")
            
            return archived_count
        
        except Exception as exc:
            logger.error(f"Archival scan failed: {exc}", exc_info=True)
            return 0
    
    async def start_archival_loop(self):
        """Start background archival loop"""
        if self._job_task:
            logger.warning("Archival job already running")
            return
        
        async def _archival_loop():
            logger.info("Session archival job started (interval={ARCHIVAL_JOB_INTERVAL_SECONDS}s)")
            while True:
                try:
                    await self.scan_and_archive()
                    await asyncio.sleep(ARCHIVAL_JOB_INTERVAL_SECONDS)
                except asyncio.CancelledError:
                    logger.info("Session archival job stopped")
                    break
                except Exception as exc:
                    logger.error(f"Archival loop error: {exc}", exc_info=True)
                    await asyncio.sleep(5)  # Back off on errors
        
        self._job_task = asyncio.create_task(_archival_loop())
    
    async def stop_archival_loop(self):
        """Stop background archival loop"""
        if self._job_task:
            self._job_task.cancel()
            try:
                await self._job_task
            except asyncio.CancelledError:
                pass
            self._job_task = None


# Global singleton instance
_archival_job: Optional[SessionArchivalJob] = None


async def init_archival_job():
    """Initialize global archival job"""
    global _archival_job
    _archival_job = SessionArchivalJob()
    await _archival_job.initialize()
    await _archival_job.start_archival_loop()


async def close_archival_job():
    """Shutdown global archival job"""
    global _archival_job
    if _archival_job:
        await _archival_job.stop_archival_loop()
        _archival_job = None


def get_archival_job() -> Optional[SessionArchivalJob]:
    """Get global archival job instance"""
    return _archival_job
