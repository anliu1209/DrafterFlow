"""Flat-colour image analysis for DrafterFlow's Color Layer Mode.

This module deliberately does *not* try to understand a picture semantically.
It quantizes the visible pixels into a small palette, returns one binary mask per
palette entry, and leaves their vertical order to the user interface.  That keeps
the colour-layer workflow predictable for sticker-like artwork and independent
from the existing line-art extractor.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Any

import cv2
import numpy as np


class ColorLayerError(Exception):
    """Raised when a flat-colour image cannot be analysed safely."""


@dataclass
class PaletteEntry:
    """One quantized colour and its binary mask (all image coordinates)."""

    id: str
    lab: tuple[float, float, float]
    rgb: tuple[int, int, int]
    mask: np.ndarray
    pixel_count: int


@dataclass
class ColorLayerAnalysis:
    """The cropped visible artwork and its non-semantic colour segmentation."""

    width_px: int
    height_px: int
    visible_mask: np.ndarray
    palette: list[PaletteEntry]
    source_color_count: int
    pixel_size_mm: float
    background_id: str | None = None
    background_pixel_count: int = 0
    background_removed: bool = False


def _read_image(path: str) -> tuple[np.ndarray, np.ndarray]:
    """Read an image as BGR plus alpha, normalising grayscale/RGB/RGBA inputs."""
    img = cv2.imread(path, cv2.IMREAD_UNCHANGED)
    if img is None:
        raise ColorLayerError("Could not read the uploaded image.")
    if img.ndim == 2:
        bgr = cv2.cvtColor(img, cv2.COLOR_GRAY2BGR)
        alpha = np.full(img.shape, 255, dtype=np.uint8)
    elif img.ndim == 3 and img.shape[2] == 4:
        bgr = img[:, :, :3]
        alpha = img[:, :, 3]
    elif img.ndim == 3 and img.shape[2] == 3:
        bgr = img
        alpha = np.full(img.shape[:2], 255, dtype=np.uint8)
    else:
        raise ColorLayerError("The uploaded image has an unsupported pixel format.")
    return bgr, alpha


def _bbox(mask: np.ndarray) -> tuple[int, int, int, int] | None:
    ys, xs = np.nonzero(mask)
    if not len(xs):
        return None
    return int(ys.min()), int(ys.max()) + 1, int(xs.min()), int(xs.max()) + 1


def _rgb_from_lab(lab: np.ndarray) -> tuple[int, int, int]:
    """Convert OpenCV's uint8 Lab value to an RGB swatch for the browser."""
    swatch = np.clip(np.rint(lab), 0, 255).astype(np.uint8).reshape(1, 1, 3)
    bgr = cv2.cvtColor(swatch, cv2.COLOR_LAB2BGR)[0, 0]
    return int(bgr[2]), int(bgr[1]), int(bgr[0])


def _lab_from_rgb(rgb: tuple[int, int, int]) -> tuple[float, float, float]:
    sample = np.array([[[rgb[2], rgb[1], rgb[0]]]], dtype=np.uint8)
    lab = cv2.cvtColor(sample, cv2.COLOR_BGR2LAB)[0, 0]
    return tuple(float(v) for v in lab)


def _normalise_palette(palette: list[dict[str, Any]]) -> list[tuple[str, tuple[float, float, float]]]:
    """Validate palette data received from the browser before re-quantizing."""
    if not palette:
        raise ColorLayerError("Choose at least one colour layer.")
    out = []
    seen = set()
    for index, item in enumerate(palette):
        if not isinstance(item, dict):
            raise ColorLayerError("The colour-layer palette is malformed.")
        ident = str(item.get("id") or f"color-{index}")
        if ident in seen:
            raise ColorLayerError("The colour-layer palette contains duplicate entries.")
        seen.add(ident)
        raw_lab = item.get("lab")
        if isinstance(raw_lab, (list, tuple)) and len(raw_lab) == 3:
            try:
                lab = tuple(float(v) for v in raw_lab)
            except (TypeError, ValueError):
                raise ColorLayerError("A palette colour contains an invalid Lab value.")
        else:
            raw_rgb = item.get("rgb")
            if not isinstance(raw_rgb, (list, tuple)) or len(raw_rgb) != 3:
                raise ColorLayerError("A palette colour is missing its colour value.")
            try:
                rgb = tuple(int(float(v)) for v in raw_rgb)
            except (TypeError, ValueError):
                raise ColorLayerError("A palette colour contains an invalid RGB value.")
            if any(v < 0 or v > 255 for v in rgb):
                raise ColorLayerError("Palette RGB values must be between 0 and 255.")
            lab = _lab_from_rgb(rgb)
        if any(not np.isfinite(v) or v < 0 or v > 255 for v in lab):
            raise ColorLayerError("Palette Lab values must be between 0 and 255.")
        out.append((ident, lab))
    return out


def _derive_palette(lab: np.ndarray, visible: np.ndarray, palette_size: int) -> list[tuple[str, tuple[float, float, float]]]:
    """Prefer dominant flat fills, retaining subtle colours despite edge noise."""
    if palette_size < 2 or palette_size > 6:
        raise ColorLayerError("Choose between 2 and 6 colours for Color Layer Mode.")
    pixels = lab[visible].reshape(-1, 3).astype(np.float32)
    if pixels.size == 0:
        raise ColorLayerError("No visible artwork was found in this image.")

    # Images can contain millions of pixels.  A deterministic even sample keeps
    # analysis responsive without changing the assignment of every output pixel.
    if len(pixels) > 100_000:
        sample_idx = np.linspace(0, len(pixels) - 1, 100_000, dtype=np.int32)
        samples = pixels[sample_idx]
    else:
        samples = pixels
    unique, frequencies = np.unique(samples.astype(np.uint8), axis=0, return_counts=True)
    unique_count = len(unique)
    k = min(palette_size, unique_count)
    if k < 1:
        raise ColorLayerError("The image does not contain a usable colour palette.")

    # Variance-minimising k-means can merge pale skin and white to spend a
    # cluster on dark anti-aliasing instead. Flat illustrations have strong
    # histogram peaks: use those fills directly when they explain the image.
    # Nearby export/rounding variants (within 3 Lab units) belong to one fill.
    peaks = []
    for index in np.argsort(-frequencies, kind="stable"):
        candidate = unique[index].astype(np.float32)
        if not peaks or min(np.linalg.norm(candidate - peak) for peak in peaks) > 3.0:
            peaks.append(candidate)
        if len(peaks) == k:
            break
    peak_centers = np.asarray(peaks, dtype=np.float32)
    distances = ((samples[:, None, :] - peak_centers[None, :, :]) ** 2).sum(axis=2)
    if (distances.min(axis=1) <= 9.0).mean() >= 0.5:
        labels = distances.argmin(axis=1)
        counts = np.bincount(labels, minlength=len(peaks))
        ordered = np.argsort(-counts, kind="stable")
        return [(f"color-{rank}", tuple(float(v) for v in peak_centers[i])) for rank, i in enumerate(ordered)]

    cv2.setRNGSeed(1789)
    _compactness, labels, centers = cv2.kmeans(
        samples,
        k,
        None,
        (cv2.TERM_CRITERIA_EPS + cv2.TERM_CRITERIA_MAX_ITER, 30, 0.5),
        5,
        cv2.KMEANS_PP_CENTERS,
    )
    counts = np.bincount(labels.reshape(-1), minlength=k)
    # Largest-first is a stable, useful initial ordering. The user controls the
    # actual bottom-to-top order after analysis.
    ordered = np.argsort(-counts, kind="stable")
    return [(f"color-{rank}", tuple(float(v) for v in centers[i])) for rank, i in enumerate(ordered)]


def _assign_masks(lab: np.ndarray, visible: np.ndarray, palette: list[tuple[str, tuple[float, float, float]]]) -> list[np.ndarray]:
    """Assign each visible pixel to its nearest supplied Lab centre."""
    centers = np.array([entry[1] for entry in palette], dtype=np.float32)
    points = lab.reshape(-1, 3)
    labels = np.empty(len(points), dtype=np.int32)
    for start in range(0, len(points), 65536):
        chunk = points[start:start + 65536].astype(np.float32)
        distances = ((chunk[:, None, :] - centers[None, :, :]) ** 2).sum(axis=2)
        labels[start:start + len(chunk)] = distances.argmin(axis=1)
    labels = labels.reshape(visible.shape)
    return [((labels == i) & visible).astype(np.uint8) for i in range(len(palette))]


def _remove_small_regions(mask: np.ndarray, min_area_px: int) -> np.ndarray:
    """Conservatively remove isolated islands; zero leaves the mask untouched."""
    if min_area_px <= 0 or not np.any(mask):
        return mask
    count, labels, stats, _centroids = cv2.connectedComponentsWithStats(mask, connectivity=8)
    keep = np.zeros_like(mask)
    for label in range(1, count):
        if int(stats[label, cv2.CC_STAT_AREA]) >= min_area_px:
            keep[labels == label] = 1
    return keep


def _edge_connected(mask: np.ndarray) -> np.ndarray:
    """Exterior background only: enclosed regions of the same colour survive."""
    _count, labels = cv2.connectedComponents(mask, connectivity=4)
    edge_labels = np.unique(np.concatenate((labels[0], labels[-1], labels[:, 0], labels[:, -1])))
    edge_labels = edge_labels[edge_labels != 0]
    return np.isin(labels, edge_labels)


def _clean_antialias_assignment(lab, visible, palette, masks):
    """Snap only uncertain edge pixels to nearby confident flat fills.

    RGB blends between dark and white can resemble an unrelated blue/pink
    pigment. Preserve exact fills (including tiny highlights and lettering),
    and leave broad shading alone; only correct within three source pixels.
    """
    labels = np.full(visible.shape, -1, dtype=np.int32)
    confident = np.zeros(visible.shape, dtype=bool)
    for index, ((_, center), mask) in enumerate(zip(palette, masks)):
        assigned = mask > 0
        labels[assigned] = index
        for start in range(0, lab.shape[0], 64):
            chunk = lab[start:start + 64].astype(np.float32)
            distance = ((chunk - np.asarray(center, dtype=np.float32)) ** 2).sum(axis=2)
            confident[start:start + 64] |= assigned[start:start + 64] & (distance <= 9.0)
    if confident.sum() < visible.sum() * 0.5:
        return masks  # Not predominantly flat-fill artwork.
    distance, nearest = cv2.distanceTransformWithLabels((~confident).astype(np.uint8), cv2.DIST_L2, 5, labelType=cv2.DIST_LABEL_PIXEL)
    lookup = np.full(int(nearest.max()) + 1, -1, dtype=np.int32)
    lookup[nearest[confident]] = labels[confident]
    correction = visible & ~confident & (distance <= 3.0)
    labels[correction] = lookup[nearest[correction]]
    return [(visible & (labels == index)).astype(np.uint8) for index in range(len(masks))]


def color_regions(analysis: ColorLayerAnalysis):
    """Stable seed-addressed connected regions and a packed preview label map."""
    h, w = analysis.visible_mask.shape
    region_map = np.zeros((h, w), dtype=np.uint32)
    regions = []
    for entry in analysis.palette:
        count, labels, stats, _ = cv2.connectedComponentsWithStats(entry.mask, connectivity=4)
        first = np.full(count, labels.size, dtype=np.int64)
        np.minimum.at(first, labels.ravel(), np.arange(labels.size))
        lookup = np.zeros(count, dtype=np.uint32)
        for label in range(1, count):
            y, x = divmod(int(first[label]), w)
            code = len(regions) + 1
            lookup[label] = code
            regions.append({
                "code": code, "color_id": entry.id, "seed": [x, y],
                "key": f"{entry.id}:{x}:{y}",
                "pixel_count": int(stats[label, cv2.CC_STAT_AREA]),
                "bounds": [int(v) for v in stats[label, :4]],
            })
        region_map[entry.mask > 0] = lookup[labels[entry.mask > 0]]
    return regions, region_map


def resolve_color_layers(analysis: ColorLayerAnalysis, layers: list[dict[str, Any]]):
    """Keep pigment assignment separate from user-defined height groups.

    The same pigment can appear at multiple heights. Seeds select whole connected
    regions; explicit complementary groups prevent accidental duplicate geometry.
    """
    if not isinstance(layers, list) or not 1 <= len(layers) <= 24:
        raise ColorLayerError("Choose between 1 and 24 printable layers.")
    colors = {entry.id: entry for entry in analysis.palette}
    labels_by_color = {}
    occupied = np.zeros_like(analysis.visible_mask, dtype=bool)
    seen = set()
    resolved = []
    for layer in layers:
        if not isinstance(layer, dict) or not isinstance(layer.get("id"), str) or not layer["id"] or layer["id"] in seen:
            raise ColorLayerError("Layer identifiers must be unique.")
        seen.add(layer["id"])
        source_id = str(layer.get("source_color_id") or layer["id"])
        if source_id not in colors:
            raise ColorLayerError("A printable layer refers to an unknown source colour. Analyze the image again.")
        if layer.get("ignored"):
            continue
        mask = colors[source_id].mask
        seeds = layer.get("region_seeds")
        exclusions = layer.get("excluded_region_seeds", [])
        if seeds is not None or exclusions:
            if seeds is None:
                seeds = []
                whole_color = True
            else:
                whole_color = False
            if not isinstance(seeds, list) or len(seeds) > mask.size:
                raise ColorLayerError("The selected regions are malformed.")
            if source_id not in labels_by_color:
                labels_by_color[source_id] = cv2.connectedComponents(mask, connectivity=4)[1]
            labels = labels_by_color[source_id]
            selected = set()
            for seed in seeds:
                if not isinstance(seed, list) or len(seed) != 2 or any(not isinstance(v, int) for v in seed):
                    raise ColorLayerError("A region seed must be an image pixel coordinate.")
                x, y = seed
                if not (0 <= x < mask.shape[1] and 0 <= y < mask.shape[0]) or labels[y, x] == 0:
                    raise ColorLayerError("A selected region changed. Analyze and select it again.")
                selected.add(int(labels[y, x]))
            mask = mask.copy() if whole_color else np.isin(labels, list(selected)).astype(np.uint8)
            if not isinstance(exclusions, list):
                raise ColorLayerError("The excluded regions are malformed.")
            for seed in exclusions:
                if not isinstance(seed, list) or len(seed) != 2 or any(not isinstance(v, int) for v in seed):
                    raise ColorLayerError("A region seed must be an image pixel coordinate.")
                x, y = seed
                if 0 <= x < labels.shape[1] and 0 <= y < labels.shape[0] and labels[y, x]:
                    mask[labels == labels[y, x]] = 0
        if not mask.any():
            continue
        if np.any(occupied & (mask > 0)):
            raise ColorLayerError("The same region belongs to two printable layers. Split it into separate regions first.")
        occupied |= mask > 0
        resolved.append((layer, mask))
    return resolved


def analyze_color_image(
    path: str,
    *,
    palette_size: int = 4,
    alpha_threshold: int = 8,
    cleanup_min_area_px: int = 0,
    width_mm: float = 80.0,
    palette: list[dict[str, Any]] | None = None,
    remove_background: bool = False,
) -> ColorLayerAnalysis:
    """Quantize an illustration and return cropped masks for each palette colour.

    Fully transparent pixels never become geometry. For opaque images the full
    canvas is artwork until the user requests removal of the dominant edge colour.
    Removal only clears edge-connected regions, preserving enclosed white details.
    """
    if not 0 <= alpha_threshold <= 255:
        raise ColorLayerError("Alpha threshold must be between 0 and 255.")
    if cleanup_min_area_px < 0 or cleanup_min_area_px > 100_000:
        raise ColorLayerError("Cleanup size must be between 0 and 100000 pixels.")
    if width_mm <= 0:
        raise ColorLayerError("Model width must be greater than zero.")

    bgr, alpha = _read_image(path)
    visible = alpha > alpha_threshold
    opaque_edge = np.concatenate((visible[0], visible[-1], visible[:, 0], visible[:, -1])).mean() >= 0.9
    bbox = _bbox(visible)
    if bbox is None:
        raise ColorLayerError("No visible artwork was found in this image.")
    y0, y1, x0, x1 = bbox
    bgr = bgr[y0:y1, x0:x1]
    visible = visible[y0:y1, x0:x1]
    h, w = visible.shape
    if min(h, w) < 2:
        raise ColorLayerError("The visible artwork is too small to turn into geometry.")

    lab = cv2.cvtColor(bgr, cv2.COLOR_BGR2LAB)
    palette_data = _normalise_palette(palette) if palette is not None else _derive_palette(lab, visible, palette_size)
    masks = _assign_masks(lab, visible, palette_data)
    masks = _clean_antialias_assignment(lab, visible, palette_data, masks)

    background_id = None
    background_pixel_count = 0
    if opaque_edge:
        edge_counts = [int(mask[0].sum() + mask[-1].sum() + mask[1:-1, 0].sum() + mask[1:-1, -1].sum()) for mask in masks]
        candidate = int(np.argmax(edge_counts))
        if edge_counts[candidate] / max(1, 2 * w + 2 * h - 4) >= 0.35:
            background_id = palette_data[candidate][0]
            exterior = _edge_connected(masks[candidate])
            background_pixel_count = int(exterior.sum())
            if remove_background:
                masks[candidate] = (masks[candidate].astype(bool) & ~exterior).astype(np.uint8)
                visible = visible & ~exterior

    entries = []
    for (ident, center), mask in zip(palette_data, masks):
        cleaned = _remove_small_regions(mask, int(cleanup_min_area_px))
        entries.append(PaletteEntry(
            id=ident,
            lab=center,
            rgb=_rgb_from_lab(np.array(center)),
            mask=cleaned,
            pixel_count=int(cleaned.sum()),
        ))

    # Count only a bounded sample: the value is used as a UX hint, not a geometric
    # truth, and avoids a massive allocation for high-resolution uploads.
    sampled = bgr[visible]
    if len(sampled) > 40_000:
        sampled = sampled[np.linspace(0, len(sampled) - 1, 40_000, dtype=np.int32)]
    source_color_count = min(999, len(np.unique(sampled, axis=0)))
    return ColorLayerAnalysis(
        width_px=w,
        height_px=h,
        visible_mask=visible.astype(np.uint8),
        palette=entries,
        source_color_count=source_color_count,
        pixel_size_mm=float(width_mm) / float(w),
        background_id=background_id,
        background_pixel_count=background_pixel_count,
        background_removed=bool(remove_background and background_id),
    )
