"""Parameter manifest and translation between the web UI payload and
``RuntimePhotoParams``.

The upstream runtime exposes ~100 knobs across eleven dataclasses. Hand-writing
a form for all of them is neither pleasant nor useful, so the UI ships a curated
manifest (the knobs that actually change the look) and accepts an optional
``extra`` dict of raw dotted paths for everything else.
"""

from __future__ import annotations

from dataclasses import fields, is_dataclass
from typing import Any

from spektrafilm.model.diffusion import DIFFUSION_FILTER_FAMILIES
from spektrafilm.profiles.io import load_profile, list_profiles
from spektrafilm.runtime.params_builder import init_params
from spektrafilm.runtime.params_schema import RuntimePhotoParams

DEFAULT_FILM = "kodak_portra_400"
DEFAULT_PRINT = "kodak_portra_endura"

# Groups are rendered in this order.
GROUPS: list[tuple[str, str]] = [
    ("camera", "相机 / 曝光的胶片"),
    ("enlarger", "放大机 / 印相"),
    ("render", "胶片渲染（颗粒 / 光晕 / 眩光）"),
    ("scanner", "扫描与输出"),
    ("io", "输入输出"),
    ("settings", "性能与精度"),
]

# path, label, kind, min, max, step, group
# kind is one of: float, int, bool, select, vec2, vec3
MANIFEST: list[dict[str, Any]] = [
    # --- camera -------------------------------------------------------
    {"path": "camera.exposure_compensation_ev", "label": "胶片曝光补偿 (EV)",
     "kind": "float", "min": -4.0, "max": 4.0, "step": 0.1, "group": "camera"},
    {"path": "camera.auto_exposure", "label": "自动曝光",
     "kind": "bool", "group": "camera"},
    {"path": "camera.film_format_mm", "label": "画幅 (mm)",
     "kind": "float", "min": 4.0, "max": 240.0, "step": 1.0, "group": "camera"},
    {"path": "camera.lens_blur_um", "label": "镜头模糊 (µm)",
     "kind": "float", "min": 0.0, "max": 80.0, "step": 0.5, "group": "camera"},
    {"path": "camera.diffusion_filter.active", "label": "扩散滤镜",
     "kind": "bool", "group": "camera"},
    {"path": "camera.diffusion_filter.filter_family", "label": "扩散滤镜类型",
     "kind": "select", "group": "camera", "options": None},  # filled from DIFFUSION_FILTER_FAMILIES
    {"path": "camera.diffusion_filter.strength", "label": "扩散强度 (档)",
     "kind": "float", "min": 0.0, "max": 2.0, "step": 0.125, "group": "camera"},
    {"path": "camera.diffusion_filter.halo_warmth", "label": "扩散暖调偏置",
     "kind": "float", "min": -1.0, "max": 1.0, "step": 0.05, "group": "camera"},

    # --- enlarger -----------------------------------------------------
    {"path": "enlarger.print_exposure", "label": "印相曝光",
     "kind": "float", "min": 0.2, "max": 3.0, "step": 0.02, "group": "enlarger"},
    {"path": "enlarger.y_filter_shift", "label": "黄滤镜偏移 (Y)",
     "kind": "float", "min": -60.0, "max": 60.0, "step": 1.0, "group": "enlarger"},
    {"path": "enlarger.m_filter_shift", "label": "品红滤镜偏移 (M)",
     "kind": "float", "min": -60.0, "max": 60.0, "step": 1.0, "group": "enlarger"},
    {"path": "enlarger.preflash_exposure", "label": "预闪曝光",
     "kind": "float", "min": 0.0, "max": 1.0, "step": 0.01, "group": "enlarger"},
    {"path": "enlarger.lens_blur", "label": "放大镜头模糊",
     "kind": "float", "min": 0.0, "max": 20.0, "step": 0.1, "group": "enlarger"},
    {"path": "enlarger.diffusion_filter.active", "label": "放大机扩散滤镜",
     "kind": "bool", "group": "enlarger"},
    {"path": "enlarger.diffusion_filter.strength", "label": "放大机扩散强度",
     "kind": "float", "min": 0.0, "max": 2.0, "step": 0.125, "group": "enlarger"},

    # --- film render --------------------------------------------------
    {"path": "film_render.grain.active", "label": "颗粒",
     "kind": "bool", "group": "render"},
    {"path": "film_render.grain.sublayers_active", "label": "多层颗粒",
     "kind": "bool", "group": "render"},
    {"path": "film_render.grain.particle_area_um2", "label": "颗粒面积 (µm²)",
     "kind": "float", "min": 0.05, "max": 3.2, "step": 0.05, "group": "render"},
    {"path": "film_render.grain.blur", "label": "颗粒扩散",
     "kind": "float", "min": 0.0, "max": 2.0, "step": 0.05, "group": "render"},
    {"path": "film_render.halation.active", "label": "光晕 (halation)",
     "kind": "bool", "group": "render"},
    {"path": "film_render.halation.scatter_amount", "label": "散射量",
     "kind": "float", "min": 0.0, "max": 3.0, "step": 0.05, "group": "render"},
    {"path": "film_render.halation.halation_amount", "label": "光晕量",
     "kind": "float", "min": 0.0, "max": 3.0, "step": 0.05, "group": "render"},
    {"path": "film_render.halation.boost_ev", "label": "高光重建 (EV)",
     "kind": "float", "min": 0.0, "max": 3.0, "step": 0.1, "group": "render"},
    {"path": "film_render.dir_couplers.active", "label": "DIR 抑制耦合剂",
     "kind": "bool", "group": "render"},
    {"path": "film_render.dir_couplers.amount", "label": "耦合强度",
     "kind": "float", "min": 0.0, "max": 2.0, "step": 0.05, "group": "render"},
    {"path": "film_render.glare.active", "label": "胶片眩光",
     "kind": "bool", "group": "render"},
    {"path": "film_render.glare.percent", "label": "眩光比例",
     "kind": "float", "min": 0.0, "max": 0.3, "step": 0.005, "group": "render"},

    # --- scanner ------------------------------------------------------
    {"path": "scanner.lens_blur", "label": "扫描镜头模糊",
     "kind": "float", "min": 0.0, "max": 10.0, "step": 0.1, "group": "scanner"},
    {"path": "scanner.unsharp_mask", "label": "锐化 (半径/强度)",
     "kind": "vec2", "min": 0.0, "max": 3.0, "step": 0.05, "group": "scanner"},
    {"path": "scanner.black_level", "label": "黑场",
     "kind": "float", "min": 0.0, "max": 0.1, "step": 0.002, "group": "scanner"},
    {"path": "scanner.white_level", "label": "白场",
     "kind": "float", "min": 0.8, "max": 1.0, "step": 0.005, "group": "scanner"},

    # --- io -----------------------------------------------------------
    {"path": "io.scan_film", "label": "输出虚拟负片（不印相）",
     "kind": "bool", "group": "io"},
    {"path": "io.upscale_factor", "label": "输出放大倍数",
     "kind": "float", "min": 0.25, "max": 4.0, "step": 0.25, "group": "io"},
    {"path": "io.output_color_space", "label": "输出色彩空间",
     "kind": "select", "group": "io",
     "options": ["sRGB", "Display P3", "ITU-R BT.2020", "ProPhoto RGB", "Adobe RGB (1998)"]},

    # --- settings -----------------------------------------------------
    {"path": "settings.use_enlarger_lut", "label": "印相 LUT 近似（更快）",
     "kind": "bool", "group": "settings"},
    {"path": "settings.use_scanner_lut", "label": "扫描 LUT 近似（更快）",
     "kind": "bool", "group": "settings"},
    {"path": "settings.preview_max_size", "label": "预览长边 (px)",
     "kind": "int", "min": 320, "max": 2048, "step": 64, "group": "settings"},
]

_SKIP_RS_FIELDS = {"film", "print", "debug", "taps"}
# Groups the free-form "extra" JSON may address; film/print stay dropdown-only.
_EXTRA_ROOTS = {"camera", "enlarger", "scanner", "film_render", "print_render",
                "io", "settings", "debug"}
# Nested specs whose Rust counterpart has a different shape; the UI never edits
# them, so they are left at the Rust defaults instead of risking a decode error.
_RS_DENY = {"input_gamut_compress", "output_gamut_compress", "density_curves_morph"}


def profile_options() -> dict[str, list[dict[str, Any]]]:
    """Film and paper entries for the UI dropdowns."""
    films: list[dict[str, Any]] = []
    papers: list[dict[str, Any]] = []
    for slug in list_profiles():
        try:
            info = load_profile(slug).info
        except Exception:  # unreadable profile: skip rather than 500 the page
            continue
        entry = {
            "slug": slug,
            "stock": getattr(info, "stock", slug),
            "label": getattr(info, "name", None) or slug.replace("_", " ").title(),
            "type": getattr(info, "type", "negative"),
            "target_print": getattr(info, "target_print", None),
        }
        if getattr(info, "support", "film") == "paper":
            papers.append(entry)
        else:
            films.append(entry)
    films.sort(key=lambda e: e["stock"])
    papers.sort(key=lambda e: e["stock"])
    return {"films": films, "papers": papers}


def default_payload() -> dict[str, Any]:
    params = init_params(DEFAULT_FILM, DEFAULT_PRINT)
    values: dict[str, Any] = {}
    for item in MANIFEST:
        value = _get_path(params, item["path"])
        values[item["path"]] = list(value) if isinstance(value, tuple) else value
    return {
        "film": DEFAULT_FILM,
        "print": DEFAULT_PRINT,
        "values": values,
        "extra": {},
    }


def manifest() -> dict[str, Any]:
    families = list(DIFFUSION_FILTER_FAMILIES)
    for item in MANIFEST:
        if item.get("options") is None:
            item["options"] = families
    return {
        "groups": [{"id": gid, "label": label} for gid, label in GROUPS],
        "controls": MANIFEST,
        "defaults": default_payload(),
        "profiles": profile_options(),
    }


def build_params(payload: dict[str, Any]) -> RuntimePhotoParams:
    """Turn the UI payload into a validated ``RuntimePhotoParams``."""
    film = str(payload.get("film") or DEFAULT_FILM)
    paper = str(payload.get("print") or DEFAULT_PRINT)
    params = init_params(film, paper)

    allowed = {item["path"] for item in MANIFEST}
    values = payload.get("values") or {}
    for path, value in values.items():
        if path not in allowed:
            continue
        _set_path(params, path, _coerce(_get_path(params, path), value))

    for path, value in (payload.get("extra") or {}).items():
        path = str(path)
        if path.split(".")[0] not in _EXTRA_ROOTS:
            raise KeyError(f"unknown parameter: {path}")
        _set_path(params, path, value)

    # Uploads are decoded once into canonical linear ACES; ignore any user
    # override so both engines see the same input space.
    params.io.input_color_space = "ACES2065-1"
    return params


def to_rs_params(params: RuntimePhotoParams) -> dict[str, Any]:
    """Project ``RuntimePhotoParams`` onto the JSON shape the Rust CLI reads.

    The Rust `RuntimeParams` mirrors the same field names and every field has a
    serde default, so unknown or non-primitive values are simply dropped.
    """
    out: dict[str, Any] = {}
    for group in fields(RuntimePhotoParams):
        if group.name in _SKIP_RS_FIELDS:
            continue
        plain = _plain(getattr(params, group.name))
        if plain:
            out[group.name] = plain
    return out


def _plain(value: Any) -> Any:
    if is_dataclass(value) and not isinstance(value, type):
        out: dict[str, Any] = {}
        for item in fields(value):
            if item.name in _RS_DENY:
                continue
            plain = _plain(getattr(value, item.name))
            if plain is not None:
                out[item.name] = plain
        return out
    if isinstance(value, tuple):
        if all(isinstance(v, (int, float)) and not isinstance(v, bool) for v in value):
            return [float(v) for v in value]
        return None
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float, str)):
        return value
    return None


def _get_path(obj: Any, path: str) -> Any:
    for part in path.split("."):
        obj = getattr(obj, part)
    return obj


def _set_path(obj: Any, path: str, value: Any) -> None:
    parts = path.split(".")
    for part in parts[:-1]:
        if not hasattr(obj, part):
            raise KeyError(f"unknown parameter: {path}")
        obj = getattr(obj, part)
    if not hasattr(obj, parts[-1]):
        raise KeyError(f"unknown parameter: {path}")
    setattr(obj, parts[-1], value)


def _coerce(current: Any, value: Any) -> Any:
    if isinstance(current, bool):
        return bool(value)
    if isinstance(current, int) and not isinstance(current, bool):
        return int(round(float(value)))
    if isinstance(current, float):
        return float(value)
    if isinstance(current, str):
        return str(value)
    if isinstance(current, tuple):
        items = list(value) if isinstance(value, (list, tuple)) else [value]
        return tuple(float(v) for v in items)
    return value
