import logging
import os
import urllib.request
import urllib.error
import json
from typing import Any

import jwt
from jwt import PyJWKClient, PyJWKClientError
from jwt.exceptions import ExpiredSignatureError, InvalidTokenError

logger = logging.getLogger(__name__)


class EntitlementError(Exception):
    def __init__(self, code: int, message: str):
        self.code = code
        self.message = message
        super().__init__(message)


# Module-level JWKS client — instantiated lazily on first use.
# Shared across all calls in the same worker process lifetime.
_jwks_client: PyJWKClient | None = None
_jwks_url: str = ""


def configure_jwks_url(url: str) -> None:
    """
    Called once at worker startup (from handle_initialize) with the URL
    received from the extension in the initialize params.
    e.g. https://your-app.onrender.com/.well-known/jwks.json
    """
    global _jwks_client, _jwks_url
    if not url:
        return
    _jwks_url = url.rstrip("/")
    # PyJWKClient handles in-memory caching and automatic refresh on unknown kid.
    # lifespan=3600 means it re-fetches the JWKS at most once per hour.
    _jwks_client = PyJWKClient(_jwks_url, lifespan=3600, timeout=10)
    logger.info("JWKS client configured: %s", _jwks_url)


def _get_signing_key(token: str):
    """
    Resolve the signing key for this token.
    Uses the JWKS client if configured, otherwise raises EntitlementError
    so the caller can return a clear 'auth service not configured' error
    instead of silently failing.
    """
    if _jwks_client is None:
        raise EntitlementError(
            code=-32000,
            message=(
                "no_jwks_client: auth service URL was not provided at startup. "
                "Set VERTEX_HOSTED_AUTH_URL so the worker can fetch the public key."
            ),
        )
    try:
        return _jwks_client.get_signing_key_from_jwt(token)
    except PyJWKClientError as exc:
        raise EntitlementError(code=-32000, message=f"jwks_fetch_failed: {exc}") from exc


def validate_entitlement(token: str) -> dict:
    """
    Cryptographically verifies the RS256 JWT using the public key fetched
    dynamically from the hosted auth service's JWKS endpoint.

    Returns the decoded claims if valid.
    Raises EntitlementError if expired, invalid, or the key cannot be fetched.
    """
    if not token:
        raise EntitlementError(code=-32000, message="no_entitlement")

    try:
        signing_key = _get_signing_key(token)

        claims = jwt.decode(
            token,
            signing_key.key,
            algorithms=["RS256"],
            options={"require": ["exp", "sub", "iss", "aud", "token_type"]},
            audience="vertex-swarm-extension",
            issuer="vertex-swarm-backend",
        )

        # Ensure this is an *access* token, not a refresh token.
        if claims.get("token_type") != "access":
            raise EntitlementError(
                code=-32000,
                message="invalid_token_type: only access tokens are accepted",
            )

        # Require a subject claim — tokens without sub have no identity.
        if not isinstance(claims.get("sub"), str) or not claims["sub"]:
            raise EntitlementError(
                code=-32000,
                message="invalid_entitlement: token missing sub claim",
            )

        return claims

    except ExpiredSignatureError:
        # Expected: tells the extension to trigger a cloud /refresh
        raise EntitlementError(code=-32001, message="entitlement_expired")
    except EntitlementError:
        raise
    except InvalidTokenError as exc:
        raise EntitlementError(
            code=-32000, message=f"invalid_entitlement: {exc}"
        ) from exc
