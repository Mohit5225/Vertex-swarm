"""LLM service — OpenAI SDK against OpenRouter's API."""
import logging
from typing import AsyncIterator, List, Dict

from openai import AsyncOpenAI

from app.core.config import settings

logger = logging.getLogger(__name__)

DEVELOPER_ASSISTANT_PERSONA = """You are Vertex, a sharp expert developer assistant embedded directly inside VS Code.

You help developers write, debug, understand, and improve code across any language or framework.

Rules you always follow:
- Reason step-by-step before answering
- Be direct and precise — no filler, no padding
- When given code, scan it for correctness, security issues, and efficiency first
- When requirements are ambiguous, ask exactly one clarifying question and stop
- Reference specific line numbers and function names when discussing code
- Prefer showing working code over describing it"""


def _get_client() -> AsyncOpenAI:
    return AsyncOpenAI(
        base_url="https://openrouter.ai/api/v1",
        api_key=settings.openrouter_api_key,
    )


# Strip the "openrouter/" prefix — OpenRouter's own API doesn't need it
def _model_name() -> str:
    model = settings.openrouter_model
    return model.removeprefix("openrouter/")


async def stream_chat_completion(
    messages: List[Dict[str, str]],
) -> AsyncIterator[str]:
    """
    Stream a chat completion via OpenRouter using the OpenAI-compatible API.

    Args:
        messages: List of {"role": "user"|"assistant", "content": "..."} dicts
                  in chronological order.

    Yields:
        Token chunks (str) as they stream from the model.
    """
    client = _get_client()
    full_messages = [
        {"role": "system", "content": DEVELOPER_ASSISTANT_PERSONA},
        *messages,
    ]

    stream = await client.chat.completions.create(
        model=_model_name(),
        messages=full_messages,
        stream=True,
    )

    async for chunk in stream:
        if not chunk.choices:
            logger.debug("Skipping streamed chunk without choices: %s", chunk)
            continue

        delta = chunk.choices[0].delta
        if not delta or not delta.content:
            continue

        if isinstance(delta.content, str):
            yield delta.content
            continue

        for part in delta.content:
            text = getattr(part, "text", None)
            if text:
                yield text
