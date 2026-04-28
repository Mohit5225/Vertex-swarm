"""Backend access-token dependency for protected FastAPI routes."""
import logging
from typing import Optional

from fastapi import Depends, Request

from app.auth.app_token_service import AppTokenError, verify_extension_access_token
from app.auth.middleware import AuthenticationError, extract_bearer_token
from app.db.postgres.auth import get_user_by_id
from app.models.auth import NeonAuthUser
from app.db.postgres.connection import AsyncSessionLocal

logger = logging.getLogger(__name__)


class AuthenticatedUser:
    """Represents an authenticated user context in FastAPI"""

    def __init__(self, jwt_claims: dict, db_user: Optional[NeonAuthUser] = None):
        self.jwt_claims = jwt_claims  # Raw JWT claims (sub, email, role, exp, iat)
        self.db_user = db_user  # Full user record from neon_auth.user
        self.user_id = jwt_claims.get("sub")
        self.email = jwt_claims.get("email")
        self.role = jwt_claims.get("role", "authenticated")

    def to_dict(self) -> dict:
        """Convert to dictionary for request context"""
        return {
            "user_id": self.user_id,
            "email": self.email,
            "role": self.role,
            "email_verified": self.db_user.email_verified if self.db_user else False,
            "name": self.db_user.name if self.db_user else None,
            "image": self.db_user.image if self.db_user else None,
        }


async def get_current_user(request: Request) -> AuthenticatedUser:
    """
    FastAPI dependency to validate backend access token and return user context.
    
    Usage:
        @router.get("/protected")
        async def protected_route(user: AuthenticatedUser = Depends(get_current_user)):
            # user.user_id, user.email, user.db_user available
            ...
    
    Raises:
        AuthenticationError: If token is missing, invalid, or expired
    """
    # Extract token from Authorization header
    token = await extract_bearer_token(request)
    if not token:
        logger.error(f"No token provided for {request.method} {request.url.path}")
        raise AuthenticationError("Missing authentication token")

    # Verify backend-issued access token
    try:
        logger.debug(f"Verifying backend access token (length={len(token)}) for {request.url.path}")
        jwt_claims = verify_extension_access_token(token)
        logger.info(
            f"Extension token verified for user_id={jwt_claims.get('sub')} at {request.url.path}"
        )
    except AppTokenError as e:
        logger.error(f"Extension token verification failed for {request.url.path}: {str(e)}", exc_info=True)
        raise AuthenticationError(str(e))

    # Optionally fetch full user record from neon_auth.user
    db_user: Optional[NeonAuthUser] = None
    try:
        async with AsyncSessionLocal() as session:
            user_id = jwt_claims.get("sub")
            if user_id:
                db_user = await get_user_by_id(session, user_id)
    except Exception:
        logger.warning("Could not fetch authenticated user profile", exc_info=True)

    return AuthenticatedUser(jwt_claims=jwt_claims, db_user=db_user)


__all__ = [
    "AuthenticatedUser",
    "get_current_user",
]
