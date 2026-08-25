# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

A local Python CLI that converts a **transparent-background PNG or a white-background image** (dark artwork) into a single two-layer, 3D-printable keychain STL: the silhouette becomes a light base plate, dark regions become a raised top layer, and a keychain hole is auto-placed. The two "colors" are achieved purely by layer height (slicer filament swap at ~1.2 mm), so one STL carries no color info.

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
.venv/bin/python main.py examples/white_ring.png output/ring.stl --debug   # white-background input; --debug writes masks

# regenerate the test images in examples/
.venv/bin/python examples/make_examples.py
.venv/bin/python examples/make_white_examples.py   # white-background test inputs

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
- **`image_processing.py`** — `extract_masks(path, alpha_threshold, dark_threshold, background="auto", background_distance_threshold=45, debug=False, debug_dir=None)` reads the image and returns `(base_mask, color_mask, (h_px, w_px))`. `base_mask` = the silhouette; `color_mask` = dark pixels within it. `background="auto"` routes to the **transparent path** when the image has a real alpha channel (`_transparent_masks`: `base_mask` = `alpha > alpha_threshold`, `color_mask` = `gray < dark_threshold & alpha > alpha_threshold`), else to the **white-background path** (`_white_masks`). Both masks are cropped to the silhouette's bounding box before returning, so the pixel size (and thus `--width`) refers to the artwork itself, not the canvas around it. The white-background path estimates the background colour from the image corners (`_estimate_bg`), marks pixels whose colour distance from it exceeds `background_distance_threshold` as foreground (`_clean_fg`: morph close/open + connected-component size floor), then **fills the outer contours into a solid silhouette** (`_fill_silhouette`) so white interior regions stay part of the base plate; `color_mask` = `gray < dark_threshold` within that silhouette. It raises `ImageProcessingError` on non-image, missing alpha (when transparent is forced), all-opaque transparent input, no base, an empty dark mask, very low contrast, or a non-uniform (photographic) background. `debug=True` writes original / raw-foreground / silhouette / dark PNGs to `debug_dir`.
- **`vectorize.py`** — converts each binary mask into `shapely` polygons. Primary vectorizer is **potrace** (`_potrace_polys`, `_sample_curve`, `POTRACE_*`): it fits smooth cubic bezier curves straight to the mask, so there is **no pixel staircase** on diagonal/curved edges (unlike `findContours`). Nesting (holes/islands) is recovered with a depth-parity pass matching potrace's even-odd semantics. `base_polygons()` fills the outer contours into a solid plate; `color_polygons()` preserves the dark artwork. If `potracer` is not installed it falls back to the OpenCV-contours path (blur `_blur_mask` → `findContours` `CHAIN_APPROX_NONE` → periodic B-spline `_spline_ring`/`splprep` → `simplify(SPLINE_TOLERANCE)`, with Chaikin as a final backstop). Note: potrace slightly shrinks convex corners and thins narrow strokes; `model_builder`'s `color ∩ base` clip catches dark-layer overflow, but hole margin/clearance shift a little. potrace tends to produce more mesh faces (and larger STLs) on dense line art than the splprep path.
- **`model_builder.py`** — `build_model(...)` does all 3D work with `trimesh`: pixel→mm scaling, extrusion, boolean union of the two layers, hole placement, and hole boolean difference. It clips the color layer to the base in 2D (`color_union.intersection(base_union)`, then `_polygon_parts`) before extruding, so the independently-smoothed outlines stay manifold at the shared boundary. `_extrude` applies a 1 µm positive buffer (see `EXTRUDE_BUFFER_EPS`) when a thin ring fails to triangulate into a closed volume. `compute_default_hole()` returns the auto-placed centre without building a mesh. Returns `(final_mesh, hole_center_mm)` — `hole_center_mm` is `None` when `holes=[]` (no keyhole).
- **`export.py`** — `export_stl(mesh, path)` appends `.stl` if missing and calls `mesh.export()`.

### Critical: the actual stack differs from the design doc

`DEVDOC.md` describes a **planned** architecture using **CadQuery + potrace**. The implementation used DEVDOC §22's fallback (OpenCV contours) first, then moved to **potrace** for vectorization: the real stack is **trimesh + shapely + manifold3d** for 3D, and **potrace (`potracer`)** for vectorization (with an OpenCV-contours + splprep fallback path). `requirements.txt` reflects this (`opencv-python-headless`, `numpy`, `scipy`, `shapely`, `trimesh`, `manifold3d`, `potracer` — no CadQuery). Treat DEVDOC.md as the design spec/roadmap, not as documentation of the current code. Verify against the source before assuming a CadQuery API. **Licensing**: `potracer` is GPLv2+, so the project is distributed under **GPLv3** (see `LICENSE` and `THIRD_PARTY_NOTICES.md`); be careful if the dependency or license is ever changed.

### Pixel → mm conversion happens in exactly one place

`image_processing.py` and `vectorize.py` work entirely in **pixel** coordinates (origin top-left, y-down). Only `model_builder._scale_and_center()` converts to millimeters (`scale = width_mm / max(w_px, h_px)`), producing a coordinate system **centered on the origin with y-up**: X ∈ [-w/2, w/2], Y ∈ [-h/2, h/2], base Z ∈ [0, base_thickness], color Z ∈ [base_thickness, base_thickness + color_thickness]. Do not add a second unit conversion — keep all pixel math upstream and all mm math inside `model_builder.py`.

### Hole placement

Default hole position is auto-computed by `find_hole_center()` in mm space: scan from the top-center downward/outward for the first center where the hole circle (plus `min_edge` margin) fits inside the base and (plus `clearance`) avoids dark artwork. `--hole-x`/`--hole-y` override it but go through the same `_hole_valid()` check. When the dark artwork covers ≥ 85% of the base area (solid-dark silhouettes), the color clearance is disabled (`clearance = None`) because the hole cannot avoid the color layer. As a second fallback, if no center clears the dark artwork at all (dense artwork), `build_model` retries with `clearance=None` — a structurally-safe hole (`min_edge` only) that may cut through dark art — instead of failing.

`compute_default_hole()` exposes the same auto-placement (without building a mesh) so the web UI can draw the default hole on the canvas. `build_model(..., holes=[])` explicitly means **no keyhole** — it returns `(merged, None)` and `_extrude` snaps a thin ring that would otherwise fail to triangulate into a solid volume (`EXTRUDE_BUFFER_EPS` = 1 µm positive buffer) so line-art frames still build. `--no-hole` is the CLI equivalent.

Boolean operations use `engine="manifold"` throughout `model_builder.py` (union of base+color, difference for the hole).

## Web frontend

`server.py` (FastAPI + uvicorn) exposes the pipeline over HTTP and serves the static UI. It reuses the pipeline modules unchanged — it is a transport layer only, so migrating to a hosted backend means swapping `server.py`, not touching the conversion code. The app is containerised (`Dockerfile`) and host-agnostic: it runs on Render's free tier (`render.yaml`) or a VPS (`docker-compose.yml`) with no code change. `server.py` binds `FOG_HOST` (default `127.0.0.1`; the Dockerfile sets `0.0.0.0`) and reads `PORT`/`FOG_PORT`, and the service is stateless (no DB; STL goes to a temp dir).

- **`server.py`** — two JSON/binary endpoints:
  - `POST /api/analyze` (multipart `file` + `dark_threshold`/`alpha_threshold` + optional `width`/`hole`/`base_color`/`color_color` hex, defaults `50`/`4`/`#ffffff`/`#2563eb`) → `{ ok, w_px, h_px, base_png, color_png, combined_png, dark_ratio, clearance_disabled, default_hole, base_poly }`. The `base_png` is the **filled** base plate (mirrors `vectorize.base_polygons`, not the raw stroke mask); `color_png` is the dark art; `combined_png` overlays them; `default_hole` is the auto-placed keyhole centre in mm (`[x, y]` or `null`) the frontend draws on the canvas; `base_poly` is the base-exterior rings (pixel space) the frontend uses to judge whether a placed ring is printable. `clearance_disabled` = `dark_ratio >= 0.85` (matches `model_builder`'s color-clearance cutoff).
  - `POST /api/generate` (multipart `file` + `width`/`base`/`color`/`hole`/thresholds + optional `holes` JSON `[[x,y,outer],...]`, or the single-hole `hole_x`/`hole_y`/`tab_outer_radius`) → binary STL with `X-Hole-Center: "x,y"` header (omitted when `holes=[]` = no keyhole). Multi-hole builds a tab (挂耳) at each hole whose `outer > hole_radius`, then cuts all inner holes; an empty `holes=[]` produces **no keyhole** at all.
  - `GET /api/examples` / `GET /api/examples/{id}` — one-click example images (`EXAMPLES` dict in `server.py`, ordered line-art-first: `nametag`, `heart`, `qban`; `nametag` is a white-background "EVAN" name-tag, `qban` maps to the Chinese-named `Q版测试.png` in the repo root).
- **`static/`** — vanilla HTML/CSS/JS frontend ("SketchForge" brand), no build step. A landing page (hero, "How it works", "What you can make", gallery, about) wraps the tool. Two toggles, both persisted via localStorage: a **language** toggle (`sketchforge_lang`, EN default + ZH) and a **theme** toggle (`sketchforge_theme`, light default + `data-theme="dark"`). All UI copy lives in an `I18N` dict in `app.js` — static text via `data-i18n`/`data-i18n-ph` attributes, dynamic text via `t(key)`. `static/vendor/` holds a vendored Three.js (`three.module.js`, `STLLoader.js`, `OrbitControls.js`; `BufferGeometryUtils.js` is vendored but currently unused) so it works offline. `app.js` renders the STL as **two meshes split at the swap line** (base plate + raised layer) with flat shading so the 90° layer edge stays crisp; curved-edge smoothness is handled at the geometry level by the potrace vectorizer in `vectorize.py`). Generation shows a cycling pipeline-stage indicator, and an image-switch confirm modal guards against discarding an ungenerated image.
- Preview colours default to `BASE_RGB` / `COLOR_RGB` in `server.py`; `/api/analyze` accepts `base_color`/`color_color` (hex) so the UI's two colour pickers re-tint the mask previews, the 3D render, and the cross-section gauge bars client-side.
- `requirements.txt` gains `fastapi`, `uvicorn[standard]`, `python-multipart` for the web layer.

## Known design decisions

- Base thickness 4 mm, color layer 2 mm (total 6 mm) — a realistic all-around keychain default; a ~1 mm plate is too thin to print confidently. `--base`/`--color` still allow override.
- `alpha_threshold` defaults to 8 (not 0) to reject semi-transparent specks from the silhouette.
- 3MF export (dual-material) is deferred to a later version; the internal `base_solid`/`color_solid` split was kept in DEVDOC for that future reuse but the current code exports a single unioned mesh.
- The 3D preview uses **flat shading** (not smooth normals) so the 90° base/relief edge stays crisp; smooth normals rounded the relief into a "blob". The curved-silhouette jaggies are addressed at the geometry level in `vectorize.py` by vectorizing with **potrace** (`_potrace_polys`), which fits smooth cubic bezier curves straight to the mask — no pixel staircase. This adds `potracer` (GPLv2+, copyleft — see `THIRD_PARTY_NOTICES.md`). `POTRACE_ALPHAMAX` / `POTRACE_OPTTOLERANCE` / `POTRACE_PER_SEG` are tunable; potrace produces smoother curves but generates more mesh faces (larger STLs) on dense line art than the splprep fallback path.
- The example list is ordered **line-art-first** (`nametag`) because a solid silhouette (`heart`) doesn't visually separate the two layers; the 3D camera default is a low, side-on angle for the same reason.
- The frontend "layers" panel (底板/浮雕 eye toggles) is **preview-only**: it shows/hides the two 3D meshes but the exported STL is always the full two-layer model. **TODO / future idea**: make layer visibility affect the backend geometry (exclude hidden layers from the exported STL). The hole tool sends the `holes` JSON list `[[x, y, outer], ...]` to `/api/generate` (each `outer` is the hang-tab radius; `null` = plain hole). **An empty list = no keyhole.** After `/api/analyze` the backend's auto-placed centre is drawn on the canvas as a default, movable/deletable hole; `--no-hole` is the CLI equivalent.
- **DONE** (*Generate STL ↔ hole-center sync*): the frontend now sends explicit hole placements, so the ring on the canvas *is* the `X-Hole-Center` the server used — no desync. Deleting all holes sends `holes=[]` and yields a no-keyhole STL.
- **TODO (non-closed line art)**: if the artwork has no closed outline (no base plate), the keychain can't print as one piece — prompt "no backplate — cannot print as one. Continue?" with an option to auto-create a larger contour around it, or let the user proceed.
- **TODO (draw tool)**: add a draw-simple-shapes tool (rectangle / ellipse / line) to add geometry to the canvas.
- **DONE — white-background input** (`0913146` → this session): `extract_masks` now auto-detects transparent vs. white-background (`background="auto"`, plus forced `white`/`transparent`; CLI `--background`, `--bg-distance`, `--debug`). White background is removed by colour-distance thresholding from a corner-estimated background colour, then the outer contours are filled so **white interior regions are preserved** in the base silhouette (no per-artwork-white removal — the physical white base absorbs both). **Remaining limitations / ideas**: (1) there is no **background-colour eyedropper in the UI** yet — the web frontend sends no `background` field, so it relies on `auto`; (2) **light-gray-only line art** (no pixel below `dark_threshold`) errors with "No dark artwork detected" — a mostly-white raised layer is arguably pointless, but a configurable dark threshold or a warning-instead-of-error could change that; (3) an artwork that runs **right up to the image border** can trip the "uniform background" check (`_border_purity < 0.5`) and be rejected; (4) JPG/JPEG is accepted (it has no alpha, so it always routes to white-background).
