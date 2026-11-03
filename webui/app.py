"""FastAPI app: the server side of the spektrafilm web UI.

Preview requests go to the Rust/Vulkan engine when it is installed and fall back
to the Python runtime otherwise; exports always use the Python f64 reference.
"""

from __future__ import annotations

import os
import re
import time
import uuid
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import Any

from fastapi import FastAPI, HTTPException, UploadFile, File
from fastapi.responses import FileResponse, HTMLResponse, Response
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from . import engine_py, engine_rs, params as param_mod
from .jobs import JobStore

DATA_DIR = Path(os.environ.get("SPEKTRAFILM_DATA", "/data"))
UPLOAD_DIR = DATA_DIR / "uploads"
OUTPUT_DIR = DATA_DIR / "outputs"
TMP_DIR = DATA_DIR / "tmp"
JOB_DIR = DATA_DIR / "jobs"
STATIC_DIR = Path(__file__).resolve().parent / "static"

for directory in (UPLOAD_DIR, OUTPUT_DIR, TMP_DIR, JOB_DIR):
    directory.mkdir(parents=True, exist_ok=True)

ALLOWED_EXTENSIONS = {".png", ".jpg", ".jpeg", ".tif", ".tiff", ".exr"}
MAX_UPLOAD_BYTES = int(os.environ.get("SPEKTRAFILM_MAX_UPLOAD_MB", "256")) * 1024 * 1024
_UPLOAD_ID = re.compile(r"^[0-9a-f]{32}$")

app = FastAPI(title="spektrafilm", docs_url=None, redoc_url=None)
app.mount("/static", StaticFiles(directory=str(STATIC_DIR)), name="static")

_jobs = JobStore(str(JOB_DIR))
_pool = ThreadPoolExecutor(max_workers=1, thread_name_prefix="render")


class RenderRequest(BaseModel):
    upload_id: str
    input_encoding: str = "auto"
    payload: dict[str, Any]


@app.get("/", response_class=HTMLResponse)
def index() -> HTMLResponse:
    return HTMLResponse((STATIC_DIR / "index.html").read_text(encoding="utf-8"))


@app.get("/api/health")
def health() -> dict[str, Any]:
    return {
        "ok": True,
        "engine_python": True,
        "engine_gpu": engine_rs.available(),
        "gpu_backend": engine_rs.RS_BACKEND if engine_rs.available() else None,
        "max_pixels": engine_py._MAX_PIXELS,
    }


@app.get("/api/manifest")
def manifest() -> dict[str, Any]:
    return param_mod.manifest()


@app.post("/api/upload")
async def upload(file: UploadFile = File(...)) -> dict[str, Any]:
    ext = os.path.splitext(file.filename or "")[1].lower()
    if ext not in ALLOWED_EXTENSIONS:
        raise HTTPException(status_code=400, detail=f"unsupported file type: {ext or 'none'}")

    upload_id = uuid.uuid4().hex
    target = UPLOAD_DIR / f"{upload_id}{ext}"
    written = 0
    with target.open("wb") as handle:
        while chunk := await file.read(1 << 20):
            written += len(chunk)
            if written > MAX_UPLOAD_BYTES:
                handle.close()
                target.unlink(missing_ok=True)
                raise HTTPException(status_code=413, detail="file too large")
            handle.write(chunk)

    try:
        info = engine_py.probe(str(target))
    except Exception as exc:  # decode failure is a user error, not a 500
        target.unlink(missing_ok=True)
        raise HTTPException(status_code=400, detail=f"cannot read image: {exc}") from exc

    return {"id": upload_id, "filename": file.filename, "bytes": written, **info}


@app.post("/api/preview")
def preview(request: RenderRequest) -> Response:
    path = str(_upload_path(request.upload_id))
    params = _params(request.payload)
    image = engine_py.load_input(
        path, input_encoding=request.input_encoding,
        target_space=params.io.input_color_space,
    )
    small = engine_py.downscale(image, int(params.settings.preview_max_size))

    engine = "python-cpu"
    png = None
    if engine_rs.available():
        png = _gpu_preview(small, params, request.payload)
        if png is not None:
            engine = "wgpu-vulkan"

    if png is None:
        result = engine_py.render_preview(small, params)
        png = engine_py.encode_png(result)

    return Response(content=png, media_type="image/png", headers={"X-Engine": engine})


@app.post("/api/render")
def render(request: RenderRequest) -> dict[str, Any]:
    path = _upload_path(request.upload_id)
    job = _jobs.create(upload_id=request.upload_id)
    _pool.submit(_run_render, job["id"], str(path), request.input_encoding, request.payload)
    return job


@app.get("/api/jobs/{job_id}")
def job_status(job_id: str) -> dict[str, Any]:
    if not _jobs.exists(job_id):
        raise HTTPException(status_code=404, detail="unknown job")
    return _jobs.get(job_id)


@app.get("/api/jobs")
def job_list() -> list[dict[str, Any]]:
    return _jobs.list_recent()


@app.get("/api/files/{name}")
def download(name: str) -> FileResponse:
    safe = os.path.basename(name)
    path = OUTPUT_DIR / safe
    if not path.is_file():
        raise HTTPException(status_code=404, detail="not found")
    return FileResponse(str(path), filename=safe, media_type="image/tiff")


def _run_render(job_id: str, path: str, encoding: str, payload: dict[str, Any]) -> None:
    _jobs.update(job_id, status="running")
    try:
        params = _params(payload)
        image = engine_py.load_input(
            path, input_encoding=encoding, target_space=params.io.input_color_space,
        )
        result = engine_py.render_full(image, params)
        name = f"spektrafilm-{job_id}.tif"
        engine_py.write_tiff(str(OUTPUT_DIR / name), result, params)
        _jobs.update(job_id, status="done", output=name, finished=time.time())
    except Exception as exc:
        _jobs.update(job_id, status="failed", error=str(exc), finished=time.time())


def _gpu_preview(image, params, payload: dict[str, Any]) -> bytes | None:
    """Render through the Rust CLI; returns None when it is unusable."""
    film = str(payload.get("film") or param_mod.DEFAULT_FILM)
    paper = payload.get("print") or None
    tmp_in = TMP_DIR / f"{uuid.uuid4().hex}-in.tif"
    tmp_out = TMP_DIR / f"{uuid.uuid4().hex}-out.png"
    try:
        engine_py.write_linear_tiff(str(tmp_in), image, params.io.input_color_space)
        rs_params = param_mod.to_rs_params(params)
        rs_params.setdefault("io", {}).update({
            "input_color_space": params.io.input_color_space,
            "input_cctf_decoding": False,
            "output_color_space": params.io.output_color_space,
            "output_cctf_encoding": params.io.output_cctf_encoding,
            "upscale_factor": 1.0,
            "scan_film": params.io.scan_film,
        })
        rs_params.setdefault("settings", {}).update({"preview_mode": False})
        engine_rs.render(
            str(tmp_in), str(tmp_out),
            film=film, paper=str(paper) if paper else None,
            params_json=rs_params,
        )
        return tmp_out.read_bytes()
    except Exception:
        return None
    finally:
        tmp_in.unlink(missing_ok=True)
        tmp_out.unlink(missing_ok=True)


def _params(payload: dict[str, Any]):
    try:
        return param_mod.build_params(payload)
    except KeyError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:
        raise HTTPException(status_code=400, detail=f"invalid parameters: {exc}") from exc


def _upload_path(upload_id: str) -> Path:
    if not _UPLOAD_ID.match(upload_id):
        raise HTTPException(status_code=400, detail="bad upload id")
    matches = list(UPLOAD_DIR.glob(f"{upload_id}.*"))
    if not matches:
        raise HTTPException(status_code=404, detail="upload expired")
    return matches[0]
