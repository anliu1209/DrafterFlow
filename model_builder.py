"""Build the two-layer keychain model from shapely polygons (mm coordinates).

Pixel -> mm conversion happens in exactly one place (here), per §9 of the DevDoc.
"""
from __future__ import annotations

import trimesh
import io
import numpy as np
from manifold3d import CrossSection, FillRule, JoinType
from shapely.affinity import affine_transform
from shapely.geometry import GeometryCollection, MultiPolygon, Point, Polygon
from shapely.ops import unary_union
from shapely.validation import make_valid


class ModelBuildError(Exception):
    """Raised when geometry construction or hole placement fails."""


DEFAULT_MARGIN = 3.0       # mm, hole top -> part top edge
DEFAULT_MIN_EDGE = 2.0     # mm, hole -> outer contour min wall
DEFAULT_CLEARANCE = 1.0    # mm, hole -> dark artwork clearance
EXTRUDE_BUFFER_EPS = 0.001  # mm, hairline rounding that snaps a degenerate outline into a solid volume
COLOR_LAYER_OVERLAP_EPS = 0.002  # mm, removes zero-thickness seams between adjacent colour masks
COLOR_BASE_MARGIN_EPS = 0.004  # mm, keeps coloured side walls inside the base instead of coplanar with it


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


def _robust_union(geometries, min_area=0.001):
    """Union traced regions after repairing contours from anti-aliased artwork.

    A quantized illustration can create a tiny self-crossing contour or a hole
    that lands microscopically outside its shell after curve smoothing.  GEOS
    rightly rejects that input, but the source is still a valid raster mask.  We
    repair each individual trace *before* unioning so Color Layer Mode remains
    robust for normal exported PNGs instead of surfacing a raw TopologyException.
    """
    repaired = []
    for geom in geometries:
        if geom is None or geom.is_empty:
            continue
        try:
            candidate = geom if geom.is_valid else make_valid(geom)
            # buffer(0) resolves near-coincident shell/hole edges left by tracing.
            candidate = candidate.buffer(0)
        except Exception:
            continue
        repaired.extend(_polygon_parts(candidate, min_area))
    if not repaired:
        return GeometryCollection()
    try:
        result = unary_union(repaired)
    except Exception:
        # A final defensive pass for a rare pair of individually-valid polygons
        # with coincident boundaries.
        result = GeometryCollection()
        for poly in repaired:
            try:
                result = poly if result.is_empty else result.union(poly)
            except Exception:
                try:
                    result = result.buffer(0).union(poly.buffer(0))
                except Exception:
                    continue
    try:
        return result if result.is_valid else make_valid(result).buffer(0)
    except Exception:
        return result


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


# --------------------------------------------------------------------------- #
# Color Layer Mode
# --------------------------------------------------------------------------- #
def _prepare_colour_layer_geometry(base_polys, layer_polys, w_px, h_px, width_mm):
    """Scale Color Layer polygons to an exact requested physical *width*.

    The original keychain mode intentionally uses the longest image dimension for
    its "max width" setting.  Color Layer Mode promises a literal width with an
    automatic aspect-ratio-preserved height, so it has its own small preparation
    helper instead of changing the legacy behaviour.
    """
    if w_px <= 0 or h_px <= 0:
        raise ModelBuildError("Failed to construct the colour model: invalid image dimensions.")
    if width_mm <= 0:
        raise ModelBuildError("Model width must be greater than zero.")
    scale = width_mm / float(w_px)
    base_union = _robust_union(
        [_scale_and_center(p, scale, w_px, h_px) for p in base_polys]
    ) if base_polys else GeometryCollection()
    # Adjacent raster regions may meet at exactly one pixel corner. Give the
    # base a four-micron perimeter allowance: it joins those point contacts and
    # ensures a coloured side wall is inside the base rather than coplanar with
    # it. Both changes are far below printer resolution.
    if not base_union.is_empty:
        base_union = _robust_union([base_union.buffer(COLOR_BASE_MARGIN_EPS)])
    if base_union.is_empty:
        raise ModelBuildError("No printable colour regions remain. Enable at least one colour layer.")

    prepared_layers = []
    for polys in layer_polys:
        union = _robust_union(
            [_scale_and_center(p, scale, w_px, h_px) for p in polys]
        ) if polys else GeometryCollection()
        if not union.is_empty:
            try:
                clipped = union.intersection(base_union)
            except Exception:
                clipped = union.buffer(0).intersection(base_union.buffer(0))
            parts = _polygon_parts(clipped)
            union = _robust_union(parts) if parts else GeometryCollection()
            if not union.is_empty:
                # Adjacent palette masks meet on an exact pixel edge. Give the
                # colour volume a 2 µm internal overlap (then clip it to the
                # base) so the boolean has real volume to merge instead of a
                # zero-thickness shared face. This eliminates non-manifold STL
                # seams while remaining far below printer resolution.
                union = _robust_union([
                    union.buffer(COLOR_LAYER_OVERLAP_EPS).intersection(base_union)
                ])
        prepared_layers.append(union)
    return base_union, prepared_layers


def build_color_layer_model(
    base_polys,
    layer_polys,
    w_px,
    h_px,
    *,
    width_mm,
    base_thickness,
    height_increment,
    base_hole=None,
    layer_thicknesses=None,
):
    """Build a categorical stepped-relief mesh for ordered flat-colour masks.

    ``layer_polys`` must be supplied from lowest to highest.  Every colour volume
    starts at Z=0 and reaches its own final height, exactly like a categorical
    height map: ``base + sum(layer_thicknesses[:index + 1])``; absent overrides
    use the uniform increment. Boolean union removes the
    internal overlapping faces so the resulting STL remains a single printable
    solid rather than a stack of coincident shells.
    """
    if base_thickness <= 0:
        raise ModelBuildError("Base thickness must be greater than zero.")
    if height_increment <= 0:
        raise ModelBuildError("Height increment must be greater than zero.")
    if not layer_polys:
        raise ModelBuildError("Choose at least one colour layer.")

    base_union, prepared_layers = _prepare_colour_layer_geometry(
        base_polys, layer_polys, w_px, h_px, width_mm
    )
    hole_circle = tab_circle = None
    hole_height = base_thickness
    if base_hole is not None:
        hx, hy, diameter = (float(base_hole[key]) for key in ('x', 'y', 'diameter'))
        if not np.isfinite([hx, hy, diameter]).all() or not 0.5 <= diameter <= 30:
            raise ModelBuildError('Hole diameter must be between 0.5 and 30 mm, with a finite position.')
        radius = diameter / 2
        hole_height = float(base_hole.get('height', base_thickness))
        if not np.isfinite(hole_height) or not 0.1 <= hole_height <= 30:
            raise ModelBuildError('Hole tab height must be between 0.1 and 30 mm.')
        hole_circle = Point(hx, hy).buffer(radius, quad_segs=32)
        tab_circle = Point(hx, hy).buffer(radius + 2, quad_segs=32)
        if base_union.intersection(tab_circle).area < 0.1:
            raise ModelBuildError('The hole tab must overlap the artwork to stay attached. Move it closer to the edge.')
    thicknesses = np.asarray(layer_thicknesses if layer_thicknesses is not None else [height_increment] * len(prepared_layers), dtype=float)
    if thicknesses.shape != (len(prepared_layers),) or not np.isfinite(thicknesses).all() or np.any(thicknesses <= 0) or np.any(thicknesses > 30):
        raise ModelBuildError('Each colour layer height must be greater than zero and at most 30 mm.')
    final_heights = (base_thickness + np.cumsum(thicknesses)).tolist()
    # Only the ordering of Z levels determines topology. Construct it using
    # stable, fixed heights, then map the finished levels to the requested mm.
    # Running the boolean on tall, narrow relief walls (e.g. 3 mm + 1 mm/colour)
    # amplified cap-intersection errors even when the very same masks worked
    # at 0.4 mm + 0.2 mm/colour.
    construction_base, construction_increment = 0.4, 0.2
    canonical_levels = np.r_[0, construction_base, construction_base + construction_increment * np.arange(1, len(prepared_layers) + 1)]
    requested_levels = np.r_[0, base_thickness, final_heights]
    def map_levels(values, source, target):
        mapped = np.interp(values, source, target)
        return np.where(values > source[-1], target[-1] + (values-source[-1]) * (target[-1]-target[-2])/(source[-1]-source[-2]), mapped)
    construction_hole_height = float(map_levels(hole_height, requested_levels, canonical_levels))

    def section(geom):
        # Native cross-section extrusion shares one triangulation and topology
        # implementation with the solid boolean. Independent ear-clipped caps
        # left tiny overlapping triangles on this artwork's complex outlines.
        contours = []
        for poly in _polygon_parts(geom):
            contours.append(np.asarray(poly.exterior.coords[:-1], dtype=np.float64))
            contours.extend(np.asarray(r.coords[:-1], dtype=np.float64) for r in poly.interiors)
        return CrossSection(contours, FillRule.EvenOdd)

    try:
        final = None
        # Each printed slab contains its own region AND every higher region.
        # Compute these nested footprints in 2D before any 3D boolean. A micron
        # of allowance per lower slab makes containment strict, preventing
        # coincident side walls/point contacts after arbitrary layer reordering.
        source_sections = [section(g) for g in prepared_layers]
        for allowance in (0.001, 0.003, 0.005):
            coverage = CrossSection()
            tiers = []
            for source in reversed(source_sections):
                coverage = (coverage + source).offset(allowance, JoinType.Miter).simplify(allowance / 4)
                tiers.append(coverage)
            tiers.reverse()
            backing = (section(base_union) + tiers[0]).offset(allowance, JoinType.Miter).simplify(allowance / 4)
            solid = backing.extrude(construction_base)
            if tab_circle is not None:
                solid = (backing + section(tab_circle)).extrude(min(construction_base, construction_hole_height))
                if construction_hole_height < construction_base:
                    solid = solid + backing.extrude(construction_base-construction_hole_height+0.02).translate((0,0,construction_hole_height-0.02))
                outside_tab = section(tab_circle) - backing
                if construction_hole_height > construction_base and not outside_tab.is_empty():
                    solid = solid + outside_tab.extrude(construction_hole_height-construction_base+0.02).translate((0,0,construction_base-0.02))
            start = construction_base - 0.02
            for index, footprint in enumerate(tiers):
                bottom = start + construction_increment * index
                solid = solid + footprint.extrude(construction_increment + 0.02).translate((0, 0, bottom))
            if hole_circle is not None:
                # Keep the original base-only cut under artwork; outside the
                # artwork the hole passes through the full custom-height tab.
                solid = solid - section(hole_circle).extrude(construction_base + 0.002).translate((0, 0, -0.002))
                outside_hole = section(hole_circle) - backing
                if construction_hole_height > construction_base and not outside_hole.is_empty():
                    solid = solid - outside_hole.extrude(construction_hole_height-construction_base+0.022).translate((0,0,construction_base-0.02))
            # Binary STL stores float32 coordinates: check the delivered file,
            # not merely the double-precision in-memory solid.
            for tolerance in (0.0001, 0.001):
                output = solid.simplify(tolerance).to_mesh64()
                candidate = trimesh.Trimesh(output.vert_properties.copy(), output.tri_verts, process=False)
                # Map the native canonical levels before the single STL
                # round-trip. Checking the final delivered mesh is sufficient;
                # retaining another validated mesh doubled geometry/cache RAM.
                z = np.round(candidate.vertices[:, 2], 6)
                candidate.vertices[:, 2] = map_levels(z, canonical_levels, requested_levels)
                delivered = trimesh.load(
                    io.BytesIO(candidate.export(file_type="stl")), file_type="stl", force="mesh",
                )
                if delivered.is_volume:
                    final = delivered
                    break
            if final is not None:
                break
    except Exception as exc:
        raise ModelBuildError(f"Failed to combine colour-layer geometry: {exc}") from exc
    if final is None or len(final.faces) == 0 or not final.is_volume:
        raise ModelBuildError("Could not create a closed colour model. Increase cleanup to remove tiny regions and try again.")
    return final, final_heights
