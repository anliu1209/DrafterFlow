"""CLI entry point: transparent / white-background PNG -> two-layer keychain STL."""
import argparse
import os
import sys

from export import export_stl
from image_processing import ImageProcessingError, extract_masks
from model_builder import ModelBuildError, build_model
from vectorize import base_polygons, color_polygons


def _build_arg_parser():
    p = argparse.ArgumentParser(
        description="Convert a transparent or white-background image into a two-layer printable keychain STL."
    )
    p.add_argument("input", help="input image (PNG/JPG; transparent or white background)")
    p.add_argument("output", help="output .stl path")
    p.add_argument("--width", type=float, default=50.0, help="max model width in mm (default: 50)")
    p.add_argument("--base", type=float, default=4.0, help="base thickness in mm (default: 4)")
    p.add_argument("--color", type=float, default=2.0, help="dark layer thickness in mm (default: 2)")
    p.add_argument("--hole", type=float, default=4.0, help="keychain hole diameter in mm (default: 4)")
    p.add_argument("--hole-x", type=float, default=None, help="override hole center X in mm")
    p.add_argument("--hole-y", type=float, default=None, help="override hole center Y in mm")
    p.add_argument("--no-hole", action="store_true", help="generate without a keychain hole")
    p.add_argument("--dark-threshold", type=int, default=100, help="grayscale dark threshold 0-255 (default: 100)")
    p.add_argument("--alpha-threshold", type=int, default=8, help="alpha threshold 0-255 (default: 8)")
    p.add_argument(
        "--background",
        choices=("auto", "white", "transparent"),
        default="auto",
        help="background mode: auto-detect, force white-background, or force transparent (default: auto)",
    )
    p.add_argument(
        "--bg-distance",
        type=float,
        default=45.0,
        help="colour-distance threshold for white-background silhouette detection (default: 45)",
    )
    p.add_argument(
        "--debug",
        action="store_true",
        help="write diagnostic PNGs (original / silhouette / dark masks) next to the output",
    )
    return p


def main(argv=None):
    args = _build_arg_parser().parse_args(argv)

    if (args.hole_x is None) != (args.hole_y is None):
        print("Error: --hole-x and --hole-y must be given together.", file=sys.stderr)
        return 1
    if args.no_hole and (args.hole_x is not None or args.hole_y is not None):
        print("Error: --no-hole cannot be combined with --hole-x/--hole-y.", file=sys.stderr)
        return 1

    debug_dir = None
    if args.debug:
        debug_dir = os.path.splitext(args.output)[0] + "_debug"

    try:
        base_mask, color_mask, (h_px, w_px) = extract_masks(
            args.input,
            args.alpha_threshold,
            args.dark_threshold,
            background=args.background,
            background_distance_threshold=args.bg_distance,
            debug=args.debug,
            debug_dir=debug_dir,
        )
    except ImageProcessingError as exc:
        print(str(exc), file=sys.stderr)
        return 1

    try:
        base = base_polygons(base_mask)
        color = color_polygons(color_mask)
        hole_position = (args.hole_x, args.hole_y) if args.hole_x is not None else None
        mesh, hole_center = build_model(
            base,
            color,
            w_px,
            h_px,
            width_mm=args.width,
            base_thickness=args.base,
            color_thickness=args.color,
            hole_diameter=args.hole,
            hole_position=hole_position,
            holes=[] if args.no_hole else None,
        )
    except ModelBuildError as exc:
        print(str(exc), file=sys.stderr)
        return 1

    out = export_stl(mesh, args.output)
    print(f"Wrote {out}")
    if hole_center is None:
        print("No keychain hole")
    else:
        print(f"Hole center (mm): x={hole_center[0]:.2f}, y={hole_center[1]:.2f}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
