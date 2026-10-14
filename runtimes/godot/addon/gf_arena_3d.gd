## A 3D arena from the game's map seen from above (gf-tilemap-1, plane "top": the slot world.map, as the kit read it:
## GF.world) and the pictures of its kinds (the slots world.tiles.<kind>, gf-flat-1 tiles): the ground is the base kind,
## a solid kind is a block (walls stand `wall_m` high; water is a low basin you cannot walk into), every block a static
## collider on physics layer 1. One metre of map is `tile` metres of world, the map's x and z as they are.
##
##   var arena := GfArena3D.new()
##   add_child(arena)
##   arena.build(GF.world, {"grass": await GF.texture("world.tiles.grass"), ...})
class_name GfArena3D
extends Node3D

const LAYER_SOLID := 1

var world := {}
var wall_m := 2.0
var tile := 1.0
var _mats := {}


func build(w: Dictionary, textures: Dictionary, pixel := true) -> void:
	world = w
	tile = float(w.get("tile", 1.0))
	for c in get_children():
		c.queue_free()
	_mats.clear()
	for k in textures:
		var m := StandardMaterial3D.new()
		m.albedo_texture = textures[k]
		m.texture_filter = BaseMaterial3D.TEXTURE_FILTER_NEAREST_WITH_MIPMAPS if pixel else BaseMaterial3D.TEXTURE_FILTER_LINEAR_WITH_MIPMAPS
		m.uv1_triplanar = true
		m.uv1_world_triplanar = true
		m.uv1_scale = Vector3.ONE / tile
		m.roughness = 0.95
		_mats[k] = m
	var cols := int(w.get("cols", 0))
	var rows := int(w.get("rows", 0))
	var cells: Array = w.get("cells", [])
	var kinds: Dictionary = w.get("kinds", {})
	# the ground: the base kind under the whole map, and a collider for it
	var base = w.get("base")
	var floor_mesh := MeshInstance3D.new()
	var plane := PlaneMesh.new()
	plane.size = Vector2(cols * tile, rows * tile)
	floor_mesh.mesh = plane
	if base != null and _mats.has(base):
		floor_mesh.material_override = _mats[base]
	add_child(floor_mesh)
	var ground := StaticBody3D.new()
	ground.collision_layer = LAYER_SOLID
	var gs := CollisionShape3D.new()
	var gbox := BoxShape3D.new()
	gbox.size = Vector3(cols * tile, 1.0, rows * tile)
	gs.shape = gbox
	gs.position = Vector3(0, -0.5, 0)
	ground.add_child(gs)
	add_child(ground)
	# solid cells: a run of one kind along a row is one block
	var solid := StaticBody3D.new()
	solid.collision_layer = LAYER_SOLID
	add_child(solid)
	for r in cells.size():
		var row: Array = cells[r]
		var c := 0
		while c < row.size():
			var k = row[c]
			if k == null or k == base or not bool(kinds.get(k, {}).get("solid", false)):
				if k != null and k != base and _mats.has(k):
					_flat(k, c, r)
				c += 1
				continue
			var c0 := c
			while c + 1 < row.size() and row[c + 1] == k:
				c += 1
			_block(solid, k, c0, c, r)
			c += 1


## A cell's centre on the ground (row 0 is the far side, -z).
func centre(c: float, r: float) -> Vector3:
	var cols := int(world.get("cols", 0))
	var rows := int(world.get("rows", 0))
	return Vector3((c - cols / 2.0 + 0.5) * tile, 0.0, (r - rows / 2.0 + 0.5) * tile)


func _block(body: StaticBody3D, k: String, c0: int, c1: int, r: int) -> void:
	var water := k == "water"
	var h := 0.25 if water else wall_m
	var mid := (centre(c0, r) + centre(c1, r)) / 2.0
	var size := Vector3((c1 - c0 + 1) * tile, h, tile)
	var mi := MeshInstance3D.new()
	var box := BoxMesh.new()
	box.size = size
	mi.mesh = box
	if _mats.has(k):
		mi.material_override = _mats[k]
	mi.position = mid + Vector3(0, h / 2.0 - (0.2 if water else 0.0), 0)
	add_child(mi)
	var cs := CollisionShape3D.new()
	var shape := BoxShape3D.new()
	shape.size = Vector3(size.x, wall_m, size.z)        # water stops a body as a wall does
	cs.shape = shape
	cs.position = mid + Vector3(0, wall_m / 2.0, 0)
	body.add_child(cs)


# a walkable kind over the base (a path): a thin tile on the ground
func _flat(k: String, c: int, r: int) -> void:
	var mi := MeshInstance3D.new()
	var p := PlaneMesh.new()
	p.size = Vector2(tile, tile)
	mi.mesh = p
	mi.material_override = _mats[k]
	mi.position = centre(c, r) + Vector3(0, 0.005, 0)
	add_child(mi)
