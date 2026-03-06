"""Authentication schemas for Neon Auth (Phase 2)"""
from pydantic import BaseModel
from typing import Optional


class NeonAuthTokenResponse(BaseModel):
    """Neon Auth token response wrapper"""
    access_token: str
    token_type: str = "bearer"


class AuthUser(BaseModel):
    """Authenticated user from Neon Auth"""
    user_id: str
    email: str
    username: Optional[str] = None


__all__ = ["NeonAuthTokenResponse", "AuthUser"]
