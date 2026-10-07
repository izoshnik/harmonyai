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

- `Art/Tools/` — процедурное моделирование в Blender (bpy 5.2, headless): `blender_common.py` + `build_pistol_pm17.py`.
  Первая модель: пистолет «ПМ-17» (референс — Glock 17), 14 деталей, ~15.9k треугольников, `Art/Export/Weapons/*.glb`, рендеры в `Art/Renders/Weapons/`. Качество — PARTIALLY IMPLEMENTED: нет UV-развёртки и запечённых текстур, остались артефакты шейдинга на затворе.

- **Этап 1 — UE-проект (UNVERIFIED BUILD: движок здесь недоступен, C++ модулей UE не собирался):**
  - `PrimorskySim.uproject`, targets Game/Editor/Server/Client, `Config/Default{Engine,Game,GameplayTags,Input}.ini`.
  - `PrimSimCore` — чистый C++17 (без UE): `GeoTransform` (tmerc WGS84), `Ledger` (двойная запись, идемпотентность, защита от переполнения), `MetroSim` (кинематика, остановки, двери, оборот, интервал). **Собирается g++/clang -Werror, тесты проходят** (`Tests/SimCore`).
  - `PrimCore` — `FPrimGeoReference`, `FPrimWorldTime`, нативные Gameplay Tags.
  - `PrimWorld` — `UPrimWorldManifestSubsystem`: загрузка WorldManifest.json в рантайме.
  - `PrimInteraction` — `UPrimInteractableComponent`, `UPrimInteractionAction`, `UPrimInteractorComponent` (Server RPC, дистанция, LOS, rate limit).
  - `PrimEconomy` — `UPrimLedgerSubsystem` (только сервер), `UPrimWalletComponent` (реплика баланса только владельцу).
  - `PrimMetro` — `UPrimTrainTypeAsset`, `UPrimMetroLineAsset`, `APrimMetroLine` (сплайн трассы, серверная симуляция, квантованная репликация, клиентские вагоны с интерполяцией).
  - `PrimorskySim` — `APrimGameMode` (время, стартовые деньги через Ledger), `APrimGameState` (время мира), `APrimPlayerController`, `APrimCharacter` (Enhanced Input, спринт).
- `Tools/run_checks.sh` — все проверки без движка.
- `Art/AssetRegistry.json` — сторонние модели и статус их лицензий (USP-S Cyrex отклонён: IP Valve).

## Решения заказчика (2026-10-07)
- 3D-модели: делаем сами (процедурно в Blender) или берём бесплатные ассеты только с лицензией, разрешающей использование в коммерческой игре (CC0/CC-BY, бесплатные ассеты Fab со Standard License). Модели с лицензией «editorial only» не используем.
- Бренды: нейтральные названия и логотипы, форма узнаваемая (`display_name_policy = fictionalized`).
- Репозиторий: отдельный. Создать его должен заказчик — у интеграции нет прав на создание репозиториев (403). Пока проект живёт в `PrimorskySim/`.
- Версия UE, VCS, население: по умолчанию — последняя стабильная 5.x, Git LFS, коэффициент населения в конфиге (стартовое значение 1:10).

## В работе / заблокировано
- **BLOCKED (сеть)**: граница и карта района. Импортёр готов (`import_osm.py`, тест на синтетической карте проходит); после открытия доступа к overpass-api.de и download.geofabrik.de запускается `Tools/WorldPipeline/build_world_data.sh`.
- **BLOCKED**: перенос в отдельный репозиторий — ждёт, пока заказчик его создаст и даст доступ. Сборка UE в облачной среде невозможна (нет движка и Windows).

## Сломано / известные долги
- Спринт меняет MaxWalkSpeed через RPC — при лаге будут коррекции; перенести в FSavedMove (этап 5).
- `APrimMetroLine` грузит классы вагонов синхронно (LoadSynchronous) — заменить на async preload.
- Нет Blueprint-ассетов (BP_PrimCharacter, Input Actions, карта) — создаются в редакторе при первой сборке.

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
