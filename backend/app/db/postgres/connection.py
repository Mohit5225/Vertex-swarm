"""Database connection module — manages async and sync database operations"""
from typing import AsyncGenerator
import asyncpg
from sqlalchemy import create_engine, text
from sqlalchemy.ext.asyncio import create_async_engine, AsyncSession, async_sessionmaker
from sqlalchemy.orm import DeclarativeBase
from app.core.config import settings


# ============================================================================
# Helper: Parse connection string for asyncpg compatibility
# ============================================================================

def _parse_async_url(db_url: str) -> str:
    """
    Convert postgresql:// URL to postgresql+asyncpg:// format,
    removing SQL parameters that asyncpg doesn't understand.
    Neon uses sslmode and channel_binding which need to be handled separately.
    """
    # Remove query parameters (sslmode, channel_binding, etc.)
    if "?" in db_url:
        db_url = db_url.split("?")[0]
    
    # Replace driver
    return db_url.replace("postgresql://", "postgresql+asyncpg://")


# ============================================================================
# SQLAlchemy Base for ORM models
# ============================================================================

class Base(DeclarativeBase):
    """Base class for all ORM models"""

    pass


# ============================================================================
# Async Engine (for async operations)
# ============================================================================

async_engine = create_async_engine(
    _parse_async_url(settings.database_url),
    echo=settings.database_echo_sql,
    pool_size=settings.database_pool_size,
    max_overflow=settings.database_max_overflow,
    pool_timeout=settings.database_pool_timeout,
    pool_recycle=settings.database_pool_recycle,
    connect_args={
        "server_settings": {"application_name": settings.app_name},
        "ssl": "require",
    },
)

# Async session factory
AsyncSessionLocal = async_sessionmaker(
    async_engine,
    class_=AsyncSession,
    expire_on_commit=False,
    autoflush=False,
    autocommit=False,
)


# ============================================================================
# Async Dependency Injection
# ============================================================================

async def get_async_db() -> AsyncGenerator[AsyncSession, None]:
    """
    Dependency for FastAPI endpoints.
    Yields async database session.
    Automatically cleans up after request.
    
    Usage in FastAPI:
        @app.get("/items")
        async def list_items(db: AsyncSession = Depends(get_async_db)):
            ...
    """
    async with AsyncSessionLocal() as session:
        try:
            yield session
        finally:
            await session.close()


# ============================================================================
# Sync Engine (for sync migration scripts, CLI tools)
# ============================================================================

sync_engine = create_engine(
    settings.database_url.replace("postgresql://", "postgresql+psycopg://"),
    echo=settings.database_echo_sql,
    pool_size=settings.database_pool_size,
    max_overflow=settings.database_max_overflow,
    pool_timeout=settings.database_pool_timeout,
    pool_recycle=settings.database_pool_recycle,
    connect_args={"connect_timeout": 10},
)


# ============================================================================
# Connection Health Check
# ============================================================================

async def test_async_connection() -> bool:
    """Test async database connectivity"""
    try:
        async with async_engine.begin() as conn:
            await conn.execute(text("SELECT 1"))
        return True
    except Exception as e:
        print(f"❌ Async database connection failed: {e}")
        return False


def test_sync_connection() -> bool:
    """Test sync database connectivity"""
    try:
        with sync_engine.begin() as conn:
            conn.execute(text("SELECT 1"))
        return True
    except Exception as e:
        print(f"❌ Sync database connection failed: {e}")
        return False


# ============================================================================
# Asyncpg Connection Pool (for raw SQL operations)
# ============================================================================

_asyncpg_pool: asyncpg.Pool = None


async def init_asyncpg_pool() -> asyncpg.Pool:
    """Initialize asyncpg connection pool for high-performance raw SQL"""
    global _asyncpg_pool
    if _asyncpg_pool is None:
        _asyncpg_pool = await asyncpg.create_pool(
            settings.database_url,
            min_size=10,
            max_size=20,
            command_timeout=60,
        )
    return _asyncpg_pool


async def close_asyncpg_pool():
    """Close asyncpg pool on application shutdown"""
    global _asyncpg_pool
    if _asyncpg_pool:
        await _asyncpg_pool.close()


async def get_asyncpg_connection() -> asyncpg.Connection:
    """Get raw asyncpg connection"""
    pool = await init_asyncpg_pool()
    return await pool.acquire()
