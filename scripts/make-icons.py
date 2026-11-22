"""Draw the app icons (tennis ball on stone) at every size the PWA needs.

Run with: python3 scripts/make-icons.py
"""

from pathlib import Path

from PIL import Image, ImageDraw

OUT = Path(__file__).resolve().parent.parent / "public" / "icons"
STONE = (43, 42, 40, 255)
BALL = (214, 236, 58, 255)
BALL_SHADE = (176, 200, 30, 255)
SEAM = (250, 248, 238, 255)
SCALE = 4  # draw large, then downsample for smooth edges


def ball(img, cx, cy, r, colour, seam, shade=None):
    """Draw a ball onto img, with the seams clipped to the ball's outline."""
    size = img.size
    layer = Image.new("RGBA", size, (0, 0, 0, 0))
    draw = ImageDraw.Draw(layer)
    box = [cx - r, cy - r, cx + r, cy + r]
    draw.ellipse(box, fill=colour)
    if shade:
        draw.pieslice(box, 20, 160, fill=shade)
        draw.ellipse([cx - r * 0.96, cy - r * 1.0, cx + r * 0.96, cy + r * 0.86], fill=colour)
    w = max(2, int(r * 0.09))
    # Two curved seams, as on a real ball.
    draw.arc([cx - r * 1.9, cy - r * 0.95, cx - r * 0.35, cy + r * 0.95], -70, 70, fill=seam, width=w)
    draw.arc([cx + r * 0.35, cy - r * 0.95, cx + r * 1.9, cy + r * 0.95], 110, 250, fill=seam, width=w)
    mask = Image.new("L", size, 0)
    ImageDraw.Draw(mask).ellipse(box, fill=255)
    clipped = Image.new("RGBA", size, (0, 0, 0, 0))
    clipped.paste(layer, (0, 0), mask)
    img.alpha_composite(clipped)


def icon(size, ball_fraction, background=STONE, mono=False):
    big = size * SCALE
    img = Image.new("RGBA", (big, big), background)
    r = big * ball_fraction / 2
    if mono:
        # Badge: white silhouette with transparent seams (Android tints it).
        ball(img, big / 2, big / 2, r, (255, 255, 255, 255), (0, 0, 0, 0))
    else:
        ball(img, big / 2, big / 2, r, BALL, SEAM, BALL_SHADE)
    return img.resize((size, size), Image.LANCZOS)


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    icon(192, 0.72).save(OUT / "icon-192.png")
    icon(512, 0.72).save(OUT / "icon-512.png")
    # Maskable icons must keep the subject inside the central 80% safe zone.
    icon(512, 0.56).save(OUT / "icon-maskable-512.png")
    icon(180, 0.72).save(OUT / "apple-touch-icon.png")
    icon(96, 0.9, background=(0, 0, 0, 0), mono=True).save(OUT / "badge-96.png")
    icon(32, 0.9, background=(0, 0, 0, 0)).save(OUT / "favicon-32.png")
    print("Wrote icons to", OUT)


if __name__ == "__main__":
    main()
