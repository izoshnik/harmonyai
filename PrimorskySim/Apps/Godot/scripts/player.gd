## Игрок: человек с видом от третьего лица (V — от первого), бег, прыжок, удар, деньги,
## взаимодействие (E) с ближайшим объектом группы "interactable", вождение машин.
class_name Player
extends Humanoid

signal money_changed
signal notify(text: String)

const WALK := 1.7
const JOG := 3.6
const RUN := 6.2
const JUMP := 4.4

var money := 5000 * 100  # копейки; стартовые деньги
var bank := 30000 * 100
var camera: Camera3D
var arm: SpringArm3D
var pivot: Node3D
var first_person := false
var walk_mode := false
var vehicle: Node = null  # Vehicle, в котором сидим
var focus: Node = null    # текущая цель взаимодействия
var controls_enabled := true
var _yaw := 0.0
var _pitch := -0.15
var _attack_cd := 0.0


func _ready() -> void:
	setup_body(Color(0.22, 0.32, 0.45))
	pivot = Node3D.new()
	pivot.position.y = 1.55
	add_child(pivot)
	arm = SpringArm3D.new()
	arm.spring_length = 3.4
	arm.margin = 0.2
	arm.position = Vector3(0.45, 0.1, 0)
	arm.add_excluded_object(get_rid())
	pivot.add_child(arm)
	camera = Camera3D.new()
	camera.near = 0.1
	camera.far = 6000.0
	arm.add_child(camera)
	add_to_group("player")
	_apply_settings()
	Settings.changed.connect(_apply_settings)


func _apply_settings() -> void:
	camera.fov = Settings.get_v("fov")
	camera.far = Settings.get_v("view_distance") + 500.0


func _unhandled_input(event: InputEvent) -> void:
	if not controls_enabled:
		return
	if event is InputEventMouseButton and event.pressed and Input.mouse_mode != Input.MOUSE_MODE_CAPTURED:
		Input.mouse_mode = Input.MOUSE_MODE_CAPTURED
		return
	if event is InputEventMouseMotion and Input.mouse_mode == Input.MOUSE_MODE_CAPTURED:
		var s: float = 0.0022 * Settings.get_v("mouse_sens")
		_yaw -= event.relative.x * s
		_pitch -= event.relative.y * s * (-1.0 if Settings.get_v("invert_y") else 1.0)
		_pitch = clamp(_pitch, -1.35, 1.1)
	if event.is_action_pressed("camera_toggle"):
		first_person = not first_person
	if event.is_action_pressed("walk_toggle"):
		walk_mode = not walk_mode
	if event.is_action_pressed("interact"):
		if vehicle:
			vehicle.exit_vehicle()
		elif focus and is_instance_valid(focus):
			focus.interact(self)
	if (event.is_action_pressed("attack") or event.is_action_pressed("attack_mouse")) and vehicle == null and _attack_cd <= 0.0:
		_attack_cd = 0.6
		punch_target(focus as Node3D if focus is Node3D else _nearest_body())


func _nearest_body() -> Node3D:
	var best: Node3D = null
	var bd := 1.8
	for n in get_tree().get_nodes_in_group("punchable"):
		var d: float = (n as Node3D).global_position.distance_to(global_position)
		if d < bd and n != self:
			bd = d
			best = n
	return best


func _physics_process(delta: float) -> void:
	_attack_cd -= delta
	pivot.rotation = Vector3(_pitch, _yaw - rotation.y, 0)
	if first_person:
		arm.spring_length = 0.0
		arm.position = Vector3(0, 0.12, -0.15)
		model.visible = false
	else:
		arm.spring_length = 3.4
		arm.position = Vector3(0.45, 0.1, 0)
		model.visible = vehicle == null
	if vehicle != null or dead:
		return
	var input := Input.get_vector("move_left", "move_right", "move_forward", "move_back") if controls_enabled else Vector2.ZERO
	var speed := RUN if Input.is_action_pressed("sprint") and controls_enabled else (WALK if walk_mode else JOG)
	var basis_yaw := Basis(Vector3.UP, _yaw)
	var wish := basis_yaw * Vector3(input.x, 0, input.y)
	wish = wish.normalized() * speed * min(input.length(), 1.0)
	var accel := 12.0 if is_on_floor() else 2.5
	velocity.x = move_toward(velocity.x, wish.x, accel * delta * max(speed, 3.0))
	velocity.z = move_toward(velocity.z, wish.z, accel * delta * max(speed, 3.0))
	if is_on_floor() and controls_enabled and Input.is_action_just_pressed("jump"):
		velocity.y = JUMP
		play_once("Jump_Start")
	# разворот тела по направлению движения (в 1-м лице — по камере)
	var hv := Vector2(velocity.x, velocity.z)
	if first_person:
		rotation.y = _yaw
	elif hv.length() > 0.3:
		rotation.y = lerp_angle(rotation.y, atan2(-hv.x, -hv.y), min(1.0, 10.0 * delta))
	apply_gravity_and_move(delta)
	if not is_on_floor():
		play("Jump")
	else:
		play(locomotion_anim(hv.length()), 0.2, clamp(hv.length() / (1.4 if hv.length() < 2.2 else (3.6 if hv.length() < 5.0 else 6.2)), 0.6, 1.4))
	_update_focus()


func _update_focus() -> void:
	var best: Node = null
	var bd := 2.8
	var fwd := -global_transform.basis.z
	for n in get_tree().get_nodes_in_group("interactable"):
		if not (n is Node3D) or n == self:
			continue
		var to: Vector3 = (n as Node3D).global_position - global_position
		to.y = 0
		var d := to.length()
		var reach: float = n.get("interact_radius") if n.get("interact_radius") != null else 2.8
		if d < reach and d < bd + 0.5 and (d < 1.2 or fwd.dot(to.normalized()) > -0.2):
			bd = d
			best = n
	focus = best


func add_money(kopecks: int, reason: String) -> bool:
	if money + kopecks < 0:
		notify.emit("Недостаточно наличных")
		return false
	money += kopecks
	money_changed.emit()
	if reason != "":
		notify.emit("%s: %s%s ₽" % [reason, "+" if kopecks > 0 else "−", str(abs(kopecks) / 100)])
	return true


func view_camera() -> Camera3D:
	return camera
