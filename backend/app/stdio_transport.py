import sys
import json
import asyncio
from typing import Optional, Dict, Any

class StdioTransport:
    """
    Handles reading and writing JSON-RPC messages over stdin/stdout
    using Content-Length framing (similar to LSP).
    Uses thread pool executor for blocking I/O to support Windows safely.
    """
    _MAX_HEADER_LINE_BYTES = 64 * 1024

    def __init__(self, in_stream=None, out_stream=None):
        self.in_stream = in_stream or sys.stdin.buffer
        self.out_stream = out_stream or sys.stdout.buffer
        self._write_lock = asyncio.Lock()

    async def _readline(self) -> bytes:
        loop = asyncio.get_running_loop()
        return await loop.run_in_executor(None, self.in_stream.readline)

    async def _readexactly(self, n: int) -> bytes:
        loop = asyncio.get_running_loop()
        def _read_all():
            data = bytearray()
            while len(data) < n:
                chunk = self.in_stream.read(n - len(data))
                if not chunk:
                    break
                data.extend(chunk)
            return bytes(data)
        return await loop.run_in_executor(None, _read_all)

    async def read_message(self) -> Optional[Dict[str, Any]]:
        """Reads a Content-Length framed JSON message."""
        content_length = None
        while True:
            line = await self._readline()
            if not line:
                return None  # EOF

            if len(line) > self._MAX_HEADER_LINE_BYTES:
                raise ValueError(
                    f"Stdio header line too large ({len(line)} bytes); "
                    "likely a framing error on the extension→worker channel"
                )

            line_str = line.decode('utf-8', errors='ignore').strip()
            if line_str == "":
                break # End of headers

            if line_str.lower().startswith("content-length:"):
                try:
                    content_length = int(line_str.split(":")[1].strip())
                except ValueError:
                    raise ValueError(f"Invalid Content-Length header: {line_str}")

        if content_length is None:
            # We reached \r\n\r\n but saw no Content-Length header, or EOF
            return None

        if content_length < 0 or content_length > 64 * 1024 * 1024:
            raise ValueError(f"Refusing Content-Length={content_length}")

        body = await self._readexactly(content_length)
        if len(body) < content_length:
            return None # EOF before reading full body

        return json.loads(body.decode('utf-8'))
        
    async def write_message(self, msg: Dict[str, Any]) -> None:
        """Writes a Content-Length framed JSON message."""
        body_bytes = json.dumps(msg, separators=(',', ':')).encode('utf-8')
        header = f"Content-Length: {len(body_bytes)}\r\n\r\n".encode('utf-8')
        
        loop = asyncio.get_running_loop()
        
        def _write():
            self.out_stream.write(header)
            self.out_stream.write(body_bytes)
            self.out_stream.flush()
            
        async with self._write_lock:
            await loop.run_in_executor(None, _write)

    async def write_event(self, chat_id: str, event: Dict[str, Any]) -> None:
        """Convenience method to write a streaming event notification."""
        msg = {
            "jsonrpc": "2.0",
            "method": "stream/event",
            "params": {
                "chat_id": chat_id,
                "event": event
            }
        }
        await self.write_message(msg)
