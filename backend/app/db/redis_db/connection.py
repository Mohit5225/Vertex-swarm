"""Redis connection module — manages async cache operations"""
from typing import Any, Dict, Optional
import json
import redis.asyncio as redis
from redis.asyncio import Redis as AsyncRedis
from app.db.redis_db.config import RedisSettings
from app.models.session import PersistedSessionState, EphemeralSessionState, SessionState

# ============================================================================
# Configuration
# ============================================================================

settings = RedisSettings()

# ============================================================================
# Global Redis Client
# ============================================================================

_redis_client: Optional[AsyncRedis] = None


# ============================================================================
# Connection Pool Management
# ============================================================================

async def init_redis() -> AsyncRedis:
    """
    Initialize Redis async client.
    Called on application startup.
    """
    global _redis_client
    if _redis_client is None:
        _redis_client = await redis.from_url(
            settings.url,
            encoding=settings.encoding,
            decode_responses=settings.decode_responses,
            socket_connect_timeout=settings.socket_connect_timeout,
            socket_keepalive=settings.socket_keepalive,
            retry_on_timeout=settings.retry_on_timeout,
            health_check_interval=settings.health_check_interval,
        )
    return _redis_client


async def get_redis() -> AsyncRedis:
    """
    Get Redis client (must be initialized first).
    """
    if _redis_client is None:
        raise RuntimeError("Redis client not initialized. Call init_redis() on startup.")
    return _redis_client


async def close_redis():
    """
    Close Redis client connection.
    Called on application shutdown.
    """
    global _redis_client
    if _redis_client:
        await _redis_client.aclose()
        _redis_client = None


# ============================================================================
# Health Check
# ============================================================================

async def test_redis_connection() -> bool:
    """Test Redis connectivity"""
    try:
        client = await get_redis()
        pong = await client.ping()
        return pong is True or pong == b"PONG"
    except Exception as e:
        print(f"❌ Redis connection failed: {e}")
        return False


# ============================================================================
# Serialization Helpers
# ============================================================================

def serialize_persisted_state(state: PersistedSessionState) -> str:
    """
    Serialize PersistedSessionState to JSON string.
    Safe for Redis storage and recovery.
    """
    return state.model_dump_json()


def deserialize_persisted_state(data: str) -> PersistedSessionState:
    """
    Deserialize PersistedSessionState from JSON string.
    """
    return PersistedSessionState.model_validate_json(data)


def serialize_ephemeral_state(state: EphemeralSessionState) -> str:
    """
    Serialize EphemeralSessionState to JSON string.
    This state is transient and lost on disconnect.
    """
    return state.model_dump_json()


def deserialize_ephemeral_state(data: str) -> EphemeralSessionState:
    """
    Deserialize EphemeralSessionState from JSON string.
    """
    return EphemeralSessionState.model_validate_json(data)


def serialize_session_state(state: SessionState) -> Dict[str, str]:
    """
    Serialize complete SessionState into two Redis-friendly dicts.
    
    Returns:
        {
            "persisted": JSON string (survives disconnect)
            "ephemeral": JSON string (lost on disconnect)
        }
    """
    return {
        "persisted": serialize_persisted_state(state.persisted),
        "ephemeral": serialize_ephemeral_state(state.ephemeral),
    }


def deserialize_session_state(persisted_json: str, ephemeral_json: Optional[str] = None) -> SessionState:
    """
    Deserialize SessionState from Redis-stored JSON strings.
    
    Args:
        persisted_json: Serialized PersistedSessionState (from DB)
        ephemeral_json: Serialized EphemeralSessionState (from Redis, may be None if lost)
    
    Returns:
        Complete SessionState with recovered persisted and optional ephemeral state
    """
    persisted = deserialize_persisted_state(persisted_json)
    
    # Ephemeral state is ephemeral — if lost, restore empty
    if ephemeral_json:
        ephemeral = deserialize_ephemeral_state(ephemeral_json)
    else:
        ephemeral = EphemeralSessionState(in_flight_tool_call=None)
    
    return SessionState(persisted=persisted, ephemeral=ephemeral)


# ============================================================================
# Key Naming Conventions
# ============================================================================

def session_persisted_key(session_id: str) -> str:
    """Redis key for persisted session state"""
    return f"session:{session_id}:persisted"


def session_ephemeral_key(session_id: str) -> str:
    """Redis key for ephemeral session state"""
    return f"session:{session_id}:ephemeral"


def session_lock_key(session_id: str) -> str:
    """Redis key for session state mutation lock"""
    return f"session:{session_id}:lock"


def task_queue_key() -> str:
    """Redis Streams key for task completion events (Phase 5)"""
    return "task_queue:events"


def tool_result_stream_key(
    session_id: str,
    chat_id: str,
    message_id: str,
    tool_call_id: str,
) -> str:
    """Redis Streams key for a single tool result channel."""
    return f"tool_result_stream:{session_id}:{chat_id}:{message_id}:{tool_call_id}"


# ============================================================================
# State Operations
# ============================================================================

async def store_session_state(session_id: str, state: SessionState, ttl: int = 10800) -> None:
    """
    Store session state in Redis.
    
    Args:
        session_id: Unique session identifier
        state: Complete SessionState (persisted + ephemeral)
        ttl: Time-to-live in seconds (default: 10800 = 3 hours for persisted)
    
    Behavior:
        - Persisted state: stored with TTL (survives restarts)
        - Ephemeral state: stored without TTL in same request (lost on disconnect)
    """
    client = await get_redis()
    serialized = serialize_session_state(state)
    
    # Store persisted state (with TTL)
    await client.setex(
        session_persisted_key(session_id),
        ttl,
        serialized["persisted"],
    )
    
    # Store ephemeral state (no TTL, lost on Redis restart)
    await client.set(
        session_ephemeral_key(session_id),
        serialized["ephemeral"],
    )

    last_message_at = int(state.persisted.last_message_at.timestamp())
    await client.setex(
        f"session:{session_id}:last_message_at",
        ttl,
        last_message_at,
    )
    await client.setnx(
        f"session:{session_id}:agent_status",
        "ACTIVE",
    )


async def retrieve_session_state(session_id: str) -> Optional[SessionState]:
    """
    Retrieve session state from Redis.
    
    Returns:
        SessionState if persisted state found, None if not found
        Ephemeral state included if available (otherwise empty)
    """
    client = await get_redis()
    
    persisted_json = await client.get(session_persisted_key(session_id))
    if persisted_json is None:
        return None
    
    ephemeral_json = await client.get(session_ephemeral_key(session_id))
    
    return deserialize_session_state(persisted_json, ephemeral_json)


async def delete_session_state(session_id: str) -> None:
    """
    Delete session state from Redis (on completion or timeout).
    """
    client = await get_redis()
    await client.delete(
        session_persisted_key(session_id),
        session_ephemeral_key(session_id),
        session_lock_key(session_id),
        f"session:{session_id}:last_message_at",
        f"session:{session_id}:agent_status",
        f"session:{session_id}:last_heartbeat_response",
        f"session:{session_id}:archived_at",
        f"session:{session_id}:user_id",
    )


async def update_ephemeral_state(session_id: str, state: EphemeralSessionState) -> None:
    """
    Update only the ephemeral state (e.g., in-flight tool call).
    Persisted state remains unchanged.
    """
    client = await get_redis()
    await client.set(
        session_ephemeral_key(session_id),
        serialize_ephemeral_state(state),
    )


# ============================================================================
# Pub/Sub for Events (Phase 5 preparation)
# ============================================================================

async def publish_event(channel: str, message: Dict[str, Any]) -> None:
    """Publish event to Redis Pub/Sub channel"""
    client = await get_redis()
    await client.publish(channel, json.dumps(message))


async def subscribe_to_events(channel: str):
    """
    Subscribe to Redis Pub/Sub channel.
    Returns async iterator for incoming messages.
    """
    client = await get_redis()
    pubsub = client.pubsub()
    await pubsub.subscribe(channel)
    return pubsub
