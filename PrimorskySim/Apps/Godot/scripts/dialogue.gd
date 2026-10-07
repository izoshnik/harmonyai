## Диалоги с NPC через Claude API (если в настройках указан ключ) или заготовленными фразами.
## Ответ модели — строго JSON {reply, intent}: intent — намерение (follow, leave, give_directions, none),
## которое игра проверяет и исполняет сама; модель никогда не меняет деньги/здоровье напрямую.
class_name Dialogue
extends Node

signal answered(npc: Node, reply: String, intent: String)

const URL := "https://api.anthropic.com/v1/messages"
const MODEL := "claude-opus-5-5"
const INTENTS := ["none", "follow", "stop_follow", "leave", "give_directions", "call_police"]

const FALLBACK := {
	"greet": ["Здравствуйте.", "Добрый день!", "Да?", "Слушаю вас.", "Привет."],
	"directions": ["Метро? Вон туда, минут десять пешком.", "Магазин за углом, у остановки."],
	"bye": ["Всего доброго.", "Пока.", "Удачи."],
}

var _busy := {}


func ask(npc: Node, persona: String, history: Array, player_text: String, context: String) -> void:
	var key: String = Settings.get_v("ai_api_key")
	if key == "" or not Settings.get_v("ai_enabled"):
		_fallback(npc, player_text)
		return
	if _busy.get(npc, false):
		return
	_busy[npc] = true
	var http := HTTPRequest.new()
	http.timeout = 25.0
	add_child(http)
	http.request_completed.connect(func(result, code, _h, body): _on_done(npc, http, result, code, body, player_text))
	var messages := history.duplicate()
	messages.append({"role": "user", "content": player_text})
	var body := {
		"model": MODEL,
		"max_tokens": 1024,
		"fallbacks": "default",
		"output_config": {
			"effort": "low",
			"format": {"type": "json_schema", "schema": {
				"type": "object",
				"properties": {
					"reply": {"type": "string"},
					"intent": {"type": "string", "enum": INTENTS},
				},
				"required": ["reply", "intent"],
				"additionalProperties": false,
			}},
		},
		"system": "Ты — житель Приморского района Санкт-Петербурга в компьютерной игре, октябрь 2026 года. "
			+ persona + "\nОбстановка: " + context
			+ "\nОтвечай по-русски, 1–2 короткие фразы, живо и в характере. "
			+ "intent: follow — согласен пойти с игроком; stop_follow — перестать следовать; leave — уходишь; "
			+ "give_directions — объясняешь дорогу; call_police — если тебе угрожают; иначе none. "
			+ "Ты не можешь менять деньги, здоровье или вещи игрока.",
		"messages": messages,
	}
	var headers := ["content-type: application/json", "x-api-key: " + key, "anthropic-version: 2023-06-01",
		"anthropic-beta: server-side-fallback-2026-07-01"]
	var err := http.request(URL, headers, HTTPClient.METHOD_POST, JSON.stringify(body))
	if err != OK:
		_busy[npc] = false
		http.queue_free()
		_fallback(npc, player_text)


func _on_done(npc: Node, http: HTTPRequest, result: int, code: int, body: PackedByteArray, player_text: String) -> void:
	_busy[npc] = false
	http.queue_free()
	if result != HTTPRequest.RESULT_SUCCESS or code != 200:
		push_warning("Claude API: HTTP %d" % code)
		answered.emit(npc, "(нет связи с ИИ: код %d) " % code + _pick("greet"), "none")
		return
	var data: Variant = JSON.parse_string(body.get_string_from_utf8())
	if typeof(data) != TYPE_DICTIONARY:
		_fallback(npc, player_text)
		return
	if data.get("stop_reason", "") == "refusal":
		answered.emit(npc, "Не хочу об этом говорить.", "none")
		return
	for block in data.get("content", []):
		if block.get("type", "") == "text":
			var parsed: Variant = JSON.parse_string(block["text"])
			if typeof(parsed) == TYPE_DICTIONARY:
				var intent: String = parsed.get("intent", "none")
				answered.emit(npc, str(parsed.get("reply", "…")), intent if intent in INTENTS else "none")
				return
	_fallback(npc, player_text)


func _fallback(npc: Node, player_text: String) -> void:
	var t := player_text.to_lower()
	if "метро" in t or "где" in t or "как пройти" in t:
		answered.emit(npc, _pick("directions"), "give_directions")
	elif "пойд" in t or "за мной" in t or "со мной" in t:
		answered.emit(npc, "Ну пойдём.", "follow")
	elif "пока" in t or "до свид" in t:
		answered.emit(npc, _pick("bye"), "leave")
	else:
		answered.emit(npc, _pick("greet"), "none")


func _pick(k: String) -> String:
	var a: Array = FALLBACK[k]
	return a[randi() % a.size()]
