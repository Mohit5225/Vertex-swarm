"""Tool request and response schemas."""
from typing import Literal

from pydantic import BaseModel, Field


class ToolResultSchema(BaseModel):
    """Tool result payload received from extension host."""

    tool_name: str = Field(..., min_length=1)
    tool_call_id: str = Field(..., min_length=1)
    session_id: str = Field(..., min_length=1)
    chat_id: str = Field(..., min_length=1)
    message_id: str = Field(..., min_length=1)
    request_id: str | None = None
    action: str | None = None
    status: Literal["success", "error", "timeout"]
    content: str
    summary: str | None = None
    data: dict[str, object] | list[object] | str | int | float | bool | None = None
    conflict: dict[str, object] | None = None
    execution_time_ms: int = Field(..., ge=0)
    error_code: str | None = None


class ToolResultAckSchema(BaseModel):
    """Acknowledgement returned after result persistence."""

    status: Literal["received"]
    tool_call_id: str
