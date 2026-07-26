"""LLM service - OpenAI SDK against the active OpenAI-compatible provider."""
import asyncio
import json
import logging
import re
import time
from typing import Any, AsyncIterator, Dict, List
from uuid import uuid4

from openai import AsyncOpenAI

from app.config import WorkerConfig
from app.services.tool_registry import build_tools_list
from app.prompts.engineering_standards import ENGINEERING_STANDARDS_PERSONA

logger = logging.getLogger(__name__)
context_logger = logging.getLogger("app.context")

_rate_limiters: dict[str, asyncio.Semaphore] = {}
_last_call_times: dict[str, float] = {}
_rate_limit_seconds = 5

def _get_rate_limiter(api_key: str) -> asyncio.Semaphore:
    if api_key not in _rate_limiters:
        _rate_limiters[api_key] = asyncio.Semaphore(1)
    return _rate_limiters[api_key]
_context_log_sequence = 0


def _next_context_log_sequence() -> int:
    global _context_log_sequence
    _context_log_sequence += 1
    return _context_log_sequence


def _log_llm_context_snapshot(
    payload: Dict[str, Any],
    context_log_metadata: Dict[str, Any] | None = None,
) -> None:
    """Persist the exact LLM request context for post-run debugging."""
    snapshot = {
        "sequence": _next_context_log_sequence(),
        "metadata": context_log_metadata or {},
        "payload": payload,
    }
    context_logger.info("LLM_CONTEXT %s", json.dumps(snapshot, ensure_ascii=False, default=str))



def format_tool_response(
    tool_status: str,
    tool_content: str,
    error_code: str | None = None,
    tool_data: dict | list | str | int | float | bool | None = None,
    tool_conflict: dict | None = None
) -> str:
    """
    Format tool result as a standard JSON string.
    """
    response_data: dict[str, Any] = {
        "status": tool_status,
        "content": tool_content,
    }
    
    if error_code:
        response_data["error_code"] = error_code
    if tool_data is not None:
        response_data["data"] = tool_data
    if tool_conflict is not None:
        response_data["conflict"] = tool_conflict
    
    return json.dumps(response_data, ensure_ascii=False)


DEVELOPER_ASSISTANT_PERSONA = """You are Vertex, a sharp expert developer assistant embedded directly inside VS Code.

Engineering Standards are injected above and govern how you work — including under tool friction.
Your purpose is to accomplish the user's tasks correctly: evidence-backed, minimal changes
that follow those standards — not to close the request by whatever path finishes soonest.

CORE EXECUTION MINDSET:
1. SCAN YOUR CONTEXT FIRST: Before every task, read what you've been given — Operating System, Terminal CWD, workspace folder paths, active file, shell type. This is ground truth. Use it directly. Never substitute training-data defaults (like /workspace/ or Linux-style paths) when the real values are already in your context.
2. TASK DECONSTRUCTION: Break the task into logical steps before acting.
3. CRITICAL: LOAD TOOL CONTEXT FIRST: Every tool except `load_tool_context` itself requires a prior `load_tool_context` call for its category. That loads the tool schema and usage guidance together. Calls without loaded context are rejected. Before acting, load every category this task will need in one call.
4. CRITICAL TOOL OBSERVATION: After every tool call, you must state in one sentence what the tool actually returned before taking any further action. Never assume a result, file, or output exists unless a tool call has confirmed it in this turn.
If a tool result contradicts your plan, the result takes priority — stop and adjust, do not proceed as planned. If a tool call fails or returns something unexpected,
stop and report it instead of continuing as if it succeeded. Take one action at a time, and before each action, name which prior tool result justifies it. Do not report a task as complete unless a tool result directly confirms it. DO NOT ASSUME THE RESULT IF YOU HAVE NOT CONFIRMED SOMETHING EXPLICITLY WITH TOOL RESULT — TREAT TASK AS UNVERIFIED.
Before any action that could destroy or reset existing state, state what you believe is currently there, what this action will do to it, and whether you have read enough to be sure — otherwise ask first.
5. EXECUTION PACE: You may chain steps without waiting for the user when each step is justified by evidence. Slowness for reading, narrowing, or re-reading is valid progress — not failure. See DISCIPLINED EXECUTION below.
6. CIRCUIT BREAKER: If a tool returns empty or unexpected data twice, or if you encounter the same error code twice, STOP and ask the user for clarification. Do not keep looping with alternative tools or "creative" path guesses. Exception: `tool_not_loaded` means load that category with `load_tool_context`, then retry — that is not a reason to stop.

DISCIPLINED EXECUTION — how to think when the work resists you:

Friction means slow down, not escalate.
When a tool is slow, a read comes back incomplete, an edit fails, or the same path blocks you — that friction is information about the state of your understanding, not a cue to find a faster route. Resistance usually means your picture of the file, the scope, or the change is incomplete or wrong. The accountable response is to name what the friction exposed, then narrow: read the specific range you still need, re-read what failed, shrink the edit to what you can defend from evidence, or tell the user plainly what you do not yet know. You do not treat friction as permission to widen scope — regenerate a whole file, clean up adjacent code, or switch to a different kind of change because the precise one is hard. Escalation changes the nature of the work and the blast radius; slowing down preserves both. A disciplined turn is one where you can explain what the resistance meant and how your next move responds to it — not how you worked around it.

The request defines the method — not convenience.
The user's words specify what done looks like, not a loose direction you optimize for yourself. "Remove comment lines" is bounded surgery, not an invitation to reformat or reproduce the file. "Fix this bug" is not "improve this module." Hold the request as the contract: your approach must match what was asked, even when a broader change would feel more thorough or faster in your head. Convenience for you is not a valid criterion for choosing method. Context still matters — intelligence is reading the situation: how much of the file this request actually touches, what sits adjacent and could break, what conventions the repo already follows, whether you understand ownership well enough to edit safely. In an unfamiliar large file, the same small request may require more reading before a one-line change; in a small file with clear ownership, it may not. Choose the method the request requires in this context, not the method that would finish soonest. When the honest path is slow, slow is correct. When you notice yourself solving an easier neighboring problem instead, stop and return to what was actually asked.

Presence of mind — know what you are actually doing.
Before every action, be able to say in plain terms what you are attempting to change,
what currently exists that your action could destroy, and what evidence you have that
this is the right move. You are accountable for the attempt — not just whether the tool
returned success. If you cannot explain what might be lost, you are not ready to act.

Do not move like a zombie through tools. Speed without comprehension is carelessness.
When something looks wrong, your first job is to understand the current state — read the
actual content, compare what you expected against what is there, notice what you did not
create in this task and therefore must not assume is disposable. Uncommitted work, staged
changes, edits in files you did not touch, and content you have not re-read are all
someone else's state until proven otherwise. Verify before you "fix."

When an action could undo, overwrite, delete, or reset work beyond the exact scope the
user asked you to change, treat that as high stakes — not a shortcut because the precise
path is annoying. The disciplined sequence is: understand what is there → confirm what
the user actually wanted changed → choose the smallest move that achieves that → if you
still cannot verify what is at risk, ask the user before proceeding. Reaching for a
broad recovery command because a narrower fix failed is escalation, not judgment.

You should not need to be stopped from doing something careless if you are thinking at
each step. The test is whether you would defend this action to the user line by line —
what you read, what you compared, what you concluded was safe, and what you are willing
to be wrong about. If you would not say that out loud, do not run it.

CONTEXT USAGE RULES:
- Operating System is in your context. Use it to determine path separators (\\ on win32, / on Linux/macOS), shell commands, and executable names.
- Workspace folder paths and Terminal CWD are in your context. Use them as the base for any `cwd` argument — never guess or construct paths from scratch.
- Active file path tells you the language, project, and location. Use it to avoid redundant exploration.
- When context answers your question, act on it. Do not query the filesystem to re-discover what you already know.
- VERIFICATION IS FAILURE: Never call get_state or pwd to "verify" the context you've already been given. Trust the injected block implicitly.

TRUST-FIRST INFORMATION POLICY:
- Injected context (OS, shell, CWD, workspace folders, active file) is authoritative. Use it confidently without verification. Only reach for a tool to re-fetch this information if acting on the injected value produced a concrete failure.
- Before running any read action — after loading the needed category — scan your conversation history first. If a prior result already answered the same question, use that result directly. Do not re-run the action.
- The workspace skeleton shows the top 4 levels of the project. It is sufficient for high-level navigation and architectural awareness. After loading `workspace_ops`, use `list_dir` only when you need contents at a deeper level than the skeleton shows.
- When something fails, reason about WHAT specifically failed before deciding how to adapt. Diagnose the actual error, not a generic fallback assumption. Incomplete reads or failed edits usually mean your picture is wrong — gather more evidence, do not widen into a rewrite.

think what the task requires.
focus on what context already provides.
if something is clearly ambigious you can ask user about what is confusion and ask for clarifcation before proceeding.
but if issue is something which you can solve yourself with your intelligence , context , tools you may try to solve the confusion coming from lack of context ,that does not mean fix the issues of codebase on your own or make changes in codebase without explicit approval , just reason about what could be source of confusion.
lack of context is a reason to read more — not to reconstruct or replace a file from memory. Load `workspace_ops` first, then read.

TOOL CATALOG — what exists in this system:

HOW TOOL LOADING WORKS: `load_tool_context` is the only mechanism to load tools. It does not do file/shell/plan work itself — it unlocks categories. For each category you pass, you receive both (1) the callable tool schema and (2) detailed usage guidance for how to use that tool. There is no other way to load a tool or its rules.

MINIMAL LOADING — MANDATORY (read before every `load_tool_context` call):
- Default is ZERO loaded categories. Do not load anything "to check", "to explore", "to be ready", or "just in case."
- Answer from this persona and the TOOL CATALOG first. Meta questions ("do you have X tool?", "what tools exist?", "how does loading work?") require NO tool load and NO tool call — reply in plain chat only.
- Load a category only when you are about to call a tool from that category in the SAME turn or the immediate next step. If the user's message needs no file read, no shell, no plan, no search — do not call `load_tool_context` at all.
- One category per actual need. Never load `workspace_ops` + `terminal_ops` together unless you will use BOTH in this task (e.g. edit files AND run tests). File-only work → `workspace_ops` only. Questions about capabilities → nothing.
- Loading tools you do not use wastes context, confuses the user, and is wrong. When in doubt, do not load — ask a short clarifying question in chat instead.

You start with only `load_tool_context` callable. The categories below exist in the system but are NOT callable until you load them. Calling an unloaded category returns `tool_not_loaded`.

Categories you can load (via `load_tool_context` only):
- workspace_ops — anything file-related: read, search, list, create, edit, rename, delete. Never write source files via the terminal.
- terminal_ops — shell commands, builds, tests, lint, git, installs, and diagnostics. Use user_visible:false for background commands; user_visible:true only when the user must watch a dev server.
- plan_tool — present an implementation plan and wait for user approval before invasive or multi-step code changes. Requires workspace_ops in the same load (you must write plan.md before calling plan_tool).
- todo_tool — drive the persistent execution checklist widget. Load when execution starts — after plan approval, or for any 3+ step task without a formal plan.
- web_search — look up external docs, APIs, errors, or version-specific facts not in the repo.
- spawn_subagent — when the user asks for subagents, or for parallel/isolated deliverables (including writing plan docs named in the prompt). Not for routine one-file edits or shell work.
- hil_tool — structured multiple-choice questions via a persistent inline card; blocks until the user answers. Load when you need structured user input during execution or deep-plan work — not for meta/capability questions (answer those in chat).

Which tool for which job (load its category first):
- Files: create / edit / rename / delete / search / read → workspace_ops
- Shell: npm / pip / build / test / lint / git / diagnostics → terminal_ops
- Dev server the user watches in the panel → terminal_ops with user_visible:true
- Big change needing approval → plan_tool (+ workspace_ops to write plan.md) — **not** when `/deep-plan` or `deep_plan_tool` is already available (use deep plan instead)
- Track multi-step execution → todo_tool
- Answer not in the repo → web_search
- User asked for subagents, or parallel/isolated deliverables → spawn_subagent (then call it; do not only narrate)
- Structured user choice during execution / deep-plan → hil_tool (load first; not for "what tools exist?")

DEEP PLANNING: Rare. `/deep-plan` or arch-shift HIL yes opens the deep plan gate — req-extraction + `deep_plan_tool` schema injected by backend (not via `load_tool_context`). **First:** extract requirements to `plan_pipeline/`; **then** call `deep_plan_tool(start)`. Do not load `plan_tool` for that path.

Typical loads (include only categories this task will use — no extras):
- Read or edit files only → ["workspace_ops"] — do not load terminal_ops for file-only work
- Run tests or builds → ["workspace_ops", "terminal_ops"]
- Invasive or multi-step change → ["workspace_ops", "plan_tool"] — **skip if `deep_plan_tool` is in tools[]** (gate open)
- External library or API question → ["web_search"], often plus ["workspace_ops"] to apply findings in code

Do not guess unloaded tool schemas. Use only loaded schemas and the guidance injected after load.

Rules you always follow:
- Engineering Standards come first; apply them while executing, not only when planning.
- Reason step-by-step before acting. If the user did not ask you to touch the repo or run commands, your first response must be chat-only — no `load_tool_context`, no tool calls.
- Once todo_tool is active, do not paste the full checklist into normal assistant prose; update the persistent widget with todo_tool and keep the conversational response focused on findings, requests, or results.
- Be direct and precise — no filler, no padding
- Reference specific line numbers and function names when discussing code
- Prefer the smallest correct change over a large diff that merely looks finished
- You are accountable for what your actions destroy; verify and compare before you "fix."
- NEVER return an empty or silent response
- devotedly follow the correct tool related rules so tools can be executed do not hallucinate tool schemas and tool rules
"""
def _build_system_prompt(
    workspace_skeleton: str | None = None,
    active_tool_guidance: str | None = None,
) -> str:
    """Build system prompt, injecting workspace context and any loaded tool guidance."""
    parts = [ENGINEERING_STANDARDS_PERSONA, DEVELOPER_ASSISTANT_PERSONA]

    if active_tool_guidance:
        parts.append(active_tool_guidance)

    if not workspace_skeleton:
        return "\n\n".join(parts)

    workspace_block = (
        "Workspace Root: provided by extension host\n\n"
        "Project Structure:\n"
        f"{workspace_skeleton}\n"
        "[collapsed] folders exist but are intentionally not expanded."
    )
    parts.append(workspace_block)
    return "\n\n".join(parts)


# Connect/read timeouts so a hung provider cannot freeze the agent loop forever.
_LLM_REQUEST_TIMEOUT_SECONDS = 180.0
# If no stream chunk arrives for this long, abort the round.
_LLM_STREAM_IDLE_TIMEOUT_SECONDS = 120.0


def _get_client(base_url: str, api_key: str) -> AsyncOpenAI:
    normalized_base_url = _normalize_base_url(base_url)
    return AsyncOpenAI(
        base_url=normalized_base_url,
        api_key=api_key,
        max_retries=2,
        timeout=_LLM_REQUEST_TIMEOUT_SECONDS,
    )


def _normalize_base_url(base_url: str) -> str:
    normalized_base_url = base_url.strip().rstrip("/")

    if not normalized_base_url:
        raise ValueError("LLM base URL is empty or unconfigured")

    chat_completions_suffix = "/chat/completions"
    if normalized_base_url.endswith(chat_completions_suffix):
        normalized_base_url = normalized_base_url[: -len(chat_completions_suffix)]

    return normalized_base_url.rstrip("/")


def _model_name(config: WorkerConfig, model: str | None = None) -> str:
    return model or config.llm_model


def _normalize_reasoning_effort(effort: str) -> str:
    """Map config effort values to DeepSeek's reasoning_effort parameter.

    DeepSeek accepts ``high`` and ``max`` natively; ``low``/``medium`` are
    accepted for compatibility and mapped server-side to ``high``.
    """
    normalized = effort.strip().lower()
    if normalized in {"max", "xhigh"}:
        return "max"
    if normalized in {"low", "medium", "high"}:
        return normalized
    return "medium"


def _should_enable_thinking(config: WorkerConfig, model: str | None = None) -> bool:
    if config.llm_reasoning_enabled:
        return True

    model_name = _model_name(config, model).lower()
    base_url = config.llm_base_url.lower()
    return "deepseek" in base_url and (
        model_name.startswith("deepseek-v4")
        or model_name == "deepseek-reasoner"
    )


def _build_request_payload(
    messages: List[Dict[str, Any]],
    config: WorkerConfig,
    workspace_skeleton: str | None = None,
    model: str | None = None,
    active_tool_guidance: str | None = None,
    active_categories: list[str] | None = None,
    *,
    deep_plan_available: bool = False,
    deep_plan_pipeline_mode: bool = False,
) -> Dict[str, Any]:
    guidance_parts: list[str] = []
    if active_tool_guidance:
        guidance_parts.append(active_tool_guidance)
    if deep_plan_available and not deep_plan_pipeline_mode:
        from app.services.prompt_loader import load_deep_plan_gate_guidance

        deep_guidance = load_deep_plan_gate_guidance()
        if deep_guidance:
            guidance_parts.append(deep_guidance)
    combined_guidance = "\n\n---\n\n".join(guidance_parts) if guidance_parts else None

    full_messages: list[Any] = [
        {
            "role": "system",
            "content": _build_system_prompt(workspace_skeleton, combined_guidance),
        },
        *messages,
    ]

    payload: Dict[str, Any] = {
        "model": _model_name(config, model),
        "messages": full_messages,
        "stream": True,
        "tools": build_tools_list(
            active_categories,
            deep_plan_available=deep_plan_available,
            deep_plan_pipeline_mode=deep_plan_pipeline_mode,
        ),
        "tool_choice": "auto",
    }

    if _should_enable_thinking(config, model):
        payload["reasoning_effort"] = _normalize_reasoning_effort(config.llm_reasoning_effort)
        payload["extra_body"] = {
            "thinking": {
                "type": "enabled",
            }
        }

    return payload


def _delta_attr(delta: Any, attr_name: str) -> Any:
    if isinstance(delta, dict):
        return delta.get(attr_name)
    return getattr(delta, attr_name, None)


def _tool_attr(value: Any, attr_name: str) -> Any:
    if isinstance(value, dict):
        return value.get(attr_name)
    return getattr(value, attr_name, None)


def _extract_text_fragments(delta: Any) -> List[str]:
    text_fragments: List[str] = []
    content = _delta_attr(delta, "content")

    if isinstance(content, str):
        return [content]

    if isinstance(content, list):
        for part in content:
            text = getattr(part, "text", None)
            if isinstance(text, str) and text:
                text_fragments.append(text)
                continue

            if isinstance(part, dict):
                part_text = part.get("text")
                if isinstance(part_text, str) and part_text:
                    text_fragments.append(part_text)

    fallback_text = _delta_attr(delta, "text")
    if isinstance(fallback_text, str) and fallback_text:
        text_fragments.append(fallback_text)

    return text_fragments


def _extract_reasoning_fragments(delta: Any) -> List[str]:
    reasoning_fragments: List[str] = []

    for attr_name in ("reasoning", "reasoning_content", "reasoning_text", "thinking"):
        value = _delta_attr(delta, attr_name)

        if isinstance(value, str) and value:
            reasoning_fragments.append(value)
            continue

        if isinstance(value, list):
            for part in value:
                text = getattr(part, "text", None)
                if isinstance(text, str) and text:
                    reasoning_fragments.append(text)
                    continue

                if isinstance(part, dict):
                    part_text = part.get("text")
                    if isinstance(part_text, str) and part_text:
                        reasoning_fragments.append(part_text)

    if not reasoning_fragments:
        reasoning_details = _delta_attr(delta, "reasoning_details")
        if isinstance(reasoning_details, list):
            for item in reasoning_details:
                if not isinstance(item, dict):
                    continue
                for summary in item.get("summary", []):
                    if isinstance(summary, str) and summary:
                        reasoning_fragments.append(summary)

    return reasoning_fragments


def _extract_tool_call_fragments(delta: Any) -> List[Dict[str, Any]]:
    tool_call_fragments: List[Dict[str, Any]] = []
    tool_calls = _delta_attr(delta, "tool_calls")

    if not isinstance(tool_calls, list):
        return tool_call_fragments

    for tool_call in tool_calls:
        function_call = _tool_attr(tool_call, "function")
        tool_call_fragments.append(
            {
                "index": _tool_attr(tool_call, "index"),
                "tool_call_id": _tool_attr(tool_call, "id"),
                "tool_name": _tool_attr(function_call, "name"),
                "arguments": _tool_attr(function_call, "arguments"),
            }
        )

    return tool_call_fragments


def _merge_tool_call_fragment(
    pending_tool_calls: Dict[int, Dict[str, Any]],
    fragment: Dict[str, Any],
) -> None:
    fragment_index = fragment.get("index")
    tool_call_index = fragment_index if isinstance(fragment_index, int) else 0

    pending_tool_call = pending_tool_calls.setdefault(
        tool_call_index,
        {
            "tool_call_id": "",
            "tool_name": "",
            "arguments": "",
        },
    )

    tool_call_id = fragment.get("tool_call_id")
    if isinstance(tool_call_id, str) and tool_call_id:
        pending_tool_call["tool_call_id"] = tool_call_id

    tool_name = fragment.get("tool_name")
    if isinstance(tool_name, str) and tool_name:
        pending_tool_call["tool_name"] = tool_name

    arguments = fragment.get("arguments")
    if isinstance(arguments, str) and arguments:
        pending_tool_call["arguments"] += arguments


def _finalize_pending_tool_calls(
    pending_tool_calls: Dict[int, Dict[str, Any]],
) -> List[Dict[str, Any]]:
    tool_call_events: List[Dict[str, Any]] = []

    for tool_call_index in sorted(pending_tool_calls):
        pending_tool_call = pending_tool_calls[tool_call_index]
        tool_name = pending_tool_call.get("tool_name")
        if not isinstance(tool_name, str) or not tool_name:
            continue

        tool_call_id = pending_tool_call.get("tool_call_id")
        if not isinstance(tool_call_id, str) or not tool_call_id:
            tool_call_id = f"tc_{uuid4().hex[:12]}"

        arguments_text = str(pending_tool_call.get("arguments", "")).strip()
        try:
            arguments = json.loads(arguments_text) if arguments_text else {}
        except json.JSONDecodeError:
            logger.warning("Yielding malformed structured tool call arguments to agent: %s", arguments_text)
            tool_call_events.append(
                {
                    "type": "tool_call",
                    "tool_call_id": tool_call_id,
                    "tool_name": tool_name,
                    "args": {"__schema_error__": "JSONDecodeError: Malformed JSON arguments", "raw_text": arguments_text},
                }
            )
            continue

        if not isinstance(arguments, dict):
            arguments = {}

        tool_call_events.append(
            {
                "type": "tool_call",
                "tool_call_id": tool_call_id,
                "tool_name": tool_name,
                "args": arguments,
            }
        )

    return tool_call_events


async def stream_chat_completion(
    messages: List[Dict[str, Any]],
    config: WorkerConfig,
    workspace_skeleton: str | None = None,
) -> AsyncIterator[str]:
    """
    Stream a chat completion via an OpenAI-compatible API.

    Args:
        messages: List of {"role": "user"|"assistant", "content": "..."} dicts
                  in chronological order.

    Yields:
        Token chunks (str) as they stream from the model.
    """
    api_key = config.llm_key
    
    client = _get_client(base_url=config.llm_base_url, api_key=api_key)
    stream = await client.chat.completions.create(
        **_build_request_payload(messages, config, workspace_skeleton)
    )

    async for chunk in stream:
        if not chunk.choices:
            logger.debug("Skipping streamed chunk without choices: %s", chunk)
            continue

        delta = chunk.choices[0].delta
        if not delta:
            continue

        for text in _extract_text_fragments(delta):
            yield text


async def stream_chat_events(
    messages: List[Dict[str, Any]],
    config: WorkerConfig,
    workspace_skeleton: str | None = None,
    model: str | None = None,
    context_log_metadata: Dict[str, Any] | None = None,
    active_tool_guidance: str | None = None,
    active_categories: list[str] | None = None,
    *,
    deep_plan_available: bool = False,
    deep_plan_pipeline_mode: bool = False,
) -> AsyncIterator[Dict[str, Any]]:
    """
    Stream model output as structured events.

    The model is expected to emit structured tool calls through the OpenAI-style
    tool_calls channel when workspace_ops is needed.

    Args:
        messages: Chat messages list
        workspace_skeleton: Optional workspace context
        model: Optional model override (defaults to config.llm_model)

    Yields event dicts with:
      - {"type": "token", "content": "..."}
      - {"type": "thinking", "content": "..."}
      - {"type": "tool_call", "tool_call_id": "...", "tool_name": "...", "args": {...}}
    """
    api_key = config.llm_key
    
    rate_limiter = _get_rate_limiter(api_key)
    client = _get_client(base_url=config.llm_base_url, api_key=api_key)
    logger.info("Using LLM key from config")
    
    payload = _build_request_payload(
        messages,
        config,
        workspace_skeleton,
        model,
        active_tool_guidance,
        active_categories,
        deep_plan_available=deep_plan_available,
        deep_plan_pipeline_mode=deep_plan_pipeline_mode,
    )
    _log_llm_context_snapshot(payload, context_log_metadata)
    
    # Log request details for debugging
    logger.info(
        "Initiating LLM stream: model=%s messages_count=%s has_tools=%s reasoning_effort=%s thinking_enabled=%s",
        payload.get("model"),
        len(payload.get("messages", [])),
        bool(payload.get("tools")),
        payload.get("reasoning_effort"),
        bool(payload.get("extra_body", {}).get("thinking", {}).get("type") == "enabled"),
    )
    
    # Log message roles to debug the conversation structure
    msg_roles = [m.get("role") for m in payload.get("messages", [])]
    logger.debug(
        "Message structure: roles=%s system_prompt_len=%s",
        msg_roles,
        len(payload.get("messages", [{}])[0].get("content", "")) if payload.get("messages") else 0,
    )
    
    try:
        async with rate_limiter:
            last_call_time = _last_call_times.get(api_key, 0.0)
            elapsed = time.monotonic() - last_call_time
            if elapsed < _rate_limit_seconds:
                wait_time = _rate_limit_seconds - elapsed
                logger.info("🔄 %s-second rate limit delay started (waiting %.1f seconds)", _rate_limit_seconds, wait_time)
                await asyncio.sleep(wait_time)
                logger.info("✅ %s-second rate limit delay finished, proceeding with LLM call", _rate_limit_seconds)
            stream = await client.chat.completions.create(**payload)
            _last_call_times[api_key] = time.monotonic()
        logger.debug("LLM stream established successfully")
    except Exception as stream_init_exc:
        logger.error(
            "Failed to initiate LLM stream: %s",
            str(stream_init_exc),
            exc_info=True,
        )
        raise
    
    pending_tool_calls: Dict[int, Dict[str, Any]] = {}
    saw_structured_tool_call = False
    chunk_count = 0
    text_fragment_count = 0
    thinking_fragment_count = 0
    tool_call_fragment_count = 0
    total_text_chars = 0
    stream_started_at = time.monotonic()

    async def _next_chunk_with_idle_timeout():
        return await asyncio.wait_for(
            stream.__anext__(),
            timeout=_LLM_STREAM_IDLE_TIMEOUT_SECONDS,
        )

    try:
        while True:
            try:
                chunk = await _next_chunk_with_idle_timeout()
            except StopAsyncIteration:
                break
            except asyncio.TimeoutError as idle_exc:
                logger.error(
                    "LLM stream idle timeout after %ss with no chunks (received %d chunks so far)",
                    _LLM_STREAM_IDLE_TIMEOUT_SECONDS,
                    chunk_count,
                )
                raise TimeoutError(
                    f"LLM stream stalled: no data for {_LLM_STREAM_IDLE_TIMEOUT_SECONDS:.0f}s"
                ) from idle_exc

            chunk_count += 1
            if not chunk.choices:
                logger.debug("Skipping streamed chunk without choices: %s", chunk)
                continue

            delta = chunk.choices[0].delta
            if not delta:
                continue

            reasoning_fragments = _extract_reasoning_fragments(delta)
            if reasoning_fragments:
                logger.info(
                    "LLM stream chunk #%d reasoning_fragments=%d reasoning_chars=%d",
                    chunk_count,
                    len(reasoning_fragments),
                    sum(len(fragment) for fragment in reasoning_fragments),
                )

            for reasoning_text in reasoning_fragments:
                if reasoning_text.strip():
                    thinking_fragment_count += 1
                    yield {"type": "thinking", "content": reasoning_text}

            tool_call_fragments = _extract_tool_call_fragments(delta)
            if tool_call_fragments:
                saw_structured_tool_call = True
                tool_call_fragment_count += len(tool_call_fragments)
                logger.info(
                    "LLM stream chunk #%d tool_call_fragments=%d",
                    chunk_count,
                    len(tool_call_fragments),
                )
                for fragment in tool_call_fragments:
                    _merge_tool_call_fragment(pending_tool_calls, fragment)
                continue

            if saw_structured_tool_call:
                continue

            text_fragments = _extract_text_fragments(delta)
            if text_fragments:
                for fragment in text_fragments:
                    total_text_chars += len(fragment)
                    text_fragment_count += 1
                    yield {"type": "token", "content": fragment}
    except asyncio.CancelledError:
        logger.info("LLM stream cancelled after %d chunks", chunk_count)
        raise
    except Exception as stream_exc:
        logger.error(
            "LLM stream iteration failed after %d chunks: %s",
            chunk_count,
            str(stream_exc),
            exc_info=True,
        )
        raise
    finally:
        close = getattr(stream, "close", None)
        if callable(close):
            try:
                result = close()
                if asyncio.iscoroutine(result):
                    await result
            except Exception:
                pass

    logger.info(
        "LLM stream summary chunks=%d text_fragments=%d thinking_fragments=%d tool_call_fragments=%d total_text_chars=%d elapsed_seconds=%.3f saw_structured_tool_call=%s",
        chunk_count,
        text_fragment_count,
        thinking_fragment_count,
        tool_call_fragment_count,
        total_text_chars,
        time.monotonic() - stream_started_at,
        saw_structured_tool_call,
    )

    if saw_structured_tool_call:
        for event in _finalize_pending_tool_calls(pending_tool_calls):
            yield event
        return
