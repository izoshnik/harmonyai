# World: Reference Pipeline (C), WorldManifest (D), границы, World Partition, GIS-импорт

## 1. Границы мира

| Зона | Содержимое | Детализация |
|---|---|---|
| **Core** — внутри `PrimorskyDistrictBoundary` | Всё: улицы, здания, дворы, POI, интерьеры по приоритету | Полная |
| **Context ring** — полоса снаружи (ширина задаётся после получения границы; ориентир 300–800 м) | Продолжение дорог и ОТ, фасады вдоль границы, перегоны метро до следующей станции | Фасады без интерьеров, упрощённые дворы |
| **Horizon** — дальний фон (центр, Кронштадт, ЗСД, Финский залив) | HLOD/импостеры, силуэты, вода | Только визуал |

Граница:
- Источник геометрии — OSM relation района; источник истины для спорных мест — закон СПб о территориальном устройстве.
- Отдельно проверяются участки: акватория Финского залива и намывы, Лахта/Ольгино/Лисий Нос (внутригородские муниципальные образования района), стыки с Выборгским, Петроградским и Курортным районами, Чёрная речка/Большая Невка.
- **Текущий статус: BLOCKED** — из облачной среды нет доступа к OSM (403). Скрипт `Tools/WorldPipeline/fetch_osm_boundary.py` запускается локально или вы присылаете выгрузку.

## 2. Система координат

- Хранение: WGS84 (EPSG:4326) в манифесте и GeoJSON.
- Движок: **локальная поперечная проекция Меркатора** с центром в центроиде границы района (`+proj=tmerc`). Не UTM: район пересекает меридиан 30° — границу зон UTM 35/36, что дало бы шов.
- Искажение масштаба на ~15 км от центра ≈ 3·10⁻⁶ — пренебрежимо.
- UE: 1 uu = 1 см, X = восток, Y = **юг** (левосторонняя система UE), Z = высота в Балтийской системе − базовая отметка. Large World Coordinates включены.
- Origin фиксируется **один раз** и записывается в `WorldManifest.crs.engine_origin`; смена после начала контента запрещена.

## 3. World Reference Pipeline (C)

```
 Источники                    Нормализация                Реестр                   Импорт в UE              Валидация
 ─────────                    ────────────                ──────                   ───────────              ─────────
 OSM .osm.pbf (дата 2026) ─┐
 Граница (закон)          ─┤  osmium/ogr2ogr →          WorldManifest.json  ─→  Commandlet ImportWorld  ─→ L1 data (CI)
 Открытые данные СПб      ─┼─ GeoPackage по слоям  ─→   + слои GPKG/GeoJSON      (дороги→Road Graph,       L2 import
 GTFS ОТ                  ─┤  (roads, buildings, poi,   в WorldReference/        здания→Building       ─→ L3 engine
 DEM                      ─┤   metro, transit…)          Sources/SourceRegistry   Descriptors, POI→       → WorldValidationReport
 Ортофото (лицензия!)     ─┤  ручная сверка в QGIS                                 реестр, метро→Metro DB)
 Фото заказчика (EXIF GPS)─┤  matching фото↔объект
 Яндекс (только глазами)  ─┘  ← человек сверяет и пишет verification_status, НЕ копирует данные
```

Правила пайплайна:
1. Каждый объект получает `object_id` при первом импорте и сохраняет его навсегда (стабильные ID ↔ OSM id/адрес хранятся в `attributes.osm_id`).
2. Импорт **не создаёт** объекты, которых нет в источниках. Пробелы (нет этажности, нет высоты) остаются пустыми со статусом `NEEDS_VERIFICATION` и списком `verification_needs`; в движке такие здания получают визуальную пометку в редакторе (debug-материал) и не попадают в shipping-сборку без явного решения.
3. Повторный импорт = diff: новые/удалённые/изменённые объекты выводятся в отчёт для ручного подтверждения; удалить «реальный» объект можно только через ревью.
4. Яндекс Карты/Панорамы: только визуальная сверка человеком (это отмечается в `notes`), без трассировки, скриншотов в репозитории и автоматического извлечения — это запрещено условиями сервиса.
5. Лицензии: производная БД от OSM — ODbL (атрибуция в титрах, share-alike для публикуемой БД). Ортофото — только с лицензией, разрешающей трассировку.

### Структура `WorldReference/`
```
Boundary/        PrimorskyDistrictBoundary.geojson + .meta.json (источник, дата, relation id)
Satellite/       ортофото тайлами (GeoTIFF) — НЕ в git, только манифест и ссылки на хранилище
Roads/ Buildings/ Metro/ Transport/ Landmarks/ POI/ Nature/ Industrial/ Infrastructure/
                 GeoPackage/GeoJSON слоёв + поясняющие README
StreetView/      фото заказчика: <object_id>/<дата>_<n>.jpg + photos.csv (lat, lon, азимут, дата)
Sources/         SourceRegistry.json — источники, лицензии, допустимое использование
Validation/      WorldValidationReport.{json,md}
WorldManifest.json
```
Крупные бинарные материалы (ортофото, фото, сканы) хранятся вне git (Perforce/LFS/объектное хранилище); в репозитории — только индексы.

## 4. WorldManifest schema (D)

Файл схемы: `Data/Schemas/WorldManifest.schema.json` (JSON Schema 2020-12). Обязательные поля из ТЗ: `object_id, category, real_name, type, coordinates, source, source_url, verification_status, confidence, year, notes, importance, interior_required, gameplay_required`.

Дополнительно: `geometry_ref`, `address`, `source_ids` (→ SourceRegistry), `last_checked`, `verification_needs`, `district_scope` (`inside | adjacent_context | outside_context | not_spatial`), `display_name_policy` (`real | fictionalized | generic | undecided` — для брендов/товарных знаков), `related_ids`, `attributes` (типоспецифичные поля).

Правила статусов (проверяются автоматически):
- `VERIFIED` — есть `source_url`, данные ≥ 2025 года, `confidence ≥ 0.9`, `last_checked`, геометрия/координаты; Яндекс не может быть единственным источником.
- `NEEDS_VERIFICATION` / `UNKNOWN` — обязателен непустой `verification_needs`.
- Координаты `null` допустимы для непроверенных — лучше пусто, чем выдумано.

`attributes` по категориям (валидируются профильными проверками на этапе 2):
- **building**: `levels`, `height_m`, `footprint_ref`, `building_type` (residential, commercial, office, school, hospital, clinic, pharmacy, bank, restaurant, fast_food, shopping_mall, supermarket, warehouse, industrial, police, government, metro, parking, religious, sports, entertainment, other), `series` (типовая серия, если известна), `entrances[]`, `courtyard_id`, `commercial_units[]`, `parking_ids[]`, `interior_level` (`none | lobby | key_rooms | full`), `facade_profile` (ссылка на параметры модульного кита), `year_built`.
- **road**: `lanes_forward/backward`, `oneway`, `highway_class`, `maxspeed`, `surface`, `sidewalk`, `cycleway`, `parking`, `turn_lanes`, `geometry_ref`.
- **courtyard**: `building_ids[]`, `playgrounds`, `sports`, `parking`, `waste_points`, `paths_ref`, `lighting`, `fences`, `passages[]` (реальные проходы/арки).
- **metro_station / transit_stop / transit_route** — см. Metro.md, Vehicles.md.

## 5. Здания и дворы

- Здание = `FBuildingDescriptor` (из манифеста) → сборка из **модульного кита серии** (типовые серии жилых домов района — отдельные киты; конкретный перечень серий определяется по данным, не заранее) + **уникальные параметры** (этажность, число секций, подъезды, цвет/материал панелей, балконы, первые этажи с реальными коммерческими помещениями).
- Уникальные/знаковые здания — индивидуальные модели (`importance=critical|high`).
- Двор — отдельный объект `courtyard`, привязанный к домам; детские/спортивные площадки, контейнерные площадки, парковки, проходы ставятся по ортофото/фото, а не процедурно. Если данных нет — двор остаётся в статусе `NEEDS_VERIFICATION` с базовой геометрией (газон/дорожки из OSM) и попадает в список на фотосъёмку.

## 6. World Partition strategy

| Grid | Ячейка | Loading range | Что лежит |
|---|---|---|---|
| `Surface` | 128 м | 512–768 м (клиент) | здания, дворы, улицы, пропсы |
| `SurfaceLarge` | 512 м | 2 км | крупные объекты: ЖК-высотки, мосты, развязки, промзоны |
| `Underground` | 64 м | 192 м | метро: станции, тоннели, служебные зоны |
| `Interiors` | Level Instances / отдельные стриминговые уровни по входу | по триггеру входа | интерьеры (не в общей сетке) |

- **HLOD**: 3 слоя — HLOD0 (merged instanced, 128 м), HLOD1 (simplified mesh, 512 м), HLOD2 (импостеры кварталов, весь район + горизонт).
- **Data Layers**: `Season_Winter/Summer` (снег, листва), `Construction_2026` (стройплощадки на дату состояния мира), `Event_*`, `Debug_Unverified`.
- **Сервер**: включён server streaming; сервер грузит ячейки вокруг игроков и активных near-сущностей. Симуляция far-LOD не требует загруженных ячеек (работает на графах в `PrimSimCore`).
- Навигация: World Partitioned Navmesh (стриминговый), отдельные графы — дорожный, пешеходный, транзитный — строятся пайплайном из GIS и не зависят от загрузки уровня.

## 7. GIS → Unreal import pipeline

1. `fetch_*` / ручная загрузка источников → `WorldReference/Sources` (+ SourceRegistry).
2. Нормализация: обрезка по `Core ∪ Context ring`, перепроекция в локальную tmerc, топологическая очистка дорог (snapping узлов, разрывы, дубликаты), объединение атрибутов этажности из официальных данных.
3. L1-валидация (`validate_world.py`) → если есть ошибки, импорт не запускается.
4. Editor commandlet `ImportWorld` (модуль `PrimWorld`, этап 2): создаёт Road Graph asset, Building Descriptors, POI Data Table, Metro DB, Transit DB; расставляет акторы-строители в World Partition. Идемпотентен: повторный запуск обновляет, а не дублирует.
5. L2/L3-валидация → `WorldValidationReport`.
