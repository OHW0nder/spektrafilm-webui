"""Image decoding (including camera RAW) and the Python f64 reference engine.

A source is decoded once at upload into a small linear ACES2065-1 float32 TIFF.
Both engines accept ACES2065-1 as their input space, so previews only read that
cache — no full-size decode or colour conversion on slider moves.
"""

from __future__ import annotations

import io as _io
import os
from typing import Any

import numpy as np
from skimage.transform import resize

from spektrafilm import simulate, simulate_preview
from spektrafilm.runtime.params_schema import RuntimePhotoParams
from spektrafilm.utils.io import load_image_oiio, save_image_oiio

RAW_EXTENSIONS = {".rw2", ".cr2", ".cr3", ".nef", ".arw", ".orf", ".raf",
                  ".dng", ".pef", ".srw", ".3fr", ".fff", ".iiq", ".raw"}
ENCODED_EXTENSIONS = {".png", ".jpg", ".jpeg"}
SUPPORTED_EXTENSIONS = RAW_EXTENSIONS | ENCODED_EXTENSIONS | {".tif", ".tiff", ".exr"}
CANONICAL_SPACE = "ACES2065-1"
DEFAULT_SOURCE_SPACE = "ProPhoto RGB"

PREVIEW_EDGE = int(os.environ.get("SPEKTRAFILM_PREVIEW_EDGE", 1600))
MAX_PIXELS = int(os.environ.get("SPEKTRAFILM_MAX_PIXELS", 24_000_000))


class UnsupportedImage(ValueError):
    pass


class ImageTooLarge(ValueError):
    pass


def decode_source(
    path: str,
    *,
    input_encoding: str = "auto",
    source_space: str = DEFAULT_SOURCE_SPACE,
    max_edge: int = PREVIEW_EDGE,
    allow_half_raw: bool = True,
) -> np.ndarray:
    """Decode into linear ACES2065-1, limited to ``max_edge`` px on the long side."""
    ext = os.path.splitext(path)[1].lower()
    if ext in RAW_EXTENSIONS:
        image = _decode_raw(path, max_edge, allow_half_raw)
    elif ext in ENCODED_EXTENSIONS:
        image = _decode_encoded(path, input_encoding, source_space, max_edge)
    else:
        image = _decode_oiio(path, source_space, max_edge)

    if image.ndim == 2:
        image = np.repeat(image[:, :, None], 3, axis=2)
    if image.shape[2] > 3:
        image = image[:, :, :3]
    if image.shape[2] != 3:
        raise UnsupportedImage(f"expected 3 channels, got {image.shape[2]}")
    return np.ascontiguousarray(_limit(image, max_edge), dtype=np.float32)


def load_cached(path: str) -> np.ndarray:
    """Read the cached linear float32 TIFF; no re-decoding."""
    return np.ascontiguousarray(load_image_oiio(path), dtype=np.float32)


def rotate(image: np.ndarray, quarter_turns: int) -> np.ndarray:
    k = int(quarter_turns) % 4
    return np.rot90(image, k) if k else image


def display_png(image: np.ndarray) -> bytes:
    """Colour-manage a linear ACES source into an 8-bit sRGB PNG ('before' view)."""
    return encode_png(aces_to_display(image))


def aces_to_display(image: np.ndarray) -> np.ndarray:
    import colour

    return colour.RGB_to_RGB(
        np.clip(image, 0.0, 1.0), CANONICAL_SPACE, "sRGB",
        apply_cctf_decoding=False, apply_cctf_encoding=True,
    )


def encode_png(image: np.ndarray) -> bytes:
    """Encode an already display-referred (sRGB encoded) float image to PNG."""
    buf = _io.BytesIO()
    from PIL import Image

    Image.fromarray(_to_uint8(image)).save(buf, format="PNG")
    return buf.getvalue()


def render_preview(image: np.ndarray, params: RuntimePhotoParams) -> np.ndarray:
    return simulate_preview(image, params)


def render_full(image: np.ndarray, params: RuntimePhotoParams) -> np.ndarray:
    if image.shape[0] * image.shape[1] > MAX_PIXELS:
        raise ImageTooLarge(
            f"image has {image.shape[0] * image.shape[1]} px, limit is {MAX_PIXELS}"
        )
    return simulate(image, params)


def write_tiff(path: str, image: np.ndarray, params: RuntimePhotoParams) -> None:
    save_image_oiio(path, image, bit_depth=16,
                    color_space=params.io.output_color_space,
                    cctf_encoding=params.io.output_cctf_encoding)


def write_linear_tiff(path: str, image: np.ndarray) -> None:
    """Intermediate handed to the Rust CLI: float32 ACES, no transfer function."""
    save_image_oiio(path, image, bit_depth=32,
                    color_space=CANONICAL_SPACE, cctf_encoding=False)


def describe(image: np.ndarray) -> dict[str, Any]:
    return {"width": int(image.shape[1]), "height": int(image.shape[0])}


def downscale(image: np.ndarray, max_edge: int) -> np.ndarray:
    return _limit(image, max_edge)


def _limit(image: np.ndarray, max_edge: int) -> np.ndarray:
    h, w = image.shape[:2]
    if max(h, w) <= max_edge:
        return image
    scale = max_edge / max(h, w)
    out = resize(image, (int(h * scale), int(w * scale)), preserve_range=True,
                 anti_aliasing=True, order=1)
    return out.astype(image.dtype)


def _to_aces(rgb: np.ndarray, space: str, encoded: bool) -> np.ndarray:
    import colour

    if space == CANONICAL_SPACE and not encoded:
        return np.clip(rgb, 0.0, 1.0)
    return colour.RGB_to_RGB(
        np.clip(rgb, 0.0, 1.0), space, CANONICAL_SPACE,
        apply_cctf_decoding=encoded, apply_cctf_encoding=False,
    ).astype(np.float32)


def _decode_raw(path: str, max_edge: int, allow_half: bool) -> np.ndarray:
    import rawpy

    with rawpy.imread(path) as raw:
        native = max(raw.sizes.raw_height, raw.sizes.raw_width)
        half = bool(allow_half and native // 2 >= max_edge)
        rgb = raw.postprocess(
            output_color=rawpy.ColorSpace.ACES, output_bps=16,
            no_auto_bright=True, gamma=(1, 1), use_camera_wb=True,
            half_size=half,
        ).astype(np.float32) / np.float32(65535.0)
    return rgb


def _decode_encoded(path: str, input_encoding: str, source_space: str,
                    max_edge: int) -> np.ndarray:
    from PIL import Image

    with Image.open(path) as handle:
        handle.draft("RGB", (max_edge * 2, max_edge * 2))
        rgb = np.asarray(handle.convert("RGB"), dtype=np.float32) / np.float32(255.0)

    rgb = _limit(rgb, max_edge * 2)
    if input_encoding == "linear":
        return _to_aces(rgb, source_space, encoded=False)
    return _to_aces(rgb, "sRGB", encoded=True)


def _decode_oiio(path: str, source_space: str, max_edge: int) -> np.ndarray:
    image = np.asarray(load_image_oiio(path), dtype=np.float32)
    image = _limit(image, max_edge * 2)
    return _to_aces(image, source_space, encoded=False)


def _to_uint8(image: np.ndarray) -> np.ndarray:
    return (np.clip(image, 0.0, 1.0) * 255.0 + 0.5).astype(np.uint8)
