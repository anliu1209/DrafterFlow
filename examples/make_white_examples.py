"""Generate white-background test images (PNG/JPG) for the V3 white-bg pipeline.

Each image is a BGR canvas on a near-white background, drawn with cv2 only (no
Pillow dependency). Run this, then feed the outputs to main.py:

    .venv/bin/python examples/make_white_examples.py
    .venv/bin/python main.py examples/white_ring.png output/white_ring.stl --debug
"""
import os

import cv2
import numpy as np

WHITE = (255, 255, 255)
SIZE = 600


def _canvas():
    return np.full((SIZE, SIZE, 3), WHITE, dtype=np.uint8)


def make_white_ring(path):
    """The most important case: white interior + dark OUTLINE.

    A thick black ring on white. The white middle must stay part of the filled
    base silhouette (a disc), not be punched out.
    """
    img = _canvas()
    c = (SIZE // 2, SIZE // 2)
    cv2.circle(img, c, 200, (0, 0, 0), -1)
    cv2.circle(img, c, 150, WHITE, -1)
    cv2.imwrite(path, img)


def make_white_solid(path):
    """Solid black heart on white (same shape as examples/heart.png)."""
    img = _canvas()
    t = np.linspace(0, 2 * np.pi, 300)
    x = 16 * np.sin(t) ** 3
    y = 13 * np.cos(t) - 5 * np.cos(2 * t) - 2 * np.cos(3 * t) - np.cos(4 * t)
    x = x - x.min()
    y = y - y.min()
    y = y.max() - y  # flip so the heart lobes point UP (same as examples/heart.png)
    s = (SIZE * 0.82) / max(x.max(), y.max())
    pts = np.stack([x * s + SIZE * 0.09, y * s + SIZE * 0.09], axis=1).astype(np.int32)
    cv2.fillPoly(img, [pts], (0, 0, 0))
    cv2.imwrite(path, img)


def make_white_char(path):
    """A 'character': white face + black hair + eyes + a thin face outline.

    The white face interior must remain part of the base silhouette even though no
    dark pixel sits inside it.
    """
    img = _canvas()
    c = (SIZE // 2, SIZE // 2)
    # Face: black oval outline (the face stays white).
    cv2.ellipse(img, c, (150, 190), 0, 0, 360, (0, 0, 0), 10)
    # Hair: a filled black mass over the top of the face.
    cv2.circle(img, (c[0], c[1] - 120), 110, (0, 0, 0), -1)
    # Eyes: two filled black dots.
    for dx in (-70, 70):
        cv2.circle(img, (c[0] + dx, c[1] - 20), 16, (0, 0, 0), -1)
    cv2.imwrite(path, img)


def make_white_gray_edge(path):
    """Dark polygon with a gray anti-aliased halo around a black core.

    The gray halo is part of the base silhouette; the black core is the dark layer.
    """
    img = _canvas()
    c = (SIZE // 2, SIZE // 2)
    cv2.circle(img, c, 190, (110, 110, 110), -1)  # gray halo (moderately off-white)
    cv2.circle(img, c, 150, (0, 0, 0), -1)        # black core
    cv2.imwrite(path, img)


def make_white_text(path):
    """Dark text on white: several disconnected glyph islands (one has a hole)."""
    img = _canvas()
    font = cv2.FONT_HERSHEY_SIMPLEX
    cv2.putText(img, "OK", (170, 360), font, 4.2, (0, 0, 0), 22, cv2.LINE_AA)
    cv2.imwrite(path, img)


def make_all_white(path):
    """Completely white: must fail gracefully (no foreground)."""
    img = _canvas()
    cv2.imwrite(path, img)


def make_photo_bg(path):
    """Non-uniform (photograph-like) background: must warn/fail, not produce garbage."""
    img = _canvas()
    rows = np.linspace(0, 255, SIZE, dtype=np.uint8)
    gray = np.tile(rows[:, None], (1, SIZE))  # smooth vertical gradient
    img = cv2.cvtColor(gray, cv2.COLOR_GRAY2BGR)
    # A dark blob so there is *some* object, but the background itself is non-uniform.
    c = (SIZE // 2, SIZE // 2)
    cv2.circle(img, c, 40, (0, 0, 0), -1)
    cv2.imwrite(path, img)


if __name__ == "__main__":
    here = os.path.dirname(os.path.abspath(__file__))
    jobs = [
        (make_white_ring, "white_ring.png"),
        (make_white_solid, "white_solid.png"),
        (make_white_char, "white_char.png"),
        (make_white_gray_edge, "white_gray_edge.png"),
        (make_white_text, "white_text.png"),
        (make_all_white, "all_white.png"),
        (make_photo_bg, "photo_bg.png"),
    ]
    for fn, name in jobs:
        fn(os.path.join(here, name))
        print(f"Wrote examples/{name}")
