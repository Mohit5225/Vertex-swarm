"""Task data model"""
from enum import Enum
from typing import Any, List, Optional
from pydantic import BaseModel, ConfigDict, Field
from app.models.base import TimestampedModel


class TaskStatus(str, Enum):
    """Task execution status"""

    PENDING = "pending"
    IN_PROGRESS = "in_progress"
    COMPLETED = "completed"
    FAILED = "failed"
    RETRYING = "retrying"
    RETRY_COUNT = "retry_count"
    


class Task(TimestampedModel):
    """Task represents a unit of work to be executed by an agent"""

    model_config = ConfigDict(from_attributes=True)

    task_id: str = Field(..., description="Unique identifier for the task")
    session_id: str = Field(..., description="Session this task belongs to")
    description: str = Field(..., description="Plain English task description")
    agent_id: Optional[str] = Field(None, description="Agent assigned to execute this task")
    status: TaskStatus = Field(default=TaskStatus.PENDING, description="Current execution status")
    tools_required: List[str] = Field(default_factory=list, description="Tools needed for this task")
    dependencies: List[str] = Field(
        default_factory=list,
        description="Task IDs this task depends on — dependency graph edge list",
    )
    retry_count: int = Field(default=0, ge=0, description="Number of times this task has been retried")
    retry_limit: int = Field(default=3, ge=1, description="Maximum retries allowed")
    fallback_strategy: str = Field(default="skip", description="Strategy if max retries exceeded")
    output: Optional[Any] = Field(None, description="Task execution output")
    error: Optional[str] = Field(None, description="Error message if task failed")
