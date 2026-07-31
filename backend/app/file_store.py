import json
import os
import aiofiles
import aiofiles.os
import asyncio
from pathlib import Path
from typing import Optional, List, Dict, Any
from datetime import datetime, timezone
import logging

logger = logging.getLogger(__name__)

class FileStore:
    def __init__(self, base_path: Path):
        self.base_path = Path(base_path)
        self.chats_path = self.base_path / "chats"
        self._locks: Dict[str, asyncio.Lock] = {}
        
    def _get_lock(self, chat_id: str) -> asyncio.Lock:
        if chat_id not in self._locks:
            self._locks[chat_id] = asyncio.Lock()
        return self._locks[chat_id]

    async def _ensure_dir(self, path: Path) -> None:
        if not await aiofiles.os.path.exists(path):
            os.makedirs(path, exist_ok=True)

    async def create_chat(self, chat_id: str, title: str, ide_context: bool) -> None:
        chat_dir = self.chats_path / chat_id
        await self._ensure_dir(chat_dir)
        await self._ensure_dir(chat_dir / "logs" / "subagents")
        
        meta = {
            "title": title,
            "created_at": datetime.now(timezone.utc).isoformat(),
            "updated_at": datetime.now(timezone.utc).isoformat(),
            "ide_context_enabled": ide_context
        }
        
        meta_file = chat_dir / "meta.json"
        async with aiofiles.open(meta_file, mode='w', encoding='utf-8') as f:
            await f.write(json.dumps(meta, indent=2))
            
    async def append_message(
        self,
        chat_id: str,
        role: str,
        content: str,
        events: List[Dict[str, Any]] = None,
        message_id: str = None,
        turn_duration_ms: int | None = None,
        attachments: List[Dict[str, Any]] | None = None,
    ) -> None:
        chat_dir = self.chats_path / chat_id
        await self._ensure_dir(chat_dir)
        
        msg: Dict[str, Any] = {
            "message_id": message_id,
            "timestamp": datetime.now(timezone.utc).isoformat(),
            "role": role,
            "content": content,
            "events": events or []
        }
        if attachments:
            msg["attachments"] = attachments
        if turn_duration_ms is not None and turn_duration_ms >= 0:
            msg["turn_duration_ms"] = turn_duration_ms
        
        messages_file = chat_dir / "messages.jsonl"
        async with self._get_lock(chat_id):
            async with aiofiles.open(messages_file, mode='a', encoding='utf-8') as f:
                await f.write(json.dumps(msg) + "\n")

    async def read_messages(self, chat_id: str) -> List[Dict[str, Any]]:
        messages_file = self.chats_path / chat_id / "messages.jsonl"
        if not await aiofiles.os.path.exists(messages_file):
            return []
            
        messages = []
        async with self._get_lock(chat_id):
            async with aiofiles.open(messages_file, mode='r', encoding='utf-8') as f:
                async for line in f:
                    if line.strip():
                        messages.append(json.loads(line))
        return messages
            
    async def write_session(self, chat_id: str, state: Dict[str, Any]) -> None:
        """Atomic write of session.json via tmp + rename."""
        chat_dir = self.chats_path / chat_id
        await self._ensure_dir(chat_dir)
        
        session_file = chat_dir / "session.json"
        tmp_file = chat_dir / "session.json.tmp"
        
        async with self._get_lock(chat_id):
            async with aiofiles.open(tmp_file, mode='w', encoding='utf-8') as f:
                await f.write(json.dumps(state, indent=2))
                
            await aiofiles.os.replace(tmp_file, session_file)
        
    async def read_session(self, chat_id: str) -> Optional[Dict[str, Any]]:
        session_file = self.chats_path / chat_id / "session.json"
        if not await aiofiles.os.path.exists(session_file):
            return None
            
        async with aiofiles.open(session_file, mode='r', encoding='utf-8') as f:
            content = await f.read()
            return json.loads(content)
            
    async def write_plan(self, chat_id: str, content: str) -> None:
        chat_dir = self.chats_path / chat_id
        await self._ensure_dir(chat_dir)
        
        plan_file = chat_dir / "plan.md"
        async with aiofiles.open(plan_file, mode='w', encoding='utf-8') as f:
            await f.write(content)
            
    async def log_subagent(self, chat_id: str, agent_id: str, entry: Dict[str, Any]) -> None:
        subagents_dir = self.chats_path / chat_id / "logs" / "subagents"
        await self._ensure_dir(subagents_dir)
        
        log_file = subagents_dir / f"{agent_id}.jsonl"
        async with aiofiles.open(log_file, mode='a', encoding='utf-8') as f:
            entry["timestamp"] = datetime.now(timezone.utc).isoformat()
            await f.write(json.dumps(entry) + "\n")
