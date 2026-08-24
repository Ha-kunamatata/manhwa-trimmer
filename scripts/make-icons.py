#!/usr/bin/env python3
"""
앱 아이콘을 그린다.

    python scripts/make-icons.py

넘어가는 종이 한 장. 그 실루엣은 앱이 실제로 페이지를 넘길 때 쓰는 것과 같은
호(arc) 수식에서 나온다 — 종이는 늘어나지 않으므로 자유단이 뻣뻣한 판만큼
멀리 가지 못하고, 들린 쪽은 멀어지며 좁아진다. 아이콘만 따로 그리면 그 형태가
앱과 미묘하게 어긋나므로, 같은 식을 쓴다.

4배로 그린 뒤 줄여서 가장자리를 매끄럽게 만든다. Pillow에는 안티에일리어싱이
없으므로 이 방법 말고는 계단이 남는다.
"""
import math
from pathlib import Path

from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "icons"

INK = (18, 19, 26)          # 배경 — 깊은 먹색
PAPER = (233, 227, 214)     # 놓여 있는 종이
TURN = (18, 138, 158)       # 넘어가는 종이 — 앱의 강조색
SHADE = (12, 90, 104)       # 넘어가는 종이의 어두운 쪽

SS = 4                      # supersampling


def curl(progress, width, samples=64, bend=0.95):
    """core/curl.js와 같은 호. 호 길이가 보존된다."""
    theta = progress * math.pi
    k = (bend * math.sin(theta)) / max(1.0, width)
    out = []
    for i in range(samples + 1):
        s = width * i / samples
        a = theta + k * s
        if abs(k) < 1e-9:
            x, z = s * math.cos(theta), s * math.sin(theta)
        else:
            x = (math.sin(a) - math.sin(theta)) / k
            z = (math.cos(theta) - math.cos(a)) / k
        out.append((s, x, z))
    return out


def foreshorten(z, width):
    focal = width * 2.6
    return focal / (focal + max(0.0, z))


def rounded(draw, box, r, fill):
    draw.rounded_rectangle(box, radius=r, fill=fill)


def draw_icon(size, inset):
    """`inset`은 가장자리에서 비워둘 비율 — 마스크되는 아이콘일수록 크게."""
    S = size * SS
    im = Image.new("RGB", (S, S), INK)
    d = ImageDraw.Draw(im)

    # 펼친 책. 정사각형 안에 들어가야 하므로 세로를 조금 눌러 담는다.
    pad = S * inset
    w = S - pad * 2
    h = w * 0.74
    left, top = pad, (S - h) / 2
    right, bottom = left + w, top + h
    spine = left + w / 2
    half = w / 2
    midY = (top + bottom) / 2
    radius = int(w * 0.05)

    # 두 쪽 다 깔아둔다 — 한 쪽만 있으면 아이콘의 반이 비어 보인다
    rounded(d, (left, top, right, bottom), radius, PAPER)

    # 넘어가는 종이는 오른쪽 한 장. 진행도를 낮게 둬야 종이가 눕고 넓게 잡혀
    # 페이지로 읽힌다 — 세워버리면 얇은 조각이 되어 무엇인지 알 수 없다.
    shape = curl(0.15, half)
    upper, lower = [], []
    for _s, x, z in shape:
        m = foreshorten(z, half)
        px = spine + x * m
        ph = h * m
        upper.append((px, midY - ph / 2))
        lower.append((px, midY + ph / 2))
    d.polygon(upper + lower[::-1], fill=TURN)

    # 자유단 쪽으로 갈수록 빛을 덜 받는다 — 굽었다는 것이 여기서 읽힌다
    edge = int(len(shape) * 0.62)
    d.polygon(upper[edge:] + lower[edge:][::-1], fill=SHADE)

    # 책등
    d.rectangle((spine - S * 0.005, top, spine + S * 0.005, bottom), fill=(150, 143, 130))

    return im.resize((size, size), Image.LANCZOS)


def main():
    OUT.mkdir(exist_ok=True)
    # 마스크되는 아이콘은 원으로 잘려도 살아남게 안쪽으로 더 넣는다
    jobs = [("icon-512.png", 512, 0.16), ("icon-192.png", 192, 0.16),
            ("maskable-512.png", 512, 0.26), ("favicon-32.png", 32, 0.10)]
    for name, size, inset in jobs:
        img = draw_icon(size, inset)
        img.save(OUT / name, "PNG", optimize=True)
        print(f"  {name}  {size}x{size}  {(OUT / name).stat().st_size} bytes")


if __name__ == "__main__":
    main()
