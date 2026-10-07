## Персонаж от первого лица: ходьба, бег, прыжок, полёт (F). Мышь — обзор, Esc — освободить курсор.
class_name Player
extends CharacterBody3D

const WALK := 1.6
const RUN := 6.5
const FLY := 45.0
const FLY_FAST := 160.0
const JUMP := 4.2
const SENS := 0.0022

var flying := false
var head: Node3D
var camera: Camera3D
var _gravity: float = ProjectSettings.get_setting("physics/3d/default_gravity")


func _ready() -> void:
	var col := CollisionShape3D.new()
	var cap := CapsuleShape3D.new()
	cap.radius = 0.3
	cap.height = 1.75
	col.shape = cap
	col.position.y = 0.875
	add_child(col)
	head = Node3D.new()
	head.position.y = 1.65
	add_child(head)
	camera = Camera3D.new()
	camera.fov = 75.0
	camera.near = 0.1
	camera.far = 8000.0
	head.add_child(camera)
	floor_snap_length = 0.5
	floor_max_angle = deg_to_rad(50)


func _unhandled_input(event: InputEvent) -> void:
	if event is InputEventMouseButton and event.pressed and Input.mouse_mode != Input.MOUSE_MODE_CAPTURED:
		Input.mouse_mode = Input.MOUSE_MODE_CAPTURED
	if event is InputEventMouseMotion and Input.mouse_mode == Input.MOUSE_MODE_CAPTURED:
		rotate_y(-event.relative.x * SENS)
		head.rotate_x(-event.relative.y * SENS)
		head.rotation.x = clamp(head.rotation.x, -1.5, 1.5)
	if event is InputEventKey and event.pressed and not event.echo:
		match event.physical_keycode:
			KEY_ESCAPE:
				Input.mouse_mode = Input.MOUSE_MODE_VISIBLE
			KEY_F:
				set_flying(not flying)


func set_flying(v: bool) -> void:
	flying = v
	for c in get_children():
		if c is CollisionShape3D:
			c.disabled = v
	if not v:
		velocity = Vector3.ZERO


func _physics_process(delta: float) -> void:
	var input := Input.get_vector("move_left", "move_right", "move_forward", "move_back")
	var sprint := Input.is_action_pressed("sprint")
	if flying:
		var dir := (camera.global_transform.basis * Vector3(input.x, 0, input.y))
		if Input.is_key_pressed(KEY_E) or Input.is_action_pressed("jump"):
			dir.y += 1.0
		if Input.is_key_pressed(KEY_Q):
			dir.y -= 1.0
		velocity = dir.normalized() * (FLY_FAST if sprint else FLY) if dir.length() > 0.01 else Vector3.ZERO
		global_position += velocity * delta
		global_position.y = max(global_position.y, 0.5)
		return
	var speed := RUN if sprint else WALK
	var wish := (transform.basis * Vector3(input.x, 0, input.y))
	wish.y = 0
	wish = wish.normalized() * speed
	var accel := 10.0 if is_on_floor() else 2.0
	velocity.x = move_toward(velocity.x, wish.x, accel * speed * delta)
	velocity.z = move_toward(velocity.z, wish.z, accel * speed * delta)
	if not is_on_floor():
		velocity.y -= _gravity * delta
	elif Input.is_action_just_pressed("jump"):
		velocity.y = JUMP
	move_and_slide()
	# покачивание головы при ходьбе
	var hv := Vector2(velocity.x, velocity.z).length()
	head.position.y = 1.65 + (sin(Time.get_ticks_msec() * 0.011 * (1.0 + hv * 0.15)) * 0.025 * min(hv, 6.0) / 6.0 if is_on_floor() else 0.0)


func ground_speed_kmh() -> float:
	return Vector2(velocity.x, velocity.z).length() * 3.6 if not flying else velocity.length() * 3.6
