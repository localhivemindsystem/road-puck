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
    _, st, road, dist, detail, acc, kind = msg.split("|")
    dist = int(dist) if dist else -1
    if st == "X":
        d.ellipse((0, 0, 465, 465), fill=RED)
        fit(d, kind or "RESTRICTED", 90, WHITE, "SMALL")
        fit(d, "DON'T", 206, WHITE, "STATUS")
        fit(d, "ENTER", 322, WHITE, "STATUS")
        fit(d, road, 378, WHITE, "ROAD", "ROAD_S", "SMALL")
        fit(d, detail, 420, WHITE, "SMALL", "TINY")
        return img
    col, word = {"C": (RED, "CLOSED"), "W": (AMBER, "CLOSING"), "O": (GREEN, "OPEN"), "G": (AMBER, "NO GPS")}.get(st, (GREEN, "CLEAR"))
    ring(d, col, 14 if st == "C" else 8)
    if acc:
        fit(d, f"GPS {acc} M", 54, GREY, "TINY")
    fit(d, kind or "ROAD PUCK", 100, col, "SMALL")
    fit(d, word, 228, col, "STATUS", "BIG")
    fit(d, road, 290, WHITE, "ROAD", "ROAD_S", "SMALL")
    if dist >= 0:
        fit(d, fmt_dist(dist), 378, WHITE, "BIG")
        fit(d, detail, 424, WHITE if st == "C" else GREY, "SMALL", "TINY")
    else:
        fit(d, detail, 350, GREY, "ROAD_S", "SMALL", "TINY")
    return img


SCREENS = [
    "CONNECT",
    "1|K|NO CLOSURES AHEAD||NEAREST 1.2 KM|6|SCHOOL STREETS",
    "1|W|STUDLEY RD|420|CLOSES IN 6 MIN|7|SCHOOL STREET",
    "1|C|HACKFORD RD|180|UNTIL 09:15|8|SCHOOL STREET",
    "1|X|HACKFORD RD|30|CLOSED UNTIL 09:15|8|SCHOOL STREET",
    "1|O|SOUTH LAMBETH RD|250|NEXT CLOSURE 14:45|9|SCHOOL STREET",
]

if __name__ == "__main__":
    tiles = [screen(s) for s in SCREENS]
    pad = 24
    sheet = Image.new("RGB", (len(tiles) * (466 + pad) + pad, 466 + 2 * pad), (20, 24, 29))
    for i, t in enumerate(tiles):
        mask = Image.new("L", (466, 466), 0)
        ImageDraw.Draw(mask).ellipse((0, 0, 465, 465), fill=255)
        sheet.paste(t, (pad + i * (466 + pad), pad), mask)
    out = ROOT / "docs" / "puck-screens.png"
    sheet.save(out)
    print("wrote", out, "| text too wide:", OVERFLOW or "none")
