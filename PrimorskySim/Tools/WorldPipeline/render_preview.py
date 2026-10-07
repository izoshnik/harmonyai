#!/usr/bin/env python3
"""Превью карты района по слоям WorldReference -> Docs/img/primorsky_osm_preview.png (нужен matplotlib)."""
import json
import math
from pathlib import Path

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt  # noqa: E402
from matplotlib.collections import LineCollection, PolyCollection  # noqa: E402

ROOT = Path(__file__).resolve().parents[2]
REF = ROOT / "WorldReference"
K = math.cos(math.radians(60.02))  # выравнивание масштаба по широте


def layer(rel):
    return json.loads((REF / rel).read_text(encoding="utf-8"))["features"]


def proj(coords):
    return [(x * K, y) for x, y in coords]


def main():
    fig, ax = plt.subplots(figsize=(16, 11), dpi=110)
    fig.patch.set_facecolor("#15171b")
    ax.set_facecolor("#15171b")
    boundary = layer("Boundary/PrimorskyDistrictBoundary.geojson")[0]["geometry"]
    rings = [boundary["coordinates"][0]] if boundary["type"] == "Polygon" else [p[0] for p in boundary["coordinates"]]
    for ring in rings:
        ax.fill(*zip(*proj(ring)), color="#1f242b", zorder=0)
    buildings = layer("Buildings/osm_buildings.geojson")
    ax.add_collection(PolyCollection([proj(f["geometry"]["coordinates"][0]) for f in buildings], facecolor="#8a8f99", edgecolor="none", zorder=2))
    roads = layer("Roads/osm_roads.geojson")
    style = {"motorway": ("#e8a23a", 2.2), "trunk": ("#e8a23a", 2.0), "primary": ("#e0c060", 1.6), "secondary": ("#d8d8d8", 1.2),
             "tertiary": ("#bbbbbb", 0.9), "residential": ("#888888", 0.6), "unclassified": ("#888888", 0.6), "service": ("#555555", 0.3)}
    for cls, (color, width) in style.items():
        lines = [proj(f["geometry"]["coordinates"]) for f in roads if f["properties"]["highway"].startswith(cls)]
        ax.add_collection(LineCollection(lines, colors=color, linewidths=width, zorder=3))
    for ring in rings:
        ax.plot(*zip(*proj(ring)), color="#4aa3ff", lw=1.5, zorder=4)
    stops = layer("Transport/osm_stops.geojson")
    ax.scatter([f["geometry"]["coordinates"][0] * K for f in stops], [f["geometry"]["coordinates"][1] for f in stops], s=3, color="#55cc77", zorder=5)
    stations = 0
    for f in layer("Metro/osm_metro.geojson"):
        x, y = f["geometry"]["coordinates"]
        if f["properties"].get("railway") == "station":
            stations += 1
            ax.scatter([x * K], [y], s=90, color="#e04040", zorder=6, edgecolors="white")
            ax.annotate(f["properties"].get("name"), (x * K, y), xytext=(6, 6), textcoords="offset points", color="white", fontsize=11, zorder=7)
        else:
            ax.scatter([x * K], [y], s=10, color="#ff8080", zorder=5)
    ax.set_aspect("equal")
    ax.autoscale()
    ax.axis("off")
    n = lambda v: f"{v:,}".replace(",", "\u202f")  # noqa: E731
    ax.set_title(f"Приморский район — OSM: {n(len(buildings))} зданий, {n(len(stops))} остановок, {stations} станций метро",
                 color="white", fontsize=14)
    out = ROOT / "Docs" / "img" / "primorsky_osm_preview.png"
    out.parent.mkdir(parents=True, exist_ok=True)
    fig.savefig(out, bbox_inches="tight", facecolor=fig.get_facecolor())
    print(out)


if __name__ == "__main__":
    main()
