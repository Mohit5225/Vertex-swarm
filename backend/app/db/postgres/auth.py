"""Postgres auth queries."""
import logging
from typing import Optional

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.auth import NeonAuthUser

logger = logging.getLogger(__name__)


async def get_user_by_id(session: AsyncSession, user_id: str) -> Optional[NeonAuthUser]:
    """Query neon_auth.user by ID from JWT subject claim."""
    try:
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
    except Exception:
        logger.warning(
            "neon_auth.user lookup failed for user_id=%s",
            user_id,
            exc_info=True,
        )
        return None


__all__ = ["get_user_by_id"]
