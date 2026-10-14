## The bots of a 2D game played alone (the kit fills empty seats with them; a friends round has none): each one a body
## with the starter's own movement (side-on: run, jump, drop through a ledge; seen from above: walk eight ways), a
## simple head for where to go, and its pose reported to the kit (GF.report_bot), which makes it a player like any
## other: in the scores, the results, the HUD and window.__game. A game says where bots head with `goal`, and reports
## what they do with GF.event_as(bot_id, name, data).
##
##   var bots := GfBots2D.new()
##   bots.sheet = sheet                      # the body every bot wears (GF.texture("character.body.player"))
##   bots.goal = func(bot: Dictionary) -> Vector2: return nearest_coin(bot.at)   # optional: pixels, or Vector2.INF
##   add_child(bots)
##   for b in bots.near(point, 0.75 * GF.ppm): GF.event_as(b.id, "coin", {"i": i})
class_name GfBots2D
extends Node2D

const GRAVITY := 20.0         ## side-on: the starter's gravity and fall (templates/2d-side/main.gd)
const FALL := 1.7

var sheet: Texture2D
var height_m := 1.7
var goal: Callable            ## func(bot: Dictionary) -> Vector2: where a bot heads (pixels); Vector2.INF: wander
var list := {}                ## id → {id, seat, node: CharacterBody2D, body: GfFlatBody, target, think, stuck, drop}
var _rng := RandomNumberGenerator.new()


func _ready() -> void:
	_rng.seed = 7
	GF.bots_changed.connect(_sync)
	GF.phase_changed.connect(func(ph: String) -> void:
		if ph == "playing" or ph == "countdown":
			for b in list.values():
				_place(b))
	_sync(GF.bots)


## The bots within r pixels of a point (their middle, not their feet): [{id, at}].
func near(point: Vector2, r: float) -> Array:
	var out: Array = []
	for b in list.values():
		var mid: Vector2 = b.node.position + (Vector2(0, -0.8 * GF.ppm) if GF.plane == "side" else Vector2(0, -0.4 * GF.ppm))
		if mid.distance_to(point) < r:
			out.append({"id": b.id, "at": b.node.position})
	return out


func _sync(want: Array) -> void:
	var seen := {}
	for w in want:
		var id := String(w.get("id", ""))
		seen[id] = true
		if not list.has(id):
			list[id] = _make(w)
	for id in list.keys():
		if not seen.has(id):
			list[id].node.queue_free()
			list.erase(id)


func _make(w: Dictionary) -> Dictionary:
	var node := CharacterBody2D.new()
	var side := GF.plane == "side"
	node.collision_layer = 0
	node.collision_mask = GfTilemap2D.LAYER_SOLID | (GfTilemap2D.LAYER_LEDGE if side else 0)
	if not side:
		node.motion_mode = CharacterBody2D.MOTION_MODE_FLOATING
	var shape := CollisionShape2D.new()
	if side:
		var capsule := CapsuleShape2D.new()
		capsule.radius = 0.3 * GF.ppm
		capsule.height = height_m * 0.95 * GF.ppm
		shape.shape = capsule
		shape.position = Vector2(0, -capsule.height / 2.0)
	else:
		var feet := CircleShape2D.new()
		feet.radius = 0.32 * GF.ppm
		shape.shape = feet
		shape.position = Vector2(0, -feet.radius)
	node.add_child(shape)
	var body := GfFlatBody.new()
	body.setup(sheet, height_m, GF.ppm, w.get("color"), GF.style == "pixel")
	node.add_child(body)
	node.name = "Bot_" + String(w.get("id", "")).validate_node_name()
	add_child(node)
	var b := {"id": String(w.get("id", "")), "seat": int(w.get("seat", 0)), "node": node, "body": body, "target": Vector2.INF, "think": 0.0, "stuck": 0.0, "drop": 0.0, "last": Vector2.ZERO}
	_place(b)
	return b


func _place(b: Dictionary) -> void:
	b.node.position = GF.spawn(b.seat)
	b.node.velocity = Vector2.ZERO
	b.target = Vector2.INF
	b.think = 0.0


# where a bot heads: the game's goal, else a mark or a spawn picked at random
func _target(b: Dictionary) -> Vector2:
	if goal.is_valid():
		var g = goal.call({"id": b.id, "seat": b.seat, "at": b.node.position})
		if g is Vector2 and g != Vector2.INF:
			return g
	var places: Array = []
	for name in GF.world.get("marks", {}):
		places.append_array(GF.marks(name))
	for i in GF.world.get("spawns", []).size():
		places.append(GF.spawn(i))
	return places[_rng.randi() % places.size()] if not places.is_empty() else b.node.position


func _physics_process(dt: float) -> void:
	var act := GF.playing and GF.input_on
	var p := GF.ppm
	var speed := float(GF.value("controller.speed", 5.2)) * p * 0.85
	for b in list.values():
		var n: CharacterBody2D = b.node
		b.think -= dt
		if act and (b.think <= 0.0 or b.target == Vector2.INF or n.position.distance_to(b.target) < 0.4 * p):
			b.target = _target(b)
			b.think = _rng.randf_range(1.5, 3.5)
		if GF.plane == "side":
			_side(b, n, dt, act, speed)
		else:
			_top(b, n, dt, act, speed)
		# stuck: a second without getting closer → another place
		if act:
			b.stuck = b.stuck + dt if n.position.distance_to(b.last) < 0.05 * p else 0.0
			b.last = n.position
			if b.stuck > 1.0:
				b.target = Vector2.INF
				b.think = 0.0
				b.stuck = 0.0
		GF.report_bot(b.id, n.position, b.body.face, b.body.anim, {"look": b.body.look} if GF.plane == "top" else {})


func _side(b: Dictionary, n: CharacterBody2D, dt: float, act: bool, speed: float) -> void:
	var p := GF.ppm
	var dx: float = (b.target.x - n.position.x) if act and b.target != Vector2.INF else 0.0
	var dir := 0.0 if absf(dx) < 0.25 * p else signf(dx)
	n.velocity.x = move_toward(n.velocity.x, dir * speed, speed * 10.0 * dt)
	n.velocity.y += GRAVITY * p * dt * (FALL if n.velocity.y > 0.0 else 1.0)
	if act and n.is_on_floor() and b.target != Vector2.INF:
		var above: bool = b.target.y < n.position.y - 0.9 * p and absf(dx) < 4.0 * p
		var below: bool = b.target.y > n.position.y + 0.9 * p and absf(dx) < 2.0 * p
		if above or n.is_on_wall() or b.stuck > 0.4:
			n.velocity.y = -float(GF.value("controller.jump", 10.5)) * p
		elif below:
			b.drop = 0.25
	b.drop = maxf(0.0, b.drop - dt)
	n.set_collision_mask_value(2, b.drop <= 0.0)
	n.move_and_slide()
	if n.position.y > 20 * p:
		_place(b)
	b.body.tick(dt, n.velocity, n.is_on_floor())


func _top(b: Dictionary, n: CharacterBody2D, dt: float, act: bool, speed: float) -> void:
	var to: Vector2 = (b.target - n.position) if act and b.target != Vector2.INF else Vector2.ZERO
	var dir := to.normalized() if to.length() > 0.2 * GF.ppm else Vector2.ZERO
	n.velocity = n.velocity.move_toward(dir * speed, speed * 10.0 * dt)
	n.move_and_slide()
	b.body.tick_top(dt, n.velocity)
