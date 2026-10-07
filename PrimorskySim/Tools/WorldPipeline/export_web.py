#!/usr/bin/env python3
"""Экспорт данных района для 3D-приложения (Apps/Web/data/district.json).

Координаты — метры в локальной поперечной Меркатора от crs.engine_origin (та же проекция, что в
SimCore::GeoTransform): x — восток, y — север. Высоты зданий не выдумываются: если в OSM нет
height/building:levels, здание помечается h=0, и приложение рисует его условной высотой другим цветом.

    python3 export_web.py --osm .cache/osm/region.osm.pbf
"""
from __future__ import annotations

import argparse
import json
import math
import sys
from pathlib import Path

import osmium

sys.path.insert(0, str(Path(__file__).parent))
from import_osm import bbox_of  # noqa: E402

ROOT = Path(__file__).resolve().parents[2]
REF = ROOT / "WorldReference"
OUT = ROOT / "Apps" / "Web" / "data" / "district.json"

ROAD_KEEP = {
    "motorway": 4, "trunk": 4, "primary": 3, "secondary": 2, "tertiary": 2, "motorway_link": 1, "trunk_link": 1,
    "primary_link": 1, "secondary_link": 1, "tertiary_link": 1, "unclassified": 1, "residential": 1,
    "living_street": 1, "service": 0, "pedestrian": 0,
}
DEFAULT_WIDTH = {4: 20.0, 3: 16.0, 2: 12.0, 1: 7.0, 0: 4.5}
BTYPE = {"apartments": 1, "residential": 1, "house": 2, "detached": 2, "commercial": 3, "retail": 3, "office": 3,
         "school": 4, "kindergarten": 4, "university": 4, "hospital": 5, "industrial": 6, "warehouse": 6,
         "garages": 7, "garage": 7, "service": 7, "church": 8, "train_station": 9}


class TM:
    """Порт SimCore::GeoTransform::Forward (Snyder, WGS84, k0=1)."""
    A = 6378137.0
    F = 1 / 298.257223563
    E2 = F * (2 - F)
    EP2 = E2 / (1 - E2)

    def __init__(self, lat0, lon0):
        self.lat0, self.lon0 = math.radians(lat0), math.radians(lon0)
        self.m0 = self._m(self.lat0)

    def _m(self, p):
        e2, e4, e6 = self.E2, self.E2 ** 2, self.E2 ** 3
        return self.A * ((1 - e2 / 4 - 3 * e4 / 64 - 5 * e6 / 256) * p - (3 * e2 / 8 + 3 * e4 / 32 + 45 * e6 / 1024) * math.sin(2 * p)
                         + (15 * e4 / 256 + 45 * e6 / 1024) * math.sin(4 * p) - (35 * e6 / 3072) * math.sin(6 * p))

    def __call__(self, lon, lat):
        p = math.radians(lat)
        s, c, t = math.sin(p), math.cos(p), math.tan(p)
        n = self.A / math.sqrt(1 - self.E2 * s * s)
        tt, cc = t * t, self.EP2 * c * c
        a = (math.radians(lon) - self.lon0) * c
        a2 = a * a
        x = n * (a + (1 - tt + cc) * a2 * a / 6 + (5 - 18 * tt + tt * tt + 72 * cc - 58 * self.EP2) * a2 * a2 * a / 120)
        y = self._m(p) - self.m0 + n * t * (a2 / 2 + (5 - tt + 9 * cc + 4 * cc * cc) * a2 * a2 / 24
                                             + (61 - 58 * tt + tt * tt + 600 * cc - 330 * self.EP2) * a2 * a2 * a2 / 720)
        return round(x, 1), round(y, 1)


def num(v):
    try:
        return float(str(v).replace(",", ".").split()[0])
    except (TypeError, ValueError, IndexError):
        return None


class Metro(osmium.SimpleHandler):
    """Маршруты метро (route=subway), станции и вода в расширенной рамке района."""

    def __init__(self, bbox):
        super().__init__()
        self.bbox = bbox
        self.routes, self.stations, self.water = [], [], []
        self.ways = {}

    def _in(self, lon, lat):
        x0, y0, x1, y1 = self.bbox
        return x0 <= lon <= x1 and y0 <= lat <= y1

    def node(self, n):
        t = n.tags
        if t.get("railway") == "station" and t.get("station") == "subway" and self._in(n.location.lon, n.location.lat):
            self.stations.append({"name": t.get("name"), "lon": n.location.lon, "lat": n.location.lat})

    def way(self, w):
        t = w.tags
        try:
            coords = [(nd.lon, nd.lat) for nd in w.nodes]
        except osmium.InvalidLocationError:
            return
        if t.get("railway") == "subway":
            self.ways[w.id] = coords
        elif (t.get("natural") == "water" or t.get("waterway") == "riverbank") and w.is_closed() and len(coords) >= 4:
            if any(self._in(x, y) for x, y in coords):
                self.water.append(coords)

    def relation(self, r):
        t = r.tags
        if t.get("route") == "subway":
            self.routes.append({"name": t.get("name", ""), "ref": t.get("ref", ""), "colour": t.get("colour", "#888888"),
                                "ways": [m.ref for m in r.members if m.type == "w"]})


def chain(segments):
    """Склейка путей маршрута в одну полилинию (порядок членов relation обычно последовательный)."""
    line = []
    for seg in segments:
        if not seg:
            continue
        if not line:
            line = list(seg)
            continue
        if seg[0] == line[-1]:
            line += seg[1:]
        elif seg[-1] == line[-1]:
            line += list(reversed(seg))[1:]
        elif seg[-1] == line[0]:
            line = seg[:-1] + line
        elif seg[0] == line[0]:
            line = list(reversed(seg))[:-1] + line
        else:
            line += seg  # разрыв в данных — соединяем как есть
    return line


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--osm", type=Path, required=True)
    args = ap.parse_args()

    manifest = json.loads((REF / "WorldManifest.json").read_text(encoding="utf-8"))
    origin = manifest["crs"]["engine_origin"]
    tm = TM(origin["lat"], origin["lon"])

    boundary = json.loads((REF / "Boundary/PrimorskyDistrictBoundary.geojson").read_text(encoding="utf-8"))
    geom = boundary["features"][0]["geometry"]
    rings = [geom["coordinates"][0]] if geom["type"] == "Polygon" else [p[0] for p in geom["coordinates"]]

    buildings = []
    for f in json.loads((REF / "Buildings/osm_buildings.geojson").read_text(encoding="utf-8"))["features"]:
        p = f["properties"]
        pts = [tm(x, y) for x, y in f["geometry"]["coordinates"][0][:-1]]
        h = num(p.get("height"))
        lv = num(p.get("building:levels"))
        height = h if h else (lv * 3.0 + 1.0 if lv else 0)
        flat = [v for pt in pts for v in pt]
        addr = f"{p.get('addr:street', '')} {p.get('addr:housenumber', '')}".strip()
        buildings.append([flat, round(height, 1), BTYPE.get(p.get("building"), 0), p.get("name") or addr or ""])

    roads = []
    for f in json.loads((REF / "Roads/osm_roads.geojson").read_text(encoding="utf-8"))["features"]:
        p = f["properties"]
        cls = ROAD_KEEP.get(p.get("highway"))
        if cls is None:
            continue
        lanes = num(p.get("lanes"))
        width = lanes * 3.5 if lanes else DEFAULT_WIDTH[cls]
        flat = [v for pt in (tm(x, y) for x, y in f["geometry"]["coordinates"]) for v in pt]
        roads.append([flat, round(width, 1), cls, p.get("name") or ""])

    x0, y0, x1, y1 = bbox_of(boundary)
    margin = 0.03
    mh = Metro((x0 - margin * 2, y0 - margin, x1 + margin * 2, y1 + margin))
    mh.apply_file(str(args.osm), locations=True)

    lines = {}
    for r in mh.routes:
        key = r["ref"] or r["name"]
        if key in lines:
            continue  # второе направление того же маршрута
        poly = chain([mh.ways.get(w) for w in r["ways"]])
        if len(poly) < 2:
            continue
        inside = [i for i, (x, y) in enumerate(poly) if mh._in(x, y)]
        if not inside:
            continue
        a, b = max(0, inside[0] - 1), min(len(poly), inside[-1] + 2)
        lines[key] = {"name": r["name"], "ref": r["ref"], "colour": r["colour"],
                      "track": [v for pt in (tm(x, y) for x, y in poly[a:b]) for v in pt]}

    out = {
        "source": "© OpenStreetMap contributors (ODbL). Выгрузка СПб, download.openstreetmap.fr",
        "origin": origin,
        "boundary": [[v for pt in (tm(x, y) for x, y in ring) for v in pt] for ring in rings],
        "buildings": buildings,
        "roads": roads,
        "water": [[v for pt in (tm(x, y) for x, y in ring[:-1]) for v in pt] for ring in mh.water],
        "stations": [{"name": s["name"], "p": tm(s["lon"], s["lat"])} for s in mh.stations if s["name"]],
        "lines": list(lines.values()),
        "stops": [{"name": f["properties"].get("name") or "", "p": tm(*f["geometry"]["coordinates"])}
                  for f in json.loads((REF / "Transport/osm_stops.geojson").read_text(encoding="utf-8"))["features"]],
    }
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(out, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print(f"{OUT}: {OUT.stat().st_size / 1e6:.1f} MB, buildings={len(buildings)} (без высоты: {sum(1 for b in buildings if not b[1])}), "
          f"roads={len(roads)}, water={len(out['water'])}, stations={len(out['stations'])}, lines={[(l['ref'], l['name']) for l in out['lines']]}")


if __name__ == "__main__":
    main()
