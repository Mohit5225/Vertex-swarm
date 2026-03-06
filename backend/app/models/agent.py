"""Agent data model"""
from typing import List, Optional
from pydantic import BaseModel, ConfigDict, Field
from app.models.base import TimestampedModel


class Agent(TimestampedModel):
    """Agent represents an autonomous execution unit with specific capabilities and constraints"""

    agent_id: str = Field(..., description="Unique identifier for the agent")
    task_description: str = Field(..., description="Plain English description of the task")
    tools: List[str] = Field(default_factory=list, description="Array of tool names the agent can call")
    persona: str = Field(..., description="System prompt instructions defining agent behavior")
    memory_scope: str = Field(..., description="Definition of what memory this agent can read and write")
    success_criteria: str = Field(..., description="How to evaluate if the agent completed its task successfully")
    retry_limit: int = Field(default=3, ge=1, description="Integer defining failure threshold before fallback")
    fallback_strategy: str = Field(..., description="Logic to try alternate tools or skip non-hard dependencies")
    credentials_needed: List[str] = Field(
        default_factory=list,
        description="List of secret keys fetched from secrets broker at runtime",
    )


class AgentDefinitionSchema(BaseModel):
    """Schema for defining an agent at instantiation time"""

    model_config = ConfigDict(from_attributes=True)

    agent_id: str = Field(..., description="Unique identifier for the agent")
    task_description: str = Field(..., description="Plain English description of the task")
    tools: List[str] = Field(default_factory=list, description="Array of tool names the agent can call")
    persona: str = Field(..., description="System prompt instructions defining agent behavior")
    memory_scope: str = Field(..., description="Definition of what memory this agent can read and write")
    success_criteria: str = Field(..., description="How to evaluate if the agent completed its task successfully")
    retry_limit: int = Field(default=3, ge=1, description="Integer defining failure threshold before fallback")
    fallback_strategy: str = Field(..., description="Logic to try alternate tools or skip non-hard dependencies")
    credentials_needed: List[str] = Field(
        default_factory=list,
        description="List of secret keys fetched from secrets broker at runtime",
    )
