"""Localhost web frontend for the DrafterFlow keychain generator.

Runs the existing pipeline (image_processing -> vectorize -> model_builder) behind
a small HTTP API and serves a static browser UI. The pipeline modules are reused
unchanged; this file is only a thin transport layer, so it can later be swapped for
a hosted backend without touching the conversion code.

Run with:  .venv/bin/python server.py   (then open http://127.0.0.1:8000)
"""
from __future__ import annotations

import base64
import ctypes
import gc
import threading
import hashlib
import re
import json
import os
import shutil
import tempfile
from pathlib import Path

import cv2
import numpy as np
import uvicorn
from fastapi import FastAPI, File, Form, HTTPException, Request, Response as FastAPIResponse, UploadFile
from fastapi.responses import FileResponse, JSONResponse, Response
from fastapi.staticfiles import StaticFiles

from color_layers import ColorLayerError, analyze_color_image, color_regions, resolve_color_layers
from export import export_stl
from image_processing import ImageProcessingError, extract_masks
from model_builder import ModelBuildError, build_color_layer_model, build_model, compute_default_hole
from vectorize import base_polygons, color_polygons
from project_store import (
    StoreError, authenticate, create_session, create_share, create_user, delete_project,
    delete_session, duplicate_project, get_community_project, get_owned_project,
    get_shared_project, init_db, list_community, list_projects, publish_project,
    remix_project, save_project, unpublish_project, user_for_session,
)

BASE_DIR = Path(__file__).resolve().parent
ASSET_REVISION = hashlib.sha256(b"".join(path.read_bytes() for path in sorted((BASE_DIR / "static").glob("*.js"))) + b"".join(path.read_bytes() for path in sorted((BASE_DIR / "static").glob("*.css")))).hexdigest()[:12]

app = FastAPI(title="DrafterFlow")

# Bound OpenCV's worker scratch space on the small production instance.
# This changes execution scheduling, not pixel assignment or geometry.
cv2.setNumThreads(1)
COLOR_PROCESSING_LOCK = threading.Lock()

def _release_color_scratch_memory():
    """Return unused analysis/vectorizer arenas before constructing the mesh."""
    gc.collect()
    try:
        trim = ctypes.CDLL(None).malloc_trim
        trim.argtypes = [ctypes.c_size_t]
        trim.restype = ctypes.c_int
        trim(0)
    except AttributeError:
        pass  # malloc_trim is available on the production Linux host, not macOS.



SESSION_COOKIE = "drafterflow_session"


@app.on_event("startup")
def _open_store():
    """Create the local SQLite schema without altering the conversion pipeline."""
    init_db()


def _current_user(request: Request):
    return user_for_session(request.cookies.get(SESSION_COOKIE))


def _require_user(request: Request):
    user = _current_user(request)
    if user is None:
        raise HTTPException(401, "Sign in to use this feature.")
    return user


def _require_account_storage():
    # Never accept real registrations into Render's disposable container layer.
    # Enable only after the operator attaches persistent storage and sets its path.
    if os.environ.get("RENDER") == "true" and (
        os.environ.get("DF_ACCOUNTS_ENABLED") != "1" or not os.environ.get("DF_DATABASE_PATH")
    ):
        raise HTTPException(503, "Account registration is waiting for persistent storage setup. Please try again later.")


def _store_error(error: StoreError):
    raise HTTPException(400, str(error)) from error


def _set_session(response: FastAPIResponse, token: str) -> None:
    # Local HTTP development deliberately stays usable; production can set
    # DF_COOKIE_SECURE=1 behind HTTPS.
    response.set_cookie(
        SESSION_COOKIE, token, max_age=60 * 60 * 24 * 30, httponly=True,
        samesite="lax", secure=os.environ.get("DF_COOKIE_SECURE") == "1", path="/",
    )

# Preview colours: these are the two "filaments" shown in the UI (the light base
# plate and the raised dark layer). The real print colour is chosen in the slicer.
BASE_RGB = (255, 255, 255)   # white -> base plate
COLOR_RGB = (43, 74, 124)    # ink-blue -> raised dark layer

# Example images offered as one-click sources. Mapped id -> (label, path).
EXAMPLES = {
    "nametag": ("Nametag", BASE_DIR / "examples" / "nametag.png"),
    "heart": ("Heart", BASE_DIR / "examples" / "heart.png"),
    "qban": ("Line art", BASE_DIR / "Q版测试.png"),
}
EXAMPLES = {k: v for k, v in EXAMPLES.items() if v[1].exists()}


def _num(value, default, name):
    """Parse a float form field, returning a clean error on bad input."""
    if value is None or str(value).strip() == "":
        return default
    try:
        return float(str(value))
    except ValueError:
        raise HTTPException(422, f"参数「{name}」必须是数字。")


def _int(value, default, name):
    if value is None or str(value).strip() == "":
        return default
    try:
        return int(float(str(value)))
    except ValueError:
        raise HTTPException(422, f"参数「{name}」必须是整数。")


def _mask_png(mask, rgb):
    """Render a binary mask as a transparent PNG (coloured where the mask is set)."""
    h, w = mask.shape
    rgba = np.zeros((h, w, 4), dtype=np.uint8)
    rgba[mask > 0] = (rgb[2], rgb[1], rgb[0], 255)  # cv2 expects BGR order
    ok, buf = cv2.imencode(".png", rgba)
    if not ok:
        raise HTTPException(500, "生成预览图失败。")
    return "data:image/png;base64," + base64.b64encode(buf.tobytes()).decode()


def _filled_base_mask(base_mask):
    """Fill the silhouette's outer contours into a solid plate.

    Mirrors what `vectorize.base_polygons` does, so the "base" preview shows the
    actual solid backing plate (not the raw line-art strokes).
    """
    m = (base_mask > 0).astype(np.uint8)
    contours, _ = cv2.findContours(m, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    filled = np.zeros_like(m)
    cv2.drawContours(filled, contours, -1, 1, thickness=cv2.FILLED)
    return filled


def _combined_png(base_mask, color_mask, base_rgb, color_rgb):
    """Overlay the two layers: base everywhere, colour on top where the dark art is."""
    h, w = base_mask.shape
    rgba = np.zeros((h, w, 4), dtype=np.uint8)
    rgba[base_mask > 0] = (base_rgb[2], base_rgb[1], base_rgb[0], 255)  # BGR
    rgba[color_mask > 0] = (color_rgb[2], color_rgb[1], color_rgb[0], 255)
    ok, buf = cv2.imencode(".png", rgba)
    if not ok:
        raise HTTPException(500, "生成预览图失败。")
    return "data:image/png;base64," + base64.b64encode(buf.tobytes()).decode()


def _hex_rgb(value, default):
    """Parse a '#rrggbb' (or 'rrggbb') hex colour, falling back to `default`."""
    if not value:
        return default
    v = str(value).strip().lstrip("#")
    if len(v) == 6:
        try:
            return tuple(int(v[i:i + 2], 16) for i in (0, 2, 4))
        except ValueError:
            pass
    return default


def _save_upload(data: bytes, tmpdir: str) -> str:
    """Write upload bytes to a temp PNG path and return it."""
    path = os.path.join(tmpdir, "upload.png")
    with open(path, "wb") as f:
        f.write(data)
    return path


def _color_layer_payload(result):
    """Make a ColorLayerAnalysis JSON-safe, including transparent mask previews."""
    palette = []
    for entry in result.palette:
        rgb = entry.rgb
        mask = entry.mask > 0
        # Keep edge coverage available to clients inspecting the palette;
        # background removal itself uses edge-connected regions in color_layers.
        edge_count = int(
            mask[0, :].sum() + mask[-1, :].sum() + mask[1:-1, 0].sum() + mask[1:-1, -1].sum()
        ) if mask.shape[0] > 1 and mask.shape[1] > 1 else int(mask.sum())
        palette.append({
            "id": entry.id,
            "rgb": list(rgb),
            "lab": [round(float(v), 4) for v in entry.lab],
            "hex": "#{:02x}{:02x}{:02x}".format(*rgb),
            "pixel_count": entry.pixel_count,
            "edge_pixel_count": edge_count,
            "mask_png": _mask_png(entry.mask, rgb),
        })
    regions, region_map = color_regions(result)
    packed = np.zeros((*region_map.shape, 4), dtype=np.uint8)
    packed[:, :, 2] = region_map & 255
    packed[:, :, 1] = (region_map >> 8) & 255
    packed[:, :, 0] = (region_map >> 16) & 255
    packed[:, :, 3] = 255
    ok, encoded = cv2.imencode(".png", packed)
    if not ok:
        raise HTTPException(500, "Could not create region selection preview.")
    return {
        "ok": True,
        "w_px": result.width_px,
        "h_px": result.height_px,
        "source_color_count": result.source_color_count,
        "pixel_size_mm": result.pixel_size_mm,
        "palette": palette,
        "background_id": result.background_id,
        "background_pixel_count": result.background_pixel_count,
        "background_removed": result.background_removed,
        "regions": regions,
        "region_map_png": "data:image/png;base64," + base64.b64encode(encoded.tobytes()).decode(),
    }


def _parse_color_palette(value):
    """Parse the ordered Color Layer palette submitted by the browser."""
    try:
        palette = json.loads(value)
    except (TypeError, ValueError) as exc:
        raise HTTPException(422, "Color layer palette is invalid.") from exc
    if not isinstance(palette, list):
        raise HTTPException(422, "Color layer palette must be a list.")
    return palette


# ---------- accounts and durable projects ----------
# The editor APIs below intentionally sit beside, rather than inside, the image
# pipeline. Guests can continue calling /api/analyze and /api/generate with no
# credential at all; persistence/social actions are the only protected routes.

@app.get("/api/auth/me")
def auth_me(request: Request):
    return {"user": _current_user(request)}


@app.post("/api/auth/signup")
def auth_signup(payload: dict, response: FastAPIResponse):
    _require_account_storage()
    try:
        user = create_user(payload.get("email", ""), payload.get("password", ""), payload.get("name"))
    except StoreError as error:
        _store_error(error)
    _set_session(response, create_session(user["id"]))
    return {"user": user}


@app.post("/api/auth/login")
def auth_login(payload: dict, response: FastAPIResponse):
    user = authenticate(payload.get("email", ""), payload.get("password", ""))
    if user is None:
        raise HTTPException(401, "Email or password is incorrect.")
    _set_session(response, create_session(user["id"]))
    return {"user": user}


@app.post("/api/auth/logout")
def auth_logout(request: Request, response: FastAPIResponse):
    delete_session(request.cookies.get(SESSION_COOKIE))
    response.delete_cookie(SESSION_COOKIE, path="/")
    return {"ok": True}


@app.get("/api/projects")
def projects_index(request: Request):
    return {"projects": list_projects(_require_user(request)["id"])}


@app.post("/api/projects")
def projects_create(payload: dict, request: Request):
    try:
        return {"project": save_project(_require_user(request)["id"], payload)}
    except StoreError as error:
        _store_error(error)


@app.get("/api/projects/{project_id}")
def projects_get(project_id: str, request: Request):
    project = get_owned_project(_require_user(request)["id"], project_id)
    if project is None:
        raise HTTPException(404, "Project not found.")
    return {"project": project}


@app.put("/api/projects/{project_id}")
def projects_update(project_id: str, payload: dict, request: Request):
    try:
        return {"project": save_project(_require_user(request)["id"], payload, project_id)}
    except StoreError as error:
        _store_error(error)


@app.delete("/api/projects/{project_id}")
def projects_delete(project_id: str, request: Request):
    if not delete_project(_require_user(request)["id"], project_id):
        raise HTTPException(404, "Project not found.")
    return {"ok": True}


@app.post("/api/projects/{project_id}/duplicate")
def projects_duplicate(project_id: str, request: Request):
    try:
        return {"project": duplicate_project(_require_user(request)["id"], project_id)}
    except StoreError as error:
        _store_error(error)


@app.post("/api/projects/{project_id}/share")
def projects_share(project_id: str, request: Request):
    try:
        return {"share": create_share(_require_user(request)["id"], project_id)}
    except StoreError as error:
        _store_error(error)


@app.post("/api/projects/{project_id}/publish")
def projects_publish(project_id: str, payload: dict, request: Request):
    try:
        return {"submission": publish_project(_require_user(request)["id"], project_id, payload)}
    except StoreError as error:
        _store_error(error)


@app.post("/api/projects/{project_id}/unpublish")
def projects_unpublish(project_id: str, request: Request):
    try:
        unpublish_project(_require_user(request)["id"], project_id)
    except StoreError as error:
        _store_error(error)
    return {"ok": True}


@app.get("/api/shared/{code}")
def shared_project(code: str):
    project = get_shared_project(code)
    if project is None:
        raise HTTPException(404, "This share link is unavailable.")
    return {"project": project}


@app.get("/api/community")
def community_index():
    return {"projects": list_community()}


@app.get("/api/community/{project_id}")
def community_get(project_id: str):
    project = get_community_project(project_id)
    if project is None:
        raise HTTPException(404, "Community project not found.")
    return {"project": project}


@app.post("/api/community/{project_id}/remix")
@app.post("/api/projects/{project_id}/remix")
def project_remix(project_id: str, request: Request):
    try:
        return {"project": remix_project(_require_user(request)["id"], project_id)}
    except StoreError as error:
        _store_error(error)


@app.get("/api/examples")
def list_examples():
    return [{"id": k, "name": v[0]} for k, v in EXAMPLES.items()]


@app.get("/api/examples/{example_id}")
def get_example(example_id: str):
    if example_id not in EXAMPLES:
        raise HTTPException(404, "示例不存在。")
    return FileResponse(EXAMPLES[example_id][1], media_type="image/png")


@app.post("/api/analyze")
async def analyze(
    file: UploadFile = File(...),
    dark_threshold: str = Form("100"),
    alpha_threshold: str = Form("8"),
    width: str = Form("50"),
    hole: str = Form("4"),
    base_color: str = Form("#ffffff"),
    color_color: str = Form("#2b4a7c"),
):
    """Return the base/colour masks as PNGs so the user can see what will be built."""
    data = await file.read()
    if not data:
        raise HTTPException(400, "上传内容为空。")

    dark = _int(dark_threshold, 100, "深色阈值")
    alpha = _int(alpha_threshold, 8, "透明阈值")
    width_mm = _num(width, 50.0, "宽度")
    hole_d = _num(hole, 4.0, "孔直径")
    base_rgb = _hex_rgb(base_color, BASE_RGB)
    color_rgb = _hex_rgb(color_color, COLOR_RGB)

    tmpdir = tempfile.mkdtemp(prefix="df_")
    try:
        path = _save_upload(data, tmpdir)
        try:
            base_mask, color_mask, (h_px, w_px) = extract_masks(path, alpha, dark)
        except ImageProcessingError as exc:
            return JSONResponse({"ok": False, "error": str(exc)}, status_code=400)

        filled_base = _filled_base_mask(base_mask)
        base_polys = base_polygons(base_mask)
        color_polys = color_polygons(color_mask)
        base_sum = int(filled_base.sum())
        color_sum = int(color_mask.sum())
        dark_ratio = round(color_sum / base_sum, 4) if base_sum else 0.0
        # Base silhouette exterior rings (pixel space, y-down) so the frontend can
        # judge whether a placed ring overlaps the base (printable) or floats outside.
        base_rings = []
        for poly in base_polys:
            for g in (getattr(poly, "geoms", [poly])):
                base_rings.append([[round(float(x), 2), round(float(y), 2)] for x, y in g.exterior.coords])
        default_hole = compute_default_hole(base_polys, color_polys, w_px, h_px, width_mm, hole_d)
        return {
            "ok": True,
            "w_px": w_px,
            "h_px": h_px,
            "base_png": _mask_png(filled_base, base_rgb),
            "color_png": _mask_png(color_mask, color_rgb),
            "combined_png": _combined_png(filled_base, color_mask, base_rgb, color_rgb),
            "dark_ratio": dark_ratio,
            "clearance_disabled": dark_ratio >= 0.85,
            "default_hole": [default_hole[0], default_hole[1]] if default_hole else None,
            "base_poly": base_rings,
        }
    finally:
        shutil.rmtree(tmpdir, ignore_errors=True)


@app.post("/api/color/analyze")
def analyze_color_layers(
    file: UploadFile = File(...),
    palette_size: str = Form("5"),
    alpha_threshold: str = Form("8"),
    cleanup_min_area: str = Form("0"),
    width: str = Form("80"),
    remove_background: bool = Form(False),
    palette: str | None = Form(None),
):
    """Quantize a flat illustration and return one inspectable mask per colour."""
    data = file.file.read()
    # Run in FastAPI's worker pool so health checks and assets remain responsive.
    # Serialize memory-heavy colour requests on the small shared instance.
    with COLOR_PROCESSING_LOCK:
        if not data:
            raise HTTPException(400, "Uploaded file is empty.")
        count = _int(palette_size, 5, "palette size")
        alpha = _int(alpha_threshold, 8, "alpha threshold")
        cleanup = _int(cleanup_min_area, 0, "cleanup size")
        width_mm = _num(width, 80.0, "model width")
        tmpdir = tempfile.mkdtemp(prefix="df_color_")
        try:
            path = _save_upload(data, tmpdir)
            try:
                result = analyze_color_image(
                    path,
                    palette_size=count,
                    alpha_threshold=alpha,
                    cleanup_min_area_px=cleanup,
                    width_mm=width_mm,
                    remove_background=remove_background,
                    palette=_parse_color_palette(palette) if palette else None,
                )
            except ColorLayerError as exc:
                return JSONResponse({"ok": False, "error": str(exc)}, status_code=400)
            return _color_layer_payload(result)
        finally:
            shutil.rmtree(tmpdir, ignore_errors=True)


@app.post("/api/generate")
async def generate(
    file: UploadFile = File(...),
    width: str = Form("50"),
    base: str = Form("4"),
    color: str = Form("2"),
    hole: str = Form("4"),
    hole_x: str | None = Form(None),
    hole_y: str | None = Form(None),
    tab_outer_radius: str | None = Form(None),
    holes: str | None = Form(None),  # JSON list of {x,y,outer} (multi-hole)
    dark_threshold: str = Form("100"),
    alpha_threshold: str = Form("8"),
):
    """Run the full pipeline and return the STL (binary) plus the hole centre."""
    data = await file.read()
    if not data:
        raise HTTPException(400, "上传内容为空。")

    width_mm = _num(width, 50.0, "宽度")
    base_th = _num(base, 4.0, "底板厚度")
    color_th = _num(color, 2.0, "深色层厚度")
    hole_d = _num(hole, 4.0, "孔直径")
    tab_r = _num(tab_outer_radius, None, "挂耳半径") if tab_outer_radius not in (None, "") else None
    dark = _int(dark_threshold, 100, "深色阈值")
    alpha = _int(alpha_threshold, 8, "透明阈值")

    hx = _num(hole_x, None, "孔位 X") if hole_x not in (None, "") else None
    hy = _num(hole_y, None, "孔位 Y") if hole_y not in (None, "") else None
    if (hx is None) != (hy is None):
        raise HTTPException(422, "孔位 X / Y 需要同时填写，或同时留空。")
    if tab_r is not None and hx is None:
        raise HTTPException(422, "已启用挂耳（外环），请同时提供孔位 X / Y。")

    holes_list = None
    if holes not in (None, ""):
        try:
            raw = json.loads(holes)
            holes_list = [
                (float(item[0]), float(item[1]), (float(item[2]) if len(item) > 2 and item[2] is not None else None))
                for item in raw
            ]
        except Exception:
            holes_list = None

    tmpdir = tempfile.mkdtemp(prefix="df_")
    try:
        path = _save_upload(data, tmpdir)
        try:
            base_mask, color_mask, (h_px, w_px) = extract_masks(path, alpha, dark)
            base_polys = base_polygons(base_mask)
            color_polys = color_polygons(color_mask)
            if holes_list is not None:
                mesh, hole_center = build_model(
                    base_polys, color_polys, w_px, h_px,
                    width_mm=width_mm, base_thickness=base_th, color_thickness=color_th,
                    hole_diameter=hole_d, holes=holes_list,
                )
            else:
                hole_position = (hx, hy) if hx is not None else None
                mesh, hole_center = build_model(
                    base_polys, color_polys, w_px, h_px,
                    width_mm=width_mm, base_thickness=base_th, color_thickness=color_th,
                    hole_diameter=hole_d, hole_position=hole_position, tab_outer_radius=tab_r,
                )
        except ImageProcessingError as exc:
            return JSONResponse({"ok": False, "error": str(exc)}, status_code=400)
        except ModelBuildError as exc:
            return JSONResponse({"ok": False, "error": str(exc)}, status_code=400)

        out_path = export_stl(mesh, os.path.join(tmpdir, "keychain"))
        with open(out_path, "rb") as f:
            stl_bytes = f.read()

        headers = {
            "Content-Disposition": 'attachment; filename="keychain.stl"',
        }
        if hole_center is not None:
            headers["X-Hole-Center"] = f"{hole_center[0]:.3f},{hole_center[1]:.3f}"
        return Response(stl_bytes, media_type="model/stl", headers=headers)
    finally:
        shutil.rmtree(tmpdir, ignore_errors=True)


@app.post("/api/color/generate")
def generate_color_layers(
    file: UploadFile = File(...),
    width: str = Form("80"),
    base: str = Form("0.4"),
    increment: str = Form("0.2"),
    alpha_threshold: str = Form("8"),
    cleanup_min_area: str = Form("0"),
    palette: str = Form(...),
    remove_background: bool = Form(False),
    layers: str | None = Form(None),
    base_hole: str | None = Form(None),
):
    """Build one STL from ordered flat-colour masks.

    Palette order is bottom-to-top. Ignored entries are excluded after assignment.
    Optional background removal clears exterior regions before tracing, preserving
    enclosed details of the same palette colour.
    """
    data = file.file.read()
    # Run in FastAPI's worker pool so health checks and assets remain responsive.
    # Serialize memory-heavy colour requests on the small shared instance.
    with COLOR_PROCESSING_LOCK:
        if not data:
            raise HTTPException(400, "Uploaded file is empty.")
        width_mm = _num(width, 80.0, "model width")
        base_thickness = _num(base, 0.4, "base thickness")
        height_increment = _num(increment, 0.2, "height increment")
        alpha = _int(alpha_threshold, 8, "alpha threshold")
        cleanup = _int(cleanup_min_area, 0, "cleanup size")
        submitted_palette = _parse_color_palette(palette)
        if any(not isinstance(item, dict) for item in submitted_palette):
            raise HTTPException(422, "Every color layer palette entry must be an object.")
        active_ids = {str(item.get("id")) for item in submitted_palette if not bool(item.get("ignored", False))}
        if not active_ids:
            raise HTTPException(422, "Enable at least one colour layer before generating.")

        tmpdir = tempfile.mkdtemp(prefix="df_color_")
        try:
            path = _save_upload(data, tmpdir)
            try:
                result = analyze_color_image(
                    path,
                    alpha_threshold=alpha,
                    cleanup_min_area_px=cleanup,
                    width_mm=width_mm,
                    # Keep the full palette during assignment. Passing only active
                    # colours made an ignored white background get re-labelled as a
                    # foreground colour, so "Ignore" previously changed the UI but
                    # not the printable geometry.
                    palette=submitted_palette,
                    remove_background=remove_background,
                )
                if layers is not None:
                    resolved = resolve_color_layers(result, _parse_color_palette(layers))
                    active_masks = [mask for _, mask in resolved]
                else:
                    active_masks = [entry.mask for entry in result.palette if entry.id in active_ids and entry.pixel_count > 0]
                if not active_masks:
                    raise ModelBuildError("No printable colour regions remain after cleanup.")
                thicknesses = None
                if layers is not None:
                    try:
                        thicknesses = [float(entry.get('height_mm') if entry.get('height_mm') is not None else height_increment) for entry, _ in resolved]
                    except (TypeError, ValueError):
                        raise ModelBuildError('Each colour layer height must be a valid number of millimetres.')
                base_mask = np.logical_or.reduce(active_masks).astype(np.uint8)
                base = base_polygons(base_mask)
                layer_polys = [color_polygons(mask) for mask in active_masks]
                hole = None
                if base_hole:
                    try:
                        hole = json.loads(base_hole)
                        if not isinstance(hole, dict) or any(key not in hole for key in ('x', 'y', 'diameter')):
                            raise ValueError()
                        hole = {key: float(hole[key]) for key in ('x', 'y', 'diameter')}
                        payload = json.loads(base_hole)
                        if payload.get('height') is not None:
                            hole['height'] = float(payload['height'])
                    except (TypeError, ValueError):
                        raise ModelBuildError('The base hole position or diameter is invalid.')
                image_width, image_height = result.width_px, result.height_px
                del result, active_masks, base_mask
                if layers is not None:
                    del resolved
                _release_color_scratch_memory()
                mesh, final_heights = build_color_layer_model(
                    base,
                    layer_polys,
                    image_width,
                    image_height,
                    width_mm=width_mm,
                    base_thickness=base_thickness,
                    height_increment=height_increment,
                    base_hole=hole,
                    layer_thicknesses=thicknesses,
                )
            except (ColorLayerError, ModelBuildError) as exc:
                return JSONResponse({"ok": False, "error": str(exc)}, status_code=400)
            except Exception as exc:
                # Do not expose an internal GEOS/mesh traceback in the editor. The
                # common topology cases are repaired in model_builder; this remains
                # a useful actionable fallback for an unexpected malformed image.
                return JSONResponse({"ok": False, "error": "Could not build this colour geometry. Try background removal or increase cleanup."}, status_code=400)

            out_path = export_stl(mesh, os.path.join(tmpdir, "color-layer-relief"))
            with open(out_path, "rb") as f:
                stl_bytes = f.read()
            height_text = ",".join(f"{v:.6f}" for v in final_heights)
            headers = {
                "Content-Disposition": 'attachment; filename="color-layer-relief.stl"',
                "X-Color-Layer-Heights": height_text,
            }
            return Response(stl_bytes, media_type="model/stl", headers=headers)
        finally:
            shutil.rmtree(tmpdir, ignore_errors=True)


# Static frontend (served last so the /api routes above win).
app.mount("/static", StaticFiles(directory=BASE_DIR / "static"), name="static")


@app.get("/")
def index():
    html = (BASE_DIR / "static" / "index.html").read_text()
    html = re.sub(r'(/static/(?:app\.js|style\.css|workspace\.css))(?:\?v=[^"]*)?"', lambda match: f'{match[1]}?v={ASSET_REVISION}"', html)
    return Response(html, media_type="text/html", headers={"Cache-Control": "no-cache"})


@app.get("/s/{share_code}")
def shared_page(share_code: str):
    """The client renders a read-only share preview after fetching its code."""
    return index()


if __name__ == "__main__":
    host = os.environ.get("DF_HOST", "127.0.0.1")  # container/cloud sets 0.0.0.0
    port = int(os.environ.get("PORT", os.environ.get("DF_PORT", "8000")))
    print(f"DrafterFlow → http://{host}:{port}")
    uvicorn.run(app, host=host, port=port)
