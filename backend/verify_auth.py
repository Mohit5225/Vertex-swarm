#!/usr/bin/env python
import sys

from app.main import app


auth_routes = [r.path for r in app.routes if 'auth' in r.path or 'neon' in r.path]
print("Auth routes registered in backend:")
for route in sorted(auth_routes):
    print(f"  {route}")

try:
    from app.auth.core import verify_neon_auth_jwt, NeonAuthVerificationError
    print("app.auth.core imports working")
except ImportError as e:
    print(f"app.auth.core import failed: {e}")
    sys.exit(1)

try:
    from app.auth.dependencies import get_current_user
    print("app.auth.dependencies imports working")
except ImportError as e:
    print(f"app.auth.dependencies import failed: {e}")
    sys.exit(1)

try:
    from app.auth.middleware import extract_bearer_token
    print("app.auth.middleware imports working")
except ImportError as e:
    print(f"app.auth.middleware import failed: {e}")
    sys.exit(1)

try:
    from app.db.postgres.auth import get_user_by_id
    print("app.db.postgres.auth imports working")
except ImportError as e:
    print(f"app.db.postgres.auth import failed: {e}")
    sys.exit(1)

try:
    from app.models.auth import NeonAuthUser
    print("app.models.auth imports working")
except ImportError as e:
    print(f"app.models.auth import failed: {e}")
    sys.exit(1)

print("\nBackend auth imports are coherent.")
