"""Validation and answer normalization for hil_tool."""
from __future__ import annotations

from typing import Any

_MAX_QUESTIONS = 10
_MAX_OPTIONS = 8
_MIN_OPTIONS = 2

_VALID_CONTEXTS = frozenset({"execution", "deep_plan", "planning_gate"})


def validate_hil_ask_payload(tool_args: dict[str, Any]) -> tuple[str | None, str | None]:
    """Return (error_message, error_code) or (None, None) when valid.

    Availability and appropriate use are prompt-guided — no execution_active gate.
    """
    action = tool_args.get("action")
    if action != "ask":
        return (f"Unsupported hil_tool action: {action!r}. Only 'ask' is supported.", "validation_error")

    payload = tool_args.get("payload")
    if not isinstance(payload, dict):
        return ("hil_tool payload must be an object.", "validation_error")

    context = payload.get("context")
    if context not in _VALID_CONTEXTS:
        return (
            f"context must be one of: {', '.join(sorted(_VALID_CONTEXTS))}.",
            "validation_error",
        )

    agent_label = payload.get("agent_label")
    if not isinstance(agent_label, str) or not agent_label.strip():
        return ("agent_label must be a non-empty string.", "validation_error")

    questions = payload.get("questions")
    if not isinstance(questions, list) or not questions:
        return ("questions must be a non-empty array.", "validation_error")
    if len(questions) > _MAX_QUESTIONS:
        return (f"At most {_MAX_QUESTIONS} questions per ask.", "validation_error")

    seen_ids: set[str] = set()
    for index, question in enumerate(questions):
        if not isinstance(question, dict):
            return (f"questions[{index}] must be an object.", "validation_error")

        question_id = question.get("question_id")
        if not isinstance(question_id, str) or not question_id.strip():
            return (f"questions[{index}].question_id must be a non-empty string.", "validation_error")
        if question_id in seen_ids:
            return (f"Duplicate question_id: {question_id}", "validation_error")
        seen_ids.add(question_id)

        prompt = question.get("prompt")
        if not isinstance(prompt, str) or not prompt.strip():
            return (f"questions[{index}].prompt must be a non-empty string.", "validation_error")

        options = question.get("options")
        if not isinstance(options, list) or len(options) < _MIN_OPTIONS:
            return (
                f"questions[{index}].options must have at least {_MIN_OPTIONS} items.",
                "validation_error",
            )
        if len(options) > _MAX_OPTIONS:
            return (
                f"questions[{index}].options must have at most {_MAX_OPTIONS} items.",
                "validation_error",
            )

        option_ids: set[str] = set()
        for opt_index, option in enumerate(options):
            if not isinstance(option, dict):
                return (
                    f"questions[{index}].options[{opt_index}] must be an object.",
                    "validation_error",
                )
            opt_id = option.get("id")
            opt_label = option.get("label")
            if not isinstance(opt_id, str) or not opt_id.strip():
                return (
                    f"questions[{index}].options[{opt_index}].id must be a non-empty string.",
                    "validation_error",
                )
            if not isinstance(opt_label, str) or not opt_label.strip():
                return (
                    f"questions[{index}].options[{opt_index}].label must be a non-empty string.",
                    "validation_error",
                )
            if opt_id in option_ids:
                return (
                    f"Duplicate option id {opt_id!r} in question {question_id!r}.",
                    "validation_error",
                )
            option_ids.add(opt_id)

    return (None, None)


def normalize_hil_questions(questions: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Apply UI defaults (allow_custom / allow_skip) for stream events."""
    normalized: list[dict[str, Any]] = []
    for question in questions:
        normalized.append(
            {
                "question_id": question["question_id"],
                "prompt": question["prompt"],
                "options": question["options"],
                "allow_custom": question.get("allow_custom", True),
                "allow_skip": question.get("allow_skip", True),
            }
        )
    return normalized


def enrich_hil_answers(
    questions: list[dict[str, Any]],
    raw_answers: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    """Attach option labels to agent-facing tool result data."""
    by_id = {question["question_id"]: question for question in questions}
    enriched: list[dict[str, Any]] = []

    for answer in raw_answers:
        if not isinstance(answer, dict):
            continue
        question_id = answer.get("question_id")
        answer_type = answer.get("type")
        if not isinstance(question_id, str) or not isinstance(answer_type, str):
            continue

        entry: dict[str, Any] = {"question_id": question_id, "type": answer_type}
        if answer_type == "option":
            option_id = answer.get("option_id")
            if isinstance(option_id, str):
                entry["option_id"] = option_id
                question = by_id.get(question_id)
                if question:
                    for option in question.get("options", []):
                        if option.get("id") == option_id:
                            entry["label"] = option.get("label")
                            break
        elif answer_type == "custom":
            text = answer.get("text")
            if isinstance(text, str):
                entry["text"] = text
        enriched.append(entry)

    return enriched