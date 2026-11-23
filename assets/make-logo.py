#!/usr/bin/env python3
"""
Generates the Wave brand mark used by the bot (assets/wave.png).

This is a wordmark remake, not the community's original file. If the real asset
exists, drop it at assets/wave.png and delete nothing else - render.js picks up
whatever sits at that path, this script is only here so the repo is reproducible
after a clone.

    python assets/make-logo.py
"""

from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter, ImageFont

SIZE = 512
SS = 2  # supersample, then downscale: cheap anti-aliasing without any dependency


def gradient(width: int, height: int, top: tuple, bottom: tuple) -> Image.Image:
    img = Image.new("RGB", (width, height))
    draw = ImageDraw.Draw(img)
    for y in range(height):
        t = y / max(1, height - 1)
        draw.line(
            [(0, y), (width, y)],
            fill=(
                round(top[0] + (bottom[0] - top[0]) * t),
                round(top[1] + (bottom[1] - top[1]) * t),
                round(top[2] + (bottom[2] - top[2]) * t),
            ),
        )
    return img


def main() -> None:
    w = SIZE * SS
    canvas = Image.new("RGBA", (w, w), (0, 0, 0, 0))

    # Rounded square panel.
    panel = Image.new("RGBA", (w, w), (0, 0, 0, 0))
    ImageDraw.Draw(panel).rounded_rectangle(
        [0, 0, w - 1, w - 1], radius=int(w * 0.22), fill=(11, 15, 22, 255)
    )
    canvas.alpha_composite(panel)

    # Two crescent arcs, the swirl behind the wordmark.
    arc_layer = Image.new("RGBA", (w, w), (0, 0, 0, 0))
    ad = ImageDraw.Draw(arc_layer)
    pad = int(w * 0.10)
    box = [pad, pad, w - pad, w - pad]
    ad.arc(box, start=205, end=430, fill=(201, 214, 232, 255), width=int(w * 0.035))
    ad.arc(box, start=20, end=175, fill=(143, 163, 191, 220), width=int(w * 0.035))
    arc_layer = arc_layer.filter(ImageFilter.GaussianBlur(int(w * 0.004)))
    canvas.alpha_composite(arc_layer)

    # Metallic wordmark.
    font_size = int(w * 0.30)
    font = None
    for candidate in ("segoeuib.ttf", "arialbd.ttf", "impact.ttf"):
        try:
            font = ImageFont.truetype(f"C:/Windows/Fonts/{candidate}", font_size)
            break
        except OSError:
            continue
    if font is None:
        raise SystemExit("no bold system font found")

    text = "wave"
    probe = ImageDraw.Draw(Image.new("RGBA", (10, 10)))
    left, top, right, bottom = probe.textbbox((0, 0), text, font=font)
    tw, th = right - left, bottom - top

    mask = Image.new("L", (tw + 40, th + 40), 0)
    ImageDraw.Draw(mask).text((20 - left, 20 - top), text, font=font, fill=255)

    metal = gradient(mask.width, mask.height, (255, 255, 255), (150, 168, 196)).convert(
        "RGBA"
    )
    metal.putalpha(mask)

    cx = (w - metal.width) // 2
    cy = (w - metal.height) // 2 - int(w * 0.02)
    shadow = Image.new("RGBA", canvas.size, (0, 0, 0, 0))
    shadow.paste(
        (0, 0, 0, 170), (cx + int(w * 0.006), cy + int(w * 0.012)), metal.split()[3]
    )
    shadow = shadow.filter(ImageFilter.GaussianBlur(int(w * 0.012)))
    canvas.alpha_composite(shadow)
    canvas.alpha_composite(metal, (cx, cy))

    out = canvas.resize((SIZE, SIZE), Image.LANCZOS)
    path = Path(__file__).resolve().parent / "wave.png"
    out.save(path)
    print(f"wrote {path} {out.size}")


if __name__ == "__main__":
    main()
