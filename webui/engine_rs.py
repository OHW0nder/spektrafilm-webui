"""GPU preview engine: drives the Rust (wgpu/Vulkan) CLI from spektrafilm-rs.

The Rust port renders the same pipeline with f32 compute shaders, which is what
makes slider-drag previews fast. Exports stay on the Python f64 path; this module
is only ever used for previews and always degrades to the Python engine.
"""

from __future__ import annotations

import json
import os
import subprocess
import tempfile
from typing import Any

RS_BIN = os.environ.get("SPEKTRAFILM_RS_BIN", "/opt/spektrafilm-rs/spektrafilm")
RS_DATA = os.environ.get("SPEKTRAFILM_RS_DATA", "/opt/spektrafilm-rs/data")
RS_BACKEND = os.environ.get("SPEKTRAFILM_RS_BACKEND", "wgpu")
RS_TIMEOUT = float(os.environ.get("SPEKTRAFILM_RS_TIMEOUT", "90"))


class RustEngineError(RuntimeError):
    pass


def available() -> bool:
    return os.path.isfile(RS_BIN) and os.path.isdir(RS_DATA)


def render(
    input_tiff: str,
    output_png: str,
    *,
    film: str,
    paper: str | None,
    params_json: dict[str, Any],
) -> None:
    """Run one preview render; raises RustEngineError on any failure."""
    if not available():
        raise RustEngineError("spektrafilm-rs binary not installed")

    with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False) as handle:
        json.dump(params_json, handle)
        params_path = handle.name
    try:
        cmd = [
            RS_BIN, "process", input_tiff,
            "-o", output_png,
            "--film", film,
            "--data-dir", RS_DATA,
            "--params", params_path,
        ]
        if paper:
            cmd += ["--paper", paper]
        env = dict(os.environ)
        env["SPEKTRAFILM_BACKEND"] = RS_BACKEND
        proc = subprocess.run(
            cmd, capture_output=True, text=True, timeout=RS_TIMEOUT, env=env,
        )
        if proc.returncode != 0 or not os.path.exists(output_png):
            detail = (proc.stderr or proc.stdout or "").strip().splitlines()[-3:]
            raise RustEngineError(" ".join(detail) or f"exit {proc.returncode}")
    except subprocess.TimeoutExpired as exc:
        raise RustEngineError(f"timeout after {RS_TIMEOUT:.0f}s") from exc
    finally:
        os.unlink(params_path)
