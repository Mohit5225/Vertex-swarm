"""Unified application configuration — merges all settings"""
from pathlib import Path

from pydantic import ConfigDict, field_validator
from pydantic_settings import SettingsConfigDict,BaseSettings


BACKEND_ROOT = Path(__file__).resolve().parents[2]


class Settings(BaseSettings):
    """Unified application settings"""

    model_config = SettingsConfigDict(
        env_file=BACKEND_ROOT / ".env",
        case_sensitive=False,
        extra="ignore",
    )

    # ========================================
    # Application
    # ========================================
    app_name: str = "Vertex Swarm Backend"
    app_version: str = "0.1.0"
    debug: bool = False
    env: str = "development"

    @field_validator("debug", mode="before")
    @classmethod
    def _parse_debug(cls, value):
        if isinstance(value, bool):
            return value

        if isinstance(value, str):
            normalized = value.strip().lower()
            if normalized in {"1", "true", "yes", "on", "debug"}:
                return True
            if normalized in {"0", "false", "no", "off", "release", "prod", "production"}:
                return False

        return value

    # ========================================
    # CORS
    # ========================================
    cors_origins: list = ["http://localhost:52080", "http://localhost:5173", "http://localhost:3000"]
    cors_allow_credentials: bool = True
    cors_allow_methods: list = ["GET", "POST", "PUT", "DELETE", "OPTIONS", "PATCH"]
    cors_allow_headers: list = ["*"]

    # ========================================
    # Database (PostgreSQL / Neon)
    # ========================================
    database_url: str = ""
    database_echo_sql: bool = False
    database_pool_size: int = 20
    database_max_overflow: int = 10
    database_pool_timeout: int = 30
    database_pool_recycle: int = 3600

    # ========================================
    # Redis (Cache)
    # ========================================
    redis_url: str = "redis://localhost:6379/0"
    redis_encoding: str = "utf-8"
    redis_decode_responses: bool = True
    redis_socket_connect_timeout: int = 5
    redis_socket_keepalive: bool = True
    redis_retry_on_timeout: bool = True
    redis_health_check_interval: int = 30

    # ========================================
    # Neon Auth (Phase 2) — JWT Verification
    # ========================================
    neon_auth_base_url: str = ""
    neon_auth_jwks_url: str = ""
    jwt_algorithm: str = "EdDSA"  # Neon Auth uses EdDSA with Ed25519 (OKP keys), verified via JWKS
    jwt_cache_ttl_seconds: int = 3600  # Cache JWKS keys for 1 hour
    jwt_token_leeway_seconds: int = 300  # Clock skew tolerance (iat, exp validation)

    # ========================================
    # OpenRouter / LiteLLM
    # ========================================
    openrouter_api_key: str = ""
    openrouter_model: str = "z-ai/glm-4.5-air:free"
    openrouter_fallback_model: str = "openrouter/z-ai/glm-4.5-air:free"  # Fallback on 429 rate limit
    openrouter_reasoning_enabled: bool = True
    openrouter_reasoning_effort: str = "low"

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
