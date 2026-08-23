"""Build the two-layer keychain model from shapely polygons (mm coordinates).

Pixel -> mm conversion happens in exactly one place (here), per §9 of the DevDoc.
"""
from __future__ import annotations

import trimesh
from shapely.affinity import affine_transform
from shapely.geometry import GeometryCollection, MultiPolygon, Point, Polygon
from shapely.ops import unary_union


class ModelBuildError(Exception):
    """Raised when geometry construction or hole placement fails."""


DEFAULT_MARGIN = 3.0       # mm, hole top -> part top edge
DEFAULT_MIN_EDGE = 2.0     # mm, hole -> outer contour min wall
DEFAULT_CLEARANCE = 1.0    # mm, hole -> dark artwork clearance


def _scale_and_center(poly, scale, w_px, h_px):
    """Pixel coords (origin top-left, y down) -> mm coords (centered, y up)."""
    return affine_transform(
        poly,
        [scale, 0.0, 0.0, -scale, -scale * w_px / 2.0, scale * h_px / 2.0],
    )


def _extrude(geom, height):
    """Extrude a shapely Polygon/MultiPolygon into a trimesh, Z in [0, height]."""
    if isinstance(geom, Polygon):
        return trimesh.creation.extrude_polygon(geom, height)
    if isinstance(geom, MultiPolygon):
        parts = [trimesh.creation.extrude_polygon(g, height) for g in geom.geoms]
        if not parts:
            raise ModelBuildError("Failed to construct the 3D model: empty geometry.")
        return trimesh.util.concatenate(parts)
    geom = geom.buffer(0)
    return _extrude(geom, height)


def _polygon_parts(geom, min_area=0.001):
    """Flatten a geometry into its Polygon parts, dropping lines/points/slivers."""
    if isinstance(geom, Polygon):
        return [geom] if geom.area >= min_area else []
    if isinstance(geom, MultiPolygon):
        return [g for g in geom.geoms if g.area >= min_area]
    if isinstance(geom, GeometryCollection):
        out = []
        for g in geom.geoms:
            out.extend(_polygon_parts(g, min_area))
        return out
    return []  # LineString, Point, etc.


def _hole_valid(base_union, color_union, x, y, r, min_edge, clearance):
    p = Point(x, y)
    if not base_union.contains(p):
        return False
    if base_union.boundary.distance(p) < r + min_edge:
        return False
    if clearance is not None and color_union.distance(p) < r + clearance:
        return False
    return True


def _spread(center, half_range, step):
    """Yield x values from center outward: 0, +s, -s, +2s, -2s, ..."""
    yield center
    off = step
    while off <= half_range:
        yield center + off
        yield center - off
        off += step


def find_hole_center(base_union, color_union, hole_radius, margin=DEFAULT_MARGIN,
                     min_edge=DEFAULT_MIN_EDGE, clearance=DEFAULT_CLEARANCE):
    """Default hole position: highest, most-centered point where a circle fits."""
    minx, _miny, maxx, maxy = base_union.bounds
    cx = (minx + maxx) / 2.0
    top = maxy
    half_range = (maxx - minx) / 2.0 + hole_radius
    step = 0.25

    y = top - margin - hole_radius
    y_limit = y - 40.0
    while y >= y_limit:
        for x in _spread(cx, half_range, step):
            if _hole_valid(base_union, color_union, x, y, hole_radius, min_edge, clearance):
                return (x, y)
        y -= step

    raise ModelBuildError(
        "Unable to place keychain hole safely.\nPlease specify another hole position."
    )


def build_model(
    base_polys,
    color_polys,
    w_px,
    h_px,
    width_mm,
    base_thickness,
    color_thickness,
    hole_diameter,
    hole_position=None,
    tab_outer_radius=None,
):
    """Return (final_mesh, hole_center_mm)."""
    scale = width_mm / max(w_px, h_px)

    base_polys_mm = [_scale_and_center(p, scale, w_px, h_px) for p in base_polys]
    color_polys_mm = [_scale_and_center(p, scale, w_px, h_px) for p in color_polys]

    base_union = unary_union(base_polys_mm) if base_polys_mm else GeometryCollection()
    color_union = unary_union(color_polys_mm) if color_polys_mm else GeometryCollection()

    if base_union.is_empty:
        raise ModelBuildError("Failed to construct the 3D model: empty base geometry.")

    # The color layer is vectorized and smoothed independently of the base, so its
    # outer edge can drift past the base boundary (e.g. at the rounded corners of a
    # frame). Clip it to the base so the boolean union stays manifold. The clip can
    # leave degenerate line/point slivers at coincident boundaries; keep only 2D
    # polygon parts.
    if not color_union.is_empty:
        parts = _polygon_parts(color_union.intersection(base_union))
        color_union = unary_union(parts) if parts else GeometryCollection()

    hole_radius = hole_diameter / 2.0

    # For solid-dark artwork the color layer covers (nearly) the whole base, so the
    # hole cannot avoid it — skip the color clearance entirely (None). For line art
    # the dark is a small fraction, so keep the clearance to avoid cutting strokes.
    color_area_ratio = (color_union.area / base_union.area) if not color_union.is_empty else 0.0
    clearance = DEFAULT_CLEARANCE if color_area_ratio < 0.85 else None

    base_mesh = _extrude(base_union, base_thickness)
    if not color_union.is_empty:
        color_mesh = _extrude(color_union, color_thickness)
        color_mesh.apply_translation([0, 0, base_thickness])
        merged = trimesh.boolean.union([base_mesh, color_mesh], engine="manifold")
    else:
        merged = base_mesh

    if hole_position is not None:
        hx, hy = hole_position
        if hx is None or hy is None:
            raise ModelBuildError("--hole-x and --hole-y must be given together.")
        # Ring mode trusts the user's placement: the ring may deliberately extend past
        # the silhouette to form a hang-tab, so the "must fit inside the base" check is
        # skipped. A plain repositioned hole keeps the safety check.
        if tab_outer_radius is None:
            if not _hole_valid(base_union, color_union, hx, hy, hole_radius,
                               DEFAULT_MIN_EDGE, clearance):
                raise ModelBuildError(
                    "Unable to place keychain hole safely.\nPlease specify another hole position."
                )
    else:
        try:
            hx, hy = find_hole_center(base_union, color_union, hole_radius, clearance=clearance)
        except ModelBuildError:
            # Dense artwork may have no spot clear of the dark layer; fall back to
            # a structurally-safe hole (min_edge only) that may cut through dark art.
            if clearance is None:
                raise
            hx, hy = find_hole_center(base_union, color_union, hole_radius, clearance=None)

    # Ring/tab: a base-coloured outer cylinder fused at the hole centre. Where it lies
    # inside the silhouette it is invisible after the union; where it crosses the edge
    # the outside part becomes a protruding hang-tab (挂耳). The inner hole is cut below
    # (its cylinder spans the full height), leaving a clean through-hole.
    if tab_outer_radius is not None and tab_outer_radius > hole_radius:
        tab = trimesh.creation.cylinder(
            radius=tab_outer_radius, height=base_thickness, sections=64
        )
        tab.apply_translation([hx, hy, base_thickness / 2.0])
        merged = trimesh.boolean.union([merged, tab], engine="manifold")

    total_height = base_thickness + color_thickness
    cylinder = trimesh.creation.cylinder(
        radius=hole_radius, height=total_height + 4.0, sections=64
    )
    cylinder.apply_translation([hx, hy, total_height / 2.0])

    final = trimesh.boolean.difference([merged, cylinder], engine="manifold")

    return final, (hx, hy)
