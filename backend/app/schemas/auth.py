"""Authentication schemas for extension token exchange and refresh."""
from datetime import datetime
from typing import Optional

from pydantic import BaseModel


class AuthUserSchema(BaseModel):
    """Authenticated user payload returned to extension."""

    id: str
    email: str = ""
    role: str = "authenticated"


class AuthExchangeResponse(BaseModel):
    """Response for Neon->backend token exchange."""

    access_token: str
    refresh_token: str
    token_type: str = "Bearer"
    expires_in: int
    expires_at: datetime
    user: AuthUserSchema


class AuthRefreshRequest(BaseModel):
    """Refresh request from extension."""

    refresh_token: str


class AuthRefreshResponse(BaseModel):
    """Response for backend refresh-token rotation."""

    access_token: str
    refresh_token: str
    token_type: str = "Bearer"
    expires_in: int
    expires_at: datetime


class AuthLogoutRequest(BaseModel):
    """Optional refresh-token revocation payload."""

    refresh_token: Optional[str] = None


class AuthLogoutResponse(BaseModel):
    """Logout acknowledgement."""

    status: str = "logged_out"
