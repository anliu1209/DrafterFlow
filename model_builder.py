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
EXTRUDE_BUFFER_EPS = 0.001  # mm, hairline rounding that snaps a degenerate outline into a solid volume


def _scale_and_center(poly, scale, w_px, h_px):
    """Pixel coords (origin top-left, y down) -> mm coords (centered, y up)."""
    return affine_transform(
        poly,
        [scale, 0.0, 0.0, -scale, -scale * w_px / 2.0, scale * h_px / 2.0],
    )


def _extrude_poly(poly, height):
    """Extrude a single Polygon, rounding by a hair if ear-clipping fails to close it.

    A thin ring (e.g. a frame with an interior hole) can triangulate into a
    non-volume mesh; a 1 µm positive buffer snaps it into a clean solid.
    """
    mesh = trimesh.creation.extrude_polygon(poly, height)
    if mesh.is_volume:
        return mesh
    rounded = poly.buffer(EXTRUDE_BUFFER_EPS)
    if isinstance(rounded, Polygon):
        return trimesh.creation.extrude_polygon(rounded, height)
    if isinstance(rounded, MultiPolygon):
        parts = [trimesh.creation.extrude_polygon(g, height) for g in rounded.geoms]
        if parts:
            return trimesh.util.concatenate(parts)
    raise ModelBuildError("Failed to construct the 3D model: degenerate geometry.")


def _extrude(geom, height):
    """Extrude a shapely Polygon/MultiPolygon into a trimesh, Z in [0, height]."""
    if isinstance(geom, Polygon):
        return _extrude_poly(geom, height)
    if isinstance(geom, MultiPolygon):
        parts = [_extrude_poly(g, height) for g in geom.geoms]
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


def _prepare_geometries(base_polys, color_polys, w_px, h_px, width_mm):
    """Scale to mm and union the base/colour layers, clipping colour to the base.

    Shared by `build_model` and `compute_default_hole` so the hole-placement logic stays
    identical in both. Returns (base_union, color_union) in mm coordinates.
    """
    scale = width_mm / max(w_px, h_px)
    base_union = (
        unary_union([_scale_and_center(p, scale, w_px, h_px) for p in base_polys])
        if base_polys else GeometryCollection()
    )
    color_union = (
        unary_union([_scale_and_center(p, scale, w_px, h_px) for p in color_polys])
        if color_polys else GeometryCollection()
    )
    if not color_union.is_empty:
        parts = _polygon_parts(color_union.intersection(base_union))
        color_union = unary_union(parts) if parts else GeometryCollection()
    return base_union, color_union


def compute_default_hole(base_polys, color_polys, w_px, h_px, width_mm, hole_diameter,
                         margin=DEFAULT_MARGIN, min_edge=DEFAULT_MIN_EDGE):
    """Return the auto-placed keyhole centre (mm) without building the mesh.

    Mirrors the single-hole fallback in `build_model`: skip the colour clearance for
    solid-dark art, then retry without any clearance. Returns (x, y) or None if no
    structurally-safe spot exists.
    """
    base_union, color_union = _prepare_geometries(base_polys, color_polys, w_px, h_px, width_mm)
    if base_union.is_empty:
        return None
    hole_radius = hole_diameter / 2.0
    ratio = (color_union.area / base_union.area) if not color_union.is_empty else 0.0
    clearance = DEFAULT_CLEARANCE if ratio < 0.85 else None
    try:
        return find_hole_center(base_union, color_union, hole_radius,
                                margin=margin, min_edge=min_edge, clearance=clearance)
    except ModelBuildError:
        if clearance is None:
            return None
        try:
            return find_hole_center(base_union, color_union, hole_radius,
                                    margin=margin, min_edge=min_edge, clearance=None)
        except ModelBuildError:
            return None


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
    holes=None,
):
    """Return (final_mesh, hole_center_mm).

    `holes` is a list of (hx, hy, outer_radius) in mm and takes priority; each gets a
    base-coloured hang-tab when `outer_radius > hole_radius`, then an inner through-hole
    is cut. `holes=[]` explicitly means **no keyhole** (returns `hole_center_mm=None`).
    `hole_position`/`tab_outer_radius` remain as the single-hole form. When none are set
    the hole is auto-placed.
    """
    base_union, color_union = _prepare_geometries(base_polys, color_polys, w_px, h_px, width_mm)

    if base_union.is_empty:
        raise ModelBuildError("Failed to construct the 3D model: empty base geometry.")

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

    # Normalise hole input to a list of (hx, hy, outer) in mm. `holes` uses the list
    # as-is (including an empty list = no hole); otherwise fall back to the single-hole
    # form, or None = auto-place.
    if holes is not None:
        hole_list = [
            (float(x), float(y), (float(o) if o is not None else None))
            for (x, y, o) in holes
        ]
    elif hole_position is not None:
        if hole_position[0] is None or hole_position[1] is None:
            raise ModelBuildError("--hole-x and --hole-y must be given together.")
        hole_list = [(float(hole_position[0]), float(hole_position[1]), tab_outer_radius)]
    else:
        hole_list = None

    total_height = base_thickness + color_thickness

    if hole_list is None:
        # Auto-place a single structural hole (and fall back to clearance=None for
        # dense artwork where the hole cannot avoid the dark layer).
        try:
            hx, hy = find_hole_center(base_union, color_union, hole_radius, clearance=clearance)
        except ModelBuildError:
            if clearance is None:
                raise
            hx, hy = find_hole_center(base_union, color_union, hole_radius, clearance=None)
        cylinder = trimesh.creation.cylinder(radius=hole_radius, height=total_height + 4.0, sections=64)
        cylinder.apply_translation([hx, hy, total_height / 2.0])
        final = trimesh.boolean.difference([merged, cylinder], engine="manifold")
        hole_center = (hx, hy)
    elif hole_list:
        # Explicit holes: union all hang-tabs first (base-coloured), then cut inner holes.
        tabs = []
        for hx, hy, outer in hole_list:
            if outer is not None and outer > hole_radius:
                tab = trimesh.creation.cylinder(radius=outer, height=base_thickness, sections=64)
                tab.apply_translation([hx, hy, base_thickness / 2.0])
                tabs.append(tab)
        if tabs:
            merged = trimesh.boolean.union([merged] + tabs, engine="manifold")
        cutters = []
        for hx, hy, _outer in hole_list:
            cyl = trimesh.creation.cylinder(radius=hole_radius, height=total_height + 4.0, sections=64)
            cyl.apply_translation([hx, hy, total_height / 2.0])
            cutters.append(cyl)
        final = trimesh.boolean.difference([merged] + cutters, engine="manifold")
        hole_center = (hole_list[0][0], hole_list[0][1])
    else:
        # holes == [] -> no keyhole.
        final = merged
        hole_center = None

    return final, hole_center
