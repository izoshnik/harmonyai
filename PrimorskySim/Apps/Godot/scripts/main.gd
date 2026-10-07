## Точка входа: загрузка данных района, окружение (небо, солнце, GI, туман), город, игрок, трафик,
## смена дня и ночи, HUD и настройки качества графики.
extends Node3D

const SPAWN_STATION := "Комендантский проспект"
const TIME_SCALES := [1.0, 60.0, 600.0]

var data: Dictionary
var city: City
var player: Player
var traffic: Traffic
var env: Environment
var sun: DirectionalLight3D
var moon: DirectionalLight3D
var hud: Label
var help: Label
var loading: Label
var lamp_lights: Array[OmniLight3D] = []

var world_seconds := 13.0 * 3600.0
var time_scale_idx := 1
var quality := 2  # 0 низкое, 1 среднее, 2 высокое
var _hud_timer := 0.0


func _ready() -> void:
	_make_ui()
	await _status("Загрузка данных района…")
	var f := FileAccess.open("res://data/district.json", FileAccess.READ)
	if f == null:
		loading.text = "Не найден data/district.json"
		return
	data = JSON.parse_string(f.get_as_text())
	_make_environment()
	city = City.new()
	city.name = "City"
	add_child(city)
	city.build(data, func(msg): loading.text = msg)
	await _status("Персонаж и транспорт…")
	_spawn_player()
	traffic = Traffic.new()
	traffic.name = "Traffic"
	add_child(traffic)
	traffic.build(data, player)
	_make_lamp_lights()
	_apply_quality()
	loading.visible = false
	help.visible = true
	get_tree().create_timer(12.0).timeout.connect(func(): help.visible = false)
	for arg in OS.get_cmdline_user_args():
		if arg.begins_with("--shots="):
			_take_shots(arg.substr(8))


## Тестовый режим: `-- --shots=/path/prefix` — серия скриншотов с разных точек и выход.
func _take_shots(prefix: String) -> void:
	help.visible = false
	var views := [
		["street", 13.0, Vector3(0, 0, 0), false, 0.0],
		["fly", 13.0, Vector3(0, 120, 0), true, -0.45],
		["evening", 18.6, Vector3(0, 0, 0), false, 0.05],
		["night", 22.0, Vector3(0, 60, 0), true, -0.3],
	]
	var base := player.global_position
	for v in views:
		world_seconds = v[1] * 3600.0
		player.set_flying(v[3])
		player.global_position = base + v[2]
		player.head.rotation.x = v[4]
		_hud_timer = 0.0
		for i in 90:
			await get_tree().process_frame
		var img := get_viewport().get_texture().get_image()
		img.save_png("%s_%s.png" % [prefix, v[0]])
	get_tree().quit()


func _status(msg: String) -> void:
	loading.text = msg
	await get_tree().process_frame
	await get_tree().process_frame


# ------------------------------------------------------------------ окружение

func _make_environment() -> void:
	var sky_mat := PhysicalSkyMaterial.new()
	sky_mat.rayleigh_coefficient = 2.0
	sky_mat.mie_coefficient = 0.004
	sky_mat.turbidity = 4.0
	sky_mat.sun_disk_scale = 1.2
	sky_mat.ground_color = Color(0.25, 0.27, 0.25)
	sky_mat.energy_multiplier = 1.0
	var sky := Sky.new()
	sky.sky_material = sky_mat
	env = Environment.new()
	env.background_mode = Environment.BG_SKY
	env.sky = sky
	env.ambient_light_source = Environment.AMBIENT_SOURCE_SKY
	env.reflected_light_source = Environment.REFLECTION_SOURCE_SKY
	env.tonemap_mode = Environment.TONE_MAPPER_AGX
	env.tonemap_exposure = 1.25
	env.ambient_light_sky_contribution = 1.0
	env.ssao_enabled = true
	env.ssao_radius = 1.5
	env.ssao_intensity = 2.0
	env.ssil_enabled = false
	env.glow_enabled = true
	env.glow_intensity = 0.6
	env.glow_bloom = 0.05
	env.fog_enabled = true
	env.fog_mode = Environment.FOG_MODE_DEPTH
	env.fog_light_color = Color(0.68, 0.75, 0.85)
	env.fog_density = 0.00025
	env.fog_aerial_perspective = 0.7
	env.fog_sky_affect = 0.15
	env.adjustment_enabled = true
	env.adjustment_saturation = 1.05
	var we := WorldEnvironment.new()
	we.environment = env
	add_child(we)

	sun = DirectionalLight3D.new()
	sun.shadow_enabled = true
	sun.directional_shadow_mode = DirectionalLight3D.SHADOW_PARALLEL_4_SPLITS
	sun.directional_shadow_max_distance = 600.0
	sun.light_angular_distance = 0.5
	sun.light_energy = 1.2
	add_child(sun)
	moon = DirectionalLight3D.new()
	moon.light_color = Color(0.6, 0.7, 1.0)
	moon.light_energy = 0.0
	moon.sky_mode = DirectionalLight3D.SKY_MODE_LIGHT_ONLY
	add_child(moon)


func _update_daylight() -> void:
	var hour := fmod(world_seconds / 3600.0, 24.0)
	# Петербург, начало октября: восход ~7:30, закат ~18:20 (МСК), высота солнца в полдень ~27°
	var t: float = (hour - 7.5) / (18.3 - 7.5)
	var elev: float = sin(PI * clamp(t, 0.0, 1.0)) * deg_to_rad(28.0) if t > 0.0 and t < 1.0 else deg_to_rad(-12.0) * sin(PI * clamp(abs(t - 0.5) - 0.5, 0.0, 0.5) * 2.0) - 0.02
	var az: float = lerp(deg_to_rad(100.0), deg_to_rad(260.0), clamp(t, 0.0, 1.0))
	sun.rotation = Vector3(-elev, -az + PI, 0.0)
	var day: float = clamp(elev / deg_to_rad(8.0), 0.0, 1.0)
	sun.light_energy = 1.4 * day
	sun.visible = day > 0.001
	moon.light_energy = 0.12 * (1.0 - day)
	moon.rotation = Vector3(deg_to_rad(-35.0), deg_to_rad(40.0), 0.0)
	var night: float = 1.0 - clamp((elev + deg_to_rad(4.0)) / deg_to_rad(8.0), 0.0, 1.0)
	RenderingServer.global_shader_parameter_set("night", night)
	env.ambient_light_energy = lerp(1.6, 0.4, night)
	env.background_energy_multiplier = lerp(1.0, 0.25, night)
	env.fog_light_color = Color(0.68, 0.75, 0.85).lerp(Color(0.05, 0.07, 0.12), night)
	for l in lamp_lights:
		l.visible = night > 0.3


# ------------------------------------------------------------------ игрок, фонари

func _spawn_player() -> void:
	player = Player.new()
	player.name = "Player"
	add_child(player)
	var pos := Vector3.ZERO
	for st in city.stations:
		if st["name"] == SPAWN_STATION:
			pos = st["pos"] + Vector3(18, 0, 12)
	player.global_position = pos + Vector3(0, 1.0, 0)
	player.rotation.y = deg_to_rad(-120)
	player.camera.current = true


func _make_lamp_lights() -> void:
	# Реальные источники света — только у ближайших к игроку фонарей (пул), остальные светятся эмиссией.
	for i in 24:
		var l := OmniLight3D.new()
		l.light_color = Color(1.0, 0.82, 0.6)
		l.light_energy = 2.5
		l.omni_range = 18.0
		l.shadow_enabled = false
		l.visible = false
		add_child(l)
		lamp_lights.append(l)


func _update_lamp_pool() -> void:
	if city.lamp_points.is_empty():
		return
	var p := player.global_position
	var near := city.lamp_points.filter(func(q): return abs(q.x - p.x) < 120.0 and abs(q.z - p.z) < 120.0)
	near.sort_custom(func(a, b): return a.distance_squared_to(p) < b.distance_squared_to(p))
	for i in lamp_lights.size():
		if i < near.size():
			lamp_lights[i].global_position = near[i]
		else:
			lamp_lights[i].global_position = Vector3(0, -100, 0)


# ------------------------------------------------------------------ качество графики

func _apply_quality() -> void:
	var vp := get_viewport()
	match quality:
		0:
			env.sdfgi_enabled = false
			env.ssao_enabled = false
			sun.directional_shadow_max_distance = 200.0
			vp.scaling_3d_mode = Viewport.SCALING_3D_MODE_FSR2
			vp.scaling_3d_scale = 0.67
		1:
			env.sdfgi_enabled = false
			env.ssao_enabled = true
			sun.directional_shadow_max_distance = 400.0
			vp.scaling_3d_mode = Viewport.SCALING_3D_MODE_FSR2
			vp.scaling_3d_scale = 0.8
		2:
			env.sdfgi_enabled = true
			env.sdfgi_cascades = 6
			env.sdfgi_min_cell_size = 0.4
			env.sdfgi_use_occlusion = true
			env.ssao_enabled = true
			sun.directional_shadow_max_distance = 700.0
			vp.scaling_3d_mode = Viewport.SCALING_3D_MODE_BILINEAR
			vp.scaling_3d_scale = 1.0


# ------------------------------------------------------------------ UI

func _make_ui() -> void:
	var layer := CanvasLayer.new()
	add_child(layer)
	hud = Label.new()
	hud.position = Vector2(24, 20)
	hud.add_theme_font_size_override("font_size", 20)
	hud.add_theme_color_override("font_shadow_color", Color(0, 0, 0, 0.8))
	hud.add_theme_constant_override("shadow_offset_x", 1)
	hud.add_theme_constant_override("shadow_offset_y", 1)
	layer.add_child(hud)
	help = Label.new()
	help.visible = false
	help.position = Vector2(24, 140)
	help.add_theme_font_size_override("font_size", 16)
	help.add_theme_color_override("font_shadow_color", Color(0, 0, 0, 0.8))
	help.text = "WASD — идти · мышь — смотреть · Shift — бег · Пробел — прыжок · F — полёт (E/Q вверх/вниз)\nT — скорость времени · 1/2/3 — качество графики · H — здания с условной высотой · Esc — курсор · F11 — окно"
	layer.add_child(help)
	loading = Label.new()
	loading.set_anchors_preset(Control.PRESET_CENTER)
	loading.add_theme_font_size_override("font_size", 28)
	layer.add_child(loading)


func _unhandled_input(event: InputEvent) -> void:
	if not (event is InputEventKey and event.pressed and not event.echo):
		return
	match event.physical_keycode:
		KEY_T:
			time_scale_idx = (time_scale_idx + 1) % TIME_SCALES.size()
		KEY_1, KEY_2, KEY_3:
			quality = event.physical_keycode - KEY_1
			_apply_quality()
		KEY_H:
			if city:
				city.unknown_markers.visible = not city.unknown_markers.visible
		KEY_F11:
			var full := DisplayServer.window_get_mode() == DisplayServer.WINDOW_MODE_EXCLUSIVE_FULLSCREEN
			DisplayServer.window_set_mode(DisplayServer.WINDOW_MODE_WINDOWED if full else DisplayServer.WINDOW_MODE_EXCLUSIVE_FULLSCREEN)
		KEY_F1:
			help.visible = not help.visible


func _process(delta: float) -> void:
	if player == null:
		return
	world_seconds = fmod(world_seconds + delta * TIME_SCALES[time_scale_idx], 86400.0)
	_hud_timer -= delta
	if _hud_timer > 0.0:
		return
	_hud_timer = 0.25
	_update_daylight()
	_update_lamp_pool()
	var p := player.global_position
	var street := city.street_at(p.x, -p.z)
	var nearest := ""
	var best := INF
	for st in city.stations:
		var d: float = st["pos"].distance_to(Vector3(p.x, 0, p.z))
		if d < best:
			best = d
			nearest = st["name"]
	var hh := int(world_seconds / 3600.0)
	var mm := int(fmod(world_seconds / 60.0, 60.0))
	hud.text = "%s\n%02d:%02d МСК  ×%d   %s   %d км/ч   %d FPS\nМ %s — %s" % [
		street if street != "" else "Приморский район", hh, mm, int(TIME_SCALES[time_scale_idx]),
		"полёт %d м" % int(p.y) if player.flying else "пешком", int(player.ground_speed_kmh()),
		Engine.get_frames_per_second(), nearest, ("%d м" % int(best)) if best < 1000.0 else ("%.1f км" % (best / 1000.0))]
