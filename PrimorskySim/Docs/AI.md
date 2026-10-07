# AI, взаимодействие, LLM и голос

## Слой решений
- StateTree (предпочтительно) / Behavior Trees для near-LOD поведения; Utility-оценки для выбора целей; Mass StateTree для mid-LOD.
- Восприятие: AIPerception (зрение/слух) только у near; mid/far получают события через `GameplayMessage` с радиусом (выстрел, авария).

## Universal Interaction System (модуль PrimInteraction)
```
Player → Target → Intent → Context → Validation → Game Rules → Action → Physical/AI Response
```
- `UInteractableComponent` на любом объекте: список поддерживаемых intents (Gameplay Tags: `Intent.Door.Open`, `Intent.NPC.Talk`, `Intent.Vehicle.Enter`…), ссылки на `UInteractionRuleSet`.
- `UInteractionIntentDef` (Data Asset): требования (дистанция, LOS, предметы, права, навыки), стоимость времени/денег, длительность, анимация, результат (вызов action-класса).
- Игрок получает контекстное радиальное меню + текст/голос; одна клавиша «взаимодействовать» + выбор.
- Сервер выполняет `FInteractionRequest{instigator, target, intent, params}` → `Validate` → `Execute`. Новые взаимодействия — данные + при необходимости один action-класс, переиспользуемый многими объектами.

## LLM (DialogueService)
LLM **не** управляет NPC и **не** меняет состояние.
```
Текст/голос игрока + контекст NPC (роль, память, отношения, ситуация)
   → DialogueService → { reply_text, intents: [{tag, params, confidence}] }
   → PrimInteraction.Validate (те же правила, что и у кнопок)
   → Game Rules → Action
```
- Белый список intents на ответ определяется ролью NPC и ситуацией (продавец может предложить `Trade`, но не изменить цену вне правил экономики).
- Защиты: JSON-схема ответа, отклонение неизвестных тегов, лимиты частоты, фильтрация вывода, таймаут → fallback-реплики из Data Tables.
- Дешёвые случаи (приветствие, «где метро?») — без LLM: шаблоны + данные мира.

## Голос
Microphone → VAD → STT (DialogueService) → тот же intent-пайплайн → TTS ответа NPC → субтитры.
- Proximity voice между игроками, телефон, рация — каналы `PrimAudio` (VOIP UE/внешний провайдер — решение этапа 3).
- Пример: «Пойдём со мной» → `Intent.NPC.Follow{target=player}` → проверка (NPC не на работе/не боится игрока/отношения) → StateTree `FollowActor`.
