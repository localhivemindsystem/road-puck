#!/usr/bin/env python3
"""Draw what the puck firmware shows, as PNGs, without a board.

Run from the repo root:  python3 tools/puck_preview.py
Mirrors the layout in firmware/RoadPuck/RoadPuck.ino (same fonts, sizes,
baselines and fit rules) and writes docs/puck-screens.png.
"""
import math
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parent.parent
FD = ROOT / "tools" / "fonts"
F = {
    "STATUS": ImageFont.truetype(str(FD / "Anton-Regular.ttf"), 124),
    "BIG": ImageFont.truetype(str(FD / "Anton-Regular.ttf"), 84),
    "ROAD": ImageFont.truetype(str(FD / "BarlowCondensed-ExtraBold.ttf"), 48),
    "ROAD_S": ImageFont.truetype(str(FD / "BarlowCondensed-ExtraBold.ttf"), 38),
    "SMALL": ImageFont.truetype(str(FD / "BarlowCondensed-Bold.ttf"), 32),
    "TINY": ImageFont.truetype(str(FD / "BarlowCondensed-SemiBold.ttf"), 22),
}
RED, RED_DIM, AMBER, GREEN = (255, 59, 48), (138, 18, 12), (255, 176, 32), (61, 220, 132)
WHITE, GREY, DARK = (255, 255, 255), (154, 164, 174), (38, 44, 51)
OVERFLOW = []


def cap(f):
    return -f.getbbox("H", anchor="ls")[1]


def chord(top, bottom, margin):
    r = 233
    dy = max(abs(top - r), abs(bottom - r))
    return 0 if dy >= r else int(2 * math.sqrt(r * r - dy * dy)) - 2 * margin


def fit(d, text, baseline, color, *names):
    text = text.upper()
    use = names[0]
    for n in names:
        use = n
        if F[n].getlength(text) <= chord(baseline - cap(F[n]), baseline, 22):
            break
    f = F[use]
    w = f.getlength(text)
    if w > chord(baseline - cap(f), baseline, 22):
        OVERFLOW.append(text)
    d.text(((466 - w) / 2, baseline), text, font=f, fill=color, anchor="ls")


def ring(d, color, thick):
    d.ellipse((0, 0, 465, 465), fill=color)
    d.ellipse((thick, thick, 465 - thick, 465 - thick), fill=(0, 0, 0))


def fmt_dist(m):
    if m < 0:
        return ""
    if m < 1000:
        return f"{10 if m < 10 else (m + 5) // 10 * 10} M"
    return f"{m // 1000}.{(m % 1000) // 100} KM"


def badge(d, limit, over):
    cx, cy, r = 233, 58, 38
    if over >= 2:
        d.ellipse((cx - r, cy - r, cx + r, cy + r), fill=RED); num = WHITE
    elif over == 1:
        d.ellipse((cx - r, cy - r, cx + r, cy + r), fill=AMBER); num = (0, 0, 0)
    else:
        d.ellipse((cx - r, cy - r, cx + r, cy + r), fill=RED)
        d.ellipse((cx - r + 8, cy - r + 8, cx + r - 8, cy + r - 8), fill=WHITE); num = (0, 0, 0)
    f = F["ROAD"]
    t = str(limit)
    d.text((cx - f.getlength(t) / 2, cy + cap(f) // 2), t, font=f, fill=num, anchor="ls")


def screen(msg):
    img = Image.new("RGB", (466, 466), (0, 0, 0))
    d = ImageDraw.Draw(img)
    if msg == "CONNECT":
        ring(d, DARK, 8)
        fit(d, "ROAD PUCK", 100, GREY, "SMALL")
        fit(d, "CONNECT", 228, WHITE, "STATUS", "BIG")
        fit(d, "OPEN THE PHONE APP", 292, WHITE, "ROAD", "ROAD_S")
        fit(d, "TAP CONNECT PUCK", 350, AMBER, "ROAD_S", "SMALL")
        fit(d, "RoadPuck-A1B2", 410, GREY, "TINY")
        return img
    f = msg.split("|") + [""] * 10
    _, st, road, dist, detail, acc, kind, word, limit, over = f[:10]
    dist = int(dist) if dist else -1
    limit = int(limit) if limit else 0
    over = int(over) if over else 0
    if st in ("X", "R"):
        d.ellipse((0, 0, 465, 465), fill=RED)
        fit(d, kind or "RESTRICTED", 90, WHITE, "SMALL")
        fit(d, "WRONG" if st == "R" else "DON'T", 206, WHITE, "STATUS")
        fit(d, "WAY" if st == "R" else "ENTER", 322, WHITE, "STATUS")
        fit(d, road, 378, WHITE, "ROAD", "ROAD_S", "SMALL")
        fit(d, detail, 420, WHITE, "SMALL", "TINY")
        return img
    col, w0 = {"C": (RED, "CLOSED"), "E": (RED, "NO ENTRY"), "W": (AMBER, "CLOSING"), "P": (AMBER, "PERMIT"),
               "S": (RED if over else AMBER, "CAMERA"), "Y": (AMBER, "KEEP CLEAR"),
               "O": (GREEN, "OPEN"), "F": (GREEN, "FREE"), "G": (AMBER, "NO GPS")}.get(st, (GREEN, "CLEAR"))
    word = word or w0
    strong = st in ("C", "E") or (st == "S" and over)
    ring(d, col, 14 if strong else 8)
    if limit:
        badge(d, limit, over)
    elif acc:
        fit(d, f"GPS {acc} M", 60, GREY, "TINY")
    fit(d, kind or "ROAD PUCK", 122, col, "SMALL", "TINY")
    fit(d, word, 238, col, "STATUS", "BIG")
    fit(d, road, 292, WHITE, "ROAD", "ROAD_S", "SMALL")
    if dist >= 0:
        fit(d, fmt_dist(dist), 378, WHITE, "BIG")
        fit(d, detail, 424, WHITE if strong else GREY, "SMALL", "TINY")
    else:
        fit(d, detail, 350, WHITE if strong or st in ("P", "F") else GREY, "ROAD_S", "SMALL", "TINY")
    return img


def demo_screens():
    """The same sample screens as the firmware's demo mode."""
    src = (ROOT / "firmware" / "RoadPuck" / "RoadPuck.ino").read_text()
    block = src[src.index("const char *DEMO[] = {"):src.index("};", src.index("const char *DEMO[] = {"))]
    import re
    return ["CONNECT"] + [m.replace("\\'", "'") for m in re.findall(r'"(2\|[^"]*)"', block)]


SCREENS = demo_screens()

if __name__ == "__main__":
    tiles = [screen(s) for s in SCREENS]
    pad, cols = 24, 5
    rows = (len(tiles) + cols - 1) // cols
    sheet = Image.new("RGB", (cols * (466 + pad) + pad, rows * (466 + pad) + pad), (20, 24, 29))
    mask = Image.new("L", (466, 466), 0)
    ImageDraw.Draw(mask).ellipse((0, 0, 465, 465), fill=255)
    for i, t in enumerate(tiles):
        sheet.paste(t, (pad + (i % cols) * (466 + pad), pad + (i // cols) * (466 + pad)), mask)
    out = ROOT / "docs" / "puck-screens.png"
    sheet.save(out)
    print("wrote", out, "| text too wide:", OVERFLOW or "none")
