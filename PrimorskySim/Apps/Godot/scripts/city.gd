## Строит город из data/district.json: здания (по типам фасадов), дороги с разметкой, тротуары,
## вода, зелёные зоны, деревья, фонари, станции метро. Геометрия разбита на квадраты CHUNK метров —
## движок отсекает невидимые куски и строит для каждого коллизию.
## Координаты данных: x — восток, y — север (метры). В Godot: X = x, Z = -y.
class_name City
extends Node3D

const CHUNK := 400.0
const FLOOR_H := 2.8

## Высота по умолчанию, когда в OSM нет ни height, ни building:levels.
## Это НЕ реальные данные: такие здания помечаются (H в игре подсвечивает их).
const DEFAULT_H := {0: 9.0, 1: 26.0, 2: 7.0, 3: 10.0, 4: 12.0, 5: 15.0, 6: 8.0, 7: 3.0, 8: 14.0, 9: 9.0}
const PANEL_TINTS := [
	Color(0.86, 0.84, 0.80), Color(0.82, 0.83, 0.84), Color(0.88, 0.82, 0.72), Color(0.78, 0.80, 0.82),
	Color(0.90, 0.88, 0.84), Color(0.80, 0.74, 0.66), Color(0.84, 0.78, 0.70), Color(0.74, 0.78, 0.80),
]

var data: Dictionary
var buildings_unknown: Array[Vector2] = []  # центры зданий с условной высотой (для подсветки)
var unknown_markers: MultiMeshInstance3D
var lamp_points: Array[Vector3] = []
var road_segments_by_cell := {}  # для поиска названия улицы
var stations: Array = []

var _mat := {}


func build(d: Dictionary, progress: Callable) -> void:
	data = d
	_make_materials()
	progress.call("Земля и вода…")
	_build_ground()
	_build_water()
	progress.call("Здания…")
	_build_buildings()
	progress.call("Дороги и тротуары…")
	_build_roads()
	progress.call("Деревья и парки…")
	_build_vegetation()
	progress.call("Фонари и станции…")
	_build_lamps()
	_build_stations()


# ------------------------------------------------------------------ материалы

func _tex(name: String) -> Texture2D:
	return load("res://assets/tex/%s.jpg" % name)


func _ground_mat(set: String, tile: float, tint := Color.WHITE, rough_min := 0.5) -> ShaderMaterial:
	var m := ShaderMaterial.new()
	m.shader = load("res://shaders/ground.gdshader")
	m.set_shader_parameter("albedo_tex", _tex(set + "_Color"))
	m.set_shader_parameter("normal_tex", _tex(set + "_NormalGL"))
	m.set_shader_parameter("rough_tex", _tex(set + "_Roughness"))
	m.set_shader_parameter("tile_m", tile)
	m.set_shader_parameter("tint", Vector3(tint.r, tint.g, tint.b))
	m.set_shader_parameter("rough_min", rough_min)
	return m


func _make_materials() -> void:
	var panel := ShaderMaterial.new()
	panel.shader = load("res://shaders/panel_facade.gdshader")
	panel.set_shader_parameter("concrete", _tex("Concrete034_Color"))
	panel.set_shader_parameter("concrete_n", _tex("Concrete034_NormalGL"))
	_mat["panel"] = panel

	var brick := ShaderMaterial.new()
	brick.shader = load("res://shaders/textured_facade.gdshader")
	brick.set_shader_parameter("albedo_tex", _tex("Facade018A_Color"))
	brick.set_shader_parameter("normal_tex", _tex("Facade018A_NormalGL"))
	brick.set_shader_parameter("rough_tex", _tex("Facade018A_Roughness"))
	brick.set_shader_parameter("emission_tex", _tex("Facade018A_Emission"))
	brick.set_shader_parameter("tile_m", Vector2(16.0, 16.8))
	_mat["brick"] = brick

	var office := ShaderMaterial.new()
	office.shader = load("res://shaders/textured_facade.gdshader")
	office.set_shader_parameter("albedo_tex", _tex("Facade006_Color"))
	office.set_shader_parameter("normal_tex", _tex("Facade006_NormalGL"))
	office.set_shader_parameter("rough_tex", _tex("Facade006_Roughness"))
	office.set_shader_parameter("emission_tex", _tex("Facade006_Emission"))
	office.set_shader_parameter("tile_m", Vector2(20.0, 22.0))
	office.set_shader_parameter("metallic", 0.3)
	_mat["office"] = office

	_mat["roof"] = _ground_mat("Concrete034", 6.0, Color(0.5, 0.5, 0.52), 0.85)
	_mat["asphalt"] = _ground_mat("Asphalt026C", 5.0, Color(0.85, 0.85, 0.85))
	_mat["paving"] = _ground_mat("PavingStones130", 2.5, Color(0.9, 0.88, 0.85))
	_mat["grass"] = _ground_mat("Grass004", 3.0, Color(0.62, 0.66, 0.55), 0.85)
	_mat["forest"] = _ground_mat("Grass004", 2.2, Color(0.36, 0.40, 0.28), 0.9)

	var water := ShaderMaterial.new()
	water.shader = load("res://shaders/water.gdshader")
	_mat["water"] = water

	var marking := StandardMaterial3D.new()
	marking.albedo_color = Color(0.92, 0.92, 0.9)
	marking.roughness = 0.6
	_mat["marking"] = marking


# ------------------------------------------------------------------ утилиты геометрии

func _chunk_key(x: float, y: float) -> Vector2i:
	return Vector2i(floori(x / CHUNK), floori(y / CHUNK))


class MeshBuf:
	var v := PackedVector3Array()
	var n := PackedVector3Array()
	var uv := PackedVector2Array()
	var c := PackedColorArray()

	func tri(a: Vector3, b: Vector3, cc: Vector3, ua: Vector2, ub: Vector2, uc: Vector2, col: Color, normal: Vector3) -> void:
		v.append(a); v.append(b); v.append(cc)
		uv.append(ua); uv.append(ub); uv.append(uc)
		n.append(normal); n.append(normal); n.append(normal)
		c.append(col); c.append(col); c.append(col)

	func to_mesh(mat: Material) -> ArrayMesh:
		var arr := []
		arr.resize(Mesh.ARRAY_MAX)
		arr[Mesh.ARRAY_VERTEX] = v
		arr[Mesh.ARRAY_NORMAL] = n
		arr[Mesh.ARRAY_TEX_UV] = uv
		arr[Mesh.ARRAY_COLOR] = c
		var m := ArrayMesh.new()
		m.add_surface_from_arrays(Mesh.PRIMITIVE_TRIANGLES, arr)
		m.surface_set_material(0, mat)
		return m


func _buf(store: Dictionary, key: Vector2i, mat: String) -> MeshBuf:
	if not store.has(key):
		store[key] = {}
	if not store[key].has(mat):
		store[key][mat] = MeshBuf.new()
	return store[key][mat]


func _emit_chunks(store: Dictionary, collide: Array, cast_shadows := true) -> void:
	for key in store:
		var holder := Node3D.new()
		holder.name = "chunk_%d_%d" % [key.x, key.y]
		add_child(holder)
		for mat_name in store[key]:
			var b: MeshBuf = store[key][mat_name]
			if b.v.is_empty():
				continue
			var mi := MeshInstance3D.new()
			mi.mesh = b.to_mesh(_mat[mat_name])
			mi.cast_shadow = GeometryInstance3D.SHADOW_CASTING_SETTING_ON if cast_shadows else GeometryInstance3D.SHADOW_CASTING_SETTING_OFF
			mi.visibility_range_end = 3500.0
			holder.add_child(mi)
			if mat_name in collide:
				var body := StaticBody3D.new()
				var shape := CollisionShape3D.new()
				var conc := ConcavePolygonShape3D.new()
				conc.backface_collision = true
				conc.set_faces(b.v)
				shape.shape = conc
				body.add_child(shape)
				holder.add_child(body)


static func _flat_to_points(flat: Array) -> PackedVector2Array:
	var p := PackedVector2Array()
	for i in range(0, flat.size() - 1, 2):
		p.append(Vector2(flat[i], flat[i + 1]))
	return p


# ------------------------------------------------------------------ земля и вода

func _build_ground() -> void:
	var plane := PlaneMesh.new()
	plane.size = Vector2(40000, 40000)
	plane.subdivide_width = 8
	plane.subdivide_depth = 8
	var mi := MeshInstance3D.new()
	mi.mesh = plane
	mi.material_override = _mat["grass"]
	mi.position.y = -0.02
	mi.cast_shadow = GeometryInstance3D.SHADOW_CASTING_SETTING_OFF
	add_child(mi)
	var body := StaticBody3D.new()
	var shape := CollisionShape3D.new()
	shape.shape = WorldBoundaryShape3D.new()
	body.add_child(shape)
	add_child(body)


func _add_polygon(store: Dictionary, pts: PackedVector2Array, mat: String, y: float) -> void:
	var idx := Geometry2D.triangulate_polygon(pts)
	if idx.is_empty():
		return
	# Защита от самопересекающихся контуров: сумма площадей треугольников должна совпадать с площадью полигона
	var poly_area := 0.0
	for i in pts.size():
		poly_area += pts[i].cross(pts[(i + 1) % pts.size()])
	poly_area = abs(poly_area) * 0.5
	var tri_area := 0.0
	for i in range(0, idx.size(), 3):
		tri_area += abs((pts[idx[i + 1]] - pts[idx[i]]).cross(pts[idx[i + 2]] - pts[idx[i]])) * 0.5
	if poly_area <= 0.0 or abs(tri_area - poly_area) > poly_area * 0.02:
		return
	var key := _chunk_key(pts[0].x, pts[0].y)
	var b := _buf(store, key, mat)
	for i in range(0, idx.size(), 3):
		var a := pts[idx[i]]
		var bb := pts[idx[i + 1]]
		var c := pts[idx[i + 2]]
		b.tri(Vector3(a.x, y, -a.y), Vector3(c.x, y, -c.y), Vector3(bb.x, y, -bb.y), a, c, bb, Color.WHITE, Vector3.UP)


func _build_water() -> void:
	var store := {}
	for ring in data.get("water", []):
		_add_polygon(store, _flat_to_points(ring), "water", 0.06)
	for g in data.get("green", []):
		if g[0] == "forest":
			_add_polygon(store, _flat_to_points(g[1]), "forest", 0.015)
	_emit_chunks(store, [], false)


# ------------------------------------------------------------------ здания

func _building_material(type: int) -> String:
	match type:
		3: return "office"
		4, 5, 8, 9: return "brick"
		_: return "panel"


func _build_buildings() -> void:
	var store := {}
	var rng := RandomNumberGenerator.new()
	rng.seed = 2026
	for b in data["buildings"]:
		var flat: Array = b[0]
		var h: float = b[1]
		var type: int = b[2]
		var pts := _flat_to_points(flat)
		if pts.size() < 3:
			continue
		var known := h > 0.0
		var H: float = h if known else DEFAULT_H.get(type, 9.0)
		# ориентация обхода: стены наружу
		if Geometry2D.is_polygon_clockwise(pts):
			pts.reverse()
		var center := Vector2.ZERO
		for p in pts:
			center += p
		center /= pts.size()
		if not known:
			buildings_unknown.append(center)
		var key := _chunk_key(center.x, center.y)
		var mat := _building_material(type)
		if type == 7 or type == 6:
			mat = "brick" if H > 6.0 else "roof"
		var wall := _buf(store, key, mat)
		var tint: Color = PANEL_TINTS[rng.randi() % PANEL_TINTS.size()]
		tint.a = rng.randf()
		var u := 0.0
		for i in pts.size():
			var a := pts[i]
			var c := pts[(i + 1) % pts.size()]
			var len := a.distance_to(c)
			if len < 0.05:
				continue
			var dir := (c - a) / len
			var normal := Vector3(dir.y, 0, dir.x)  # наружу для обхода против часовой (данные: y — север)
			var A0 := Vector3(a.x, 0, -a.y)
			var C0 := Vector3(c.x, 0, -c.y)
			var A1 := Vector3(a.x, H, -a.y)
			var C1 := Vector3(c.x, H, -c.y)
			wall.tri(A0, C0, C1, Vector2(u, 0), Vector2(u + len, 0), Vector2(u + len, H), tint, normal)
			wall.tri(A0, C1, A1, Vector2(u, 0), Vector2(u + len, H), Vector2(u, H), tint, normal)
			u += len
		# крыша
		var idx := Geometry2D.triangulate_polygon(pts)
		var roof := _buf(store, key, "roof")
		for i in range(0, idx.size(), 3):
			var p0 := pts[idx[i]]
			var p1 := pts[idx[i + 1]]
			var p2 := pts[idx[i + 2]]
			roof.tri(Vector3(p0.x, H, -p0.y), Vector3(p2.x, H, -p2.y), Vector3(p1.x, H, -p1.y), p0, p2, p1, Color.WHITE, Vector3.UP)
	_emit_chunks(store, ["panel", "brick", "office"])
	_build_unknown_markers()


func _build_unknown_markers() -> void:
	# Подсветка зданий с условной высотой (клавиша H): маркер над крышей.
	var mm := MultiMesh.new()
	mm.transform_format = MultiMesh.TRANSFORM_3D
	var m := BoxMesh.new()
	m.size = Vector3(2, 6, 2)
	var mat := StandardMaterial3D.new()
	mat.albedo_color = Color(1.0, 0.5, 0.1)
	mat.emission_enabled = true
	mat.emission = Color(1.0, 0.45, 0.05)
	mat.emission_energy_multiplier = 2.0
	m.material = mat
	mm.mesh = m
	mm.instance_count = buildings_unknown.size()
	for i in buildings_unknown.size():
		var c := buildings_unknown[i]
		mm.set_instance_transform(i, Transform3D(Basis(), Vector3(c.x, 40.0, -c.y)))
	unknown_markers = MultiMeshInstance3D.new()
	unknown_markers.multimesh = mm
	unknown_markers.visible = false
	add_child(unknown_markers)


# ------------------------------------------------------------------ дороги

func _build_roads() -> void:
	var store := {}
	for r in data["roads"]:
		var flat: Array = r[0]
		var width: float = r[1]
		var cls: int = r[2]
		var name: String = r[3]
		var pts := _flat_to_points(flat)
		if pts.size() < 2:
			continue
		var mat := "paving" if cls == 5 else "asphalt"
		var y := 0.03 + cls * 0.004 if cls != 5 else 0.05
		var w := width * 0.5
		var key := _chunk_key(pts[0].x, pts[0].y)
		var buf := _buf(store, key, mat)
		var dash := 0.0
		for i in pts.size() - 1:
			var a := pts[i]
			var c := pts[i + 1]
			var len := a.distance_to(c)
			if len < 0.01:
				continue
			var d := (c - a) / len
			var nrm := Vector2(-d.y, d.x) * w
			# небольшое удлинение сегментов закрывает щели на изломах
			var a2 := a - d * minf(w, 2.0)
			var c2 := c + d * minf(w, 2.0)
			var p0 := a2 + nrm
			var p1 := a2 - nrm
			var p2 := c2 - nrm
			var p3 := c2 + nrm
			buf.tri(Vector3(p0.x, y, -p0.y), Vector3(p2.x, y, -p2.y), Vector3(p1.x, y, -p1.y), p0, p2, p1, Color.WHITE, Vector3.UP)
			buf.tri(Vector3(p0.x, y, -p0.y), Vector3(p3.x, y, -p3.y), Vector3(p2.x, y, -p2.y), p0, p3, p2, Color.WHITE, Vector3.UP)
			if name != "":
				var cell := _chunk_key(a.x, a.y)
				if not road_segments_by_cell.has(cell):
					road_segments_by_cell[cell] = []
				road_segments_by_cell[cell].append([a, c, name])
			# разметка: прерывистая осевая на дорогах 2+ класса
			if cls >= 2 and cls != 5:
				var mk := _buf(store, key, "marking")
				var s := dash
				while s < len:
					var s0 := a + d * s
					var s1 := a + d * minf(s + 3.0, len)
					var m := Vector2(-d.y, d.x) * 0.08
					var yy := y + 0.01
					mk.tri(Vector3(s0.x + m.x, yy, -(s0.y + m.y)), Vector3(s1.x - m.x, yy, -(s1.y - m.y)), Vector3(s0.x - m.x, yy, -(s0.y - m.y)), Vector2.ZERO, Vector2.ZERO, Vector2.ZERO, Color.WHITE, Vector3.UP)
					mk.tri(Vector3(s0.x + m.x, yy, -(s0.y + m.y)), Vector3(s1.x + m.x, yy, -(s1.y + m.y)), Vector3(s1.x - m.x, yy, -(s1.y - m.y)), Vector2.ZERO, Vector2.ZERO, Vector2.ZERO, Color.WHITE, Vector3.UP)
					s += 9.0
				dash = s - len
	_emit_chunks(store, [], false)


func street_at(x: float, y: float) -> String:
	var best := 40.0
	var name := ""
	var k := _chunk_key(x, y)
	var p := Vector2(x, y)
	for dx in [-1, 0, 1]:
		for dy in [-1, 0, 1]:
			for seg in road_segments_by_cell.get(Vector2i(k.x + dx, k.y + dy), []):
				var q := Geometry2D.get_closest_point_to_segment(p, seg[0], seg[1])
				var dd := q.distance_to(p)
				if dd < best:
					best = dd
					name = seg[2]
	return name


# ------------------------------------------------------------------ растительность

func _tree_mesh() -> ArrayMesh:
	# Два перекрещённых квада (4 ракурса атласа). Размеры кадра атласа: 4.38 × 8.76 м, ствол в центре по X.
	var st := SurfaceTool.new()
	st.begin(Mesh.PRIMITIVE_TRIANGLES)
	var hw := 4.38 * 0.5
	var h := 8.76
	var y0 := -h * 0.5 + 2.28  # нижний край кадра относительно основания ствола
	for i in 4:
		var ang := i * PI / 4.0
		var dir := Vector3(cos(ang), 0, sin(ang))
		var u0 := i * 0.25
		var u1 := u0 + 0.25
		var corners := [
			[-dir * hw + Vector3(0, y0, 0), Vector2(u0, 1)], [dir * hw + Vector3(0, y0, 0), Vector2(u1, 1)],
			[dir * hw + Vector3(0, y0 + h, 0), Vector2(u1, 0)], [-dir * hw + Vector3(0, y0 + h, 0), Vector2(u0, 0)],
		]
		for t in [[0, 1, 2], [0, 2, 3]]:
			for k in t:
				st.set_uv(corners[k][1])
				st.set_uv2(Vector2(0, clamp(corners[k][0].y / h, 0.0, 1.0)))
				st.set_normal(Vector3(dir.z, 0, -dir.x))
				st.add_vertex(corners[k][0])
	var m := st.commit()
	var mat := ShaderMaterial.new()
	mat.shader = load("res://shaders/tree_impostor.gdshader")
	mat.set_shader_parameter("atlas", load("res://assets/tree_atlas.png"))
	m.surface_set_material(0, mat)
	return m


func _build_vegetation() -> void:
	var rng := RandomNumberGenerator.new()
	rng.seed = 7
	var points: Array[Vector2] = []
	for t in data.get("trees", []):
		points.append(Vector2(t[0], t[1]))
	# Насаждения в парках и лесах: реальные контуры зон из OSM, расположение отдельных деревьев — случайное.
	var district := Rect2()
	for ring in data.get("boundary", []):
		var bp := _flat_to_points(ring)
		district = Rect2(bp[0], Vector2.ZERO) if district.size == Vector2.ZERO else district
		for p in bp:
			district = district.expand(p)
	district = district.grow(600.0)
	for g in data.get("green", []):
		var pts := _flat_to_points(g[1])
		if pts.size() < 3:
			continue
		var rect := Rect2(pts[0], Vector2.ZERO)
		for p in pts:
			rect = rect.expand(p)
		if not district.intersects(rect):
			continue
		rect = rect.intersection(district)
		var per := 110.0 if g[0] == "forest" else 350.0
		var n := mini(int(rect.get_area() / per), 6000)
		for i in n:
			var q := Vector2(rng.randf_range(rect.position.x, rect.end.x), rng.randf_range(rect.position.y, rect.end.y))
			if Geometry2D.is_point_in_polygon(q, pts):
				points.append(q)
		if points.size() > 180000:
			break
	var mesh := _tree_mesh()
	var by_chunk := {}
	for q in points:
		var k := _chunk_key(q.x, q.y)
		if not by_chunk.has(k):
			by_chunk[k] = []
		by_chunk[k].append(q)
	for k in by_chunk:
		var pts_k: Array = by_chunk[k]
		var mm := MultiMesh.new()
		mm.transform_format = MultiMesh.TRANSFORM_3D
		mm.use_colors = true
		mm.mesh = mesh
		mm.instance_count = pts_k.size()
		var origin := Vector3((k.x + 0.5) * CHUNK, 0, -(k.y + 0.5) * CHUNK)
		for i in pts_k.size():
			var s := rng.randf_range(1.5, 2.6)  # исходная модель ~4.5 м; городские деревья 7–12 м
			var basis := Basis(Vector3.UP, rng.randf() * TAU).scaled(Vector3(s, s * rng.randf_range(0.9, 1.15), s))
			mm.set_instance_transform(i, Transform3D(basis, Vector3(pts_k[i].x, 0, -pts_k[i].y) - origin))
			var g := rng.randf_range(0.8, 1.05)
			mm.set_instance_color(i, Color(g * rng.randf_range(0.9, 1.0), g, g * rng.randf_range(0.85, 1.0)))
		var mmi := MultiMeshInstance3D.new()
		mmi.multimesh = mm
		mmi.position = origin
		mmi.cast_shadow = GeometryInstance3D.SHADOW_CASTING_SETTING_ON
		mmi.visibility_range_end = 2200.0
		add_child(mmi)


# ------------------------------------------------------------------ фонари и станции

func _lamp_parts() -> Array:
	# Типовой городской светильник консольного типа: опора 9 м, консоль, плоский светильник.
	var metal := StandardMaterial3D.new()
	metal.albedo_color = Color(0.42, 0.44, 0.46)
	metal.metallic = 0.7
	metal.roughness = 0.45
	var pole := CylinderMesh.new()
	pole.top_radius = 0.06
	pole.bottom_radius = 0.11
	pole.height = 9.0
	pole.radial_segments = 10
	pole.material = metal
	var arm := CylinderMesh.new()
	arm.top_radius = 0.04
	arm.bottom_radius = 0.05
	arm.height = 1.9
	arm.radial_segments = 8
	arm.material = metal
	var head := BoxMesh.new()
	head.size = Vector3(0.32, 0.12, 0.7)
	var hm := ShaderMaterial.new()
	hm.shader = load("res://shaders/lamp_head.gdshader")
	head.material = hm
	var arm_t := Transform3D(Basis(Vector3.RIGHT, deg_to_rad(75)), Vector3(0, 8.95, -0.9))
	return [[pole, Transform3D(Basis(), Vector3(0, 4.5, 0))], [arm, arm_t], [head, Transform3D(Basis(Vector3.RIGHT, deg_to_rad(-8)), Vector3(0, 9.15, -1.85))]]


func _instance_parts(parts: Array, transforms: Array, range_end := 900.0) -> void:
	var by_chunk := {}
	for t in transforms:
		var k := _chunk_key(t.origin.x, -t.origin.z)
		if not by_chunk.has(k):
			by_chunk[k] = []
		by_chunk[k].append(t)
	for part in parts:
		for k in by_chunk:
			var list: Array = by_chunk[k]
			var origin := Vector3((k.x + 0.5) * CHUNK, 0, -(k.y + 0.5) * CHUNK)
			var mm := MultiMesh.new()
			mm.transform_format = MultiMesh.TRANSFORM_3D
			mm.mesh = part[0]
			mm.instance_count = list.size()
			for i in list.size():
				var t: Transform3D = list[i]
				t.origin -= origin
				mm.set_instance_transform(i, t * part[1])
			var mmi := MultiMeshInstance3D.new()
			mmi.multimesh = mm
			mmi.position = origin
			mmi.visibility_range_end = range_end
			add_child(mmi)


func _instance_glb(path: String, transforms: Array) -> void:
	var scene: PackedScene = load(path)
	if scene == null:
		return
	var probe := scene.instantiate()
	var by_chunk := {}
	for t in transforms:
		var k := _chunk_key(t.origin.x, -t.origin.z)
		if not by_chunk.has(k):
			by_chunk[k] = []
		by_chunk[k].append(t)
	for mi in probe.find_children("*", "MeshInstance3D", true, false):
		var local: Transform3D = Transform3D()
		var n: Node = mi
		while n != probe and n is Node3D:
			local = (n as Node3D).transform * local
			n = n.get_parent()
		for k in by_chunk:
			var list: Array = by_chunk[k]
			var origin := Vector3((k.x + 0.5) * CHUNK, 0, -(k.y + 0.5) * CHUNK)
			var mm := MultiMesh.new()
			mm.transform_format = MultiMesh.TRANSFORM_3D
			mm.mesh = mi.mesh
			mm.instance_count = list.size()
			for i in list.size():
				var t: Transform3D = list[i]
				t.origin -= origin
				mm.set_instance_transform(i, t * local)
			var mmi := MultiMeshInstance3D.new()
			mmi.multimesh = mm
			mmi.position = origin
			mmi.visibility_range_end = 900.0
			add_child(mmi)
	probe.queue_free()


func _build_lamps() -> void:
	var xforms := []
	for l in data.get("lamps", []):
		lamp_points.append(Vector3(l[0], 8.6, -l[1]))
		xforms.append(Transform3D(Basis(), Vector3(l[0], 0, -l[1])))
	# Вдоль магистралей ставим фонари с шагом 40 м (в OSM опоры отмечены не везде — это оформление, не данные)
	for r in data["roads"]:
		if r[2] < 2 or r[2] == 5:
			continue
		var pts := _flat_to_points(r[0])
		var off: float = r[1] * 0.5 + 1.2
		var acc := 0.0
		for i in pts.size() - 1:
			var a := pts[i]
			var c := pts[i + 1]
			var len := a.distance_to(c)
			if len < 0.1:
				continue
			var d := (c - a) / len
			var nrm := Vector2(-d.y, d.x)
			while acc < len:
				for side in [-1.0, 1.0]:
					var p: Vector2 = a + d * acc + nrm * off * side
					# консоль смотрит на дорогу: локальная −Z → направление к оси дороги
					var to_road := Vector3(-nrm.x * side, 0, nrm.y * side)
					var yaw: float = atan2(-to_road.x, -to_road.z)
					xforms.append(Transform3D(Basis(Vector3.UP, yaw), Vector3(p.x, 0, -p.y)))
					lamp_points.append(Vector3(p.x, 8.6, -p.y) + to_road * 1.8)
				acc += 40.0
			acc -= len
	_instance_parts(_lamp_parts(), xforms)


func _build_stations() -> void:
	var red := StandardMaterial3D.new()
	red.albedo_color = Color(0.85, 0.1, 0.1)
	red.emission_enabled = true
	red.emission = Color(0.9, 0.1, 0.08)
	red.emission_energy_multiplier = 1.5
	for st in data.get("stations", []):
		var p: Array = st["p"]
		var pole := MeshInstance3D.new()
		var cyl := CylinderMesh.new()
		cyl.top_radius = 0.12
		cyl.bottom_radius = 0.12
		cyl.height = 5.0
		pole.mesh = cyl
		pole.position = Vector3(p[0], 2.5, -p[1])
		add_child(pole)
		var sign := Label3D.new()
		sign.text = "М"
		sign.font_size = 256
		sign.outline_size = 0
		sign.modulate = Color(0.95, 0.12, 0.1)
		sign.billboard = BaseMaterial3D.BILLBOARD_FIXED_Y
		sign.position = Vector3(p[0], 5.6, -p[1])
		sign.pixel_size = 0.006
		add_child(sign)
		var name := Label3D.new()
		name.text = st["name"]
		name.font_size = 64
		name.billboard = BaseMaterial3D.BILLBOARD_FIXED_Y
		name.position = Vector3(p[0], 4.4, -p[1])
		name.pixel_size = 0.006
		add_child(name)
		stations.append({"name": st["name"], "pos": Vector3(p[0], 0, -p[1])})
