import asyncio
import json
import logging
from typing import Callable, Optional, Dict, Any

from nats.aio.client import Client as NATS
from nats.js.api import KeyValueConfig
from nats.js.errors import KeyNotFoundError, BucketNotFoundError

logger = logging.getLogger(__name__)

# Fail fast when nats-server dies mid-request instead of hanging the agent loop forever.
_KV_TIMEOUT_SECONDS = 5.0


class NATSClient:
    def __init__(self):
        self.nc = NATS()
        self.js = None

    async def connect(self, url: str) -> None:
        await self.nc.connect(url)
        self.js = self.nc.jetstream()

    async def close(self) -> None:
        await self.nc.close()

    def is_connected(self) -> bool:
        try:
            return bool(self.nc.is_connected)
        except Exception:
            return False

    async def publish(self, subject: str, payload: dict) -> None:
        payload_bytes = json.dumps(payload).encode("utf-8")
        await self.nc.publish(subject, payload_bytes)

    async def request(self, subject: str, payload: dict, timeout: float = 5.0) -> dict:
        payload_bytes = json.dumps(payload).encode("utf-8")
        msg = await self.nc.request(subject, payload_bytes, timeout=timeout)
        return json.loads(msg.data.decode("utf-8"))

    async def subscribe(self, subject: str, handler: Callable) -> None:
        async def _wrapper(msg):
            try:
                data = json.loads(msg.data.decode("utf-8"))
            except Exception as e:
                logger.error(f"Failed to parse NATS message on {subject}: {e}")
                data = {}
            try:
                await handler(msg, data)
            except Exception as e:
                logger.error(f"Handler for NATS message on {subject} crashed: {e}")

        await self.nc.subscribe(subject, cb=_wrapper)

    async def _get_or_create_kv(self, bucket: str, ttl: Optional[int] = None):
        try:
            return await self.js.key_value(bucket)
        except BucketNotFoundError:
            config = KeyValueConfig(bucket=bucket)
            if ttl is not None:
                config.ttl = ttl
            return await self.js.create_key_value(config)

    async def kv_set(self, bucket: str, key: str, value: str, ttl: Optional[int] = None) -> None:
        async def _set() -> None:
            kv = await self._get_or_create_kv(bucket, ttl)
            await kv.put(key, value.encode("utf-8"))

        await asyncio.wait_for(_set(), timeout=_KV_TIMEOUT_SECONDS)

    async def kv_get(self, bucket: str, key: str) -> Optional[str]:
        async def _get() -> Optional[str]:
            kv = await self._get_or_create_kv(bucket)
            try:
                entry = await kv.get(key)
                return entry.value.decode("utf-8")
            except KeyNotFoundError:
                return None

        return await asyncio.wait_for(_get(), timeout=_KV_TIMEOUT_SECONDS)

    async def kv_delete(self, bucket: str, key: str) -> None:
        async def _delete() -> None:
            kv = await self._get_or_create_kv(bucket)
            try:
                await kv.delete(key)
            except KeyNotFoundError:
                pass

        await asyncio.wait_for(_delete(), timeout=_KV_TIMEOUT_SECONDS)
