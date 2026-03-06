"""Serialization utilities"""
import json
from typing import Any


def encode_json(obj: Any) -> str:
    """Encode object to JSON string"""
    return json.dumps(obj, default=str)


def decode_json(data: str) -> Any:
    """Decode JSON string to object"""
    return json.loads(data)
