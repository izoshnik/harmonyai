#!/usr/bin/env python3
"""World Validation (data stage).

Проверяет WorldReference/WorldManifest.json до импорта в Unreal и пишет
WorldReference/Validation/WorldValidationReport.{json,md}.

Это первый из трёх уровней валидации (см. Docs/Validation.md):
  1. data      — этот скрипт (CI, без движка);
  2. import    — GIS-импорт (топология дорог, пересечения зданий);
  3. engine    — editor commandlet в UE (navmesh, акторы vs манифест, метро в уровне).

Код выхода: 0 — ошибок нет, 1 — есть ошибки, 2 — сбой загрузки входных данных.
"""
from __future__ import annotations

import argparse
import datetime as dt
import json
import sys
from collections import Counter
from dataclasses import dataclass, field
from pathlib import Path

try:
    from jsonschema import Draft202012Validator
except ImportError:  # pragma: no cover - окружение без зависимости
    Draft202012Validator = None

ROOT = Path(__file__).resolve().parents[2]
DEFAULT_MANIFEST = ROOT / "WorldReference" / "WorldManifest.json"
DEFAULT_SCHEMA = ROOT / "Data" / "Schemas" / "WorldManifest.schema.json"
DEFAULT_SOURCES = ROOT / "WorldReference" / "Sources" / "SourceRegistry.json"
DEFAULT_OUT = ROOT / "WorldReference" / "Validation"

BOUNDARY_ID = "PRM-BOUNDARY-DISTRICT"
# Грубая рамка Санкт-Петербурга: ловит перепутанные lat/lon и мусор, не заменяет проверку границей.
SPB_BBOX = {"lat": (59.6, 60.3), "lon": (29.4, 30.9)}
VERIFIED_MIN_YEAR = 2025
VERIFIED_MIN_CONFIDENCE = 0.9
YANDEX_SOURCE_ID = "SRC-YANDEX-REF"


@dataclass
class Issue:
    severity: str  # ERROR | WARN
    check: str
    object_id: str | None
    message: str


@dataclass
class Report:
    issues: list[Issue] = field(default_factory=list)
    checks: dict[str, str] = field(default_factory=dict)  # check -> PASS | FAIL | BLOCKED | WARN

    def add(self, severity: str, check: str, object_id: str | None, message: str) -> None:
        self.issues.append(Issue(severity, check, object_id, message))
        current = self.checks.get(check, "PASS")
        if severity == "ERROR":
            self.checks[check] = "FAIL"
        elif current == "PASS":
            self.checks[check] = "WARN"

    def ran(self, check: str) -> None:
        self.checks.setdefault(check, "PASS")

    def blocked(self, check: str, object_id: str | None, message: str) -> None:
        self.checks[check] = "BLOCKED"
        self.issues.append(Issue("WARN", check, object_id, message))

    @property
    def error_count(self) -> int:
        return sum(1 for i in self.issues if i.severity == "ERROR")


# ---------------------------------------------------------------- geometry

def _point_in_ring(lon: float, lat: float, ring: list) -> bool:
    inside = False
    j = len(ring) - 1
    for i in range(len(ring)):
        xi, yi = ring[i][0], ring[i][1]
        xj, yj = ring[j][0], ring[j][1]
        if (yi > lat) != (yj > lat) and lon < (xj - xi) * (lat - yi) / (yj - yi) + xi:
            inside = not inside
        j = i
    return inside


def _point_in_polygon(lon: float, lat: float, polygon: list) -> bool:
    if not polygon or not _point_in_ring(lon, lat, polygon[0]):
        return False
    return not any(_point_in_ring(lon, lat, hole) for hole in polygon[1:])


def point_in_geojson(lon: float, lat: float, geojson: dict) -> bool:
    geometries = []
    if geojson.get("type") == "FeatureCollection":
        geometries = [f["geometry"] for f in geojson.get("features", []) if f.get("geometry")]
    elif geojson.get("type") == "Feature":
        geometries = [geojson["geometry"]]
    else:
        geometries = [geojson]
    for geom in geometries:
        if geom["type"] == "Polygon" and _point_in_polygon(lon, lat, geom["coordinates"]):
            return True
        if geom["type"] == "MultiPolygon" and any(_point_in_polygon(lon, lat, p) for p in geom["coordinates"]):
            return True
    return False


# ---------------------------------------------------------------- checks

def check_schema(manifest: dict, schema: dict, report: Report) -> None:
    report.ran("schema")
    if Draft202012Validator is None:
        report.blocked("schema", None, "Пакет jsonschema не установлен: pip install jsonschema")
        return
    for err in sorted(Draft202012Validator(schema).iter_errors(manifest), key=lambda e: list(e.path)):
        path = list(err.path)
        object_id = None
        if len(path) >= 2 and path[0] == "objects" and isinstance(path[1], int):
            objs = manifest.get("objects", [])
            if path[1] < len(objs):
                object_id = objs[path[1]].get("object_id")
        report.add("ERROR", "schema", object_id, f"{'/'.join(map(str, path)) or '<root>'}: {err.message}")


def check_unique_ids(objects: list, report: Report) -> None:
    report.ran("unique_ids")
    for oid, n in Counter(o.get("object_id") for o in objects).items():
        if n > 1:
            report.add("ERROR", "unique_ids", oid, f"object_id встречается {n} раз")


def check_verification_rules(objects: list, report: Report) -> None:
    """VERIFIED нельзя поставить без подтверждения; непроверенное обязано говорить, чего не хватает."""
    report.ran("verification_rules")
    for o in objects:
        oid, status = o.get("object_id"), o.get("verification_status")
        if status == "VERIFIED":
            if not o.get("source_url"):
                report.add("ERROR", "verification_rules", oid, "VERIFIED без source_url")
            if (o.get("year") or 0) < VERIFIED_MIN_YEAR:
                report.add("ERROR", "verification_rules", oid, f"VERIFIED с данными старше {VERIFIED_MIN_YEAR} года или без года")
            if (o.get("confidence") or 0) < VERIFIED_MIN_CONFIDENCE:
                report.add("ERROR", "verification_rules", oid, f"VERIFIED с confidence < {VERIFIED_MIN_CONFIDENCE}")
            if not o.get("last_checked"):
                report.add("ERROR", "verification_rules", oid, "VERIFIED без last_checked")
            if o.get("district_scope") != "not_spatial" and not (o.get("coordinates") or o.get("geometry_ref")):
                report.add("ERROR", "verification_rules", oid, "VERIFIED пространственный объект без координат/геометрии")
            if o.get("source_ids") == [YANDEX_SOURCE_ID]:
                report.add("ERROR", "verification_rules", oid, "Яндекс — только визуальная сверка, не единственный источник факта")
        if status in ("NEEDS_VERIFICATION", "UNKNOWN") and not o.get("verification_needs"):
            report.add("ERROR", "verification_rules", oid, f"{status} без списка verification_needs")
        if status == "UNKNOWN" and (o.get("confidence") or 0) > 0.3:
            report.add("WARN", "verification_rules", oid, "UNKNOWN с confidence > 0.3 — статус занижен или уверенность завышена")


def check_sources(objects: list, sources: dict | None, report: Report) -> None:
    report.ran("sources")
    if sources is None:
        report.blocked("sources", None, "SourceRegistry.json не найден")
        return
    known = {s["source_id"] for s in sources.get("sources", [])}
    for o in objects:
        for sid in o.get("source_ids", []):
            if sid not in known:
                report.add("ERROR", "sources", o.get("object_id"), f"неизвестный source_id {sid}")


def check_coordinates(objects: list, report: Report) -> None:
    report.ran("coordinates_sanity")
    for o in objects:
        c = o.get("coordinates")
        if not c:
            continue
        lat_ok = SPB_BBOX["lat"][0] <= c["lat"] <= SPB_BBOX["lat"][1]
        lon_ok = SPB_BBOX["lon"][0] <= c["lon"] <= SPB_BBOX["lon"][1]
        if not (lat_ok and lon_ok):
            hint = " (похоже, lat/lon перепутаны)" if (SPB_BBOX["lat"][0] <= c["lon"] <= SPB_BBOX["lat"][1]) else ""
            report.add("ERROR", "coordinates_sanity", o.get("object_id"), f"координаты {c['lat']},{c['lon']} вне Санкт-Петербурга{hint}")


def load_boundary(objects: list, reference_root: Path) -> dict | None:
    b = next((o for o in objects if o.get("object_id") == BOUNDARY_ID), None)
    if not b or not b.get("geometry_ref"):
        return None
    path = reference_root / b["geometry_ref"]
    if not path.is_file():
        return None
    return json.loads(path.read_text(encoding="utf-8"))


def check_inside_boundary(objects: list, boundary: dict | None, report: Report) -> None:
    candidates = [o for o in objects if o.get("district_scope") == "inside" and o.get("coordinates")]
    if boundary is None:
        report.blocked("inside_boundary", BOUNDARY_ID,
                       f"Граница района не загружена — {len(candidates)} объект(ов) с координатами не проверены на принадлежность району")
        return
    report.ran("inside_boundary")
    for o in candidates:
        c = o["coordinates"]
        if not point_in_geojson(c["lon"], c["lat"], boundary):
            report.add("ERROR", "inside_boundary", o["object_id"], "district_scope=inside, но точка вне границы района")


def check_references(objects: list, reference_root: Path, report: Report) -> None:
    report.ran("references")
    ids = {o.get("object_id") for o in objects}
    for o in objects:
        for rid in o.get("related_ids", []):
            if rid not in ids:
                report.add("ERROR", "references", o.get("object_id"), f"related_ids ссылается на несуществующий {rid}")
        ref = o.get("geometry_ref")
        if ref and not (reference_root / ref).is_file():
            sev = "ERROR" if o.get("verification_status") in ("VERIFIED", "PARTIALLY_VERIFIED") else "WARN"
            report.add(sev, "references", o.get("object_id"), f"geometry_ref {ref} отсутствует")


def check_metro_topology(objects: list, report: Report) -> None:
    report.ran("metro_topology")
    by_id = {o.get("object_id"): o for o in objects}
    lines = [o for o in objects if o.get("category") == "metro_line"]
    stations = [o for o in objects if o.get("category") == "metro_station"]
    for line in lines:
        for sid in line.get("attributes", {}).get("station_ids", []):
            st = by_id.get(sid)
            if st is None or st.get("category") != "metro_station":
                report.add("ERROR", "metro_topology", line["object_id"], f"станция {sid} отсутствует в манифесте")
            elif st.get("attributes", {}).get("line_id") != line["object_id"]:
                report.add("ERROR", "metro_topology", sid, f"line_id станции не совпадает с линией {line['object_id']}")
    for st in stations:
        lid = st.get("attributes", {}).get("line_id")
        line = by_id.get(lid)
        if line is None:
            report.add("ERROR", "metro_topology", st["object_id"], f"станция ссылается на несуществующую линию {lid}")
        elif st["object_id"] not in line.get("attributes", {}).get("station_ids", []):
            report.add("ERROR", "metro_topology", st["object_id"], f"станция не перечислена в station_ids линии {lid}")


# ---------------------------------------------------------------- report

def build_summary(objects: list, report: Report) -> dict:
    return {
        "generated_at": dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds"),
        "object_count": len(objects),
        "by_status": dict(Counter(o.get("verification_status") for o in objects)),
        "by_category": dict(Counter(o.get("category") for o in objects)),
        "errors": report.error_count,
        "warnings": sum(1 for i in report.issues if i.severity == "WARN"),
        "checks": report.checks,
        "world_validated": report.error_count == 0 and "BLOCKED" not in report.checks.values()
                           and all(o.get("verification_status") == "VERIFIED" for o in objects),
    }


def write_reports(summary: dict, report: Report, out_dir: Path) -> None:
    out_dir.mkdir(parents=True, exist_ok=True)
    payload = {"summary": summary, "issues": [i.__dict__ for i in report.issues]}
    (out_dir / "WorldValidationReport.json").write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    lines = [
        "# WorldValidationReport",
        "",
        f"Сгенерировано: {summary['generated_at']} — `Tools/WorldPipeline/validate_world.py`",
        "",
        f"Объектов: **{summary['object_count']}** · ошибок: **{summary['errors']}** · предупреждений: **{summary['warnings']}**",
        f"Мир прошёл валидацию полностью: **{'да' if summary['world_validated'] else 'нет'}**",
        "",
        "## Проверки",
        "",
        "| Проверка | Результат |",
        "|---|---|",
        *[f"| {k} | {v} |" for k, v in sorted(summary["checks"].items())],
        "",
        "## Статусы объектов",
        "",
        *[f"- {k}: {v}" for k, v in sorted(summary["by_status"].items())],
        "",
        "## Замечания",
        "",
    ]
    if report.issues:
        lines += ["| Уровень | Проверка | Объект | Сообщение |", "|---|---|---|---|"]
        lines += [f"| {i.severity} | {i.check} | {i.object_id or '—'} | {i.message} |" for i in report.issues]
    else:
        lines.append("Нет.")
    (out_dir / "WorldValidationReport.md").write_text("\n".join(lines) + "\n", encoding="utf-8")


def validate(manifest: dict, schema: dict, sources: dict | None, reference_root: Path) -> tuple[dict, Report]:
    report = Report()
    objects = manifest.get("objects", [])
    check_schema(manifest, schema, report)
    check_unique_ids(objects, report)
    check_verification_rules(objects, report)
    check_sources(objects, sources, report)
    check_coordinates(objects, report)
    check_inside_boundary(objects, load_boundary(objects, reference_root), report)
    check_references(objects, reference_root, report)
    check_metro_topology(objects, report)
    return build_summary(objects, report), report


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--manifest", type=Path, default=DEFAULT_MANIFEST)
    ap.add_argument("--schema", type=Path, default=DEFAULT_SCHEMA)
    ap.add_argument("--sources", type=Path, default=DEFAULT_SOURCES)
    ap.add_argument("--out", type=Path, default=DEFAULT_OUT)
    args = ap.parse_args(argv)
    try:
        manifest = json.loads(args.manifest.read_text(encoding="utf-8"))
        schema = json.loads(args.schema.read_text(encoding="utf-8"))
        sources = json.loads(args.sources.read_text(encoding="utf-8")) if args.sources.is_file() else None
    except (OSError, json.JSONDecodeError) as exc:
        print(f"Не удалось загрузить входные данные: {exc}", file=sys.stderr)
        return 2
    summary, report = validate(manifest, schema, sources, args.manifest.parent)
    write_reports(summary, report, args.out)
    for k, v in sorted(summary["checks"].items()):
        print(f"{v:8} {k}")
    print(f"objects={summary['object_count']} errors={summary['errors']} warnings={summary['warnings']} "
          f"world_validated={summary['world_validated']}")
    return 1 if summary["errors"] else 0


if __name__ == "__main__":
    sys.exit(main())
