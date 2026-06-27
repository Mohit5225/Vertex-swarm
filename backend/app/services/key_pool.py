import asyncio

from app.core.config import settings

class OpenRouterKeyPool:
    """Thread-safe round-robin key selector for OpenRouter API keys."""

    def __init__(self, keys: list[str]) -> None:
        # Fallback to empty string if no keys provided
        self._keys = keys if keys else [""]
        self._index = 0
        self._lock = asyncio.Lock()

    async def next_key(self) -> str:
        async with self._lock:
            key = self._keys[self._index % len(self._keys)]
            self._index += 1
            # Return index and key so we can log which key was used
            return (self._index - 1) % len(self._keys), key

    @property
    def pool_size(self) -> int:
        return len(self._keys)

# Singleton initialized from settings
key_pool = OpenRouterKeyPool(settings.llm_api_key_pool)
