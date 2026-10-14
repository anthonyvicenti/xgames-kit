## The bots of a 3D game played alone (the kit fills empty seats with them; a friends round has none): each a
## gf-humanoid-1 body with the starter's movement (walk, run, jump), a simple head for where to go (the game's `goal`,
## else a mark or a spawn), and its pose reported to the kit (GF.report_bot3): a player like any other in the scores,
## the results, the HUD and window.__game. A game reports what a bot does with GF.event_as(bot_id, name, data).
##
##   var bots := GfBots3D.new()
##   bots.body_tpl = body_tpl; bots.clips_tpl = clips_tpl
##   bots.goal = func(bot: Dictionary) -> Vector3: return nearest_coin(bot.at)   # optional; Vector3.INF: wander
##   add_child(bots)
class_name GfBots3D
extends Node3D

const GRAVITY := 20.0

var body_tpl: Node3D
var clips_tpl: Node3D
var height_m := 1.7
var goal: Callable
var list := {}
var _rng := RandomNumberGenerator.new()


func _ready() -> void:
	_rng.seed = 7
	GF.bots_changed.connect(_sync)
	GF.phase_changed.connect(func(ph: String) -> void:
		if ph == "playing" or ph == "countdown":
			for b in list.values():
				_place(b))
	_sync(GF.bots)


## The bots within r metres of a point: [{id, at}].
func near(point: Vector3, r: float) -> Array:
	var out: Array = []
	for b in list.values():
		if (b.node.position + Vector3(0, 0.8, 0)).distance_to(point) < r:
			out.append({"id": b.id, "at": b.node.position})
	return out


func _sync(want: Array) -> void:
	var seen := {}
	for w in want:
		var id := String(w.get("id", ""))
		seen[id] = true
		if not list.has(id) and body_tpl != null:
			list[id] = _make(w)
	for id in list.keys():
		if not seen.has(id):
			list[id].node.queue_free()
			list.erase(id)


func _make(w: Dictionary) -> Dictionary:
	var node := CharacterBody3D.new()
	node.collision_layer = 0
	node.collision_mask = GfArena3D.LAYER_SOLID
	var shape := CollisionShape3D.new()
	var capsule := CapsuleShape3D.new()
	capsule.radius = 0.3
	capsule.height = height_m * 0.95
	shape.shape = capsule
	shape.position = Vector3(0, capsule.height / 2.0, 0)
	node.add_child(shape)
	node.name = "Bot_" + String(w.get("id", "")).validate_node_name()
	add_child(node)
	var body := GfHumanoid3D.new()
	node.add_child(body)
	body.setup(body_tpl, clips_tpl, height_m, w.get("color"))
	var b := {"id": String(w.get("id", "")), "seat": int(w.get("seat", 0)), "node": node, "body": body, "target": Vector3.INF, "think": 0.0, "stuck": 0.0, "last": Vector3.ZERO}
	_place(b)
	return b


func _place(b: Dictionary) -> void:
	b.node.position = GF.spawn3(b.seat)
	b.node.velocity = Vector3.ZERO
	b.target = Vector3.INF
	b.think = 0.0


func _target(b: Dictionary) -> Vector3:
	if goal.is_valid():
		var g = goal.call({"id": b.id, "seat": b.seat, "at": b.node.position})
		if g is Vector3 and g != Vector3.INF:
			return g
	var places: Array = []
	for name in GF.world.get("marks", {}):
		places.append_array(GF.marks3(name))
	for i in GF.world.get("spawns", []).size():
		places.append(GF.spawn3(i))
	return places[_rng.randi() % places.size()] if not places.is_empty() else b.node.position


func _physics_process(dt: float) -> void:
	var act := GF.playing and GF.input_on
	var speed := float(GF.value("controller.speed", 5.2)) * 0.85
	for b in list.values():
		var n: CharacterBody3D = b.node
		b.think -= dt
		if act and (b.think <= 0.0 or b.target == Vector3.INF or Vector2(n.position.x - b.target.x, n.position.z - b.target.z).length() < 0.5):
			b.target = _target(b)
			b.think = _rng.randf_range(1.5, 3.5)
		var to := Vector3.ZERO
		if act and b.target != Vector3.INF:
			to = Vector3(b.target.x - n.position.x, 0, b.target.z - n.position.z)
		var dir := to.normalized() if to.length() > 0.3 else Vector3.ZERO
		var v := Vector3(n.velocity.x, 0, n.velocity.z).move_toward(dir * speed, speed * 10.0 * dt)
		n.velocity = Vector3(v.x, n.velocity.y - GRAVITY * dt, v.z)
		if act and n.is_on_floor() and (n.is_on_wall() or b.stuck > 0.4):
			n.velocity.y = float(GF.value("controller.jump", 7.5))
		n.move_and_slide()
		if n.position.y < -10.0:
			_place(b)
		if act:
			b.stuck = b.stuck + dt if n.position.distance_to(b.last) < 0.02 else 0.0
			b.last = n.position
			if b.stuck > 1.0:
				b.target = Vector3.INF
				b.think = 0.0
				b.stuck = 0.0
		b.body.tick(dt, n.velocity, n.is_on_floor())
		GF.report_bot3(b.id, n.position, b.body.yaw, b.body.anim)
