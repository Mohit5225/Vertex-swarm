"""Chat endpoints - create chats, send messages with LLM streaming, load history."""
import json
import logging
from datetime import datetime, timezone
from typing import Any, Optional
from uuid import UUID, uuid4

from fastapi import APIRouter, Depends, HTTPException, status
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
from sqlalchemy import desc, select
from openai import RateLimitError, APIError

from app.auth.dependencies import AuthenticatedUser, get_current_user
from app.core.config import settings
from app.db.postgres.connection import AsyncSessionLocal
from app.db.postgres.models import ChatORM, MessageORM
from app.db.redis_db import get_redis, retrieve_session_state, store_session_state, tool_result_stream_key
from app.db.redis_sessions import bootstrap_chat_session, build_chat_session_id
from app.schemas.tool import ToolResultSchema
from app.services.llm_service import stream_chat_events, format_tool_response
from app.services.tool_memory import build_tool_memory_from_trace_events, format_tool_memory_for_prompt
from app.services.prompt_loader import build_injected_guidance, load_categories, SUPPORTED_CATEGORIES

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/v1/chats", tags=["chats"])


class CreateChatRequest(BaseModel):
    title: Optional[str] = None
    ide_context_enabled: bool = False


class SendMessageRequest(BaseModel):
    content: str
    workspace_skeleton: Optional[str] = None
    ide_context_enabled: Optional[bool] = None
    request_context: Optional[dict[str, Any]] = None


class UpdateIdeContextRequest(BaseModel):
    enabled: bool


async def _wait_for_tool_result(
    session_id: str,
    chat_id: str,
    message_id: str,
    tool_call_id: str,
    timeout_seconds: int = 360,
) -> ToolResultSchema | None:
    stream_key = tool_result_stream_key(session_id, chat_id, message_id, tool_call_id)
    redis_client = await get_redis()
    stream_entries = await redis_client.xread(
        {stream_key: "0-0"},
        count=1,
        block=timeout_seconds * 1000,
    )

    if not stream_entries:
        return None

    _, entries = stream_entries[0]
    if not entries:
        return None

    _, payload = entries[0]
    if not isinstance(payload, dict):
        return None

    payload_json = payload.get("payload")
    if not isinstance(payload_json, str):
        return None

    tool_result = ToolResultSchema.model_validate_json(payload_json)
    await redis_client.delete(stream_key)
    return tool_result


def _event_timestamp_ms() -> int:
    return int(datetime.now(timezone.utc).timestamp() * 1000)


def _build_event(
    event_type: str,
    *,
    content: str | None = None,
    metadata: dict[str, Any] | None = None,
    **extra: Any,
) -> dict[str, Any]:
    event: dict[str, Any] = {
        "id": f"evt-{uuid4().hex[:12]}",
        "type": event_type,
        "timestamp": _event_timestamp_ms(),
    }
    if content is not None:
        event["content"] = content
    if metadata:
        event["metadata"] = metadata
    event.update(extra)
    return event


def _serialize_sse(event: dict[str, Any]) -> str:
    return f"data: {json.dumps(event)}\n\n"


def _preview(value: str, limit: int = 180) -> str:
    normalized = " ".join(value.split())
    if len(normalized) <= limit:
        return normalized
    return f"{normalized[: limit - 3]}..."


def _assistant_tool_call_message(
    assistant_turn_content: str,
    tool_name: str,
    tool_call_id: str,
    tool_args: dict[str, Any],
) -> dict[str, Any]:
    tool_call_arguments = json.dumps(tool_args, separators=(",", ":"), sort_keys=True)
    assistant_message: dict[str, Any] = {
        "role": "assistant",
        "content": assistant_turn_content,
        "tool_calls": [
            {
                "id": tool_call_id,
                "type": "function",
                "function": {
                    "name": tool_name,
                    "arguments": tool_call_arguments,
                },
            }
        ],
    }
    if not assistant_turn_content:
        assistant_message["content"] = None
    return assistant_message


def _build_request_context_message(request_context: dict[str, Any] | None) -> str | None:
    if not request_context:
        return None

    lines: list[str] = ["VS Code request context:"]

    active_file = request_context.get("activeFile")
    if isinstance(active_file, dict):
        file_path = active_file.get("path")
        if isinstance(file_path, str) and file_path:
            lines.append(f"Active file: {file_path}")

        language_id = active_file.get("languageId")
        if isinstance(language_id, str) and language_id:
            lines.append(f"Language: {language_id}")

        selection = active_file.get("selection")
        if isinstance(selection, dict):
            selection_text = selection.get("text")
            if isinstance(selection_text, str) and selection_text.strip():
                lines.append("Selection:")
                lines.append(_preview(selection_text, 500))

    active_terminal = request_context.get("activeTerminal")
    if isinstance(active_terminal, dict):
        terminal_name = active_terminal.get("name")
        if isinstance(terminal_name, str) and terminal_name:
            lines.append(f"Active terminal: {terminal_name}")

        shell = active_terminal.get("shell")
        if isinstance(shell, str) and shell:
            lines.append(f"Terminal shell: {shell}")

        cwd = active_terminal.get("cwd")
        if isinstance(cwd, str) and cwd:
            lines.append(f"Terminal CWD: {cwd}")

        process_id = active_terminal.get("processId")
        if isinstance(process_id, int):
            lines.append(f"Terminal process id: {process_id}")

    os_platform = request_context.get("os")
    if isinstance(os_platform, str) and os_platform:
        lines.append(f"Operating System: {os_platform}")

    workspace_folders = request_context.get("workspaceFolders")
    if isinstance(workspace_folders, list):
        folder_names = [folder for folder in workspace_folders if isinstance(folder, str) and folder]
        if folder_names:
            lines.append("Workspace folders:")
            lines.extend(f"- {folder}" for folder in folder_names[:10])

    if len(lines) == 1:
        return None

    return "\n".join(lines)


def _log_trace_event(
    user_id: str | None,
    chat_id: UUID,
    session_id: str,
    message_id: str,
    event: dict[str, Any],
) -> None:
    safe_user_id = user_id or "unknown"
    event_type = str(event.get("type", "unknown"))
    content = str(event.get("content", ""))

    if event_type == "thinking":
        logger.info(
            "thinking trace user_id=%s chat_id=%s session_id=%s message_id=%s preview=%s",
            safe_user_id,
            chat_id,
            session_id,
            message_id,
            _preview(content),
        )
        return

    if event_type == "status":
        logger.info(
            "status update user_id=%s chat_id=%s session_id=%s message_id=%s status=%s",
            safe_user_id,
            chat_id,
            session_id,
            message_id,
            _preview(content),
        )
        return

    if event_type == "tool_call":
        logger.info(
            "tool requested user_id=%s chat_id=%s session_id=%s message_id=%s tool_call_id=%s tool_name=%s args=%s",
            safe_user_id,
            chat_id,
            session_id,
            message_id,
            event.get("tool_call_id"),
            event.get("tool_name"),
            json.dumps(event.get("args", {}), sort_keys=True),
        )
        return

    if event_type == "tool_result":
        logger.info(
            "tool result received user_id=%s chat_id=%s session_id=%s message_id=%s tool_call_id=%s tool_name=%s status=%s execution_time_ms=%s",
            safe_user_id,
            chat_id,
            session_id,
            message_id,
            event.get("tool_call_id"),
            event.get("tool_name"),
            event.get("status"),
            event.get("execution_time_ms"),
        )
        return

    if event_type == "error":
        logger.error(
            "stream error event user_id=%s chat_id=%s session_id=%s message_id=%s error=%s",
            safe_user_id,
            chat_id,
            session_id,
            message_id,
            _preview(content),
        )


@router.post("", status_code=status.HTTP_201_CREATED)
async def create_chat(
    req: CreateChatRequest,
    user: AuthenticatedUser = Depends(get_current_user),
):
    async with AsyncSessionLocal() as db:
        chat = ChatORM(
            user_id=user.user_id,
            title=req.title,
            ide_context_enabled=req.ide_context_enabled,
        )
        db.add(chat)
        await db.commit()
        await db.refresh(chat)

    return {
        "chatId": str(chat.chat_id),
        "title": chat.title,
        "ideContextEnabled": chat.ide_context_enabled,
        "createdAt": chat.created_at.isoformat(),
        "updatedAt": chat.updated_at.isoformat(),
    }


@router.get("")
async def list_chats(user: AuthenticatedUser = Depends(get_current_user)):
    async with AsyncSessionLocal() as db:
        result = await db.execute(
            select(ChatORM)
            .where(ChatORM.user_id == user.user_id)
            .order_by(desc(ChatORM.updated_at))
        )
        chats = result.scalars().all()

    return [
        {
            "chatId": str(c.chat_id),
            "title": c.title,
            "ideContextEnabled": c.ide_context_enabled,
            "createdAt": c.created_at.isoformat(),
            "updatedAt": c.updated_at.isoformat(),
        }
        for c in chats
    ]


@router.post("/{chat_id}/messages", response_class=StreamingResponse)
async def send_message(
    chat_id: UUID,
    req: SendMessageRequest,
    user: AuthenticatedUser = Depends(get_current_user),
):
    async with AsyncSessionLocal() as db:
        chat_result = await db.execute(
            select(ChatORM).where(
                ChatORM.chat_id == chat_id,
                ChatORM.user_id == user.user_id,
            )
        )
        chat = chat_result.scalar_one_or_none()

    if not chat:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Chat not found")

    synthetic_session_id = build_chat_session_id(chat_id)

    await bootstrap_chat_session(
        synthetic_session_id,
        user.user_id,
        chat_id,
        req.content,
    )

    session_state = await retrieve_session_state(synthetic_session_id)
    existing_tool_memory = None
    existing_active_categories: list[str] = []
    if session_state is not None:
        existing_tool_memory = session_state.persisted.working_memory.get("tool_memory")
        raw_cats = session_state.persisted.working_memory.get("active_tool_categories", [])
        if isinstance(raw_cats, list):
            existing_active_categories = [c for c in raw_cats if isinstance(c, str)]

    logger.info(
        "message received user_id=%s chat_id=%s session_id=%s ide_context_enabled=%s",
        user.user_id,
        chat_id,
        synthetic_session_id,
        req.ide_context_enabled,
    )

    async def event_stream():
        nonlocal existing_active_categories
        async with AsyncSessionLocal() as db:
            logger.info(
                "persisting user message user_id=%s chat_id=%s session_id=%s",
                user.user_id,
                chat_id,
                synthetic_session_id,
            )
            user_msg = MessageORM(
                chat_id=chat_id,
                role="user",
                content=req.content,
            )
            db.add(user_msg)

            chat_row = await db.get(ChatORM, chat_id)
            if chat_row:
                if req.ide_context_enabled is not None:
                    chat_row.ide_context_enabled = req.ide_context_enabled
                    logger.info(
                        "ide_context toggle loaded chat_id=%s enabled=%s",
                        chat_id,
                        req.ide_context_enabled,
                    )

                if not chat_row.title:
                    normalized_title = " ".join(req.content.split())
                    chat_row.title = normalized_title[:80] if normalized_title else "Untitled chat"

            await db.commit()
            await db.refresh(user_msg)
            request_message_id = str(user_msg.message_id)

            history_result = await db.execute(
                select(MessageORM)
                .where(MessageORM.chat_id == chat_id)
                .order_by(MessageORM.created_at)
            )
            history = history_result.scalars().all()

        llm_messages = [{"role": m.role, "content": m.content} for m in history]
        request_context_message = _build_request_context_message(req.request_context)
        tool_memory_message = format_tool_memory_for_prompt(existing_tool_memory)

        # Build guidance from already-loaded categories for this session
        active_tool_guidance: str | None = build_injected_guidance(existing_active_categories) or None

        system_context_messages: list[dict[str, str]] = []
        if request_context_message:
            system_context_messages.append({"role": "system", "content": request_context_message})
        if tool_memory_message:
            system_context_messages.append({"role": "system", "content": tool_memory_message})

        if system_context_messages:
            llm_messages = [
                *system_context_messages,
                *llm_messages,
            ]

        if tool_memory_message:
            mutation_count = len(existing_tool_memory.get("completed_mutations", [])) if isinstance(existing_tool_memory, dict) else 0
            logger.info(
                "tool memory injected user_id=%s chat_id=%s session_id=%s message_id=%s mutation_count=%s",
                user.user_id,
                chat_id,
                synthetic_session_id,
                request_message_id,
                mutation_count,
            )

        logger.info(
            "context loaded chat_id=%s message_id=%s history_messages=%s",
            chat_id,
            request_message_id,
            len(llm_messages),
        )

        full_response = ""
        trace_events: list[dict[str, Any]] = []
        run_failed = False
        llm_round = 0

        def emit_trace(event: dict[str, Any]) -> str:
            trace_events.append(event)
            _log_trace_event(
                user.user_id,
                chat_id,
                synthetic_session_id,
                request_message_id,
                event,
            )
            return _serialize_sse(event)

        def build_status_event(content: str, phase: str) -> dict[str, Any]:
            return _build_event(
                "status",
                content=content,
                metadata={"phase": phase},
                session_id=synthetic_session_id,
                chat_id=str(chat_id),
                message_id=request_message_id,
            )

        try:
            yield emit_trace(build_status_event("Preparing conversation context...", "preparing_context"))

            while True:
                llm_round += 1
                assistant_turn_content = ""
                tool_call_requested = False
                stream_aborted = False

                status_text = (
                    f"Calling model {settings.llm_model}..."
                    if llm_round == 1
                    else "Continuing with tool result..."
                )
                status_phase = "calling_model" if llm_round == 1 else "resuming_after_tool"
                yield emit_trace(build_status_event(status_text, status_phase))

                llm_context_log_base = {
                    "user_id": user.user_id,
                    "chat_id": str(chat_id),
                    "session_id": synthetic_session_id,
                    "message_id": request_message_id,
                    "llm_round": llm_round,
                    "ide_context_enabled": req.ide_context_enabled,
                    "workspace_skeleton_included": bool(req.workspace_skeleton),
                    "workspace_skeleton_len": len(req.workspace_skeleton) if req.workspace_skeleton else 0,
                    "request_context_included": bool(req.request_context),
                    "llm_message_count": len(llm_messages),
                    "last_message_role": llm_messages[-1].get("role") if llm_messages else None,
                }

                # Try primary model, fallback to secondary on rate limit
                try:
                    stream_iterator = stream_chat_events(
                        llm_messages,
                        workspace_skeleton=req.workspace_skeleton,
                        context_log_metadata={
                            **llm_context_log_base,
                            "model": settings.llm_model,
                            "is_fallback": False,
                        },
                        active_tool_guidance=active_tool_guidance,
                    )
                except RateLimitError:
                    logger.warning(
                        "Primary model rate-limited, switching to fallback user_id=%s chat_id=%s session_id=%s message_id=%s primary=%s fallback=%s",
                        user.user_id,
                        chat_id,
                        synthetic_session_id,
                        request_message_id,
                        settings.llm_model,
                        settings.llm_fallback_model,
                    )
                    yield emit_trace(
                        build_status_event(
                            f"Primary model rate-limited, switching to fallback...",
                            "fallback_model",
                        )
                    )
                    stream_iterator = stream_chat_events(
                        llm_messages,
                        workspace_skeleton=req.workspace_skeleton,
                        model=settings.llm_fallback_model,
                        context_log_metadata={
                            **llm_context_log_base,
                            "model": settings.llm_fallback_model,
                            "is_fallback": True,
                        },
                        active_tool_guidance=active_tool_guidance,
                    )

                async for event in stream_iterator:
                    event_type = event.get("type")

                    if event_type == "token":
                        token = str(event.get("content", ""))
                        if not token:
                            continue

                        assistant_turn_content += token
                        full_response += token
                        yield _serialize_sse(
                            _build_event(
                                "token",
                                content=token,
                                metadata={"phase": "assistant_output"},
                            )
                        )
                        continue

                    if event_type == "thinking":
                        thinking_content = str(event.get("content", ""))
                        if not thinking_content.strip():
                            continue

                        yield emit_trace(
                            _build_event(
                                "thinking",
                                content=thinking_content,
                                metadata={"phase": "reasoning"},
                                session_id=synthetic_session_id,
                                chat_id=str(chat_id),
                                message_id=request_message_id,
                            )
                        )
                        continue

                    if event_type == "tool_call":
                        tool_name = event.get("tool_name")
                        tool_call_id = event.get("tool_call_id")
                        tool_args = event.get("args")

                        if not isinstance(tool_name, str) or not isinstance(tool_call_id, str):
                            logger.warning("Skipping malformed tool_call event: %s", event)
                            continue

                        if not isinstance(tool_args, dict):
                            tool_args = {}

                        # ── load_tool_context interception ──────────────────────────
                        # This tool is handled entirely on the backend.
                        # No round-trip to the extension needed.
                        if tool_name == "load_tool_context":
                            requested = tool_args.get("categories", [])
                            if not isinstance(requested, list):
                                requested = []
                            valid = [c for c in requested if c in SUPPORTED_CATEGORIES]

                            # Load and persist new categories into session
                            loaded_prose = load_categories(valid)
                            newly_loaded = list(loaded_prose.keys())

                            # Merge with already-active categories
                            merged = list(dict.fromkeys(existing_active_categories + newly_loaded))
                            existing_active_categories = merged
                            active_tool_guidance = build_injected_guidance(merged) or None

                            # Persist to Redis immediately so next turn auto-injects
                            try:
                                latest_state = await retrieve_session_state(synthetic_session_id)
                                if latest_state is not None:
                                    latest_state.persisted.working_memory["active_tool_categories"] = merged
                                    await store_session_state(synthetic_session_id, latest_state)
                            except Exception:
                                logger.exception("Failed to persist active_tool_categories session_id=%s", synthetic_session_id)

                            # Emit ephemeral UI notification
                            if newly_loaded:
                                label = ", ".join(c.replace("_", " ").title() for c in newly_loaded)
                                yield emit_trace(
                                    build_status_event(
                                        f"Loaded {label} guidance",
                                        "tool_context_loaded",
                                    )
                                )

                            # Build a combined prose result to give to the LLM
                            combined_prose = "\n\n---\n\n".join(loaded_prose.values())
                            result_content = (
                                f"Tool guidance loaded for: {', '.join(newly_loaded)}.\n\n{combined_prose}"
                                if newly_loaded
                                else f"No new categories loaded. Already active: {', '.join(existing_active_categories) or 'none'}."
                            )

                            llm_messages.append(
                                _assistant_tool_call_message(
                                    assistant_turn_content,
                                    tool_name,
                                    tool_call_id,
                                    tool_args,
                                )
                            )
                            llm_messages.append(
                                {
                                    "role": "tool",
                                    "tool_call_id": tool_call_id,
                                    "content": format_tool_response(
                                         tool_status="success",
                                         tool_content=result_content,
                                     ),
                                }
                            )
                            tool_call_requested = True
                            break
                        # ── end load_tool_context ───────────────────────────────────

                        tool_event = _build_event(
                            "tool_call",
                            metadata={"phase": "tool_requested"},
                            tool_call_id=tool_call_id,
                            tool_name=tool_name,
                            args=tool_args,
                            session_id=synthetic_session_id,
                            chat_id=str(chat_id),
                            message_id=request_message_id,
                        )
                        yield emit_trace(tool_event)

                        yield emit_trace(
                            build_status_event(
                                f"Waiting for {tool_name} result from the extension...",
                                "awaiting_tool_result",
                            )
                        )

                        tool_result = await _wait_for_tool_result(
                            synthetic_session_id,
                            str(chat_id),
                            request_message_id,
                            tool_call_id,
                        )

                        if tool_result is None:
                            run_failed = True
                            stream_aborted = True
                            yield emit_trace(
                                _build_event(
                                    "error",
                                    content=f"Timed out waiting for tool result: {tool_name}",
                                    metadata={"phase": "tool_timeout"},
                                    session_id=synthetic_session_id,
                                    chat_id=str(chat_id),
                                    message_id=request_message_id,
                                )
                            )
                            break

                        tool_result_event = _build_event(
                            "tool_result",
                            metadata={
                                "phase": "tool_result",
                                "status": tool_result.status,
                                "execution_time_ms": tool_result.execution_time_ms,
                                "error_code": tool_result.error_code,
                            },
                            **tool_result.model_dump(),
                        )
                        yield emit_trace(tool_result_event)

                        yield emit_trace(
                            build_status_event(
                                f"Tool result received from {tool_name}. Continuing reasoning...",
                                "tool_result_received",
                            )
                        )

                        llm_messages.append(
                            _assistant_tool_call_message(
                                assistant_turn_content,
                                tool_name,
                                tool_call_id,
                                tool_args,
                            )
                        )
                        
                        llm_messages.append(
                            {
                                "role": "tool",
                                "tool_call_id": tool_call_id,
                                "content": format_tool_response(
                                    tool_status=tool_result.status,
                                    tool_content=tool_result.content,
                                    error_code=tool_result.error_code,
                                ),
                            }
                        )

                        tool_call_requested = True
                        break

                if stream_aborted:
                    break

                if tool_call_requested:
                    logger.info(
                        "resuming llm user_id=%s chat_id=%s session_id=%s message_id=%s",
                        user.user_id,
                        chat_id,
                        synthetic_session_id,
                        request_message_id,
                    )
                    continue

                llm_messages.append(
                    {
                        "role": "assistant",
                        "content": assistant_turn_content,
                    }
                )

                if not assistant_turn_content.strip():
                    run_failed = True
                    empty_response_message = (
                        "Model stream completed without a final assistant answer after tool execution."
                        if llm_round > 1
                        else "Model stream completed without a visible assistant answer."
                    )
                    yield emit_trace(
                        _build_event(
                            "error",
                            content=empty_response_message,
                            metadata={"phase": "empty_response"},
                            session_id=synthetic_session_id,
                            chat_id=str(chat_id),
                            message_id=request_message_id,
                        )
                    )
                else:
                    yield emit_trace(build_status_event("Final answer ready.", "completed"))
                break
        except Exception as exc:
            run_failed = True
            error_details = str(exc)
            
            # Log provider error details for debugging
            if isinstance(exc, APIError):
                logger.error(
                    "LLM stream API error for chat %s: message=%s type=%s code=%s body=%s provider_request_headers=%s",
                    chat_id,
                    exc.message,
                    exc.type,
                    exc.code,
                    json.dumps(exc.body) if exc.body else None,
                    exc.request.headers if exc.request else None,
                    exc_info=True,
                )
                # Log the request payload that was sent
                logger.error(
                    "Request payload for failed chat %s llm_round=%s: messages_count=%s last_message_role=%s workspace_skeleton_len=%s",
                    chat_id,
                    llm_round,
                    len(llm_messages),
                    llm_messages[-1].get("role") if llm_messages else None,
                    len(req.workspace_skeleton) if req.workspace_skeleton else 0,
                )
            else:
                logger.error("LLM stream error for chat %s: %s", chat_id, error_details, exc_info=True)
            
            yield emit_trace(
                _build_event(
                    "error",
                    content=f"LLM stream failed: {error_details}",
                    metadata={"phase": "stream_exception"},
                    session_id=synthetic_session_id,
                    chat_id=str(chat_id),
                    message_id=request_message_id,
                )
            )

        async with AsyncSessionLocal() as db:
            asst_msg = MessageORM(
                chat_id=chat_id,
                role="assistant",
                content=full_response,
                events=trace_events or None,
            )
            db.add(asst_msg)

            chat_row = await db.get(ChatORM, chat_id)
            if chat_row:
                chat_row.updated_at = datetime.now(timezone.utc)

            await db.commit()
            await db.refresh(asst_msg)

        logger.info(
            "final response completed user_id=%s chat_id=%s session_id=%s message_id=%s assistant_message_id=%s failed=%s trace_events=%s response_chars=%s response_preview=%s",
            user.user_id,
            chat_id,
            synthetic_session_id,
            request_message_id,
            asst_msg.message_id,
            run_failed,
            len(trace_events),
            len(full_response),
            _preview(full_response) if full_response else "",
        )

        try:
            latest_session_state = await retrieve_session_state(synthetic_session_id)
            if latest_session_state is None:
                logger.warning(
                    "tool memory persistence skipped session missing user_id=%s chat_id=%s session_id=%s message_id=%s",
                    user.user_id,
                    chat_id,
                    synthetic_session_id,
                    request_message_id,
                )
            else:
                previous_tool_memory = latest_session_state.persisted.working_memory.get("tool_memory")
                updated_tool_memory = build_tool_memory_from_trace_events(previous_tool_memory, trace_events)
                latest_session_state.persisted.working_memory["tool_memory"] = updated_tool_memory
                await store_session_state(synthetic_session_id, latest_session_state)

                logger.info(
                    "tool memory persisted user_id=%s chat_id=%s session_id=%s message_id=%s mutation_count=%s",
                    user.user_id,
                    chat_id,
                    synthetic_session_id,
                    request_message_id,
                    len(updated_tool_memory.get("completed_mutations", [])),
                )
        except Exception:
            logger.exception(
                "tool memory persistence failed user_id=%s chat_id=%s session_id=%s message_id=%s",
                user.user_id,
                chat_id,
                synthetic_session_id,
                request_message_id,
            )

        yield _serialize_sse({"type": "done", "messageId": str(asst_msg.message_id)})

    return StreamingResponse(
        event_stream(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",
        },
    )


@router.get("/{chat_id}/messages")
async def get_messages(
    chat_id: UUID,
    user: AuthenticatedUser = Depends(get_current_user),
):
    async with AsyncSessionLocal() as db:
        chat_result = await db.execute(
            select(ChatORM).where(
                ChatORM.chat_id == chat_id,
                ChatORM.user_id == user.user_id,
            )
        )
        chat = chat_result.scalar_one_or_none()

        if not chat:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Chat not found")

        msg_result = await db.execute(
            select(MessageORM)
            .where(MessageORM.chat_id == chat_id)
            .order_by(MessageORM.created_at)
        )
        messages = msg_result.scalars().all()

    return {
        "chatId": str(chat.chat_id),
        "ideContextEnabled": chat.ide_context_enabled,
        "messages": [
            {
                "messageId": str(m.message_id),
                "role": m.role,
                "content": m.content,
                "events": m.events,
                "createdAt": m.created_at.isoformat(),
            }
            for m in messages
        ],
    }


@router.patch("/{chat_id}/ide-context")
async def update_chat_ide_context(
    chat_id: UUID,
    req: UpdateIdeContextRequest,
    user: AuthenticatedUser = Depends(get_current_user),
):
    async with AsyncSessionLocal() as db:
        chat_result = await db.execute(
            select(ChatORM).where(
                ChatORM.chat_id == chat_id,
                ChatORM.user_id == user.user_id,
            )
        )
        chat = chat_result.scalar_one_or_none()

        if not chat:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Chat not found")

        chat.ide_context_enabled = req.enabled
        chat.updated_at = datetime.now(timezone.utc)
        await db.commit()
        await db.refresh(chat)

    return {
        "chatId": str(chat.chat_id),
        "ideContextEnabled": chat.ide_context_enabled,
        "updatedAt": chat.updated_at.isoformat(),
    }


class CancelRequest(BaseModel):
    reason: Optional[str] = None


@router.post("/{chat_id}/cancel")
async def cancel_chat_stream(
    chat_id: UUID,
    req: CancelRequest = None,
    user: AuthenticatedUser = Depends(get_current_user),
):
    """
    Cancel an active chat stream and record the cancellation in conversation history.
    This creates a system message so the LLM is aware the user cancelled the operation
    when it reconstructs conversation context on the next message.
    """
    reason = req.reason if req else None
    
    async with AsyncSessionLocal() as db:
        chat_result = await db.execute(
            select(ChatORM).where(
                ChatORM.chat_id == chat_id,
                ChatORM.user_id == user.user_id,
            )
        )
        chat = chat_result.scalar_one_or_none()

        if not chat:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Chat not found")

        # Record cancellation as a system message so LLM knows it happened
        # This ensures context is maintained across page reloads and reconnects
        cancellation_message = MessageORM(
            chat_id=chat_id,
            role="system",
            content=f"User cancelled the operation. Reason: {reason or 'No reason provided'}",
            events=[
                {
                    "id": f"evt-cancel-{datetime.now(timezone.utc).timestamp()}",
                    "type": "status",
                    "content": "User cancelled the operation.",
                    "timestamp": int(datetime.now(timezone.utc).timestamp() * 1000),
                    "metadata": {
                        "phase": "cancelled",
                        "cancelledBy": "user",
                        "reason": reason or "user-requested",
                    },
                }
            ],
        )
        db.add(cancellation_message)
        await db.commit()

    logger.info(
        "chat stream cancelled user_id=%s chat_id=%s reason=%s message_id=%s",
        user.user_id,
        chat_id,
        reason or "user-requested",
        cancellation_message.message_id,
    )

    return {
        "chatId": str(chat_id),
        "status": "cancelled",
        "message": "Stream cancellation recorded. The LLM will be aware of this in the next message.",
    }
