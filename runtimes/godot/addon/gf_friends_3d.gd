## The other players in a 3D game, drawn where the kit says they are (GF.peers: the net's poses, smoothed 130 ms
## behind), each a gf-humanoid-1 body in their seat colour playing what their pose says, and reported back to the kit:
## where this copy draws them and the screen box their body covers (the multiplayer gate and the name tags read both).
##
##   var friends := GfFriends3D.new()
##   friends.body_tpl = body_tpl; friends.clips_tpl = clips_tpl; friends.camera = cam
##   add_child(friends)
class_name GfFriends3D
extends Node3D

var body_tpl: Node3D
var clips_tpl: Node3D
var camera: Camera3D
var height_m := 1.7
var bodies := {}               ## id → {body: GfHumanoid3D, pos: Vector3, color}


func _process(dt: float) -> void:
	var seen := {}
	for p in GF.peers:
		var id := String(p.get("id", ""))
		if id == "" or body_tpl == null:
			continue
		seen[id] = true
		var f = bodies.get(id)
		if f != null and f.color != p.get("color"):
			f.body.queue_free()
			f = null
		if f == null:
			var body := GfHumanoid3D.new()
			body.name = "Friend_" + id.validate_node_name()
			add_child(body)
			body.setup(body_tpl, clips_tpl, height_m, p.get("color"))
			f = {"body": body, "pos": null, "color": p.get("color")}
			bodies[id] = f
		var target: Vector3 = p.get("at3", Vector3.ZERO)
		if f.pos == null or f.pos.distance_to(target) > 6.0:
			f.pos = target
		else:
			f.pos = f.pos.lerp(target, 1.0 - exp(-dt * 22.0))
		f.body.position = f.pos
		f.body.show_anim(String(p.get("anim", "idle")), float(p.get("yaw", 0.0)))
		if camera != null:
			var b: Dictionary = f.body.screen_box(camera)
			GF.report_friend3(id, f.pos, b.on, b.box)
	for id in bodies.keys():
		if not seen.has(id):
			bodies[id].body.queue_free()
			bodies.erase(id)
			GF.forget_friend(id)


## Where this copy draws a friend now (metres, feet), or null when it does not draw them.
func at(id: String) -> Variant:
	var f = bodies.get(id)
	return f.pos if f != null else null
