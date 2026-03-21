
import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from sqlalchemy import text
from app.core.config import settings
from app.db.redis_db import init_redis, close_redis
from app.agent_infra.heartbeat import init_vitality_tracker, close_vitality_tracker
from app.agent_infra.jobs import init_archival_job, close_archival_job
from app.db.postgres.connection import async_engine, Base
import app.db.postgres.models  # noqa: F401 — registers ORM metadata before create_all

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s [%(name)s] %(message)s",
)
logging.getLogger("uvicorn.error").setLevel(logging.INFO)
logging.getLogger("uvicorn.access").setLevel(logging.INFO)
logging.getLogger(__name__).setLevel(logging.INFO)

logger = logging.getLogger(__name__)


@asynccontextmanager
async def lifespan(app: FastAPI):
    """
    FastAPI lifespan context manager.
    Handles startup and shutdown of background services.
    
    Startup sequence:
    1. Initialize Redis cache
    2. Initialize agent vitality tracker (background heartbeat check)
    3. Initialize session archival job (background TTL enforcement)
    
    Shutdown sequence (reverse order):
    1. Stop archival job
    2. Stop vitality tracker
    3. Close Redis
    """
    # Startup
    logger.info("🚀 Backend startup sequence")

    try:
        logger.info("Creating database tables...")
        async with async_engine.begin() as conn:
            await conn.run_sync(Base.metadata.create_all)
            await conn.execute(
                text(
                    "ALTER TABLE chats "
                    "ADD COLUMN IF NOT EXISTS ide_context_enabled BOOLEAN NOT NULL DEFAULT FALSE"
                )
            )
        logger.info("✅ Database tables ready")
    except Exception as exc:
        logger.error(f"❌ Database table creation failed: {exc}")
        raise

    try:
        logger.info("Initializing Redis cache...")
        await init_redis()
        logger.info("✅ Redis initialized")
    except Exception as exc:
        logger.error(f"❌ Redis initialization failed: {exc}")
        raise
    
    try:
        logger.info("Initializing agent vitality tracker...")
        await init_vitality_tracker()
        logger.info("✅ Agent vitality tracker initialized")
    except Exception as exc:
        logger.error(f"❌ Vitality tracker initialization failed: {exc}")
        raise
    
    try:
        logger.info("Initializing session archival job...")
        await init_archival_job()
        logger.info("✅ Session archival job initialized")
    except Exception as exc:
        logger.error(f"❌ Archival job initialization failed: {exc}")
        raise
    
    logger.info("✅ All background services started")
    
    yield  # Application runs here
    
    # Shutdown
    logger.info("🛑 Backend shutdown sequence")
    
    try:
        logger.info("Stopping session archival job...")
        await close_archival_job()
        logger.info("✅ Archival job stopped")
    except Exception as exc:
        logger.error(f"Error stopping archival job: {exc}")
    
    try:
        logger.info("Stopping agent vitality tracker...")
        await close_vitality_tracker()
        logger.info("✅ Vitality tracker stopped")
    except Exception as exc:
        logger.error(f"Error stopping vitality tracker: {exc}")
    
    try:
        logger.info("Closing Redis...")
        await close_redis()
        logger.info("✅ Redis closed")
    except Exception as exc:
        logger.error(f"Error closing Redis: {exc}")
    
    logger.info("✅ Shutdown complete")


app = FastAPI(
    title=settings.app_name,
    version=settings.app_version,
    lifespan=lifespan,
)

# Configure CORS middleware
app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins,
    allow_credentials=settings.cors_allow_credentials,
    allow_methods=settings.cors_allow_methods,
    allow_headers=settings.cors_allow_headers,
)


@app.get("/health")
async def health_check():
    """Health check endpoint"""
    return {"status": "healthy", "app": settings.app_name}


@app.get("/")
async def root():
    """Root endpoint."""
    return {"message": "Vertex Swarm Backend API", "version": settings.app_version}


# Include API routes
from app.api.v1 import endpoints, sessions
from app.api.v1.chat import router as chat_router
from app.api.v1.tools import router as tools_router
from app.auth.routes import protected as auth

app.include_router(auth.router)
app.include_router(endpoints.router)
app.include_router(sessions.router)
app.include_router(chat_router)
app.include_router(tools_router)
