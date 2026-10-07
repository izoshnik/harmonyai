## Пешеходы вокруг игрока: граф тротуаров (OSM footway/path/pedestrian + обочины улиц), пул NPC,
## перекладывание дальних NPC ближе к игроку (AI LOD), диалоги, сообщения о нарушениях.
class_name Pedestrians
extends Node3D

const SNAP := 1.0
const RADIUS := 160.0

var nodes: Array[Vector2] = []
var adj: Array = []
var player: Player
var hud: Node
var dialogue: Dialogue
var npcs: Array[NPC] = []
var rng := RandomNumberGenerator.new()
var talking: NPC = null
var wanted := 0.0  # «розыск»: растёт от жалоб, снижается со временем


func build(data: Dictionary, p: Player, h: Node, count: int) -> void:
	player = p
	hud = h
	rng.seed = 99
	dialogue = Dialogue.new()
	add_child(dialogue)
	dialogue.answered.connect(_on_answer)
	var index := {}
	for r in data["roads"]:
		var cls: int = r[2]
		if cls != 5 and cls != 1 and cls != 0:
			continue
		var flat: Array = r[0]
		var prev := -1
		for i in range(0, flat.size() - 1, 2):
			var pt := Vector2(flat[i], flat[i + 1])
			var key := Vector2i(roundi(pt.x / SNAP), roundi(pt.y / SNAP))
			var id: int = index.get(key, -1)
			if id < 0:
				id = nodes.size()
				index[key] = id
				nodes.append(pt)
				adj.append([])
			if prev >= 0 and prev != id:
				adj[prev].append(id)
				adj[id].append(prev)
			prev = id
	for i in count:
		var n := NPC.new()
		add_child(n)
		n.init_npc(self, rng)
		npcs.append(n)
		_place(n, true)


func node_pos(i: int) -> Vector3:
	var p := nodes[i]
	return Vector3(p.x, 0, -p.y)


func next_node(at: int, prev: int) -> int:
	var opts: Array = adj[at]
	if opts.is_empty():
		return at
	var choices := opts.filter(func(x): return x != prev)
	if choices.is_empty():
		choices = opts
	return choices[rng.randi() % choices.size()]


func _place(n: NPC, initial: bool) -> void:
	var c := Vector2(player.global_position.x, -player.global_position.z)
	for attempt in 60:
		var id := rng.randi() % nodes.size()
		var d := nodes[id].distance_to(c)
		if d < RADIUS and (initial or d > 60.0) and adj[id].size() > 0:
			n.global_position = node_pos(id) + Vector3(0, 0.1, 0)
			n.path_from = id
			n.path_to = adj[id][rng.randi() % adj[id].size()]
			n.state = NPC.State.WALK
			n.health = n.max_health
			n.dead = false
			n.collision_layer = 1
			n.current_anim = ""
			if not n.is_in_group("interactable"):
				n.add_to_group("interactable")
			return


func _process(delta: float) -> void:
	wanted = max(0.0, wanted - delta * 0.02)
	var pp := player.global_position
	if player.vehicle:
		pp = (player.vehicle as Node3D).global_position
	for n in npcs:
		var d := n.global_position.distance_to(pp)
		# дальние — выключаем физику и переносим ближе (их состояние «где-то в городе» не важно для сцены)
		if d > RADIUS * 1.25 and n != talking and n.state != NPC.State.FOLLOW:
			_place(n, false)
		n.process_mode = Node.PROCESS_MODE_INHERIT if d < RADIUS else Node.PROCESS_MODE_DISABLED


func open_dialogue(n: NPC) -> void:
	talking = n
	hud.open_dialogue(n.display_name, func(text: String): _say(n, text), func(): close_dialogue())


func close_dialogue() -> void:
	if talking:
		talking.end_talk()
	talking = null


func _say(n: NPC, text: String) -> void:
	var context := "Ты стоишь на улице %s, время %s." % [hud.current_street, hud.current_time]
	dialogue.ask(n, n.persona, n.history, text, context)
	n.history.append({"role": "user", "content": text})


func _on_answer(npc: Node, reply: String, intent: String) -> void:
	var n := npc as NPC
	n.history.append({"role": "assistant", "content": reply})
	if n.history.size() > 16:
		n.history = n.history.slice(n.history.size() - 16)
	hud.dialogue_reply(n.display_name, reply)
	n.apply_intent(intent, player)
	if intent in ["leave", "call_police"]:
		hud.close_dialogue()


func report_crime(_victim: NPC, _offender: Node) -> void:
	wanted = min(5.0, wanted + 1.0)
	hud.toast("Прохожий звонит в полицию! Розыск: %d" % int(ceil(wanted)))
