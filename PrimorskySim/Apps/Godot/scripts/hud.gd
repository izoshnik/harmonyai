## HUD: здоровье, деньги, мини-карта (настраиваемая), улица и время, подсказка взаимодействия,
## окно диалога, меню выбора (магазин, метро, банкомат), уведомления, затемнение экрана.
class_name HUD
extends CanvasLayer


var player: Player
var data: Dictionary
var current_street := ""
var current_time := ""
var ui_open := false

var _root: Control
var _hp_bar: ProgressBar
var _money: Label
var _info: Label
var _prompt: Label
var _toast: Label
var _toast_t := 0.0
var _map_panel: Panel
var _map: Control
var _map_tex: Texture2D
var _map_origin := Vector2.ZERO
var _map_res := 4.0
var _dialog: PanelContainer
var _dialog_log: RichTextLabel
var _dialog_input: LineEdit
var _dialog_send: Callable
var _dialog_close: Callable
var _menu: PanelContainer
var _menu_box: VBoxContainer
var _fade: ColorRect
var _speed: Label
var _stations: Array = []


func build(d: Dictionary, p: Player, stations: Array) -> void:
	data = d
	player = p
	_stations = stations
	_root = Control.new()
	_root.set_anchors_preset(Control.PRESET_FULL_RECT)
	_root.mouse_filter = Control.MOUSE_FILTER_IGNORE
	add_child(_root)
	_build_status()
	_build_minimap()
	_build_prompt()
	_build_dialog()
	_build_menu()
	_fade = ColorRect.new()
	_fade.color = Color(0, 0, 0, 0)
	_fade.set_anchors_preset(Control.PRESET_FULL_RECT)
	_fade.mouse_filter = Control.MOUSE_FILTER_IGNORE
	_root.add_child(_fade)
	p.money_changed.connect(_refresh_money)
	p.notify.connect(toast)
	Settings.changed.connect(_layout_minimap)
	_refresh_money()


func _panel_style(alpha := 0.72) -> StyleBoxFlat:
	var sb := StyleBoxFlat.new()
	sb.bg_color = Color(0.06, 0.07, 0.09, alpha)
	sb.set_corner_radius_all(8)
	sb.set_content_margin_all(10)
	return sb


func _label(size: int, color := Color(0.93, 0.95, 0.98)) -> Label:
	var l := Label.new()
	l.add_theme_font_size_override("font_size", size)
	l.add_theme_color_override("font_color", color)
	l.add_theme_color_override("font_shadow_color", Color(0, 0, 0, 0.8))
	l.add_theme_constant_override("shadow_offset_x", 1)
	l.add_theme_constant_override("shadow_offset_y", 1)
	return l


# ------------------------------------------------------------------ здоровье, деньги, инфо

func _build_status() -> void:
	var box := VBoxContainer.new()
	box.set_anchors_preset(Control.PRESET_BOTTOM_LEFT)
	box.position = Vector2(24, -110)
	box.add_theme_constant_override("separation", 6)
	_root.add_child(box)
	_money = _label(26, Color(0.55, 0.95, 0.6))
	box.add_child(_money)
	_hp_bar = ProgressBar.new()
	_hp_bar.custom_minimum_size = Vector2(260, 16)
	_hp_bar.max_value = 100
	_hp_bar.show_percentage = false
	var fill := StyleBoxFlat.new()
	fill.bg_color = Color(0.85, 0.22, 0.2)
	fill.set_corner_radius_all(4)
	var bg := StyleBoxFlat.new()
	bg.bg_color = Color(0, 0, 0, 0.55)
	bg.set_corner_radius_all(4)
	_hp_bar.add_theme_stylebox_override("fill", fill)
	_hp_bar.add_theme_stylebox_override("background", bg)
	box.add_child(_hp_bar)
	_speed = _label(22)
	box.add_child(_speed)
	_info = _label(18)
	_info.set_anchors_preset(Control.PRESET_TOP_RIGHT)
	_info.horizontal_alignment = HORIZONTAL_ALIGNMENT_RIGHT
	_info.position = Vector2(-440, 18)
	_info.size = Vector2(420, 80)
	_root.add_child(_info)
	_toast = _label(20, Color(1, 0.92, 0.7))
	_toast.set_anchors_preset(Control.PRESET_CENTER_TOP)
	_toast.position = Vector2(-300, 110)
	_toast.size = Vector2(600, 40)
	_toast.horizontal_alignment = HORIZONTAL_ALIGNMENT_CENTER
	_root.add_child(_toast)


func _refresh_money() -> void:
	_money.text = "%s ₽   ·   на карте %s ₽" % [_fmt(player.money / 100), _fmt(player.bank / 100)]


static func _fmt(v: int) -> String:
	var s := str(abs(v))
	var out := ""
	while s.length() > 3:
		out = " " + s.substr(s.length() - 3) + out
		s = s.substr(0, s.length() - 3)
	return ("-" if v < 0 else "") + s + out


func toast(text: String) -> void:
	_toast.text = text
	_toast_t = 3.5


func fade(mid: Callable) -> void:
	var tw := create_tween()
	tw.tween_property(_fade, "color:a", 1.0, 0.4)
	tw.tween_callback(mid)
	tw.tween_interval(0.5)
	tw.tween_property(_fade, "color:a", 0.0, 0.5)


# ------------------------------------------------------------------ мини-карта

func _build_minimap() -> void:
	_render_map_texture()
	_map_panel = Panel.new()
	_map_panel.clip_contents = true
	var sb := StyleBoxFlat.new()
	sb.bg_color = Color(0.08, 0.09, 0.1, 0.85)
	sb.set_corner_radius_all(10)
	sb.border_color = Color(1, 1, 1, 0.25)
	sb.set_border_width_all(2)
	_map_panel.add_theme_stylebox_override("panel", sb)
	_map_panel.mouse_filter = Control.MOUSE_FILTER_IGNORE
	_root.add_child(_map_panel)
	_map = Control.new()
	_map.set_anchors_preset(Control.PRESET_FULL_RECT)
	_map.mouse_filter = Control.MOUSE_FILTER_IGNORE
	_map.draw.connect(_draw_map)
	_map_panel.add_child(_map)
	_layout_minimap()


func _layout_minimap() -> void:
	var sz: float = Settings.get_v("minimap_size")
	_map_panel.visible = Settings.get_v("minimap")
	_map_panel.size = Vector2(sz, sz)
	var vp := _root.get_viewport_rect().size if _root.is_inside_tree() else Vector2(1920, 1080)
	match int(Settings.get_v("minimap_corner")):
		0: _map_panel.position = Vector2(18, 18)
		1: _map_panel.position = Vector2(vp.x - sz - 18, 110)
		2: _map_panel.position = Vector2(18, vp.y - sz - 140)
		_: _map_panel.position = Vector2(vp.x - sz - 18, vp.y - sz - 18)


func _render_map_texture() -> void:
	# Растр района рендерится заранее (Tools/WorldPipeline/render_minimap.py)
	var meta: Dictionary = JSON.parse_string(FileAccess.get_file_as_string("res://data/minimap.json"))
	_map_tex = load("res://assets/minimap.png")
	_map_res = meta["res"]
	_map_origin = Vector2(meta["x0"], meta["y1"])  # левый верхний угол: x0, y1 (север)


func _player_world() -> Vector3:
	return (player.vehicle as Node3D).global_position if player.vehicle else player.global_position


func _to_map(w: Vector3) -> Vector2:
	return Vector2((w.x - _map_origin.x) / _map_res, (_map_origin.y - (-w.z)) / _map_res)


func _draw_map() -> void:
	var sz := _map.size
	var c := sz * 0.5
	var zoom: float = Settings.get_v("minimap_zoom")
	var pw := _player_world()
	var px := _to_map(pw)
	var yaw: float = player._yaw if player.vehicle == null else (player.vehicle as Node3D).rotation.y
	var rot: float = yaw if Settings.get_v("minimap_rotate") else 0.0
	_map.draw_set_transform(c, rot, Vector2(zoom, zoom))
	_map.draw_texture(_map_tex, -px)
	for st in _stations:
		var sp: Vector3 = st["pos"]
		var sx := _to_map(sp)
		_map.draw_circle(sx - px, 5.0 / zoom, Color(0.9, 0.15, 0.12))
	_map.draw_set_transform(c, 0, Vector2.ONE)
	var arrow_rot: float = 0.0 if Settings.get_v("minimap_rotate") else -yaw
	var pts := PackedVector2Array([Vector2(0, -9), Vector2(6, 7), Vector2(-6, 7)])
	var t := Transform2D(arrow_rot, Vector2.ZERO)
	for i in pts.size():
		pts[i] = t * pts[i]
	_map.draw_colored_polygon(pts, Color(1, 1, 1))
	_map.draw_set_transform(Vector2.ZERO, 0, Vector2.ONE)
	_map.draw_string(ThemeDB.fallback_font, Vector2(sz.x * 0.5 - 4, 16), "С" if not Settings.get_v("minimap_rotate") else "", HORIZONTAL_ALIGNMENT_LEFT, -1, 14)


# ------------------------------------------------------------------ подсказка и диалог

func _build_prompt() -> void:
	_prompt = _label(22)
	_prompt.set_anchors_preset(Control.PRESET_CENTER_BOTTOM)
	_prompt.position = Vector2(-400, -150)
	_prompt.size = Vector2(800, 40)
	_prompt.horizontal_alignment = HORIZONTAL_ALIGNMENT_CENTER
	_root.add_child(_prompt)


func _build_dialog() -> void:
	_dialog = PanelContainer.new()
	_dialog.add_theme_stylebox_override("panel", _panel_style(0.85))
	_dialog.set_anchors_preset(Control.PRESET_CENTER_BOTTOM)
	_dialog.position = Vector2(-380, -420)
	_dialog.custom_minimum_size = Vector2(760, 300)
	_dialog.visible = false
	_root.add_child(_dialog)
	var v := VBoxContainer.new()
	_dialog.add_child(v)
	_dialog_log = RichTextLabel.new()
	_dialog_log.custom_minimum_size = Vector2(740, 210)
	_dialog_log.scroll_following = true
	_dialog_log.bbcode_enabled = true
	v.add_child(_dialog_log)
	var row := HBoxContainer.new()
	v.add_child(row)
	_dialog_input = LineEdit.new()
	_dialog_input.placeholder_text = "Скажите что-нибудь… (Enter — отправить)"
	_dialog_input.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	_dialog_input.text_submitted.connect(func(t): _send_dialog(t))
	row.add_child(_dialog_input)
	var bye := Button.new()
	bye.text = "Уйти (Esc)"
	bye.pressed.connect(close_dialogue)
	row.add_child(bye)


func open_dialogue(npc_name: String, send: Callable, on_close: Callable) -> void:
	_dialog_send = send
	_dialog_close = on_close
	_dialog_log.clear()
	_dialog_log.append_text("[color=#9ab]Вы подошли к человеку по имени %s.[/color]\n" % npc_name)
	if Settings.get_v("ai_api_key") == "":
		_dialog_log.append_text("[color=#777](ИИ-диалоги выключены: укажите ключ API в Esc → Настройки → ИИ. Сейчас — простые ответы.)[/color]\n")
	_dialog.visible = true
	_set_ui(true)
	_dialog_input.grab_focus()


func _send_dialog(text: String) -> void:
	if text.strip_edges() == "":
		return
	_dialog_log.append_text("[b]Вы:[/b] %s\n" % text)
	_dialog_input.clear()
	_dialog_send.call(text)


func dialogue_reply(npc_name: String, reply: String) -> void:
	_dialog_log.append_text("[b][color=#fc9]%s:[/color][/b] %s\n" % [npc_name, reply])


func close_dialogue() -> void:
	if _dialog.visible:
		_dialog.visible = false
		_set_ui(false)
		if _dialog_close.is_valid():
			_dialog_close.call()


# ------------------------------------------------------------------ меню выбора

func _build_menu() -> void:
	_menu = PanelContainer.new()
	_menu.add_theme_stylebox_override("panel", _panel_style(0.9))
	_menu.set_anchors_preset(Control.PRESET_CENTER)
	_menu.position = Vector2(-240, -200)
	_menu.custom_minimum_size = Vector2(480, 0)
	_menu.visible = false
	_root.add_child(_menu)
	_menu_box = VBoxContainer.new()
	_menu.add_child(_menu_box)


func open_menu(title: String, options: Array) -> void:
	for c in _menu_box.get_children():
		c.queue_free()
	var t := _label(22)
	t.text = title
	_menu_box.add_child(t)
	var scroll := ScrollContainer.new()
	scroll.custom_minimum_size = Vector2(460, min(420, 44 * options.size() + 10))
	_menu_box.add_child(scroll)
	var list := VBoxContainer.new()
	list.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	scroll.add_child(list)
	for o in options:
		var b := Button.new()
		b.text = o[0]
		b.alignment = HORIZONTAL_ALIGNMENT_LEFT
		var cb: Callable = o[1]
		b.pressed.connect(func():
			close_menu()
			cb.call())
		list.add_child(b)
	var close := Button.new()
	close.text = "Закрыть (Esc)"
	close.pressed.connect(close_menu)
	_menu_box.add_child(close)
	_menu.visible = true
	_set_ui(true)


func close_menu() -> void:
	if _menu.visible:
		_menu.visible = false
		_set_ui(false)


func close_all() -> bool:
	var was := _menu.visible or _dialog.visible
	close_menu()
	close_dialogue()
	return was


func _set_ui(open: bool) -> void:
	ui_open = open
	player.controls_enabled = not open
	Input.mouse_mode = Input.MOUSE_MODE_VISIBLE if open else Input.MOUSE_MODE_CAPTURED


# ------------------------------------------------------------------ кадр

func update_hud(street: String, time_text: String, extra: String, delta: float) -> void:
	current_street = street
	current_time = time_text
	_hp_bar.value = player.health
	_info.text = "%s\n%s\n%s" % [street if street != "" else "Приморский район", time_text, extra]
	if player.vehicle:
		_speed.text = "%d км/ч" % int((player.vehicle as Vehicle).speed_kmh())
		_prompt.text = "[%s] Выйти из машины" % Settings.key_name(Settings.keys["interact"])
	else:
		_speed.text = ""
		var f: Node = player.focus
		_prompt.text = ("[%s] %s" % [Settings.key_name(Settings.keys["interact"]), f.get_prompt(player)]) if f and is_instance_valid(f) and not ui_open and f.get_prompt(player) != "" else ""
	if player.dead:
		_prompt.text = "Вы погибли. Нажмите Enter, чтобы очнуться в больнице."
	_toast_t -= delta
	_toast.visible = _toast_t > 0.0
	if _map_panel.visible:
		_map.queue_redraw()
