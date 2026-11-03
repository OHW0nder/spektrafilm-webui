"""Python reference engine: numpy/numba, f64, full resolution."""

from __future__ import annotations

import io as _io
import os
from typing import Any

import numpy as np
from skimage.transform import resize

from spektrafilm import simulate, simulate_preview
from spektrafilm.runtime.params_schema import RuntimePhotoParams
from spektrafilm.utils.io import load_image_oiio, save_image_oiio

# Sources that are treated as sRGB-encoded unless the caller says otherwise.
_ENCODED_EXTENSIONS = {".png", ".jpg", ".jpeg"}
_MAX_PIXELS = int(os.environ.get("SPEKTRAFILM_MAX_PIXELS", 24_000_000))
MAX_PIXELS = _MAX_PIXELS


class UnsupportedImage(ValueError):
    pass


class ImageTooLarge(ValueError):
    pass


def load_input(path: str, *, input_encoding: str, target_space: str) -> np.ndarray:
    """Decode an upload into linear light in ``target_space``."""
    image = load_image_oiio(path)
    if image.ndim == 2:
        image = np.repeat(image[:, :, None], 3, axis=2)
    if image.shape[2] > 3:
        image = image[:, :, :3]
    if image.shape[2] != 3:
        raise UnsupportedImage(f"expected 3 channels, got {image.shape[2]}")

    encoding = _resolve_encoding(path, input_encoding)
    if encoding == "srgb":
        image = _srgb_to_space(image, target_space)
    return np.ascontiguousarray(image, dtype=np.float64)


def render_preview(image: np.ndarray, params: RuntimePhotoParams) -> np.ndarray:
    return simulate_preview(image, params)


def render_full(image: np.ndarray, params: RuntimePhotoParams) -> np.ndarray:
    if image.shape[0] * image.shape[1] > _MAX_PIXELS:
        raise ImageTooLarge(
            f"image has {image.shape[0] * image.shape[1]} px, limit is {_MAX_PIXELS}"
        )
    return simulate(image, params)


def downscale(image: np.ndarray, max_size: int) -> np.ndarray:
    h, w = image.shape[:2]
    if max(h, w) <= max_size:
        return image
    scale = max_size / max(h, w)
    out = resize(image, (int(h * scale), int(w * scale)), preserve_range=True,
                 anti_aliasing=True, order=1)
    return out.astype(image.dtype)


def encode_png(image: np.ndarray) -> bytes:
    buf = _io.BytesIO()
    from PIL import Image

    Image.fromarray(_to_uint8(image)).save(buf, format="PNG", optimize=False)
    return buf.getvalue()


def write_tiff(path: str, image: np.ndarray, params: RuntimePhotoParams) -> None:
    save_image_oiio(
        path,
        image,
        bit_depth=16,
        color_space=params.io.output_color_space,
        cctf_encoding=params.io.output_cctf_encoding,
    )


def write_linear_tiff(path: str, image: np.ndarray, color_space: str) -> None:
    """Intermediate file handed to the Rust CLI: float32, no transfer function."""
    save_image_oiio(path, image, bit_depth=32, color_space=color_space, cctf_encoding=False)


def _to_uint8(image: np.ndarray) -> np.ndarray:
    return (np.clip(image, 0.0, 1.0) * 255.0 + 0.5).astype(np.uint8)


def _resolve_encoding(path: str, requested: str) -> str:
    if requested in {"srgb", "linear"}:
        return requested
    return "srgb" if os.path.splitext(path)[1].lower() in _ENCODED_EXTENSIONS else "linear"


def _srgb_to_space(image: np.ndarray, target_space: str) -> np.ndarray:
    import colour

    if target_space == "sRGB":
        return colour.cctf_decoding(image)
    return colour.RGB_to_RGB(
        np.clip(image, 0.0, 1.0),
        "sRGB",
        target_space,
        apply_cctf_decoding=True,
        apply_cctf_encoding=False,
    )



def probe(path: str) -> dict[str, Any]:
    """Cheap header read: no pixel decode, used to validate an upload."""
    import OpenImageIO as oiio

    handle = oiio.ImageInput.open(path)
    if handle is None:
        raise UnsupportedImage(f"cannot open image: {oiio.geterror()}")
    try:
        spec = handle.spec()
        if spec.nchannels < 3:
            raise UnsupportedImage(f"expected at least 3 channels, got {spec.nchannels}")
        return {"width": spec.width, "height": spec.height, "format": str(spec.format)}
    finally:
        handle.close()
