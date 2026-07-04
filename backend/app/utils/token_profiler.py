import json
import logging
import os
from typing import Any, Dict, List
import tiktoken
from datetime import datetime, timezone

logger = logging.getLogger(__name__)

class TokenProfiler:
    def __init__(self, request_id: str):
        self.request_id = request_id
        self.profile = {
            "request_id": request_id,
            "created_at": datetime.now(timezone.utc).isoformat(),
            "total_provider_billed_tokens": 0,
            "constants": {},
            "turns": [],
        }
        try:
            self.encoder = tiktoken.get_encoding("cl100k_base")
        except Exception as e:
            logger.error("Failed to load tiktoken encoding: %s", e)
            self.encoder = None

    def _count_tokens(self, text: str | None) -> int:
        if not self.encoder or not text:
            return 0
        try:
            return len(self.encoder.encode(text))
        except Exception:
            return 0

    def log_constant(self, name: str, value: str | None) -> None:
        """Log a constant piece of the prompt (e.g., skeleton, schema)."""
        token_count = self._count_tokens(value)
        self.profile["constants"][name] = token_count

    def _ensure_turn(self, round_num: int) -> Dict[str, Any]:
        """Ensure the turn dictionary exists for this round."""
        for turn in self.profile["turns"]:
            if turn["round"] == round_num:
                return turn
        new_turn = {"round": round_num}
        self.profile["turns"].append(new_turn)
        return new_turn

    def log_turn(self, round_num: int, name: str, value: str | None) -> None:
        """Log a specific component during a turn (e.g., tool output, reasoning)."""
        turn = self._ensure_turn(round_num)
        token_count = self._count_tokens(value)
        turn[name] = token_count

    def log_payload_snapshot(self, round_num: int, messages: List[Dict[str, Any]]) -> None:
        """Measure the exact total size of the llm_messages array sent to the API."""
        turn = self._ensure_turn(round_num)
        total_tokens = 0
        if self.encoder:
            try:
                payload_str = json.dumps(messages)
                total_tokens = len(self.encoder.encode(payload_str))
            except Exception:
                pass
        turn["cumulative_tokens_sent_to_api_this_round"] = total_tokens

    def log_api_usage(self, round_num: int, usage: Dict[str, Any]) -> None:
        """Log the exact API usage reported by the provider."""
        turn = self._ensure_turn(round_num)
        try:
            # Aggressively sanitize any non-serializable nested objects (like CompletionTokensDetails)
            turn["api_usage"] = json.loads(json.dumps(usage, default=str))
        except Exception:
            turn["api_usage"] = str(usage)
            
        total_tokens = usage.get("total_tokens", 0)
        self.profile["total_provider_billed_tokens"] += total_tokens

    def dump(self, directory: str = "logs") -> None:
        """Dump the final profile to a JSON file."""
        try:
            os.makedirs(directory, exist_ok=True)
            filepath = os.path.join(directory, f"token_profile_{self.request_id}.json")
            with open(filepath, "w", encoding="utf-8") as f:
                json.dump(self.profile, f, indent=2)
            logger.info("Token profile dumped to %s", filepath)
        except Exception as e:
            logger.error("Failed to dump token profile: %s", e)
            try:
                with open(filepath + ".error", "w", encoding="utf-8") as err_f:
                    err_f.write(str(e))
            except Exception:
                pass
