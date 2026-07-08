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
    # Vertex extension auth broker (Phase 3)
    # ========================================
    app_auth_secret: str = ""
    app_auth_algorithm: str = "HS256"
    app_auth_issuer: str = "vertex-swarm-backend"
    app_auth_audience: str = "vertex-swarm-extension"

    # Legacy env compatibility: APP_AUTH_TOKEN_TTL_SECONDS
    app_auth_token_ttl_seconds: int = 604800
    # Preferred explicit TTL settings (set to 0 to fall back)
    app_auth_access_token_ttl_seconds: int = 0
    app_auth_refresh_token_ttl_seconds: int = 0

    # ========================================
    # OpenAI-compatible LLM provider
    # OpenRouter is the active path; Modal is retained for rollback.
    # ========================================
    # openrouter_base_url: str = "https://openrouter.ai/api/v1"
    # openrouter_api_key: str = ""
    # openrouter_api_key_2: str = ""
    # openrouter_api_key_3: str = ""
    # openrouter_api_key_4: str = ""
    # openrouter_api_key_5: str = ""
    # openrouter_api_key_6: str = ""
    # openrouter_model: str = "poolside/laguna-xs.2:free"
    # openrouter_fallback_model: str = "poolside/laguna-xs.2:free"
    # openrouter_reasoning_enabled: bool = True
    # openrouter_reasoning_effort: str = "low"

    deepseek_base_url: str = "https://api.deepseek.com"
    deepseek_api_key: str = ""
    deepseek_model: str = "deepseek-v4-flash"
    deepseek_fallback_model: str = "deepseek-v4-flash"
    deepseek_reasoning_enabled: bool = False
    deepseek_reasoning_effort: str = "low"

    modal_base_url: str = "https://api.us-west-2.modal.direct/v1"
    modal_api_key: str = ""
    modal_model: str = "zai-org/GLM-5-FP8"
    modal_fallback_model: str = "zai-org/GLM-5-FP8"
    modal_reasoning_enabled: bool = False
    modal_reasoning_effort: str = "low"

    # ========================================
    # Web search (Exa)
    # ========================================
    exa_api_key: str = ""

    @property
    def llm_base_url(self) -> str:
        if self.deepseek_api_key.strip():
            return self.deepseek_base_url
        return self.modal_base_url

    @property
    def llm_api_key_pool(self) -> list[str]:
        """All configured DeepSeek keys (non-empty), in order."""
        candidates = [
            self.deepseek_api_key,
        ]
        return [k.strip() for k in candidates if k.strip()]

    @property
    def llm_api_key(self) -> str:
        if self.deepseek_api_key.strip():
            return self.deepseek_api_key
        return self.modal_api_key

    @property
    def llm_model(self) -> str:
        if self.deepseek_api_key.strip():
            return self.deepseek_model
        return self.modal_model

    @property
    def llm_fallback_model(self) -> str:
        if self.deepseek_api_key.strip():
            return self.deepseek_fallback_model
        return self.modal_fallback_model

    @property
    def llm_reasoning_enabled(self) -> bool:
        if self.deepseek_api_key.strip():
            return self.deepseek_reasoning_enabled
        return self.modal_reasoning_enabled

    @property
    def llm_reasoning_effort(self) -> str:
        if self.deepseek_api_key.strip():
            return self.deepseek_reasoning_effort
        return self.modal_reasoning_effort

    @property
    def app_auth_access_ttl_seconds(self) -> int:
        """Effective access-token TTL (short-lived by default)."""
        if self.app_auth_access_token_ttl_seconds > 0:
            return self.app_auth_access_token_ttl_seconds
        return min(self.app_auth_token_ttl_seconds, 3600)

    @property
    def app_auth_refresh_ttl_seconds(self) -> int:
        """Effective refresh-token TTL."""
        if self.app_auth_refresh_token_ttl_seconds > 0:
            return self.app_auth_refresh_token_ttl_seconds
        return self.app_auth_token_ttl_seconds

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
