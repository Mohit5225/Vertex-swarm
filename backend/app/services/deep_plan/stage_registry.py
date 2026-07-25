"""Deep plan worker stage definitions — id, prompt, outputs, tool allowlist."""
from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

from .constants import REQUIREMENTS_REL

_STAGES_DIR = Path(__file__).parent.parent.parent / "prompts" / "deep_plan" / "stages"

SYSTEM_PLAN_REL = "plan_pipeline/02_system_plan.md"
FRONTEND_PLAN_REL = "plan_pipeline/03_frontend_plan.md"
FRONTEND_PLAN_A_REL = "plan_pipeline/03_frontend_plan_a.md"
FRONTEND_PLAN_B_REL = "plan_pipeline/03_frontend_plan_b.md"
SDK_AUDIT_REL = "plan_pipeline/04_sdk_practices_audit.md"
CODE_AUDIT_REL = "plan_pipeline/05_code_practices_audit.md"
PERF_PLAN_REL = "plan_pipeline/06_performance_planning.md"
SECURITY_AUDIT_REL = "plan_pipeline/07_security_audit.md"
CORRECTION_SUMMARY_REL = "plan_pipeline/08_correction_summary.md"

END_LAYER_STAGE_ID = "correction"

PLANNER_STAGE_IDS = frozenset(
    {
        "system_plan",
        "frontend_plan",
        "frontend_plan_a",
        "frontend_plan_b",
    }
)

CHECKER_STAGE_IDS = frozenset(
    {
        "sdk_practices_audit",
        "code_practices_audit",
        "performance_planning",
        "security_audit",
    }
)

_STAGE_PROMPT_CACHE: dict[str, str] = {}

_READ_TOOLS = ("workspace_ops", "web_search", "hil_tool", "load_tool_context")


@dataclass(frozen=True)
class StageDefinition:
    stage_id: str
    label: str
    output_rel: str
    prompt_file: str
    tool_categories: tuple[str, ...]
    input_artifacts: tuple[str, ...]
    writes_in_place: bool = False


STAGE_REGISTRY: dict[str, StageDefinition] = {
    "system_plan": StageDefinition(
        stage_id="system_plan",
        label="System plan",
        output_rel=SYSTEM_PLAN_REL,
        prompt_file="system_plan.md",
        tool_categories=_READ_TOOLS,
        input_artifacts=(REQUIREMENTS_REL,),
    ),
    "frontend_plan": StageDefinition(
        stage_id="frontend_plan",
        label="Frontend plan",
        output_rel=FRONTEND_PLAN_REL,
        prompt_file="frontend_plan.md",
        tool_categories=_READ_TOOLS,
        input_artifacts=(REQUIREMENTS_REL, SYSTEM_PLAN_REL),
    ),
    "frontend_plan_a": StageDefinition(
        stage_id="frontend_plan_a",
        label="Frontend plan (A)",
        output_rel=FRONTEND_PLAN_A_REL,
        prompt_file="frontend_plan_a.md",
        tool_categories=_READ_TOOLS,
        input_artifacts=(REQUIREMENTS_REL, SYSTEM_PLAN_REL),
    ),
    "frontend_plan_b": StageDefinition(
        stage_id="frontend_plan_b",
        label="Frontend plan (B)",
        output_rel=FRONTEND_PLAN_B_REL,
        prompt_file="frontend_plan_b.md",
        tool_categories=_READ_TOOLS,
        input_artifacts=(REQUIREMENTS_REL, SYSTEM_PLAN_REL),
    ),
    "sdk_practices_audit": StageDefinition(
        stage_id="sdk_practices_audit",
        label="SDK practices audit",
        output_rel=SDK_AUDIT_REL,
        prompt_file="sdk_practices_audit.md",
        tool_categories=_READ_TOOLS,
        input_artifacts=(REQUIREMENTS_REL, SYSTEM_PLAN_REL),
    ),
    "code_practices_audit": StageDefinition(
        stage_id="code_practices_audit",
        label="Code practices audit",
        output_rel=CODE_AUDIT_REL,
        prompt_file="code_practices_audit.md",
        tool_categories=_READ_TOOLS,
        input_artifacts=(REQUIREMENTS_REL, SYSTEM_PLAN_REL, SDK_AUDIT_REL),
    ),
    "performance_planning": StageDefinition(
        stage_id="performance_planning",
        label="Performance planning",
        output_rel=PERF_PLAN_REL,
        prompt_file="performance_planning.md",
        tool_categories=_READ_TOOLS,
        input_artifacts=(REQUIREMENTS_REL, SYSTEM_PLAN_REL, SDK_AUDIT_REL),
    ),
    "security_audit": StageDefinition(
        stage_id="security_audit",
        label="Security audit",
        output_rel=SECURITY_AUDIT_REL,
        prompt_file="security_audit.md",
        tool_categories=_READ_TOOLS,
        input_artifacts=(REQUIREMENTS_REL, SYSTEM_PLAN_REL),
    ),
    END_LAYER_STAGE_ID: StageDefinition(
        stage_id=END_LAYER_STAGE_ID,
        label="Plan coherence pass",
        output_rel=CORRECTION_SUMMARY_REL,
        prompt_file="correction.md",
        tool_categories=_READ_TOOLS,
        input_artifacts=(REQUIREMENTS_REL,),
        writes_in_place=True,
    ),
}


IMPLEMENTED_WORKER_STAGES: frozenset[str] = frozenset(STAGE_REGISTRY.keys())


def get_stage(stage_id: str) -> StageDefinition | None:
    return STAGE_REGISTRY.get(stage_id)


def is_planner_stage(stage_id: str) -> bool:
    return stage_id in PLANNER_STAGE_IDS


def is_checker_stage(stage_id: str) -> bool:
    return stage_id in CHECKER_STAGE_IDS


def load_stage_prompt(stage_id: str) -> str | None:
    if stage_id in _STAGE_PROMPT_CACHE:
        return _STAGE_PROMPT_CACHE[stage_id]
    stage = get_stage(stage_id)
    if stage is None:
        return None
    path = _STAGES_DIR / stage.prompt_file
    if not path.is_file():
        return None
    try:
        text = path.read_text(encoding="utf-8").strip()
    except OSError:
        return None
    _STAGE_PROMPT_CACHE[stage_id] = text
    return text
