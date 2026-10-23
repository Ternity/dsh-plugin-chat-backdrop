"""Offline 'what will the wallpaper look like' preview.

Renders the source photo the way CSS `background-size: cover` would crop it for
plausible conversation-column aspect ratios, at several veil strengths, and
paints a mock of the real UI on top (assistant text directly on the backdrop, a
user bubble, the composer card) so the veil/crop choice is made by looking at
something close to the real thing instead of guessing.

    python tools/preview-crop.py

This is a design aid only -- it is not verification of the running plugin.
"""

from __future__ import annotations

import os

from PIL import Image, ImageDraw, ImageFilter, ImageFont

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.join(HERE, "..", "assets", "backdrop.webp")
OUT = os.path.join(HERE, "..", "docs", "design-preview.png")

SURFACE = (0x15, 0x15, 0x17)   # dark theme --dsw-alias-bg-base
BUBBLE = (0x2C, 0x2C, 0x2E)    # --dsw-specific-bubble (dark)
CARD = (0x2C, 0x2C, 0x2E)      # --dsw-specific-input-major (dark)
LABEL = (0xEC, 0xED, 0xEE)

CASES = [
    ("1.20 center veil 30%", 1200, 1000, "center", 0.30),
    ("1.20 center veil 45%", 1200, 1000, "center", 0.45),
    ("0.70 center veil 30%", 700, 1000, "center", 0.30),
    ("0.70 center veil 45%", 700, 1000, "center", 0.45),
]


def font(size: int):
    for candidate in (r"C:\Windows\Fonts\msyh.ttc", r"C:\Windows\Fonts\segoeui.ttf"):
        try:
            return ImageFont.truetype(candidate, size)
        except OSError:
            continue
    return ImageFont.load_default()


def cover_crop(image: Image.Image, width: int, height: int, position: str) -> Image.Image:
    scale = max(width / image.width, height / image.height)
    scaled = image.resize((round(image.width * scale), round(image.height * scale)), Image.LANCZOS)
    x_ratio = 0.5 if position == "center" else float(position.rstrip("%")) / 100
    left = round((scaled.width - width) * x_ratio)
    top = round((scaled.height - height) * 0.5)
    return scaled.crop((left, top, left + width, top + height))


def mock_ui(tile: Image.Image, bubble_keep: float = 0.78, card_keep: float = 0.82) -> None:
    draw = ImageDraw.Draw(tile)
    small, large = font(15), font(17)
    # Assistant prose: no background of its own, straight on the backdrop.
    width = tile.width
    margin = max(24, round(width * 0.14))
    text_left, text_width = margin, width - margin * 2
    y = round(tile.height * 0.30)
    for line in (
        "The conversation column keeps its own theme colour,",
        "mixed with the wallpaper behind it. Long prose like",
        "this sits directly on that mixture, so the wash has",
        "to stay strong enough for comfortable reading.",
    ):
        draw.text((text_left, y), line, font=small, fill=LABEL)
        y += 26

    # User bubble, painted with the rebound --dsw-specific-bubble over the photo.
    bubble = Image.new("RGB", (round(text_width * 0.72), 92), BUBBLE)
    tile.paste(Image.blend(tile.crop((text_left, y + 26, text_left + bubble.width, y + 26 + bubble.height)), bubble, bubble_keep),
               (text_left, y + 26))
    draw.text((text_left + 14, y + 42), "Show me the foggy library wallpaper please", font=small, fill=LABEL)

    # Composer card at the bottom, with a frost stand-in for backdrop-filter.
    card_top = tile.height - 132
    card = (text_left, card_top, text_left + text_width, card_top + 92)
    frost = tile.crop(card).filter(ImageFilter.GaussianBlur(10))
    tile.paste(Image.blend(frost, Image.new("RGB", (card[2] - card[0], card[3] - card[1]), CARD), card_keep), card[:2])
    draw.rounded_rectangle(card, radius=16, outline=(0x3A, 0x3A, 0x3C))
    draw.text((text_left + 16, card_top + 22), "Ask anything  (composer card, 14px frost)", font=large, fill=LABEL)


def main() -> int:
    source = Image.open(SRC).convert("RGB")
    tiles = []
    for label, width, height, position, veil in CASES:
        tile = cover_crop(source, width, height, position)
        tile = Image.blend(tile, Image.new("RGB", tile.size, SURFACE), veil)
        mock_ui(tile)
        draw = ImageDraw.Draw(tile)
        draw.rectangle((0, 0, 250, 26), fill=(0, 0, 0))
        draw.text((8, 6), label, font=font(14), fill=(255, 255, 255))
        tiles.append(tile)

    gap = 14
    canvas = Image.new("RGB", (sum(t.width for t in tiles) + gap * (len(tiles) + 1),
                               max(t.height for t in tiles) + gap * 2), (8, 8, 10))
    x = gap
    for tile in tiles:
        canvas.paste(tile, (x, gap))
        x += tile.width + gap
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    canvas.save(OUT)
    print(f"{OUT}  {canvas.width}x{canvas.height}  {os.path.getsize(OUT) / 1024:.0f} KB")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
