# Production Architecture (A) и структура проекта (B)

Статус: **ARCHITECTURE DEFINED, NOT IMPLEMENTED.** Кода Unreal пока нет; движок в облачной среде не собирается.

## 1. Принципы

1. **Server authority.** Любое состояние, влияющее на геймплей (деньги, здоровье, инвентарь, собственность, розыск, транспорт), меняется только на dedicated server. Клиент шлёт *намерения*, не результаты.
2. **Данные отдельно от кода.** Мир — `WorldManifest` + GIS-слои; геймплей — Data Assets / Data Tables / Gameplay Tags. Никаких захардкоженных NPC, машин, маршрутов.
3. **Состояние отдельно от представления.** NPC, поезд, автобус, машина в трафике существуют как *запись в симуляции*; Actor — только визуализация рядом с игроком (см. §4).
4. **Один механизм на класс задач.** Одна система взаимодействия, одна система повреждений, одна экономическая книга, одна система расписаний (люди, автобусы, поезда используют общий `Schedule` слой).
5. **Точность > удобство.** Реальный объект без записи в манифесте не может попасть в мир как «реальный» — это проверяет валидация на трёх уровнях.

## 2. Технологический стек

| Слой | Решение | Комментарий |
|---|---|---|
| Движок | Unreal Engine 5, **source build** | Dedicated Server target требует сборки движка из исходников. Конкретная минорная версия фиксируется на этапе 0 (последняя стабильная 5.x на дату старта) и не меняется без миграционного плана. |
| Язык | C++ (системы), Blueprint (сборка, контент, тюнинг) | Blueprint не владеет серверным состоянием и не реализует правил. |
| Мир | World Partition, HLOD, Data Layers, Level Instances, Nanite для статики, PCG только для *недостоверных* мелочей (трава, мусор) с явной пометкой | PCG не генерирует ни зданий, ни дорог. |
| Толпа/трафик | Mass Entity + Mass AI (StateTree) для mid/far-LOD; Actor + Behavior Tree/StateTree для near | |
| Сеть | Dedicated Server, Replication Graph / Iris (решение на этапе 0 по результатам нагрузочного теста), Network Dormancy, Relevancy | |
| Persistence | PostgreSQL (+ PostGIS для пространственных запросов) за сервисом `Persistence` | UE-сервер не пишет в БД напрямую из геймплея — только через `UPersistenceSubsystem` с батчингом. |
| Экономика | Двойная запись (double-entry ledger) в PostgreSQL, идемпотентные транзакции | см. Economy.md |
| LLM / STT / TTS | Внешний сервис `DialogueService` за шлюзом; ответ — только структурированный intent | см. AI.md |
| GIS pipeline | Python 3 + GDAL/OGR, PROJ, QGIS (ручная сверка), osmium | см. World.md |
| VCS | **Perforce (Helix Core)** для UE-контента или Git + LFS с file locking | Бинарные `.uasset/.umap` без блокировок в обычном git — неработоспособно в команде. Решение — у заказчика (DataRequirements). |
| CI | Build (Win64 Client/Server/Editor), data validation, editor commandlet validation, automation tests | |

## 3. Модули C++ (каждый — отдельный UE module)

Отдельные модули вместо папок в одном модуле: явные зависимости, быстрее инкрементальная сборка, нельзя случайно завязать экономику на рендер.

| Модуль | Назначение | Зависит от |
|---|---|---|
| `PrimCore` | Типы, Gameplay Tags, логирование, `FPrimId`, время мира (`UWorldClockSubsystem`), геокоординаты (`FGeoTransform`) | Engine |
| `PrimSimCore` | Ядро симуляции без UObject: расписания, графы, агенты far-LOD, детерминированные шаги. Выносимо в отдельный процесс. | только Core (UE) |
| `PrimWorld` | Загрузка манифеста, `UWorldManifestSubsystem`, зоны, адреса, здания, дворы, POI-реестр | PrimCore |
| `PrimWorldValidation` | Editor commandlet и автотесты уровня 3 валидации | PrimWorld, PrimMetro, PrimTransport |
| `PrimInteraction` | Intent → Context → Validation → Rules → Action | PrimCore |
| `PrimNPC` | Identity, потребности, память, отношения; мост SimCore ↔ Mass ↔ Actor | PrimSimCore, PrimInteraction |
| `PrimAI` | StateTree/BT задачи, Utility-оценки, AI LOD | PrimNPC |
| `PrimDialogue` | Клиент `DialogueService`, intent-схемы, voice pipeline | PrimInteraction |
| `PrimVehicles` | Chaos Vehicles + компонентная модель машины (двигатель, КПП, тормоза, шины, повреждения) | PrimCore, PrimInteraction |
| `PrimTraffic` | Дорожный граф, светофоры, Mass-трафик | PrimWorld, PrimVehicles |
| `PrimTransport` | Наземный ОТ: маршруты, рейсы, остановки (GTFS) | PrimTraffic, PrimSimCore |
| `PrimMetro` | Линии, станции, поезда, диспетчер, пассажиропоток | PrimWorld, PrimSimCore |
| `PrimEconomy` | Ledger-клиент, цены, зарплаты, налоги | PrimCore, PrimPersistence |
| `PrimJobs` | Заказы/работы как цепочки задач между агентами | PrimEconomy, PrimNPC |
| `PrimLaw` | Нарушения, свидетели, доказательства, розыск, полиция | PrimNPC, PrimAI |
| `PrimCombat` | Оружие, урон, ближний бой, травмы (Gameplay Ability System) | PrimInteraction |
| `PrimInventory` | Инвентарь, предметы | PrimInteraction |
| `PrimProperty` | Недвижимость, права, аренда, строительство | PrimEconomy, PrimWorld |
| `PrimDestruction` | Состояния повреждения, Geometry Collections для выбранных объектов | PrimCore |
| `PrimEnvironment` | День/ночь, погода, поверхность дорог (сцепление) | PrimCore |
| `PrimPersistence` | Сохранение/загрузка, батчинг, версии схем | PrimCore |
| `PrimNet` | Replication Graph/Iris политики, relevancy, анти-чит валидации | PrimCore |
| `PrimCharacter` | Персонаж игрока, кастомизация | PrimInteraction, PrimCombat |
| `PrimUI` | CommonUI, настройки (Graphics/Audio/Gameplay/Controls через Enhanced Input), HUD | все публичные интерфейсы |
| `PrimAudio` | MetaSounds, объявления, радио, proximity voice | PrimCore |

Правило: межмодульное взаимодействие — через интерфейсы (`IPrimInteractable`, `IPrimSchedulable`…) и Gameplay Message Router, без прямых ссылок «вниз-вверх».

## 4. Модель «запись ↔ представление» (сквозная для NPC, транспорта, метро)

```
[Persistent record (БД)] ⇄ [SimCore agent: far LOD, event-driven]
                               ⇅ promote/demote по дистанции до ближайшего игрока
                          [Mass entity: mid LOD, упрощённое движение]
                               ⇅
                          [Actor: near LOD, полная логика, физика, анимация, репликация]
```
- Переход между уровнями детерминирован: позиция/задача выводятся из расписания и текущего шага задачи (например, «едет в автобусе 1234 между остановками A и B, прогресс 0.42»), поэтому при приближении игрока объект появляется там, где «должен» быть.
- Demote возможен только когда объект вне поля зрения всех игроков (проверка на сервере) — иначе «исчезновения».

## 5. Структура репозитория (B)

```
PrimorskySim/
  PrimorskySim.uproject            (этап 1)
  Source/
    PrimorskySim/                  Game module (тонкий: GameMode, GameState, PlayerController)
    PrimorskySimServer.Target.cs   Client/Editor/Server targets
    PrimCore/ PrimSimCore/ PrimWorld/ PrimWorldValidation/ PrimInteraction/
    PrimNPC/ PrimAI/ PrimDialogue/ PrimVehicles/ PrimTraffic/ PrimTransport/
    PrimMetro/ PrimEconomy/ PrimJobs/ PrimLaw/ PrimCombat/ PrimInventory/
    PrimProperty/ PrimDestruction/ PrimEnvironment/ PrimPersistence/ PrimNet/
    PrimCharacter/ PrimUI/ PrimAudio/
  Content/
    World/        уровни World Partition, HLOD, Data Layers
    Buildings/    модульные киты фасадов по сериям/эпохам застройки + уникальные здания
    Props/        уличная мебель, дворовые элементы, знаки, светофоры
    Characters/  Vehicles/  Weapons/  Metro/  Audio/  UI/
  Config/         DefaultGame/Engine/Input.ini, теги
  Data/
    Schemas/      JSON Schema всех внешних данных (WorldManifest и др.)
    World/ NPC/ Vehicles/ Weapons/ Economy/ Transport/ Metro/   исходные таблицы → импорт в Data Tables
  WorldReference/ эталонные данные мира (см. World.md)
  Tools/
    WorldPipeline/  GIS-импорт, валидация уровня 1–2
  Services/        (этап 2+) DialogueService, Persistence/Ledger API
  Docs/
```
Структура `Source/` и `.uproject` создаются на этапе 1 Roadmap, после фиксации версии движка и VCS.
