#!/usr/bin/env python3
"""Растр мини-карты для игры: Apps/Godot/assets/minimap.png + data/minimap.json (origin, метров на пиксель)."""
import json
from pathlib import Path

from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parents[2]
G = ROOT / "Apps" / "Godot"
RES = 4.0

d = json.loads((G / "data" / "district.json").read_text(encoding="utf-8"))
xs = [v for r in d["boundary"] for v in r[0::2]]
ys = [v for r in d["boundary"] for v in r[1::2]]
x0, y0, x1, y1 = min(xs) - 800, min(ys) - 800, max(xs) + 800, max(ys) + 800
W, H = int((x1 - x0) / RES), int((y1 - y0) / RES)
img = Image.new("RGB", (W, H), (44, 49, 41))
dr = ImageDraw.Draw(img)
P = lambda f: [((f[i] - x0) / RES, (y1 - f[i + 1]) / RES) for i in range(0, len(f) - 1, 2)]
for k, ring in d.get("green", []):
    if len(ring) >= 6:
        dr.polygon(P(ring), fill=(46, 62, 40) if k == "forest" else (52, 66, 46))
for ring in d.get("water", []):
    if len(ring) >= 6:
        dr.polygon(P(ring), fill=(46, 82, 115))
for f, w, cls, _ in d["roads"]:
    col = (120, 118, 110) if cls == 5 else ((215, 205, 180) if cls >= 2 else (160, 160, 160))
    width = 1 if cls == 5 else max(2, int(w / RES))
    dr.line(P(f), fill=col, width=width)
for b in d["buildings"]:
    if len(b[0]) >= 6:
        dr.polygon(P(b[0]), fill=(108, 108, 114), outline=(80, 80, 86))
for ring in d["boundary"]:
    dr.line(P(ring), fill=(74, 163, 255), width=3)
img.save(G / "assets" / "minimap.png", optimize=True)
(G / "data" / "minimap.json").write_text(json.dumps({"x0": x0, "y1": y1, "res": RES, "w": W, "h": H}))
print(W, H)
