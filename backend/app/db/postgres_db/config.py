"""Database configuration — environment-aware settings"""
from pydantic_settings import BaseSettings
from typing import Optional


class DatabaseSettings(BaseSettings):
    """PostgreSQL/Neon database configuration"""

    url: str = ""
    echo_sql: bool = False
    pool_size: int = 20
    max_overflow: int = 10
    pool_timeout: int = 30
    pool_recycle: int = 3600

    class Config:
        env_file = ".env"
        case_sensitive = False
        env_prefix = "DATABASE_"


class AppSettings(BaseSettings):
    """Application settings"""

    app_name: str = "Vertex Swarm Backend"
    app_version: str = "0.1.0"
    debug: bool = False
    env: str = "development"

    # Database
    database: DatabaseSettings = DatabaseSettings()

    class Config:
        env_file = ".env"
        case_sensitive = False


settings = AppSettings()
