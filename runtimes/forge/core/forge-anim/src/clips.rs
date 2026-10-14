//! A clip set: the animations a GLB holds and the node tree they animate. The gf-humanoid-1 clip file
//! (research/gf-three/library/clips/gf-humanoid-1.glb, RIG.md §4) animates the *standard skeleton*: canonical names,
//! identity rest rotations, the UAL T-pose; its per-clip metadata sits in the `gf_humanoid_1` node's extras (`gfClips`:
//! loop, layer, duration, speed, impact) and its ground in the scene's (`gfGround`). Any other file's own clips play
//! on its own skeleton by name (`Animator`'s direct mode).
use glam::{Quat, Vec3};

use crate::gltf_io::Doc;
use crate::humanoid;
use crate::pose::Trs;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Path {
    Translation,
    Rotation,
    Scale,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Interp {
    Step,
    Linear,
    Cubic,
}

#[derive(Clone, Debug)]
pub struct Channel {
    /// The node (an index into `ClipSet::nodes`).
    pub node: usize,
    pub path: Path,
    pub interp: Interp,
    pub times: Vec<f32>,
    /// 3 or 4 floats a key (×3 for cubic: in-tangent, value, out-tangent).
    pub values: Vec<f32>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Layer {
    /// The whole body (locomotion, a swing that replaces it).
    Base,
    /// Only `humanoid::upper` bones, over the base (aim, hit, throw).
    Upper,
}

#[derive(Clone, Debug)]
pub struct Clip {
    pub name: String,
    pub duration: f32,
    pub channels: Vec<Channel>,
    pub looping: bool,
    pub layer: Layer,
    /// A gait clip's speed at the standard's size, m/s (0: none).
    pub speed: f32,
    /// When a swing lands, seconds (0: none).
    pub impact: f32,
}

#[derive(Clone, Debug)]
pub struct SetNode {
    pub name: String,
    pub parent: Option<usize>,
    pub rest: Trs,
}

/// The standard skeleton's rest (RIG.md §4): positions summed from the hips, its ground and hip height.
#[derive(Clone, Debug)]
pub struct Standard {
    pub rest: [Option<Vec3>; humanoid::COUNT],
    pub ground: f32,
    pub hips_height: f32,
}

#[derive(Clone, Debug)]
pub struct ClipSet {
    pub nodes: Vec<SetNode>,
    /// Humanoid bone → node.
    pub humanoid: [Option<usize>; humanoid::COUNT],
    pub clips: Vec<Clip>,
    /// Set when the file is a standard clip file: canonical bones with identity rest rotations (any body on
    /// gf-humanoid-1 plays it through the retarget).
    pub standard: Option<Standard>,
}

fn sample_channel(c: &Channel, t: f32, out: &mut [f32; 4]) {
    let w = if c.path == Path::Rotation { 4 } else { 3 };
    let n = c.times.len();
    if n == 0 {
        return;
    }
    let stride = if c.interp == Interp::Cubic { w * 3 } else { w };
    let at = |k: usize, o: usize| -> &[f32] { &c.values[k * stride + o * w..k * stride + o * w + w] };
    let val_off = if c.interp == Interp::Cubic { 1 } else { 0 };
    if t <= c.times[0] || n == 1 {
        out[..w].copy_from_slice(at(0, val_off));
        return;
    }
    if t >= c.times[n - 1] {
        out[..w].copy_from_slice(at(n - 1, val_off));
        return;
    }
    let k = c.times.partition_point(|&x| x <= t).saturating_sub(1).min(n - 2);
    let (t0, t1) = (c.times[k], c.times[k + 1]);
    let dt = (t1 - t0).max(1e-9);
    let u = ((t - t0) / dt).clamp(0.0, 1.0);
    match c.interp {
        Interp::Step => out[..w].copy_from_slice(at(k, 0)),
        Interp::Linear => {
            let (a, b) = (at(k, 0), at(k + 1, 0));
            if w == 4 {
                let qa = Quat::from_slice(a).normalize();
                let qb = Quat::from_slice(b).normalize();
                out.copy_from_slice(&qa.slerp(qb, u).to_array());
            } else {
                for i in 0..3 {
                    out[i] = a[i] + (b[i] - a[i]) * u;
                }
            }
        }
        Interp::Cubic => {
            let (p0, m0, p1, m1) = (at(k, 1), at(k, 2), at(k + 1, 1), at(k + 1, 0));
            let (u2, u3) = (u * u, u * u * u);
            let (h00, h10, h01, h11) = (2.0 * u3 - 3.0 * u2 + 1.0, u3 - 2.0 * u2 + u, -2.0 * u3 + 3.0 * u2, u3 - u2);
            for i in 0..w {
                out[i] = h00 * p0[i] + h10 * dt * m0[i] + h01 * p1[i] + h11 * dt * m1[i];
            }
            if w == 4 {
                let q = Quat::from_slice(&out[..4]).normalize();
                out.copy_from_slice(&q.to_array());
            }
        }
    }
}

impl Clip {
    /// Write this clip at `t` seconds into `pose` (one `Trs` per set node; channels overwrite what they animate).
    pub fn sample(&self, t: f32, pose: &mut [Trs]) {
        let mut v = [0f32; 4];
        for c in &self.channels {
            let Some(p) = pose.get_mut(c.node) else { continue };
            sample_channel(c, t, &mut v);
            match c.path {
                Path::Translation => p.t = Vec3::new(v[0], v[1], v[2]),
                Path::Rotation => p.r = Quat::from_array(v).normalize(),
                Path::Scale => p.s = Vec3::new(v[0], v[1], v[2]),
            }
        }
    }
}

impl ClipSet {
    pub fn parse(bytes: &[u8]) -> Result<ClipSet, String> {
        let doc = Doc::parse(bytes)?;
        Self::from_doc(&doc)
    }

    pub fn from_doc(doc: &Doc) -> Result<ClipSet, String> {
        let g = &doc.g;
        let parents = doc.parents();
        let nodes: Vec<SetNode> = g
            .nodes()
            .map(|n| {
                let (t, r, s) = doc.trs(n.index());
                SetNode { name: n.name().unwrap_or("").to_string(), parent: parents[n.index()], rest: Trs { t, r, s } }
            })
            .collect();
        let mut humanoid_map = [None; humanoid::COUNT];
        for (i, n) in nodes.iter().enumerate() {
            if let Some(h) = humanoid::index(&n.name)
                && humanoid_map[h].is_none() {
                    humanoid_map[h] = Some(i);
                }
        }
        // per-clip metadata (gfClips on the gf_humanoid_1 node), the ground (gfGround on the scene)
        let meta = g.nodes().find(|n| n.name() == Some("gf_humanoid_1")).and_then(|n| doc.node_extras(n.index())).and_then(|e| e.get("gfClips").cloned());
        let mut clips = Vec::new();
        for a in g.animations() {
            let name = a.name().unwrap_or("").to_string();
            let mut channels = Vec::new();
            let mut duration: f32 = 0.0;
            for ch in a.channels() {
                let target = ch.target();
                let path = match target.property() {
                    gltf::animation::Property::Translation => Path::Translation,
                    gltf::animation::Property::Rotation => Path::Rotation,
                    gltf::animation::Property::Scale => Path::Scale,
                    _ => continue,
                };
                let s = ch.sampler();
                let interp = match s.interpolation() {
                    gltf::animation::Interpolation::Step => Interp::Step,
                    gltf::animation::Interpolation::Linear => Interp::Linear,
                    gltf::animation::Interpolation::CubicSpline => Interp::Cubic,
                };
                let times = doc.floats(&s.input(), 1)?;
                let w = if path == Path::Rotation { 4 } else { 3 };
                let values = doc.floats(&s.output(), w)?;
                let per = if interp == Interp::Cubic { w * 3 } else { w };
                if values.len() < times.len() * per {
                    return Err(format!("animation {name}: a channel has fewer values than keys"));
                }
                duration = duration.max(times.last().copied().unwrap_or(0.0));
                channels.push(Channel { node: target.node().index(), path, interp, times, values });
            }
            let m = meta.as_ref().and_then(|m| m.get(&name));
            let num = |k: &str| m.and_then(|m| m.get(k)).and_then(|v| v.as_f64()).map(|v| v as f32);
            let looping = m.and_then(|m| m.get("loop")).and_then(|v| v.as_bool()).unwrap_or(matches!(name.as_str(), "idle" | "walk" | "run" | "sprint" | "fall" | "aim" | "carry"));
            let layer = if m.and_then(|m| m.get("layer")).and_then(|v| v.as_str()) == Some("upper") { Layer::Upper } else { Layer::Base };
            clips.push(Clip { duration: num("duration").unwrap_or(duration).max(duration), name, channels, looping, layer, speed: num("speed").unwrap_or(0.0), impact: num("impact").unwrap_or(0.0) });
        }
        // a standard clip file: Hips, and every canonical node at an identity rest rotation
        let standard = humanoid_map[0].filter(|_| humanoid_map.iter().flatten().all(|&i| nodes[i].rest.r.abs_diff_eq(Quat::IDENTITY, 1e-4))).map(|hips| {
            let mut rest = [None; humanoid::COUNT];
            // positions summed down from the hips (rest rotations are identity, so a sum of local translations)
            let mut stack = vec![(hips, Vec3::ZERO)];
            let children = |p: usize| nodes.iter().enumerate().filter(move |(_, n)| n.parent == Some(p)).map(|(i, _)| i);
            while let Some((i, acc)) = stack.pop() {
                let pos = acc + nodes[i].rest.t;
                if let Some(h) = humanoid::index(&nodes[i].name) {
                    rest[h].get_or_insert(pos);
                }
                for c in children(i) {
                    stack.push((c, pos));
                }
            }
            let ground = doc.scene_extras().and_then(|e| e.get("gfGround").and_then(|v| v.as_f64())).unwrap_or(0.0) as f32;
            let hips_height = rest[0].map(|p| p.y).unwrap_or(0.0) - ground;
            Standard { rest, ground, hips_height }
        });
        Ok(ClipSet { nodes, humanoid: humanoid_map, clips, standard })
    }

    pub fn clip(&self, name: &str) -> Option<usize> {
        self.clips.iter().position(|c| c.name == name)
    }
    /// The rest pose of every node.
    pub fn rest(&self) -> Vec<Trs> {
        self.nodes.iter().map(|n| n.rest).collect()
    }
}
