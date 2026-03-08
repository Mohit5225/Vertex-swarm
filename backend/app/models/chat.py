from uuid import UUID
from datetime import datetime
from typing import Optional, Dict, Any
from pydantic import BaseModel, ConfigDict


class ChatModel(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    chat_id: UUID
    user_id: str
    title: Optional[str] = None
    created_at: datetime
    updated_at: datetime


class MessageModel(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    message_id: UUID
    chat_id: UUID
    role: str  # 'user' or 'assistant'
    content: str
    events: Optional[Dict[str, Any]] = None
    created_at: datetime
