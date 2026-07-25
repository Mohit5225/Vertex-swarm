"""Parse and validate 00_pipeline_manifest.json (trust mode)."""
from __future__ import annotations

import json
from typing import Any

from .constants import VERTEX_OWNED_STAGES

MANIFEST_SCHEMA_VERSION = 1

_VALID_SURFACES = frozenset({"frontend", "backend", "fullstack"})
_VALID_FRONTEND_STRATEGIES = frozenset({"none", "single", "dual"})
_VALID_SCALE_TIERS = frozenset({"small", "medium", "large", "custom"})


def parse_manifest_json(raw: str) -> tuple[dict[str, Any] | None, list[str]]:
    errors: list[str] = []
    try:
        data = json.loads(raw)
    except json.JSONDecodeError as exc:
        return None, [f"manifest is not valid JSON: {exc}"]

    if not isinstance(data, dict):
        return None, ["manifest root must be a JSON object"]

    ok, val_errors = validate_manifest(data)
    if not ok:
        errors.extend(val_errors)
        return None, errors
    return data, []


def validate_manifest(data: dict[str, Any]) -> tuple[bool, list[str]]:
    errors: list[str] = []

    version = data.get("schema_version")
    if version != MANIFEST_SCHEMA_VERSION:
        errors.append(f"schema_version must be {MANIFEST_SCHEMA_VERSION}")

    pipeline_id = data.get("pipeline_id")
    if not isinstance(pipeline_id, str) or not pipeline_id.strip():
        errors.append("pipeline_id must be a non-empty string")

    surfaces = data.get("surfaces")
    if not isinstance(surfaces, list) or not surfaces:
        errors.append("surfaces must be a non-empty array")
    else:
        for item in surfaces:
            if item not in _VALID_SURFACES:
                errors.append(f"invalid surface: {item!r}")

    scale_tier = data.get("scale_tier")
    if scale_tier is not None and scale_tier not in _VALID_SCALE_TIERS:
        errors.append(f"invalid scale_tier: {scale_tier!r}")

    frontend_strategy = data.get("frontend_strategy")
    if frontend_strategy is not None and frontend_strategy not in _VALID_FRONTEND_STRATEGIES:
        errors.append(f"invalid frontend_strategy: {frontend_strategy!r}")

    requested = data.get("requested_stages")
    if not isinstance(requested, list) or not requested:
        errors.append("requested_stages must be a non-empty array")
    else:
        if "assembly" not in requested:
            errors.append("requested_stages must include assembly")
        for stage_id in requested:
            if not isinstance(stage_id, str) or not stage_id.strip():
                errors.append("requested_stages entries must be non-empty strings")

    skipped = data.get("skipped_stages")
    if skipped is not None and not isinstance(skipped, dict):
        errors.append("skipped_stages must be an object when present")

    rationale = data.get("rationale")
    if not isinstance(rationale, str) or not rationale.strip():
        errors.append("rationale must be a non-empty string")

    return len(errors) == 0, errors


def planner_stages(manifest: dict[str, Any]) -> list[str]:
    """Stages the pipeline harness should run (excludes Vertex-owned intake)."""
    requested = manifest.get("requested_stages") or []
    out: list[str] = []
    for stage_id in requested:
        if stage_id in VERTEX_OWNED_STAGES:
            continue
        if stage_id == "assembly":
            continue
        out.append(stage_id)
    return out
