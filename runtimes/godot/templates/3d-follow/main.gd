## THE GAME'S OWN SCENE SCRIPT (the build agent's file, like rules.js). Written by create for a 3D game on runtime godot
## (profile 3d, a three-quarter follow camera): the arena from the map, this player's gf-humanoid-1 body and controls
## (walk, run, jump; the screen's up is north), the friends, the bots, a sun and a camera. Change anything; the kit's
## side is the GF autoload (addons/gf/gf.gd) and the round, the menu, the HUD and the sounds stay the kit's.
extends Node3D

const GRAVITY := 20.0        # metres a second, a second

var arena: GfArena3D
var friends: GfFriends3D
var bots: GfBots3D
var me: CharacterBody3D
var body: GfHumanoid3D
var cam: Camera3D
var _look := Vector3.ZERO


func _ready() -> void:
	await GF.boot()
	RenderingServer.set_default_clear_color(Color(String(GF.value("look.background", "#9fd3f0"))))
	GF.value_changed.connect(_value_changed)
	var env := WorldEnvironment.new()
	env.environment = Environment.new()
	env.environment.background_mode = Environment.BG_CLEAR_COLOR
	env.environment.ambient_light_source = Environment.AMBIENT_SOURCE_COLOR
	env.environment.ambient_light_color = Color(0.75, 0.8, 0.9)
	env.environment.ambient_light_energy = 0.55
	add_child(env)
	var sun := DirectionalLight3D.new()
	sun.rotation_degrees = Vector3(-55, 35, 0)
	sun.light_energy = 1.1
	sun.shadow_enabled = true
	add_child(sun)
	arena = GfArena3D.new()
	add_child(arena)
	var tiles := {}
	for kind in GF.world.get("kinds", {}):
		if GF.has_slot("world.tiles." + kind):
			tiles[kind] = await GF.texture("world.tiles." + kind)
	arena.build(GF.world, tiles, GF.style == "pixel")
	# the body and the shared clips, parsed once (kept hidden here) and copied for every character
	var body_tpl := await GfHumanoid3D.load_model("character.body.player")
	var clips_tpl := await GfHumanoid3D.load_model(GfHumanoid3D.CLIP_FILE)
	add_child(body_tpl)
	add_child(clips_tpl)
	var height := float(GF.value("character.height.player", 1.7))
	cam = Camera3D.new()
	cam.fov = 55.0
	add_child(cam)
	cam.make_current()
	friends = GfFriends3D.new()
	friends.body_tpl = body_tpl
	friends.clips_tpl = clips_tpl
	friends.camera = cam
	friends.height_m = height
	add_child(friends)
	# alone, the kit fills the empty seats with bots (a friends round has none): they move like this player
	bots = GfBots3D.new()
	bots.body_tpl = body_tpl
	bots.clips_tpl = clips_tpl
	bots.height_m = height
	add_child(bots)
	me = CharacterBody3D.new()
	me.collision_layer = 0
	me.collision_mask = GfArena3D.LAYER_SOLID
	var shape := CollisionShape3D.new()
	var capsule := CapsuleShape3D.new()
	capsule.radius = 0.3
	capsule.height = height * 0.95
	shape.shape = capsule
	shape.position = Vector3(0, capsule.height / 2.0, 0)
	me.add_child(shape)
	add_child(me)
	body = GfHumanoid3D.new()
	me.add_child(body)
	body.setup(body_tpl, clips_tpl, height, GF.me.get("color"))
	me.position = GF.spawn3(int(GF.me.get("seat", 0)))
	GF.place_me3.connect(func(at: Vector3) -> void:
		me.position = at
		me.velocity = Vector3.ZERO)
	_look = me.position
	_follow_camera(1.0)


func _process(dt: float) -> void:
	_follow_camera(dt)


## The camera stands behind and above whom it follows (this player; a viewer's copy follows the streamer), looking
## north, look.view metres away.
func _follow_camera(dt: float) -> void:
	if cam == null:
		return
	var at = friends.at(GF.follow) if GF.watching else null
	var target: Vector3 = at if at != null else me.position
	_look = _look.lerp(target, 1.0 - exp(-dt * 8.0))
	var d := float(GF.value("look.view", 11.0))
	cam.position = _look + Vector3(0, d * 0.72, d * 0.7)
	cam.look_at(_look + Vector3(0, 1.0, 0), Vector3.UP)


## A value slot changed while the game runs (the studio page): show it now where it is read once.
func _value_changed(id: String, v: Variant) -> void:
	if id == "look.background":
		RenderingServer.set_default_clear_color(Color(String(v)))


func _physics_process(dt: float) -> void:
	if me == null:
		return
	# watching a friend's stream: this copy has no player of its own
	me.visible = not GF.watching
	if GF.watching:
		return
	var speed := float(GF.value("controller.speed", 5.2))
	var dir := Input.get_vector("move_left", "move_right", "move_up", "move_down") if GF.input_on else Vector2.ZERO
	var v := Vector3(me.velocity.x, 0, me.velocity.z).move_toward(Vector3(dir.x, 0, dir.y) * speed, speed * 12.0 * dt)
	me.velocity = Vector3(v.x, me.velocity.y - GRAVITY * dt, v.z)
	if GF.input_on and Input.is_action_just_pressed("jump") and me.is_on_floor():
		me.velocity.y = float(GF.value("controller.jump", 7.5))
	me.move_and_slide()
	if me.position.y < -10.0:
		me.position = GF.spawn3(int(GF.me.get("seat", 0)))
		me.velocity = Vector3.ZERO
	body.tick(dt, me.velocity, me.is_on_floor())
	GF.set_pose3(me.position, body.yaw, body.anim)
