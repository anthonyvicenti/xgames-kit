//! An animator: what one entity is playing, and its pose this step.
//!
//! - **Layers.** A base clip with a crossfade from the previous one (`play(.., fade)`), and an upper-body overlay
//!   (`Layer::Upper`: aim, hit, throw; only `humanoid::upper` bones) faded in and out over the base.
//! - **Impulses.** Additive per-bone rotations on a damped spring (`impulse`): a hit kicks the bone it lands on, which
//!   swings back by itself. They are added after the retarget, in each bone's parent space.
//! - **Two modes.** A body on gf-humanoid-1 playing a standard clip file goes through the retarget (`Retarget`); a
//!   file's own clips play on its own skeleton by bone name (`direct`).
//!
//! `evaluate` writes the body's bone matrices into the pose buffer (world and skin, one per body joint).
use glam::{Mat4, Quat, Vec3};

use crate::clips::Layer;
use crate::humanoid;
use crate::pose::{PoseBuffer, Trs};
use crate::Library;

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Playing {
    pub clip: usize,
    pub time: f32,
    pub rate: f32,
    pub looping: bool,
    /// Stop on the last frame (a death) instead of ending.
    pub hold: bool,
    /// The most the clip may lift the hips above their rest height, in the clip file's metres (`f32::INFINITY`: as
    /// authored). Root pinning for clips whose hips hop high on a tall body (`Play::max_rise`).
    pub max_rise: f32,
}

/// How to start a clip (`Animator::play`).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Play {
    /// Seconds to crossfade from what played before (0: cut).
    pub fade: f32,
    /// None: the clip's own setting.
    pub looping: Option<bool>,
    pub rate: f32,
    /// None: the clip's own layer.
    pub layer: Option<Layer>,
    /// Start again from 0 if it is already playing.
    pub restart: bool,
    pub hold: bool,
    /// Pin the root: the hips may rise at most this far above their rest height (the clip file's metres; None: as
    /// authored). Sinking (an emerge from the ground) is kept. Track C2's open point: a boss's `taunt` and `emerge_leap`
    /// lift the hips to 2.2 and 2.85 m (rest 0.92), which on a 2.6 m body puts the head at 4-5 m.
    pub max_rise: Option<f32>,
}

impl Default for Play {
    fn default() -> Self {
        Self { fade: 0.2, looping: None, rate: 1.0, layer: None, restart: false, hold: false, max_rise: None }
    }
}

/// A bone's additive rotation on a damped spring (radians as a rotation vector, in the bone's parent space).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Impulse {
    /// The body joint.
    pub joint: usize,
    pub angle: Vec3,
    pub vel: Vec3,
    /// The spring's angular frequency (rad/s) and damping ratio.
    pub omega: f32,
    pub zeta: f32,
}

#[derive(Clone, Debug)]
pub struct Animator {
    pub body: usize,
    pub set: usize,
    pub base: Option<Playing>,
    /// The clip faded out of: it, the time into the fade, the fade's length.
    pub fading: Option<(Playing, f32, f32)>,
    pub upper: Option<Playing>,
    pub upper_weight: f32,
    /// Seconds to fade the upper layer in or out (its target weight is 1 while it plays).
    pub upper_fade: f32,
    pub impulses: Vec<Impulse>,
    /// Keep the hips over the origin (a clip that walks away in place).
    pub pin_xz: bool,
    direct: bool,
    joints: usize,
    // direct mode: per body joint, the set node of the same name
    by_name: Vec<Option<usize>>,
    // the set's pose being built (one Trs per set node), and the body's
    set_pose: Vec<Trs>,
    tmp: Vec<Trs>,
    body_pose: Vec<Trs>,
    world: Vec<Mat4>,
}

impl Animator {
    /// Use `Library::animator`: it builds the retarget this body needs for this set once.
    pub(crate) fn new(lib: &Library, body: usize, set: usize, direct: bool) -> Animator {
        let b = &lib.bodies[body];
        let s = &lib.sets[set];
        let n = b.joints.len();
        let by_name = b.joints.iter().map(|j| s.nodes.iter().position(|x| x.name == j.name)).collect();
        Animator { body, set, base: None, fading: None, upper: None, upper_weight: 0.0, upper_fade: 0.15, impulses: Vec::new(), pin_xz: false, direct, joints: n, by_name, set_pose: s.rest(), tmp: s.rest(), body_pose: b.joints.iter().map(|j| j.rest).collect(), world: vec![Mat4::IDENTITY; n] }
    }

    /// The number of bones it writes (the body's joints).
    pub fn bone_count(&self, _lib: &Library) -> usize {
        self.joints
    }
    pub fn is_direct(&self) -> bool {
        self.direct
    }

    /// Play a clip by name. → false when the set has no such clip.
    pub fn play(&mut self, lib: &Library, name: &str, p: Play) -> bool {
        let Some(set) = lib.sets.get(self.set) else { return false };
        let Some(clip) = set.clip(name) else { return false };
        let c = &set.clips[clip];
        let layer = p.layer.unwrap_or(c.layer);
        let playing = Playing { clip, time: 0.0, rate: p.rate, looping: p.looping.unwrap_or(c.looping), hold: p.hold, max_rise: p.max_rise.unwrap_or(f32::INFINITY) };
        match layer {
            Layer::Base => {
                if let Some(cur) = self.base {
                    if cur.clip == clip && !p.restart {
                        self.base = Some(Playing { rate: p.rate, max_rise: playing.max_rise, ..cur });
                        return true;
                    }
                    self.fading = if p.fade > 0.0 { Some((cur, 0.0, p.fade)) } else { None };
                }
                self.base = Some(playing);
            }
            Layer::Upper => {
                if self.upper.is_some_and(|u| u.clip == clip) && !p.restart {
                    return true;
                }
                self.upper = Some(playing);
                self.upper_fade = p.fade.max(1e-3);
            }
        }
        true
    }

    /// Stop the upper layer (it fades out), or the base (the body returns to rest).
    pub fn stop(&mut self, layer: Layer) {
        match layer {
            Layer::Upper => self.upper = None,
            Layer::Base => {
                self.base = None;
                self.fading = None;
            }
        }
    }

    /// Kick a bone: add `spin` (rad/s, a rotation vector in the bone's parent space) to its spring. `omega` and `zeta`:
    /// how fast and how damped it swings back (a hit flinch: about 18 rad/s at 0.5). `bone` is a body joint index
    /// (`Library::bone` finds one by name).
    pub fn impulse(&mut self, bone: usize, spin: Vec3, omega: f32, zeta: f32) {
        if bone >= self.joints {
            return;
        }
        match self.impulses.iter_mut().find(|i| i.joint == bone) {
            Some(i) => {
                i.vel += spin;
                i.omega = omega;
                i.zeta = zeta;
            }
            None => self.impulses.push(Impulse { joint: bone, angle: Vec3::ZERO, vel: spin, omega, zeta }),
        }
    }

    /// Push a bone away from a hit (the per-bone spring track F's hit impulses drive): the bone tips so that it moves
    /// along `dir_model` (the hit's direction in the body's model space: `to_model` turns a world direction into it),
    /// at `strength` rad/s on the spring (`impulse`). Uses the pose of the last `evaluate` for the bone's parent.
    pub fn push(&mut self, lib: &Library, bone: usize, dir_model: Vec3, strength: f32, omega: f32, zeta: f32) {
        let Some(body) = lib.bodies.get(self.body) else { return };
        let Some(j) = body.joints.get(bone) else { return };
        let d = Vec3::new(dir_model.x, 0.0, dir_model.z).normalize_or_zero();
        if d == Vec3::ZERO || !(strength > 0.0) {
            return;
        }
        // about up × dir: the bone's far end swings toward dir; the spring lives in the bone's parent space
        let axis = Vec3::Y.cross(d).normalize_or(Vec3::X);
        let parent = j.parent.and_then(|p| self.world.get(p)).map(|m| m.to_scale_rotation_translation().1.normalize()).unwrap_or(Quat::IDENTITY);
        self.impulse(bone, parent.inverse() * axis * strength, omega, zeta);
    }

    /// Advance the clocks and the springs by `dt` seconds.
    pub fn advance(&mut self, dt: f32) {
        let adv = |p: &mut Playing| p.time += dt * p.rate;
        if let Some(b) = self.base.as_mut() {
            adv(b);
        }
        if let Some((f, t, len)) = self.fading.as_mut() {
            adv(f);
            *t += dt;
            if *t >= *len {
                self.fading = None;
            }
        }
        if let Some(u) = self.upper.as_mut() {
            adv(u);
        }
        let target = if self.upper.is_some() { 1.0 } else { 0.0 };
        let step = dt / self.upper_fade.max(1e-3);
        self.upper_weight = if self.upper_weight < target { (self.upper_weight + step).min(target) } else { (self.upper_weight - step).max(target) };
        for i in self.impulses.iter_mut() {
            // semi-implicit damped spring toward zero
            let acc = -i.omega * i.omega * i.angle - 2.0 * i.zeta * i.omega * i.vel;
            i.vel += acc * dt;
            i.angle += i.vel * dt;
        }
        self.impulses.retain(|i| i.angle.length_squared() > 1e-8 || i.vel.length_squared() > 1e-6);
    }

    fn clip_time(lib: &Library, set: usize, p: &Playing) -> f32 {
        let d = lib.sets[set].clips[p.clip].duration.max(1e-6);
        if p.looping { p.time.rem_euclid(d) } else { p.time.clamp(0.0, d) }
    }

    /// Is the base clip done (a one-shot past its end)?
    pub fn finished(&self, lib: &Library) -> bool {
        self.base.is_some_and(|b| !b.looping && !b.hold && b.time >= lib.sets[self.set].clips[b.clip].duration)
    }

    /// Write this entity's bone matrices into `out` from `base` (one per body joint).
    pub fn evaluate(&mut self, lib: &Library, out: &mut PoseBuffer, base: usize) {
        let (Some(body), Some(set)) = (lib.bodies.get(self.body), lib.sets.get(self.set)) else { return };
        if base + self.joints > out.len() {
            return;
        }
        // 1. the set's pose: rest, the base clip, the clip faded out of, the upper layer
        for (p, n) in self.set_pose.iter_mut().zip(set.nodes.iter()) {
            *p = n.rest;
        }
        if let Some(b) = self.base {
            set.clips[b.clip].sample(Self::clip_time(lib, self.set, &b), &mut self.set_pose);
            pin_root(set, &mut self.set_pose, b.max_rise);
        }
        if let Some((f, t, len)) = self.fading {
            for (p, n) in self.tmp.iter_mut().zip(set.nodes.iter()) {
                *p = n.rest;
            }
            set.clips[f.clip].sample(Self::clip_time(lib, self.set, &f), &mut self.tmp);
            pin_root(set, &mut self.tmp, f.max_rise);
            let w = (t / len.max(1e-6)).clamp(0.0, 1.0);
            for (cur, old) in self.set_pose.iter_mut().zip(self.tmp.iter()) {
                *cur = Trs::blend(old, cur, w);
            }
        }
        if self.upper_weight > 0.0
            && let Some(u) = self.upper {
                self.tmp.copy_from_slice(&self.set_pose);
                set.clips[u.clip].sample(Self::clip_time(lib, self.set, &u), &mut self.tmp);
                for h in 0..humanoid::COUNT {
                    if humanoid::upper(h)
                        && let Some(i) = set.humanoid[h] {
                            self.set_pose[i] = Trs::blend(&self.set_pose[i], &self.tmp[i], self.upper_weight);
                        }
                }
            }
        // 2. the body's local pose
        for (p, j) in self.body_pose.iter_mut().zip(body.joints.iter()) {
            *p = j.rest;
        }
        match (self.direct, lib.retarget(self.body, self.set)) {
            (false, Some(rt)) => {
                let std_local: [Option<Quat>; humanoid::COUNT] = std::array::from_fn(|h| set.humanoid[h].map(|i| self.set_pose[i].r));
                let hips = set.humanoid[0].map(|i| self.set_pose[i].t).unwrap_or(Vec3::ZERO);
                rt.apply(body, &std_local, hips, self.pin_xz, &mut self.body_pose);
            }
            _ => {
                for (i, k) in self.by_name.iter().enumerate() {
                    if let Some(k) = *k {
                        self.body_pose[i] = self.set_pose[k];
                    }
                }
            }
        }
        // 3. impulses, in each bone's parent space
        for imp in &self.impulses {
            if let Some(p) = self.body_pose.get_mut(imp.joint) {
                p.r = (Quat::from_scaled_axis(imp.angle) * p.r).normalize();
            }
        }
        // 4. world and skin matrices
        body.world_of(&self.body_pose, &mut self.world);
        for (i, j) in body.joints.iter().enumerate() {
            out.world[base + i] = self.world[i];
            out.skin[base + i] = self.world[i] * j.ibm;
        }
    }
}

/// Hold a sampled pose's hips at most `max_rise` above their rest height (the clip file's units). Sinking is kept.
fn pin_root(set: &crate::clips::ClipSet, pose: &mut [Trs], max_rise: f32) {
    if !max_rise.is_finite() {
        return;
    }
    let Some(h) = set.humanoid[0] else { return };
    let rest = set.nodes[h].rest.t.y;
    if let Some(p) = pose.get_mut(h)
        && p.t.y - rest > max_rise {
            p.t.y = rest + max_rise.max(0.0);
        }
}

/// A world direction in a body's model space: `body_rot` is the body's world rotation (for a gf-humanoid-1 body drawn
/// on a forge entity: the entity's rotation turned by π about Y, since the body faces +Z and the entity −Z).
pub fn to_model(dir_world: Vec3, body_rot: Quat) -> Vec3 {
    body_rot.inverse() * dir_world
}
