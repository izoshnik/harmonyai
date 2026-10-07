## Места для взаимодействия из реальных точек OSM: магазины, кафе, аптеки, банкоматы, АЗС, станции метро.
## Цены — игровые значения (не данные). Подпись с названием видна вблизи.
class_name Places
extends Node3D

const OFFERS := {
	"food": [["Хлеб и молоко", 140, 8], ["Готовый обед", 390, 30], ["Вода", 60, 3]],
	"cafe": [["Шаверма", 290, 25], ["Кофе", 190, 6], ["Бизнес-ланч", 450, 35]],
	"pharmacy": [["Бинт и антисептик", 250, 20], ["Аптечка", 900, 60]],
	"fuel": [["Хот-дог", 180, 12], ["Кофе с собой", 150, 5]],
}
const KIND_NAMES := {"food": "Магазин", "cafe": "Кафе", "pharmacy": "Аптека", "atm": "Банкомат", "fuel": "АЗС"}
const METRO_FARE := 70  # ₽, игровое значение

var hud: Node
var player: Player


class Place:
	extends Node3D
	var kind := ""
	var title := ""
	var places: Places
	var interact_radius := 3.0

	func get_prompt(_p: Player) -> String:
		if kind == "metro":
			return "Метро «%s»: поехать" % title
		return "%s%s" % [Places.KIND_NAMES.get(kind, ""), (" «%s»" % title) if title != "" else ""]

	func interact(p: Player) -> void:
		places.open(self, p)


func build(data: Dictionary, p: Player, h: Node, stations: Array) -> void:
	player = p
	hud = h
	for poi in data.get("poi", []):
		_add(poi[2], poi[3], Vector3(poi[0], 0, -poi[1]), true)
	for st in stations:
		_add("metro", st["name"], st["pos"], false)


func _add(kind: String, title: String, pos: Vector3, label: bool) -> void:
	var pl := Place.new()
	pl.kind = kind
	pl.title = title
	pl.places = self
	pl.position = pos
	add_child(pl)
	pl.add_to_group("interactable")
	if label and title != "":
		var l := Label3D.new()
		l.text = title
		l.font_size = 48
		l.outline_size = 8
		l.pixel_size = 0.005
		l.position.y = 3.2
		l.billboard = BaseMaterial3D.BILLBOARD_FIXED_Y
		l.visibility_range_end = 45.0
		l.modulate = Color(1, 0.95, 0.85)
		pl.add_child(l)


func open(pl: Place, p: Player) -> void:
	match pl.kind:
		"atm":
			hud.open_menu(pl.get_prompt(p), [["Снять 2 000 ₽ со счёта", func(): _withdraw(p, 2000)], ["Снять 5 000 ₽ со счёта", func(): _withdraw(p, 5000)]])
		"metro":
			var opts := []
			for other in get_children():
				if other is Place and other.kind == "metro" and other != pl:
					var dest: Place = other
					opts.append(["→ %s  (%d ₽)" % [dest.title, METRO_FARE], func(): _ride(p, dest)])
			hud.open_menu("Метро «%s»" % pl.title, opts)
		_:
			var opts2 := []
			for o in OFFERS.get(pl.kind, []):
				var item: Array = o
				opts2.append(["%s — %d ₽ (+%d HP)" % [item[0], item[1], item[2]], func(): _buy(p, item)])
			hud.open_menu(pl.get_prompt(p), opts2)


func _buy(p: Player, item: Array) -> void:
	if p.add_money(-int(item[1]) * 100, item[0]):
		p.heal(float(item[2]))


func _withdraw(p: Player, rub: int) -> void:
	if p.bank < rub * 100:
		hud.toast("Недостаточно средств на счёте")
		return
	p.bank -= rub * 100
	p.add_money(rub * 100, "Снятие наличных")


func _ride(p: Player, dest: Place) -> void:
	if not p.add_money(-METRO_FARE * 100, "Проезд в метро"):
		return
	hud.fade(func():
		p.global_position = dest.global_position + Vector3(4, 0.5, 4)
		p.velocity = Vector3.ZERO
		hud.toast("Станция «%s»" % dest.title))
