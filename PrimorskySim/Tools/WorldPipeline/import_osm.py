#!/usr/bin/env python3
"""Импорт OSM-выгрузки в WorldReference: слои GeoJSON + записи WorldManifest.

    python3 import_osm.py --osm spb.osm.pbf [--boundary WorldReference/Boundary/PrimorskyDistrictBoundary.geojson]

Что делает:
  * берёт только объекты внутри границы района (дороги — если хоть одна точка внутри);
  * пишет слои Roads/Buildings/Transport/Metro/POI в WorldReference/*/osm_*.geojson;
  * добавляет/обновляет в манифесте здания, станции и входы метро, остановки, POI, улицы
    (одна запись на улицу; геометрия — в слое). Ручные записи манифеста не затираются;
  * статус OSM-объектов — PARTIALLY_VERIFIED (данные сообщества, без сверки на месте).
    Пустые поля (этажность и т.п.) не выдумываются: остаются null + verification_needs;
  * задаёт crs.engine_origin = центр рамки границы, если origin ещё не зафиксирован.

Мультиполигоны зданий (relation) пока не импортируются — отмечаются в отчёте.
"""
from __future__ import annotations

import argparse
import datetime as dt
import json
import re
import sys
from collections import defaultdict
from pathlib import Path

import osmium

sys.path.insert(0, str(Path(__file__).parent))
from validate_world import point_in_geojson  # noqa: E402

ROOT = Path(__file__).resolve().parents[2]
REF = ROOT / "WorldReference"
MANIFEST = REF / "WorldManifest.json"
DEFAULT_BOUNDARY = REF / "Boundary" / "PrimorskyDistrictBoundary.geojson"

ROAD_CLASSES = {
    "motorway", "trunk", "primary", "secondary", "tertiary", "unclassified", "residential",
    "motorway_link", "trunk_link", "primary_link", "secondary_link", "tertiary_link",
    "living_street", "service", "pedestrian", "footway", "cycleway", "path", "steps", "track",
}
BUILDING_TYPES = {  # OSM building/amenity/shop → тип из Docs/World.md
    "apartments": "residential", "residential": "residential", "house": "residential", "dormitory": "residential",
    "commercial": "commercial", "retail": "commercial", "office": "office", "school": "school",
    "kindergarten": "school", "university": "school", "hospital": "hospital", "clinic": "clinic",
    "industrial": "industrial", "warehouse": "warehouse", "garage": "parking", "garages": "parking",
    "parking": "parking", "church": "religious", "mosque": "religious", "sports_hall": "sports",
    "supermarket": "supermarket", "mall": "shopping_mall", "pharmacy": "pharmacy", "bank": "bank",
    "restaurant": "restaurant", "cafe": "restaurant", "fast_food": "fast_food", "police": "police",
    "townhall": "government", "fuel": "other", "train_station": "metro",
}
POI_KEYS = ("amenity", "shop", "leisure", "tourism", "office")


def slug(text: str) -> str:
    table = str.maketrans("абвгдеёжзийклмнопрстуфхцчшщъыьэюя", "ABVGDEEJZIIKLMNOPRSTUFHCCSS_Y_EUA")
    s = text.lower().translate(table).upper()
    return re.sub(r"[^A-Z0-9]+", "-", s).strip("-")[:40] or "X"


class Extractor(osmium.SimpleHandler):
    def __init__(self, boundary: dict, bbox):
        super().__init__()
        self.boundary, self.bbox = boundary, bbox
        self.roads, self.buildings, self.stops, self.metro, self.poi = [], [], [], [], []
        self.skipped_multipolygons = 0
        self.max_timestamp = None

    def _inside(self, lon, lat) -> bool:
        x0, y0, x1, y1 = self.bbox
        return x0 <= lon <= x1 and y0 <= lat <= y1 and point_in_geojson(lon, lat, self.boundary)

    def _ts(self, obj):
        ts = obj.timestamp
        if ts and (self.max_timestamp is None or ts > self.max_timestamp):
            self.max_timestamp = ts

    def node(self, n):
        tags = dict(n.tags)
        if not tags or not n.location.valid() or not self._inside(n.location.lon, n.location.lat):
            return
        self._ts(n)
        pt = {"type": "Point", "coordinates": [n.location.lon, n.location.lat]}
        props = {"osm_id": f"node/{n.id}", **tags}
        if tags.get("railway") == "subway_entrance" or (tags.get("railway") == "station" and tags.get("station") == "subway"):
            self.metro.append({"type": "Feature", "geometry": pt, "properties": props})
        elif tags.get("highway") == "bus_stop" or tags.get("public_transport") == "platform" or tags.get("railway") == "tram_stop":
            self.stops.append({"type": "Feature", "geometry": pt, "properties": props})
        elif any(k in tags for k in POI_KEYS):
            self.poi.append({"type": "Feature", "geometry": pt, "properties": props})

    def way(self, w):
        tags = dict(w.tags)
        if not tags:
            return
        try:
            coords = [(nd.lon, nd.lat) for nd in w.nodes]
        except osmium.InvalidLocationError:
            return
        if len(coords) < 2:
            return
        props = {"osm_id": f"way/{w.id}", **tags}
        if tags.get("highway") in ROAD_CLASSES:
            if any(self._inside(x, y) for x, y in coords):
                self._ts(w)
                self.roads.append({"type": "Feature", "geometry": {"type": "LineString", "coordinates": coords}, "properties": props})
        elif "building" in tags and w.is_closed() and len(coords) >= 4:
            cx = sum(x for x, _ in coords[:-1]) / (len(coords) - 1)
            cy = sum(y for _, y in coords[:-1]) / (len(coords) - 1)
            if self._inside(cx, cy):
                self._ts(w)
                self.buildings.append({"type": "Feature", "geometry": {"type": "Polygon", "coordinates": [coords]},
                                       "properties": {**props, "_centroid": [cx, cy]}})

    def relation(self, r):
        if "building" in dict(r.tags):
            self.skipped_multipolygons += 1


def bbox_of(geojson: dict):
    xs, ys = [], []

    def walk(c):
        if isinstance(c[0], (int, float)):
            xs.append(c[0]); ys.append(c[1])
        else:
            for sub in c:
                walk(sub)
    for f in geojson.get("features", [geojson]):
        walk(f["geometry"]["coordinates"] if "geometry" in f else f["coordinates"])
    return min(xs), min(ys), max(xs), max(ys)


def osm_entry(oid, category, name, typ, lon, lat, osm_id, year, today, **extra):
    kind, num = osm_id.split("/")
    entry = {
        "object_id": oid, "category": category, "real_name": name, "type": typ,
        "coordinates": {"lat": round(lat, 7), "lon": round(lon, 7), "kind": "centroid" if kind == "way" else "point"},
        "geometry_ref": extra.pop("geometry_ref", None), "address": extra.pop("address", None),
        "source": "OpenStreetMap", "source_url": f"https://www.openstreetmap.org/{kind}/{num}",
        "source_ids": ["SRC-OSM"], "verification_status": "PARTIALLY_VERIFIED", "confidence": 0.7,
        "year": year, "last_checked": today, "notes": "Импорт OSM; требует сверки с фото/официальными данными.",
        "verification_needs": extra.pop("needs", []), "importance": extra.pop("importance", "low"),
        "interior_required": False, "gameplay_required": extra.pop("gameplay", False),
        "district_scope": "inside", "display_name_policy": extra.pop("policy", "real"),
        "related_ids": [], "attributes": extra.pop("attributes", {}),
    }
    return entry


def to_int(v):
    try:
        return int(float(str(v).replace(",", ".")))
    except (TypeError, ValueError):
        return None


def build_manifest_entries(ex: Extractor, year: int, today: str) -> list[dict]:
    out = []
    for f in ex.buildings:
        p = f["properties"]
        lon, lat = p["_centroid"]
        street, num = p.get("addr:street"), p.get("addr:housenumber")
        address = f"{street}, {num}" if street and num else None
        levels = to_int(p.get("building:levels"))
        needs = [] if levels else ["Этажность (официальные данные о домах / фото)"]
        typ = BUILDING_TYPES.get(p.get("building"), BUILDING_TYPES.get(p.get("amenity"), BUILDING_TYPES.get(p.get("shop"), "other")))
        out.append(osm_entry(
            f"PRM-BLD-W{p['osm_id'].split('/')[1]}", "building", p.get("name") or address or "Здание без адреса",
            typ, lon, lat, p["osm_id"], year, today, address=address, needs=needs,
            geometry_ref="Buildings/osm_buildings.geojson",
            policy="real" if typ == "residential" else "undecided",
            attributes={"osm_id": p["osm_id"], "levels": levels, "height_m": to_int(p.get("height")),
                        "osm_building": p.get("building"), "building_type": typ}))

    streets = defaultdict(list)
    for f in ex.roads:
        name = f["properties"].get("name")
        if name:
            streets[name].append(f)
    used = set()
    for name, feats in sorted(streets.items()):
        oid = f"PRM-ROAD-{slug(name)}"
        n = 2
        while oid in used:
            oid, n = f"PRM-ROAD-{slug(name)}-{n}", n + 1
        used.add(oid)
        mid = feats[0]["geometry"]["coordinates"][len(feats[0]["geometry"]["coordinates"]) // 2]
        cls = feats[0]["properties"].get("highway")
        out.append(osm_entry(
            oid, "road", name, cls, mid[0], mid[1], feats[0]["properties"]["osm_id"], year, today,
            geometry_ref="Roads/osm_roads.geojson", importance="high" if cls in ("primary", "trunk", "secondary") else "medium",
            gameplay=True, attributes={"osm_way_ids": [x["properties"]["osm_id"] for x in feats]}))

    for f in ex.stops:
        p = f["properties"]
        lon, lat = f["geometry"]["coordinates"]
        out.append(osm_entry(f"PRM-STOP-N{p['osm_id'].split('/')[1]}", "transit_stop", p.get("name") or "Остановка без названия",
                             "tram_stop" if p.get("railway") == "tram_stop" else "bus_stop", lon, lat, p["osm_id"], year, today,
                             gameplay=True, needs=["Маршруты через остановку — из GTFS"], attributes={"osm_id": p["osm_id"]}))

    for f in ex.poi:
        p = f["properties"]
        lon, lat = f["geometry"]["coordinates"]
        kind = next(k for k in POI_KEYS if k in p)
        out.append(osm_entry(f"PRM-POI-N{p['osm_id'].split('/')[1]}", "poi", p.get("name") or p[kind], f"{kind}:{p[kind]}",
                             lon, lat, p["osm_id"], year, today, policy="fictionalized" if p.get("brand") else "real",
                             attributes={"osm_id": p["osm_id"], "opening_hours": p.get("opening_hours"), "brand": p.get("brand")}))

    entrances = [f for f in ex.metro if f["properties"].get("railway") == "subway_entrance"]
    for f in entrances:
        p = f["properties"]
        lon, lat = f["geometry"]["coordinates"]
        out.append(osm_entry(f"PRM-METRO-ENT-N{p['osm_id'].split('/')[1]}", "metro_entrance", p.get("name") or "Вход в метро",
                             "subway_entrance", lon, lat, p["osm_id"], year, today, importance="critical", gameplay=True,
                             needs=["Привязка к станции и вестибюлю — проверить по фото"], attributes={"osm_id": p["osm_id"]}))
    return out


def merge_metro_stations(manifest: dict, ex: Extractor, year: int, today: str) -> list[str]:
    """Заполняет координаты seed-станций по совпадению названия; статус не выше PARTIALLY_VERIFIED."""
    stations = {f["properties"].get("name"): f for f in ex.metro if f["properties"].get("railway") == "station"}
    updated = []
    for o in manifest["objects"]:
        if o["category"] != "metro_station" or o["real_name"] not in stations:
            continue
        f = stations[o["real_name"]]
        lon, lat = f["geometry"]["coordinates"]
        kind, num = f["properties"]["osm_id"].split("/")
        o["coordinates"] = {"lat": round(lat, 7), "lon": round(lon, 7), "kind": "point"}
        o["source_url"] = f"https://www.openstreetmap.org/{kind}/{num}"
        o["year"], o["last_checked"] = year, today
        if o["verification_status"] in ("UNKNOWN", "NEEDS_VERIFICATION"):
            o["verification_status"], o["confidence"] = "PARTIALLY_VERIFIED", 0.75
        o["verification_needs"] = [n for n in o.get("verification_needs", []) if not n.startswith("Координаты")]
        o["notes"] = (o.get("notes", "") + " Координаты — OSM.").strip()
        updated.append(o["object_id"])
    return updated


def write_layer(path: Path, features: list[dict]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    for f in features:
        f["properties"].pop("_centroid", None)
    path.write_text(json.dumps({"type": "FeatureCollection", "features": features}, ensure_ascii=False), encoding="utf-8")


def run(osm_path: Path, boundary_path: Path, manifest_path: Path, ref_root: Path) -> dict:
    boundary = json.loads(boundary_path.read_text(encoding="utf-8"))
    ex = Extractor(boundary, bbox_of(boundary))
    ex.apply_file(str(osm_path), locations=True)
    year = ex.max_timestamp.year if ex.max_timestamp else None
    today = dt.date.today().isoformat()

    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    if not manifest["crs"].get("engine_origin"):
        x0, y0, x1, y1 = bbox_of(boundary)
        manifest["crs"]["engine_origin"] = {"lat": round((y0 + y1) / 2, 6), "lon": round((x0 + x1) / 2, 6)}

    stations_updated = merge_metro_stations(manifest, ex, year, today)
    manual = [o for o in manifest["objects"] if o.get("source") != "OpenStreetMap"]
    manifest["objects"] = manual + build_manifest_entries(ex, year, today)
    manifest_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")

    write_layer(ref_root / "Roads" / "osm_roads.geojson", ex.roads)
    write_layer(ref_root / "Buildings" / "osm_buildings.geojson", ex.buildings)
    write_layer(ref_root / "Transport" / "osm_stops.geojson", ex.stops)
    write_layer(ref_root / "Metro" / "osm_metro.geojson", ex.metro)
    write_layer(ref_root / "POI" / "osm_poi.geojson", ex.poi)
    return {"roads": len(ex.roads), "buildings": len(ex.buildings), "stops": len(ex.stops), "metro": len(ex.metro),
            "poi": len(ex.poi), "stations_updated": stations_updated, "skipped_multipolygons": ex.skipped_multipolygons,
            "data_year": year, "objects_total": len(manifest["objects"])}


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--osm", type=Path, required=True)
    ap.add_argument("--boundary", type=Path, default=DEFAULT_BOUNDARY)
    ap.add_argument("--manifest", type=Path, default=MANIFEST)
    args = ap.parse_args()
    print(json.dumps(run(args.osm, args.boundary, args.manifest, args.manifest.parent), ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
