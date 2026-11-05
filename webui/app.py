"""FastAPI app: batch upload, GPU previews and a persistent results library.

Preview requests read a cached, downscaled linear-ACES TIFF (decoded once at
upload), so slider moves stay fast even for 20 MP JPEGs or camera RAW files.
Exports run sequentially in one worker; results are written to /data/outputs
with a JSON sidecar so the gallery survives container restarts.
"""

from __future__ import annotations

import json
import os
import re
import time
import uuid
import zipfile
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import Any

from fastapi import FastAPI, HTTPException, UploadFile, File, Form
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
PRESET_DIR = DATA_DIR / "presets"
STATIC_DIR = Path(__file__).resolve().parent / "static"

for directory in (UPLOAD_DIR, OUTPUT_DIR, TMP_DIR, JOB_DIR, PRESET_DIR):
    directory.mkdir(parents=True, exist_ok=True)

MAX_UPLOAD_BYTES = int(os.environ.get("SPEKTRAFILM_MAX_UPLOAD_MB", "256")) * 1024 * 1024
_UPLOAD_ID = re.compile(r"^[0-9a-f]{32}$")
_SAFE_NAME = re.compile(r"[^A-Za-z0-9_.-]+")
# Preset names are display strings, not file names: keep CJK, strip only
# path separators / control characters.
_UNSAFE_PRESET_NAME = re.compile(r"[/\\\x00-\x1f<>:\"|?*]+")

# Curated starting points; user presets live in /data/presets/*.json.
BUILTIN_PRESETS = [
    {"id": "builtin-portra", "name": "Portra 400 · 标准",
     "payload": {"film": "kodak_portra_400", "print": "kodak_portra_endura",
                 "values": {}, "extra": {}}, "builtin": True},
    {"id": "builtin-gold", "name": "Gold 200 · 暖调高饱和",
     "payload": {"film": "kodak_gold_200", "print": "fujifilm_crystal_archive_typeii",
                 "values": {"camera.exposure_compensation_ev": 0.5,
                            "film_render.grain.particle_area_um2": 0.5},
                 "extra": {}}, "builtin": True},
    {"id": "builtin-slide", "name": "Velvia 100 · 反转片",
     "payload": {"film": "fujifilm_velvia_100", "print": "kodak_portra_endura",
                 "values": {"io.scan_film": True}, "extra": {}}, "builtin": True},
    {"id": "builtin-soft", "name": "柔光 · 扩散滤镜",
     "payload": {"film": "kodak_portra_400", "print": "kodak_portra_endura",
                 "values": {"camera.diffusion_filter.active": True,
                            "camera.diffusion_filter.filter_family": "black_pro_mist",
                            "camera.diffusion_filter.strength": 0.5},
                 "extra": {}}, "builtin": True},
]

app = FastAPI(title="spektrafilm", docs_url=None, redoc_url=None)
app.mount("/static", StaticFiles(directory=str(STATIC_DIR)), name="static")

_jobs = JobStore(str(JOB_DIR))
INTERRUPTED = _jobs.reconcile()
_pool = ThreadPoolExecutor(max_workers=1, thread_name_prefix="render")


class PreviewRequest(BaseModel):
    upload_id: str
    rotation: int = 0
    payload: dict[str, Any]


class RenderRequest(BaseModel):
    upload_ids: list[str]
    rotation: int = 0
    rotations: dict[str, int] = {}   # per-image override (rotation follows the image)
    payload: dict[str, Any]
    mode: str = "gpu"          # gpu (fast) | cpu (f64 reference)
    max_edge: int = 2400


class PresetRequest(BaseModel):
    name: str
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
        "max_pixels": engine_py.MAX_PIXELS,
        "preview_edge": engine_py.PREVIEW_EDGE,
        "preview_size": param_mod.PREVIEW_QUALITY_SIZE,
        "interrupted_jobs": INTERRUPTED,
    }


@app.get("/api/manifest")
def manifest() -> dict[str, Any]:
    return param_mod.manifest()


@app.get("/api/presets")
def presets() -> list[dict[str, Any]]:
    out = list(BUILTIN_PRESETS)
    for path in PRESET_DIR.glob("*.json"):
        try:
            out.append(json.loads(path.read_text(encoding="utf-8")))
        except (OSError, json.JSONDecodeError):
            continue
    out.sort(key=lambda item: (not item.get("builtin"), item.get("name", "")))
    return out


@app.post("/api/presets")
def save_preset(body: PresetRequest) -> dict[str, Any]:
    name = _UNSAFE_PRESET_NAME.sub("_", body.name.strip())[:60]
    if not name:
        raise HTTPException(status_code=400, detail="preset name required")
    entry = {
        "id": uuid.uuid4().hex[:12], "name": name,
        "payload": body.payload, "created": time.time(), "builtin": False,
    }
    (PRESET_DIR / f"{entry['id']}.json").write_text(
        json.dumps(entry), encoding="utf-8")
    return entry


@app.delete("/api/presets/{preset_id}")
def delete_preset(preset_id: str) -> dict[str, Any]:
    safe = "".join(ch for ch in preset_id if ch.isalnum() or ch in "-_")
    path = PRESET_DIR / f"{safe}.json"
    if not path.is_file():
        raise HTTPException(status_code=404, detail="preset not found")
    path.unlink()
    return {"deleted": safe}


@app.post("/api/rotation/{upload_id}")
def set_upload_rotation(upload_id: str, rotation: int = 0) -> dict[str, Any]:
    """Rotation belongs to the image, not to the viewer's global state."""
    meta = _meta(upload_id)
    meta["rotation"] = int(rotation) % 4
    (UPLOAD_DIR / f"{_check_id(upload_id)}.meta.json").write_text(
        json.dumps(meta), encoding="utf-8")
    return meta


@app.get("/api/uploads")
def uploads() -> list[dict[str, Any]]:
    """Restores the upload strip after a page reload."""
    out = []
    for meta in UPLOAD_DIR.glob("*.meta.json"):
        try:
            out.append(json.loads(meta.read_text(encoding="utf-8")))
        except (OSError, json.JSONDecodeError):
            continue
    out.sort(key=lambda item: item.get("created", 0), reverse=True)
    return out


@app.get("/api/view/{upload_id}")
def view(upload_id: str, rotation: int = 0) -> FileResponse:
    """The unprocessed ('before') view, rotated server-side to match the render.

    Keeping both halves of the comparison on the server avoids a client-side
    race where a fast rotate click could leave the original unrotated.
    """
    upload_id = _check_id(upload_id)
    k = int(rotation) % 4
    if k == 0:
        path = UPLOAD_DIR / f"{upload_id}.view.png"
        if not path.is_file():
            raise HTTPException(status_code=404, detail="view not found")
        return FileResponse(str(path), media_type="image/png")

    rotated = UPLOAD_DIR / f"{upload_id}.view.{k}.png"
    if not rotated.is_file():
        image = engine_py.load_cached(str(_cache_path(upload_id)))
        image = engine_py.rotate(image, k)
        rotated.write_bytes(engine_py.display_png(image))
    return FileResponse(str(rotated), media_type="image/png")


@app.post("/api/upload")
async def upload(
    files: list[UploadFile] = File(...),
    input_encoding: str = Form("auto"),
    source_space: str = Form(engine_py.DEFAULT_SOURCE_SPACE),
) -> dict[str, Any]:
    items = []
    for file in files:
        ext = os.path.splitext(file.filename or "")[1].lower()
        if ext not in engine_py.SUPPORTED_EXTENSIONS:
            raise HTTPException(status_code=400,
                                detail=f"unsupported file type: {ext or 'none'} ({file.filename})")

        upload_id = uuid.uuid4().hex
        target = UPLOAD_DIR / f"{upload_id}{ext}"
        written = 0
        with target.open("wb") as handle:
            while chunk := await file.read(1 << 20):
                written += len(chunk)
                if written > MAX_UPLOAD_BYTES:
                    handle.close()
                    target.unlink(missing_ok=True)
                    raise HTTPException(status_code=413, detail=f"{file.filename} too large")
                handle.write(chunk)

        try:
            image = engine_py.decode_source(
                str(target), input_encoding=input_encoding,
                source_space=source_space, max_edge=engine_py.PREVIEW_EDGE,
            )
            engine_py.write_linear_tiff(str(UPLOAD_DIR / f"{upload_id}.src.tif"), image)
            (UPLOAD_DIR / f"{upload_id}.view.png").write_bytes(engine_py.display_png(image))
        except Exception as exc:
            for suffix in ("", ".src.tif", ".view.png"):
                (UPLOAD_DIR / f"{upload_id}{suffix}").unlink(missing_ok=True)
            raise HTTPException(status_code=400,
                                detail=f"cannot decode {file.filename}: {exc}") from exc

        meta = {
            "id": upload_id,
            "name": file.filename,
            "bytes": written,
            "raw": ext in engine_py.RAW_EXTENSIONS,
            "input_encoding": input_encoding,
            "source_space": source_space,
            "rotation": 0,
            "created": time.time(),
            **engine_py.describe(image),
        }
        (UPLOAD_DIR / f"{upload_id}.meta.json").write_text(
            json.dumps(meta), encoding="utf-8")
        items.append(meta)
    return {"items": items}


@app.post("/api/preview")
def preview(request: PreviewRequest) -> Response:
    params = _params(request.payload)
    image = engine_py.load_cached(str(_cache_path(request.upload_id)))
    image = engine_py.rotate(image, request.rotation)
    image = engine_py.downscale(image, int(params.settings.preview_max_size))

    engine = "python-cpu"
    png = None
    if engine_rs.available():
        png = _gpu_preview(image, params, request.payload)
        if png is not None:
            engine = "wgpu-vulkan"
    if png is None:
        png = engine_py.encode_png(
            engine_py.render_preview(image.astype("float64"), params))
    return Response(content=png, media_type="image/png",
                    headers={"X-Engine": engine})


@app.post("/api/render")
def render(request: RenderRequest) -> dict[str, Any]:
    if not request.upload_ids:
        raise HTTPException(status_code=400, detail="no images selected")
    mode = "gpu" if request.mode == "gpu" and engine_rs.available() else "cpu"
    max_edge = max(640, min(int(request.max_edge), 6000))
    rotation = int(request.rotation) % 4
    jobs = []
    for upload_id in request.upload_ids:
        meta = _meta(upload_id)
        image_rotation = int(request.rotations.get(upload_id, rotation)) % 4
        job = _jobs.create(upload_id=upload_id, source=meta["name"],
                           rotation=image_rotation, mode=mode,
                           engine=("wgpu-f32" if mode == "gpu" else "python-f64"))
        jobs.append(job)
        _pool.submit(_run_render, job["id"], upload_id, image_rotation,
                     request.payload, mode, max_edge)
    return {"jobs": jobs, "mode": mode}


@app.get("/api/jobs/{job_id}")
def job_status(job_id: str) -> dict[str, Any]:
    if not _jobs.exists(job_id):
        raise HTTPException(status_code=404, detail="unknown job")
    job = _jobs.get(job_id)
    if job.get("status") in {"queued", "running"}:
        job["elapsed"] = round(time.time() - job["created"], 1)
        active = sorted(
            (entry for entry in _jobs.list_recent(limit=1000)
             if entry.get("status") in {"queued", "running"}),
            key=lambda entry: entry.get("created", 0))
        for index, entry in enumerate(active, start=1):
            if entry["id"] == job_id:
                job["queue_position"] = index
                job["queue_total"] = len(active)
                break
    return job


@app.get("/api/jobs")
def job_list() -> list[dict[str, Any]]:
    return _jobs.list_recent(limit=50)


@app.get("/api/results")
def results() -> list[dict[str, Any]]:
    out = []
    for sidecar in OUTPUT_DIR.glob("*.json"):
        try:
            item = json.loads(sidecar.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            continue
        path = OUTPUT_DIR / item["name"]
        if not path.is_file():
            continue
        item["size"] = path.stat().st_size
        item["download"] = f"/api/files/{item['name']}"
        out.append(item)
    out.sort(key=lambda item: item.get("created", 0), reverse=True)
    return out


@app.get("/api/files/{name}")
def download(name: str) -> FileResponse:
    path = OUTPUT_DIR / os.path.basename(name)
    if not path.is_file():
        raise HTTPException(status_code=404, detail="not found")
    media = "image/png" if path.suffix.lower() == ".png" else "image/tiff"
    return FileResponse(str(path), filename=path.name, media_type=media)


@app.get("/api/result-thumb/{name}")
def result_thumb(name: str) -> Response:
    """Browser-displayable preview of a result (TIFFs are not renderable)."""
    path = OUTPUT_DIR / os.path.basename(name)
    if not path.is_file():
        raise HTTPException(status_code=404, detail="not found")
    if path.suffix.lower() == ".png":
        return FileResponse(str(path), media_type="image/png")
    image = engine_py.load_cached(str(path))
    image = engine_py.downscale(image, 480)
    return Response(content=engine_py.encode_png(image), media_type="image/png")


@app.get("/api/download-all")
def download_all() -> FileResponse:
    files = [p for p in OUTPUT_DIR.iterdir()
             if p.suffix.lower() in {".png", ".tif", ".tiff"}]
    if not files:
        raise HTTPException(status_code=404, detail="no results yet")
    archive = TMP_DIR / "spektrafilm-results.zip"
    with zipfile.ZipFile(archive, "w", zipfile.ZIP_DEFLATED, compresslevel=3) as bundle:
        for path in files:
            bundle.write(path, path.name)
    return FileResponse(str(archive), filename="spektrafilm-results.zip",
                        media_type="application/zip")


def _run_render(job_id: str, upload_id: str, rotation: int,
                payload: dict[str, Any], mode: str, max_edge: int) -> None:
    started = time.time()
    stem = ""
    try:
        _jobs.update(job_id, status="running", stage="解码", progress=10)
        meta = _meta(upload_id)
        image = engine_py.decode_source(
            str(_original_path(upload_id)),
            input_encoding=meta.get("input_encoding", "auto"),
            source_space=meta.get("source_space", engine_py.DEFAULT_SOURCE_SPACE),
            max_edge=max_edge, allow_half_raw=False,
        )
        image = engine_py.rotate(image, rotation)
        params = _params(payload)
        _jobs.update(job_id, stage="准备渲染", progress=35)

        safe_source = _SAFE_NAME.sub("_", Path(meta["name"]).stem)[:60]
        stem = f"spektrafilm-{safe_source}-{job_id}"
        tmp_in = TMP_DIR / f"{uuid.uuid4().hex}.tif"

        if mode == "gpu":
            _jobs.update(job_id, stage="GPU 渲染", progress=55)
            engine_py.write_linear_tiff(str(tmp_in), image)
            engine_rs.render(
                str(tmp_in), str(OUTPUT_DIR / f"{stem}.png"),
                film=str(payload.get("film") or param_mod.DEFAULT_FILM),
                paper=str(payload.get("print") or param_mod.DEFAULT_PRINT),
                params_json=_rs_params(params),
            )
            name = f"{stem}.png"
        else:
            _jobs.update(job_id, stage="f64 计算（CPU 满核，可能较慢）", progress=45)
            result = engine_py.render_full(image.astype("float64"), params)
            _jobs.update(job_id, stage="保存", progress=90)
            name = f"{stem}.tif"
            engine_py.write_tiff(str(OUTPUT_DIR / name), result, params)
        tmp_in.unlink(missing_ok=True)
        _jobs.update(job_id, stage="写入结果", progress=95)

        (OUTPUT_DIR / f"{stem}.json").write_text(json.dumps({
            "name": name,
            "source": meta["name"],
            "mode": mode,
            "engine": "wgpu-f32" if mode == "gpu" else "python-f64",
            "width": int(image.shape[1]),
            "height": int(image.shape[0]),
            "created": time.time(),
            "duration": round(time.time() - started, 1),
            "upload_id": upload_id,
        }), encoding="utf-8")
        _jobs.update(job_id, status="done", output=name, stage="完成",
                     progress=100, finished=time.time(),
                     duration=round(time.time() - started, 1))
    except Exception as exc:
        if stem:
            (OUTPUT_DIR / f"{stem}.png").unlink(missing_ok=True)
            (OUTPUT_DIR / f"{stem}.tif").unlink(missing_ok=True)
        _jobs.update(job_id, status="failed", stage="失败", progress=0,
                     error=str(exc), finished=time.time())


def _gpu_preview(image, params, payload: dict[str, Any]) -> bytes | None:
    tmp_in = TMP_DIR / f"{uuid.uuid4().hex}-in.tif"
    tmp_out = TMP_DIR / f"{uuid.uuid4().hex}-out.png"
    try:
        engine_py.write_linear_tiff(str(tmp_in), image)
        engine_rs.render(
            str(tmp_in), str(tmp_out),
            film=str(payload.get("film") or param_mod.DEFAULT_FILM),
            paper=str(payload.get("print") or param_mod.DEFAULT_PRINT),
            params_json=_rs_params(params),
        )
        return tmp_out.read_bytes()
    except Exception:
        return None
    finally:
        tmp_in.unlink(missing_ok=True)
        tmp_out.unlink(missing_ok=True)


def _rs_params(params) -> dict[str, Any]:
    rs_params = param_mod.to_rs_params(params)
    rs_params.setdefault("io", {}).update({
        "input_color_space": engine_py.CANONICAL_SPACE,
        "input_cctf_decoding": False,
        "output_color_space": params.io.output_color_space,
        "output_cctf_encoding": params.io.output_cctf_encoding,
        "upscale_factor": 1.0,
        "scan_film": params.io.scan_film,
    })
    rs_params.setdefault("settings", {}).update({"preview_mode": False})
    return rs_params


def _params(payload: dict[str, Any]):
    try:
        return param_mod.build_params(payload)
    except KeyError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:
        raise HTTPException(status_code=400, detail=f"invalid parameters: {exc}") from exc


def _meta(upload_id: str) -> dict[str, Any]:
    path = UPLOAD_DIR / f"{_check_id(upload_id)}.meta.json"
    if not path.is_file():
        raise HTTPException(status_code=404, detail="upload expired")
    return json.loads(path.read_text(encoding="utf-8"))


def _cache_path(upload_id: str) -> Path:
    path = UPLOAD_DIR / f"{_check_id(upload_id)}.src.tif"
    if not path.is_file():
        raise HTTPException(status_code=404, detail="preview cache missing")
    return path


def _original_path(upload_id: str) -> Path:
    uid = _check_id(upload_id)
    matches = [p for p in UPLOAD_DIR.glob(f"{uid}.*")
               if p.name not in {f"{uid}.src.tif", f"{uid}.meta.json",
                                 f"{uid}.view.png"}
               and not p.name.startswith(f"{uid}.view.")]
    if not matches:
        raise HTTPException(status_code=404, detail="original file missing")
    return matches[0]


def _check_id(upload_id: str) -> str:
    if not _UPLOAD_ID.match(upload_id):
        raise HTTPException(status_code=400, detail="bad upload id")
    return upload_id
