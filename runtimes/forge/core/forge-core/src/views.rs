//! State out (PLAN §2; ARCHITECTURE.md "Views"): flat f32 arrays the JS host and the renderer read after every tick,
//! structure-of-arrays (field `f` of row `i` is `array[f * capacity + i]`), with transforms interpolated between the
//! last two fixed steps (render interpolation). The host re-reads them every tick (memory growth detaches old views).
//!
//! - `players`: `player::FIELDS` × `MAX_PLAYERS`, sorted by player id.
//! - `entities`: `entity::FIELDS` × `MAX_ENTITIES`, every entity with a net id, a kind and a transform (players too),
//!   sorted by net id; `BONE_BASE`/`BONE_COUNT` index the bone palette.
//! - `camera`: `camera::FIELDS` floats: the local player's eyes with the feel's offsets (`CameraRig`) on top.
//! - the bone palette is `AnimWorld::poses` (16 floats a bone, column-major, model space; forge-anim).
use glam::{Quat, Vec2, Vec3};

use crate::components::*;
use crate::sim::{Animated, Sim};

pub const MAX_PLAYERS: usize = 8;
pub const MAX_ENTITIES: usize = 2048;

/// Fields of the players view. 0..=11 are wave 0's, in its order.
pub mod player {
    pub const ID: usize = 0;
    pub const X: usize = 1;
    pub const Y: usize = 2;
    pub const Z: usize = 3;
    pub const YAW: usize = 4;
    pub const PITCH: usize = 5;
    pub const VX: usize = 6;
    pub const VY: usize = 7;
    pub const VZ: usize = 8;
    pub const GROUNDED: usize = 9;
    pub const LOCAL: usize = 10;
    pub const SPEED: usize = 11;
    pub const HP: usize = 12;
    pub const HP_MAX: usize = 13;
    pub const ARMOR: usize = 14;
    pub const ALIVE: usize = 15;
    pub const FIELDS: usize = 16;
}

/// Fields of the entities view.
pub mod entity {
    pub const NET: usize = 0;
    pub const KIND: usize = 1;
    pub const TYPE: usize = 2;
    pub const X: usize = 3;
    pub const Y: usize = 4;
    pub const Z: usize = 5;
    pub const QX: usize = 6;
    pub const QY: usize = 7;
    pub const QZ: usize = 8;
    pub const QW: usize = 9;
    pub const SCALE: usize = 10;
    /// Health as a share of the most (1 with no health).
    pub const HP: usize = 11;
    /// `FLAG_*` bits.
    pub const FLAGS: usize = 12;
    pub const BONE_BASE: usize = 13;
    pub const BONE_COUNT: usize = 14;
    /// Horizontal speed, m/s.
    pub const SPEED: usize = 15;
    pub const FIELDS: usize = 16;
    pub const FLAG_DEAD: u32 = 1;
    pub const FLAG_REPLICA: u32 = 2;
    pub const FLAG_GROUNDED: u32 = 4;
    pub const FLAG_ANIMATED: u32 = 8;
}

/// The camera view.
pub mod camera {
    pub const X: usize = 0;
    pub const Y: usize = 1;
    pub const Z: usize = 2;
    pub const YAW: usize = 3;
    pub const PITCH: usize = 4;
    /// How far between the last two steps this frame is drawn (0..1).
    pub const ALPHA: usize = 5;
    /// Vertical field of view, degrees (the table's plus the feel's punch).
    pub const FOV: usize = 6;
    pub const ROLL: usize = 7;
    /// The local player's id (0: none).
    pub const PLAYER: usize = 8;
    pub const FIELDS: usize = 16;
}

pub struct Views {
    pub players: Vec<f32>,
    pub player_count: usize,
    pub entities: Vec<f32>,
    pub entity_count: usize,
    pub camera: Vec<f32>,
}

impl Default for Views {
    fn default() -> Self {
        Self { players: vec![0.0; player::FIELDS * MAX_PLAYERS], player_count: 0, entities: vec![0.0; entity::FIELDS * MAX_ENTITIES], entity_count: 0, camera: vec![0.0; camera::FIELDS] }
    }
}

impl Views {
    /// Fill every view from the sim, `alpha` of the way from the previous step to the last.
    pub fn fill(&mut self, sim: &Sim, alpha: f32) {
        self.fill_players(sim, alpha);
        self.fill_entities(sim, alpha);
    }

    fn fill_players(&mut self, sim: &Sim, alpha: f32) {
        let v = &mut self.players;
        v.iter_mut().for_each(|x| *x = 0.0);
        self.camera.iter_mut().for_each(|x| *x = 0.0);
        self.camera[camera::ALPHA] = alpha;
        self.camera[camera::FOV] = sim.tables.player.fov + sim.camera.fov_add;
        let mut rows: Vec<_> = sim.world.query::<(&Player, &Transform, &Look, Option<&Velocity>, Option<&crate::physics::Mover>, Option<&Health>, Option<&Replica>)>().iter().map(|(p, t, l, v, m, h, r)| (*p, *t, *l, v.copied().unwrap_or_default(), m.map(|m| m.grounded).unwrap_or(true), h.copied(), r.copied())).collect();
        rows.sort_by_key(|r| r.0.id);
        self.player_count = rows.len().min(MAX_PLAYERS);
        for (i, (p, t, look, vel, grounded, hp, replica)) in rows.iter().take(MAX_PLAYERS).enumerate() {
            let (at, rot) = t.interpolated(alpha);
            let mut put = |f: usize, x: f32| v[f * MAX_PLAYERS + i] = x;
            put(player::ID, p.id as f32);
            put(player::X, at.x);
            put(player::Y, at.y);
            put(player::Z, at.z);
            put(player::YAW, look.yaw);
            put(player::PITCH, look.pitch);
            put(player::VX, vel.linear.x);
            put(player::VY, vel.linear.y);
            put(player::VZ, vel.linear.z);
            put(player::GROUNDED, *grounded as u8 as f32);
            put(player::LOCAL, p.local as u8 as f32);
            put(player::SPEED, Vec2::new(vel.linear.x, vel.linear.z).length());
            put(player::HP, hp.map(|h| h.hp).unwrap_or(0.0));
            put(player::HP_MAX, hp.map(|h| h.max).unwrap_or(0.0));
            put(player::ARMOR, hp.map(|h| h.armor).unwrap_or(0.0));
            put(player::ALIVE, hp.map(|h| !h.dead).unwrap_or(true) as u8 as f32);
            if p.local {
                let rig = &sim.camera;
                // a joiner's camera catches up with a correction of its predicted player over ~0.1 s (net.rs `smooth`)
                let smooth = sim.res.get::<crate::net::NetState>().map(|n| n.smooth).unwrap_or(Vec3::ZERO);
                let eye = at + Vec3::Y * sim.tables.player.eye + rig.offset + smooth;
                // a viewer's camera is the eyes of a replica (wave 4; net.rs): its look arrives ten times a second,
                // so the view turns between the last two samples as the body moves between them
                let (yaw, pitch) = match replica {
                    Some(r) => (crate::snapshot::yaw_of_rot(rot), r.pitch_at(alpha)),
                    None => (look.yaw, look.pitch),
                };
                let c = &mut self.camera;
                c[camera::X] = eye.x;
                c[camera::Y] = eye.y;
                c[camera::Z] = eye.z;
                c[camera::YAW] = yaw + rig.yaw;
                c[camera::PITCH] = (pitch + rig.pitch).clamp(-1.55, 1.55);
                c[camera::ROLL] = rig.roll;
                c[camera::PLAYER] = p.id as f32;
            }
        }
    }

    fn fill_entities(&mut self, sim: &Sim, alpha: f32) {
        let v = &mut self.entities;
        let mut rows: Vec<(u32, Kind, Transform, Option<Health>, u32, u32, u32, f32)> = Vec::new();
        for (net, k, t, h, a, r, m, vel) in sim.world.query::<(&NetId, &Kind, &Transform, Option<&Health>, Option<&Animated>, Option<&Replica>, Option<&crate::physics::Mover>, Option<&Velocity>)>().iter() {
            let mut flags = 0;
            if h.is_some_and(|h| h.dead) {
                flags |= entity::FLAG_DEAD;
            }
            if r.is_some() {
                flags |= entity::FLAG_REPLICA;
            }
            if m.is_some_and(|m| m.grounded) {
                flags |= entity::FLAG_GROUNDED;
            }
            let (base, count) = a.map(|a| (a.base, a.count)).unwrap_or((0, 0));
            if a.is_some() {
                flags |= entity::FLAG_ANIMATED;
            }
            let speed = vel.map(|v| Vec2::new(v.linear.x, v.linear.z).length()).unwrap_or(0.0);
            rows.push((net.0, *k, *t, h.copied(), flags, base, count, speed));
        }
        rows.sort_by_key(|r| r.0);
        self.entity_count = rows.len().min(MAX_ENTITIES);
        for (i, (net, k, t, h, flags, base, count, speed)) in rows.iter().take(MAX_ENTITIES).enumerate() {
            let (p, q): (Vec3, Quat) = t.interpolated(alpha);
            let mut put = |f: usize, x: f32| v[f * MAX_ENTITIES + i] = x;
            put(entity::NET, *net as f32);
            put(entity::KIND, k.kind as f32);
            put(entity::TYPE, k.type_ as f32);
            put(entity::X, p.x);
            put(entity::Y, p.y);
            put(entity::Z, p.z);
            put(entity::QX, q.x);
            put(entity::QY, q.y);
            put(entity::QZ, q.z);
            put(entity::QW, q.w);
            put(entity::SCALE, t.scale);
            put(entity::HP, h.map(|h| h.fraction()).unwrap_or(1.0));
            put(entity::FLAGS, *flags as f32);
            put(entity::BONE_BASE, *base as f32);
            put(entity::BONE_COUNT, *count as f32);
            put(entity::SPEED, *speed);
        }
    }
}
