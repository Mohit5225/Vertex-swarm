"""
Agent heartbeat and vitality monitoring.

Heartbeat Strategy (Option A: Backend → Agent):
- Backend spawns agent subprocess
- Every 5 minutes: backend sends HEARTBEAT request to agent
- Agent responds with PONG + status (if still alive)
- Backend records last_heartbeat_response timestamp
- If no PONG for 90+ seconds: mark agent_status = INACTIVE
- Session archival happens only when: agent_status == INACTIVE AND last_message_at > 3 hours
"""
import asyncio
import logging
import time
from typing import Optional, Dict, Any

from app.db.redis_db import get_redis

logger = logging.getLogger(__name__)

# Heartbeat configuration
HEARTBEAT_INTERVAL_SECONDS = 300  # 5 minutes
HEARTBEAT_TIMEOUT_SECONDS = 90  # 90 second timeout before marking inactive
VITALITY_CHECK_INTERVAL_SECONDS = 60  # Check every minute for timeout


class AgentVitalityTracker:
    """
    Tracks agent subprocess vitality via heartbeat mechanism.
    
    Stores in Redis:
    - session:{session_id}:agent_status = "ACTIVE" | "INACTIVE"
    - session:{session_id}:last_heartbeat_response = Unix timestamp
    """
    
    def __init__(self):
        self.redis = None
        self._vitality_check_task: Optional[asyncio.Task] = None
    
    async def initialize(self):
        """Initialize connection to Redis"""
        self.redis = await get_redis()
        if not self.redis:
            logger.error("Redis not available for agent vitality tracking")
    
    async def send_heartbeat(self, session_id: str, agent_process_id: str) -> bool:
        """
        Send heartbeat request to agent subprocess.
        
        In MVP Phase 1, this is a placeholder that simulates successful heartbeat.
        Phase 2: Integrate with actual subprocess IPC (pipes, sockets, or message queues).
        
        Args:
            session_id: Session ID
            agent_process_id: PID of spawned agent subprocess
        
        Returns:
            bool: True if PONG received within timeout, False otherwise
        """
        if not self.redis:
            return False
        
        try:
            logger.debug(f"Sending heartbeat to agent PID={agent_process_id} (session={session_id})")
            
            # TODO: Phase 2 — Replace with real subprocess heartbeat mechanism
            # Options:
            # 1. Unix socket: send HEARTBEAT, wait for PONG
            # 2. Named pipe: write heartbeat request, read response
            # 3. Redis Pub/Sub: publish heartbeat, agent subscribes and publishes back
            # 4. HTTP endpoint: if agent runs its own FastAPI server
            
            # MVP Simulation: Heartbeat always succeeds, agent always responds
            # This will be replaced with real IPC in Phase 2
            pong_received = True
            
            if pong_received:
                timestamp = time.time()
                await self.redis.set(
                    f"session:{session_id}:last_heartbeat_response",
                    int(timestamp),
                )
                await self.redis.set(
                    f"session:{session_id}:agent_status",
                    "ACTIVE",
                )
                logger.debug(f"PONG received from agent {agent_process_id}")
                return True
            else:
                logger.warning(f"No PONG from agent {agent_process_id} (timeout)")
                return False
        
        except Exception as exc:
            logger.error(f"Heartbeat error for agent {agent_process_id}: {exc}")
            return False
    
    async def check_vitality(self):
        """
        Background task: every 60 seconds, scan all active sessions.
        If last_heartbeat_response > 90 seconds ago, mark agent_status = INACTIVE.
        
        This is separate from the send_heartbeat timer. Rationale:
        - send_heartbeat runs every 5 minutes (backend initiates)
        - check_vitality runs every 60 seconds (backend validates responses)
        - Decoupling allows flexible retry + timeout handling
        """
        if not self.redis:
            logger.warning("Redis not available in check_vitality")
            return
        
        try:
            current_time = time.time()
            
            # Scan for all "last_heartbeat_response" keys
            async for key in self.redis.scan_iter("session:*:last_heartbeat_response"):
                try:
                    last_response_str = await self.redis.get(key)
                    if not last_response_str:
                        continue
                    
                    last_response_time = int(last_response_str)
                    elapsed_seconds = current_time - last_response_time
                    
                    # Extract session_id from key: "session:{session_id}:last_heartbeat_response"
                    session_id = key.split(":")[1]
                    
                    if elapsed_seconds > HEARTBEAT_TIMEOUT_SECONDS:
                        # Mark as inactive
                        await self.redis.set(
                            f"session:{session_id}:agent_status",
                            "INACTIVE",
                        )
                        logger.info(
                            f"Agent marked INACTIVE: session={session_id}, "
                            f"no heartbeat for {elapsed_seconds}s"
                        )
                
                except (ValueError, IndexError, Exception) as exc:
                    logger.warning(f"Error processing heartbeat key {key}: {exc}")
        
        except Exception as exc:
            logger.error(f"Vitality check failed: {exc}", exc_info=True)
    
    async def start_vitality_loop(self):
        """Start background vitality checking loop"""
        if self._vitality_check_task:
            logger.warning("Vitality loop already running")
            return
        
        async def _vitality_loop():
            logger.info("Agent vitality checker started")
            while True:
                try:
                    await self.check_vitality()
                    await asyncio.sleep(VITALITY_CHECK_INTERVAL_SECONDS)
                except asyncio.CancelledError:
                    logger.info("Agent vitality checker stopped")
                    break
                except Exception as exc:
                    logger.error(f"Vitality loop error: {exc}", exc_info=True)
                    await asyncio.sleep(5)  # Back off on errors
        
        self._vitality_check_task = asyncio.create_task(_vitality_loop())
    
    async def stop_vitality_loop(self):
        """Stop background vitality checking loop"""
        if self._vitality_check_task:
            self._vitality_check_task.cancel()
            try:
                await self._vitality_check_task
            except asyncio.CancelledError:
                pass
            self._vitality_check_task = None


# Global singleton instance
_vitality_tracker: Optional[AgentVitalityTracker] = None


async def init_vitality_tracker():
    """Initialize global vitality tracker"""
    global _vitality_tracker
    _vitality_tracker = AgentVitalityTracker()
    await _vitality_tracker.initialize()
    await _vitality_tracker.start_vitality_loop()


async def close_vitality_tracker():
    """Shutdown global vitality tracker"""
    global _vitality_tracker
    if _vitality_tracker:
        await _vitality_tracker.stop_vitality_loop()
        _vitality_tracker = None


def get_vitality_tracker() -> Optional[AgentVitalityTracker]:
    """Get global vitality tracker instance"""
    return _vitality_tracker
