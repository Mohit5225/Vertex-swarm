"""JWT verification and Neon Auth integration (Phase 2)"""
from datetime import datetime, timedelta, timezone
from typing import Optional
import logging

import aiohttp
import jwt
from jwt import PyJWKClientError

from app.core.config import settings

logger = logging.getLogger(__name__)


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
        logger.debug(f"Token kid={kid}, alg={unverified_header.get('alg')}")

        if not kid:
            raise NeonAuthVerificationError("Token missing 'kid' header")

        jwks_data = await _jwks_cache.get()
        keys = {key["kid"]: key for key in jwks_data.get("keys", [])}

        if not keys:
            raise NeonAuthVerificationError("No JWKS keys available")

        if kid not in keys:
            logger.warning(f"Kid {kid} not in cache, forcing JWKS refresh...")
            refreshed_jwks_data = await _jwks_cache.get(force_refresh=True)
            keys = {key["kid"]: key for key in refreshed_jwks_data.get("keys", [])}

        if kid not in keys:
            raise NeonAuthVerificationError(f"Key {kid} not found in JWKS (available kids: {list(keys.keys())})")

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
        
        logger.debug(f"Decoding with alg={token_alg}, leeway={settings.jwt_token_leeway_seconds}s")
        decoded = jwt.decode(
            token,
            public_key,
            algorithms=[token_alg],
            audience=None,
            # Neon Auth may include an audience claim even when this backend
            # does not enforce one. Disable audience validation explicitly.
            options={"verify_aud": False},
            leeway=settings.jwt_token_leeway_seconds,  # Tolerance for clock skew (iat, exp)
        )
        
        # Log JWT lifetime details
        exp_timestamp = decoded.get('exp')
        if exp_timestamp:
            exp_dt = datetime.fromtimestamp(exp_timestamp, tz=timezone.utc)
            now = datetime.now(timezone.utc)
            remaining = exp_dt - now
            hours = remaining.total_seconds() // 3600
            minutes = (remaining.total_seconds() % 3600) // 60
            logger.info(f"JWT lifetime: exp={exp_dt.isoformat()} (expires in {int(hours)}h {int(minutes)}m) | sub={decoded.get('sub')}")
        else:
            logger.warning(f"JWT decoded but no exp claim found: sub={decoded.get('sub')}")
        
        logger.debug(f"Token decoded successfully: sub={decoded.get('sub')}, iat={decoded.get('iat')}, exp={decoded.get('exp')}")
        return decoded

    except jwt.ExpiredSignatureError:
        raise NeonAuthVerificationError("Token has expired")
    except jwt.ImmatureSignatureError:
        try:
            unverified_payload = jwt.decode(
                token,
                options={
                    "verify_signature": False,
                    "verify_exp": False,
                    "verify_iat": False,
                    "verify_nbf": False,
                    "verify_aud": False,
                },
            )
            token_iat = unverified_payload.get("iat")
            server_now = int(datetime.now(timezone.utc).timestamp())
            if isinstance(token_iat, (int, float)):
                skew_seconds = int(token_iat) - server_now
                logger.error(
                    "Token iat is ahead of backend clock by %ss (iat=%s, now=%s, leeway=%ss)",
                    skew_seconds,
                    int(token_iat),
                    server_now,
                    settings.jwt_token_leeway_seconds,
                )
            else:
                logger.error(
                    "Token failed iat validation and iat claim is non-numeric (iat=%s)",
                    token_iat,
                )
        except Exception as diagnostics_error:
            logger.error("Unable to compute JWT iat skew diagnostics: %s", diagnostics_error)
        raise NeonAuthVerificationError("Token is not yet valid (clock skew detected)")
    except jwt.InvalidAudienceError:
        raise NeonAuthVerificationError("Invalid token audience")
    except jwt.InvalidSignatureError:
        raise NeonAuthVerificationError("Invalid token signature")
    except jwt.DecodeError as e:
        raise NeonAuthVerificationError(f"Token decode error: {str(e)}")
    except (PyJWKClientError, KeyError, ValueError) as e:
        raise NeonAuthVerificationError(f"JWKS error: {str(e)}")


__all__ = ["verify_neon_auth_jwt", "NeonAuthVerificationError", "JWKSCache"]
