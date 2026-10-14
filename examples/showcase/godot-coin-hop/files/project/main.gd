## Coin Hop's scene script: create's side-on starter (the stage from the map, this player, the friends, the camera)
## plus the coins. A coin sits on every "mark:coin" of the map; it is drawn while the host's shared state says it is
## there (GF.shared.coins.t[i] == 0), and touching one tells rules.js (GF.event("coin", {i})), which asks the host.
extends Node2D

const GRAVITY := 20.0        # metres a second, a second: a jump of 10.5 m/s rises 2.76 m (the map's reach rule)
const FALL := 1.7            # falling is this much heavier than rising (the reach rule's fallScale)

var stage: GfTilemap2D
var friends: GfFriends2D
var bots: GfBots2D
var me: CharacterBody2D
var body: GfFlatBody
var cam: Camera2D
var _drop := 0.0
var coins: Array[Sprite2D] = []
var _asked := {}             # coin index → seconds until this copy may ask for it again
var _t := 0.0


func _ready() -> void:
	await GF.boot()
	RenderingServer.set_default_clear_color(Color(String(GF.value("look.background", "#1d2236"))))
	GF.value_changed.connect(_value_changed)
	var pixel := GF.style == "pixel"
	stage = GfTilemap2D.new()
	add_child(stage)
	var tiles := {}
	for kind in GF.world.get("kinds", {}):
		if GF.has_slot("world.tiles." + kind):
			tiles[kind] = await GF.texture("world.tiles." + kind)
	stage.build(GF.world, tiles, GF.ppm, pixel)
	var sheet := await GF.texture("character.body.player")
	var height := float(GF.value("character.height.player", 1.7))
	friends = GfFriends2D.new()
	friends.sheet = sheet
	friends.height_m = height
	add_child(friends)
	# alone, the kit fills the empty seats with bots (a friends round has none): they move like this player
	bots = GfBots2D.new()
	bots.sheet = sheet
	bots.height_m = height
	bots.goal = _nearest_coin
	add_child(bots)
	me = CharacterBody2D.new()
	me.collision_layer = 0
	me.collision_mask = GfTilemap2D.LAYER_SOLID | GfTilemap2D.LAYER_LEDGE
	var shape := CollisionShape2D.new()
	var capsule := CapsuleShape2D.new()
	capsule.radius = 0.3 * GF.ppm
	capsule.height = height * 0.95 * GF.ppm
	shape.shape = capsule
	shape.position = Vector2(0, -capsule.height / 2.0)
	me.add_child(shape)
	body = GfFlatBody.new()
	body.setup(sheet, height, GF.ppm, GF.me.get("color"), pixel)
	me.add_child(body)
	add_child(me)
	await _make_coins()
	me.position = GF.spawn(int(GF.me.get("seat", 0)))
	GF.observe = func() -> Dictionary: return {"coinsDrawn": coins.filter(func(c): return c.visible).size(), "coins": coins.size()}
	GF.place_me.connect(func(at: Vector2) -> void:
		me.position = at
		me.velocity = Vector2.ZERO)
	cam = Camera2D.new()
	cam.position_smoothing_enabled = true
	add_child(cam)
	cam.position = me.position
	cam.make_current()
	var ext := stage.extent()
	cam.limit_left = int(ext.position.x)
	cam.limit_right = int(ext.end.x)
	cam.limit_top = int(ext.position.y - 4 * GF.ppm)
	cam.limit_bottom = int(ext.end.y)
	_fit_camera()
	get_viewport().size_changed.connect(_fit_camera)


func _make_coins() -> void:
	var tex := await GF.texture("game.coin")
	var size_m := float(GF.value("rules.coin-size", 0.6))
	for at in GF.marks("coin"):
		var c := Sprite2D.new()
		c.texture = tex
		c.texture_filter = CanvasItem.TEXTURE_FILTER_NEAREST if GF.style == "pixel" else CanvasItem.TEXTURE_FILTER_LINEAR
		var s := size_m * GF.ppm / float(tex.get_height())
		c.scale = Vector2(s, s)
		c.position = at
		c.set_meta("home", at)
		add_child(c)
		coins.append(c)


func _process(dt: float) -> void:
	_follow_camera()
	_t += dt
	var t: Array = GF.shared.get("coins", {}).get("t", [])
	for i in coins.size():
		var c := coins[i]
		c.visible = i < t.size() and float(t[i]) == 0.0
		c.position = c.get_meta("home") + Vector2(0, sin(_t * 3.0 + i) * 0.08 * GF.ppm)
	for k in _asked.keys():
		_asked[k] -= dt
		if _asked[k] <= 0.0:
			_asked.erase(k)
	if me == null or not GF.playing or GF.watching:
		return
	var centre := me.position + Vector2(0, -0.8 * GF.ppm)
	for i in coins.size():
		if coins[i].visible and not _asked.has(i) and centre.distance_to(coins[i].get_meta("home")) < 0.75 * GF.ppm:
			_asked[i] = 0.6
			body.act()
			GF.event("coin", {"i": i})
	# a bot that touches a coin asks for it the same way, as itself
	for i in coins.size():
		if not coins[i].visible:
			continue
		for b in bots.near(coins[i].get_meta("home"), 0.75 * GF.ppm):
			var key := "%s:%d" % [b.id, i]
			if not _asked.has(key):
				_asked[key] = 0.6
				GF.event_as(b.id, "coin", {"i": i})


## Where a bot heads: the nearest coin that is up (Vector2.INF: none, so it wanders).
func _nearest_coin(bot: Dictionary) -> Vector2:
	var best := Vector2.INF
	for c in coins:
		if c.visible and (best == Vector2.INF or bot.at.distance_to(c.get_meta("home")) < bot.at.distance_to(best)):
			best = c.get_meta("home")
	return best


## The camera follows this player; a viewer's copy (watch then play: GF.watching) follows the streamer instead.
func _follow_camera() -> void:
	if cam == null:
		return
	var at = friends.at(GF.follow) if GF.watching else null
	cam.position = at if at != null else me.position


## A value slot changed while the game runs (the studio page): show it now where it is read once.
func _value_changed(id: String, v: Variant) -> void:
	if id == "look.background":
		RenderingServer.set_default_clear_color(Color(String(v)))
	elif id == "look.view":
		_fit_camera()


## The view shows look.view metres from top to bottom; pixel art at a whole number of screen pixels a texel.
func _fit_camera() -> void:
	var h := get_viewport().get_visible_rect().size.y
	var z := h / (float(GF.value("look.view", 12.0)) * GF.ppm)
	if GF.style == "pixel":
		z = maxf(1.0, roundf(z))
	cam.zoom = Vector2(z, z)


func _physics_process(dt: float) -> void:
	if me == null:
		return
	# watching a friend's stream: this copy has no player of its own
	me.visible = not GF.watching
	if GF.watching:
		return
	var p := GF.ppm
	var speed := float(GF.value("controller.speed", 5.2)) * p
	var jump := float(GF.value("controller.jump", 10.5)) * p
	var dir := Input.get_axis("move_left", "move_right") if GF.input_on else 0.0
	me.velocity.x = move_toward(me.velocity.x, dir * speed, speed * 12.0 * dt)
	me.velocity.y += GRAVITY * p * dt * (FALL if me.velocity.y > 0.0 else 1.0)
	if GF.input_on and Input.is_action_just_pressed("jump") and me.is_on_floor():
		if Input.is_action_pressed("move_down"):
			_drop = 0.25
		else:
			me.velocity.y = -jump
	if GF.input_on and Input.is_action_just_pressed("move_down") and me.is_on_floor():
		_drop = 0.25
	_drop = maxf(0.0, _drop - dt)
	me.set_collision_mask_value(2, _drop <= 0.0)
	me.move_and_slide()
	if me.position.y > 20 * p:
		me.position = GF.spawn(int(GF.me.get("seat", 0)))
		me.velocity = Vector2.ZERO
	body.tick(dt, me.velocity, me.is_on_floor())
	GF.set_pose(me.position, body.face, body.anim)
