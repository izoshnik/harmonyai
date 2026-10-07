## Меню паузы (Esc): продолжить, настройки (Графика, Управление, Мини-карта, ИИ), выход.
class_name PauseMenu
extends CanvasLayer

var _panel: PanelContainer
var _main: VBoxContainer
var _tabs: TabContainer
var _waiting_action := ""
var _rebind_buttons := {}


func _ready() -> void:
	process_mode = Node.PROCESS_MODE_ALWAYS
	layer = 10
	var dim := ColorRect.new()
	dim.color = Color(0, 0, 0, 0.55)
	dim.set_anchors_preset(Control.PRESET_FULL_RECT)
	add_child(dim)
	_panel = PanelContainer.new()
	var sb := StyleBoxFlat.new()
	sb.bg_color = Color(0.07, 0.08, 0.1, 0.96)
	sb.set_corner_radius_all(12)
	sb.set_content_margin_all(18)
	_panel.add_theme_stylebox_override("panel", sb)
	_panel.set_anchors_preset(Control.PRESET_CENTER)
	_panel.custom_minimum_size = Vector2(760, 560)
	_panel.position = Vector2(-380, -280)
	add_child(_panel)
	var v := VBoxContainer.new()
	v.add_theme_constant_override("separation", 10)
	_panel.add_child(v)
	var title := Label.new()
	title.text = "Приморский 2026 — пауза"
	title.add_theme_font_size_override("font_size", 26)
	v.add_child(title)
	_main = VBoxContainer.new()
	v.add_child(_main)
	for item in [["Продолжить", _resume], ["Настройки", _show_settings], ["Выйти из игры", func(): get_tree().quit()]]:
		var b := Button.new()
		b.text = item[0]
		b.custom_minimum_size = Vector2(0, 44)
		b.pressed.connect(item[1])
		_main.add_child(b)
	_tabs = TabContainer.new()
	_tabs.visible = false
	_tabs.custom_minimum_size = Vector2(720, 430)
	v.add_child(_tabs)
	_build_graphics()
	_build_controls()
	_build_minimap()
	_build_ai()
	var back := Button.new()
	back.text = "Назад"
	back.pressed.connect(func():
		_tabs.visible = false
		_main.visible = true)
	_tabs.set_meta("back", back)
	v.add_child(back)
	visible = false


func toggle() -> void:
	if visible:
		_resume()
	else:
		visible = true
		_tabs.visible = false
		_main.visible = true
		get_tree().paused = true
		Input.mouse_mode = Input.MOUSE_MODE_VISIBLE


func _resume() -> void:
	visible = false
	get_tree().paused = false
	Input.mouse_mode = Input.MOUSE_MODE_CAPTURED


func _show_settings() -> void:
	_main.visible = false
	_tabs.visible = true


func _unhandled_input(event: InputEvent) -> void:
	if _waiting_action != "" and event is InputEventKey and event.pressed:
		Settings.rebind(_waiting_action, event.physical_keycode)
		_rebind_buttons[_waiting_action].text = Settings.key_name(event.physical_keycode)
		_waiting_action = ""
		get_viewport().set_input_as_handled()


# ------------------------------------------------------------------ помощники UI

func _page(name: String) -> VBoxContainer:
	var scroll := ScrollContainer.new()
	scroll.name = name
	_tabs.add_child(scroll)
	var v := VBoxContainer.new()
	v.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	v.add_theme_constant_override("separation", 8)
	scroll.add_child(v)
	return v


func _row(parent: Container, label: String, control: Control) -> void:
	var h := HBoxContainer.new()
	var l := Label.new()
	l.text = label
	l.custom_minimum_size = Vector2(300, 0)
	h.add_child(l)
	control.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	h.add_child(control)
	parent.add_child(h)


func _slider(parent: Container, label: String, key: String, lo: float, hi: float, step: float) -> void:
	var s := HSlider.new()
	s.min_value = lo
	s.max_value = hi
	s.step = step
	s.value = Settings.get_v(key)
	var val := Label.new()
	val.text = str(s.value)
	val.custom_minimum_size = Vector2(60, 0)
	s.value_changed.connect(func(x):
		val.text = str(x)
		Settings.set_value(key, x))
	var h := HBoxContainer.new()
	s.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	h.add_child(s)
	h.add_child(val)
	_row(parent, label, h)


func _check(parent: Container, label: String, key: String) -> void:
	var c := CheckBox.new()
	c.button_pressed = Settings.get_v(key)
	c.toggled.connect(func(x): Settings.set_value(key, x))
	_row(parent, label, c)


func _option(parent: Container, label: String, key: String, items: Array) -> void:
	var o := OptionButton.new()
	for it in items:
		o.add_item(it)
	o.selected = int(Settings.get_v(key))
	o.item_selected.connect(func(i): Settings.set_value(key, i))
	_row(parent, label, o)


# ------------------------------------------------------------------ вкладки

func _build_graphics() -> void:
	var p := _page("Графика")
	_option(p, "Качество", "quality", ["Низкое", "Среднее", "Высокое", "Ультра (глобальное освещение)"])
	_slider(p, "Масштаб рендера", "render_scale", 0.5, 1.0, 0.05)
	_check(p, "Апскейл FSR 2", "fsr")
	_option(p, "Тени", "shadows", ["Выкл", "Средние", "Высокие"])
	_slider(p, "Дальность прорисовки, м", "view_distance", 600, 3500, 100)
	_slider(p, "Плотность деревьев (после перезапуска)", "vegetation", 0.0, 1.0, 0.1)
	_slider(p, "Машин в потоке", "traffic", 0, 250, 10)
	_slider(p, "Пешеходов (после перезапуска)", "pedestrians", 0, 150, 10)
	_option(p, "Ограничение FPS", "fps_limit", ["Без ограничения", "30", "60", "120", "144"])
	_check(p, "Вертикальная синхронизация", "vsync")
	_check(p, "Полноэкранный режим", "fullscreen")


func _build_controls() -> void:
	var p := _page("Управление")
	_slider(p, "Чувствительность мыши", "mouse_sens", 0.2, 3.0, 0.1)
	_check(p, "Инвертировать ось Y", "invert_y")
	_slider(p, "Поле зрения (FOV)", "fov", 60, 100, 1)
	var hint := Label.new()
	hint.text = "Нажмите на клавишу, затем новую клавишу:"
	p.add_child(hint)
	for a in Settings.ACTIONS.keys():
		var b := Button.new()
		b.text = Settings.key_name(Settings.keys[a])
		var action: String = a
		b.pressed.connect(func():
			_waiting_action = action
			b.text = "…нажмите клавишу…")
		_rebind_buttons[a] = b
		_row(p, Settings.ACTIONS[a], b)
	var reset := Button.new()
	reset.text = "Сбросить клавиши"
	reset.pressed.connect(func():
		Settings.reset_keys()
		for a in _rebind_buttons:
			_rebind_buttons[a].text = Settings.key_name(Settings.keys[a]))
	p.add_child(reset)


func _build_minimap() -> void:
	var p := _page("Мини-карта")
	_check(p, "Показывать мини-карту", "minimap")
	_option(p, "Положение", "minimap_corner", ["Слева сверху", "Справа сверху", "Слева снизу", "Справа снизу"])
	_slider(p, "Размер, пикс.", "minimap_size", 140, 420, 10)
	_slider(p, "Масштаб", "minimap_zoom", 0.4, 3.0, 0.1)
	_check(p, "Вращать по направлению взгляда", "minimap_rotate")


func _build_ai() -> void:
	var p := _page("ИИ")
	var info := Label.new()
	info.autowrap_mode = TextServer.AUTOWRAP_WORD
	info.custom_minimum_size = Vector2(680, 0)
	info.text = "Живые диалоги с прохожими работают через Claude API (модель claude-opus-5-5). Ключ создаётся на console.anthropic.com → API Keys и хранится только на этом компьютере (user://settings.cfg). Без ключа NPC отвечают простыми заготовками. ИИ выбирает только реплику и намерение (пойти за вами, уйти, вызвать полицию); деньги, здоровье и вещи меняет игра, а не модель."
	p.add_child(info)
	var key := LineEdit.new()
	key.secret = true
	key.placeholder_text = "sk-ant-…"
	key.text = Settings.get_v("ai_api_key")
	key.text_changed.connect(func(t): Settings.set_value("ai_api_key", t.strip_edges()))
	_row(p, "Ключ Claude API", key)
	_check(p, "Включить ИИ-диалоги", "ai_enabled")
