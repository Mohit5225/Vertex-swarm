"""Run one deep-plan worker stage via an ephemeral internal agent loop."""
from __future__ import annotations

import asyncio
import json
import logging
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any, TYPE_CHECKING
from uuid import uuid4

from .artifacts import read_text_file, resolve_artifact_path
from .stage_registry import StageDefinition, get_stage, load_stage_prompt

if TYPE_CHECKING:
    from .orchestrator import DeepPlanOrchestrator

logger = logging.getLogger(__name__)

_MIN_SYSTEM_PLAN_CHARS = 400
_INTEGRATION_HEADING_RE = re.compile(
    r"(?im)^##\s+integration\s*/\s*cross-surface\s*$"
)


@dataclass
class StageRunResult:
    ok: bool
    stage_id: str
    output_rel: str | None = None
    content: str | None = None
    error: str | None = None


def extract_integration_section(requirements_md: str) -> str:
    """Return the Integration / cross-surface section from requirements."""
    match = _INTEGRATION_HEADING_RE.search(requirements_md)
    if not match:
        return "_No Integration / cross-surface section found in requirements._"
    start = match.start()
    rest = requirements_md[match.end() :]
    next_heading = re.search(r"(?m)^##\s+", rest)
    end = match.end() + next_heading.start() if next_heading else len(requirements_md)
    return requirements_md[start:end].strip()


def extract_markdown_artifact(text: str) -> str:
    """Strip optional fenced code block wrapper from model output."""
    body = (text or "").strip()
    if not body.startswith("```"):
        return body
    lines = body.splitlines()
    if lines and lines[0].startswith("```"):
        lines = lines[1:]
    if lines and lines[-1].strip() == "```":
        lines = lines[:-1]
    return "\n".join(lines).strip()


def validate_system_plan_content(content: str) -> tuple[bool, str | None]:
    text = content.strip()
    if len(text) < _MIN_SYSTEM_PLAN_CHARS:
        return False, f"system plan too short ({len(text)} chars; min {_MIN_SYSTEM_PLAN_CHARS})"
    if not text.startswith("#"):
        return False, "system plan must start with a top-level markdown heading (# )"
    if "## " not in text:
        return False, "system plan must include at least one ## section"
    return True, None


_MIN_GENERIC_PLAN_CHARS = 200


def validate_stage_content(stage_id: str, content: str) -> tuple[bool, str | None]:
    """Stage-specific output validation — extend per worker as stages land."""
    if stage_id == "system_plan":
        return validate_system_plan_content(content)
    text = content.strip()
    if len(text) < _MIN_GENERIC_PLAN_CHARS:
        return False, f"{stage_id} output too short ({len(text)} chars; min {_MIN_GENERIC_PLAN_CHARS})"
    if not text.startswith("#"):
        return False, f"{stage_id} output must start with a top-level markdown heading (# )"
    return True, None


def _manifest_slice(manifest: dict[str, Any]) -> str:
    keys = (
        "pipeline_id",
        "pipeline_mode",
        "surfaces",
        "scale_tier",
        "frontend_strategy",
        "requested_stages",
        "skipped_stages",
        "rationale",
    )
    slice_data = {key: manifest.get(key) for key in keys if key in manifest}
    return json.dumps(slice_data, indent=2)


def build_stage_user_message(
    *,
    stage: StageDefinition,
    requirements_path: str,
    requirements_md: str,
    manifest: dict[str, Any],
    prior_artifacts: dict[str, str],
) -> str:
    integration = extract_integration_section(requirements_md)
    prior_blocks: list[str] = []
    for rel, body in prior_artifacts.items():
        prior_blocks.append(f"### Prior artifact: `{rel}`\n\n{body.strip()}")

    prior_section = "\n\n".join(prior_blocks) if prior_blocks else "_None._"

    if stage.writes_in_place:
        return (
            f"# Deep plan stage: {stage.stage_id}\n\n"
            f"Edit existing plan markdown under `plan_pipeline/` in place using workspace tools. "
            f"Do not replace entire files in your final answer.\n\n"
            f"After edits, return a short summary (for `{stage.output_rel}`) listing coherence fixes applied.\n\n"
            f"## Requirements (`{requirements_path}`)\n\n"
            f"{requirements_md.strip()}\n\n"
            f"## Integration slice (for cross-surface contract)\n\n"
            f"{integration}\n\n"
            f"## Manifest slice\n\n"
            f"```json\n{_manifest_slice(manifest)}\n```\n\n"
            f"## Prior stage artifacts\n\n"
            f"{prior_section}\n\n"
            f"Return only the correction summary markdown for `{stage.output_rel}` as your final answer."
        )

    return (
        f"# Deep plan stage: {stage.stage_id}\n\n"
        f"Write **`{stage.output_rel}`**.\n\n"
        f"## Requirements (`{requirements_path}`)\n\n"
        f"{requirements_md.strip()}\n\n"
        f"## Integration slice (for cross-surface contract)\n\n"
        f"{integration}\n\n"
        f"## Manifest slice\n\n"
        f"```json\n{_manifest_slice(manifest)}\n```\n\n"
        f"## Prior stage artifacts\n\n"
        f"{prior_section}\n\n"
        f"Return the full markdown for `{stage.output_rel}` as your final answer."
    )


async def run_stage(
    orchestrator: DeepPlanOrchestrator,
    *,
    pipeline_id: str,
    stage_id: str,
    manifest: dict[str, Any],
    requirements_path: str,
    prior_artifacts: dict[str, str] | None = None,
) -> StageRunResult:
    stage = get_stage(stage_id)
    if stage is None:
        return StageRunResult(
            ok=False,
            stage_id=stage_id,
            error=f"unknown stage: {stage_id!r}",
        )

    prompt_prose = load_stage_prompt(stage_id)
    if not prompt_prose:
        return StageRunResult(
            ok=False,
            stage_id=stage_id,
            output_rel=stage.output_rel,
            error=f"stage prompt missing for {stage_id!r}",
        )

    chat_dir = orchestrator.chat_dir
    req_path = resolve_artifact_path(chat_dir, requirements_path)
    requirements_md = await read_text_file(req_path)
    if requirements_md is None:
        return StageRunResult(
            ok=False,
            stage_id=stage_id,
            output_rel=stage.output_rel,
            error=f"requirements missing: {requirements_path}",
        )

    user_message = build_stage_user_message(
        stage=stage,
        requirements_path=requirements_path,
        requirements_md=requirements_md,
        manifest=manifest,
        prior_artifacts=prior_artifacts or {},
    )

    from app.orchestrator import _run_agent_loop_impl

    parent = orchestrator._parent
    stage_chat_id = orchestrator._chat_id
    context: dict[str, Any] = {
        "user_id": "deep_plan_worker",
        "synthetic_session_id": f"sess_{pipeline_id}_{stage_id}",
        "request_message_id": f"msg_{uuid4().hex[:12]}",
        "ide_context_enabled": True,
        "active_tool_categories": list(stage.tool_categories),
        "deep_plan_stage_id": stage_id,
        "task_type": f"deep_plan:{stage_id}",
        "ephemeral_run": True,
        "pipeline_id": pipeline_id,
    }

    async def worker_trace_emit(event: dict[str, Any]) -> None:
        await orchestrator.emit_worker_trace(stage_id, event)

    context["external_trace_emit"] = worker_trace_emit

    system_preamble = (
        f"{prompt_prose}\n\n---\n\n"
        f"Pipeline id: `{pipeline_id}`\n"
        f"Parent chat id: `{orchestrator._chat_id}`\n"
        f"Output path: `{stage.output_rel}`"
    )
    context["stage_system_preamble"] = system_preamble

    logger.info(
        "deep_plan stage run start pipeline_id=%s stage_id=%s chat_id=%s",
        pipeline_id,
        stage_id,
        stage_chat_id,
    )

    try:
        raw_response = await _run_agent_loop_impl(
            parent,
            stage_chat_id,
            user_message,
            context,
        )
    except asyncio.CancelledError:
        raise
    except Exception as exc:
        logger.exception(
            "deep_plan stage run failed pipeline_id=%s stage_id=%s",
            pipeline_id,
            stage_id,
        )
        return StageRunResult(
            ok=False,
            stage_id=stage_id,
            output_rel=stage.output_rel,
            error=str(exc),
        )

    content = extract_markdown_artifact(raw_response)

    if stage.writes_in_place:
        summary = content.strip()
        if len(summary) < 80:
            return StageRunResult(
                ok=False,
                stage_id=stage_id,
                output_rel=stage.output_rel,
                error="correction pass must return a short summary of coherence fixes applied",
            )
        await orchestrator.write_artifact(stage.output_rel, summary)
        return StageRunResult(
            ok=True,
            stage_id=stage_id,
            output_rel=stage.output_rel,
            content=summary,
        )

    ok, err = validate_stage_content(stage_id, content)
    if not ok:
        return StageRunResult(
            ok=False,
            stage_id=stage_id,
            output_rel=stage.output_rel,
            error=err,
        )

    await orchestrator.write_artifact(stage.output_rel, content)
    return StageRunResult(
        ok=True,
        stage_id=stage_id,
        output_rel=stage.output_rel,
        content=content,
    )


async def read_prior_artifacts(
    chat_dir: Path,
    *,
    paths: list[str],
) -> dict[str, str]:
    out: dict[str, str] = {}
    for rel in paths:
        path = resolve_artifact_path(chat_dir, rel)
        text = await read_text_file(path)
        if text:
            out[rel] = text
    return out
