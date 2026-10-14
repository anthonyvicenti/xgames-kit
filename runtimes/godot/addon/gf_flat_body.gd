## A gf-flat-1 body: one sheet of square cells, six frames (idle, walk1, walk2, air, act, down) in one row (side-on)
## or three (seen from above: facing down, side, up), drawn with its feet at this node's position, facing right and
## mirrored to face left. The seat colour (mixed 30% toward white) goes onto the picture's light greys only, as three's
## flat-2d does it: a shirt painted light grey takes the player's colour with its shading kept, and skin, hair and
## coloured clothes keep their own. Seen from above (a sheet of three rows) a small shadow lies under the feet.
##
##   var body := GfFlatBody.new()
##   body.setup(sheet, GF.value("character.height.player", 1.7), GF.ppm, GF.me.color, GF.style == "pixel")
##   body.tick(dt, velocity, on_floor)        # this player: the frame from how it moves
##   body.tick_top(dt, velocity)              # this player, seen from above: the row from where they head
##   body.show_anim("walk", face, dt, look)   # a friend: the frame from what their pose says
class_name GfFlatBody
extends Node2D

const FRAMES := {"idle": 0, "walk1": 1, "walk2": 2, "air": 3, "act": 4, "down": 5}

var sprite := Sprite2D.new()
var shadow := Node2D.new()  ## seen from above: the ellipse under the feet
## The grey test is made on linear values, as three's tintGreys makes it on its linear texels; the product stays sRGB.
const TINT_GREYS := """
shader_type canvas_item;
uniform vec4 seat : source_color = vec4(1.0);
void fragment() {
	vec4 t = texture(TEXTURE, UV);
	vec3 lin = pow(t.rgb, vec3(2.2));
	float hi = max(max(lin.r, lin.g), lin.b);
	float lo = min(min(lin.r, lin.g), lin.b);
	float grey = 1.0 - smoothstep(0.07, 0.14, hi > 0.0 ? (hi - lo) / hi : 0.0);
	float takes = grey * smoothstep(0.18, 0.3, hi);
	COLOR = vec4(t.rgb * mix(vec3(1.0), seat.rgb, takes), t.a * COLOR.a);
}
"""
static var _tint_shader: Shader
var face := 1             ## 1 right, -1 left
var anim := "idle"        ## idle, walk, air, act, down: what this body is doing (what a pose carries)
var look := "side"        ## seen from above: "down", "side" or "up", the sheet's row (a pose carries it too)
var rows := 1
var cell_px := 32.0       ## a cell's side in the sheet's pixels
var height_px := 27.0     ## the standing figure's height in world pixels (85% of the cell)
var _row := 0
var _walk := 0.0
var _act := 0.0


func setup(sheet: Texture2D, height_m: float, ppm: float, color: Variant = null, pixel := true) -> void:
	sprite.texture = sheet
	rows = 1 if sheet.get_width() == sheet.get_height() * 6 else 3
	sprite.hframes = 6
	sprite.vframes = rows
	_row = 1 if rows == 3 else 0
	cell_px = float(sheet.get_height()) / rows
	var cell_m := height_m / 0.85
	var s := cell_m * ppm / cell_px
	sprite.scale = Vector2(s, s)
	sprite.centered = true
	sprite.offset = Vector2(0, -cell_px / 2.0)
	sprite.texture_filter = CanvasItem.TEXTURE_FILTER_NEAREST if pixel else CanvasItem.TEXTURE_FILTER_LINEAR
	if color != null:
		tint(Color(color).lerp(Color.WHITE, 0.3))
	height_px = height_m * ppm
	if rows == 3 and shadow.get_parent() == null:
		shadow.draw.connect(func() -> void:
			shadow.draw_set_transform(Vector2.ZERO, 0.0, Vector2(height_px * 0.25, height_px * 0.1))
			shadow.draw_circle(Vector2.ZERO, 1.0, Color(0.102, 0.063, 0.188, 0.26))
			shadow.draw_set_transform(Vector2.ZERO, 0.0, Vector2.ONE))
		add_child(shadow)
	shadow.queue_redraw()
	if sprite.get_parent() == null:
		add_child(sprite)
	_show("idle")


## The seat colour on the picture's light greys (a ShaderMaterial; the sprite's modulate stays white).
func tint(c: Color) -> void:
	if _tint_shader == null:
		_tint_shader = Shader.new()
		_tint_shader.code = TINT_GREYS
	var m := sprite.material as ShaderMaterial
	if m == null:
		m = ShaderMaterial.new()
		m.shader = _tint_shader
		sprite.material = m
	m.set_shader_parameter("seat", c)


## A new picture for the body (a slot swapped while the game runs): its tint stays.
func set_sheet(sheet: Texture2D, height_m: float, ppm: float, pixel := true) -> void:
	setup(sheet, height_m, ppm, null, pixel)


## This player: pick the frame from how the body moves (pixels a second). Sets face and anim.
func tick(dt: float, velocity: Vector2, on_floor: bool) -> void:
	if absf(velocity.x) > 1.0:
		face = 1 if velocity.x > 0 else -1
	if anim == "down":
		pass
	elif _act > 0.0:
		_act -= dt
		anim = "act"
	elif not on_floor:
		anim = "air"
	elif absf(velocity.x) > 8.0:
		anim = "walk"
	else:
		anim = "idle"
	show_anim(anim, face, dt)


## Seen from above: the row and the frame from where the body heads (pixels a second). Sets face, look and anim.
func tick_top(dt: float, velocity: Vector2) -> void:
	var moving := velocity.length() > 8.0
	if moving:
		if absf(velocity.x) >= absf(velocity.y):
			look = "side"
			face = 1 if velocity.x > 0 else -1
		else:
			look = "down" if velocity.y > 0 else "up"
	if anim == "down":
		pass
	elif _act > 0.0:
		_act -= dt
		anim = "act"
	else:
		anim = "walk" if moving else "idle"
	show_anim(anim, face, dt, look)


## A quarter second of the act frame (a grab, a throw, a cheer).
func act() -> void:
	_act = 0.25


## Show what a pose says: anim (idle, walk, air, act, down), face and (a sheet of three rows) look; walking alternates
## walk1 and walk2.
func show_anim(a: String, f: int, dt: float, l := "") -> void:
	anim = a
	face = f if f != 0 else face
	if rows == 3 and l != "":
		look = l
		_row = {"down": 0, "side": 1, "up": 2}.get(l, 1)
	if a == "walk":
		_walk += dt * 5.0
		_show("walk1" if int(_walk) % 2 == 0 else "walk2")
	else:
		_show(a if FRAMES.has(a) else "idle")
	sprite.flip_h = face < 0 and (rows == 1 or look == "side")


func _show(frame: String) -> void:
	sprite.frame_coords = Vector2i(FRAMES[frame], _row)


## The box the body covers in its own space (feet at the origin), in world pixels.
func box() -> Rect2:
	var w := height_px * 0.6
	return Rect2(-w / 2.0, -height_px, w, height_px)
