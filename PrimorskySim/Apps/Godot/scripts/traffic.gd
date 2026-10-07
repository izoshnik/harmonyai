## Уличный трафик по реальному графу дорог OSM: машины едут по правой полосе, на перекрёстках
## выбирают следующую дорогу, держат дистанцию до впереди идущей машины. Активны только машины
## в радиусе вокруг игрока — дальние перекладываются ближе (AI LOD из Docs/NPC.md).
class_name Traffic
extends Node3D

const CAR_COUNT := 220
const RADIUS := 900.0
const SNAP := 1.0  # м: склейка узлов графа по совпадающим точкам

var nodes: Array[Vector2] = []
var adj: Array = []  # node -> Array[[to_node, lane_offset, max_speed]]
var cars: Array = []
var player: Node3D
var car_scenes: Array[PackedScene] = []
var rng := RandomNumberGenerator.new()


func build(data: Dictionary, p: Node3D) -> void:
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
	for path in ["res://assets/models/car_sedan.glb", "res://assets/models/car_hatch.glb", "res://assets/models/car_suv.glb"]:
		if ResourceLoader.exists(path):
			car_scenes.append(load(path))
	for i in CAR_COUNT:
		var car := _make_car()
		add_child(car.node)
		cars.append(car)
		_respawn(car)


func _make_car() -> Dictionary:
	var node: Node3D
	if car_scenes.is_empty():
		node = _fallback_car()
	else:
		node = car_scenes[rng.randi() % car_scenes.size()].instantiate()
		_tint(node, Color.from_hsv(rng.randf(), rng.randf_range(0.0, 0.7), rng.randf_range(0.15, 0.9)))
	return {"node": node, "from": 0, "to": 0, "t": 0.0, "speed": 0.0, "vmax": 12.0, "lane": 2.0}


func _tint(node: Node, color: Color) -> void:
	for mi in node.find_children("*", "MeshInstance3D", true, false):
		for s in mi.mesh.get_surface_count():
			var mat: Material = mi.mesh.surface_get_material(s)
			if mat is StandardMaterial3D and mat.resource_name.begins_with("Paint"):
				var m2: StandardMaterial3D = mat.duplicate()
				m2.albedo_color = color
				mi.set_surface_override_material(s, m2)


func _fallback_car() -> Node3D:
	var n := Node3D.new()
	var body := MeshInstance3D.new()
	var bm := BoxMesh.new()
	bm.size = Vector3(1.75, 0.7, 4.3)
	body.mesh = bm
	body.position.y = 0.55
	var mat := StandardMaterial3D.new()
	mat.albedo_color = Color.from_hsv(rng.randf(), 0.5, 0.6)
	mat.metallic = 0.6
	mat.roughness = 0.25
	mat.clearcoat_enabled = true
	body.material_override = mat
	n.add_child(body)
	var cab := MeshInstance3D.new()
	var cm := BoxMesh.new()
	cm.size = Vector3(1.6, 0.55, 2.2)
	cab.mesh = cm
	cab.position = Vector3(0, 1.15, -0.2)
	var glass := StandardMaterial3D.new()
	glass.albedo_color = Color(0.05, 0.07, 0.09)
	glass.roughness = 0.05
	cab.material_override = glass
	n.add_child(cab)
	return n


func _respawn(car: Dictionary) -> void:
	if nodes.is_empty():
		return
	var center := Vector2(player.global_position.x, -player.global_position.z)
	for attempt in 40:
		var id := rng.randi() % nodes.size()
		if nodes[id].distance_to(center) < RADIUS and adj[id].size() > 0:
			var e: Array = adj[id][rng.randi() % adj[id].size()]
			car.from = id
			car.to = e[0]
			car.lane = e[1]
			car.vmax = e[2] * rng.randf_range(0.8, 1.1)
			car.t = rng.randf()
			car.speed = car.vmax * 0.5
			return


func _next_edge(car: Dictionary) -> void:
	var options: Array = adj[car.to]
	var back: int = car.from
	var choices := options.filter(func(e): return e[0] != back)
	if choices.is_empty():
		choices = options  # тупик — разворот
	var e: Array = choices[rng.randi() % choices.size()]
	car.from = car.to
	car.to = e[0]
	car.lane = e[1]
	car.vmax = e[2] * rng.randf_range(0.8, 1.1)
	car.t = 0.0


func _physics_process(delta: float) -> void:
	if nodes.is_empty():
		return
	var center := Vector2(player.global_position.x, -player.global_position.z)
	for car in cars:
		var a: Vector2 = nodes[car.from]
		var b: Vector2 = nodes[car.to]
		var seg := a.distance_to(b)
		if seg < 0.01:
			_next_edge(car)
			continue
		# дистанция до впереди идущей машины на том же ребре
		var target: float = car.vmax
		for o in cars:
			if o != car and o.from == car.from and o.to == car.to and o.t > car.t and (o.t - car.t) * seg < 12.0:
				target = min(target, o.speed * 0.8)
		car.speed = move_toward(car.speed, target, 3.0 * delta)
		car.t += car.speed * delta / seg
		while car.t >= 1.0:
			var over: float = (car.t - 1.0) * seg
			_next_edge(car)
			a = nodes[car.from]
			b = nodes[car.to]
			seg = max(a.distance_to(b), 0.01)
			car.t = over / seg
		var dir := (b - a).normalized()
		var right := Vector2(dir.y, -dir.x)  # правостороннее движение
		var p: Vector2 = a.lerp(b, car.t) + right * car.lane
		var node: Node3D = car.node
		var pos := Vector3(p.x, 0.0, -p.y)
		var yaw := atan2(-dir.x, dir.y)  # модель смотрит вдоль -Z; север = -Z
		var jumped := node.global_position.distance_to(pos) > 5.0
		node.global_position = pos
		node.rotation.y = yaw if jumped else lerp_angle(node.rotation.y, yaw, min(1.0, 8.0 * delta))
		if p.distance_to(center) > RADIUS * 1.3:
			_respawn(car)
