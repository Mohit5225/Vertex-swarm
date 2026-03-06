"""Authentication endpoints (Phase 2) — JWT validation + Neon Auth integration"""
from fastapi import APIRouter, Depends, status

from app.services.auth_dependency import AuthenticatedUser, get_current_user

router = APIRouter(prefix="/api/v1/auth", tags=["auth"])


@router.get(
    "/me",
    response_model=dict,
    status_code=status.HTTP_200_OK,
    summary="Get current authenticated user",
    description="Returns the authenticated user's profile from JWT claims and neon_auth.user",
)
async def get_current_user_profile(user: AuthenticatedUser = Depends(get_current_user)):
    """
    Get current authenticated user.
    
    Requires valid JWT token in Authorization header.
    
    JWT is obtained from Neon Auth after successful login via https://ep-jolly-feather-aiaavjnk.neonauth.c-4.us-east-1.aws.neon.tech/neondb/auth
    
    Returns:
        - user_id: User ID from neon_auth.user
        - email: User email
        - name: User name (if available)
        - image: User avatar (if available)
        - email_verified: Whether email is verified
        - role: JWT role claim
    """
    return user.to_dict()


@router.post(
    "/verify",
    response_model=dict,
    status_code=status.HTTP_200_OK,
    summary="Verify and decode JWT token",
    description="Validates JWT signature and returns decoded claims as verification",
)
async def verify_jwt_token(user: AuthenticatedUser = Depends(get_current_user)):
    """
    Verify JWT token validity.
    
    This endpoint validates:
    1. JWT signature against Neon Auth JWKS keys
    2. Token expiration (exp claim)
    3. Standard JWT structure
    4. Fetches user data from neon_auth.user
    
    Returns decoded claims if valid, 401 if invalid.
    """
    return {
        "valid": True,
        "user_id": user.user_id,
        "email": user.email,
        "role": user.role,
        "email_verified": user.db_user.email_verified if user.db_user else False,
    }


# NOTE: Register/Login endpoints are NOT needed here
# Users authenticate directly with Neon Auth at the auth base URL
# After successful auth, they receive a JWT token
# This token is then used to access FastAPI endpoints via the Authorization header
# See https://ep-jolly-feather-aiaavjnk.neonauth.c-4.us-east-1.aws.neon.tech/neondb/auth for Neon Auth UI


__all__ = ["router"]
