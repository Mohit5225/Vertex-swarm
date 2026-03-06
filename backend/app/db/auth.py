"""Database layer for neon_auth schema queries (Phase 2)"""
from typing import Optional

from sqlalchemy import select, text
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.postgres.connection import Base


class NeonAuthUser:
    """Represents a user from neon_auth.user table"""

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
        """Convert to dictionary"""
        return {
            "id": self.id,
            "email": self.email,
            "email_verified": self.email_verified,
            "name": self.name,
            "image": self.image,
            "created_at": self.created_at,
            "updated_at": self.updated_at,
        }


async def get_user_by_id(session: AsyncSession, user_id: str) -> Optional[NeonAuthUser]:
    """
    Query neon_auth.user by ID (from JWT 'sub' claim).
    
    Args:
        session: AsyncSession from app database
        user_id: User ID from JWT token
        
    Returns:
        NeonAuthUser or None if not found
    """
    try:
        # Query neon_auth.user schema directly
        stmt = text("""
            SELECT id, email, "emailVerified", name, image, "createdAt", "updatedAt"
            FROM neon_auth."user"
            WHERE id = :user_id
            LIMIT 1
        """)

        result = await session.execute(stmt, {"user_id": user_id})
        row = result.first()

        if not row:
            return None

        return NeonAuthUser(
            id=row[0],
            email=row[1],
            email_verified=row[2],
            name=row[3],
            image=row[4],
            created_at=row[5],
            updated_at=row[6],
        )

    except Exception as e:
        # Log the error but don't crash
        print(f"Error querying neon_auth.user: {e}")
        return None


async def get_user_by_email(session: AsyncSession, email: str) -> Optional[NeonAuthUser]:
    """
    Query neon_auth.user by email.
    
    Args:
        session: AsyncSession from app database
        email: User email
        
    Returns:
        NeonAuthUser or None if not found
    """
    try:
        stmt = text("""
            SELECT id, email, "emailVerified", name, image, "createdAt", "updatedAt"
            FROM neon_auth."user"
            WHERE email = :email
            LIMIT 1
        """)

        result = await session.execute(stmt, {"email": email})
        row = result.first()

        if not row:
            return None

        return NeonAuthUser(
            id=row[0],
            email=row[1],
            email_verified=row[2],
            name=row[3],
            image=row[4],
            created_at=row[5],
            updated_at=row[6],
        )

    except Exception as e:
        print(f"Error querying neon_auth.user by email: {e}")
        return None


__all__ = ["NeonAuthUser", "get_user_by_id", "get_user_by_email"]
