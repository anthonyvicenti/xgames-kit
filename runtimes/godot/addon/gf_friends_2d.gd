## The other players, drawn where the kit says they are (GF.peers: the net's poses, already smoothed 130 ms behind),
## each as a gf-flat-1 body in their seat colour, and reported back to the kit: where this copy draws them and
## whether they are in view (the multiplayer gate reads both from window.__game). Name tags are the kit's (the page
## draws them over the canvas, from the box reported here).
##
##   var friends := GfFriends2D.new()
##   friends.sheet = await GF.texture("character.body.player")
##   add_child(friends)
class_name GfFriends2D
extends Node2D

var sheet: Texture2D           ## the body every friend wears (a sheet per seat: set sheets instead)
var sheets := {}               ## seat → Texture2D, when seats wear different bodies
var height_m := 1.7
var bodies := {}               ## id → {body: GfFlatBody, pos: Vector2, color}


func _process(dt: float) -> void:
	var seen := {}
	for p in GF.peers:
		var id := String(p.get("id", ""))
		if id == "":
			continue
		seen[id] = true
		var f = bodies.get(id)
		if f != null and f.color != p.get("color"):
			f.body.queue_free()
			f = null
		if f == null:
			f = _make(p)
		var target: Vector2 = p.at
		if f.pos == null or f.pos.distance_to(target) > 6.0 * GF.ppm:
			f.pos = target
		else:
			f.pos = f.pos.lerp(target, 1.0 - exp(-dt * 22.0))
		f.body.position = f.pos
		f.body.show_anim(String(p.get("anim", "idle")), int(p.get("face", 1)), dt, String(p.get("look", "")))
		_report(id, f)
	for id in bodies.keys():
		if not seen.has(id):
			bodies[id].body.queue_free()
			bodies.erase(id)
			GF.forget_friend(id)


## Where this copy draws a friend now (pixels, feet), or null when it does not draw them.
func at(id: String) -> Variant:
	var f = bodies.get(id)
	return f.pos if f != null else null


func _make(p: Dictionary) -> Dictionary:
	var body := GfFlatBody.new()
	var seat := int(p.get("seat", 0))
	var tex: Texture2D = sheets.get(seat, sheet)
	body.setup(tex, height_m, GF.ppm, p.get("color"), GF.style == "pixel")
	body.name = "Friend_" + String(p.get("id", "")).validate_node_name()
	add_child(body)
	var f := {"body": body, "pos": null, "color": p.get("color")}
	bodies[String(p.get("id", ""))] = f
	return f


func _report(id: String, f: Dictionary) -> void:
	var body: GfFlatBody = f.body
	var xf := body.get_global_transform_with_canvas()
	var size := get_viewport().get_visible_rect().size
	var b := body.box()
	var a := xf * b.position
	var z := xf * b.end
	var box := Rect2(Vector2(minf(a.x, z.x), minf(a.y, z.y)) / size, (Vector2(absf(z.x - a.x), absf(z.y - a.y))) / size)
	var centre := box.get_center()
	var on := body.visible and centre.x >= 0.0 and centre.x <= 1.0 and centre.y >= 0.0 and centre.y <= 1.0 and box.size.y * size.y > 6.0
	GF.report_friend(id, f.pos, on, box)
