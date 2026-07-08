"""Web search helpers backed by Exa."""
from __future__ import annotations

import asyncio
from typing import Any

from app.core.config import settings


def _normalize_search_results(search_response: Any) -> list[dict[str, Any]]:
    results: list[dict[str, Any]] = []
    for result in getattr(search_response, "results", []) or []:
        results.append(
            {
                "title": getattr(result, "title", None),
                "url": getattr(result, "url", None),
                "highlights": getattr(result, "highlights", None),
            }
        )
    return results


async def search_web(query: str, num_results: int = 5) -> list[dict[str, Any]]:
    if not settings.exa_api_key.strip():
        raise RuntimeError("EXA_API_KEY is not configured")

    safe_num_results = max(1, min(int(num_results), 10))

    def do_search():
        from exa_py import Exa

        exa = Exa(api_key=settings.exa_api_key.strip())
        return exa.search(
            query,
            type="auto",
            num_results=safe_num_results,
            contents={"highlights": True},
        )

    search_response = await asyncio.to_thread(do_search)
    return _normalize_search_results(search_response)


__all__ = ["search_web"]
