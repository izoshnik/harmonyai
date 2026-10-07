# WorldValidationReport

Сгенерировано: 2026-10-07T15:49:51+00:00 — `Tools/WorldPipeline/validate_world.py`

Объектов: **10** · ошибок: **0** · предупреждений: **2**
Мир прошёл валидацию полностью: **нет**

## Проверки

| Проверка | Результат |
|---|---|
| coordinates_sanity | PASS |
| inside_boundary | BLOCKED |
| metro_topology | PASS |
| references | WARN |
| schema | PASS |
| sources | PASS |
| unique_ids | PASS |
| verification_rules | PASS |

## Статусы объектов

- NEEDS_VERIFICATION: 9
- UNKNOWN: 1

## Замечания

| Уровень | Проверка | Объект | Сообщение |
|---|---|---|---|
| WARN | inside_boundary | PRM-BOUNDARY-DISTRICT | Граница района не загружена — 0 объект(ов) с координатами не проверены на принадлежность району |
| WARN | references | PRM-BOUNDARY-DISTRICT | geometry_ref Boundary/PrimorskyDistrictBoundary.geojson отсутствует |
