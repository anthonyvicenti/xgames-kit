//! A body: a skinned model's skeleton read from its GLB (the joints of every skin, parents first), with each joint's
//! inverse bind matrix and its bind pose in character space, measured the way rig.js `bindPose` does (the bind frame
//! is recovered from the hips, so files exported under a scaled armature or quantized per mesh read right), its rest
//! pose made consistent with that bind pose (rig.js `poseToBind`), and the bind-pose box of its skinned vertices (its
//! ground and height).
use std::collections::HashMap;

use glam::{Mat4, Vec3};

use crate::gltf_io::Doc;
use crate::humanoid;
use crate::pose::Trs;

#[derive(Clone, Debug)]
pub struct Joint {
    pub name: String,
    /// The node index in the file.
    pub node: usize,
    /// The parent joint (None: the joint hangs under a node that is not a joint, or the scene).
    pub parent: Option<usize>,
    /// The local pose at bind (translation, rotation, scale relative to its parent).
    pub rest: Trs,
    pub ibm: Mat4,
    /// The bind pose in character space.
    pub bind: Mat4,
    /// For a joint with no parent joint: its parent node's matrix in the scene (identity under the scene itself).
    pub static_parent: Mat4,
    /// A skin lists it (false: a canonical node no skin lists, such as an end bone; it deforms nothing).
    pub skin: bool,
}

#[derive(Clone, Debug)]
pub struct Body {
    /// Every joint, parents first. The pose buffer holds one matrix per joint, in this order.
    pub joints: Vec<Joint>,
    /// Per skin in the file, its joints (in the skin's order) as indices into `joints`: a skinning shader's
    /// JOINTS_0 values index this list.
    pub skins: Vec<Vec<usize>>,
    /// Humanoid bone index → joint index (gf-humanoid-1 names).
    pub humanoid: [Option<usize>; humanoid::COUNT],
    pub by_name: HashMap<String, usize>,
    /// The bind-pose skinned vertices' lowest y and height (character space).
    pub ground: f32,
    pub height: f32,
    /// `gf_body` extras: `gfSpineBend` (0–1, default 1), `gfFingers` ("by-name" turns the palm shift off).
    pub spine_bend: f32,
    pub fingers_by_name: bool,
    /// How many skinned meshes the file has.
    pub skinned_meshes: usize,
}

impl Body {
    /// Read a body from a GLB's bytes (meshopt already decoded). Err when it has no skin.
    pub fn parse(bytes: &[u8]) -> Result<Body, String> {
        let doc = Doc::parse(bytes)?;
        Self::from_doc(&doc)
    }

    pub fn from_doc(doc: &Doc) -> Result<Body, String> {
        let g = &doc.g;
        let parents = doc.parents();
        let world = doc.world_matrices();
        // every skin's joints, the first IBM a joint gets wins (rig.js bindPose)
        let mut ibm: HashMap<usize, Mat4> = HashMap::new();
        let mut order: Vec<usize> = Vec::new();
        let mut skin_nodes: Vec<Vec<usize>> = Vec::new();
        for skin in g.skins() {
            let mats: Vec<Mat4> = match skin.inverse_bind_matrices() {
                Some(a) => doc.floats(&a, 16)?.chunks_exact(16).map(Mat4::from_cols_slice).collect(),
                None => Vec::new(),
            };
            let mut list = Vec::new();
            for (i, j) in skin.joints().enumerate() {
                let n = j.index();
                list.push(n);
                if let std::collections::hash_map::Entry::Vacant(e) = ibm.entry(n) {
                    e.insert(mats.get(i).copied().unwrap_or(Mat4::IDENTITY));
                    order.push(n);
                }
            }
            skin_nodes.push(list);
        }
        if order.is_empty() {
            return Err("the model has no skin (a body needs a skeleton)".into());
        }
        let name_of = |n: usize| g.nodes().nth(n).and_then(|x| x.name().map(str::to_string)).unwrap_or_else(|| format!("node{n}"));
        // canonical nodes that no skin lists (an end bone such as head_end) count as bones too, at their file pose
        // (rig.js findRig); they move with the skeleton but deform nothing
        let skin_joint_count = order.len();
        let mut taken: std::collections::HashSet<String> = order.iter().map(|&n| name_of(n)).collect();
        for n in g.nodes() {
            let name = name_of(n.index());
            if n.mesh().is_none() && humanoid::is_canonical(&name) && !ibm.contains_key(&n.index()) && taken.insert(name) {
                order.push(n.index());
            }
        }
        let is_skin_joint: std::collections::HashSet<usize> = order[..skin_joint_count].iter().copied().collect();
        // parents first
        let depth = |mut n: usize| {
            let mut d = 0;
            while let Some(p) = parents[n] {
                d += 1;
                n = p;
                if d > 512 {
                    break;
                }
            }
            d
        };
        order.sort_by_key(|&n| (depth(n), n));
        let joint_of: HashMap<usize, usize> = order.iter().enumerate().map(|(i, &n)| (n, i)).collect();
        // the bind frame from the hips: frame = hipsRest · IBM(hips) (identity for a plain file at its bind pose)
        let hips_node = order.iter().copied().find(|&n| name_of(n) == "Hips" && ibm.contains_key(&n));
        let frame = match hips_node {
            Some(h) => world[h] * ibm[&h],
            None => Mat4::IDENTITY,
        };
        let mut joints: Vec<Joint> = Vec::with_capacity(order.len());
        for &n in &order {
            let skin = is_skin_joint.contains(&n);
            let bind = if skin { frame * ibm[&n].inverse() } else { world[n] };
            // the direct parent when it is a joint (rig.js: a node in between makes the parent static)
            let parent_joint = parents[n].and_then(|x| joint_of.get(&x).copied());
            let static_parent = match (parent_joint, parents[n]) {
                (None, Some(x)) => world[x],
                _ => Mat4::IDENTITY,
            };
            joints.push(Joint { name: name_of(n), node: n, parent: parent_joint, rest: Trs::IDENTITY, ibm: ibm.get(&n).copied().unwrap_or(Mat4::IDENTITY), bind, static_parent, skin });
        }
        // the rest pose consistent with the bind pose (rig.js poseToBind); a bone no skin lists keeps its file pose
        for i in 0..joints.len() {
            if !joints[i].skin {
                joints[i].rest = {
                    let (t, r, s) = doc.trs(joints[i].node);
                    Trs { t, r, s }
                };
                continue;
            }
            let pw = match joints[i].parent {
                Some(p) => joints[p].bind,
                None => joints[i].static_parent,
            };
            joints[i].rest = Trs::from_mat(pw.inverse() * joints[i].bind);
        }
        let skins: Vec<Vec<usize>> = skin_nodes.iter().map(|l| l.iter().map(|n| joint_of[n]).collect()).collect();
        let mut humanoid_map = [None; humanoid::COUNT];
        let mut by_name = HashMap::new();
        for (i, j) in joints.iter().enumerate() {
            by_name.entry(j.name.clone()).or_insert(i);
            if let Some(h) = humanoid::index(&j.name)
                && humanoid_map[h].is_none() {
                    humanoid_map[h] = Some(i);
                }
        }
        // the bind-pose box of every skinned vertex (rig.js bindBox: frame · v, the skinned mesh bound at identity)
        let (mut lo, mut hi) = (Vec3::splat(f32::MAX), Vec3::splat(f32::MIN));
        let mut skinned = 0;
        for node in g.nodes() {
            let (Some(mesh), Some(skin)) = (node.mesh(), node.skin()) else { continue };
            skinned += 1;
            let mats: Vec<Mat4> = match skin.inverse_bind_matrices() {
                Some(a) => doc.floats(&a, 16)?.chunks_exact(16).map(Mat4::from_cols_slice).collect(),
                None => Vec::new(),
            };
            let f = match hips_node.and_then(|h| skin.joints().position(|j| j.index() == h)) {
                Some(i) => world[hips_node.unwrap()] * mats.get(i).copied().unwrap_or(Mat4::IDENTITY),
                None => Mat4::IDENTITY,
            };
            for prim in mesh.primitives() {
                let Some(a) = prim.get(&gltf::Semantic::Positions) else { continue };
                for v in doc.floats(&a, 3)?.chunks_exact(3) {
                    let p = f.transform_point3(Vec3::new(v[0], v[1], v[2]));
                    lo = lo.min(p);
                    hi = hi.max(p);
                }
            }
        }
        let (ground, height) = if lo.y <= hi.y { (lo.y, hi.y - lo.y) } else { (0.0, 0.0) };
        // gf_body extras
        let extras = g.nodes().find(|n| n.name() == Some("gf_body")).and_then(|n| doc.node_extras(n.index()));
        let spine_bend = extras.as_ref().and_then(|e| e.get("gfSpineBend")).and_then(|v| v.as_f64()).map(|v| v as f32).unwrap_or(1.0).clamp(0.0, 1.0);
        let fingers_by_name = extras.as_ref().and_then(|e| e.get("gfFingers")).and_then(|v| v.as_str()) == Some("by-name");
        Ok(Body { joints, skins, humanoid: humanoid_map, by_name, ground, height, spine_bend, fingers_by_name, skinned_meshes: skinned })
    }

    pub fn has(&self, h: usize) -> bool {
        self.humanoid.get(h).is_some_and(|x| x.is_some())
    }
    /// The bind position (character space) of humanoid bone `h`.
    pub fn bind_pos(&self, h: usize) -> Option<Vec3> {
        self.humanoid[h].map(|j| self.joints[j].bind.w_axis.truncate())
    }
    /// The humanoid bones it lacks that gf-humanoid-1 requires.
    pub fn missing(&self) -> Vec<&'static str> {
        (0..humanoid::COUNT).filter(|&h| humanoid::required(h) && !self.has(h)).map(humanoid::name).collect()
    }
    pub fn is_humanoid(&self) -> bool {
        self.missing().is_empty()
    }
    /// World matrices for local poses (`local[j]` for joint j), parents first.
    pub fn world_of(&self, local: &[Trs], out: &mut [Mat4]) {
        for (i, j) in self.joints.iter().enumerate() {
            let l = local.get(i).copied().unwrap_or(j.rest).mat();
            out[i] = match j.parent {
                Some(p) => out[p] * l,
                None => j.static_parent * l,
            };
        }
    }
}
