#!/usr/bin/env python3
"""Generate test JWT for session endpoint testing"""
import jwt
from datetime import datetime, timezone, timedelta

payload = {
    'sub': 'test-user-123',
    'email': 'test@example.com',
    'email_verified': True,
    'exp': (datetime.now(timezone.utc) + timedelta(hours=1)).timestamp(),
    'iat': datetime.now(timezone.utc).timestamp(),
}

# Note: This won't validate against Neon Auth JWKS (which is OK for this test)
# In production, Neon Auth would issue the token
token = jwt.encode(payload, 'dummy-secret', algorithm='HS256')
print(token)
