"""Backend auth broker endpoints for extension session tokens."""
from datetime import datetime, timezone
import logging

from fastapi import APIRouter, Depends, HTTPException, Request, status

from app.auth.app_token_service import (
    AppTokenError,
    issue_extension_token_pair,
    revoke_extension_refresh_token,
    rotate_extension_refresh_token,
)
from app.auth.core import NeonAuthVerificationError, verify_neon_auth_jwt
from app.auth.dependencies import AuthenticatedUser, get_current_user
from app.auth.middleware import extract_bearer_token
from app.schemas.auth import (
    AuthExchangeResponse,
    AuthLogoutRequest,
    AuthLogoutResponse,
    AuthRefreshRequest,
    AuthRefreshResponse,
    AuthUserSchema,
)

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/v1/auth", tags=["auth"])


def _seconds_until(expires_at: datetime) -> int:
    return max(0, int((expires_at - datetime.now(timezone.utc)).total_seconds()))


@router.post("/exchange", response_model=AuthExchangeResponse)
async def exchange_neon_token(request: Request):
    """
    Exchange a freshly acquired Neon JWT for backend-issued extension tokens.

    Request:
      Authorization: Bearer <neon_jwt>
    """
    neon_token = await extract_bearer_token(request)
    if not neon_token:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Missing Neon authentication token",
        )

    try:
        neon_claims = await verify_neon_auth_jwt(neon_token)
    except NeonAuthVerificationError as exc:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail=f"Neon token verification failed: {str(exc)}",
        ) from exc

    user_id = neon_claims.get("sub")
    if not isinstance(user_id, str) or not user_id:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Neon token missing user id (sub)",
        )

    email = neon_claims.get("email")
    role = neon_claims.get("role", "authenticated")

    try:
        token_pair = await issue_extension_token_pair(
            user_id=user_id,
            email=email if isinstance(email, str) else "",
            role=role if isinstance(role, str) and role else "authenticated",
        )
    except AppTokenError as exc:
        logger.error("Failed to issue extension token pair for user_id=%s: %s", user_id, str(exc))
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=str(exc),
        ) from exc

    logger.info("Issued backend extension tokens for user_id=%s", user_id)

    return AuthExchangeResponse(
        access_token=token_pair.access_token,
        refresh_token=token_pair.refresh_token,
        token_type=token_pair.token_type,
        expires_in=_seconds_until(token_pair.access_expires_at),
        expires_at=token_pair.access_expires_at,
        user=AuthUserSchema(
            id=user_id,
            email=email if isinstance(email, str) else "",
            role=role if isinstance(role, str) and role else "authenticated",
        ),
    )


@router.post("/refresh", response_model=AuthRefreshResponse)
async def refresh_extension_token(req: AuthRefreshRequest):
    """Rotate backend refresh token and mint a fresh access token."""
    try:
        token_pair = await rotate_extension_refresh_token(req.refresh_token)
    except AppTokenError as exc:
        logger.warning(
            "Extension refresh rejected reason=%s token_len=%s",
            str(exc),
            len(req.refresh_token) if isinstance(req.refresh_token, str) else 0,
        )
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail=str(exc),
        ) from exc

    return AuthRefreshResponse(
        access_token=token_pair.access_token,
        refresh_token=token_pair.refresh_token,
        token_type=token_pair.token_type,
        expires_in=_seconds_until(token_pair.access_expires_at),
        expires_at=token_pair.access_expires_at,
    )


@router.post("/logout", response_model=AuthLogoutResponse)
async def logout_extension_token(req: AuthLogoutRequest):
    """Best-effort token revocation for extension logout."""
    if req.refresh_token:
        await revoke_extension_refresh_token(req.refresh_token)

    return AuthLogoutResponse()


@router.get("/me", response_model=AuthUserSchema)
async def get_authenticated_profile(user: AuthenticatedUser = Depends(get_current_user)):
    """Return the currently authenticated backend user."""
    return AuthUserSchema(
        id=user.user_id or "",
        email=user.email or "",
        role=user.role or "authenticated",
    )
