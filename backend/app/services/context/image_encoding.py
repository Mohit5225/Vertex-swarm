"""Load, resize, and encode chat images for multimodal LLM requests."""

from __future__ import annotations

import base64
import io
import logging
from dataclasses import dataclass
from pathlib import Path

from PIL import Image

from app.services.context.budget import estimate_image_tokens
from app.services.context.policy import ImagesPolicy

logger = logging.getLogger(__name__)

_RASTER_EXTENSIONS = {".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp"}


@dataclass(frozen=True)
class EncodedImage:
    data_uri: str
    mime_type: str
    width: int
    height: int
    estimated_tokens: int
    byte_size: int


def _output_format_for_image(image: Image.Image, original_ext: str) -> tuple[str, str]:
    ext = original_ext.lower()
    if ext in {".jpg", ".jpeg"}:
        return "JPEG", "image/jpeg"
    if ext == ".webp":
        return "WEBP", "image/webp"
    if image.mode in ("RGBA", "LA", "P"):
        return "PNG", "image/png"
    return "JPEG", "image/jpeg"


def _resize_to_long_edge(image: Image.Image, max_long_edge: int) -> Image.Image:
    width, height = image.size
    long_edge = max(width, height)
    if long_edge <= max_long_edge:
        return image
    scale = max_long_edge / long_edge
    new_size = (max(1, int(width * scale)), max(1, int(height * scale)))
    return image.resize(new_size, Image.Resampling.LANCZOS)


def _encode_with_quality(
    image: Image.Image,
    fmt: str,
    mime_type: str,
    *,
    max_bytes: int,
    target_tokens: int,
) -> EncodedImage:
    quality_steps = (90, 80, 70, 60, 50, 40, 30)
    long_edge_steps = (None, 0.85, 0.7, 0.55, 0.45)

    working = image
    best: EncodedImage | None = None

    for edge_scale in long_edge_steps:
        candidate = working
        if edge_scale is not None:
            width, height = candidate.size
            long_edge = max(width, height)
            candidate = candidate.resize(
                (max(1, int(width * edge_scale)), max(1, int(height * edge_scale))),
                Image.Resampling.LANCZOS,
            )
            long_edge = max(candidate.size)

        for quality in quality_steps:
            buffer = io.BytesIO()
            save_kwargs: dict = {"format": fmt, "optimize": True}
            if fmt in {"JPEG", "WEBP"}:
                save_kwargs["quality"] = quality
            if fmt == "PNG":
                save_kwargs["compress_level"] = 9

            rgb = candidate
            if fmt == "JPEG" and rgb.mode not in ("RGB", "L"):
                rgb = rgb.convert("RGB")

            rgb.save(buffer, **save_kwargs)
            raw = buffer.getvalue()
            if len(raw) > max_bytes:
                continue

            width, height = rgb.size
            tokens = estimate_image_tokens(width, height)
            encoded = EncodedImage(
                data_uri=f"data:{mime_type};base64,{base64.b64encode(raw).decode('ascii')}",
                mime_type=mime_type,
                width=width,
                height=height,
                estimated_tokens=tokens,
                byte_size=len(raw),
            )
            best = encoded
            if tokens <= target_tokens:
                return encoded

    if best is not None:
        return best

    buffer = io.BytesIO()
    rgb = image.convert("RGB") if image.mode not in ("RGB", "L") else image
    rgb.save(buffer, format="JPEG", quality=30, optimize=True)
    raw = buffer.getvalue()
    width, height = rgb.size
    return EncodedImage(
        data_uri=f"data:image/jpeg;base64,{base64.b64encode(raw).decode('ascii')}",
        mime_type="image/jpeg",
        width=width,
        height=height,
        estimated_tokens=estimate_image_tokens(width, height),
        byte_size=len(raw),
    )


def encode_image_file(path: Path, policy: ImagesPolicy) -> EncodedImage:
    ext = path.suffix.lower()
    if ext not in _RASTER_EXTENSIONS:
        raise ValueError(f"Unsupported image format for send: {path.name}")

    with Image.open(path) as image:
        image = image.convert("RGBA") if image.mode == "P" else image
        resized = _resize_to_long_edge(image, policy.send_max_long_edge_px)
        fmt, mime_type = _output_format_for_image(resized, ext)
        encoded = _encode_with_quality(
            resized,
            fmt,
            mime_type,
            max_bytes=policy.send_max_bytes_per_image,
            target_tokens=policy.target_tokens_per_image,
        )

    logger.debug(
        "encoded attachment path=%s bytes=%s dims=%sx%s est_tokens=%s",
        path.name,
        encoded.byte_size,
        encoded.width,
        encoded.height,
        encoded.estimated_tokens,
    )
    return encoded
