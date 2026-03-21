"""Application configuration"""
from pathlib import Path

from pydantic import ConfigDict
from pydantic_settings import BaseSettings


BACKEND_ROOT = Path(__file__).resolve().parents[1]


class Settings(BaseSettings):
    """Application settings"""

    app_name: str = "Vertex Swarm Backend"
    app_version: str = "0.1.0"
    debug: bool = False
    env: str = "development"

    # Database
    database_url: str = ""
    database_echo_sql: bool = False
    database_pool_size: int = 20
    database_max_overflow: int = 10
    database_pool_timeout: int = 30
    database_pool_recycle: int = 3600
    
    # Redis
    redis_url: str = "redis://localhost:6379/0"

    model_config = ConfigDict(
        env_file=BACKEND_ROOT / ".env",
        case_sensitive=False,
    )

    @property
    def database(self):
        """Return database config as a dict for connection use"""
        return {
            "url": self.database_url,
            "echo_sql": self.database_echo_sql,
            "pool_size": self.database_pool_size,
            "max_overflow": self.database_max_overflow,
            "pool_timeout": self.database_pool_timeout,
            "pool_recycle": self.database_pool_recycle,
        }


settings = Settings()
