## THE GAME'S OWN SCENE SCRIPT (the build agent's file, like rules.js). Written by create for a side-on 2D game on
## runtime godot: the stage from the map, this player's body and controls, the friends and a camera. Change anything;
## the kit's side is the GF autoload (addons/gf/gf.gd) and the round, the menu, the HUD and the sounds stay the kit's.
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
	cam.limit_top = int(ext.position.y - 4 * GF.ppm)
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
