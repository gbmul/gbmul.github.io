#!/usr/bin/env python3
"""Generate the GBmul icon set from GBEmb.jpg (a photo of an embroidered
Game Boy patch).

Design notes
------------
* The patch is tall (594x919 px in the source), so every square icon carries
  fabric margin on the left/right. That is kept rather than cropped, so the
  whole Game Boy stays visible at 16 px.
* The fabric background is softened (the patch stays sharp). This reads better
  at icon sizes and compresses far better than a noisy photo background.
* Maskable variant: the patch is shrunk to 66% of the canvas height so it sits
  inside the maskable safe zone (inner 80% circle).
"""
import sys
from pathlib import Path

import numpy as np
from PIL import Image, ImageFilter
from scipy import ndimage as ndi

ROOT = Path(__file__).resolve().parent
# Source photo lives next to the repo (persona folder), not inside it.
SRC = str(Path(sys.argv[1]).resolve() if len(sys.argv) > 1 else ROOT.parent / "GBEmb.jpg")
OUT = str(ROOT)

# patch silhouette in the source photo (measured)
PX0, PY0, PX1, PY1 = 207, 61, 800, 979
PW, PH = PX1 - PX0, PY1 - PY0            # 593 x 918
CX, CY = (PX0 + PX1) // 2, (PY0 + PY1) // 2

# square crop for the "any" icons: patch height = 92.6% of the side
SIDE_ANY = 992
ANY_BOX = (CX - SIDE_ANY // 2, CY - SIDE_ANY // 2)


def patch_mask(photo: Image.Image) -> Image.Image:
    """Soft alpha mask of the patch (dilated then feathered)."""
    grey = photo.convert("L")
    smooth = np.asarray(grey.filter(ImageFilter.BoxBlur(25)), dtype=np.float32)
    m = smooth > 105
    lab, n = ndi.label(m)
    sizes = ndi.sum(m, lab, range(1, n + 1))
    big = ndi.binary_fill_holes(lab == int(np.argmax(sizes)) + 1)
    big = ndi.binary_dilation(big, np.ones((11, 11)))
    mask = Image.fromarray((big * 255).astype(np.uint8))
    return mask.filter(ImageFilter.GaussianBlur(7))


def styled_photo() -> Image.Image:
    """Sharp patch over a softened fabric background."""
    photo = Image.open(SRC).convert("RGB")
    plate = photo.filter(ImageFilter.GaussianBlur(14))
    plate.paste(photo, (0, 0), patch_mask(photo))
    return plate


def square_icon(size: int) -> Image.Image:
    art = styled_photo().crop((ANY_BOX[0], ANY_BOX[1],
                               ANY_BOX[0] + SIDE_ANY, ANY_BOX[1] + SIDE_ANY))
    return art.resize((size, size), Image.LANCZOS)


def maskable_icon(size: int) -> Image.Image:
    """Patch at 66% of the height, blurred fabric extended to fill the square."""
    art = styled_photo()
    side = int(round(PH / 0.66))
    x0, y0 = CX - side // 2, CY - side // 2

    arr = np.asarray(art)
    pad_l, pad_t = max(0, -x0), max(0, -y0)
    pad_r = max(0, (x0 + side) - arr.shape[1])
    pad_b = max(0, (y0 + side) - arr.shape[0])
    plate = np.pad(arr, ((pad_t, pad_b), (pad_l, pad_r), (0, 0)), mode="edge")
    plate = Image.fromarray(plate).filter(ImageFilter.GaussianBlur(side / 20))
    plate = plate.crop((x0 + pad_l, y0 + pad_t,
                        x0 + pad_l + side, y0 + pad_t + side))
    return plate.resize((size, size), Image.LANCZOS)


def main() -> None:
    def save_png(img: Image.Image, path: str, quantize: bool = False) -> None:
        """Photo content in a palette PNG: ~2.5x smaller, visually identical
        at icon display sizes."""
        if quantize:
            img = img.quantize(colors=256, method=Image.MEDIANCUT,
                               dither=Image.FLOYDSTEINBERG)
        img.save(path, optimize=True)

    save_png(square_icon(192), f"{OUT}/icons/icon-192.png")
    save_png(square_icon(512), f"{OUT}/icons/icon-512.png", quantize=True)
    save_png(maskable_icon(512), f"{OUT}/icons/icon-maskable-512.png", quantize=True)
    save_png(square_icon(180), f"{OUT}/icons/apple-touch-icon-180.png")

    base = square_icon(256)
    base.save(f"{OUT}/favicon.ico", format="ICO",
              sizes=[(16, 16), (32, 32), (48, 48), (64, 64)])
    print("done")


if __name__ == "__main__":
    main()
