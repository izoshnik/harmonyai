## Человек (игрок и NPC): модель-манекен Quaternius (CC0) с анимациями, здоровье, удары, падение.
## Общая физика CharacterBody3D; управление — у наследников (Player / NPC).
class_name Humanoid
extends CharacterBody3D

signal died
signal damaged(amount: float, source: Node)

const MODEL := preload("res://assets/characters/mannequin.glb")
const LOOPS := ["Idle", "Walk", "Jog_Fwd", "Sprint", "Jump", "Idle_Talking",
	"Driving", "Crouch_Idle", "Sitting_Idle", "Walk_Formal", "Push"]

var max_health := 100.0
var health := 100.0
var dead := false
var model: Node3D
var anim: AnimationPlayer
var current_anim := ""
var one_shot_until := 0.0
var gravity: float = ProjectSettings.get_setting("physics/3d/default_gravity")
var _fall_start_y := 0.0
var _was_on_floor := true


func setup_body(tint: Color, height_scale := 1.0) -> void:
	var col := CollisionShape3D.new()
	var cap := CapsuleShape3D.new()
	cap.radius = 0.3
	cap.height = 1.75 * height_scale
	col.shape = cap
	col.position.y = 0.875 * height_scale
	add_child(col)
	model = MODEL.instantiate()
	model.scale = Vector3.ONE * height_scale
	model.rotation.y = PI  # модель смотрит в +Z, персонаж — в −Z
	add_child(model)
	anim = model.find_child("AnimationPlayer", true, false)
	if anim:
		for lib_name in anim.get_animation_library_list():
			var lib := anim.get_animation_library(lib_name)
			for a in lib.get_animation_list():
				if a in LOOPS:
					lib.get_animation(a).loop_mode = Animation.LOOP_LINEAR
	for mi in model.find_children("*", "MeshInstance3D", true, false):
		for s in mi.mesh.get_surface_count():
			var m: Material = mi.mesh.surface_get_material(s)
			if m is StandardMaterial3D and m.resource_name == "M_Main":
				var m2: StandardMaterial3D = m.duplicate()
				m2.albedo_color = tint
				m2.roughness = 0.7
				mi.set_surface_override_material(s, m2)
		mi.cast_shadow = GeometryInstance3D.SHADOW_CASTING_SETTING_ON
	floor_snap_length = 0.4
	floor_max_angle = deg_to_rad(50)


func play(name: String, blend := 0.2, speed := 1.0) -> void:
	if anim == null or name == current_anim or Time.get_ticks_msec() < one_shot_until:
		return
	if anim.has_animation(name):
		anim.play(name, blend, speed)
		current_anim = name


func play_once(name: String, blend := 0.1) -> void:
	if anim and anim.has_animation(name):
		anim.play(name, blend)
		current_anim = name
		one_shot_until = Time.get_ticks_msec() + anim.get_animation(name).length * 1000.0 * 0.9


func locomotion_anim(speed: float) -> String:
	if speed < 0.2:
		return "Idle"
	if speed < 2.2:
		return "Walk"
	if speed < 5.0:
		return "Jog_Fwd"
	return "Sprint"


func apply_gravity_and_move(delta: float) -> void:
	if not is_on_floor():
		velocity.y -= gravity * delta
	move_and_slide()
	# урон от падения
	var on_floor := is_on_floor()
	if _was_on_floor and not on_floor:
		_fall_start_y = global_position.y
	elif not _was_on_floor and on_floor:
		var h := _fall_start_y - global_position.y
		if h > 4.0:
			take_damage((h - 4.0) * 12.0, null)
	_was_on_floor = on_floor


func take_damage(amount: float, source: Node) -> void:
	if dead:
		return
	health = max(0.0, health - amount)
	damaged.emit(amount, source)
	if health <= 0.0:
		die()
	else:
		play_once("Hit_Chest")


func heal(amount: float) -> void:
	if not dead:
		health = min(max_health, health + amount)


func die() -> void:
	dead = true
	velocity = Vector3.ZERO
	one_shot_until = 0
	play_once("Death01")
	died.emit()


func punch_target(target: Node3D) -> void:
	play_once("Punch_Jab" if randf() < 0.5 else "Punch_Cross")
	if target is Humanoid and global_position.distance_to(target.global_position) < 1.6:
		var t: Humanoid = target
		t.take_damage(12.0, self)
		var push := (t.global_position - global_position).normalized()
		t.velocity += Vector3(push.x, 1.0, push.z) * 2.5
	elif target is RigidBody3D:
		var rb: RigidBody3D = target
		rb.apply_central_impulse((rb.global_position - global_position).normalized() * 40.0 + Vector3.UP * 10.0)
