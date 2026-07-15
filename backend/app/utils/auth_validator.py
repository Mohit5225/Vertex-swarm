import jwt
from jwt.exceptions import ExpiredSignatureError, InvalidTokenError

class EntitlementError(Exception):
    def __init__(self, code: int, message: str):
        self.code = code
        self.message = message
        super().__init__(message)

# This Public Key is safely baked into the Python backend.
# It is used to mathematically verify that the JWT was signed by our Cloud Auth Service's Private Key.
# It cannot be used to forge tokens.
PUBLIC_KEY = """-----BEGIN PUBLIC KEY-----
MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAnTO1Nhp2rUI8yoPsw5qf
UBwb4IFPnLGdLJSl2d1pgXs8smvB+GLsQwR6Ii9/XRBsgLYxxV9ZUDbx3u7H9Jp+
OmPEL/lGon84WhrWFcHrLZz93G7XplTtbo8gcfcMcV+jEad0L6pq1yoOxK08Nn/F
20FhXDdE1h7WEmnVLDl7IQYuFNYELjffyweumkWkw6HWuMa+f5xa81s/8kW2M5Ka
ZEtLtrY8vmCsBfwYxQvvP+ube0y1HQtjIxcogwV1UaaaHpaquo2oruNMmLA7tPCS
wVgmY/nChYOV7eK55Ktx9SCAnvJIek6mp+R3K13HqKvdXc2OrKvLhbJqhGC7oZpQ
uQIDAQAB
-----END PUBLIC KEY-----"""

def validate_entitlement(token: str) -> dict:
    """
    Cryptographically verifies the RS256 JWT using the baked-in Public Key.
    Returns the decoded claims if valid.
    Raises EntitlementError if expired or invalid.
    """
    if not token:
        raise EntitlementError(code=-32000, message="no_entitlement")

    try:
        # Decode and verify the signature using the Public Key and RS256 algorithm.
        claims = jwt.decode(
            token,
            PUBLIC_KEY,
            algorithms=["RS256"],
            options={"require": ["exp"]},
            audience="vertex-swarm-extension",
            issuer="vertex-swarm-backend"
        )
        return claims
    except ExpiredSignatureError:
        # Expected error code -32001 tells the extension to trigger a Cloud /refresh
        raise EntitlementError(code=-32001, message="entitlement_expired")
    except InvalidTokenError as e:
        # If the signature doesn't match the math, it was forged or corrupted.
        raise EntitlementError(code=-32000, message=f"invalid_entitlement: {str(e)}")
