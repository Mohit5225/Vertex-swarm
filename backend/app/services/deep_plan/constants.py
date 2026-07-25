"""Shared paths and phase constants for deep plan."""
from __future__ import annotations

ARTIFACT_ROOT = "plan_pipeline"
MANIFEST_REL = f"{ARTIFACT_ROOT}/00_pipeline_manifest.json"
REQUIREMENTS_REL = f"{ARTIFACT_ROOT}/01_requirements.md"
INDEX_REL = f"{ARTIFACT_ROOT}/index.md"

DEEP_PLAN_PHASE_KEY = "deep_plan_phase"
DEEP_PLAN_PIPELINE_KEY = "deep_plan_pipeline"

PHASE_REQ = "req"
PHASE_PIPELINE = "pipeline"
PHASE_IDLE = "idle"

# Vertex-owned intake — orchestrator skips execution
VERTEX_OWNED_STAGES = frozenset({"requirement_extraction"})

# Stagger parallel spawns within a wave (seconds between starting each worker)
PARALLEL_SPAWN_STAGGER_SECONDS = 10

# Cap Vertex orchestration LLM round-trips
MAX_DEEP_PLAN_PIPELINE_LLM_ROUNDS = 48
