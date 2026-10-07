import json
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import import_osm  # noqa: E402
import validate_world as vw  # noqa: E402

OSM = """<?xml version='1.0' encoding='UTF-8'?>
<osm version="0.6">
 <node id="1" lat="60.01" lon="30.01" version="1" timestamp="2026-05-01T00:00:00Z"/>
 <node id="2" lat="60.01" lon="30.02" version="1" timestamp="2026-05-01T00:00:00Z"/>
 <node id="3" lat="60.02" lon="30.02" version="1" timestamp="2026-05-01T00:00:00Z"/>
 <node id="4" lat="60.02" lon="30.01" version="1" timestamp="2026-05-01T00:00:00Z"/>
 <node id="5" lat="59.90" lon="30.01" version="1" timestamp="2026-05-01T00:00:00Z"/>
 <node id="6" lat="59.90" lon="30.02" version="1" timestamp="2026-05-01T00:00:00Z"/>
 <node id="7" lat="59.91" lon="30.02" version="1" timestamp="2026-05-01T00:00:00Z"/>
 <node id="8" lat="60.03" lon="30.03" version="1" timestamp="2026-05-01T00:00:00Z"/>
 <node id="9" lat="60.03" lon="30.05" version="1" timestamp="2026-05-01T00:00:00Z"/>
 <node id="10" lat="60.04" lon="30.04" version="1" timestamp="2026-06-01T00:00:00Z">
  <tag k="railway" v="station"/><tag k="station" v="subway"/><tag k="name" v="Пионерская"/></node>
 <node id="11" lat="60.041" lon="30.041" version="1" timestamp="2026-05-01T00:00:00Z">
  <tag k="railway" v="subway_entrance"/></node>
 <node id="12" lat="60.035" lon="30.035" version="1" timestamp="2026-05-01T00:00:00Z">
  <tag k="highway" v="bus_stop"/><tag k="name" v="Улица Тестовая"/></node>
 <node id="13" lat="60.036" lon="30.036" version="1" timestamp="2026-05-01T00:00:00Z">
  <tag k="amenity" v="pharmacy"/><tag k="name" v="Аптека"/></node>
 <way id="100" version="1" timestamp="2026-05-01T00:00:00Z">
  <nd ref="1"/><nd ref="2"/><nd ref="3"/><nd ref="4"/><nd ref="1"/>
  <tag k="building" v="apartments"/><tag k="building:levels" v="9"/>
  <tag k="addr:street" v="Тестовая улица"/><tag k="addr:housenumber" v="1"/></way>
 <way id="101" version="1" timestamp="2026-05-01T00:00:00Z">
  <nd ref="5"/><nd ref="6"/><nd ref="7"/><nd ref="5"/><tag k="building" v="yes"/></way>
 <way id="102" version="1" timestamp="2026-05-01T00:00:00Z">
  <nd ref="8"/><nd ref="9"/><tag k="highway" v="primary"/><tag k="name" v="Тестовый проспект"/><tag k="lanes" v="4"/></way>
</osm>
"""
BOUNDARY = {"type": "FeatureCollection", "features": [{"type": "Feature", "properties": {}, "geometry": {
    "type": "Polygon", "coordinates": [[[30.0, 60.0], [30.1, 60.0], [30.1, 60.1], [30.0, 60.1], [30.0, 60.0]]]}}]}


class ImportOsmTests(unittest.TestCase):
    def test_import_clips_and_merges(self):
        with tempfile.TemporaryDirectory() as d:
            root = Path(d)
            (root / "map.osm").write_text(OSM, encoding="utf-8")
            (root / "b.geojson").write_text(json.dumps(BOUNDARY))
            # Изолированный манифест: только ручные seed-записи без реальных координат
            seed = json.loads(vw.DEFAULT_MANIFEST.read_text(encoding="utf-8"))
            seed["crs"]["engine_origin"] = None
            seed["objects"] = [
                {**o, "coordinates": None, "verification_status": "NEEDS_VERIFICATION", "confidence": 0.5,
                 "verification_needs": o.get("verification_needs") or ["test"]}
                for o in seed["objects"] if o.get("source") != "OpenStreetMap"
            ]
            (root / "WorldManifest.json").write_text(json.dumps(seed, ensure_ascii=False), encoding="utf-8")
            stats = import_osm.run(root / "map.osm", root / "b.geojson", root / "WorldManifest.json", root)

            self.assertEqual(stats["buildings"], 1)  # здание вне границы отброшено
            self.assertEqual(stats["roads"], 1)
            self.assertEqual(stats["stations_updated"], ["PRM-METRO-STN-PIONERSKAYA"])
            self.assertEqual(stats["data_year"], 2026)

            m = json.loads((root / "WorldManifest.json").read_text(encoding="utf-8"))
            by_id = {o["object_id"]: o for o in m["objects"]}
            b = by_id["PRM-BLD-W100"]
            self.assertEqual(b["attributes"]["levels"], 9)
            self.assertEqual(b["address"], "Тестовая улица, 1")
            st = by_id["PRM-METRO-STN-PIONERSKAYA"]
            self.assertEqual(st["verification_status"], "PARTIALLY_VERIFIED")
            self.assertAlmostEqual(st["coordinates"]["lat"], 60.04)
            self.assertIsNotNone(m["crs"]["engine_origin"])
            self.assertIn("PRM-METRO-ENT-N11", by_id)
            self.assertIn("PRM-STOP-N12", by_id)
            self.assertIn("PRM-POI-N13", by_id)

            # Повторный импорт не дублирует объекты
            import_osm.run(root / "map.osm", root / "b.geojson", root / "WorldManifest.json", root)
            m2 = json.loads((root / "WorldManifest.json").read_text(encoding="utf-8"))
            self.assertEqual(len(m2["objects"]), len(m["objects"]))

            # Результат проходит L1-валидацию (граница — тестовый квадрат)
            m2["objects"] = [o if o["object_id"] != vw.BOUNDARY_ID else {**o, "geometry_ref": "b.geojson"} for o in m2["objects"]]
            schema = json.loads(vw.DEFAULT_SCHEMA.read_text(encoding="utf-8"))
            sources = json.loads(vw.DEFAULT_SOURCES.read_text(encoding="utf-8"))
            summary, report = vw.validate(m2, schema, sources, root)
            self.assertEqual(summary["errors"], 0, [i.message for i in report.issues if i.severity == "ERROR"])
            self.assertEqual(report.checks["inside_boundary"], "PASS")


if __name__ == "__main__":
    unittest.main()
