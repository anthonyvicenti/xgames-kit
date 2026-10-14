## A stage from the game's map (gf-tilemap-1, the slot world.map, as the kit read it: GF.world) and the pictures of
## its kinds (the slots world.tiles.<kind>). Draws every cell and builds the colliders: solid kinds on physics layer 1,
## ledges (side-on, solid "top": land on them from above, jump up through, drop through) on layer 2 as one-way shapes.
## Side-on (plane "side") row 0 is the sky and the top of the bottom row is y = 0; seen from above (plane "top") row 0
## is the north edge, the map's base kind is drawn under every cell and solid kinds (walls, water) stop a body.
## A painter who changes the map changes the stage; no code changes.
## Seen from above the field is drawn as three's flat-2d draws it, from the plan the page made (GF.world.plan, from
## gf/three/flat/drawplan.js): the base under every cell, the kinds, soft "blend" edges on the cells' corners (a path,
## a pond), "connect" kinds joined to themselves (a wall, a fence), dressing on a share of a kind's cells (tufts,
## flowers), and set pieces (a house, a tree) standing on their footprint's near edge with a shadow under them. The set
## pieces are sprites in `pieces`, which the scene puts beside the bodies in one y-sorted parent, so a body walks behind
## a roof and in front of a door.
##
##   var stage := GfTilemap2D.new()
##   stage.z_index = -1                   # the ground under everything the y-sort orders
##   add_child(stage)
##   stage.build(GF.world, {"ground": await GF.texture("world.tiles.ground"), ...}, GF.ppm, GF.style == "pixel", plan_tex)
##   add_child(stage.pieces)              # seen from above: beside the bodies (this node y-sorts)
class_name GfTilemap2D
extends Node2D

const LAYER_SOLID := 1
const LAYER_LEDGE := 2

var world := {}
var textures := {}
var ppm := 16.0
var tile_px := 16.0
var body: StaticBody2D
var top := false               ## seen from above (plane "top")
var plan_tex := {}             ## slot id → Texture2D: every picture the plan draws
var pieces := Node2D.new()     ## seen from above: the set pieces, one sprite each, standing on their near edge (y-sorted)
const SHADOW := Color(0.102, 0.063, 0.188, 0.26)


func build(w: Dictionary, tex: Dictionary, pixels_a_metre: float, pixel := true, plan_textures := {}) -> void:
	world = w
	textures = tex
	plan_tex = plan_textures
	ppm = pixels_a_metre
	tile_px = float(w.get("tile", 1.0)) * ppm
	top = String(w.get("plane", "side")) == "top"
	texture_filter = CanvasItem.TEXTURE_FILTER_NEAREST if pixel else CanvasItem.TEXTURE_FILTER_LINEAR
	pieces.y_sort_enabled = true
	pieces.texture_filter = texture_filter
	for child in pieces.get_children():
		child.queue_free()
	if body:
		body.queue_free()
	body = StaticBody2D.new()
	body.collision_layer = LAYER_SOLID | LAYER_LEDGE
	body.collision_mask = 0
	add_child(body)
	var cells: Array = w.get("cells", [])
	var kinds: Dictionary = w.get("kinds", {})
	for r in cells.size():
		var row: Array = cells[r]
		var c := 0
		while c < row.size():
			var k = row[c]
			var solid = kinds.get(k, {}).get("solid", false) if k != null else false
			if k == null or not (solid is bool and solid or solid is String and solid == "top"):
				c += 1
				continue
			var c0 := c
			while c + 1 < row.size() and row[c + 1] == k:
				c += 1
			_collider(r, c0, c, solid is String)
			c += 1
	if _planned():
		for it in world["plan"].get("items", []):
			if int(it[9]) == 5:
				_piece(it)
	queue_redraw()


func _planned() -> bool:
	return top and world.has("plan") and world["plan"] is Dictionary


## An item's picture: its texture and the frame's region in it (frame col, row of a grid of cols x rows).
func _region(it: Array) -> Array:
	var slots: Array = world["plan"].get("slots", [])
	var si := int(it[0])
	if si < 0 or si >= slots.size() or not plan_tex.has(slots[si]) or plan_tex[slots[si]] == null:
		return []
	var t: Texture2D = plan_tex[slots[si]]
	var cw := float(t.get_width()) / maxf(1.0, float(it[3]))
	var ch := float(t.get_height()) / maxf(1.0, float(it[4]))
	return [t, Rect2(float(it[1]) * cw, float(it[2]) * ch, cw, ch)]


## Where an item's centre is (c, r in cell units: cell (c, r)'s middle is (c, r)), in pixels.
func _at(c: float, r: float) -> Vector2:
	return corner(0, 0) + Vector2(c + 0.5, r + 0.5) * tile_px


## A set piece: a sprite whose bottom stands on its footprint's near edge, the y the sort reads.
func _piece(it: Array) -> void:
	var reg := _region(it)
	if reg.is_empty():
		return
	var s := Sprite2D.new()
	s.texture = reg[0]
	s.region_enabled = true
	s.region_rect = reg[1]
	var size := Vector2(float(it[7]), float(it[8])) * tile_px
	s.scale = Vector2(size.x / reg[1].size.x, size.y / reg[1].size.y)
	s.centered = true
	s.offset = Vector2(0, -reg[1].size.y / 2.0)
	s.position = Vector2(_at(float(it[5]), 0.0).x, _at(0.0, float(it[10])).y)
	s.name = "piece_%d" % pieces.get_child_count()
	pieces.add_child(s)


## A cell's top-left corner in pixels (row 0 is the top). Side-on the top of the bottom row is y = 0; from above the
## map's middle is (0, 0).
func corner(c: int, r: int) -> Vector2:
	var cols := int(world.get("cols", 0))
	var rows := int(world.get("rows", 0))
	if top:
		return Vector2((c - cols / 2.0) * tile_px, (r - rows / 2.0) * tile_px)
	return Vector2((c - cols / 2.0) * tile_px, -(rows - 1 - r) * tile_px)


## The stage's extent in pixels.
func extent() -> Rect2:
	var cols := int(world.get("cols", 0))
	var rows := int(world.get("rows", 0))
	return Rect2(corner(0, 0), Vector2(cols, rows) * tile_px)


func _collider(r: int, c0: int, c1: int, ledge: bool) -> void:
	var shape := CollisionShape2D.new()
	var rect := RectangleShape2D.new()
	var a := corner(c0, r)
	if ledge:
		rect.size = Vector2((c1 - c0 + 1) * tile_px, tile_px * 0.25)
		shape.position = a + Vector2(rect.size.x / 2.0, rect.size.y / 2.0)
		shape.one_way_collision = true
		var holder := StaticBody2D.new()
		holder.collision_layer = LAYER_LEDGE
		holder.collision_mask = 0
		holder.add_child(shape)
		shape.shape = rect
		add_child(holder)
		return
	rect.size = Vector2((c1 - c0 + 1) * tile_px, tile_px)
	shape.position = a + rect.size / 2.0
	shape.shape = rect
	body.add_child(shape)


func _draw() -> void:
	if _planned():
		for it in world["plan"].get("items", []):
			var layer := float(it[9])
			if layer >= 5.0:
				continue
			var size := Vector2(float(it[7]), float(it[8])) * tile_px
			var at := _at(float(it[5]), float(it[6]))
			if int(it[0]) < 0:
				# a set piece's shadow: a flat ellipse on the ground
				draw_set_transform(at, 0.0, size / 2.0)
				draw_circle(Vector2.ZERO, 1.0, SHADOW)
				draw_set_transform(Vector2.ZERO, 0.0, Vector2.ONE)
				continue
			var reg := _region(it)
			if not reg.is_empty():
				draw_texture_rect_region(reg[0], Rect2(at - size / 2.0, size), reg[1])
		return
	var cells: Array = world.get("cells", [])
	var base = world.get("base") if top else null
	for r in cells.size():
		var row: Array = cells[r]
		for c in row.size():
			var k = row[c]
			if base != null and k != base:
				_cell(base, c, r, null)
			if k == null:
				continue
			_cell(k, c, r, cells[r - 1][c] if r > 0 else null)


# one cell's picture; a picture two cells wide is cap and fill (the cap where the cell above is another kind, side-on)
func _cell(k, c: int, r: int, above) -> void:
	if not textures.has(k) or textures[k] == null:
		return
	var t: Texture2D = textures[k]
	var cell := float(t.get_height())
	var src := Rect2(0, 0, cell, cell)
	if t.get_width() >= t.get_height() * 2 and not top:
		src.position.x = 0.0 if above != k else cell
	draw_texture_rect_region(t, Rect2(corner(c, r), Vector2(tile_px, tile_px)), src)
