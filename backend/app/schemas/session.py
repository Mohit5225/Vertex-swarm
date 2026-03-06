"""Session schemas (Phase 1)"""
from pydantic import BaseModel, ConfigDict
from typing import Optional, Dict, Any
from datetime import datetime


class SessionResponse(BaseModel):
    """Session response schema"""
    session_run_id: str
    created_at: datetime
    last_message_at: datetime

    model_config = ConfigDict(from_attributes=True)
