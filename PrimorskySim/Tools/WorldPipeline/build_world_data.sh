#!/usr/bin/env bash
# Сборка данных мира одной командой: граница (Overpass) -> выгрузка OSM (Geofabrik) -> импорт -> валидация.
# Требует сетевого доступа к overpass-api.de и download.geofabrik.de.
set -euo pipefail
cd "$(dirname "$0")/../.."
CACHE=${CACHE:-.cache/osm}
PBF_URL=${PBF_URL:-https://download.geofabrik.de/russia/northwestern-fed-district-latest.osm.pbf}
mkdir -p "$CACHE"
pip install --quiet osmium jsonschema

[ -f WorldReference/Boundary/PrimorskyDistrictBoundary.geojson ] || python3 Tools/WorldPipeline/fetch_osm_boundary.py
[ -f "$CACHE/region.osm.pbf" ] || curl -fL --retry 3 -o "$CACHE/region.osm.pbf" "$PBF_URL"

python3 Tools/WorldPipeline/import_osm.py --osm "$CACHE/region.osm.pbf"
python3 Tools/WorldPipeline/validate_world.py
