## A gf-humanoid-1 body (runtimes/three/kit/character/RIG.md) on Godot: a rigged GLB from a model slot, read at run time
## (GF.bytes through Godot's GLTFDocument, so a replaced model reaches the game with no new export), played with the
## kit's shared clip file through the standard's retarget (GfRig3D), scaled to a height, its tint materials in the
## seat colour (as three's character.js: tint_* or gfTint, by gfTintMix), turned to where it heads.
##
##   var body_tpl := await GfHumanoid3D.load_model("character.body.player")      # once each: parsed, kept hidden
##   var clips_tpl := await GfHumanoid3D.load_model(GfHumanoid3D.CLIP_FILE)
##   var body := GfHumanoid3D.new()
##   body.setup(body_tpl, clips_tpl, GF.value("character.height.player", 1.7), GF.me.color)
##   body.tick(dt, velocity, on_floor)        # this player: the clip and the turn from how it moves
##   body.show_anim("walk", yaw)              # a friend or a bot: from what its pose says
class_name GfHumanoid3D
extends Node3D

## The kit's shared clip file in a game (gf-humanoid-1 clips: idle, walk, run, jump, fall, land, hit, knockdown, …).
const CLIP_FILE := "assets/clips/gf-humanoid-1.glb"
## The clip for each word a pose carries.
const WORDS := {"idle": "idle", "walk": "walk", "run": "run", "jump": "jump", "air": "fall", "act": "interact", "down": "knockdown", "hit": "hit", "wave": "emote_wave", "cheer": "emote_cheer"}
const LOOPS := ["idle", "walk", "run", "fall", "sprint", "carry", "crouch", "crouch_walk", "swim", "swim_idle", "emote_dance", "emote_talk", "aim", "block"]

var model: Node3D
var rig: GfRig3D
var anim := "idle"
var yaw := 0.0
var height_m := 1.7
var _proxy: Node3D
var _player: AnimationPlayer
var _clip := ""
var _act := 0.0


## A GLB in a slot (or a path in the game), parsed once: a hidden node to copy from (null when it could not be read).
static func load_model(slot_or_path: String) -> Node3D:
	var b: PackedByteArray = await GF.bytes(slot_or_path)
	if b.is_empty():
		return null
	var doc := GLTFDocument.new()
	var state := GLTFState.new()
	if doc.append_from_buffer(b, "", state) != OK:
		push_error("GF: %s is not a glTF binary (GLB) Godot can read" % slot_or_path)
		return null
	var scene: Node3D = doc.generate_scene(state)
	scene.visible = false
	scene.process_mode = Node.PROCESS_MODE_DISABLED
	return scene


func setup(body_tpl: Node3D, clips_tpl: Node3D, height := 1.7, color: Variant = null) -> void:
	height_m = height
	model = body_tpl.duplicate()
	model.visible = true
	model.process_mode = Node.PROCESS_MODE_INHERIT
	add_child(model)
	_proxy = clips_tpl.duplicate()
	_proxy.process_mode = Node.PROCESS_MODE_INHERIT
	add_child(_proxy)
	var sk := model.find_children("*", "Skeleton3D", true, false)
	if sk.is_empty():
		push_error("GF: the body has no skeleton (a gf-humanoid-1 body is a skinned GLB)")
		return
	var body_root := model.find_child("gf_body", true, false)
	rig = GfRig3D.new(sk[0], _proxy, body_root)
	if not rig.missing.is_empty():
		push_error("GF: the body is not gf-humanoid-1: it has no %s" % ", ".join(rig.missing))
	elif rig.height > 0.1:
		model.scale = Vector3.ONE * (height / rig.height)
	for mi in model.find_children("*", "MeshInstance3D", true, false):
		(mi as MeshInstance3D).extra_cull_margin = 2.0
	# the body's own words (gf_body extras, RIG.md): which materials take the seat colour (named tint_*, or listed in
	# gfTint) and how far (gfTintMix, default 1), and its faces (gfFaces: an expression's surfaces are hidden until it shows)
	var extras = body_root.get_meta("extras", {}) if body_root != null and body_root.has_meta("extras") else {}
	if not extras is Dictionary:
		extras = {}
	var tint_names: Array = extras.get("gfTint", [])
	var mix := float(extras.get("gfTintMix", 1.0))
	var hidden := {}
	for f in extras.get("gfFaces", {}).values():
		for n in f.get("show", []):
			hidden[n] = true
	for mi in model.find_children("*", "MeshInstance3D", true, false):
		var m := mi as MeshInstance3D
		for i in m.mesh.get_surface_count():
			var base := m.get_active_material(i)
			var name := base.resource_name if base != null else ""
			if hidden.has(name) and base is StandardMaterial3D:
				var none: StandardMaterial3D = base.duplicate()
				none.transparency = BaseMaterial3D.TRANSPARENCY_ALPHA
				none.albedo_color = Color(0, 0, 0, 0)
				m.set_surface_override_material(i, none)
			elif color != null and base is StandardMaterial3D and (name.begins_with("tint") or name in tint_names):
				var mat: StandardMaterial3D = base.duplicate()
				mat.albedo_color = base.albedo_color.lerp(Color(color), mix)
				m.set_surface_override_material(i, mat)
	var found := _proxy.find_children("*", "AnimationPlayer", true, false)
	if not found.is_empty():
		_player = found[0]
		_player.callback_mode_process = AnimationMixer.ANIMATION_CALLBACK_MODE_PROCESS_MANUAL
		for n in _player.get_animation_list():
			if String(n) in LOOPS:
				_player.get_animation(n).loop_mode = Animation.LOOP_LINEAR
	show_anim("idle", 0.0)


func _process(dt: float) -> void:
	if _player != null:
		_player.advance(dt)
	if rig != null:
		rig.apply()


## This player (or a bot): the clip from how the body moves (metres a second), turned toward where it heads.
func tick(dt: float, velocity: Vector3, on_floor: bool) -> void:
	var flat := Vector2(velocity.x, velocity.z)
	if flat.length() > 0.3:
		yaw = lerp_angle(yaw, atan2(velocity.x, velocity.z), 1.0 - exp(-dt * 14.0))
	if _act > 0.0:
		_act -= dt
		show_anim("act", yaw)
	elif not on_floor:
		show_anim("jump" if velocity.y > 1.0 else "air", yaw)
	elif flat.length() > 4.5:
		show_anim("run", yaw)
	elif flat.length() > 0.3:
		show_anim("walk", yaw)
	else:
		show_anim("idle", yaw)


## Half a second of the act clip (a grab, a throw, a cheer).
func act() -> void:
	_act = 0.5


## Show what a pose says: a word (idle, walk, run, jump, air, act, down, hit, wave, cheer) and a yaw.
func show_anim(word: String, y: float) -> void:
	anim = word
	yaw = y
	rotation.y = yaw
	if _player == null:
		return
	var n: String = WORDS.get(word, word)
	if not _player.has_animation(n):
		n = "idle"
	if n != _clip and _player.has_animation(n):
		_clip = n
		_player.play(n, 0.15)


## The box the body covers on screen, as fractions of the view, and whether it is in view (for the kit's name tags and
## the multiplayer gate): from its feet and the top of its head.
func screen_box(cam: Camera3D) -> Dictionary:
	var feet := global_position
	var head := feet + Vector3(0, height_m, 0)
	var size := get_viewport().get_visible_rect().size
	if cam.is_position_behind(head) or cam.is_position_behind(feet):
		return {"on": false, "box": Rect2()}
	var a := cam.unproject_position(head) / size
	var b := cam.unproject_position(feet) / size
	var h := absf(b.y - a.y)
	var w := h * 0.45 * size.y / size.x
	var box := Rect2(Vector2((a.x + b.x) / 2.0 - w / 2.0, minf(a.y, b.y)), Vector2(w, h))
	var c := box.get_center()
	return {"on": visible and c.x >= 0.0 and c.x <= 1.0 and c.y >= 0.0 and c.y <= 1.0 and h * size.y > 6.0, "box": box}
