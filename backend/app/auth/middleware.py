"""Authentication middleware for Neon Auth JWT validation (Phase 2)"""
from fastapi import HTTPException, Request, status 
from typing import Optional
import logging

logger = logging.getLogger(__name__)


class AuthenticationError(HTTPException):
    """Raised when token verification fails"""

    def __init__(self, detail: str):
        super().__init__(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail=detail,
            headers={"WWW-Authenticate": "Bearer"},
        )


async def extract_bearer_token(request: Request) -> Optional[str]:
    """
    Extract JWT token from Authorization header.
    
    Expected format: Authorization: Bearer {token}
    
    Returns:
        Token string or None if not present/invalid
    """
    auth_header = request.headers.get("Authorization", "")
    
    if not auth_header:
        logger.warning(f"No Authorization header found in {request.method} {request.url.path}")
        return None
    
    parts = auth_header.split()
    
    if len(parts) != 2:
        logger.error(f"Invalid Authorization header format (parts={len(parts)}): {parts}")
        raise AuthenticationError("Invalid Authorization header format")
    
    if parts[0].lower() != "bearer":
        logger.error(f"Expected 'Bearer' scheme, got: {parts[0]}")
        raise AuthenticationError("Invalid Authorization header format")
    
    logger.debug(f"Extracted Bearer token (length={len(parts[1])})")
    return parts[1]

__all__ = [
    "AuthenticationError",
    "extract_bearer_token",
]
