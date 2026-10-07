#!/usr/bin/env bash
# Сборка данных мира одной командой: граница (Overpass) -> выгрузка OSM (Geofabrik) -> импорт -> валидация.
# Источники: download.openstreetmap.fr (выгрузка СПб), Nominatim/Overpass (граница).
set -euo pipefail
cd "$(dirname "$0")/../.."
CACHE=${CACHE:-.cache/osm}
PBF_URL=${PBF_URL:-https://download.openstreetmap.fr/extracts/russia/northwestern_federal_district/saint_petersburg-latest.osm.pbf}
mkdir -p "$CACHE"
pip install --quiet osmium jsonschema

[ -f WorldReference/Boundary/PrimorskyDistrictBoundary.geojson ] || { python3 Tools/WorldPipeline/fetch_osm_boundary.py --nominatim || python3 Tools/WorldPipeline/fetch_osm_boundary.py; }
[ -f "$CACHE/region.osm.pbf" ] || curl -fL --retry 3 -o "$CACHE/region.osm.pbf" "$PBF_URL"

python3 Tools/WorldPipeline/import_osm.py --osm "$CACHE/region.osm.pbf"
python3 Tools/WorldPipeline/validate_world.py
