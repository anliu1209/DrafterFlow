"""Localhost web frontend for the fan-object (keychain) generator.

Runs the existing pipeline (image_processing -> vectorize -> model_builder) behind
a small HTTP API and serves a static browser UI. The pipeline modules are reused
unchanged; this file is only a thin transport layer, so it can later be swapped for
a hosted backend without touching the conversion code.

Run with:  .venv/bin/python server.py   (then open http://127.0.0.1:8000)
"""
from __future__ import annotations

import base64
import json
import os
import shutil
import tempfile
from pathlib import Path

import cv2
import numpy as np
import uvicorn
from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.responses import FileResponse, JSONResponse, Response
from fastapi.staticfiles import StaticFiles

from export import export_stl
from image_processing import ImageProcessingError, extract_masks
from model_builder import ModelBuildError, build_model
from vectorize import base_polygons, color_polygons

BASE_DIR = Path(__file__).resolve().parent

app = FastAPI(title="Fan Object Generator")

# Preview colours: these are the two "filaments" shown in the UI (the light base
# plate and the raised dark layer). The real print colour is chosen in the slicer.
BASE_RGB = (255, 255, 255)   # white -> base plate
COLOR_RGB = (37, 99, 235)    # blue -> raised dark layer

# Example images offered as one-click sources. Mapped id -> (label, path).
EXAMPLES = {
    "txt": ("Frame & text", BASE_DIR / "examples" / "txt.png"),
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
    base_color: str = Form("#ffffff"),
    color_color: str = Form("#2563eb"),
):
    """Return the base/colour masks as PNGs so the user can see what will be built."""
    data = await file.read()
    if not data:
        raise HTTPException(400, "上传内容为空。")

    dark = _int(dark_threshold, 100, "深色阈值")
    alpha = _int(alpha_threshold, 8, "透明阈值")
    base_rgb = _hex_rgb(base_color, BASE_RGB)
    color_rgb = _hex_rgb(color_color, COLOR_RGB)

    tmpdir = tempfile.mkdtemp(prefix="fog_")
    try:
        path = _save_upload(data, tmpdir)
        try:
            base_mask, color_mask, (h_px, w_px) = extract_masks(path, alpha, dark)
        except ImageProcessingError as exc:
            return JSONResponse({"ok": False, "error": str(exc)}, status_code=400)

        filled_base = _filled_base_mask(base_mask)
        base_sum = int(filled_base.sum())
        color_sum = int(color_mask.sum())
        dark_ratio = round(color_sum / base_sum, 4) if base_sum else 0.0
        # Base silhouette exterior rings (pixel space, y-down) so the frontend can
        # judge whether a placed ring overlaps the base (printable) or floats outside.
        base_rings = []
        for poly in base_polygons(base_mask):
            for g in (getattr(poly, "geoms", [poly])):
                base_rings.append([[round(float(x), 2), round(float(y), 2)] for x, y in g.exterior.coords])
        return {
            "ok": True,
            "w_px": w_px,
            "h_px": h_px,
            "base_png": _mask_png(filled_base, base_rgb),
            "color_png": _mask_png(color_mask, color_rgb),
            "combined_png": _combined_png(filled_base, color_mask, base_rgb, color_rgb),
            "dark_ratio": dark_ratio,
            "clearance_disabled": dark_ratio >= 0.85,
            "base_poly": base_rings,
        }
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

    tmpdir = tempfile.mkdtemp(prefix="fog_")
    try:
        path = _save_upload(data, tmpdir)
        try:
            base_mask, color_mask, (h_px, w_px) = extract_masks(path, alpha, dark)
            base_polys = base_polygons(base_mask)
            color_polys = color_polygons(color_mask)
            if holes_list:
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
            "X-Hole-Center": f"{hole_center[0]:.3f},{hole_center[1]:.3f}",
        }
        return Response(stl_bytes, media_type="model/stl", headers=headers)
    finally:
        shutil.rmtree(tmpdir, ignore_errors=True)


# Static frontend (served last so the /api routes above win).
app.mount("/static", StaticFiles(directory=BASE_DIR / "static"), name="static")


@app.get("/")
def index():
    return FileResponse(BASE_DIR / "static" / "index.html")


if __name__ == "__main__":
    port = int(os.environ.get("PORT", os.environ.get("FOG_PORT", "8000")))
    print(f"Fan Object Generator → http://127.0.0.1:{port}")
    uvicorn.run(app, host="127.0.0.1", port=port)
