"""Redis cache configuration"""
from pydantic_settings import BaseSettings
from pydantic import ConfigDict


class RedisSettings(BaseSettings):
    """Redis cache configuration"""

    url: str = "redis://localhost:6379/0"
    encoding: str = "utf-8"
    decode_responses: bool = True
    socket_connect_timeout: int = 5
    socket_keepalive: bool = True
    retry_on_timeout: bool = True
    health_check_interval: int = 30

    model_config = ConfigDict(
        env_file=".env",
        case_sensitive=False,
        env_prefix="REDIS_",
    )
