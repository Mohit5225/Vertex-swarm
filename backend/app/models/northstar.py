"""NorthStar document model — immutable specification captured at task submission"""
from typing import Any, List, Optional
from pydantic import BaseModel, ConfigDict, Field
from app.models.base import TimestampedModel


class ResourceBudget(BaseModel):
    """Resource constraints for task execution"""

    model_config = ConfigDict(from_attributes=True)

    max_tokens: int = Field(..., ge=1, description="Maximum tokens allowed for this task")
    max_runtime_seconds: int = Field(..., ge=1, description="Maximum runtime in seconds")
    max_escalations: int = Field(default=3, ge=0, description="Maximum escalations before hard fail")
    api_cost_ceiling: Optional[float] = Field(None, ge=0, description="Optional API cost ceiling in dollars")


class NorthStar(TimestampedModel):
    """
    NorthStar document is immutable specification captured at task submission.
    Every downstream decision and replanning event is validated against this document.
    """

    model_config = ConfigDict(from_attributes=True)

    northstar_id: str = Field(..., description="Unique identifier for this NorthStar document")
    session_id: str = Field(..., description="Session this NorthStar belongs to")
    user_intent: str = Field(..., description="Exact user intent in natural language")
    success_criteria: str = Field(..., description="How to measure if the task succeeded")
    constraints: List[str] = Field(
        default_factory=list,
        description="List of constraints the solution must satisfy",
    )
    resource_budget: ResourceBudget = Field(..., description="Resource limits for execution")
    blocked_actions: List[str] = Field(
        default_factory=list,
        description="Actions explicitly forbidden (e.g., 'delete_files', 'push_to_main')",
    )
    acceptable_fallbacks: List[str] = Field(
        default_factory=list,
        description="Pre-approved fallback strategies if primary path fails",
    )
    ambiguity_score: float = Field(
        default=0.0,
        ge=0.0,
        le=1.0,
        description="Pre-flight ambiguity scoring: 0 = crystal clear, 1 = completely ambiguous",
    )
    conflict_detected: bool = Field(
        default=False,
        description="True if pre-flight validation detected constraint conflicts",
    )
    user_approved: bool = Field(
        default=False,
        description="User has reviewed and approved the plan before execution",
    )
