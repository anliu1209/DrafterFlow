# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

A local Python CLI that converts a transparent-background PNG (dark artwork on alpha) into a single two-layer, 3D-printable keychain STL: the silhouette becomes a light base plate, dark regions become a raised top layer, and a keychain hole is auto-placed. The two "colors" are achieved purely by layer height (slicer filament swap at ~1.2 mm), so one STL carries no color info.

There is also a **browser UI** — the SketchForge landing page plus the tool — served by `server.py`, a thin FastAPI layer over the same pipeline with a static frontend (`static/`, Three.js 3D preview). The UI is English by default with a Chinese toggle, and light-first with a dark-mode toggle. The user plans to migrate this UI to a hosted web app later, so the transport layer is deliberately decoupled from the conversion code.

The repo has no git history, no test suite, no lint/format config, and no packaging metadata (`pyproject.toml`/`setup.py`). `README.md` and `DEVDOC.md` are written in Chinese; code and docstrings are English.

## Commands

There is a virtualenv at `.venv` (Python 3.13). Use it rather than system `python`.

```bash
# install deps (already done for this env)
python3 -m venv .venv
.venv/bin/python -m pip install -r requirements.txt

# run the pipeline
.venv/bin/python main.py examples/txt.png output/txt.stl
.venv/bin/python main.py examples/heart.png output/heart.stl --width 50

# regenerate the test images in examples/
.venv/bin/python examples/make_examples.py

# full CLI reference
.venv/bin/python main.py --help

# run the browser UI (then open http://127.0.0.1:8000)
.venv/bin/python server.py
```

There are **no automated tests**. Manual acceptance is running `main.py` on `examples/heart.png` and confirming a valid STL is produced. `examples/make_examples.py` generates the two test images (`heart.png` = solid silhouette, `txt.png` = frame + text line art).

## Architecture

The pipeline is a linear chain of five modules, each calling into the next:

```
main.py → image_processing.py → vectorize.py → model_builder.py → export.py
```

- **`main.py`** — argparse CLI entry point. Parses args, calls the pipeline in order, catches `ImageProcessingError` / `ModelBuildError` and prints them to stderr with exit code 1.
- **`image_processing.py`** — `extract_masks(path, alpha_threshold, dark_threshold)` reads the RGBA PNG and returns `(base_mask, color_mask, (h_px, w_px))`. `base_mask` = pixels where `alpha > alpha_threshold`; `color_mask` = `gray < dark_threshold` **and** `alpha > alpha_threshold`. Both masks are cropped to the silhouette's bounding box before returning, so the pixel size (and thus `--width`) refers to the artwork itself, not the transparent canvas around it. Raises `ImageProcessingError` on non-PNG, missing alpha, all-opaque, empty base, or empty dark mask.
- **`vectorize.py`** — converts each binary mask into `shapely` polygons. The binary mask is Gaussian-blurred and re-thresholded at 0.5 (`_blur_mask`, `SMOOTH_SIGMA`, default 2.0 px) before contour extraction, so the contour follows a smooth anti-aliased iso-boundary. Contours are extracted at full pixel resolution (`CHAIN_APPROX_NONE`) so a periodic B-spline (`splprep(per=True)`, `_spline_ring`, `SPLINE_SMOOTH`/`SPLINE_COUNT`) can fit a genuinely continuous sub-pixel curve through each ring — this removes the pixel staircase that `findContours` leaves on diagonal/curved edges. Rings are thinned back out with `simplify(SPLINE_TOLERANCE)` because over-dense resampled rings extrude into a non-watertight mesh. Self-intersecting contours (common in dense line art) are normalized via `make_valid` and flattened back to Polygon parts (`_polygons_of`); Chaikin (`_chaikin`) is the fallback when scipy is unavailable or a ring is too small/degenerate. `base_polygons()` fills outer contours into a solid plate; `color_polygons()` preserves holes/nesting. Despite the module name and "SVG" references in DEVDOC, this is the **OpenCV-contours fallback, not potrace/SVG** — the output is shapely polygons, never SVG. Note: blur + spline slightly shrink convex corners and thin narrow strokes; `model_builder`'s `color ∩ base` clip catches dark-layer overflow, but hole margin/clearance shift a little (verified: txt hole moved ~0.04 mm).
- **`model_builder.py`** — `build_model(...)` does all 3D work with `trimesh`: pixel→mm scaling, extrusion, boolean union of the two layers, hole placement, and hole boolean difference. It clips the color layer to the base in 2D (`color_union.intersection(base_union)`, then `_polygon_parts`) before extruding, so the independently-smoothed outlines stay manifold at the shared boundary. Returns `(final_mesh, hole_center_mm)`.
- **`export.py`** — `export_stl(mesh, path)` appends `.stl` if missing and calls `mesh.export()`.

### Critical: the actual stack differs from the design doc

`DEVDOC.md` describes a **planned** architecture using **CadQuery + potrace**. The implementation used DEVDOC §22's fallback instead: **trimesh + shapely + manifold3d** for 3D, and **OpenCV contours** for vectorization. `requirements.txt` reflects the real stack (`opencv-python-headless`, `numpy`, `scipy`, `shapely`, `trimesh`, `manifold3d` — no CadQuery, no potrace). Treat DEVDOC.md as the design spec/roadmap, not as documentation of the current code. Verify against the source before assuming a CadQuery/potrace API.

### Pixel → mm conversion happens in exactly one place

`image_processing.py` and `vectorize.py` work entirely in **pixel** coordinates (origin top-left, y-down). Only `model_builder._scale_and_center()` converts to millimeters (`scale = width_mm / max(w_px, h_px)`), producing a coordinate system **centered on the origin with y-up**: X ∈ [-w/2, w/2], Y ∈ [-h/2, h/2], base Z ∈ [0, base_thickness], color Z ∈ [base_thickness, base_thickness + color_thickness]. Do not add a second unit conversion — keep all pixel math upstream and all mm math inside `model_builder.py`.

### Hole placement

Default hole position is auto-computed by `find_hole_center()` in mm space: scan from the top-center downward/outward for the first center where the hole circle (plus `min_edge` margin) fits inside the base and (plus `clearance`) avoids dark artwork. `--hole-x`/`--hole-y` override it but go through the same `_hole_valid()` check. When the dark artwork covers ≥ 85% of the base area (solid-dark silhouettes), the color clearance is disabled (`clearance = None`) because the hole cannot avoid the color layer. As a second fallback, if no center clears the dark artwork at all (dense artwork), `build_model` retries with `clearance=None` — a structurally-safe hole (`min_edge` only) that may cut through dark art — instead of failing.

Boolean operations use `engine="manifold"` throughout `model_builder.py` (union of base+color, difference for the hole).

## Web frontend

`server.py` (FastAPI + uvicorn) exposes the pipeline over HTTP and serves the static UI. It reuses the pipeline modules unchanged — it is a transport layer only, so migrating to a hosted backend means swapping `server.py`, not touching the conversion code.

- **`server.py`** — two JSON/binary endpoints:
  - `POST /api/analyze` (multipart `file` + `dark_threshold`/`alpha_threshold`) → `{ ok, w_px, h_px, base_png, color_png, combined_png, dark_ratio, clearance_disabled }`. The `base_png` is the **filled** base plate (mirrors `vectorize.base_polygons`, not the raw stroke mask); `color_png` is the dark art; `combined_png` overlays them. `clearance_disabled` = `dark_ratio >= 0.85` (matches `model_builder`'s color-clearance cutoff).
  - `POST /api/generate` (multipart `file` + `width`/`base`/`color`/`hole`/optional `hole_x`/`hole_y`/thresholds) → binary STL with `X-Hole-Center: "x,y"` header.
  - `GET /api/examples` / `GET /api/examples/{id}` — one-click example images (`EXAMPLES` dict in `server.py`, ordered line-art-first: `txt`, `heart`, `qban`; `qban` maps to the Chinese-named `Q版测试.png` in the repo root).
- **`static/`** — vanilla HTML/CSS/JS frontend ("SketchForge" brand), no build step. A landing page (hero, "How it works", "What you can make", gallery, about) wraps the tool. Two toggles, both persisted via localStorage: a **language** toggle (`sketchforge_lang`, EN default + ZH) and a **theme** toggle (`sketchforge_theme`, light default + `data-theme="dark"`). All UI copy lives in an `I18N` dict in `app.js` — static text via `data-i18n`/`data-i18n-ph` attributes, dynamic text via `t(key)`. `static/vendor/` holds a vendored Three.js (`three.module.js`, `STLLoader.js`, `OrbitControls.js`; `BufferGeometryUtils.js` is vendored but currently unused) so it works offline. `app.js` renders the STL as **two meshes split at the swap line** (base plate + raised layer) with flat shading so the 90° layer edge stays crisp; curved-edge smoothness is handled at the geometry level by the `_spline_ring` periodic B-spline smoothing in `vectorize.py`). Generation shows a cycling pipeline-stage indicator, and an image-switch confirm modal guards against discarding an ungenerated image.
- Preview colours default to `BASE_RGB` / `COLOR_RGB` in `server.py`; `/api/analyze` accepts `base_color`/`color_color` (hex) so the UI's two colour pickers re-tint the mask previews, the 3D render, and the cross-section gauge bars client-side.
- `requirements.txt` gains `fastapi`, `uvicorn[standard]`, `python-multipart` for the web layer.

## Known design decisions

- Base thickness 1.2 mm, color layer 0.6 mm — chosen because 0.2 mm is too close to typical FDM layer height; `--color` still allows override.
- `alpha_threshold` defaults to 8 (not 0) to reject semi-transparent specks from the silhouette.
- 3MF export (dual-material) is deferred to a later version; the internal `base_solid`/`color_solid` split was kept in DEVDOC for that future reuse but the current code exports a single unioned mesh.
- The 3D preview uses **flat shading** (not smooth normals) so the 90° base/relief edge stays crisp; smooth normals rounded the relief into a "blob". The curved-silhouette jaggies are addressed at the geometry level in `vectorize.py`: the mask is Gaussian-blurred (`_blur_mask`, `SMOOTH_SIGMA`) so the contour follows a smooth iso-boundary, then each ring is fit with a periodic B-spline (`_spline_ring`, `splprep(per=True)`) extruded into a continuous sub-pixel curve, which removes the pixel staircase that `findContours` leaves on diagonal/curved edges. This adds `scipy` to `requirements.txt` (the fit needs it, unlike `cv2.GaussianBlur`). Both `SMOOTH_SIGMA` and `SPLINE_SMOOTH` are tunable; raising them smooths more but rounds sharp corners and thins narrow strokes, and lowers watertightness margins.
- The example list is ordered **line-art-first** (`txt`) because a solid silhouette (`heart`) doesn't visually separate the two layers; the 3D camera default is a low, side-on angle for the same reason.
