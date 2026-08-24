"""Image processing: extract base (silhouette) and color (dark artwork) masks.

Two input styles are supported, auto-detected via `background`:

- Transparent RGBA PNG — silhouette comes from the alpha channel (V1 behavior).
- Opaque white-background PNG/JPG — silhouette is recovered by thresholding the
  colour distance from an estimated background colour (detected from the corners).

Both paths return (base_mask, color_mask, (h_px, w_px)) cropped to the artwork's
bounding box, so `--width` means "the keychain is ~N mm" regardless of canvas
margin.
"""
from __future__ import annotations

import os
import sys

import cv2
import numpy as np

IMAGE_EXTS = (".png", ".jpg", ".jpeg")

# Above this many separate foreground regions, warn that the background may not be
# uniform (photographic clutter) — still proceeds, just flags it for inspection.
WARN_SEPARATE_REGIONS = 20


class ImageProcessingError(Exception):
    """Raised when the input image is unusable for V1 processing."""


# --------------------------------------------------------------------------- #
# Mode detection
# --------------------------------------------------------------------------- #
def _has_transparency(img, alpha_threshold):
    """True if `img` carries a real alpha channel with some transparent pixels."""
    if img.ndim != 3 or img.shape[2] != 4:
        return False
    return bool(np.any(img[:, :, 3] <= alpha_threshold))


def _detect_mode(img, alpha_threshold):
    """'transparent' if there is meaningful alpha, else 'white'."""
    return "transparent" if _has_transparency(img, alpha_threshold) else "white"


def _bbox(mask):
    """Bounding box of a binary mask as (y0, y1, x0, x1) slices."""
    ys, xs = np.nonzero(mask)
    if ys.size == 0:
        return None
    return ys.min(), ys.max() + 1, xs.min(), xs.max() + 1


def _slice(bbox, *arrays):
    """Slice each array to the same (y0, y1, x0, x1) bbox, skipping None."""
    if bbox is None:
        return tuple(None for _ in arrays)
    y0, y1, x0, x1 = bbox
    return tuple(a[y0:y1, x0:x1] if a is not None else None for a in arrays)


# --------------------------------------------------------------------------- #
# Transparent path (unchanged V1 behavior)
# --------------------------------------------------------------------------- #
def _transparent_masks(img, alpha_threshold, dark_threshold):
    """V1 logic: alpha -> base silhouette, dark-in-alpha -> color mask."""
    if img.ndim != 3 or img.shape[2] != 4:
        raise ImageProcessingError(
            "Error: The image must contain a transparent background (alpha channel)."
        )

    alpha = img[:, :, 3]
    bgr = img[:, :, :3]
    gray = cv2.cvtColor(bgr, cv2.COLOR_BGR2GRAY)

    if np.all(alpha > alpha_threshold):
        raise ImageProcessingError(
            "Error: The image must contain a transparent background.\n"
            "Please upload a PNG with transparency."
        )

    base_mask = (alpha > alpha_threshold).astype(np.uint8)
    if base_mask.sum() == 0:
        raise ImageProcessingError("Error: No visible artwork detected.")

    bbox = _bbox(base_mask)
    base_mask, gray, bgr = _slice(bbox, base_mask, gray, bgr)
    color_mask = ((gray < dark_threshold) & (base_mask > 0)).astype(np.uint8)
    if color_mask.sum() == 0:
        raise ImageProcessingError(
            "Error: No dark artwork detected.\n"
            "Please make sure your artwork contains sufficiently dark pixels."
        )
    debug = {"000_original.png": bgr, "002_silhouette.png": base_mask, "003_dark.png": color_mask}
    return base_mask, color_mask, base_mask.shape, debug


# --------------------------------------------------------------------------- #
# White-background path
# --------------------------------------------------------------------------- #
def _estimate_bg(bgr):
    """Estimate the background colour from a few corner patches (BGR median)."""
    h, w = bgr.shape[:2]
    patch = max(2, int(round(min(h, w) * 0.03)))
    corners = [
        bgr[:patch, :patch],
        bgr[:patch, w - patch:],
        bgr[h - patch:, :patch],
        bgr[h - patch:, w - patch:],
    ]
    pixels = np.concatenate([c.reshape(-1, 3) for c in corners])
    return np.median(pixels.astype(np.float32), axis=0)


def _border_purity(bgr, bg, distance_threshold):
    """Fraction of border pixels close to the estimated background colour.

    A low value means the artwork runs to the edges or the background is not
    uniform (e.g. a photograph) — both make a white-background assumption unsafe.
    """
    h, w = bgr.shape[:2]
    f = max(2, int(round(min(h, w) * 0.02)))
    frame = np.zeros((h, w), dtype=bool)
    frame[:f, :] = True
    frame[-f:, :] = True
    frame[:, :f] = True
    frame[:, -f:] = True
    pixels = bgr[frame].astype(np.float32)
    dist = np.linalg.norm(pixels - bg, axis=1)
    return float((dist <= distance_threshold).mean())


def _clean_fg(fg, keep_ratio=0.01):
    """Denoise a foreground mask and drop tiny specks, keeping blobs above a
    relative size floor (so multiple legitimate islands survive, but JPEG noise
    and photographic clutter do not). Returns (cleaned, n_kept)."""
    k = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (3, 3))
    cleaned = cv2.morphologyEx(fg, cv2.MORPH_CLOSE, k, iterations=2)
    cleaned = cv2.morphologyEx(cleaned, cv2.MORPH_OPEN, k, iterations=1)

    n, labels, stats, _ = cv2.connectedComponentsWithStats(cleaned, 8)
    if n <= 1:
        return cleaned, 0
    areas = stats[1:, cv2.CC_STAT_AREA]
    biggest = int(areas.max())
    keep = [i for i in range(1, n) if areas[i - 1] >= max(12, keep_ratio * biggest)]
    if not keep:
        return cleaned, 0
    return np.isin(labels, keep).astype(np.uint8), len(keep)


def _fill_silhouette(fg):
    """Return the complete silhouette: fill the outer contours of the foreground.

    This is what keeps white interior regions (a white face inside a dark
    outline, etc.) part of the base plate.
    """
    contours, _ = cv2.findContours(fg, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    filled = np.zeros_like(fg)
    cv2.drawContours(filled, contours, -1, 1, thickness=cv2.FILLED)
    return filled


def _white_masks(img, dark_threshold, distance_threshold):
    """Recover the artwork silhouette from a (near-)uniform white background."""
    bgr = img[:, :, :3]
    gray = cv2.cvtColor(bgr, cv2.COLOR_BGR2GRAY)
    bg = _estimate_bg(bgr)

    dist_full = np.linalg.norm(bgr.astype(np.float32) - bg, axis=2)
    if dist_full.max() < max(1.5, 1.5 * distance_threshold):
        raise ImageProcessingError(
            "Error: Could not reliably detect the artwork. The image has very low "
            "contrast against the background.\n"
            "Please upload a transparent PNG or an image with a clean white background."
        )

    purity = _border_purity(bgr, bg, distance_threshold)
    if purity < 0.5:
        raise ImageProcessingError(
            "Error: Could not reliably detect a uniform background. The background "
            "does not appear to be a single flat colour (e.g. a photograph).\n"
            "Please upload a transparent PNG or an image with a clean white background."
        )

    fg_raw = (dist_full > distance_threshold).astype(np.uint8)
    if fg_raw.sum() == 0:
        raise ImageProcessingError(
            "Error: Could not reliably detect the artwork. No foreground was found "
            "against the background.\n"
            "Please upload a transparent PNG or an image with a clean white background."
        )

    fg, n_kept = _clean_fg(fg_raw)
    if n_kept == 0:
        raise ImageProcessingError(
            "Error: Could not reliably detect the artwork. The detected foreground "
            "contains only tiny specks.\n"
            "Please upload a transparent PNG or an image with a clean white background."
        )
    if n_kept > WARN_SEPARATE_REGIONS:
        print(
            f"Warning: detected {n_kept} separate regions; the background may not "
            "be uniform. Inspect the result with --debug.",
            file=sys.stderr,
        )

    base_full = _fill_silhouette(fg)
    bbox = _bbox(base_full)
    base_mask, gray, bgr, fg_raw = _slice(bbox, base_full, gray, bgr, fg_raw)
    color_mask = ((gray < dark_threshold) & (base_mask > 0)).astype(np.uint8)
    if color_mask.sum() == 0:
        raise ImageProcessingError(
            "Error: No dark artwork detected.\n"
            "Please make sure your artwork contains sufficiently dark pixels."
        )
    debug = {
        "000_original.png": bgr,
        "001_fg_raw.png": fg_raw,
        "002_silhouette.png": base_mask,
        "003_dark.png": color_mask,
    }
    return base_mask, color_mask, base_mask.shape, debug


# --------------------------------------------------------------------------- #
# Public API
# --------------------------------------------------------------------------- #
def extract_masks(
    image_path,
    alpha_threshold=8,
    dark_threshold=100,
    background="auto",
    background_distance_threshold=45.0,
    debug=False,
    debug_dir=None,
):
    """Return (base_mask, color_mask, (height_px, width_px)).

    base_mask : silhouette (alpha, or colour-distance from estimated background)
    color_mask: dark pixels within the silhouette

    `background`:
        auto        — use transparency if present, else white-background recovery
        transparent — force the V1 alpha path (raise if the image is opaque)
        white       — force the white-background path

    Both masks are cropped to the silhouette's bounding box. When `debug` is True,
    diagnostic PNGs (original / raw-foreground / silhouette / dark) are written to
    `debug_dir` (defaults to `./image_debug`).
    """
    if not os.path.exists(image_path):
        raise ImageProcessingError(f"Error: File not found: {image_path}")

    if not image_path.lower().endswith(IMAGE_EXTS):
        raise ImageProcessingError("Error: Please upload a PNG or JPG image.")

    img = cv2.imread(image_path, cv2.IMREAD_UNCHANGED)
    if img is None:
        raise ImageProcessingError("Error: Failed to read the image.")

    mode = _detect_mode(img, alpha_threshold) if background == "auto" else background
    if mode == "transparent":
        base_mask, color_mask, shape, debug_arrays = _transparent_masks(
            img, alpha_threshold, dark_threshold
        )
    elif mode == "white":
        base_mask, color_mask, shape, debug_arrays = _white_masks(
            img, dark_threshold, background_distance_threshold
        )
    else:
        raise ImageProcessingError(
            f"Error: Unknown background mode '{background}' (use auto/white/transparent)."
        )

    if debug:
        _write_debug(debug_dir or "image_debug", debug_arrays)

    return base_mask, color_mask, shape


def _write_debug(debug_dir, arrays):
    """Write a dict of {filename: uint8 mask/BGR image} as PNGs under debug_dir."""
    os.makedirs(debug_dir, exist_ok=True)
    for name, arr in arrays.items():
        if arr is None or arr.dtype != np.uint8:
            continue
        if arr.ndim == 2 and arr.max() <= 1:
            arr = (arr * 255).astype(np.uint8)
        cv2.imwrite(os.path.join(debug_dir, name), arr)
