"""Authentication models."""
from typing import Optional


class NeonAuthUser:
    """Represents a user from neon_auth.user."""

    def __init__(
        self,
        id: str,
        email: str,
        email_verified: bool,
        name: Optional[str] = None,
        image: Optional[str] = None,
        created_at: Optional[str] = None,
        updated_at: Optional[str] = None,
    ):
        self.id = id
        self.email = email
        self.email_verified = email_verified
        self.name = name
        self.image = image
        self.created_at = created_at
        self.updated_at = updated_at

    def to_dict(self) -> dict:
        """Convert to dictionary."""
        return {
            "id": self.id,
            "email": self.email,
            "email_verified": self.email_verified,
            "name": self.name,
            "image": self.image,
            "created_at": self.created_at,
            "updated_at": self.updated_at,
        }


__all__ = ["NeonAuthUser"]
