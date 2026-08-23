"""Generate example transparent PNGs for testing."""
import os

import cv2
import numpy as np


def _canvas(size):
    return np.zeros((size, size, 4), dtype=np.uint8)


def make_txt(path, size=600):
    """Rectangle frame + 'TXT' text, dark on transparent."""
    img = _canvas(size)
    margin = 60
    cv2.rectangle(
        img, (margin, margin), (size - margin, size - margin), (0, 0, 0, 255), 14
    )
    font = cv2.FONT_HERSHEY_SIMPLEX
    scale = 3.2
    thickness = 12
    (tw, th), _ = cv2.getTextSize("TXT", font, scale, thickness)
    cv2.putText(
        img,
        "TXT",
        ((size - tw) // 2, (size + th) // 2),
        font,
        scale,
        (0, 0, 0, 255),
        thickness,
        cv2.LINE_AA,
    )
    cv2.imwrite(path, img)


def make_heart(path, size=600):
    """Solid black heart on transparent (the acceptance-test image)."""
    img = _canvas(size)
    t = np.linspace(0, 2 * np.pi, 300)
    x = 16 * np.sin(t) ** 3
    y = 13 * np.cos(t) - 5 * np.cos(2 * t) - 2 * np.cos(3 * t) - np.cos(4 * t)
    x = x - x.min()
    y = y - y.min()
    y = y.max() - y  # flip so the heart points DOWN (lobes up), the usual keychain orientation
    s = (size * 0.82) / max(x.max(), y.max())
    pts = np.stack([x * s + size * 0.09, y * s + size * 0.09], axis=1).astype(np.int32)
    cv2.fillPoly(img, [pts], (0, 0, 0, 255))
    cv2.imwrite(path, img)


if __name__ == "__main__":
    here = os.path.dirname(os.path.abspath(__file__))
    make_txt(os.path.join(here, "txt.png"))
    make_heart(os.path.join(here, "heart.png"))
    print("Wrote examples/txt.png and examples/heart.png")
