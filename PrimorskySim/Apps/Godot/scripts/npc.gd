## Пешеход: идёт по реальным тротуарам OSM, разговаривает (E), может пойти за игроком,
## убегает и зовёт полицию, если его ударили, погибает от удара машиной.
class_name NPC
extends Humanoid

enum State { WALK, IDLE, TALK, FOLLOW, FLEE, DEAD }

const NAMES_M := ["Андрей", "Сергей", "Дмитрий", "Алексей", "Иван", "Максим", "Олег", "Михаил", "Павел", "Николай"]
const NAMES_F := ["Анна", "Мария", "Елена", "Ольга", "Татьяна", "Наталья", "Ирина", "Светлана", "Дарья", "Ксения"]
const JOBS := ["курьер", "студентка СПбГУ", "водитель автобуса", "пенсионерка", "программист", "продавщица",
	"инженер на заводе", "школьник", "врач поликлиники", "строитель", "менеджер в ТЦ «Питерлэнд»", "охранник"]
const MOODS := ["спокойный", "торопится", "весёлый", "уставший", "раздражённый", "дружелюбный"]

var manager: Node
var state := State.WALK
var path_from := 0
var path_to := 0
var walk_speed := 1.35
var persona := ""
var display_name := ""
var history: Array = []
var interact_radius := 2.2
var _idle_t := 0.0
var _flee_from: Node3D = null
var _target: Node3D = null


func init_npc(m: Node, rng: RandomNumberGenerator) -> void:
	manager = m
	var female := rng.randf() < 0.5
	display_name = (NAMES_F if female else NAMES_M)[rng.randi() % 10]
	var age := rng.randi_range(17, 78)
	persona = "Тебя зовут %s, тебе %d, ты %s, настроение: %s." % [display_name, age, JOBS[rng.randi() % JOBS.size()], MOODS[rng.randi() % MOODS.size()]]
	var palette := [Color(0.15, 0.15, 0.18), Color(0.35, 0.12, 0.12), Color(0.12, 0.22, 0.35), Color(0.45, 0.42, 0.38),
		Color(0.22, 0.3, 0.2), Color(0.55, 0.5, 0.45), Color(0.6, 0.2, 0.3), Color(0.25, 0.25, 0.3)]
	setup_body(palette[rng.randi() % palette.size()], rng.randf_range(0.92, 1.06) if not female else rng.randf_range(0.88, 0.98))
	walk_speed = rng.randf_range(1.1, 1.6) * (0.75 if age > 65 else 1.0)
	add_to_group("interactable")
	add_to_group("punchable")
	add_to_group("npc")
	damaged.connect(_on_damaged)


func get_prompt(_p: Player) -> String:
	return "Поговорить: %s" % display_name if state != State.DEAD else ""


func interact(p: Player) -> void:
	if state == State.DEAD or state == State.FLEE:
		return
	state = State.TALK
	_target = p
	manager.open_dialogue(self)


func end_talk() -> void:
	if state == State.TALK:
		state = State.WALK


func apply_intent(intent: String, p: Player) -> void:
	match intent:
		"follow":
			state = State.FOLLOW
			_target = p
		"stop_follow", "leave":
			state = State.WALK
		"call_police":
			state = State.FLEE
			_flee_from = p
			manager.report_crime(self, p)


func _on_damaged(_amount: float, source: Node) -> void:
	if source is Player:
		state = State.FLEE
		_flee_from = source
		manager.report_crime(self, source)


func die() -> void:
	super.die()
	state = State.DEAD
	remove_from_group("interactable")
	collision_layer = 0


func _physics_process(delta: float) -> void:
	if state == State.DEAD:
		return
	var want := Vector3.ZERO
	var speed := 0.0
	match state:
		State.WALK:
			var target: Vector3 = manager.node_pos(path_to)
			var to := target - global_position
			to.y = 0
			if to.length() < 0.8:
				path_from = path_to
				path_to = manager.next_node(path_from, path_from)
				if randf() < 0.06:
					state = State.IDLE
					_idle_t = randf_range(2.0, 7.0)
			want = to.normalized()
			speed = walk_speed
		State.IDLE:
			_idle_t -= delta
			if _idle_t <= 0:
				state = State.WALK
		State.TALK:
			if _target:
				_face(_target.global_position, delta)
			play("Idle_Talking")
		State.FOLLOW:
			if _target and is_instance_valid(_target):
				var to2 := _target.global_position - global_position
				to2.y = 0
				if to2.length() > 2.0:
					want = to2.normalized()
					speed = 1.4 if to2.length() < 6.0 else 4.5
		State.FLEE:
			if _flee_from and is_instance_valid(_flee_from):
				var away := global_position - _flee_from.global_position
				away.y = 0
				want = away.normalized()
				speed = 5.5
				if away.length() > 40.0:
					state = State.WALK
	velocity.x = want.x * speed
	velocity.z = want.z * speed
	if want.length() > 0.1:
		rotation.y = lerp_angle(rotation.y, atan2(-want.x, -want.z), min(1.0, 6.0 * delta))
	apply_gravity_and_move(delta)
	if state != State.TALK:
		play(locomotion_anim(speed), 0.25, clamp(speed / (1.4 if speed < 2.2 else 5.5), 0.7, 1.3))


func _face(p: Vector3, delta: float) -> void:
	var d := p - global_position
	rotation.y = lerp_angle(rotation.y, atan2(-d.x, -d.z), min(1.0, 5.0 * delta))
