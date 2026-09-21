#!/usr/bin/env python3
"""Render the Open Graph share card.

Social platforms do not render SVG previews -- Discord, Twitter/X, Facebook, iMessage
and Slack all require a raster image at an absolute URL, so pointing og:image at
favicon.svg produces no embed at all. This renders the 1200x630 PNG those scrapers want,
using the site's own accent ramp so the card matches the page it links to.

Regenerate with:  python3 tools/og-card.py packages/account/portal/assets/og.png
"""
import math
import sys
from PIL import Image, ImageDraw, ImageFont

W, H = 1200, 630
BG = (8, 9, 13)
INK = (247, 248, 252)
MUTED = (150, 156, 172)
ACCENT = (255, 179, 71)
ACCENT_LIFT = (255, 208, 138)
ACCENT_HOT = (255, 84, 112)

out_path = sys.argv[1] if len(sys.argv) > 1 else "og.png"
title = sys.argv[2] if len(sys.argv) > 2 else "Phoenix"
subtitle = sys.argv[3] if len(sys.argv) > 3 else "The cloud your robot can talk to again"
kicker = sys.argv[4] if len(sys.argv) > 4 else "OPEN SOURCE  ·  SELF-HOSTED  ·  JIBO"


def font(size, bold=False):
    candidates = [
        "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf" if bold
        else "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
        "/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf" if bold
        else "/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf",
    ]
    for path in candidates:
        try:
            return ImageFont.truetype(path, size)
        except OSError:
            continue
    return ImageFont.load_default()


img = Image.new("RGB", (W, H), BG)
d = ImageDraw.Draw(img)

# Accent glow anchored bottom-left, mirroring the site's hero treatment. Drawn as
# concentric alpha rings so the falloff is smooth without needing a blur pass.
glow = Image.new("RGBA", (W, H), (0, 0, 0, 0))
gd = ImageDraw.Draw(glow)
cx, cy, rmax = 120, H + 40, 560
for i in range(120, 0, -1):
    r = rmax * i / 120
    t = 1 - i / 120
    col = (
        int(ACCENT_HOT[0] + (ACCENT[0] - ACCENT_HOT[0]) * t),
        int(ACCENT_HOT[1] + (ACCENT[1] - ACCENT_HOT[1]) * t),
        int(ACCENT_HOT[2] + (ACCENT[2] - ACCENT_HOT[2]) * t),
        max(0, int(26 * (1 - i / 120) ** 1.5)),
    )
    gd.ellipse([cx - r, cy - r, cx + r, cy + r], fill=col)
img = Image.alpha_composite(img.convert("RGBA"), glow).convert("RGB")
d = ImageDraw.Draw(img)

# Hairline grid, very low contrast -- the same texture the site uses behind the hero.
for x in range(0, W, 60):
    d.line([(x, 0), (x, H)], fill=(18, 20, 27), width=1)
for y in range(0, H, 60):
    d.line([(0, y), (W, y)], fill=(18, 20, 27), width=1)

PAD = 84

# The flame mark, traced as a filled polygon from the site's SVG path so the card
# carries the same logo rather than an approximation.
flame = [
    (16, 2), (21, 7), (24.5, 12), (26, 18.5), (25.4, 22.6), (22.8, 25.6), (19.6, 26.9),
    (20.4, 24.6), (20.6, 22.0), (19.6, 19.3), (18.1, 16.9), (17.2, 14.6), (17.0, 12.5),
    (14.6, 14.6), (13.0, 17.0), (12.6, 19.9), (13.1, 22.6), (14.5, 25.0), (15.2, 26.5),
    (11.6, 25.2), (8.6, 22.3), (7.0, 17.4), (8.6, 12.4), (11.6, 7.4),
]
S = 2.05
OX, OY = PAD, PAD - 6
d.polygon([(OX + px * S, OY + py * S) for px, py in flame], fill=ACCENT)

wordmark_f = font(44, bold=True)
d.text((OX + 78, OY + 10), "Phoenix", font=wordmark_f, fill=INK)

# Kicker
kick_f = font(21, bold=True)
d.text((PAD, 232), kicker, font=kick_f, fill=ACCENT)

# Title, wrapped by measured width rather than character count.
title_f = font(78, bold=True)
words = title.split()
lines, cur = [], ""
for w in words:
    probe = (cur + " " + w).strip()
    if d.textlength(probe, font=title_f) > W - 2 * PAD and cur:
        lines.append(cur)
        cur = w
    else:
        cur = probe
if cur:
    lines.append(cur)

y = 280
for line in lines[:2]:
    d.text((PAD, y), line, font=title_f, fill=INK)
    y += 88

# Subtitle
sub_f = font(32)
words = subtitle.split()
lines, cur = [], ""
for w in words:
    probe = (cur + " " + w).strip()
    if d.textlength(probe, font=sub_f) > W - 2 * PAD - 40 and cur:
        lines.append(cur)
        cur = w
    else:
        cur = probe
if cur:
    lines.append(cur)
y += 8
for line in lines[:2]:
    d.text((PAD, y), line, font=sub_f, fill=MUTED)
    y += 44

# Accent rule along the bottom, fading out to the right.
ry = H - 58
for x in range(PAD, W - PAD):
    t = (x - PAD) / (W - 2 * PAD)
    fade = max(0.0, 1 - t * 1.35)
    col = (
        int(BG[0] + (ACCENT[0] - BG[0]) * fade),
        int(BG[1] + (ACCENT[1] - BG[1]) * fade),
        int(BG[2] + (ACCENT[2] - BG[2]) * fade),
    )
    d.line([(x, ry), (x, ry + 3)], fill=col)

img.save(out_path, "PNG", optimize=True)
print(f"  wrote {out_path} ({W}x{H})")
