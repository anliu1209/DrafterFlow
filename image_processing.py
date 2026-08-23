"""Image processing: extract base (silhouette) and color (dark artwork) masks."""
from __future__ import annotations

import os

import cv2
import numpy as np


class ImageProcessingError(Exception):
    """Raised when the input image is unusable for V1 processing."""


def extract_masks(image_path, alpha_threshold=8, dark_threshold=100):
    """Return (base_mask, color_mask, (height_px, width_px)).

    base_mask : silhouette (alpha > alpha_threshold)
    color_mask: dark pixels within the silhouette

    Both masks are cropped to the silhouette's bounding box so the returned
    pixel size refers to the artwork itself, not the transparent canvas around
    it. This makes `--width` mean "the keychain is ~N mm", regardless of how
    much empty margin the PNG carries.
    """
    if not os.path.exists(image_path):
        raise ImageProcessingError(f"Error: File not found: {image_path}")

    if not image_path.lower().endswith(".png"):
        raise ImageProcessingError("Error: Please upload a PNG image.")

    img = cv2.imread(image_path, cv2.IMREAD_UNCHANGED)
    if img is None:
        raise ImageProcessingError("Error: Failed to read the image.")

    if img.ndim != 3 or img.shape[2] != 4:
        raise ImageProcessingError(
            "Error: The image must contain a transparent background (alpha channel)."
        )

    alpha = img[:, :, 3]
    gray = cv2.cvtColor(img[:, :, :3], cv2.COLOR_BGR2GRAY)

    if np.all(alpha > alpha_threshold):
        raise ImageProcessingError(
            "Error: The image must contain a transparent background.\n"
            "Please upload a PNG with transparency."
        )

    base_mask = (alpha > alpha_threshold).astype(np.uint8)
    if base_mask.sum() == 0:
        raise ImageProcessingError("Error: No visible artwork detected.")

    # Crop to the artwork's bounding box (see docstring).
    ys, xs = np.nonzero(base_mask)
    y0, y1 = ys.min(), ys.max() + 1
    x0, x1 = xs.min(), xs.max() + 1
    base_mask = base_mask[y0:y1, x0:x1]
    alpha = alpha[y0:y1, x0:x1]
    gray = gray[y0:y1, x0:x1]

    color_mask = ((gray < dark_threshold) & (alpha > alpha_threshold)).astype(np.uint8)
    if color_mask.sum() == 0:
        raise ImageProcessingError(
            "Error: No dark artwork detected.\n"
            "Please make sure your artwork contains sufficiently dark pixels."
        )

    return base_mask, color_mask, base_mask.shape
