import asyncio
import json
import logging
import sys
from pathlib import Path
from typing import Dict, Any

from app.config import WorkerConfig
from app.nats_client import NATSClient
from app.stdio_transport import StdioTransport
from app.orchestrator import LLMOrchestrator
from app.utils.auth_validator import validate_entitlement, EntitlementError, configure_jwks_url

logger = logging.getLogger(__name__)

class WorkerNode:
    def __init__(self):
        self.stdio = StdioTransport()
        self.config: WorkerConfig | None = None
        self.nats: NATSClient | None = None
        self.orchestrator: LLMOrchestrator | None = None
        self.active_sessions: Dict[str, asyncio.Task] = {}
        self.pending_user_turns: Dict[str, list[Dict[str, Any]]] = {}

    async def handle_initialize(self, msg_id: int, params: Dict[str, Any]):
        try:
            base_path = params.get("base_path")
            if not base_path:
                raise ValueError("base_path is required")

            auth_jwks_url = params.get("auth_jwks_url", "")
            # Configure the JWKS client as early as possible so
            # validate_entitlement() below can fetch the public key.
            if auth_jwks_url:
                configure_jwks_url(auth_jwks_url)

            self.config = WorkerConfig(
                base_path=Path(base_path),
                llm_key=params.get("llm_key", ""),
                exa_key=params.get("exa_key", ""),
                entitlement_token=params.get("entitlement_token", ""),
                platform=params.get("platform", sys.platform),
                # OpenRouter is the active path; DeepSeek retained for rollback.
                llm_base_url=params.get("llm_base_url", "https://openrouter.ai/api/v1"),
                llm_model=params.get("llm_model", "deepseek/deepseek-v4-flash"),
                llm_fallback_model=params.get("llm_fallback_model", "deepseek/deepseek-v4-flash"),
                # llm_base_url=params.get("llm_base_url", "https://api.deepseek.com/v1"),
                # llm_model=params.get("llm_model", "deepseek-v4-pro"),
                # llm_fallback_model=params.get("llm_fallback_model", "deepseek-v4-pro"),
                llm_reasoning_enabled=params.get("llm_reasoning_enabled", False),
                llm_reasoning_effort=params.get("llm_reasoning_effort", "low"),
                auth_jwks_url=auth_jwks_url,
            )
            
            # Strict JWT Entitlement Validation
            entitlement_token = params.get("entitlement_token")
            try:
                # Cryptographically verify the RS256 token using the baked-in Public Key
                validate_entitlement(entitlement_token)
            except EntitlementError as e:
                logger.error(f"Entitlement validation failed: {e.message}")
                await self.stdio.write_message({
                    "jsonrpc": "2.0",
                    "id": msg_id,
                    "error": {
                        "code": e.code,
                        "message": f"Auth Error: {e.message}"
                    }
                })
                return  # Abort initialization

            # Initialize NATS
            nats_port = params.get("nats_port", 4222)
            nats_url = f"nats://127.0.0.1:{nats_port}"
            self.nats = NATSClient()
            await self.nats.connect(nats_url)

            # Initialize Orchestrator
            self.orchestrator = LLMOrchestrator(self.config, self.nats)
            # Re-use the existing StdioTransport to avoid stream conflicts
            self.orchestrator.stdio = self.stdio

            # Respond success
            await self.stdio.write_message({
                "jsonrpc": "2.0",
                "id": msg_id,
                "result": {
                    "protocol_version": "1.0",
                    "status": "ready",
                    "nats_url": nats_url
                }
            })
            logger.info("Worker initialized successfully.")
        except Exception as e:
            logger.exception("Initialization failed")
            await self.stdio.write_message({
                "jsonrpc": "2.0",
                "id": msg_id,
                "error": {
                    "code": -32000,
                    "message": f"Initialization failed: {str(e)}"
                }
            })

    def has_valid_entitlement(self) -> bool:
        """Authorize work at the point it is executed, not only at startup."""
        if not self.orchestrator:
            return False
        try:
            validate_entitlement(self.orchestrator.config.entitlement_token)
            return True
        except EntitlementError as exc:
            logger.warning("Rejected privileged worker action: %s", exc.message)
            return False

    async def handle_session_start(self, params: Dict[str, Any]):
        if not self.orchestrator:
            return
        if not self.has_valid_entitlement():
            return

        chat_id = params.get("chat_id")
        message = params.get("message")
        if not chat_id or not message:
            return
            
        if chat_id in self.active_sessions:
            queue = self.pending_user_turns.setdefault(chat_id, [])
            queue.append(params)
            logger.info(
                "Session %s is already running; queued user turn (depth=%s)",
                chat_id,
                len(queue),
            )
            return

        async def run_session():
            try:
                await self.orchestrator.handle_session_start(chat_id, message, params)
            except asyncio.CancelledError:
                logger.info(f"Session {chat_id} cancelled.")
            except Exception:
                logger.exception(f"Session {chat_id} failed.")
            finally:
                self.active_sessions.pop(chat_id, None)
                await self._drain_pending_user_turn(chat_id)

        task = asyncio.create_task(run_session())
        self.active_sessions[chat_id] = task

    async def _drain_pending_user_turn(self, chat_id: str) -> None:
        queue = self.pending_user_turns.get(chat_id, [])
        if not queue:
            return

        next_params = queue.pop(0)
        if not queue:
            self.pending_user_turns.pop(chat_id, None)

        await self.handle_session_start(next_params)

    async def handle_session_cancel(self, params: Dict[str, Any]):
        chat_id = params.get("chat_id")
        if not chat_id:
            return

        self.pending_user_turns.pop(chat_id, None)
        if self.orchestrator:
            self.orchestrator.clear_job_completions(chat_id)

        if chat_id in self.active_sessions:
            self.active_sessions[chat_id].cancel()
            logger.info(f"Cancelled session {chat_id}.")

    async def handle_tool_result(self, params: Dict[str, Any]):
        if not self.orchestrator:
            return
        if not self.has_valid_entitlement():
            return
            
        chat_id = params.get("chat_id")
        tool_call_id = params.get("tool_call_id")
        if not chat_id or not tool_call_id:
            return
            
        from app.schemas.tool import ToolResultSchema
        try:
            result = ToolResultSchema(**params)
            await self.orchestrator.handle_tool_result(result)
        except Exception as e:
            logger.error(f"Failed to parse tool result: {e}")

    async def handle_hil_respond(self, params: Dict[str, Any]):
        """Route HilQuestionCard answers into the blocked hil_tool coroutine."""
        if not self.orchestrator:
            return
        if not self.has_valid_entitlement():
            return

        hil_session_id = params.get("hil_session_id")
        answers = params.get("answers")
        if not hil_session_id or not isinstance(answers, list):
            logger.warning("session/hil_respond missing hil_session_id or answers")
            return

        ok, message = await self.orchestrator.handle_hil_respond(hil_session_id, answers)
        if not ok:
            logger.warning("session/hil_respond rejected: %s", message)

    async def handle_planning_approve(self, params: Dict[str, Any]):
        if not self.orchestrator:
            return
        if not self.has_valid_entitlement():
            return

        pipeline_id = params.get("pipeline_id")
        if not pipeline_id:
            logger.warning("session/planning_approve missing pipeline_id")
            return

        ok, message = await self.orchestrator.handle_planning_approve(str(pipeline_id))
        if not ok:
            logger.warning("session/planning_approve rejected: %s", message)

    async def handle_planning_reject(self, params: Dict[str, Any]):
        if not self.orchestrator:
            return
        if not self.has_valid_entitlement():
            return

        pipeline_id = params.get("pipeline_id")
        feedback = params.get("rejection_feedback", "")
        if not pipeline_id:
            logger.warning("session/planning_reject missing pipeline_id")
            return

        ok, message = await self.orchestrator.handle_planning_reject(
            str(pipeline_id),
            str(feedback or ""),
        )
        if not ok:
            logger.warning("session/planning_reject rejected: %s", message)

    async def handle_update_keys(self, params: Dict[str, Any]):
        if not self.orchestrator:
            return

        replacement_token = params.get("entitlement_token")
        if replacement_token is not None:
            try:
                validate_entitlement(replacement_token)
            except EntitlementError as exc:
                logger.warning("Rejected invalid entitlement-token update: %s", exc.message)
                return
        elif not self.has_valid_entitlement():
            return
        
        if "llm_key" in params:
            self.orchestrator.config.llm_key = params["llm_key"]
        if "exa_key" in params:
            self.orchestrator.config.exa_key = params["exa_key"]
        if "llm_base_url" in params:
            self.orchestrator.config.llm_base_url = params["llm_base_url"]
        if "llm_model" in params:
            self.orchestrator.config.llm_model = params["llm_model"]
        if "entitlement_token" in params:
            self.orchestrator.config.entitlement_token = params["entitlement_token"]
        
        logger.info("Keys and config updated dynamically from extension.")

    async def handle_background_event(self, params: Dict[str, Any]):
        if not self.orchestrator:
            return
        if not self.has_valid_entitlement():
            return
        
        chat_id = params.get("chat_id")
        job_id = params.get("job_id")
        
        if not chat_id or not job_id:
            return

        if chat_id in self.active_sessions:
            self.orchestrator.enqueue_job_completion(chat_id, params)
            logger.info(
                "Queued job completion for active session chat_id=%s job_id=%s",
                chat_id,
                job_id,
            )
            return

        exit_code = params.get("exit_code")
        output_tail = params.get("output_tail", "")
        command = params.get("command", "")
        status_message = params.get("status_message") or params.get("status") or "completed"

        system_message = (
            f"[System Notification: Background terminal job finished]\n"
            f"job_id: {job_id}\n"
            f"command: {command}\n"
            f"exit_code: {exit_code}\n"
            f"status: {status_message}\n"
            f"output_tail:\n{output_tail}\n"
            f"Use terminal_ops -> get_output for full output if needed."
        )
        
        logger.info(f"Received background event for job {job_id} in chat {chat_id}. Waking up LLM.")
        
        wakeup_params = params.copy()
        wakeup_params["message"] = system_message
        
        await self.handle_session_start(wakeup_params)

    async def run(self):
        logger.info("Worker started. Waiting for messages on stdio.")
        while True:
            try:
                msg = await self.stdio.read_message()
                if not msg:
                    logger.info("EOF received on stdio. Exiting.")
                    break

                method = msg.get("method")
                params = msg.get("params", {})

                if method == "initialize":
                    await self.handle_initialize(msg.get("id", 1), params)
                elif method == "session/start":
                    await self.handle_session_start(params)
                elif method == "session/cancel":
                    await self.handle_session_cancel(params)
                elif method == "session/hil_respond":
                    await self.handle_hil_respond(params)
                elif method == "session/planning_approve":
                    await self.handle_planning_approve(params)
                elif method == "session/planning_reject":
                    await self.handle_planning_reject(params)
                elif method == "tool/result":
                    await self.handle_tool_result(params)
                elif method == "config/update_keys":
                    await self.handle_update_keys(params)
                elif method == "background/event":
                    await self.handle_background_event(params)
                else:
                    logger.warning(f"Unknown method: {method}")
            except Exception as e:
                logger.exception("Error processing message")

        # Cleanup
        for task in self.active_sessions.values():
            task.cancel()
        if self.nats:
            await self.nats.close()



def main():
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
        stream=sys.stderr
    )
    worker = WorkerNode()
    
    # We use ProactorEventLoop on Windows for subprocess support if needed, but asyncio.run is usually fine
    try:
        asyncio.run(worker.run())
    except KeyboardInterrupt:
        pass

if __name__ == "__main__":
    main()
