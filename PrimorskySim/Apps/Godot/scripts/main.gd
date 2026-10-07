## Точка входа: данные района, окружение (небо, солнце, туман), город, игрок, NPC, трафик, места,
## HUD, меню паузы, настройки графики, день и ночь.
extends Node3D

const SPAWN_STATION := "Комендантский проспект"
const TIME_SCALES := [1.0, 10.0, 60.0]
const FPS_LIMITS := [0, 30, 60, 120, 144]

var data: Dictionary
var city: City
var player: Player
var traffic: Traffic
var peds: Pedestrians
var places: Places
var hud: HUD
var menu: PauseMenu
var env: Environment
var sun: DirectionalLight3D
var moon: DirectionalLight3D
var loading: Label
var lamp_lights: Array[OmniLight3D] = []

var world_seconds := 12.5 * 3600.0
var time_scale_idx := 1
var _hud_timer := 0.0
var _spawn_pos := Vector3.ZERO


func _ready() -> void:
	var layer := CanvasLayer.new()
	add_child(layer)
	loading = Label.new()
	loading.set_anchors_preset(Control.PRESET_CENTER)
	loading.add_theme_font_size_override("font_size", 28)
	layer.add_child(loading)
	await _status("Загрузка данных района…")
	data = JSON.parse_string(FileAccess.get_file_as_string("res://data/district.json"))
	_make_environment()
	city = City.new()
	city.name = "City"
	add_child(city)
	city.build(data, func(msg): loading.text = msg)
	await _status("Жители и транспорт…")
	_spawn_player()
	hud = HUD.new()
	add_child(hud)
	hud.build(data, player, city.stations)
	traffic = Traffic.new()
	add_child(traffic)
	traffic.build(data, player)
	peds = Pedestrians.new()
	add_child(peds)
	peds.build(data, player, hud, int(Settings.get_v("pedestrians")))
	places = Places.new()
	add_child(places)
	places.build(data, player, hud, city.stations)
	_spawn_parked_cars()
	_spawn_props()
	_make_lamp_lights()
	menu = PauseMenu.new()
	add_child(menu)
	Settings.changed.connect(_apply_settings)
	_apply_settings()
	layer.queue_free()
	hud.toast("WASD — идти · Shift — бег · E — взаимодействие · F/ЛКМ — удар · V — вид · Esc — меню")
	player.died.connect(_on_player_died)
	for arg in OS.get_cmdline_user_args():
		if arg.begins_with("--shots="):
			_take_shots(arg.substr(8))


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
	var sky := Sky.new()
	sky.sky_material = sky_mat
	sky.radiance_size = Sky.RADIANCE_SIZE_128
	sky.process_mode = Sky.PROCESS_MODE_INCREMENTAL
	env = Environment.new()
	env.background_mode = Environment.BG_SKY
	env.sky = sky
	env.ambient_light_source = Environment.AMBIENT_SOURCE_SKY
	env.reflected_light_source = Environment.REFLECTION_SOURCE_SKY
	env.tonemap_mode = Environment.TONE_MAPPER_AGX
	env.tonemap_exposure = 1.2
	env.ssao_radius = 1.2
	env.ssao_intensity = 1.6
	env.glow_enabled = true
	env.glow_intensity = 0.5
	env.glow_bloom = 0.04
	env.fog_enabled = true
	env.fog_light_color = Color(0.68, 0.75, 0.85)
	env.fog_density = 0.0004
	env.fog_aerial_perspective = 0.6
	env.fog_sky_affect = 0.15
	env.adjustment_enabled = true
	env.adjustment_saturation = 1.08
	env.adjustment_contrast = 1.05
	var we := WorldEnvironment.new()
	we.environment = env
	add_child(we)
	sun = DirectionalLight3D.new()
	sun.shadow_enabled = true
	sun.light_angular_distance = 0.5
	add_child(sun)
	moon = DirectionalLight3D.new()
	moon.light_color = Color(0.6, 0.7, 1.0)
	moon.sky_mode = DirectionalLight3D.SKY_MODE_LIGHT_ONLY
	add_child(moon)


func _apply_settings() -> void:
	var q: int = Settings.get_v("quality")
	var vp := get_viewport()
	env.sdfgi_enabled = q >= 3
	if q >= 3:
		env.sdfgi_cascades = 4
		env.sdfgi_use_occlusion = true
	env.ssao_enabled = q >= 1
	env.ssil_enabled = q >= 2
	env.ssr_enabled = q >= 2
	env.glow_enabled = q >= 1
	var sh: int = Settings.get_v("shadows")
	sun.shadow_enabled = sh > 0
	sun.directional_shadow_mode = DirectionalLight3D.SHADOW_PARALLEL_2_SPLITS if sh == 1 else DirectionalLight3D.SHADOW_PARALLEL_4_SPLITS
	sun.directional_shadow_max_distance = 140.0 if sh == 1 else 320.0
	RenderingServer.directional_shadow_atlas_set_size(2048 if sh == 1 else 4096, true)
	vp.scaling_3d_mode = Viewport.SCALING_3D_MODE_FSR2 if Settings.get_v("fsr") else Viewport.SCALING_3D_MODE_BILINEAR
	vp.scaling_3d_scale = Settings.get_v("render_scale")
	vp.msaa_3d = Viewport.MSAA_DISABLED
	vp.use_taa = not Settings.get_v("fsr") and q >= 2
	vp.screen_space_aa = Viewport.SCREEN_SPACE_AA_FXAA if q >= 1 else Viewport.SCREEN_SPACE_AA_DISABLED
	city.set_view_distance(Settings.get_v("view_distance"))
	env.fog_density = 0.0009 * 1800.0 / float(Settings.get_v("view_distance"))
	traffic.set_count(int(Settings.get_v("traffic")))
	Engine.max_fps = FPS_LIMITS[int(Settings.get_v("fps_limit"))]
	DisplayServer.window_set_vsync_mode(DisplayServer.VSYNC_ENABLED if Settings.get_v("vsync") else DisplayServer.VSYNC_DISABLED)
	var want_full: bool = Settings.get_v("fullscreen")
	var is_full := DisplayServer.window_get_mode() in [DisplayServer.WINDOW_MODE_FULLSCREEN, DisplayServer.WINDOW_MODE_EXCLUSIVE_FULLSCREEN]
	if want_full != is_full:
		DisplayServer.window_set_mode(DisplayServer.WINDOW_MODE_FULLSCREEN if want_full else DisplayServer.WINDOW_MODE_WINDOWED)


func _update_daylight() -> void:
	var hour := fmod(world_seconds / 3600.0, 24.0)
	# Петербург, начало октября: восход ~7:30, закат ~18:20 (МСК), высота солнца в полдень ~27°
	var t: float = (hour - 7.5) / (18.3 - 7.5)
	var elev: float = sin(PI * clamp(t, 0.0, 1.0)) * deg_to_rad(28.0) if t > 0.0 and t < 1.0 else -0.15
	var az: float = lerp(deg_to_rad(100.0), deg_to_rad(260.0), clamp(t, 0.0, 1.0))
	sun.rotation = Vector3(-max(elev, 0.02), -az + PI, 0.0)
	var day: float = clamp(elev / deg_to_rad(8.0), 0.0, 1.0)
	sun.light_energy = 1.4 * day
	sun.visible = day > 0.001
	moon.light_energy = 0.15 * (1.0 - day)
	moon.rotation = Vector3(deg_to_rad(-35.0), deg_to_rad(40.0), 0.0)
	var night: float = 1.0 - clamp((elev + deg_to_rad(4.0)) / deg_to_rad(8.0), 0.0, 1.0)
	RenderingServer.global_shader_parameter_set("night", night)
	env.ambient_light_energy = lerp(1.5, 0.45, night)
	env.background_energy_multiplier = lerp(1.0, 0.25, night)
	env.fog_light_color = Color(0.68, 0.75, 0.85).lerp(Color(0.05, 0.07, 0.12), night)
	for l in lamp_lights:
		l.visible = night > 0.3


# ------------------------------------------------------------------ мир

func _spawn_player() -> void:
	player = Player.new()
	player.name = "Player"
	add_child(player)
	for st in city.stations:
		if st["name"] == SPAWN_STATION:
			_spawn_pos = st["pos"] + Vector3(18, 0.5, 12)
	player.global_position = _spawn_pos
	player.camera.current = true
	Input.mouse_mode = Input.MOUSE_MODE_CAPTURED


func _spawn_parked_cars() -> void:
	# Несколько машин у точки старта, в которые можно сесть
	var kinds := ["car_sedan", "car_hatch", "car_suv", "car_sedan"]
	var colors := [Color(0.08, 0.08, 0.09), Color(0.75, 0.75, 0.78), Color(0.45, 0.06, 0.06), Color(0.1, 0.2, 0.38)]
	var spots := traffic.parking_spots_near(_spawn_pos, 4)
	for i in spots.size():
		var v := Vehicle.new()
		v.setup(kinds[i % kinds.size()], colors[i % colors.size()])
		add_child(v)
		v.global_transform = spots[i]


func _spawn_props() -> void:
	# Физические предметы у точки старта: урны и коробки — их можно толкать и сбивать
	var rng := RandomNumberGenerator.new()
	rng.seed = 5
	var bin_mat := StandardMaterial3D.new()
	bin_mat.albedo_color = Color(0.2, 0.3, 0.22)
	bin_mat.metallic = 0.5
	bin_mat.roughness = 0.5
	var box_mat := StandardMaterial3D.new()
	box_mat.albedo_color = Color(0.62, 0.48, 0.3)
	box_mat.roughness = 0.9
	for i in 24:
		var rb := RigidBody3D.new()
		var bin := i % 3 != 0
		var mi := MeshInstance3D.new()
		var col := CollisionShape3D.new()
		if bin:
			var cm := CylinderMesh.new()
			cm.top_radius = 0.28
			cm.bottom_radius = 0.24
			cm.height = 0.85
			cm.material = bin_mat
			mi.mesh = cm
			var cs := CylinderShape3D.new()
			cs.radius = 0.28
			cs.height = 0.85
			col.shape = cs
			rb.mass = 15.0
		else:
			var bm := BoxMesh.new()
			bm.size = Vector3(0.6, 0.45, 0.45)
			bm.material = box_mat
			mi.mesh = bm
			var bs := BoxShape3D.new()
			bs.size = bm.size
			col.shape = bs
			rb.mass = 4.0
		rb.add_child(mi)
		rb.add_child(col)
		rb.add_to_group("punchable")
		add_child(rb)
		rb.global_position = _spawn_pos + Vector3(rng.randf_range(-25, 25), 0.6, rng.randf_range(-25, 25))


func _make_lamp_lights() -> void:
	for i in 12:
		var l := OmniLight3D.new()
		l.light_color = Color(1.0, 0.82, 0.6)
		l.light_energy = 3.0
		l.omni_range = 20.0
		l.visible = false
		add_child(l)
		lamp_lights.append(l)


func _update_lamp_pool(p: Vector3) -> void:
	var near := city.lamp_points.filter(func(q): return abs(q.x - p.x) < 90.0 and abs(q.z - p.z) < 90.0)
	near.sort_custom(func(a, b): return a.distance_squared_to(p) < b.distance_squared_to(p))
	for i in lamp_lights.size():
		lamp_lights[i].global_position = near[i] if i < near.size() else Vector3(0, -100, 0)


func _on_player_died() -> void:
	hud.toast("Вы погибли")


func _unhandled_input(event: InputEvent) -> void:
	if event is InputEventKey and event.pressed and not event.echo:
		if event.physical_keycode == KEY_ESCAPE:
			if hud and hud.close_all():
				return
			menu.toggle()
		elif event.physical_keycode == KEY_ENTER and player and player.dead:
			_respawn()
		elif event.is_action_pressed("phone_time"):
			time_scale_idx = (time_scale_idx + 1) % TIME_SCALES.size()
			hud.toast("Скорость времени ×%d" % int(TIME_SCALES[time_scale_idx]))


func _respawn() -> void:
	# Больница: ближайшая к станции точка старта (реальных больниц в данных пока нет — условно)
	hud.fade(func():
		player.dead = false
		player.health = player.max_health
		player.current_anim = ""
		player.global_position = _spawn_pos
		player.add_money(-min(player.money, 150000), "Лечение"))


func _process(delta: float) -> void:
	if player == null or hud == null:
		return
	world_seconds = fmod(world_seconds + delta * TIME_SCALES[time_scale_idx], 86400.0)
	_hud_timer -= delta
	var p := player.global_position if player.vehicle == null else (player.vehicle as Node3D).global_position
	if _hud_timer <= 0.0:
		_hud_timer = 0.25
		_update_daylight()
		_update_lamp_pool(p)
		hud.current_street = city.street_at(p.x, -p.z)
	var hh := int(world_seconds / 3600.0)
	var mm := int(fmod(world_seconds / 60.0, 60.0))
	var extra := "%d FPS" % Engine.get_frames_per_second()
	if peds.wanted >= 1.0:
		extra = "Розыск: " + "★".repeat(int(ceil(peds.wanted))) + "   " + extra
	hud.update_hud(hud.current_street, "%02d:%02d МСК ×%d" % [hh, mm, int(TIME_SCALES[time_scale_idx])], extra, delta)


## Тестовый режим: `-- --shots=/path/prefix` — снимки с нескольких ракурсов и выход.
func _take_shots(prefix: String) -> void:
	var views := [["street", 13.0], ["evening", 18.7], ["talk", 13.2]]
	for v in views:
		if v[0] == "talk":
			var near: NPC = null
			for n in peds.npcs:
				if near == null or n.global_position.distance_to(player.global_position) < near.global_position.distance_to(player.global_position):
					near = n
			player.global_position = near.global_position + Vector3(1.5, 0.2, 1.5)
			player._yaw = atan2(-(near.global_position.x - player.global_position.x), -(near.global_position.z - player.global_position.z))
			near.interact(player)
			peds._say(near, "Здравствуйте! Как пройти к метро?")
		world_seconds = v[1] * 3600.0
		player._pitch = -0.1
		_hud_timer = 0.0
		for i in 80:
			await get_tree().process_frame
		get_viewport().get_texture().get_image().save_png("%s_%s.png" % [prefix, v[0]])
	get_tree().quit()
