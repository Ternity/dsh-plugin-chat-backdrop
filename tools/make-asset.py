"""Downscale/encode a source wallpaper into the webp the plugin ships.

Usage:
    python tools/make-asset.py <source-image> [max-width]

The produced assets/backdrop.webp is then inlined as a data: URL into
dist/client.js by tools/build-client.mjs, so the plugin is fully self-contained
(the browser cannot load file:// images from the http page it runs on).

Requires Pillow (for example: `pip install pillow`).
"""

from __future__ import annotations

import os
import sys

from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "..", "assets", "backdrop.webp")


def main() -> int:
    if len(sys.argv) < 2:
        print(__doc__.strip(), file=sys.stderr)
        return 2

    src = sys.argv[1]
    max_width = int(sys.argv[2]) if len(sys.argv) > 2 else 2200

    image = Image.open(src).convert("RGB")
    if image.width > max_width:
        height = round(image.height * max_width / image.width)
        image = image.resize((max_width, height), Image.LANCZOS)

    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    image.save(OUT, "WEBP", quality=82, method=6)
    print(f"{src} -> {os.path.normpath(OUT)}  {image.width}x{image.height}  "
          f"{os.path.getsize(OUT) / 1024:.1f} KB")
    print("now run: node tools/build-client.mjs")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
