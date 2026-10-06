"""Create a non-user, deterministic five-color illustration for browser smoke tests."""
from pathlib import Path
import sys
import cv2
import numpy as np

def create_fixture(directory):
    directory = Path(directory)
    directory.mkdir(exist_ok=True)
    image = np.full((220, 200, 4), 255, dtype=np.uint8)
    navy = (103, 66, 58, 255)
    skin = (219, 231, 249, 255)
    blue = (241, 211, 186, 255)
    pink = (204, 188, 241, 255)
    cv2.rectangle(image, (55, 45), (145, 155), skin, -1)
    cv2.rectangle(image, (45, 50), (155, 95), navy, -1)
    cv2.rectangle(image, (45, 20), (155, 50), blue, -1)
    cv2.rectangle(image, (50, 25), (150, 44), (255, 255, 255, 255), -1)
    cv2.rectangle(image, (65, 145), (135, 195), blue, -1)
    cv2.rectangle(image, (20, 155), (70, 175), pink, -1)
    cv2.circle(image, (70, 69), 4, (255,255,255,255), -1)
    cv2.circle(image, (126, 69), 4, (255,255,255,255), -1)
    cv2.imwrite(str(directory / 'five-color-opaque.png'), image)
    transparent = image.copy()
    transparent[:, :, 3] = np.where(np.all(image[:, :, :3] == 255, axis=2), 0, 255)
    for x in (70, 126): cv2.circle(transparent, (x,69), 4, (255,255,255,255), -1)
    cv2.rectangle(transparent, (50,25), (150,44), (255,255,255,255), -1)
    cv2.imwrite(str(directory / 'five-color-transparent.png'), transparent)
    return directory

if __name__ == '__main__': print(create_fixture(sys.argv[1]))
