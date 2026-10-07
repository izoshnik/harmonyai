## Уличный трафик по реальному графу дорог OSM. Машины едут по правой полосе, держат дистанцию,
## останавливаются перед людьми и препятствиями, имеют коллизию (AnimatableBody3D).
## Любую машину можно «перехватить» (E): водитель выходит, игрок садится за руль физической машины.
class_name Traffic
extends Node3D

const RADIUS := 650.0
const SNAP := 1.0
const KINDS := ["car_sedan", "car_hatch", "car_suv"]

var nodes: Array[Vector2] = []
var adj: Array = []
var cars: Array = []
var player: Player
var rng := RandomNumberGenerator.new()
var _scenes := {}


class TrafficCar:
	extends AnimatableBody3D
	var traffic: Traffic
	var kind := ""
	var color := Color.WHITE
	var from := 0
	var to := 0
	var t := 0.0
	var speed := 0.0
	var vmax := 12.0
	var lane := 2.0
	var interact_radius := 3.0

	func get_prompt(_p: Player) -> String:
		return "Угнать машину"

	func interact(p: Player) -> void:
		traffic.hijack(self, p)


func build(data: Dictionary, p: Player) -> void:
	player = p
	rng.seed = 11
	var index := {}
	for r in data["roads"]:
		var cls: int = r[2]
		if cls < 1 or cls == 5:
			continue
		var flat: Array = r[0]
		var lane: float = clamp(r[1] * 0.25, 1.6, 5.0)
		var vmax: float = {1: 11.0, 2: 15.0, 3: 17.0, 4: 22.0}.get(cls, 11.0)
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
				adj[prev].append([id, lane, vmax])
				adj[id].append([prev, lane, vmax])
			prev = id
	for k in KINDS:
		_scenes[k] = load("res://assets/models/%s.glb" % k)


func set_count(n: int) -> void:
	while cars.size() < n:
		var c := _make_car()
		add_child(c)
		cars.append(c)
		_respawn(c)
	while cars.size() > n:
		var c: TrafficCar = cars.pop_back()
		c.queue_free()


func _make_car() -> TrafficCar:
	var c := TrafficCar.new()
	c.traffic = self
	c.kind = KINDS[rng.randi() % KINDS.size()]
	c.color = Color.from_hsv(rng.randf(), rng.randf_range(0.0, 0.6), rng.randf_range(0.12, 0.85))
	var spec: Dictionary = Vehicle.SPECS[c.kind]
	var vis: Node3D = _scenes[c.kind].instantiate()
	vis.position = Vector3(0, 0, float(spec["len"]) * 0.5)
	c.add_child(vis)
	for mi in vis.find_children("*", "MeshInstance3D", true, false):
		mi.cast_shadow = GeometryInstance3D.SHADOW_CASTING_SETTING_ON
		for i in mi.mesh.get_surface_count():
			var m: Material = mi.mesh.surface_get_material(i)
			if m and m.resource_name == "Paint":
				var m2: StandardMaterial3D = (m as StandardMaterial3D).duplicate()
				m2.albedo_color = c.color
				mi.set_surface_override_material(i, m2)
	var col := CollisionShape3D.new()
	var box := BoxShape3D.new()
	box.size = Vector3(spec["w"], float(spec["h"]) - 0.3, spec["len"])
	col.shape = box
	col.position.y = 0.3 + (float(spec["h"]) - 0.3) * 0.5
	c.add_child(col)
	c.sync_to_physics = false
	c.add_to_group("interactable")
	c.add_to_group("traffic")
	return c


func _respawn(c: TrafficCar) -> void:
	if nodes.is_empty():
		return
	var center := _center()
	for attempt in 40:
		var id := rng.randi() % nodes.size()
		var d := nodes[id].distance_to(center)
		if d < RADIUS and d > 60.0 and adj[id].size() > 0:
			var e: Array = adj[id][rng.randi() % adj[id].size()]
			c.from = id
			c.to = e[0]
			c.lane = e[1]
			c.vmax = e[2] * rng.randf_range(0.8, 1.1)
			c.t = rng.randf()
			c.speed = c.vmax * 0.5
			return


func _center() -> Vector2:
	var p := player.global_position if player.vehicle == null else (player.vehicle as Node3D).global_position
	return Vector2(p.x, -p.z)


func _next_edge(c: TrafficCar) -> void:
	var options: Array = adj[c.to]
	var back := c.from
	var choices := options.filter(func(e): return e[0] != back)
	if choices.is_empty():
		choices = options
	var e: Array = choices[rng.randi() % choices.size()]
	c.from = c.to
	c.to = e[0]
	c.lane = e[1]
	c.vmax = e[2] * rng.randf_range(0.8, 1.1)
	c.t = 0.0


func parking_spots_near(p: Vector3, n: int) -> Array:
	# Места у края проезжей части ближайших улиц
	var out := []
	var c := Vector2(p.x, -p.z)
	var ids := range(nodes.size()).filter(func(i): return nodes[i].distance_to(c) < 70.0 and adj[i].size() > 0)
	ids.sort_custom(func(a, b): return nodes[a].distance_to(c) < nodes[b].distance_to(c))
	for id in ids:
		if out.size() >= n:
			break
		var e: Array = adj[id][0]
		var a := nodes[id]
		var b := nodes[e[0]]
		var dir := (b - a).normalized()
		var right := Vector2(dir.y, -dir.x)
		var q := a + right * (float(e[1]) + 1.8)
		var yaw := atan2(-dir.x, dir.y)
		out.append(Transform3D(Basis(Vector3.UP, yaw), Vector3(q.x, 0.6, -q.y)))
	return out


func hijack(c: TrafficCar, p: Player) -> void:
	var v := Vehicle.new()
	v.setup(c.kind, c.color)
	get_parent().add_child(v)
	v.global_transform = c.global_transform
	v.global_position.y += 0.4
	_respawn(c)
	v.interact(p)


func _obstacle_ahead(c: TrafficCar, pos: Vector3, fwd: Vector3) -> bool:
	for group in ["player", "npc", "vehicles"]:
		for n in get_tree().get_nodes_in_group(group):
			var o := n as Node3D
			if o == null or not o.visible:
				continue
			var to := o.global_position - pos
			to.y = 0
			var along := to.dot(fwd)
			if along > 0.5 and along < 9.0 and abs(to.dot(Vector3(fwd.z, 0, -fwd.x))) < 1.8:
				return true
	return false


func _physics_process(delta: float) -> void:
	if nodes.is_empty():
		return
	var center := _center()
	var i := 0
	for c: TrafficCar in cars:
		i += 1
		var a: Vector2 = nodes[c.from]
		var b: Vector2 = nodes[c.to]
		var seg := a.distance_to(b)
		if seg < 0.01:
			_next_edge(c)
			continue
		var dir := (b - a) / seg
		var fwd := Vector3(dir.x, 0, -dir.y)
		var target: float = c.vmax
		for o: TrafficCar in cars:
			if o != c and o.from == c.from and o.to == c.to and o.t > c.t and (o.t - c.t) * seg < 12.0:
				target = min(target, o.speed * 0.8)
		# проверка людей/машин впереди — раз в несколько кадров для экономии
		if (Engine.get_physics_frames() + i) % 6 == 0:
			c.set_meta("blocked", _obstacle_ahead(c, c.global_position, fwd))
		if c.get_meta("blocked", false):
			target = 0.0
		c.speed = move_toward(c.speed, target, (6.0 if target < c.speed else 3.0) * delta)
		c.t += c.speed * delta / seg
		while c.t >= 1.0:
			var over: float = (c.t - 1.0) * seg
			_next_edge(c)
			a = nodes[c.from]
			b = nodes[c.to]
			seg = max(a.distance_to(b), 0.01)
			c.t = over / seg
			dir = (b - a) / seg
		var right := Vector2(dir.y, -dir.x)
		var p: Vector2 = a.lerp(b, c.t) + right * c.lane
		var pos := Vector3(p.x, 0.0, -p.y)
		var yaw := atan2(-dir.x, dir.y)
		var jumped := c.global_position.distance_to(pos) > 5.0
		c.global_position = pos
		c.rotation.y = yaw if jumped else lerp_angle(c.rotation.y, yaw, min(1.0, 8.0 * delta))
		if p.distance_to(center) > RADIUS * 1.3:
			_respawn(c)
