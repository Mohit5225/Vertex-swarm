from dataclasses import dataclass
from pathlib import Path
from typing import Optional

@dataclass
class WorkerConfig:
    base_path: Path
    llm_key: str
    exa_key: Optional[str]
    entitlement_token: str
    platform: str
    llm_base_url: str = "https://api.deepseek.com/v1"
    llm_model: str = "deepseek-chat"
    llm_fallback_model: str = "deepseek-chat"
    llm_reasoning_enabled: bool = False
    llm_reasoning_effort: str = "low"
