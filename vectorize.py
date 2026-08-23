"""Vectorize binary masks into shapely polygons via OpenCV contours.

This is the §22 fallback path (OpenCV contours) used instead of potrace/SVG for
the first working version. Potrace can be swapped in later without touching the
downstream model_builder (which only consumes shapely polygons).
"""
from __future__ import annotations

import cv2
import numpy as np
from shapely.geometry import GeometryCollection, MultiPolygon, Polygon
from shapely.validation import make_valid

MIN_AREA_PX = 4.0  # drop anti-aliasing specks smaller than ~2x2 px
SMOOTH_ITERATIONS = 2  # Chaikin corner-cutting passes to remove the pixel staircase

# TODO(jaggies): Chaikin corner-cutting still leaves a faint staircase on shallow
# curves. Try Gaussian-blurring the binary mask BEFORE contour extraction
# (cv2.GaussianBlur -> threshold ~0.5 -> findContours) so the contour follows a
# genuinely smooth anti-aliased boundary instead of raw pixels. Keep MIN_AREA_PX
# filtering so blur doesn't leave stray specks. Compare against the current
# corner-cutting path before switching.


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


def _smooth_polygon(poly, iterations=SMOOTH_ITERATIONS):
    """Smooth exterior and hole rings of a polygon (removes pixel staircase)."""
    if poly is None or poly.is_empty:
        return poly

    def ring(coords):
        c = list(coords)
        if len(c) > 1 and c[0] == c[-1]:
            c = c[:-1]
        if len(c) < 3:
            return c
        return _chaikin(c, iterations)

    def smooth_one(p):
        ext = ring(p.exterior.coords)
        holes = [ring(h.coords) for h in p.interiors]
        q = Polygon(ext, holes)
        if not q.is_valid:
            q = make_valid(q)
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
    contours, _ = cv2.findContours(m, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    filled = np.zeros_like(m)
    cv2.drawContours(filled, contours, -1, 1, thickness=cv2.FILLED)
    contours, _ = cv2.findContours(filled, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)

    polys = []
    for c in contours:
        p = _close_and_polygon(c)
        if p is not None:
            polys.append(_smooth_polygon(p))
    return polys


def color_polygons(color_mask):
    """Dark artwork, preserving holes (e.g. a frame ring + inner letters)."""
    m = (color_mask > 0).astype(np.uint8)
    contours, hierarchy = cv2.findContours(m, cv2.RETR_TREE, cv2.CHAIN_APPROX_SIMPLE)
    if hierarchy is None or len(contours) == 0:
        return []
    return [_smooth_polygon(p) for p in _tree_to_polygons(contours, hierarchy)]
