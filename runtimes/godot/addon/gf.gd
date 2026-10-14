## GF: a Godot game's side of the xgames kit (runtime godot). The project's one autoload, named GF.
##
## The kit's page (gf/godot/boot.js) runs everything shared in the browser: the slots (gf-assets, so Studio's
## replaced files and values reach the game without a new export), the round and the friends (gf/mp: lobby, names,
## each player's own results), the menu, the HUD and the wallet, the sounds (gf-audio) and window.__game. The game is
## the Godot project: it draws the world, moves this player and draws the friends where the kit says they are.
## The two talk through window.gfGodot once a frame (pull: what the kit says; push: what the game did).
##
## Units: the game works in pixels, the kit in metres with y up. GF.ppm pixels are one metre (16 for pixel art, 128
## for drawn art: gf-flat-1), and GF.to_px / GF.to_m convert. Run from the Godot editor (no page), GF plays alone with
## the config create wrote into res://gf_alone.json, and reads slot files beside the project.
##
##   func _ready():
##       await GF.boot()                                     # the config, the map and the values are in
##       var sheet := await GF.texture("character.body.player")
##   func _physics_process(dt):
##       GF.set_pose(me.position, face, "walk")              # what friends see of this player
##       if touched_coin: GF.event("coin", {"i": 3})         # rules.event(ctx, "coin", {i: 3}, "godot") on this copy
##
## Read only: phase, playing, input_on, host, me, peers, shared, world, config, ppm, style, plane.
extends Node

const VERSION := "0.1.0"

## The kit's boot message arrived: config, world, values and this player are in place (await GF.boot()).
signal booted
## The round's phase changed: "lobby", "countdown", "playing" or "results".
signal phase_changed(phase: String)
## rules.js sent the game something: ctx.godot.send(name, data) (every copy hears its own call).
signal message(name: String, data: Variant)
## The host's shared state (ctx.shared, read only here) changed.
signal shared_changed(shared: Dictionary)
## A value slot changed while the game runs (a person editing it in the studio page).
signal value_changed(id: String, value: Variant)
## The kit puts this player somewhere (a round's start: their seat's spawn), in pixels.
signal place_me(at: Vector2)
## 3D: the kit puts this player somewhere (a round's start: their seat's spawn), in metres.
signal place_me3(at: Vector3)
## The bots this copy runs changed (playing alone: the kit fills empty seats; a friends round has none).
signal bots_changed(bots: Array)
## Something happened in an open panel (GF.panel): "pick", "choose" (a shop's buy), "select", "action".
signal panel_event(req: int, name: String, data: Variant)
signal _panel_done(req: int, result: Variant)
## This copy started or stopped watching a friend's stream (watch then play), or the one it follows changed.
signal watch_changed(watching: bool, follow: String)
signal _file_done(req: int, ok: bool)

var connected := false     ## a page with the kit is there (false when run from the editor)
var is_booted := false
var profile := "2d"
var style := "pixel"
var plane := "side"        ## 2D: "side" (y is height) or "top" (seen from above: y is north); a 3D game's map is "top"
var is_3d := false         ## profile "3d": metres in Godot's own axes (y up, the map's x and z); use the *3 calls
var ppm := 16.0            ## pixels a metre
var config := {}           ## {game, world, look, characters}: the config files with Studio's changes
var world := {}            ## the map as the kit read it: {plane, tile, cols, rows, kinds, cells, spawns, marks} (metres)
var phase := "lobby"
var playing := false       ## phase is "playing"
var input_on := true       ## the kit lets this player act (a round, nothing over the game); the page's first frame says
var paused := false        ## alone, the pause menu is open: the kit pauses the scene tree (GF itself keeps running)
var watching := false      ## this copy watches a friend's stream: it has no player of its own (hide it, move nothing)
var follow := ""           ## while watching: the id of the streamer, whom the camera follows (a peer in GF.peers)
var host := true           ## this copy owns the shared world
var me := {}               ## {id, name, color, seat}
var peers: Array = []      ## the other players: {id, name, color, seat, at (pixels), face, anim, mode}; 3D: at3, yaw
var bots: Array = []       ## the bots this copy moves (alone only): {id, name, color, seat}; GfBots2D runs them
var shared := {}           ## the host's ctx.shared, read only
var observe: Callable      ## the game's own observation, func() -> Dictionary: window.__game.snapshot().godot.game

var _js = null
var _values := {}
var _slots := {}
var _pose := {}
var _events: Array = []
var _friends := {}
var _bots := {}
var _req := 0
var _frame := 0
var _game_obs = null
var _panel_last = null

const ACTIONS := {
	"move_left": [KEY_A, KEY_LEFT], "move_right": [KEY_D, KEY_RIGHT], "move_up": [KEY_W, KEY_UP],
	"move_down": [KEY_S, KEY_DOWN], "jump": [KEY_SPACE], "act": [KEY_E, KEY_F],
}


func _ready() -> void:
	process_mode = Node.PROCESS_MODE_ALWAYS
	process_priority = -1000
	_ensure_actions()
	if OS.has_feature("web"):
		_js = JavaScriptBridge.get_interface("gfGodot")
	connected = _js != null
	if connected:
		_js.hello(JSON.stringify({"addon": VERSION, "godot": Engine.get_version_info().string}))
	else:
		_boot_alone.call_deferred()


## Waits for the kit's boot message. The first line of the main scene's _ready.
func boot() -> void:
	if not is_booted:
		await booted


func _process(_dt: float) -> void:
	if not connected:
		return
	var raw = _js.pull()
	if typeof(raw) == TYPE_STRING and raw != "":
		var m = JSON.parse_string(raw)
		if m is Dictionary:
			_take(m)
	_frame += 1
	var out := {"me": _pose, "friends": _friends, "view": _view()}
	if watching:
		out["watch"] = {"target": follow if _friends.has(follow) else null}
	if not _bots.is_empty() or not bots.is_empty():
		out["bots"] = _bots
	if _events.size() > 0:
		out["events"] = _events
		_events = []
	if observe.is_valid() and (_frame % 6 == 0 or _game_obs == null):
		_game_obs = observe.call()
	if _game_obs != null:
		out["game"] = _game_obs
	if _panel_last != null:
		out["panel"] = _panel_last
	_js.push(JSON.stringify(out))


# ---- what the game calls ----

## A value slot's current value (Studio's change when there is one): GF.value("controller.speed", 5.2).
func value(id: String, fallback: Variant = null) -> Variant:
	return _values.get(id, fallback)


## Whether the game has a slot with this id.
func has_slot(id: String) -> bool:
	return _slots.has(id)


## The bytes of a file slot (or a path in the game), read through the kit's gf-assets: Studio's replaced file
## when there is one, the game's own otherwise. Empty when it could not be read.
func bytes(slot_or_path: String) -> PackedByteArray:
	if not connected:
		var file: String = _slots.get(slot_or_path, {}).get("file", slot_or_path)
		return FileAccess.get_file_as_bytes(ProjectSettings.globalize_path("res://").path_join("..").path_join(file))
	_req += 1
	var req := _req
	_js.file(req, slot_or_path)
	while true:
		var r: Array = await _file_done
		if r[0] == req:
			if not r[1]:
				push_error("GF: %s could not be read" % slot_or_path)
				return PackedByteArray()
			var buf = _js.take(req)
			return JavaScriptBridge.js_buffer_to_packed_byte_array(buf)
	return PackedByteArray()


## A picture slot as a texture (PNG, WebP or JPEG). Null when it could not be read.
func texture(slot_or_path: String) -> Texture2D:
	var b := await bytes(slot_or_path)
	if b.is_empty():
		return null
	var img := Image.new()
	var err := img.load_png_from_buffer(b)
	if err != OK:
		err = img.load_webp_from_buffer(b)
	if err != OK:
		err = img.load_jpg_from_buffer(b)
	if err != OK:
		push_error("GF: %s is not a PNG, WebP or JPEG picture" % slot_or_path)
		return null
	return ImageTexture.create_from_image(img)


## Open one of the kit's panels and wait for its answer (the kit's own cards, shop, bar, dialogue or text field over
## the game; words and pictures are the caller's, pictures by slot id): "choice" → {id, index} or null; "shop" → null
## (each buy is a panel_event "choose"); "inventory" → null; "dialogue" → {choice, index, lines, skipped}; "input" → the
## text or null. While a modal panel is open the kit holds the player's input. Run from the editor (no page): null.
##   var pick = await GF.panel("choice", {"title": "Pick one", "cards": [{"id": "a", "name": "Fast"}, {"id": "b", "name": "Strong"}]})
func panel(kind: String, opts := {}) -> Variant:
	if not connected:
		return null
	_req += 1
	var req := _req
	_js.panel(req, kind, JSON.stringify(opts))
	while true:
		var r: Array = await _panel_done
		if r[0] == req:
			return r[1]
	return null


## Close a panel GF.panel opened (its answer is null).
func panel_close(req: int) -> void:
	if connected:
		_js.panelClose(req)


## Play a sound listed in assets.json → sounds, through gf-audio (the kit's buses and the menu's volume).
## opts: {volume, rate, optional} as ctx.audio.play takes them.
func sound(id: String, opts := {}) -> void:
	if connected:
		_js.sound(id, JSON.stringify(opts))


## Something happened in the game: rules.event(ctx, name, data, "godot") runs on this copy (the kit counts it).
func event(name: String, data: Variant = {}) -> void:
	_events.append({"n": name, "d": data})


## Something a bot did: rules.event(ctx, name, data, <the bot's id>) runs on this copy (the host's: bots are alone).
func event_as(bot_id: String, name: String, data: Variant = {}) -> void:
	_events.append({"n": name, "d": data, "w": bot_id})


## Where a bot is (pixels, feet), which way it faces, what it is doing: the kit's player for it (scores, results, the
## HUD, window.__game) follows. GfBots2D calls it each frame for every bot it moves.
func report_bot(id: String, at: Vector2, face := 1, anim := "idle", extra := {}) -> void:
	var b := {"x": snappedf(at.x / ppm, 0.001), "y": snappedf(-at.y / ppm, 0.001), "face": face, "anim": anim}
	for k in extra:
		b[k] = extra[k]
	_bots[id] = b


## 3D: where this player is (metres, feet), which way they face (yaw, radians, the kit's: atan2(dx, dz), 0 faces +z) and what they are
## doing (idle, walk, run, air, act, down): what every friend's copy draws. Call once a frame.
func set_pose3(at: Vector3, yaw := 0.0, anim := "idle", extra := {}) -> void:
	_pose = {"x": snappedf(at.x, 0.001), "y": snappedf(at.y, 0.001), "z": snappedf(at.z, 0.001), "yaw": snappedf(yaw, 0.001), "anim": anim}
	for k in extra:
		_pose[k] = extra[k]


## 3D: a friend as this copy draws them (metres, feet), whether they are in view, and the screen box their body covers
## as fractions of the view (GfFriends3D calls it).
func report_friend3(id: String, at: Vector3, on_screen: bool, box: Rect2) -> void:
	_friends[id] = {"x": snappedf(at.x, 0.001), "y": snappedf(at.y, 0.001), "z": snappedf(at.z, 0.001), "on": on_screen,
		"box": [snappedf(box.position.x, 0.0001), snappedf(box.position.y, 0.0001), snappedf(box.end.x, 0.0001), snappedf(box.end.y, 0.0001)]}


## 3D: a bot's pose (metres, feet), as report_bot.
func report_bot3(id: String, at: Vector3, yaw := 0.0, anim := "idle") -> void:
	_bots[id] = {"x": snappedf(at.x, 0.001), "y": snappedf(at.y, 0.001), "z": snappedf(at.z, 0.001), "yaw": snappedf(yaw, 0.001), "anim": anim}


## 3D: a seat's spawn (metres, feet) and the map's named places (cell centres), on the ground (y 0).
func spawn3(seat: int) -> Vector3:
	var list: Array = world.get("spawns", [])
	if list.is_empty():
		return Vector3.ZERO
	var s: Dictionary = list[posmod(seat, list.size())]
	return Vector3(float(s.x), 0.0, float(s.get("z", -float(s.y))))


func marks3(name: String) -> Array:
	var out: Array = []
	for m in world.get("marks", {}).get(name, []):
		out.append(Vector3(float(m.x), 0.0, float(m.get("z", -float(m.y)))))
	return out


## Where this player is (pixels, feet), which way they face (1 right, -1 left) and what they are doing (idle, walk,
## air, act, down): what every friend's copy draws. Call once a frame.
func set_pose(at: Vector2, face := 1, anim := "idle", extra := {}) -> void:
	_pose = {"x": snappedf(at.x / ppm, 0.001), "y": snappedf(-at.y / ppm, 0.001), "face": face, "anim": anim}
	for k in extra:
		_pose[k] = extra[k]


## A friend as this copy draws them: where (pixels, feet), whether they are in view, and the screen box their body
## covers as fractions of the view (GfFriends2D calls it; a game drawing friends itself calls it too).
func report_friend(id: String, at: Vector2, on_screen: bool, box: Rect2) -> void:
	_friends[id] = {"x": snappedf(at.x / ppm, 0.001), "y": snappedf(-at.y / ppm, 0.001), "on": on_screen,
		"box": [snappedf(box.position.x, 0.0001), snappedf(box.position.y, 0.0001), snappedf(box.end.x, 0.0001), snappedf(box.end.y, 0.0001)]}


## A friend left: forget what was reported about them.
func forget_friend(id: String) -> void:
	_friends.erase(id)


## Metres (y up) to pixels (y down), and back.
func to_px(m: Vector2) -> Vector2:
	return Vector2(m.x * ppm, -m.y * ppm)


func to_m(px: Vector2) -> Vector2:
	return Vector2(px.x / ppm, -px.y / ppm)


## A seat's spawn (feet, pixels).
func spawn(seat: int) -> Vector2:
	var list: Array = world.get("spawns", [])
	if list.is_empty():
		return Vector2.ZERO
	var s: Dictionary = list[posmod(seat, list.size())]
	return to_px(Vector2(s.x, s.y))


## The map's named places (legend "mark:<name>"), centres in pixels.
func marks(name: String) -> Array:
	var out: Array = []
	for m in world.get("marks", {}).get(name, []):
		out.append(to_px(Vector2(m.x, m.y)))
	return out


# ---- the kit's messages ----

func _take(m: Dictionary) -> void:
	if m.has("boot"):
		_on_boot(m.boot)
	if m.has("me"):
		me = m.me
	if m.has("host"):
		host = bool(m.host)
	if m.has("input"):
		_set_input(bool(m.input))
	if m.has("watch"):
		var w: Dictionary = m.watch if m.watch is Dictionary else {}
		watching = bool(w.get("on", false))
		follow = String(w.get("follow", "")) if w.get("follow") != null else ""
		watch_changed.emit(watching, follow)
	if m.has("pad"):
		_pad(m.pad)
	if m.has("paused") and bool(m.paused) != paused:
		paused = bool(m.paused)
		get_tree().paused = paused
	if m.has("peers"):
		var list: Array = []
		for p in m.peers:
			var q: Dictionary = p.duplicate()
			q["at"] = to_px(Vector2(float(p.get("x", 0.0)), float(p.get("y", 0.0))))
			q["at3"] = Vector3(float(p.get("x", 0.0)), float(p.get("y", 0.0)), float(p.get("z", 0.0)))
			list.append(q)
		peers = list
	if m.has("bots"):
		bots = m.bots
		for id in _bots.keys():
			if not bots.any(func(b): return String(b.get("id", "")) == id):
				_bots.erase(id)
		bots_changed.emit(bots)
	if m.has("shared"):
		shared = m.shared
		shared_changed.emit(shared)
	if m.has("phase") and m.phase != phase:
		phase = m.phase
		playing = phase == "playing"
		phase_changed.emit(phase)
	for x in m.get("msgs", []):
		match String(x.get("k", "")):
			"place":
				if is_3d:
					place_me3.emit(Vector3(float(x.x), 0.0, float(x.get("z", -float(x.y)))))
				else:
					place_me.emit(to_px(Vector2(float(x.x), float(x.y))))
			"send":
				message.emit(String(x.get("name", "")), x.get("data"))
			"value":
				_values[String(x.id)] = x.get("value")
				value_changed.emit(String(x.id), x.get("value"))
			"file":
				_file_done.emit(int(x.req), bool(x.ok))
			"panel":
				_panel_last = {"req": int(x.req), "result": x.get("result"), "refused": bool(x.get("refused", false))}
				_panel_done.emit(int(x.req), x.get("result"))
			"panel-event":
				panel_event.emit(int(x.req), String(x.get("name", "")), x.get("data"))


func _on_boot(b: Dictionary) -> void:
	profile = String(b.get("profile", "2d"))
	is_3d = profile == "3d"
	style = String(b.get("style", "pixel"))
	ppm = float(b.get("ppm", 16.0))
	config = b.get("config", {})
	world = b.get("world", {})
	plane = String(world.get("plane", "side"))
	_values = b.get("values", {})
	_slots = b.get("slots", {})
	me = b.get("me", {})
	host = bool(b.get("host", true))
	is_booted = true
	booted.emit()


# While the kit holds input (a menu, the countdown, the results, a friend's stream), every action's keys are out of
# the input map, so no key press reaches the game's actions; they come back when the player may act again. Read
# input through actions (Input.get_axis("move_left", "move_right"), "jump", "act"), never raw keys.
var _held_events := {}

func _set_input(on: bool) -> void:
	if on == input_on:
		return
	input_on = on
	if not on:
		for a in InputMap.get_actions():
			if String(a).begins_with("ui_"):
				continue
			_held_events[a] = InputMap.action_get_events(a)
			InputMap.action_erase_events(a)
			Input.action_release(a)
	else:
		for a in _held_events:
			if InputMap.has_action(a):
				for e in _held_events[a]:
					InputMap.action_add_event(a, e)
		_held_events.clear()


# touch (the kit's stick and buttons on a phone): the game's own actions, pressed as keys would press them
var _pad_held := {}

func _pad(p: Dictionary) -> void:
	var x := float(p.get("x", 0.0))
	var y := float(p.get("y", 0.0))
	var want := {"move_left": maxf(0.0, -x), "move_right": maxf(0.0, x), "move_up": maxf(0.0, y), "move_down": maxf(0.0, -y),
		"jump": 1.0 if bool(p.get("jump", false)) else 0.0, "act": 1.0 if bool(p.get("act", false)) else 0.0}
	for a in want:
		if want[a] > 0.05 and input_on:
			Input.action_press(a, want[a])
			_pad_held[a] = true
		elif _pad_held.has(a):
			Input.action_release(a)
			_pad_held.erase(a)


func _view() -> Dictionary:
	var vp := get_viewport()
	var cam3 := vp.get_camera_3d()
	if is_3d and cam3:
		# a 3D view: the camera's place and axes and its vertical field of view, so the page can project (observation)
		var t := cam3.global_transform
		var s3 := vp.get_visible_rect().size
		return {"w": s3.x, "h": s3.y, "eye": [snappedf(t.origin.x, 0.001), snappedf(t.origin.y, 0.001), snappedf(t.origin.z, 0.001)],
			"x": [t.basis.x.x, t.basis.x.y, t.basis.x.z], "y": [t.basis.y.x, t.basis.y.y, t.basis.y.z], "z": [t.basis.z.x, t.basis.z.y, t.basis.z.z], "fov": cam3.fov}
	var cam := vp.get_camera_2d()
	var size := vp.get_visible_rect().size
	var v := {"w": size.x, "h": size.y}
	if cam:
		var c := to_m(cam.get_screen_center_position())
		v["cx"] = snappedf(c.x, 0.01)
		v["cy"] = snappedf(c.y, 0.01)
		v["zoom"] = snappedf(cam.zoom.x, 0.001)
	return v


func _ensure_actions() -> void:
	for a in ACTIONS:
		if InputMap.has_action(a):
			continue
		InputMap.add_action(a)
		for k in ACTIONS[a]:
			var e := InputEventKey.new()
			e.physical_keycode = k
			InputMap.action_add_event(a, e)


# Run from the editor: the config create wrote beside the project, alone, always playing.
func _boot_alone() -> void:
	var b := {}
	if FileAccess.file_exists("res://gf_alone.json"):
		var parsed = JSON.parse_string(FileAccess.get_file_as_string("res://gf_alone.json"))
		if parsed is Dictionary:
			b = parsed
	_on_boot(b)
	me = {"id": "p1", "name": "You", "color": "#4f7cff", "seat": 0}
	phase = "playing"
	playing = true
	input_on = true
	phase_changed.emit(phase)
	print("GF %s: alone (no page): %d kinds, %d spawns" % [VERSION, world.get("kinds", {}).size(), world.get("spawns", []).size()])
