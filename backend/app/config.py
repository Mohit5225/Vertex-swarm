from dataclasses import dataclass, field
from pathlib import Path
from typing import Optional

@dataclass
class WorkerConfig:
    base_path: Path
    llm_key: str
    exa_key: Optional[str]
    entitlement_token: str
    platform: str
    # OpenRouter is the active path; DeepSeek retained for rollback.
    llm_base_url: str = "https://openrouter.ai/api/v1"
    llm_model: str = "deepseek/deepseek-v4-flash"
    llm_fallback_model: str = "deepseek/deepseek-v4-flash"
    # llm_base_url: str = "https://api.deepseek.com/v1"
    # llm_model: str = "deepseek-v4-pro"
    # llm_fallback_model: str = "deepseek-v4-pro"
    llm_reasoning_enabled: bool = False
    llm_reasoning_effort: str = "low"
    worktree_path: Optional[Path] = None
    # URL of the hosted auth service JWKS endpoint.
    # The worker fetches the RS256 public key from here once per session
    # so no key is ever hardcoded in source code.
    auth_jwks_url: str = ""
