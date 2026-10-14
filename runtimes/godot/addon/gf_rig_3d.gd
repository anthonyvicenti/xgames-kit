## gf-humanoid-1 on Godot: one clip set drives every body (runtimes/three/kit/character/RIG.md; the same retarget as
## rig.js createRetarget). The shared clip file animates a standard skeleton whose rest rotations are identity (a
## T-pose in character axes: +X left, +Y up, +Z forward), so a clip value is how far a bone has turned from the
## T-pose. A body keeps its own mesh, rest pose and bone frames; per canonical bone b, at load:
##   B(b)  the bone's rest rotation in character space (the skeleton's global rest),
##   R(b)  a swing that lines the body's limb up with the standard's (an A-pose arm becomes a T-pose arm): its own for
##         the upper arm, forearm, thigh and shin; hands, fingers, feet and toes inherit their parent's.
## Each frame, with D(b) the standard bone's character-space rotation from the clip:
##   world(b) = D(b) * R(b) * B(b),   local(b) = world(parent)^-1 * world(b),
## and the hips stand where the standard's do, scaled by the body's leg reach. Not ported (yet): rig.js's finger
## shift for rigs whose finger 1 sits in the palm, and its per-segment finger alignment (fingers take the hand's swing).
class_name GfRig3D
extends RefCounted

const SWING := {"LeftArm": "LeftForeArm", "LeftForeArm": "LeftHand", "RightArm": "RightForeArm", "RightForeArm": "RightHand",
	"LeftUpLeg": "LeftLeg", "LeftLeg": "LeftFoot", "RightUpLeg": "RightLeg", "RightLeg": "RightFoot"}
const REQUIRED := ["Hips", "Spine", "Head", "LeftArm", "LeftForeArm", "LeftHand", "LeftUpLeg", "LeftLeg", "LeftFoot",
	"RightArm", "RightForeArm", "RightHand", "RightUpLeg", "RightLeg", "RightFoot"]
const SPINE := ["Spine02", "Spine01", "Spine", "neck", "Head"]

var skeleton: Skeleton3D
var missing: Array = []       ## required bones the body lacks (then nothing is driven)
var k := 1.0                  ## the body's leg reach over the standard's
var height := 1.7             ## the body's standing height (its highest bone, plus a head's top)
var ground := 0.0
var spine_bend := 1.0         ## gf_body extras gfSpineBend: how much of the clip's spine bend a body takes (beans 0.4)
var order: Array = []         ## canonical bones the body has, parents first
var _idx := {}
var _c := {}                  ## C(b) = R(b) * B(b)
var _parent := {}             ## the canonical parent this body has, or ""
var _static_inv := {}         ## a bone under a non-canonical parent: that parent's rest rotation, inverted
var _static_mat := {}
var _std := {}                ## the standard's proxy nodes by name
var _std_order: Array = []
var _std_parent := {}
var _std_ground := 0.0
var _hips_lift := 1.0
var _canon := {}


## The canonical bones of gf-humanoid-1 with their parents (rig.js BONES), parents first.
static func bones() -> Array:
	var out := [["Hips", ""], ["Spine02", "Hips"], ["Spine01", "Spine02"], ["Spine", "Spine01"], ["neck", "Spine"], ["Head", "neck"], ["head_end", "Head"], ["headfront", "Head"]]
	for s in ["Left", "Right"]:
		out += [[s + "Shoulder", "Spine"], [s + "Arm", s + "Shoulder"], [s + "ForeArm", s + "Arm"], [s + "Hand", s + "ForeArm"]]
		for f in ["Thumb", "Index", "Middle", "Ring", "Pinky"]:
			for i in [1, 2, 3]:
				out.append([s + "Hand" + f + str(i), s + "Hand" if i == 1 else s + "Hand" + f + str(i - 1)])
		out += [[s + "UpLeg", "Hips"], [s + "Leg", s + "UpLeg"], [s + "Foot", s + "Leg"], [s + "ToeBase", s + "Foot"]]
	return out


static func _inherits(n: String) -> bool:
	return n.ends_with("Hand") or n.ends_with("Foot") or n.ends_with("ToeBase") or n.contains("Hand") and n.right(1).is_valid_int()


## A body's skeleton, and the standard skeleton of a clip file (the root of its generated scene: Node3D bones by name).
func _init(body_skeleton: Skeleton3D, proxy: Node3D, body_root: Node = null) -> void:
	skeleton = body_skeleton
	var list := bones()
	var canon := {}
	for b in list:
		canon[b[0]] = b[1]
	for b in list:
		var i := skeleton.find_bone(b[0])
		if i >= 0:
			_idx[b[0]] = i
			order.append(b[0])
	for n in REQUIRED:
		if not _idx.has(n):
			missing.append(n)
	if not missing.is_empty():
		return
	# the standard: its bones, their rest positions (rest rotations are identity: positions add up)
	for b in list:
		var o := proxy.find_child(b[0], true, false)
		if o is Node3D:
			_std[b[0]] = o
			_std_order.append(b[0])
	for n in _std_order:
		var p: String = canon[n]
		while p != "" and not _std.has(p):
			p = canon[p]
		_std_parent[n] = p
	var std_rest := {}
	for n in _std_order:
		var p: String = _std_parent[n]
		std_rest[n] = (std_rest[p] if p != "" else Vector3.ZERO) + (_std[n] as Node3D).position
	var top_extras = proxy.get_meta("extras", {}) if proxy.has_meta("extras") else {}
	_std_ground = float(top_extras.get("gfGround", 0.0)) if top_extras is Dictionary else 0.0
	# the body at rest, in character space (the skeleton's space)
	var pos := {}
	var rot := {}
	var top := 0.0
	for n in order:
		var t := skeleton.get_bone_global_rest(_idx[n])
		pos[n] = t.origin
		rot[n] = t.basis.get_rotation_quaternion()
		top = maxf(top, t.origin.y)
	ground = 0.0           # gf-humanoid-1: the origin is between the feet, on the ground
	height = top + (0.0 if _idx.has("head_end") else 0.12)
	var reach := func(P: Dictionary, g: float) -> float:
		var side := func(s: String) -> float:
			return P[s + "UpLeg"].distance_to(P[s + "Leg"]) + P[s + "Leg"].distance_to(P[s + "Foot"]) + (P[s + "Foot"].y - g) + (P["Hips"].y - P[s + "UpLeg"].y)
		return (side.call("Left") + side.call("Right")) / 2.0
	var std_reach: float = reach.call(std_rest, _std_ground) if std_rest.has("LeftUpLeg") else std_rest["Hips"].y - _std_ground
	k = reach.call(pos, ground) / std_reach
	_hips_lift = (std_rest["Hips"].y - _std_ground) / std_reach
	# R(b): the limb's swing, or the parent's
	var R := {}
	for n in order:
		var r := Quaternion.IDENTITY
		if SWING.has(n) and pos.has(SWING[n]) and std_rest.has(n) and std_rest.has(SWING[n]):
			var db: Vector3 = (pos[SWING[n]] - pos[n]).normalized()
			var ds: Vector3 = (std_rest[SWING[n]] - std_rest[n]).normalized()
			if db.length_squared() > 0.0 and ds.length_squared() > 0.0 and db.dot(ds) > -0.9999:
				r = Quaternion(db, ds)
		elif _inherits(n):
			var p: String = canon[n]
			while p != "" and not R.has(p):
				p = canon[p]
			if p != "":
				r = R[p]
		R[n] = r
		_c[n] = r * rot[n]
	for n in order:
		var pi := skeleton.get_bone_parent(_idx[n])
		var pname := skeleton.get_bone_name(pi) if pi >= 0 else ""
		if pi >= 0 and _idx.has(pname) and _idx[pname] == pi:
			_parent[n] = pname
		else:
			_parent[n] = ""
			var pm := skeleton.get_bone_global_rest(pi) if pi >= 0 else Transform3D.IDENTITY
			_static_inv[n] = pm.basis.get_rotation_quaternion().inverse()
			_static_mat[n] = pm.affine_inverse()
	var extras = body_root.get_meta("extras", {}) if body_root != null and body_root.has_meta("extras") else {}
	if extras is Dictionary and extras.has("gfSpineBend"):
		spine_bend = float(extras.gfSpineBend)


## Pose the body from the standard skeleton's current pose (call after the clips' player has advanced).
func apply() -> void:
	if not missing.is_empty():
		return
	var sw := {}
	for n in _std_order:
		var q: Quaternion = (_std[n] as Node3D).quaternion
		var p: String = _std_parent[n]
		sw[n] = sw[p] * q if p != "" else q
	if spine_bend < 1.0 and sw.has("Hips"):
		var hq: Quaternion = sw["Hips"]
		for n in SPINE:
			if sw.has(n):
				var rel: Quaternion = (hq.inverse() * sw[n]).slerp(Quaternion.IDENTITY, 1.0 - spine_bend)
				sw[n] = hq * rel
	var W := {}
	for n in order:
		var d = sw.get(n)
		if d == null:
			d = _nearest(sw, n)
		W[n] = d * _c[n]
		var p: String = _parent[n]
		var local: Quaternion = (W[p].inverse() * W[n]) if p != "" else (_static_inv[n] * W[n])
		skeleton.set_bone_pose_rotation(_idx[n], local.normalized())
	var sh: Vector3 = (_std["Hips"] as Node3D).position
	var hips := Vector3(sh.x * k, ground + (sh.y - _std_ground) * k * _hips_lift, sh.z * k)
	skeleton.set_bone_pose_position(_idx["Hips"], hips if _parent["Hips"] != "" else _static_mat["Hips"] * hips)


# the standard rotation of a bone the clips do not carry: its nearest canonical ancestor's
func _nearest(sw: Dictionary, n: String) -> Quaternion:
	if _canon.is_empty():
		for b in bones():
			_canon[b[0]] = b[1]
	var canon := _canon
	var p: String = canon.get(n, "")
	while p != "" and not sw.has(p):
		p = canon[p]
	return sw[p] if p != "" else Quaternion.IDENTITY
