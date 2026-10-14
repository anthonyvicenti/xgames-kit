//! Bodies on the screen: which model draws each forge-anim body (`BodyBind`), the renderer's own posed bodies
//! (`Puppet`: lookdev, Studio previews, verify's poses), rigid models on a body's sockets (`Attach`: held weapons),
//! and each actor's hit flash, eye glow, tint and cloth colour over time (`ActorFx`). The host glue (forge-web
//! render.rs) turns these and the core's animated entities into `Scene::actors`, `Scene::attached` and
//! `Scene::palette` every frame.
//!
//! Sockets follow gf-humanoid-1 (research/gf-three/kit/character/RIG.md §5, rig.js `mkSocket`): `hand_r` and `hand_l`
//! sit in the palm, +Z along the hand at the standard rest, so a held item points where the hand points; `head` on
//! top of the head; `back` on the chest's back. A body may carry its own `socket_<name>` node.
use std::collections::HashMap;

use forge_anim::{humanoid, Animator, Library, PoseBuffer};
use glam::{Mat4, Quat, Vec3};

/// The model and slot a body is drawn with, and its sockets (computed once a clip set poses it).
#[derive(Clone, Debug)]
pub struct BodyBind {
    pub model: usize,
    pub slot: u32,
    /// socket name → (joint, its place on the joint)
    pub sockets: HashMap<String, (usize, Mat4)>,
    pub sockets_from: Option<usize>,
}

/// A body the renderer poses itself (not a core entity): a clip at a time, playing or held.
pub struct Puppet {
    pub body: usize,
    pub animator: Animator,
    pub transform: Mat4,
    pub visible: bool,
    pub frozen: bool,
    pub base: u32,
}

/// A rigid model on an actor's socket (or bone).
#[derive(Clone, Debug)]
pub struct Attach {
    pub owner: u32,
    pub model: usize,
    pub slot: u32,
    pub socket: String,
    pub grip: Mat4,
}

/// What an actor looks like beyond its pose, over time.
#[derive(Clone, Copy, Debug, Default)]
pub struct ActorFx {
    /// The flash: rgb, peak amount, seconds left, its length.
    pub flash: [f32; 4],
    pub flash_left: f32,
    pub flash_len: f32,
    /// The glow ramp: from, to (rgb × intensity), seconds into it, its length. None: the material's own.
    pub glow: Option<([f32; 3], [f32; 3], f32, f32)>,
    pub tint: Option<[f32; 4]>,
    pub cloth: Option<[f32; 3]>,
    /// Wave 7: a rim of light over the body (rgb linear, strength): an elite's modifier.
    pub rim: Option<[f32; 4]>,
}

impl ActorFx {
    pub fn flash_now(&self) -> [f32; 4] {
        if self.flash_left <= 0.0 || self.flash_len <= 0.0 {
            return [0.0; 4];
        }
        // full for the first two thirds, then off (2-3 frames of flat white at 0.05 s)
        let k = (self.flash_left / self.flash_len).clamp(0.0, 1.0);
        let a = if k > 0.33 { 1.0 } else { k / 0.33 };
        [self.flash[0], self.flash[1], self.flash[2], self.flash[3] * a]
    }
    pub fn glow_now(&self) -> Option<[f32; 3]> {
        self.glow.map(|(from, to, t, len)| {
            let k = if len <= 0.0 { 1.0 } else { (t / len).clamp(0.0, 1.0) };
            [from[0] + (to[0] - from[0]) * k, from[1] + (to[1] - from[1]) * k, from[2] + (to[2] - from[2]) * k]
        })
    }
    pub fn advance(&mut self, dt: f32) {
        self.flash_left = (self.flash_left - dt).max(0.0);
        if let Some(g) = self.glow.as_mut() {
            g.2 += dt;
        }
    }
    /// Start a flash: `rgb`, how far toward it, for `seconds`.
    pub fn start_flash(&mut self, rgb: [f32; 3], amount: f32, seconds: f32) {
        self.flash = [rgb[0], rgb[1], rgb[2], amount.clamp(0.0, 1.0)];
        self.flash_left = seconds.max(0.0);
        self.flash_len = seconds.max(1e-4);
    }
    /// Ramp the glow to `to` (rgb × intensity) over `seconds`, from where it is now (or from `own`, the material's).
    pub fn ramp_glow(&mut self, to: [f32; 3], seconds: f32, own: [f32; 3]) {
        let from = self.glow_now().unwrap_or(own);
        self.glow = Some((from, to, 0.0, seconds.max(0.0)));
    }
}

/// The model a rigid core entity is drawn as (the wave 1b integration): a kill's debris pieces, a coin, a weapon
/// lying in the world, a caster's orb. The host registers one per class (an entity kind, or `CLASS_ORB`) and type
/// (`ANY_TYPE`: every type of the class); the glue draws every such entity at its interpolated place.
#[derive(Clone, Copy, Debug)]
pub struct EntityModel {
    pub model: usize,
    pub slot: u32,
    /// Its fit: applied before the entity's own transform (a library bone scaled to the piece's size, a long bone
    /// laid along Z).
    pub fit: Mat4,
    /// Turns about Y (rad/s) and bobs (m) on the spot: a coin, a pickup.
    pub spin: f32,
    pub bob: f32,
}
pub const ANY_TYPE: u16 = u16::MAX;
/// A caster's orb (forge-ai's: a PROJECTILE the snapshots carry), as an entity-model class: a player's own round in
/// flight is a PROJECTILE too, and its type is a weapons row where an orb's is an enemies row.
pub const CLASS_ORB: u8 = 100;

/// The renderer's side of bodies and actors.
#[derive(Default)]
pub struct Glue {
    pub bodies: HashMap<usize, BodyBind>,
    pub puppets: Vec<Option<Puppet>>,
    pub poses: PoseBuffer,
    pub attach: Vec<Attach>,
    pub fx: HashMap<u32, ActorFx>,
    pub last_time: Option<f32>,
    pub last_tick: u64,
    pub fp_weapons: Vec<Option<crate::FpWeapon>>,
    pub unknown_particles: u32,
    /// Actors the core animates whose body has no model to draw (not bound: nobody called add_body for it).
    pub undrawn: u32,
    /// (class, type) → the model a rigid entity is drawn as.
    pub entity_models: HashMap<(u8, u16), EntityModel>,
    /// The first-person layer follows the core's feel view (the weapon in hand, its kick, sway, bob, reload, swing);
    /// off: the host poses it (`fp_pose`, the lookdev).
    pub fp_manual: bool,
    /// The weapon swung by a quick melee when the tables have no melee weapon (the built-in blade).
    pub fp_blade: Option<crate::FpWeapon>,
    /// Until this time, a puff of smoke born near the eye is the local weapon's (anchored at its muzzle).
    pub smoke_until: f32,
    /// Counted since the page loaded, for the observation: the first-person weapon's muzzle flashes shown, hit flashes
    /// started on bodies (one a hit: the look's HIT flash, forge-feel's FLASH over it), first-person swings begun.
    pub seen: [u32; 3],
    /// Whether a swing was under way at the last frame (to count its start once).
    pub swinging: bool,
    /// Wave 2: tracers begun since the page loaded (the observation's count, beside `seen`).
    pub tracers_seen: u32,
    /// Rounds in flight by net id: where each one's streak starts (the muzzle it left).
    pub rounds: HashMap<u32, Vec3>,
    /// QA: the loose pieces `debug_pieces` laid (their net ids).
    pub debug_pieces: Vec<u32>,
}

/// Puppet ids in actor ids: 1_000_000 + the puppet's index (core actors are net ids, at most 65535).
pub const PUPPET_BASE: u32 = 1_000_000;

impl Glue {
    /// The material's own glow of a model's `glow_eyes` primitives (rgb × strength), for a ramp's start.
    pub fn own_glow(scene: &crate::Scene, model: usize) -> [f32; 3] {
        scene.models.get(model).and_then(|m| m.prims.iter().find(|p| p.glow)).map(|p| p.emissive).unwrap_or([0.0; 3])
    }

    /// Sockets for a body, from a clip set (its standard rest gives each bone's rotation there). Once per body.
    pub fn ensure_sockets(&mut self, lib: &mut Library, body: usize, set: usize, model: Option<&crate::Model>) {
        let Some(b) = self.bodies.get(&body) else { return };
        if b.sockets_from.is_some() {
            return;
        }
        let sockets = sockets_of(lib, body, set, model);
        if let Some(b) = self.bodies.get_mut(&body) {
            b.sockets = sockets;
            b.sockets_from = Some(set);
        }
    }

    /// Advance every puppet by `dt` and pose it into `self.poses`; each puppet's `base` is its first bone there.
    pub fn pose_puppets(&mut self, lib: &Library, dt: f32) {
        let total: usize = self.puppets.iter().flatten().map(|p| p.animator.bone_count(lib)).sum();
        self.poses.resize(total);
        let mut base = 0usize;
        for p in self.puppets.iter_mut().flatten() {
            if !p.frozen {
                p.animator.advance(dt);
            }
            p.base = base as u32;
            p.animator.evaluate(lib, &mut self.poses, base);
            base += p.animator.bone_count(lib);
        }
    }
}

/// rig.js `mkSocket` for the hands, head and back: a place on the bone, aligned with the character at the standard
/// rest (+Z forward, +Y up), scaled to metres. A body's own `socket_<name>` node wins.
pub fn sockets_of(lib: &mut Library, body: usize, set: usize, model: Option<&crate::Model>) -> HashMap<String, (usize, Mat4)> {
    let mut out = HashMap::new();
    let Some(b) = lib.bodies.get(body).cloned() else { return out };
    // the body at the standard rest: an animator with no clip
    let rest_world: Vec<Mat4> = match lib.animator(body, set) {
        Ok(mut an) => {
            let mut pb = PoseBuffer::default();
            pb.resize(an.bone_count(lib));
            an.evaluate(lib, &mut pb, 0);
            pb.world.clone()
        }
        Err(_) => b.joints.iter().map(|j| j.bind).collect(),
    };
    let pos = |name: &str| humanoid::index(name).and_then(|h| b.bind_pos(h));
    let joint = |name: &str| humanoid::index(name).and_then(|h| b.humanoid[h]);
    let put = |name: &str, bone: &str, point: Vec3, rest_rot: Quat, out: &mut HashMap<String, (usize, Mat4)>| {
        let Some(j) = joint(bone) else { return };
        let bind = b.joints[j].bind;
        let (bs, _, _) = bind.to_scale_rotation_translation();
        let local_p = bind.inverse().transform_point3(point);
        let (_, c, _) = rest_world.get(j).copied().unwrap_or(bind).to_scale_rotation_translation();
        let rot = c.normalize().inverse() * rest_rot;
        let s = if bs.x.abs() > 1e-6 { 1.0 / bs.x } else { 1.0 };
        out.insert(name.to_string(), (j, Mat4::from_scale_rotation_translation(Vec3::splat(s), rot, local_p)));
    };
    for (name, bone, fore, mid, sgn) in [("hand_r", "RightHand", "RightForeArm", "RightHandMiddle1", -1.0f32), ("hand_l", "LeftHand", "LeftForeArm", "LeftHandMiddle1", 1.0)] {
        let (Some(hand), Some(fore)) = (pos(bone), pos(fore)) else { continue };
        let dir = (hand - fore).normalize_or(Vec3::NEG_Y);
        let reach = match pos(mid) {
            Some(m) => m.distance(hand) * 0.9,
            None => fore.distance(hand) * 0.3,
        };
        put(name, bone, hand + dir * reach, Quat::from_axis_angle(Vec3::Y, sgn * std::f32::consts::FRAC_PI_2), &mut out);
    }
    if let Some(head) = pos("Head") {
        let top = head + Vec3::Y * (b.height * 0.08).max(0.05);
        put("head", "Head", top, Quat::IDENTITY, &mut out);
    }
    if let Some(sp) = pos("Spine") {
        put("back", "Spine", sp + Vec3::NEG_Z * 0.12, Quat::IDENTITY, &mut out);
    }
    // a body's own socket nodes win (their place on their parent bone, as the file has it)
    if let Some(m) = model {
        for (name, j_name) in [("hand_r", "RightHand"), ("hand_l", "LeftHand"), ("head", "Head"), ("back", "Spine")] {
            let (Some(n), Some(j)) = (m.node_named(&format!("socket_{name}")), joint(j_name)) else { continue };
            if m.nodes[n].parent.and_then(|p| m.nodes.get(p)).is_some_and(|p| humanoid::index(&p.name).and_then(|h| b.humanoid[h]) == Some(j)) {
                out.insert(name.to_string(), (j, m.nodes[n].local));
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_flash_holds_then_drops_and_a_glow_ramps() {
        let mut fx = ActorFx::default();
        fx.start_flash([1.0; 3], 1.0, 0.05);
        assert_eq!(fx.flash_now()[3], 1.0);
        fx.advance(0.03);
        assert!(fx.flash_now()[3] > 0.5);
        fx.advance(0.03);
        assert_eq!(fx.flash_now()[3], 0.0);
        fx.ramp_glow([2.74, 1.18, 0.18], 0.3, [2.4, 1.03, 0.16]);
        fx.advance(0.15);
        let g = fx.glow_now().unwrap();
        assert!((g[0] - 2.57).abs() < 1e-3, "{g:?}");
        fx.advance(0.3);
        assert!((fx.glow_now().unwrap()[0] - 2.74).abs() < 1e-5);
    }
}
