## Управляемый автомобиль на физике VehicleBody3D: двигатель, тормоза, руль, ручник, подвеска.
## E — сесть/выйти; W/S — газ/тормоз-задний ход; A/D — руль; Пробел — ручник.
class_name Vehicle
extends VehicleBody3D

const SPECS := {
	"car_sedan": {"mass": 1350.0, "engine": 3200.0, "wheelbase": [0.95, 3.65], "track": 0.76, "r": 0.31, "len": 4.55, "w": 1.78, "h": 1.45},
	"car_hatch": {"mass": 1150.0, "engine": 2700.0, "wheelbase": [0.75, 3.3], "track": 0.74, "r": 0.30, "len": 4.05, "w": 1.73, "h": 1.5},
	"car_suv": {"mass": 1800.0, "engine": 4200.0, "wheelbase": [0.95, 3.7], "track": 0.8, "r": 0.36, "len": 4.6, "w": 1.86, "h": 1.72},
}

var kind := "car_sedan"
var paint := Color(0.6, 0.1, 0.1)
var driver: Player = null
var cam: Camera3D
var cam_yaw := 0.0
var interact_radius := 3.2
var health := 100.0
var _last_speed := 0.0


func setup(k: String, color: Color) -> void:
	kind = k
	paint = color
	var s: Dictionary = SPECS[k]
	mass = s["mass"]
	center_of_mass_mode = RigidBody3D.CENTER_OF_MASS_MODE_CUSTOM
	center_of_mass = Vector3(0, 0.45, 0)
	var L: float = s["len"]
	var visual: Node3D = load("res://assets/models/%s.glb" % k).instantiate()
	# модель: перёд в −Z, задок в начале координат → центрируем по длине
	visual.position = Vector3(0, 0, L * 0.5)
	add_child(visual)
	for mi in visual.find_children("*", "MeshInstance3D", true, false):
		for i in mi.mesh.get_surface_count():
			var m: Material = mi.mesh.surface_get_material(i)
			if m and m.resource_name == "Paint":
				var m2: StandardMaterial3D = (m as StandardMaterial3D).duplicate()
				m2.albedo_color = color
				mi.set_surface_override_material(i, m2)
			if mi.name.begins_with("Tyre") or mi.name.begins_with("Rim"):
				mi.visible = false  # колёса рисуют VehicleWheel3D
	var col := CollisionShape3D.new()
	var box := BoxShape3D.new()
	box.size = Vector3(s["w"], s["h"] - 0.35, L)
	col.shape = box
	col.position.y = 0.35 + (s["h"] - 0.35) * 0.5
	add_child(col)
	var r: float = s["r"]
	var wb: Array = s["wheelbase"]
	for y in wb:
		for side in [-1.0, 1.0]:
			var w := VehicleWheel3D.new()
			w.position = Vector3(side * float(s["w"]) * 0.5 - side * 0.13, r + 0.05, L * 0.5 - float(y))
			w.wheel_radius = r
			w.wheel_rest_length = 0.12
			w.suspension_travel = 0.15
			w.suspension_stiffness = 45.0
			w.damping_compression = 0.9
			w.damping_relaxation = 1.2
			w.wheel_friction_slip = 2.6
			w.wheel_roll_influence = 0.15
			var front := float(y) > L * 0.5
			w.use_as_steering = front
			w.use_as_traction = not front if k != "car_suv" else true
			w.add_child(_wheel_mesh(r))
			add_child(w)
	cam = Camera3D.new()
	cam.far = 6000.0
	add_child(cam)
	cam.top_level = true
	add_to_group("interactable")
	add_to_group("vehicles")
	contact_monitor = true
	max_contacts_reported = 4
	body_entered.connect(_on_hit)


func _wheel_mesh(r: float) -> Node3D:
	var root := Node3D.new()
	var tyre := MeshInstance3D.new()
	var tm := CylinderMesh.new()
	tm.top_radius = r
	tm.bottom_radius = r
	tm.height = 0.21
	tm.radial_segments = 24
	var tmat := StandardMaterial3D.new()
	tmat.albedo_color = Color(0.03, 0.03, 0.03)
	tmat.roughness = 0.9
	tm.material = tmat
	tyre.mesh = tm
	tyre.rotation.z = PI / 2
	root.add_child(tyre)
	var rim := MeshInstance3D.new()
	var rmm := CylinderMesh.new()
	rmm.top_radius = r * 0.62
	rmm.bottom_radius = r * 0.62
	rmm.height = 0.23
	rmm.radial_segments = 16
	var rmat := StandardMaterial3D.new()
	rmat.albedo_color = Color(0.6, 0.62, 0.64)
	rmat.metallic = 1.0
	rmat.roughness = 0.3
	rmm.material = rmat
	rim.mesh = rmm
	rim.rotation.z = PI / 2
	root.add_child(rim)
	return root


func get_prompt(_p: Player) -> String:
	return "Сесть в машину"


func interact(p: Player) -> void:
	if driver:
		return
	driver = p
	p.vehicle = self
	p.visible = false
	p.process_mode = Node.PROCESS_MODE_DISABLED
	p.global_position = global_position + Vector3(0, -50, 0)  # убираем капсулу из сцены
	cam.current = true
	cam_yaw = rotation.y


func exit_vehicle() -> void:
	if driver == null:
		return
	var p := driver
	driver = null
	engine_force = 0
	brake = 30.0
	var side := global_transform.basis.x * -1.6
	p.global_position = global_position + side + Vector3(0, 0.3, 0)
	p.velocity = Vector3.ZERO
	p.process_mode = Node.PROCESS_MODE_INHERIT
	p.visible = true
	p.vehicle = null
	p.camera.current = true


func _unhandled_input(event: InputEvent) -> void:
	if driver and event.is_action_pressed("interact"):
		exit_vehicle()
		get_viewport().set_input_as_handled()


func _physics_process(delta: float) -> void:
	var speed := linear_velocity.length()
	if driver:
		var throttle := Input.get_action_strength("move_forward")
		var reverse := Input.get_action_strength("move_back")
		var steer_in := Input.get_action_strength("move_left") - Input.get_action_strength("move_right")
		var fwd_speed := linear_velocity.dot(-global_transform.basis.z)
		var s: Dictionary = SPECS[kind]
		if reverse > 0.0 and fwd_speed > 1.0:
			engine_force = 0.0
			brake = 25.0 * reverse
		else:
			brake = 0.0
			engine_force = (throttle - reverse * 0.6) * float(s["engine"]) * (1.0 if speed < 45.0 else 0.2)
		# ось колёс смотрит вперёд по −Z, поэтому знак силы — минус
		engine_force = -engine_force
		var max_steer: float = lerp(0.6, 0.12, clamp(speed / 30.0, 0.0, 1.0))
		steering = move_toward(steering, steer_in * max_steer, 2.5 * delta)
		if Input.is_action_pressed("jump"):
			brake = 60.0
		_update_camera(delta)
		driver.global_position = global_position + Vector3(0, -50, 0)
	else:
		engine_force = 0.0
		brake = 8.0
	# урон от резкого торможения о препятствие
	if _last_speed - speed > 9.0:
		health -= (_last_speed - speed) * 2.0
		if driver:
			driver.take_damage((_last_speed - speed - 9.0) * 4.0, self)
	_last_speed = speed


func _update_camera(delta: float) -> void:
	cam_yaw = lerp_angle(cam_yaw, rotation.y, min(1.0, 3.0 * delta))
	var back := Basis(Vector3.UP, cam_yaw) * Vector3(0, 0, 1)
	var target := global_position + back * 7.0 + Vector3.UP * 2.6
	cam.global_position = cam.global_position.lerp(target, min(1.0, 8.0 * delta))
	cam.look_at(global_position + Vector3.UP * 1.0)


func _on_hit(body: Node) -> void:
	if body is Humanoid and linear_velocity.length() > 4.0:
		var h: Humanoid = body
		h.take_damage(linear_velocity.length() * 5.0, self)
		h.velocity += linear_velocity * 0.6 + Vector3.UP * 3.0


func speed_kmh() -> float:
	return linear_velocity.length() * 3.6
