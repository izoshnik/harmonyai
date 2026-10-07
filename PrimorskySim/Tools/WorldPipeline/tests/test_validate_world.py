import copy
import json
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import fetch_osm_boundary as fob  # noqa: E402
import validate_world as vw  # noqa: E402

SCHEMA = json.loads(vw.DEFAULT_SCHEMA.read_text(encoding="utf-8"))
SOURCES = json.loads(vw.DEFAULT_SOURCES.read_text(encoding="utf-8"))
SQUARE = {"type": "Polygon", "coordinates": [[[30.0, 60.0], [30.3, 60.0], [30.3, 60.1], [30.0, 60.1], [30.0, 60.0]]]}


def obj(oid, **over):
    base = {
        "object_id": oid, "category": "poi", "real_name": "Тест", "type": "pharmacy",
        "coordinates": {"lat": 60.05, "lon": 30.1}, "source": "test", "source_url": "https://example.org",
        "source_ids": ["SRC-OSM"], "verification_status": "VERIFIED", "confidence": 0.95, "year": 2026,
        "last_checked": "2026-10-01", "notes": "", "importance": "low", "interior_required": False,
        "gameplay_required": False, "district_scope": "inside", "related_ids": [], "attributes": {},
    }
    base.update(over)
    return base


def manifest(*objects):
    return {"manifest_version": "0.1.0", "world_state_year": 2026,
            "crs": {"geographic": "EPSG:4326", "engine_projection": "x"}, "objects": list(objects)}


def run(m, boundary=None):
    with tempfile.TemporaryDirectory() as d:
        root = Path(d)
        if boundary is not None:
            (root / "b.geojson").write_text(json.dumps(boundary))
            m = copy.deepcopy(m)
            m["objects"].append(obj(vw.BOUNDARY_ID, category="boundary", coordinates=None, geometry_ref="b.geojson",
                                    district_scope="not_spatial"))
        summary, report = vw.validate(m, SCHEMA, SOURCES, root)
    return summary, report


def messages(report, check):
    return [i.message for i in report.issues if i.check == check]


class ValidateWorldTests(unittest.TestCase):
    def test_repository_manifest_has_no_errors(self):
        m = json.loads(vw.DEFAULT_MANIFEST.read_text(encoding="utf-8"))
        summary, _ = vw.validate(m, SCHEMA, SOURCES, vw.DEFAULT_MANIFEST.parent)
        self.assertEqual(summary["errors"], 0)
        self.assertFalse(summary["world_validated"])  # пока граница не загружена, мир не валиден

    def test_verified_requires_evidence(self):
        _, r = run(manifest(obj("PRM-POI-A", source_url=None, year=2019, last_checked=None)))
        msgs = " ".join(messages(r, "verification_rules"))
        self.assertIn("source_url", msgs)
        self.assertIn("старше", msgs)
        self.assertIn("last_checked", msgs)

    def test_unverified_must_list_needs(self):
        _, r = run(manifest(obj("PRM-POI-A", verification_status="NEEDS_VERIFICATION", confidence=0.4)))
        self.assertTrue(messages(r, "verification_rules"))

    def test_yandex_cannot_be_sole_source_for_verified(self):
        _, r = run(manifest(obj("PRM-POI-A", source_ids=["SRC-YANDEX-REF"])))
        self.assertIn("Яндекс", " ".join(messages(r, "verification_rules")))

    def test_swapped_lat_lon_detected(self):
        _, r = run(manifest(obj("PRM-POI-A", coordinates={"lat": 30.1, "lon": 60.05})))
        self.assertEqual(r.checks["coordinates_sanity"], "FAIL")

    def test_boundary_missing_is_blocked_not_passed(self):
        _, r = run(manifest(obj("PRM-POI-A")))
        self.assertEqual(r.checks["inside_boundary"], "BLOCKED")

    def test_inside_and_outside_boundary(self):
        outside = obj("PRM-POI-B", coordinates={"lat": 59.95, "lon": 30.1})
        _, r = run(manifest(obj("PRM-POI-A"), outside), boundary=SQUARE)
        bad = [i.object_id for i in r.issues if i.check == "inside_boundary"]
        self.assertEqual(bad, ["PRM-POI-B"])

    def test_duplicate_ids(self):
        _, r = run(manifest(obj("PRM-POI-A"), obj("PRM-POI-A")))
        self.assertEqual(r.checks["unique_ids"], "FAIL")

    def test_metro_topology_mismatch(self):
        line = obj("PRM-METRO-LINE-9", category="metro_line", attributes={"station_ids": ["PRM-METRO-STN-X"]})
        station = obj("PRM-METRO-STN-Y", category="metro_station", attributes={"line_id": "PRM-METRO-LINE-9"})
        _, r = run(manifest(line, station))
        self.assertEqual(r.checks["metro_topology"], "FAIL")
        self.assertEqual(len(messages(r, "metro_topology")), 2)

    def test_schema_rejects_bad_status(self):
        _, r = run(manifest(obj("PRM-POI-A", verification_status="DONE")))
        self.assertEqual(r.checks["schema"], "FAIL")

    def test_point_in_polygon_with_hole(self):
        poly = {"type": "Polygon", "coordinates": [
            [[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]],
            [[4, 4], [6, 4], [6, 6], [4, 6], [4, 4]]]}
        self.assertTrue(vw.point_in_geojson(1, 1, poly))
        self.assertFalse(vw.point_in_geojson(5, 5, poly))
        self.assertFalse(vw.point_in_geojson(11, 5, poly))


class BoundaryAssemblyTests(unittest.TestCase):
    def test_assembles_reversed_segments(self):
        rings = fob.assemble_rings([[(0, 0), (1, 0)], [(1, 1), (1, 0)], [(1, 1), (0, 0)]])
        self.assertEqual(len(rings), 1)
        self.assertEqual(rings[0][0], rings[0][-1])

    def test_open_ring_is_error(self):
        with self.assertRaises(ValueError):
            fob.assemble_rings([[(0, 0), (1, 0)], [(1, 0), (1, 1)]])


if __name__ == "__main__":
    unittest.main()
