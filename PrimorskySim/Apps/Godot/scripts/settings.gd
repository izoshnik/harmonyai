## Настройки игры (автозагрузка Settings): графика, управление, интерфейс, ИИ. Хранятся в user://settings.cfg.
extends Node

signal changed

const PATH := "user://settings.cfg"
const ACTIONS := {
	"move_forward": "Вперёд", "move_back": "Назад", "move_left": "Влево", "move_right": "Вправо",
	"sprint": "Бег", "jump": "Прыжок", "interact": "Взаимодействие", "attack": "Удар",
	"walk_toggle": "Шаг / бег трусцой", "camera_toggle": "Вид от 1-го/3-го лица", "map_toggle": "Мини-карта",
	"phone_time": "Ускорить время",
}
const DEFAULT_KEYS := {
	"move_forward": KEY_W, "move_back": KEY_S, "move_left": KEY_A, "move_right": KEY_D,
	"sprint": KEY_SHIFT, "jump": KEY_SPACE, "interact": KEY_E, "attack": KEY_F,
	"walk_toggle": KEY_CTRL, "camera_toggle": KEY_V, "map_toggle": KEY_M, "phone_time": KEY_T,
}

var values := {
	"quality": 1,            # 0 низкое, 1 среднее, 2 высокое, 3 ультра (SDFGI)
	"render_scale": 0.85,
	"fsr": true,
	"shadows": 1,            # 0 выкл, 1 средние, 2 высокие
	"view_distance": 1800.0,
	"vegetation": 1.0,       # плотность деревьев 0..1
	"traffic": 90,
	"pedestrians": 50,
	"fps_limit": 0,
	"vsync": true,
	"fullscreen": true,
	"mouse_sens": 1.0,
	"invert_y": false,
	"fov": 75.0,
	"minimap": true,
	"minimap_corner": 0,     # 0 слева сверху, 1 справа сверху, 2 слева снизу, 3 справа снизу
	"minimap_size": 220,
	"minimap_zoom": 1.0,
	"minimap_rotate": true,
	"ai_api_key": "",
	"ai_enabled": true,
	"volume": 0.8,
}
var keys := {}


func _ready() -> void:
	keys = DEFAULT_KEYS.duplicate()
	load_settings()
	apply_input()


func load_settings() -> void:
	var cfg := ConfigFile.new()
	if cfg.load(PATH) != OK:
		return
	for k in values.keys():
		values[k] = cfg.get_value("settings", k, values[k])
	for a in keys.keys():
		keys[a] = cfg.get_value("keys", a, keys[a])


func save_settings() -> void:
	var cfg := ConfigFile.new()
	for k in values.keys():
		cfg.set_value("settings", k, values[k])
	for a in keys.keys():
		cfg.set_value("keys", a, keys[a])
	cfg.save(PATH)


func set_value(key: String, v: Variant) -> void:
	values[key] = v
	save_settings()
	changed.emit()


func get_v(key: String) -> Variant:
	return values[key]


func apply_input() -> void:
	for a in keys.keys():
		if not InputMap.has_action(a):
			InputMap.add_action(a, 0.2)
		InputMap.action_erase_events(a)
		var ev := InputEventKey.new()
		ev.physical_keycode = keys[a]
		InputMap.action_add_event(a, ev)
	if not InputMap.has_action("attack_mouse"):
		InputMap.add_action("attack_mouse")
		var mb := InputEventMouseButton.new()
		mb.button_index = MOUSE_BUTTON_LEFT
		InputMap.action_add_event("attack_mouse", mb)


func rebind(action: String, keycode: int) -> void:
	keys[action] = keycode
	apply_input()
	save_settings()
	changed.emit()


func reset_keys() -> void:
	keys = DEFAULT_KEYS.duplicate()
	apply_input()
	save_settings()
	changed.emit()


static func key_name(code: int) -> String:
	return OS.get_keycode_string(code)
