"""JWT verification and Neon Auth integration (Phase 2)"""
from datetime import datetime, timedelta, timezone
from typing import Optional

import aiohttp
import jwt
from jwt import PyJWKClientError

from app.core.config import settings


class JWKSCache:
    """In-memory JWKS cache with TTL to reduce network calls"""

    def __init__(self, ttl_seconds: int = 3600):
        self.ttl_seconds = ttl_seconds
        self._cache: dict = {}
        self._expires_at: Optional[datetime] = None

    def is_expired(self) -> bool:
        """Check if cache is expired"""
        if self._expires_at is None:
            return True
        return datetime.now(timezone.utc) >= self._expires_at

    async def get(self, force_refresh: bool = False) -> dict:
        """Get JWKS from cache or fetch fresh"""
        if not force_refresh and not self.is_expired() and self._cache:
            return self._cache

        # Fetch fresh JWKS
        async with aiohttp.ClientSession() as session:
            async with session.get(settings.neon_auth_jwks_url, timeout=aiohttp.ClientTimeout(total=10)) as response:
                if response.status != 200:
                    raise Exception(f"Failed to fetch JWKS: {response.status}")
                self._cache = await response.json()
                self._expires_at = datetime.now(timezone.utc) + timedelta(seconds=self.ttl_seconds)
                return self._cache


# Singleton JWKS cache
_jwks_cache = JWKSCache(ttl_seconds=settings.jwt_cache_ttl_seconds)


class NeonAuthVerificationError(Exception):
    """Raised when JWT verification fails"""

    pass


async def verify_neon_auth_jwt(token: str) -> dict:
    """
    Verify Neon Auth JWT token signature using JWKS endpoint.
    
    Neon Auth uses EdDSA with Ed25519 keys (OKP key type).
    
    Returns decoded token with claims (sub, email, role, exp, iat).
    
    Raises:
        NeonAuthVerificationError: If token is invalid or expired
    """
    if not token:
        raise NeonAuthVerificationError("No token provided")

    try:
        # Decode without verification first to get kid
        unverified_header = jwt.get_unverified_header(token)
        kid = unverified_header.get("kid")

        if not kid:
            raise NeonAuthVerificationError("Token missing 'kid' header")

        jwks_data = await _jwks_cache.get()
        keys = {key["kid"]: key for key in jwks_data.get("keys", [])}

        if not keys:
            raise NeonAuthVerificationError("No JWKS keys available")

        if kid not in keys:
            refreshed_jwks_data = await _jwks_cache.get(force_refresh=True)
            keys = {key["kid"]: key for key in refreshed_jwks_data.get("keys", [])}

        if kid not in keys:
            raise NeonAuthVerificationError(f"Key {kid} not found in JWKS")

        # Build public key from JWKS
        # Supports both RSA (RS256) and OKP (EdDSA/Ed25519) keys
        jwk = keys[kid]
        
        # Dynamically determine algorithm from key type
        key_type = jwk.get("kty")
        if key_type == "RSA":
            public_key = jwt.algorithms.RSAAlgorithm.from_jwk(jwk)
        elif key_type == "OKP":  # Neon Auth uses OKP keys with EdDSA
            public_key = jwt.algorithms.OKPAlgorithm.from_jwk(jwk)
        else:
            raise NeonAuthVerificationError(f"Unsupported key type: {key_type}")

        # Verify token signature
        # Use algorithm from key's 'alg' field, fallback to config
        token_alg = unverified_header.get("alg", settings.jwt_algorithm)
        
        decoded = jwt.decode(
            token,
            public_key,
            algorithms=[token_alg],
            audience=None,
            # Neon Auth may include an audience claim even when this backend
            # does not enforce one. Disable audience validation explicitly.
            options={"verify_aud": False},
        )

        return decoded

    except jwt.ExpiredSignatureError:
        raise NeonAuthVerificationError("Token has expired")
    except jwt.InvalidAudienceError:
        raise NeonAuthVerificationError("Invalid token audience")
    except jwt.InvalidSignatureError:
        raise NeonAuthVerificationError("Invalid token signature")
    except jwt.DecodeError as e:
        raise NeonAuthVerificationError(f"Token decode error: {str(e)}")
    except (PyJWKClientError, KeyError, ValueError) as e:
        raise NeonAuthVerificationError(f"JWKS error: {str(e)}")


__all__ = ["verify_neon_auth_jwt", "NeonAuthVerificationError", "JWKSCache"]
