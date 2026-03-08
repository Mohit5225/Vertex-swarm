"""Session state data models"""
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional
from pydantic import BaseModel, ConfigDict, Field
from app.models.base import TimestampedModel


class PersistedSessionState(BaseModel):
    """Persisted state — must be deterministically reconstructible from this data"""

    model_config = ConfigDict(from_attributes=True)

    current_task_id: Optional[str] = Field(None, description="Currently executing task ID")
    completed_task_ids: List[str] = Field(default_factory=list, description="List of completed task IDs")
    failed_task_ids: List[str] = Field(default_factory=list, description="List of failed task IDs")
    working_memory: Dict[str, Any] = Field(
        default_factory=dict,
        description="Active task context: plan state, outputs, failed tasks",
    )
    token_count: int = Field(default=0, ge=0, description="Total tokens consumed in this session")
    plan_state: Optional[Dict[str, Any]] = Field(None, description="Current decomposed plan representation")
    last_message_at: datetime = Field(
        default_factory=lambda: datetime.now(timezone.utc),
        description="Timestamp of last user message. Resets on new message. Core reference for 3-hour TTL.",
    )


class EphemeralSessionState(BaseModel):
    """
    Ephemeral state — NOT used in MVP (Phase 1-7). Reserved for Phase 8+ (sandbox isolation mode).
    During MVP, ALL execution state persists. No ephemeral loss on disconnect.
    """

    model_config = ConfigDict(from_attributes=True)

    in_flight_tool_call: Optional[Dict[str, Any]] = Field(
        None,
        description="[PHASE 8+] Current tool invocation in progress (isolated sandbox context)",
    )
    streaming_buffer: List[str] = Field(
        default_factory=list,
        description="[PHASE 8+] Buffered token stream for LLM response (sandbox context)",
    )


class SessionState(BaseModel):
    """Complete session state wrapping persisted and ephemeral layers"""

    model_config = ConfigDict(from_attributes=True)

    persisted: PersistedSessionState = Field(default_factory=PersistedSessionState)
    ephemeral: EphemeralSessionState = Field(default_factory=EphemeralSessionState)


class Session(TimestampedModel):
    """
    Session represents a single execution context binding a user to running agents and state.
    
    Lifecycle:
    - Created on first user message
    - Lives in Redis with 3-hour TTL indexed by last_message_at
    - Backend spawns agent subprocess; heartbeat check every 5 minutes
    - If agent inactive (no PONG for 90s) AND 3+ hours since last_message_at: archive to Postgres
    """

    model_config = ConfigDict(from_attributes=True)

    session_id: str = Field(..., description="Unique session identifier (primary key)")
    session_run_id: str = Field(
        ...,
        description="Unique run identifier for session recovery — recovers from this on reconnect",
    )
    user_id: str = Field(..., description="User who owns this session")
    state: SessionState = Field(default_factory=SessionState, description="Current session state (persisted + ephemeral)")
    is_active: bool = Field(default=True, description="Whether session is currently active")
    
    # TTL and activity tracking
    last_message_at: datetime = Field(
        default_factory=lambda: datetime.now(timezone.utc),
        description="Timestamp of last user message. Resets on new message. Core reference for 3-hour TTL."
    )
    agent_status: str = Field(
        default="ACTIVE",
        description="Agent vitality status: ACTIVE (responding to heartbeats) or INACTIVE (no PONG for 90s)",
    )
    agent_process_id: Optional[str] = Field(
        None,
        description="PID of spawned agent subprocess (for heartbeat checks)",
    )
    activity_window_minutes: int = Field(
        default=180,
        description="TTL window in minutes. Default 180 (3 hours). Session archived if elapsed > window AND agent_status=INACTIVE",
    )
    archived_at: Optional[datetime] = Field(
        None,
        description="When session was archived to Postgres. Once set, session removed from Redis.",
    )
    
    # Recovery reference
    archived_reason: Optional[str] = Field(
        None,
        description="Why session was archived: 'inactivity' or 'completion'",
    )
    total_tokens_used: int = Field(default=0, ge=0, description="Cumulative tokens consumed")
