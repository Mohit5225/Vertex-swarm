
import httpx
from fastapi import APIRouter, HTTPException, Query
from starlette.responses import RedirectResponse
from app.core.config import settings

router = APIRouter(prefix="/api/v1/auth/neon", tags=["neon-auth"])

@router.get("/callback", summary="Neon Auth Callback", description="Handles the callback from Neon Auth and exchanges the session verifier for a JWT.")
async def neon_auth_callback(neon_auth_session_verifier: str = Query(...)):
    """
    Handles the callback from Neon Auth.

    This endpoint receives the `neon_auth_session_verifier` from Neon Auth,
    and exchanges it for a JWT by making a POST request to the Neon Auth token endpoint.
    """
    token_url = f"{settings.neon_auth_base_url}/token"
    async with httpx.AsyncClient() as client:
        try:
            response = await client.post(
                token_url,
                json={"session_verifier": neon_auth_session_verifier},
                timeout=10
            )
            response.raise_for_status()  # Raise an exception for 4xx or 5xx status codes
            return response.json()
        except httpx.HTTPStatusError as e:
            raise HTTPException(status_code=e.response.status_code, detail=f"Failed to exchange verifier for token: {e.response.text}")
        except httpx.RequestError as e:
            raise HTTPException(status_code=500, detail=f"An error occurred while requesting the token: {str(e)}")

__all__ = ["router"]
