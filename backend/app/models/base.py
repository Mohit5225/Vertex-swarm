"""Base models with common fields"""
from datetime import datetime, timezone
from pydantic import BaseModel, ConfigDict, Field


class TimestampedModel(BaseModel):
    """Base model with timestamp fields"""

    model_config = ConfigDict(from_attributes=True)

    created_at: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))
    updated_at: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))
