# PROJECT_STATE

Последнее обновление: 2026-10-07. Читать первым перед любой задачей.

## Реализовано (IMPLEMENTED)
- Документация архитектуры: `Architecture.md` (A, B), `World.md` (C, D, границы, World Partition, GIS), `Validation.md` (E), `Metro.md` (F), `Multiplayer.md` (G), `NPC.md` + `AI.md` (H), `Vehicles.md` (I), `Economy.md` (J), `Performance.md` (K), `Roadmap.md` (L), `DataRequirements.md`.
- `Data/Schemas/WorldManifest.schema.json` — схема манифеста.
- `WorldReference/WorldManifest.json` — 10 seed-объектов (граница, линии 2/3/5, 5 станций, «Балтиец»); все NEEDS_VERIFICATION/UNKNOWN, координаты не заполнены сознательно.
- `WorldReference/Sources/SourceRegistry.json` — реестр источников и лицензий.
- `Tools/WorldPipeline/validate_world.py` — L1-валидация + отчёт; 13 unit-тестов проходят.
- `Tools/WorldPipeline/fetch_osm_boundary.py` — выгрузка границы из OSM (не запускался против сети: доступ закрыт; сборка колец покрыта тестами).
- `Data/Weapons/WeaponReference.json` — справочные значения из скриншотов заказчика (не баланс).

## В работе / заблокировано
- **BLOCKED**: граница района — нет доступа к OSM из облачной среды (403 на overpass/geofabrik/nominatim).
- **BLOCKED**: этап 1 (UE-проект) — ждёт решений заказчика (DataRequirements #9, #10).

## Сломано
- Нет.

## Архитектурные решения
- Отдельные UE-модули на домен; `PrimSimCore` без UObject (выносимость far-симуляции).
- Запись ↔ представление: far (event-driven) / mid (Mass) / near (Actor).
- Локальная tmerc-проекция с центром в районе (не UTM — шов зон 35/36 по 30° в.д.).
- Ledger с двойной записью, деньги в int64 копейках.
- LLM → structured intent → та же валидация, что и у UI.
- Яндекс — только визуальная сверка человеком.
- Игровой проект изолирован в `PrimorskySim/` (репозиторий — веб-приложение; `.vercelignore` исключает каталог из деплоя сайта).

## TODO (следующие шаги)
1. Получить данные DataRequirements «ОБЯЗАТЕЛЬНО».
2. Граница → origin проекции → `engine_origin`.
3. Этап 1 Roadmap.

## Известные ограничения
- Движок UE в облачной среде отсутствует — C++ нельзя собрать здесь; сборка будет в CI с Windows-раннером/у заказчика.
- Все утверждения о реальных объектах в документах — NEEDS_VERIFICATION до подтверждения источниками.
