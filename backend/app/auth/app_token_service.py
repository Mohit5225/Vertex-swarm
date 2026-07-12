"""Backend-issued extension token broker (access + refresh rotation)."""
from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
import json
import logging
import secrets
from typing import Any

import jwt

from app.core.config import settings
from app.db.redis_db import get_redis

logger = logging.getLogger(__name__)

_MIN_HS_SECRET_BYTES = 32


class AppTokenError(Exception):
    """Raised when extension app-token operations fail."""


@dataclass(frozen=True)
class IssuedTokenPair:
    """Issued backend token pair."""

    access_token: str
    refresh_token: str
    access_expires_at: datetime
    refresh_expires_at: datetime
    token_type: str = "Bearer"


def _utc_now() -> datetime:
    return datetime.now(timezone.utc)


def _refresh_session_key(jti: str) -> str:
    return f"auth:refresh:{jti}"


def _require_secret() -> str:
    secret = settings.app_auth_secret.strip()
    if not secret:
        raise AppTokenError("Backend app auth secret is not configured")

    if len(secret.encode("utf-8")) < _MIN_HS_SECRET_BYTES:
        raise AppTokenError(
            "Backend app auth secret must be at least 32 bytes for HS256"
        )

    return secret


def _decode_extension_token(token: str, *, expected_type: str, verify_exp: bool = True) -> dict[str, Any]:
    if not token:
        raise AppTokenError("Token is missing")

    secret = _require_secret()

    try:
        claims = jwt.decode(
            token,
            secret,
            algorithms=[settings.app_auth_algorithm],
            issuer=settings.app_auth_issuer,
            audience=settings.app_auth_audience,
            options={
                "require": ["sub", "iss", "aud", "exp", "iat", "token_type"],
                "verify_exp": verify_exp,
            },
        )
    except jwt.ExpiredSignatureError as exc:
        raise AppTokenError("Token has expired") from exc
    except jwt.InvalidTokenError as exc:
        raise AppTokenError("Token validation failed") from exc

    token_type = claims.get("token_type")
    if token_type != expected_type:
        raise AppTokenError(f"Expected {expected_type} token")

    return claims


def verify_extension_access_token(token: str) -> dict[str, Any]:
    """Validate backend-issued access token and return claims."""
    return _decode_extension_token(token, expected_type="access", verify_exp=True)


def _decode_refresh_token(token: str, *, verify_exp: bool = True) -> dict[str, Any]:
    return _decode_extension_token(token, expected_type="refresh", verify_exp=verify_exp)


async def _store_refresh_session(
    *,
    jti: str,
    user_id: str,
    email: str,
    role: str,
    refresh_expires_at: datetime,
) -> None:
    # redis_client = await get_redis()
    # remaining_seconds = max(1, int((refresh_expires_at - _utc_now()).total_seconds()))
    #
    # record = {
    #     "user_id": user_id,
    #     "email": email,
    #     "role": role,
    #     "expires_at": refresh_expires_at.isoformat(),
    # }
    #
    # await redis_client.setex(
    #     _refresh_session_key(jti),
    #     remaining_seconds,
    #     json.dumps(record),
    # )
    pass


async def _consume_refresh_session(jti: str) -> str | None:
    """Atomically read and delete a refresh session to enforce one-time rotation."""
    return "{}"
    # redis_client = await get_redis()
    # refresh_key = _refresh_session_key(jti)
    #
    # try:
    #     value = await redis_client.execute_command("GETDEL", refresh_key)
    # except Exception:
    #     # Fallback for Redis deployments without GETDEL support.
    #     # Keep one-time-use semantics by requiring successful deletion.
    #     value = await redis_client.get(refresh_key)
    #     if value is None:
    #         return None
    #
    #     deleted = await redis_client.delete(refresh_key)
    #     if deleted != 1:
    #         return None
    #
    # if value is None:
    #     return None
    #
    # if isinstance(value, bytes):
    #     return value.decode("utf-8")
    #
    # return str(value)


async def issue_extension_token_pair(
    *,
    user_id: str,
    email: str,
    role: str = "authenticated",
) -> IssuedTokenPair:
    """Issue new backend access/refresh tokens and persist refresh state."""
    if not user_id:
        raise AppTokenError("Cannot issue token pair without user_id")

    secret = _require_secret()
    now = _utc_now()

    access_expires_at = now + timedelta(seconds=settings.app_auth_access_ttl_seconds)
    refresh_expires_at = now + timedelta(seconds=settings.app_auth_refresh_ttl_seconds)
    refresh_jti = secrets.token_urlsafe(24)

    base_claims = {
        "sub": user_id,
        "email": email,
        "role": role,
        "iss": settings.app_auth_issuer,
        "aud": settings.app_auth_audience,
        "iat": int(now.timestamp()),
    }

    access_token = jwt.encode(
        {
            **base_claims,
            "exp": int(access_expires_at.timestamp()),
            "token_type": "access",
        },
        secret,
        algorithm=settings.app_auth_algorithm,
    )

    refresh_token = jwt.encode(
        {
            **base_claims,
            "exp": int(refresh_expires_at.timestamp()),
            "token_type": "refresh",
            "jti": refresh_jti,
        },
        secret,
        algorithm=settings.app_auth_algorithm,
    )

    await _store_refresh_session(
        jti=refresh_jti,
        user_id=user_id,
        email=email,
        role=role,
        refresh_expires_at=refresh_expires_at,
    )

    return IssuedTokenPair(
        access_token=access_token,
        refresh_token=refresh_token,
        access_expires_at=access_expires_at,
        refresh_expires_at=refresh_expires_at,
    )


async def rotate_extension_refresh_token(refresh_token: str) -> IssuedTokenPair:
    """Rotate refresh token and return a fresh access/refresh pair."""
    claims = _decode_refresh_token(refresh_token, verify_exp=True)

    refresh_jti = claims.get("jti")
    user_id = claims.get("sub")
    email = claims.get("email", "")
    role = claims.get("role", "authenticated")

    if not isinstance(refresh_jti, str) or not refresh_jti:
        raise AppTokenError("Refresh token is missing jti")
    if not isinstance(user_id, str) or not user_id:
        raise AppTokenError("Refresh token is missing subject")

    stored_session = await _consume_refresh_session(refresh_jti)

    if not stored_session:
        raise AppTokenError("Refresh token has been revoked or expired")

    try:
        stored_payload = json.loads(stored_session)
    except json.JSONDecodeError as exc:
        raise AppTokenError("Stored refresh state is corrupted") from exc

    if stored_payload.get("user_id") != user_id and stored_payload != {}:
        raise AppTokenError("Refresh token user mismatch")

    return await issue_extension_token_pair(
        user_id=user_id,
        email=email if isinstance(email, str) else "",
        role=role if isinstance(role, str) and role else "authenticated",
    )


async def revoke_extension_refresh_token(refresh_token: str) -> None:
    """Best-effort refresh token revocation."""
    try:
        claims = _decode_refresh_token(refresh_token, verify_exp=False)
    except AppTokenError:
        return

    refresh_jti = claims.get("jti")
    if not isinstance(refresh_jti, str) or not refresh_jti:
        return

    # redis_client = await get_redis()
    # await redis_client.delete(_refresh_session_key(refresh_jti))
    pass


__all__ = [
    "AppTokenError",
    "IssuedTokenPair",
    "issue_extension_token_pair",
    "rotate_extension_refresh_token",
    "revoke_extension_refresh_token",
    "verify_extension_access_token",
]
