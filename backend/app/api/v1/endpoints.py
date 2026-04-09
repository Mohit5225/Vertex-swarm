"""Health check endpoints."""
from fastapi import APIRouter

router = APIRouter(tags=["general"])


@router.get("/health")
async def health_check():
    """Health check endpoint"""
    return {"status": "healthy"}
