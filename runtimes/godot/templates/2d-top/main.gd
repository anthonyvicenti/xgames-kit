## THE GAME'S OWN SCENE SCRIPT (the build agent's file, like rules.js). Written by create for a 2D game seen from above
## on runtime godot: the field from the map, this player's body and controls (eight ways, no gravity), the friends and
## a camera. Change anything; the kit's side is the GF autoload (addons/gf/gf.gd) and the round, the menu, the HUD and
## the sounds stay the kit's.
extends Node2D

var stage: GfTilemap2D
var friends: GfFriends2D
var bots: GfBots2D
var me: CharacterBody2D
var body: GfFlatBody
var cam: Camera2D


func _ready() -> void:
	await GF.boot()
	RenderingServer.set_default_clear_color(Color(String(GF.value("look.background", "#2b3a2a"))))
	GF.value_changed.connect(_value_changed)
	var pixel := GF.style == "pixel"
	# near over far: the bodies and the set pieces (houses, trees) are ordered by where they stand, so a body walks
	# behind a roof and in front of a door; the ground lies under all of it
	y_sort_enabled = true
	stage = GfTilemap2D.new()
	stage.z_index = -1
	add_child(stage)
	var tiles := {}
	for kind in GF.world.get("kinds", {}):
		if GF.has_slot("world.tiles." + kind):
			tiles[kind] = await GF.texture("world.tiles." + kind)
	# every picture the field's plan draws (GF.world.plan: tiles, soft edges, dressing, set pieces)
	var plan_tex := {}
	for slot in GF.world.get("plan", {}).get("slots", []):
		plan_tex[slot] = await GF.texture(slot)
	stage.build(GF.world, tiles, GF.ppm, pixel, plan_tex)
	add_child(stage.pieces)
	var sheet := await GF.texture("character.body.player")
	var height := float(GF.value("character.height.player", 1.7))
	friends = GfFriends2D.new()
	friends.sheet = sheet
	friends.height_m = height
	friends.y_sort_enabled = true
	add_child(friends)
	# alone, the kit fills the empty seats with bots (a friends round has none): they move like this player
	bots = GfBots2D.new()
	bots.sheet = sheet
	bots.height_m = height
	bots.y_sort_enabled = true
	add_child(bots)
	me = CharacterBody2D.new()
	me.motion_mode = CharacterBody2D.MOTION_MODE_FLOATING
	me.collision_layer = 0
	me.collision_mask = GfTilemap2D.LAYER_SOLID
	var shape := CollisionShape2D.new()
	var feet := CircleShape2D.new()
	feet.radius = 0.32 * GF.ppm
	shape.shape = feet
	shape.position = Vector2(0, -feet.radius)
	me.add_child(shape)
	body = GfFlatBody.new()
	body.setup(sheet, height, GF.ppm, GF.me.get("color"), pixel)
	me.add_child(body)
	add_child(me)
	me.position = GF.spawn(int(GF.me.get("seat", 0)))
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
	cam.limit_top = int(ext.position.y)
	cam.limit_bottom = int(ext.end.y)
	_fit_camera()
	get_viewport().size_changed.connect(_fit_camera)


func _process(_dt: float) -> void:
	_follow_camera()


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
	var speed := float(GF.value("controller.speed", 5.2)) * GF.ppm
	var dir := Input.get_vector("move_left", "move_right", "move_up", "move_down") if GF.input_on else Vector2.ZERO
	me.velocity = me.velocity.move_toward(dir * speed, speed * 12.0 * dt)
	me.move_and_slide()
	body.tick_top(dt, me.velocity)
	GF.set_pose(me.position, body.face, body.anim, {"look": body.look})
