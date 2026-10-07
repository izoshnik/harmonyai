#!/usr/bin/env python3
"""Выгрузка административной границы Приморского района из OpenStreetMap (Overpass API).

Запускать локально: в облачной среде проекта доступ к OSM закрыт политикой сети.
Результат: WorldReference/Boundary/PrimorskyDistrictBoundary.geojson + .meta.json.

Граница из OSM получает статус PARTIALLY_VERIFIED только после ручной сверки с
законом о территориальном устройстве СПб (см. Docs/World.md §Границы).
Скрипт ничего не «дорисовывает»: незамкнутые кольца — ошибка, а не повод для фантазии.
"""
from __future__ import annotations

import argparse
import datetime as dt
import json
import sys
import urllib.parse
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
OUT_DIR = ROOT / "WorldReference" / "Boundary"
OVERPASS = "https://overpass-api.de/api/interpreter"
# Районы СПб в OSM размечены как boundary=administrative внутри города; admin_level печатается
# в meta, чтобы человек проверил, что взят район, а не муниципальный округ.
QUERY = """
[out:json][timeout:120];
area["name"="Санкт-Петербург"]["boundary"="administrative"]->.spb;
rel(area.spb)["boundary"="administrative"]["name"="Приморский район"];
out body; >; out skel qt;
"""


def assemble_rings(ways: list[list[tuple[float, float]]]) -> list[list[tuple[float, float]]]:
    """Склеивает отрезки way в замкнутые кольца по совпадающим концам."""
    pending = [list(w) for w in ways if len(w) >= 2]
    rings = []
    while pending:
        ring = pending.pop(0)
        progress = True
        while ring[0] != ring[-1] and progress:
            progress = False
            for i, seg in enumerate(pending):
                if seg[0] == ring[-1]:
                    ring += seg[1:]
                elif seg[-1] == ring[-1]:
                    ring += list(reversed(seg))[1:]
                elif seg[-1] == ring[0]:
                    ring = seg[:-1] + ring
                elif seg[0] == ring[0]:
                    ring = list(reversed(seg))[:-1] + ring
                else:
                    continue
                pending.pop(i)
                progress = True
                break
        if ring[0] != ring[-1]:
            raise ValueError("Незамкнутое кольцо границы — данные OSM неполные, нужна ручная проверка")
        rings.append(ring)
    return rings


def to_geojson(osm: dict) -> tuple[dict, dict]:
    rels = [e for e in osm["elements"] if e["type"] == "relation"]
    if len(rels) != 1:
        raise ValueError(f"Ожидалась 1 relation, получено {len(rels)} — уточните запрос")
    rel = rels[0]
    nodes = {e["id"]: (e["lon"], e["lat"]) for e in osm["elements"] if e["type"] == "node"}
    ways = {e["id"]: [nodes[n] for n in e["nodes"]] for e in osm["elements"] if e["type"] == "way"}
    outer = [ways[m["ref"]] for m in rel["members"] if m["type"] == "way" and m["role"] == "outer"]
    inner = [ways[m["ref"]] for m in rel["members"] if m["type"] == "way" and m["role"] == "inner"]
    outer_rings, inner_rings = assemble_rings(outer), assemble_rings(inner)
    # Дырки не привязываются к конкретному outer автоматически: при >1 outer это делается в GIS вручную.
    if len(outer_rings) > 1 and inner_rings:
        raise ValueError("Несколько outer и есть inner — сборку выполнить в QGIS и сверить вручную")
    polygons = [[r] for r in outer_rings]
    if inner_rings:
        polygons[0] += inner_rings
    feature = {
        "type": "Feature",
        "properties": {"object_id": "PRM-BOUNDARY-DISTRICT", "osm_relation_id": rel["id"], "tags": rel.get("tags", {})},
        "geometry": {"type": "MultiPolygon", "coordinates": polygons},
    }
    meta = {
        "osm_relation_id": rel["id"],
        "admin_level": rel.get("tags", {}).get("admin_level"),
        "fetched_at": dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds"),
        "osm_base_timestamp": osm.get("osm3s", {}).get("timestamp_osm_base"),
        "source": OVERPASS,
        "license": "ODbL 1.0 © OpenStreetMap contributors",
        "verification_status": "NEEDS_VERIFICATION",
    }
    return {"type": "FeatureCollection", "features": [feature]}, meta


NOMINATIM = ("https://nominatim.openstreetmap.org/search?format=jsonv2&polygon_geojson=1&limit=1&q="
             + urllib.parse.quote("Приморский район, Санкт-Петербург"))


def fetch_nominatim() -> tuple[dict, dict]:
    """Запасной путь, когда Overpass недоступен: Nominatim отдаёт готовый полигон relation."""
    req = urllib.request.Request(NOMINATIM, headers={"User-Agent": "PrimorskySim-WorldPipeline/0.1"})
    with urllib.request.urlopen(req, timeout=60) as resp:
        r = json.load(resp)[0]
    if r.get("osm_type") != "relation" or r.get("type") != "administrative":
        raise ValueError(f"Nominatim вернул не административную границу: {r.get('osm_type')} {r.get('type')}")
    feature = {"type": "Feature", "properties": {"object_id": "PRM-BOUNDARY-DISTRICT", "osm_relation_id": int(r["osm_id"])},
               "geometry": r["geojson"]}
    meta = {"osm_relation_id": int(r["osm_id"]), "fetched_at": dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds"),
            "source": "https://nominatim.openstreetmap.org (polygon_geojson)", "license": "ODbL 1.0 © OpenStreetMap contributors",
            "verification_status": "PARTIALLY_VERIFIED"}
    return {"type": "FeatureCollection", "features": [feature]}, meta


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--from-file", type=Path, help="Готовый ответ Overpass (JSON) вместо сетевого запроса")
    ap.add_argument("--nominatim", action="store_true", help="Взять полигон через Nominatim вместо Overpass")
    args = ap.parse_args()
    if args.nominatim:
        geojson, meta = fetch_nominatim()
        OUT_DIR.mkdir(parents=True, exist_ok=True)
        (OUT_DIR / "PrimorskyDistrictBoundary.geojson").write_text(json.dumps(geojson, ensure_ascii=False), encoding="utf-8")
        (OUT_DIR / "PrimorskyDistrictBoundary.meta.json").write_text(json.dumps(meta, ensure_ascii=False, indent=2), encoding="utf-8")
        print(f"OK (Nominatim): relation {meta['osm_relation_id']}")
        return 0
    if args.from_file:
        osm = json.loads(args.from_file.read_text(encoding="utf-8"))
    else:
        body = urllib.parse.urlencode({"data": QUERY}).encode()
        req = urllib.request.Request(OVERPASS, data=body, headers={"User-Agent": "PrimorskySim-WorldPipeline/0.1"})
        with urllib.request.urlopen(req, timeout=180) as resp:
            osm = json.load(resp)
    geojson, meta = to_geojson(osm)
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    (OUT_DIR / "PrimorskyDistrictBoundary.geojson").write_text(json.dumps(geojson, ensure_ascii=False), encoding="utf-8")
    (OUT_DIR / "PrimorskyDistrictBoundary.meta.json").write_text(json.dumps(meta, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"OK: relation {meta['osm_relation_id']} admin_level={meta['admin_level']} — сверить вручную перед сменой статуса")
    return 0


if __name__ == "__main__":
    sys.exit(main())
