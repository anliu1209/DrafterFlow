"""Vectorize binary masks into shapely polygons.

Primary path is potrace (fits smooth bezier curves straight to the mask, so there
is no pixel staircase). When potracer is not installed it falls back to the
OpenCV-contours + splprep path. model_builder only consumes shapely polygons, so
the vectorizer can be swapped without touching downstream code.
"""
from __future__ import annotations

import cv2
import numpy as np
from shapely.geometry import GeometryCollection, MultiPolygon, Polygon
from shapely.validation import make_valid

try:
    import potrace  # potrace vectorizer; used when installed, else splprep path
    _HAVE_POTRACE = True
except Exception:
    _HAVE_POTRACE = False

try:
    from scipy.interpolate import splprep, splev  # periodic B-spline ring smoothing
    _HAVE_SCIPY = True
except Exception:  # scipy is a declared dep; keep Chaikin as a graceful fallback
    _HAVE_SCIPY = False

# potrace parameters (used when potracer is installed)
POTRACE_TURDSIZE = 2        # drop specks smaller than this (px)
POTRACE_ALPHAMAX = 1.0      # 1.0 = only true corners become corners; higher smooths
POTRACE_OPTTOLERANCE = 0.2  # bezier fit tolerance
POTRACE_PER_SEG = 16        # samples per bezier segment; higher = smoother but heavier

MIN_AREA_PX = 4.0  # drop anti-aliasing specks smaller than ~2x2 px
SMOOTH_ITERATIONS = 2  # Chaikin passes (fallback when scipy/spline is unavailable)
SMOOTH_SIGMA = 2.0  # px. Gaussian-blur the mask BEFORE contour extraction so the
# contour follows a smooth anti-aliased iso-boundary. Raise for smoother curves;
# too high rounds sharp corners in line art and thins narrow strokes.
SPLINE_SMOOTH = 0.03  # splprep smoothing criterion s, scaled by ring point count
SPLINE_COUNT = 220  # points to resample each closed ring to (dense -> smooth)
SPLINE_TOLERANCE = 0.02  # px; Douglas-Peucker to drop collinear/duplicate spline
# points. Dense resampled rings extrude into a non-watertight mesh (degenerate cap
# triangles), so we thin them back out before handing to trimesh.

# NOTE on shrink: blurring contracts sharp convex corners slightly and narrows thin
# strokes. model_builder clips color∩base so the dark layer can't overflow the
# silhouette, but the hole margin/clearance are computed from these smoothed
# polygons, so re-check find_hole_center after changing SMOOTH_SIGMA.


def _blur_mask(m):
    """Gaussian-blur a 0/1 mask and re-threshold at 0.5 into a smooth 0/1 mask."""
    img = cv2.GaussianBlur(m.astype(np.float32) * 255.0, (0, 0), SMOOTH_SIGMA)
    return (img > 127.0).astype(np.uint8)


def _polygons_of(geom):
    """Flatten any shapely geometry into a list of Polygons (drop lines/points).

    `make_valid` on a self-intersecting contour can return a GeometryCollection
    (polygons + stray lines) or a MultiPolygon. Callers that assume a single
    `Polygon` crash on `.exterior`, so normalize to Polygon parts here.
    """
    if geom is None or geom.is_empty:
        return []
    if isinstance(geom, Polygon):
        return [geom]
    if isinstance(geom, MultiPolygon):
        return [g for g in geom.geoms]
    if isinstance(geom, GeometryCollection):
        out = []
        for g in geom.geoms:
            out.extend(_polygons_of(g))
        return out
    return []  # LineString, Point, etc.


def _close_and_polygon(contour):
    """Convert a raw contour into a Polygon/MultiPolygon, or None if trivial."""
    pts = contour.reshape(-1, 2)
    if len(pts) < 3:
        return None
    if not np.array_equal(pts[0], pts[-1]):
        pts = np.vstack([pts, pts[0]])
    poly = Polygon(pts)
    if not poly.is_valid:
        poly = make_valid(poly)
    parts = [p for p in _polygons_of(poly) if p.area >= MIN_AREA_PX]
    if not parts:
        return None
    if len(parts) == 1:
        return parts[0]
    return MultiPolygon(parts)


def _chaikin(coords, iterations):
    """Chaikin corner-cutting: turns a staircase polyline into a smooth curve."""
    pts = [list(c) for c in coords]
    for _ in range(iterations):
        n = len(pts)
        if n < 3:
            break
        new = []
        for i in range(n):
            p0, p1 = pts[i], pts[(i + 1) % n]
            new.append([0.75 * p0[0] + 0.25 * p1[0], 0.75 * p0[1] + 0.25 * p1[1]])
            new.append([0.25 * p0[0] + 0.75 * p1[0], 0.25 * p0[1] + 0.75 * p1[1]])
        pts = new
    return pts


def _spline_ring(coords, smooth=SPLINE_SMOOTH, count=SPLINE_COUNT):
    """Fit a periodic B-spline through a closed ring and resample it densely.

    findContours returns integer-pixel coordinates, so a boundary crossing a
    diagonal has to step by whole pixels -> the staircase on sloped/curved edges.
    splprep(per=True) fits a smooth continuous sub-pixel curve through the ring,
    which removes that staircase. Falls back to Chaikin when scipy is missing or
    the ring is too small / degenerate for a spline.
    """
    if not _HAVE_SCIPY:
        return _chaikin([list(c) for c in coords], SMOOTH_ITERATIONS)
    pts = [list(c) for c in coords]
    if len(pts) > 1 and pts[0] == pts[-1]:
        pts = pts[:-1]
    if len(pts) < 5:
        return pts
    try:
        x = [p[0] for p in pts]
        y = [p[1] for p in pts]
        s = min(smooth * len(pts), 60.0)
        tck, _u = splprep([x, y], s=s, per=True)
        u = np.linspace(0.0, 1.0, count)
        xs, ys = splev(u, tck)
        return list(zip(xs, ys))
    except Exception:
        return _chaikin([list(c) for c in coords], SMOOTH_ITERATIONS)


def _smooth_polygon(poly):
    """Smooth exterior and hole rings of a polygon (removes pixel staircase)."""
    if poly is None or poly.is_empty:
        return poly

    def ring(coords):
        c = list(coords)
        if len(c) > 1 and c[0] == c[-1]:
            c = c[:-1]
        if len(c) < 3:
            return c
        return _spline_ring(c)

    def smooth_one(p):
        ext = ring(p.exterior.coords)
        holes = [ring(h.coords) for h in p.interiors]
        q = Polygon(ext, holes)
        if not q.is_valid:
            q = make_valid(q)
        # Thin collinear/duplicate points so extrude_polygon produces a watertight
        # mesh (see SPLINE_TOLERANCE). Sub-pixel tolerance: shape is unchanged.
        q = q.simplify(SPLINE_TOLERANCE)
        return q

    parts = []
    for g in _polygons_of(poly):
        q = smooth_one(g)
        parts.extend(pp for pp in _polygons_of(q) if pp.area >= MIN_AREA_PX)
    if not parts:
        return poly
    if len(parts) == 1:
        return parts[0]
    return MultiPolygon(parts)


def _sample_curve(curve, per_seg=POTRACE_PER_SEG):
    """Sample a potrace curve into an ordered closed point list.

    Segments are either cubic beziers (c1/c2 control points) or sharp corners
    (a single `c` vertex); both are walked in order to rebuild the ring.
    """
    pts = [(curve.start_point.x, curve.start_point.y)]
    for s in curve.segments:
        px, py = pts[-1]
        if s.is_corner:
            pts.append((s.c.x, s.c.y))
            pts.append((s.end_point.x, s.end_point.y))
        else:
            c1x, c1y = s.c1.x, s.c1.y
            c2x, c2y = s.c2.x, s.c2.y
            ex, ey = s.end_point.x, s.end_point.y
            for k in range(1, per_seg + 1):
                u = k / per_seg
                pts.append((
                    (1-u)**3*px + 3*(1-u)**2*u*c1x + 3*(1-u)*u*u*c2x + u**3*ex,
                    (1-u)**3*py + 3*(1-u)**2*u*c1y + 3*(1-u)*u*u*c2y + u**3*ey,
                ))
    if pts[0] == pts[-1]:
        pts = pts[:-1]
    return pts


def _potrace_polys(mask):
    """Vectorize a binary mask into nested shapely Polygons via potrace beziers.

    potrace emits one closed curve per boundary; nesting is recovered with a
    depth-parity pass (even depth = filled shell, odd depth = hole) which matches
    potrace's even-odd fill semantics.
    """
    img = np.where(mask, 0, 255).astype(np.uint8)  # art dark, background bright
    path = potrace.Bitmap(img).trace(
        turdsize=POTRACE_TURDSIZE, alphamax=POTRACE_ALPHAMAX,
        opticurve=True, opttolerance=POTRACE_OPTTOLERANCE,
    )
    curves = [Polygon(_sample_curve(c)) for c in path.curves]
    curves = [p for p in curves if p.is_valid and p.area >= MIN_AREA_PX]
    if not curves:
        return []
    curves.sort(key=lambda p: -abs(p.area))

    def depth_of(p):
        rp = p.representative_point()
        return sum(
            1 for q in curves
            if q is not p and abs(q.area) > abs(p.area) + 1e-9 and q.contains(rp)
        )

    out = []
    for p in curves:
        if depth_of(p) % 2 != 0:
            continue
        rp = p.representative_point()
        holes = []
        for h in curves:
            if depth_of(h) % 2 != 1:
                continue
            hrp = h.representative_point()
            if p.contains(hrp) and not any(
                abs(q.area) < abs(p.area) and depth_of(q) % 2 == 0 and q.contains(hrp)
                for q in curves
            ):
                holes.append(list(h.exterior.coords))
        out.append(Polygon(p.exterior.coords, holes) if holes else p)
    return [q for q in out if not q.is_empty]


def _tree_to_polygons(contours, hierarchy):
    """Build polygons (with one level of holes + nested islands) from RETR_TREE."""
    n = len(contours)
    h = hierarchy[0]
    children = [[] for _ in range(n)]
    roots = []
    for i in range(n):
        parent = int(h[i][3])
        if parent == -1:
            roots.append(i)
        else:
            children[parent].append(i)

    def build(idx):
        out = []
        shells = _close_and_polygon(contours[idx])
        hole_rings = []
        sub_roots = []
        for c in children[idx]:
            hp = _close_and_polygon(contours[c])
            if hp is not None:
                hole_rings.extend(_polygons_of(hp))
            sub_roots.extend(children[c])
        if shells is not None:
            for shell in _polygons_of(shells):
                inner_holes = [hl for hl in hole_rings if shell.covers(hl)]
                if inner_holes:
                    shell = Polygon(
                        shell.exterior.coords,
                        [hl.exterior.coords for hl in inner_holes],
                    )
                    if not shell.is_valid:
                        shell = make_valid(shell)
                    out.extend(p for p in _polygons_of(shell) if p.area >= MIN_AREA_PX)
                else:
                    out.append(shell)
        for g in sub_roots:
            out.extend(build(g))
        return out

    result = []
    for r in roots:
        result.extend(build(r))
    return [p for p in result if p is not None and not p.is_empty]


def base_polygons(base_mask):
    """Solid backing plate: fill the outer contours of the silhouette.

    For line art (e.g. a frame + text) this produces a solid plate rather than
    hollow line strokes, which is what a keychain needs.
    """
    m = (base_mask > 0).astype(np.uint8)
    if _HAVE_POTRACE:
        filled = np.zeros_like(m)
        cnts, _ = cv2.findContours(m, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
        cv2.drawContours(filled, cnts, -1, 1, thickness=cv2.FILLED)
        return _potrace_polys(filled > 0)

    m = _blur_mask(m)
    contours, _ = cv2.findContours(m, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_NONE)
    filled = np.zeros_like(m)
    cv2.drawContours(filled, contours, -1, 1, thickness=cv2.FILLED)
    contours, _ = cv2.findContours(filled, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_NONE)

    polys = []
    for c in contours:
        p = _close_and_polygon(c)
        if p is not None:
            polys.append(_smooth_polygon(p))
    return polys


def color_polygons(color_mask):
    """Dark artwork, preserving holes (e.g. a frame ring + inner letters)."""
    m = (color_mask > 0).astype(np.uint8)
    if _HAVE_POTRACE:
        return _potrace_polys(m > 0)

    m = _blur_mask(m)
    contours, hierarchy = cv2.findContours(m, cv2.RETR_TREE, cv2.CHAIN_APPROX_NONE)
    if hierarchy is None or len(contours) == 0:
        return []
    return [_smooth_polygon(p) for p in _tree_to_polygons(contours, hierarchy)]
