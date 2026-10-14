//! forge-anim's tests, on GLBs built here: a standard clip file (gf-humanoid-1's 15 required bones in a T-pose, at
//! identity rest rotations) and a body resting in an A-pose, so the retarget's swing has work to do.
use glam::{Mat4, Quat, Vec3};
use serde_json::{json, Value};

use crate::gltf_io::glb;
use crate::*;

/// A tiny glTF writer: nodes, float accessors, skins, animations.
#[derive(Default)]
struct G {
    nodes: Vec<Value>,
    bin: Vec<u8>,
    views: Vec<Value>,
    accessors: Vec<Value>,
    skins: Vec<Value>,
    meshes: Vec<Value>,
    animations: Vec<Value>,
    roots: Vec<usize>,
    scene_extras: Option<Value>,
}

impl G {
    fn floats(&mut self, data: &[f32], ty: &str) -> usize {
        while !self.bin.len().is_multiple_of(4) {
            self.bin.push(0);
        }
        let off = self.bin.len();
        for v in data {
            self.bin.extend_from_slice(&v.to_le_bytes());
        }
        self.views.push(json!({ "buffer": 0, "byteOffset": off, "byteLength": data.len() * 4 }));
        let n = match ty {
            "SCALAR" => 1,
            "VEC3" => 3,
            "VEC4" => 4,
            _ => 16,
        };
        let mut a = json!({ "bufferView": self.views.len() - 1, "componentType": 5126, "count": data.len() / n, "type": ty });
        if ty == "SCALAR" {
            let (lo, hi) = data.iter().fold((f32::MAX, f32::MIN), |(a, b), &x| (a.min(x), b.max(x)));
            a["min"] = json!([lo]);
            a["max"] = json!([hi]);
        }
        self.accessors.push(a);
        self.accessors.len() - 1
    }
    fn node(&mut self, name: &str, parent: Option<usize>, t: Vec3, r: Quat) -> usize {
        self.nodes.push(json!({ "name": name, "translation": t.to_array(), "rotation": r.to_array() }));
        let i = self.nodes.len() - 1;
        match parent {
            Some(p) => {
                let ch = self.nodes[p].get("children").cloned().unwrap_or(json!([]));
                let mut ch: Vec<Value> = ch.as_array().cloned().unwrap_or_default();
                ch.push(json!(i));
                self.nodes[p]["children"] = json!(ch);
            }
            None => self.roots.push(i),
        }
        i
    }
    fn build(&self) -> Vec<u8> {
        let mut doc = json!({
            "asset": { "version": "2.0" }, "scene": 0, "scenes": [{ "nodes": self.roots }], "nodes": self.nodes,
            "buffers": [{ "byteLength": self.bin.len() }], "bufferViews": self.views, "accessors": self.accessors,
        });
        if let Some(e) = &self.scene_extras {
            doc["scenes"][0]["extras"] = e.clone();
        }
        for (k, v) in [("skins", &self.skins), ("meshes", &self.meshes), ("animations", &self.animations)] {
            if !v.is_empty() {
                doc[k] = json!(v);
            }
        }
        glb(&doc.to_string(), &self.bin)
    }
}

/// The 15 required bones: (name, parent, local translation), in a T-pose (the left arm along +X).
fn skeleton() -> Vec<(&'static str, Option<&'static str>, Vec3)> {
    vec![
        ("Hips", None, Vec3::new(0.0, 0.95, 0.0)),
        ("Spine", Some("Hips"), Vec3::new(0.0, 0.3, 0.0)),
        ("Head", Some("Spine"), Vec3::new(0.0, 0.3, 0.0)),
        ("LeftArm", Some("Spine"), Vec3::new(0.18, 0.15, 0.0)),
        ("LeftForeArm", Some("LeftArm"), Vec3::new(0.28, 0.0, 0.0)),
        ("LeftHand", Some("LeftForeArm"), Vec3::new(0.25, 0.0, 0.0)),
        ("RightArm", Some("Spine"), Vec3::new(-0.18, 0.15, 0.0)),
        ("RightForeArm", Some("RightArm"), Vec3::new(-0.28, 0.0, 0.0)),
        ("RightHand", Some("RightForeArm"), Vec3::new(-0.25, 0.0, 0.0)),
        ("LeftUpLeg", Some("Hips"), Vec3::new(0.1, -0.05, 0.0)),
        ("LeftLeg", Some("LeftUpLeg"), Vec3::new(0.0, -0.42, 0.0)),
        ("LeftFoot", Some("LeftLeg"), Vec3::new(0.0, -0.42, 0.0)),
        ("RightUpLeg", Some("Hips"), Vec3::new(-0.1, -0.05, 0.0)),
        ("RightLeg", Some("RightUpLeg"), Vec3::new(0.0, -0.42, 0.0)),
        ("RightFoot", Some("RightLeg"), Vec3::new(0.0, -0.42, 0.0)),
    ]
}

fn place(g: &mut G, root: usize, rot: impl Fn(&str) -> Quat) -> Vec<(String, usize)> {
    let mut ids: Vec<(String, usize)> = Vec::new();
    for (n, p, t) in skeleton() {
        let parent = p.map(|p| ids.iter().find(|x| x.0 == p).unwrap().1).unwrap_or(root);
        let i = g.node(n, Some(parent), t, rot(n));
        ids.push((n.to_string(), i));
    }
    ids
}

/// The standard clip file: "raise" lifts the left arm 90° (an upper clip), "walk" moves the hips 1 m forward a second.
fn standard_clips() -> Vec<u8> {
    let mut g = G::default();
    let root = g.node("gf_humanoid_1", None, Vec3::ZERO, Quat::IDENTITY);
    g.nodes[root]["extras"] = json!({ "gfClips": { "raise": { "loop": false, "layer": "upper", "duration": 1.0 }, "walk": { "loop": true, "speed": 1.0, "duration": 1.0 } } });
    g.scene_extras = Some(json!({ "gfGround": 0.0 }));
    let ids = place(&mut g, root, |_| Quat::IDENTITY);
    let node = |n: &str| ids.iter().find(|x| x.0 == n).unwrap().1;
    let t = g.floats(&[0.0, 1.0], "SCALAR");
    let up = Quat::from_rotation_z(std::f32::consts::FRAC_PI_2);
    let r = g.floats(&[0.0, 0.0, 0.0, 1.0, up.x, up.y, up.z, up.w], "VEC4");
    let hp = g.floats(&[0.0, 0.95, 0.0, 0.0, 0.95, 1.0], "VEC3");
    g.animations.push(json!({ "name": "raise", "samplers": [{ "input": t, "output": r, "interpolation": "LINEAR" }], "channels": [{ "sampler": 0, "target": { "node": node("LeftArm"), "path": "rotation" } }] }));
    g.animations.push(json!({ "name": "walk", "samplers": [{ "input": t, "output": hp, "interpolation": "LINEAR" }], "channels": [{ "sampler": 0, "target": { "node": node("Hips"), "path": "translation" } }] }));
    // "hop": the hips leap 1.2 m up (a boss taunt converted from a smaller rig hops like this) and sink 0.4 m first
    let ht = g.floats(&[0.0, 0.5, 1.0], "SCALAR");
    let hh = g.floats(&[0.0, 0.55, 0.0, 0.0, 2.15, 0.0, 0.0, 0.95, 0.0], "VEC3");
    g.animations.push(json!({ "name": "hop", "samplers": [{ "input": ht, "output": hh, "interpolation": "LINEAR" }], "channels": [{ "sampler": 0, "target": { "node": node("Hips"), "path": "translation" } }] }));
    g.build()
}

/// A body on the same bones resting in an A-pose (each upper arm 45° down), skinned to a mesh 1.8 m tall; with
/// `own_clip`, it carries its own "flap" animation of the left arm (played by name, not retargeted).
fn body(own_clip: bool) -> Vec<u8> {
    let mut g = G::default();
    let root = g.node("gf_body", None, Vec3::ZERO, Quat::IDENTITY);
    g.nodes[root]["extras"] = json!({ "gfSpineBend": 1.0 });
    let a = std::f32::consts::FRAC_PI_4;
    let ids = place(&mut g, root, |n| match n {
        "LeftArm" => Quat::from_rotation_z(-a),
        "RightArm" => Quat::from_rotation_z(a),
        _ => Quat::IDENTITY,
    });
    // inverse bind matrices from the nodes' world matrices
    let mut world: Vec<(usize, Mat4)> = Vec::new();
    for (n, p, t) in skeleton() {
        let r = match n {
            "LeftArm" => Quat::from_rotation_z(-a),
            "RightArm" => Quat::from_rotation_z(a),
            _ => Quat::IDENTITY,
        };
        let local = Mat4::from_rotation_translation(r, t);
        let pw = p.map(|p| world.iter().find(|x| x.0 == ids.iter().find(|i| i.0 == p).unwrap().1).unwrap().1).unwrap_or(Mat4::IDENTITY);
        world.push((ids.iter().find(|i| i.0 == n).unwrap().1, pw * local));
    }
    let ibm: Vec<f32> = world.iter().flat_map(|(_, m)| m.inverse().to_cols_array()).collect();
    let acc = g.floats(&ibm, "MAT4");
    g.skins.push(json!({ "joints": world.iter().map(|w| w.0).collect::<Vec<_>>(), "inverseBindMatrices": acc }));
    let pos = g.floats(&[0.0, 0.0, 0.0, 0.2, 0.0, 0.0, 0.0, 1.8, 0.0], "VEC3");
    g.meshes.push(json!({ "primitives": [{ "attributes": { "POSITION": pos } }] }));
    let mesh_node = g.node("body_mesh", Some(root), Vec3::ZERO, Quat::IDENTITY);
    g.nodes[mesh_node]["mesh"] = json!(0);
    g.nodes[mesh_node]["skin"] = json!(0);
    if own_clip {
        let t = g.floats(&[0.0, 1.0], "SCALAR");
        let q = Quat::from_rotation_z(-a) * Quat::from_rotation_z(0.5);
        let r = g.floats(&[Quat::from_rotation_z(-a).x, Quat::from_rotation_z(-a).y, Quat::from_rotation_z(-a).z, Quat::from_rotation_z(-a).w, q.x, q.y, q.z, q.w], "VEC4");
        let la = ids.iter().find(|x| x.0 == "LeftArm").unwrap().1;
        g.animations.push(json!({ "name": "flap", "samplers": [{ "input": t, "output": r }], "channels": [{ "sampler": 0, "target": { "node": la, "path": "rotation" } }] }));
    }
    g.build()
}

fn lib() -> (Library, usize, usize) {
    let mut l = Library::default();
    let s = l.add_clips(&standard_clips()).unwrap();
    let b = l.add_body(&body(false)).unwrap();
    (l, b, s)
}

fn joint_pos(l: &Library, b: usize, poses: &PoseBuffer, name: &str) -> Vec3 {
    poses.world[l.bone(b, name).unwrap()].w_axis.truncate()
}

#[test]
fn the_clip_file_reads_as_the_standard_with_its_metadata() {
    let s = ClipSet::parse(&standard_clips()).unwrap();
    let std = s.standard.as_ref().expect("a standard clip file");
    assert!((std.rest[humanoid::index("LeftHand").unwrap()].unwrap() - Vec3::new(0.71, 1.4, 0.0)).length() < 1e-5);
    assert!((std.hips_height - 0.95).abs() < 1e-6);
    let raise = &s.clips[s.clip("raise").unwrap()];
    assert_eq!((raise.layer, raise.looping, raise.duration), (Layer::Upper, false, 1.0));
    let walk = &s.clips[s.clip("walk").unwrap()];
    assert!(walk.looping && walk.speed == 1.0);
    let mut pose = s.rest();
    walk.sample(0.25, &mut pose);
    let hips = s.humanoid[0].unwrap();
    assert!((pose[hips].t - Vec3::new(0.0, 0.95, 0.25)).length() < 1e-5);
}

#[test]
fn a_body_reads_its_bind_pose_rest_and_box() {
    let b = Body::parse(&body(false)).unwrap();
    assert!(b.is_humanoid(), "{:?}", b.missing());
    assert_eq!(b.joints.len(), 15);
    assert_eq!(b.skins[0].len(), 15);
    assert!((b.ground - 0.0).abs() < 1e-5 && (b.height - 1.8).abs() < 1e-5);
    // the A-pose hand: the shoulder plus the arm turned 45° down
    let a = std::f32::consts::FRAC_PI_4;
    let hand = b.bind_pos(humanoid::index("LeftHand").unwrap()).unwrap();
    assert!((hand - (Vec3::new(0.18, 1.4, 0.0) + Vec3::new(a.cos(), -a.sin(), 0.0) * 0.53)).length() < 1e-4, "{hand}");
    // parents come first, and a joint's rest is relative to its parent
    for (i, j) in b.joints.iter().enumerate() {
        if let Some(p) = j.parent {
            assert!(p < i);
        }
    }
}

#[test]
fn the_retarget_lines_an_a_pose_arm_up_with_the_clip() {
    let (mut l, b, s) = lib();
    let mut an = l.animator(b, s).unwrap();
    assert!(!an.is_direct());
    let rt = l.retarget(b, s).unwrap();
    assert!((rt.k - 1.0).abs() < 1e-4, "same legs, same scale ({})", rt.k);
    assert!((rt.swing_deg[humanoid::index("LeftArm").unwrap()] - 45.0).abs() < 0.01);
    let mut poses = PoseBuffer::default();
    poses.resize(an.bone_count(&l));
    // at rest (no clip): the T-pose, so the A-pose arm is lifted to horizontal
    an.evaluate(&l, &mut poses, 0);
    let hand = joint_pos(&l, b, &poses, "LeftHand");
    assert!((hand - Vec3::new(0.71, 1.4, 0.0)).length() < 1e-3, "rest {hand}");
    assert!((joint_pos(&l, b, &poses, "Hips") - Vec3::new(0.0, 0.95, 0.0)).length() < 1e-4);
    // the clip's arm straight up: the hand above the shoulder
    an.play(&l, "raise", Play { fade: 0.0, layer: Some(Layer::Base), ..Play::default() });
    an.advance(1.0);
    an.evaluate(&l, &mut poses, 0);
    let hand = joint_pos(&l, b, &poses, "LeftHand");
    assert!((hand - Vec3::new(0.18, 1.93, 0.0)).length() < 1e-3, "raised {hand}");
    // the skin matrix is world × inverse bind
    let j = l.bone(b, "LeftHand").unwrap();
    assert!(poses.skin[j].abs_diff_eq(poses.world[j] * l.bodies[b].joints[j].ibm, 1e-5));
    assert_eq!(poses.world_floats().len(), poses.len() * 16);
}

#[test]
fn the_hips_follow_the_clip_and_a_crossfade_blends_two_clips() {
    let (mut l, b, s) = lib();
    let mut an = l.animator(b, s).unwrap();
    let mut poses = PoseBuffer::default();
    poses.resize(an.bone_count(&l));
    an.play(&l, "walk", Play { fade: 0.0, ..Play::default() });
    an.advance(0.5);
    an.evaluate(&l, &mut poses, 0);
    assert!((joint_pos(&l, b, &poses, "Hips").z - 0.5).abs() < 1e-3);
    an.advance(0.75);
    an.evaluate(&l, &mut poses, 0);
    assert!((joint_pos(&l, b, &poses, "Hips").z - 0.25).abs() < 1e-3, "it loops");
    // crossfade walk → raise over 0.5 s: halfway, the hips are halfway back toward rest
    an.play(&l, "raise", Play { fade: 0.5, layer: Some(Layer::Base), ..Play::default() });
    let walk_z = 0.25 + 0.25;
    an.advance(0.25);
    an.evaluate(&l, &mut poses, 0);
    let z = joint_pos(&l, b, &poses, "Hips").z;
    assert!((z - walk_z * 0.5).abs() < 0.02, "half faded: {z}");
    an.advance(0.3);
    an.evaluate(&l, &mut poses, 0);
    assert!(an.fading.is_none() && joint_pos(&l, b, &poses, "Hips").z.abs() < 1e-3);
}

#[test]
fn an_upper_clip_moves_only_the_upper_body_and_fades() {
    let (mut l, b, s) = lib();
    let mut an = l.animator(b, s).unwrap();
    let mut poses = PoseBuffer::default();
    poses.resize(an.bone_count(&l));
    an.play(&l, "walk", Play { fade: 0.0, ..Play::default() });
    an.play(&l, "raise", Play { fade: 0.1, ..Play::default() });
    assert!(an.upper.is_some() && an.base.is_some());
    an.advance(0.5);
    an.evaluate(&l, &mut poses, 0);
    assert!(an.upper_weight >= 1.0);
    assert!((joint_pos(&l, b, &poses, "Hips").z - 0.5).abs() < 1e-3, "the legs keep walking");
    let hand = joint_pos(&l, b, &poses, "LeftHand");
    assert!(hand.y > 1.6, "the arm is half raised ({hand})");
    an.stop(Layer::Upper);
    an.advance(0.2);
    assert_eq!(an.upper_weight, 0.0);
}

#[test]
fn an_impulse_kicks_a_bone_and_springs_back() {
    let (mut l, b, s) = lib();
    let mut an = l.animator(b, s).unwrap();
    let mut poses = PoseBuffer::default();
    poses.resize(an.bone_count(&l));
    an.evaluate(&l, &mut poses, 0);
    let rest = joint_pos(&l, b, &poses, "Head");
    let spine = l.bone(b, "Spine").unwrap();
    an.impulse(spine, Vec3::new(8.0, 0.0, 0.0), 18.0, 0.5);
    let mut most: f32 = 0.0;
    for _ in 0..12 {
        an.advance(1.0 / 120.0);
        an.evaluate(&l, &mut poses, 0);
        most = most.max(joint_pos(&l, b, &poses, "Head").distance(rest));
    }
    assert!(most > 0.05, "the head swung {most} m");
    for _ in 0..240 {
        an.advance(1.0 / 120.0);
    }
    an.evaluate(&l, &mut poses, 0);
    assert!(joint_pos(&l, b, &poses, "Head").distance(rest) < 1e-3, "and came back");
    assert!(an.impulses.is_empty());
}

#[test]
fn a_files_own_clip_plays_by_name_and_two_entities_share_one_buffer() {
    let mut l = Library::default();
    let bytes = body(true);
    let b = l.add_body(&bytes).unwrap();
    let s = l.add_clips(&bytes).unwrap();
    assert!(l.sets[s].standard.is_none(), "an A-pose file is not a standard clip file");
    let mut a1 = l.animator(b, s).unwrap();
    let mut a2 = l.animator(b, s).unwrap();
    assert!(a1.is_direct());
    let n = a1.bone_count(&l);
    let mut poses = PoseBuffer::default();
    poses.resize(n * 2);
    a1.evaluate(&l, &mut poses, 0);
    // at rest the skin matrices are identity (world = bind)
    for m in &poses.skin[..n] {
        assert!(m.abs_diff_eq(Mat4::IDENTITY, 1e-4), "{m}");
    }
    a2.play(&l, "flap", Play { fade: 0.0, ..Play::default() });
    a2.advance(1.0);
    a2.evaluate(&l, &mut poses, n);
    let j = l.bone(b, "LeftHand").unwrap();
    assert!(poses.world[n + j].w_axis.y > poses.world[j].w_axis.y + 0.1, "the second body's arm flapped up");
    assert_eq!(poses.slice(n as u32, n as u32).len(), n);
}

#[test]
fn a_body_without_a_skeleton_or_a_required_bone_is_refused() {
    assert!(Body::parse(&standard_clips()).is_err(), "no skin");
    let mut l = Library::default();
    let s = l.add_clips(&standard_clips()).unwrap();
    // the clip file's own nodes as a body would need a skin; a body missing a hand is refused by the retarget
    let b = Body::parse(&body(false)).unwrap();
    let mut b2 = b.clone();
    let h = humanoid::index("LeftHand").unwrap();
    b2.humanoid[h] = None;
    assert!(Retarget::new(&b2, l.sets[s].standard.as_ref().unwrap()).is_err());
}

#[test]
fn a_pinned_root_keeps_a_hopping_clip_on_the_ground_and_keeps_its_sink() {
    let (mut l, b, s) = lib();
    let mut an = l.animator(b, s).unwrap();
    let mut poses = PoseBuffer::default();
    poses.resize(an.bone_count(&l));
    // as authored: the hips leap 1.2 m above their rest (0.95)
    an.play(&l, "hop", Play { fade: 0.0, looping: Some(false), ..Play::default() });
    an.advance(0.5);
    an.evaluate(&l, &mut poses, 0);
    assert!((joint_pos(&l, b, &poses, "Hips").y - 2.15).abs() < 1e-3, "as authored");
    // pinned: at most 0.1 m of rise, the sink at the start kept
    an.play(&l, "hop", Play { fade: 0.0, looping: Some(false), restart: true, max_rise: Some(0.1), ..Play::default() });
    an.evaluate(&l, &mut poses, 0);
    assert!((joint_pos(&l, b, &poses, "Hips").y - 0.55).abs() < 1e-3, "the sink is kept");
    let mut top: f32 = 0.0;
    for _ in 0..120 {
        an.advance(1.0 / 120.0);
        an.evaluate(&l, &mut poses, 0);
        top = top.max(joint_pos(&l, b, &poses, "Hips").y);
    }
    assert!((top - 1.05).abs() < 1e-3, "pinned to 0.1 m above rest ({top})");
    // a crossfade out of a pinned clip stays pinned while it fades
    an.play(&l, "hop", Play { fade: 0.0, looping: Some(true), restart: true, max_rise: Some(0.0), ..Play::default() });
    an.advance(0.45);
    an.play(&l, "walk", Play { fade: 0.3, ..Play::default() });
    an.advance(0.05);
    an.evaluate(&l, &mut poses, 0);
    assert!(joint_pos(&l, b, &poses, "Hips").y <= 0.95 + 1e-3);
}

#[test]
fn a_push_tips_a_bone_toward_the_hit_and_springs_back() {
    let (mut l, b, s) = lib();
    let mut an = l.animator(b, s).unwrap();
    let mut poses = PoseBuffer::default();
    poses.resize(an.bone_count(&l));
    an.evaluate(&l, &mut poses, 0);
    let rest = joint_pos(&l, b, &poses, "Head");
    let spine = l.bone(b, "Spine").unwrap();
    // a hit from the front pushes toward −Z (model space): the head moves back, along −Z
    an.push(&l, spine, Vec3::NEG_Z, 6.0, 18.0, 0.5);
    let mut most = Vec3::ZERO;
    for _ in 0..10 {
        an.advance(1.0 / 120.0);
        an.evaluate(&l, &mut poses, 0);
        let d = joint_pos(&l, b, &poses, "Head") - rest;
        if d.length() > most.length() {
            most = d;
        }
    }
    assert!(most.z < -0.03 && most.x.abs() < 0.01, "the head went with the push ({most})");
    // a world direction into model space: a body turned π (a forge entity facing −Z draws its +Z body turned by π)
    let m = to_model(Vec3::X, Quat::from_rotation_y(std::f32::consts::PI));
    assert!((m - Vec3::NEG_X).length() < 1e-5, "{m}");
    assert_eq!(humanoid::part_bone("head"), Some("Head"));
    assert_eq!(humanoid::part_bone("body"), None);
}
