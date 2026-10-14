//! `Sim`: what every system gets (`&mut Sim`): the ECS world, physics, the tables, the events, names, time, a seeded
//! random stream, animation, and a typed resource map where a crate keeps its own state (`res`). Plus the operations
//! more than one crate needs, so each does them the same way: spawning players and actors, despawning (deferred to the
//! end of the stage), dealing damage (armour, death, the hit and kill events), and tracing a ray through the world
//! and every hurtbox.
use std::any::{Any, TypeId};
use std::collections::{BTreeMap, HashMap};

use glam::{Mat4, Quat, Vec3};
use hecs::Entity;

use crate::components::*;
use crate::events::{self, Event, Events};
use crate::hurtbox;
use crate::names::Names;
use crate::physics::{groups, Body, Mover, Physics, QueryMask};
use crate::tables::Tables;

/// A crate's own state, one value per type (`sim.res.get_mut::<FeelState>()`).
#[derive(Default)]
pub struct Resources {
    map: HashMap<TypeId, Box<dyn Any>>,
}

impl Resources {
    pub fn insert<T: 'static>(&mut self, v: T) {
        self.map.insert(TypeId::of::<T>(), Box::new(v));
    }
    pub fn get<T: 'static>(&self) -> Option<&T> {
        self.map.get(&TypeId::of::<T>()).and_then(|b| b.downcast_ref())
    }
    pub fn get_mut<T: 'static>(&mut self) -> Option<&mut T> {
        self.map.get_mut(&TypeId::of::<T>()).and_then(|b| b.downcast_mut())
    }
    /// The value, made with `Default` the first time.
    pub fn entry<T: Default + 'static>(&mut self) -> &mut T {
        self.map.entry(TypeId::of::<T>()).or_insert_with(|| Box::new(T::default())).downcast_mut().expect("one type, one value")
    }
    pub fn remove<T: 'static>(&mut self) -> Option<T> {
        self.map.remove(&TypeId::of::<T>()).and_then(|b| b.downcast().ok()).map(|b| *b)
    }
    /// Take a value out while a system needs `&mut Sim` and it at once; put it back with `insert`.
    pub fn take<T: Default + 'static>(&mut self) -> T {
        self.remove::<T>().unwrap_or_default()
    }
}

/// Simulation time. `step` counts fixed steps since the start; `now` is `step × STEP` in seconds.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct Time {
    pub step: u64,
    pub now: f64,
    pub dt: f32,
}

/// A small seeded random stream (xorshift64*): the same seed, the same game. Systems never use another source.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Rng(u64);

impl Default for Rng {
    fn default() -> Self {
        Self::new(1)
    }
}

impl Rng {
    pub fn new(seed: u64) -> Self {
        Self(seed.wrapping_mul(0x9E37_79B9_7F4A_7C15) | 1)
    }
    pub fn next_u64(&mut self) -> u64 {
        let mut x = self.0;
        x ^= x >> 12;
        x ^= x << 25;
        x ^= x >> 27;
        self.0 = x;
        x.wrapping_mul(0x2545_F491_4F6C_DD1D)
    }
    /// 0 ≤ x < 1.
    pub fn f32(&mut self) -> f32 {
        (self.next_u64() >> 40) as f32 / (1u64 << 24) as f32
    }
    pub fn range(&mut self, lo: f32, hi: f32) -> f32 {
        lo + (hi - lo) * self.f32()
    }
    /// A direction within `spread` radians of `dir`.
    pub fn cone(&mut self, dir: Vec3, spread: f32) -> Vec3 {
        let d = dir.normalize_or(Vec3::NEG_Z);
        if spread <= 0.0 {
            return d;
        }
        let (u, v) = d.any_orthonormal_pair();
        let a = self.range(0.0, std::f32::consts::TAU);
        let r = spread * self.f32().sqrt();
        (d + (u * a.cos() + v * a.sin()) * r.tan()).normalize()
    }
}

/// The camera's offsets on top of the local player's eyes, written by the feel systems each step (kick, shake, bob,
/// FOV punch: track F) and read by the views. The core never writes it but to reset it.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct CameraRig {
    /// Metres, world space, added to the eye.
    pub offset: Vec3,
    /// Radians added to the look (recoil kick).
    pub pitch: f32,
    pub yaw: f32,
    pub roll: f32,
    /// Degrees added to the vertical field of view.
    pub fov_add: f32,
}

/// A player's walking state for the core's basic movement (`core.move`, `core.walk`).
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct Walker {
    pub coyote: f32,
    pub jump_buffer: f32,
    /// Seconds off the ground.
    pub air: f32,
    /// Metres walked since the last footstep.
    pub walked: f32,
    /// The fastest fall since leaving the ground (m/s), for the landing.
    pub fall: f32,
    pub spawn: Vec3,
    pub spawn_yaw: f32,
    pub was_grounded: bool,
}

/// One trace's hit (`Sim::trace`): a hurt region of an entity, a body without one, or the world.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct TraceHit {
    pub entity: Option<Entity>,
    /// The entity's net id (0: the world).
    pub net: u32,
    pub dist: f32,
    pub point: Vec3,
    pub normal: Vec3,
    pub part: Part,
    /// The region's index in the entity's Hurtbox (0 when it has none).
    pub region: u32,
    pub damage: f32,
    pub crit: bool,
}

/// What `Sim::damage` did.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct Dealt {
    pub damage: f32,
    pub killed: bool,
}

/// The core's animation state: the clip sets and bodies loaded from slot files, and the bone matrices of every
/// animated entity this step (`forge_anim::PoseBuffer`, structure-of-arrays the views expose).
#[derive(Default)]
pub struct AnimWorld {
    pub library: forge_anim::Library,
    pub poses: forge_anim::PoseBuffer,
}

/// An animated entity: its animator and where its bones are in `AnimWorld::poses` this step.
pub struct Animated {
    pub animator: forge_anim::Animator,
    pub base: u32,
    pub count: u32,
}

pub struct Sim {
    pub world: hecs::World,
    pub physics: Physics,
    pub events: Events,
    pub tables: Tables,
    pub names: Names,
    pub res: Resources,
    pub time: Time,
    pub rng: Rng,
    pub anim: AnimWorld,
    pub camera: CameraRig,
    /// Player id → entity.
    pub players: BTreeMap<u32, Entity>,
    /// Below this height a player is brought back to where it spawned.
    pub floor_limit: f32,
    net: HashMap<u32, Entity>,
    next_net: u32,
    next_local: u32,
    despawns: Vec<Entity>,
}

impl Default for Sim {
    fn default() -> Self {
        Self {
            world: hecs::World::new(),
            physics: Physics::new(),
            events: Events::default(),
            tables: Tables::default(),
            names: Names::default(),
            res: Resources::default(),
            time: Time { dt: crate::STEP, ..Time::default() },
            rng: Rng::default(),
            anim: AnimWorld::default(),
            camera: CameraRig::default(),
            players: BTreeMap::new(),
            floor_limit: -20.0,
            net: HashMap::new(),
            next_net: FIRST_NET_ID,
            next_local: LOCAL_NET_ID,
            despawns: Vec::new(),
        }
    }
}

/// The first net id an actor gets (players keep 1..=255).
pub const FIRST_NET_ID: u32 = 256;
pub const MAX_NET_ID: u32 = 65535;
/// The first net id of this copy's own entities (`spawn_local`: debris, coins, a player's own rounds): the host's
/// actors keep FIRST_NET_ID..LOCAL_NET_ID, so an id a joiner gives its own debris never meets one in a snapshot.
pub const LOCAL_NET_ID: u32 = 32768;

impl Sim {
    // ---- events ----

    pub fn emit(&mut self, e: Event) {
        self.events.push(e);
    }
    /// A sound by its assets.json name, at `pos` (`source`: who made it, a net id or 0).
    pub fn sound(&mut self, name: &str, pos: Vec3, gain_db: f32, source: u32) {
        if name.is_empty() {
            return;
        }
        let id = self.names.id(name);
        self.events.push(Event::Sound(events::Sound { name: id, source, pos, gain_db, rate: 1.0 }));
    }
    /// A rule event for rules.js (`rules.event(ctx, name, {entity, a, b, c, d}, 'forge')`).
    pub fn rule(&mut self, name: &str, entity: u32, a: f32, b: f32, c: f32, d: f32) {
        let id = self.names.id(name);
        self.events.push(Event::Rule(events::Rule { name: id, entity, a, b, c, d }));
    }

    // ---- net ids ----

    /// A free net id for an actor the snapshots carry (256..LOCAL_NET_ID, reused after a despawn).
    pub fn new_net_id(&mut self) -> u32 {
        for _ in 0..(LOCAL_NET_ID - FIRST_NET_ID) {
            let id = self.next_net;
            self.next_net = if self.next_net >= LOCAL_NET_ID - 1 { FIRST_NET_ID } else { self.next_net + 1 };
            if !self.net.contains_key(&id) {
                return id;
            }
        }
        0
    }
    /// A free net id for an entity that is this copy's own (LOCAL_NET_ID..=65535; `spawn_local`).
    pub fn new_local_net_id(&mut self) -> u32 {
        for _ in 0..(MAX_NET_ID - LOCAL_NET_ID + 1) {
            let id = self.next_local;
            self.next_local = if self.next_local >= MAX_NET_ID { LOCAL_NET_ID } else { self.next_local + 1 };
            if !self.net.contains_key(&id) {
                return id;
            }
        }
        0
    }
    pub fn entity_of(&self, net: u32) -> Option<Entity> {
        self.net.get(&net).copied()
    }
    /// Forget a net id (its entity is gone without the usual despawn).
    pub fn forget_net(&mut self, net: u32) {
        self.net.remove(&net);
    }
    pub fn net_of(&self, e: Entity) -> u32 {
        self.world.get::<&NetId>(e).map(|n| n.0).unwrap_or(0)
    }
    /// Give an entity a net id (and remember it); a replica takes the host's id.
    pub fn set_net_id(&mut self, e: Entity, id: u32) {
        if let Ok(old) = self.world.get::<&NetId>(e).map(|n| n.0) {
            self.net.remove(&old);
        }
        let _ = self.world.insert_one(e, NetId(id));
        self.net.insert(id, e);
    }

    // ---- spawning ----

    /// A player (feet at `feet`, the core's yaw): its controller, body, hurtbox, health and walking state.
    pub fn spawn_player(&mut self, id: u32, feet: Vec3, yaw: f32, local: bool, owned: bool) -> Entity {
        self.spawn_player_flags(id, feet, yaw, local, owned, 0)
    }

    /// `spawn_player` with the SPAWN event's flags (`events::FLAG_REMOTE` for a replica from a snapshot).
    pub fn spawn_player_flags(&mut self, id: u32, feet: Vec3, yaw: f32, local: bool, owned: bool, flags: u32) -> Entity {
        if let Some(e) = self.players.get(&id).copied() {
            self.despawn_now(e);
        }
        let t = self.tables.player.clone();
        let e = self.world.spawn((
            Transform::facing(feet, yaw),
            Velocity::default(),
            Player { id, local, owned },
            Look { yaw, pitch: 0.0 },
            Control { enabled: true, ..Control::default() },
            Health { armor: t.armor, ..Health::new(t.health) },
            Team::PLAYERS,
            Kind { kind: kind::PLAYER, type_: 0 },
            Walker { spawn: feet, spawn_yaw: yaw, ..Walker::default() },
            Hurtbox::upright(t.radius, t.height, groups::PLAYER),
        ));
        self.set_net_id(e, id);
        let mut mover = Mover::new(t.radius, t.half_height());
        mover.step_height = t.step_height;
        mover.slope_max = t.slope_max.to_radians();
        mover.snap = t.snap;
        mover.blocks = groups::PLAYER_BLOCKS;
        let body = self.physics.add_character(e, feet, &mover, groups::PLAYER);
        // what its body wears and holds (components::Wear): the first weapon in hand when the tables have weapons
        let held = if self.tables.weapons.is_empty() { HELD_NONE } else { 0 };
        let _ = self.world.insert(e, (mover, body, Wear { held, hidden: local, ..Wear::default() }));
        self.players.insert(id, e);
        self.events.push_flags(Event::Spawn(events::Spawn { id, kind: kind::PLAYER, type_: 0, pos: feet, yaw }), flags);
        e
    }

    /// An actor (an enemy, a projectile, a pickup) with a fresh net id, at `pos` facing `yaw`. The caller adds the rest
    /// (a body with `add_character` or `physics.add_*`, health, a hurtbox, its own components).
    pub fn spawn_actor(&mut self, kind_: u8, type_: u16, pos: Vec3, yaw: f32) -> Entity {
        let id = self.new_net_id();
        let e = self.world.spawn((Transform::facing(pos, yaw), Velocity::default(), Kind { kind: kind_, type_ }));
        self.set_net_id(e, id);
        self.events.push(Event::Spawn(events::Spawn { id, kind: kind_, type_, pos, yaw }));
        e
    }

    /// Spawn an entity that is this copy's own (`components::Local`: a debris piece, a coin, a player's own round):
    /// drawn and simulated here, never in a snapshot, its net id from the local range. Its SPAWN and DESPAWN events
    /// stay on this copy (`events::replicated`).
    pub fn spawn_local(&mut self, kind_: u8, type_: u16, pos: Vec3, yaw: f32) -> Entity {
        let id = self.new_local_net_id();
        let e = self.world.spawn((Transform::facing(pos, yaw), Velocity::default(), Kind { kind: kind_, type_ }, crate::components::Local));
        self.set_net_id(e, id);
        self.events.push(Event::Spawn(events::Spawn { id, kind: kind_, type_, pos, yaw }));
        e
    }

    /// Give an entity a character's capsule and controller (feet at its transform), in `group` (ENEMY or PLAYER).
    pub fn add_character(&mut self, e: Entity, radius: f32, height: f32, group: u32) -> Option<Mover> {
        let feet = self.world.get::<&Transform>(e).ok()?.pos;
        let r = radius.clamp(0.05, height * 0.5 - 0.01);
        let mover = Mover::new(r, (height * 0.5 - r).max(0.01));
        let body = self.physics.add_character(e, feet, &mover, group);
        self.world.insert(e, (mover, body)).ok()?;
        Some(mover)
    }

    /// Despawn at the end of the current stage (safe inside a query loop's aftermath; idempotent).
    pub fn despawn(&mut self, e: Entity) {
        if !self.despawns.contains(&e) {
            self.despawns.push(e);
        }
    }

    /// Despawn now: its body leaves the physics world, its net id is freed, a DESPAWN event goes out.
    pub fn despawn_now(&mut self, e: Entity) {
        if !self.world.contains(e) {
            return;
        }
        if let Ok(b) = self.world.get::<&Body>(e).map(|b| *b) {
            self.physics.remove(&b);
        }
        let k = self.world.get::<&Kind>(e).map(|k| *k).unwrap_or(Kind { kind: 0, type_: 0 });
        let net = self.net_of(e);
        if net != 0 {
            self.net.remove(&net);
            self.events.push(Event::Despawn(events::Despawn { id: net, kind: k.kind, type_: k.type_ }));
        }
        if let Ok(p) = self.world.get::<&Player>(e).map(|p| *p)
            && self.players.get(&p.id) == Some(&e) {
                self.players.remove(&p.id);
            }
        let _ = self.world.despawn(e);
    }

    /// Run the deferred despawns (the core does it after every stage).
    pub fn flush_despawns(&mut self) {
        for e in std::mem::take(&mut self.despawns) {
            self.despawn_now(e);
        }
    }

    /// Move an entity somewhere at once (no interpolation across the jump; its body too).
    pub fn teleport(&mut self, e: Entity, pos: Vec3) {
        let rot = match self.world.get::<&mut Transform>(e) {
            Ok(mut t) => {
                t.teleport(pos);
                t.rot
            }
            Err(_) => return,
        };
        if let Ok(mut v) = self.world.get::<&mut Velocity>(e) {
            *v = Velocity::default();
        }
        let body = self.world.get::<&Body>(e).map(|b| *b).ok();
        let center = self.world.get::<&Mover>(e).map(|m| m.center(pos)).ok();
        if let Some(b) = body {
            self.physics.place(&b, center.unwrap_or(pos), if center.is_some() { Quat::IDENTITY } else { rot });
        }
    }

    // ---- damage ----

    /// Deal `amount` to `target` (armour first; a dead or invulnerable target takes nothing). Emits HIT, then KILL once
    /// when it dies. `hit` says where (from a trace; None: the target's own position, no part). → what was dealt.
    pub fn damage(&mut self, target: Entity, amount: f32, attacker: u32, hit: Option<&TraceHit>, dir: Vec3) -> Dealt {
        // a replica (a joiner's copy of the host's enemy or player) is the host's to hurt: the host replays the joiner's
        // shot from its inputs, and its HIT and KILL come back in the next snapshot (net.rs)
        if self.world.get::<&Replica>(target).is_ok() {
            return Dealt::default();
        }
        let net = self.net_of(target);
        let pos = self.world.get::<&Transform>(target).map(|t| t.pos).unwrap_or(Vec3::ZERO);
        let (point, normal, part, region, crit) = match hit {
            Some(h) => (h.point, h.normal, h.part as u8, h.region, h.crit),
            None => (pos + Vec3::Y, -dir.normalize_or_zero(), Part::Body as u8, 0, false),
        };
        let mut dealt = Dealt::default();
        // what it takes of a hit (wave 7: an armoured elite takes a share); the HIT says what was dealt
        let amount = amount * self.world.get::<&Marked>(target).map(|d| d.taken.max(0.0)).unwrap_or(1.0);
        {
            let Ok(mut hp) = self.world.get::<&mut Health>(target) else { return dealt };
            if hp.dead || hp.invulnerable > 0.0 || !(amount > 0.0) {
                return dealt;
            }
            let soak = hp.armor.min(amount);
            hp.armor -= soak;
            let rest = amount - soak;
            hp.hp -= rest;
            hp.last_hit_by = attacker;
            dealt.damage = amount;
            if hp.hp <= 0.0 {
                hp.hp = 0.0;
                hp.dead = true;
                dealt.killed = true;
            }
        }
        self.events.push(Event::Hit(events::Hit { attacker, target: net, part, point, normal, damage: amount, crit, region }));
        if dealt.killed {
            self.events.push(Event::Kill(events::Kill { attacker, target: net, part, point, dir: dir.normalize_or_zero(), damage: amount }));
        }
        dealt
    }

    // ---- traces ----

    /// The first thing a ray hits within `max` metres: a hurt region (of an entity in `hits`' groups, never
    /// `exclude`), a body without a hurtbox, or the world (when `hits` has WORLD). Weapons and AI line of sight use it.
    pub fn trace(&self, origin: Vec3, dir: Vec3, max: f32, hits: u32, exclude: Option<Entity>) -> Option<TraceHit> {
        let d = dir.normalize_or_zero();
        if d == Vec3::ZERO || !(max > 0.0) {
            return None;
        }
        let mut best: Option<TraceHit> = None;
        // the world and bodies without hurt regions, through rapier
        let mut mask = QueryMask::new(hits);
        mask.exclude = exclude;
        mask.exclude_body = exclude.and_then(|e| self.world.get::<&Body>(e).ok().map(|b| b.body));
        for h in self.physics.cast_ray_all(origin, d, max, mask) {
            if let Some(e) = h.entity
                && self.world.get::<&Hurtbox>(e).is_ok() {
                    continue;
                }
            best = Some(TraceHit { entity: h.entity, net: h.entity.map(|e| self.net_of(e)).unwrap_or(0), dist: h.dist, point: h.point, normal: h.normal, part: Part::Body, region: 0, damage: 1.0, crit: false });
            break;
        }
        // every hurtbox in the groups asked for
        let limit = best.map(|b| b.dist).unwrap_or(max);
        for (e, hb) in self.world.query::<(Entity, &Hurtbox)>().iter() {
            if Some(e) == exclude || hb.group & hits == 0 {
                continue;
            }
            for (i, (r, (a, b))) in hb.regions.iter().zip(hb.world.iter()).enumerate() {
                let cur = best.map(|b| b.dist).unwrap_or(limit);
                if let Some((t, n)) = hurtbox::ray_capsule(origin, d, *a, *b, r.radius, cur)
                    && best.is_none_or(|b| t < b.dist) {
                        best = Some(TraceHit { entity: Some(e), net: self.net_of(e), dist: t, point: origin + d * t, normal: n, part: r.part, region: i as u32, damage: r.damage, crit: r.crit });
                    }
            }
        }
        best
    }

    /// Animate an entity: `body` (an `anim.library` body) playing clip set `clips`. With `hurt` (a collision group), its
    /// hurtbox becomes the body's ragdoll-part capsules on its bones (`hurtbox::humanoid_regions`).
    pub fn animate(&mut self, e: Entity, body: usize, clips: usize, hurt: Option<u32>) -> Result<(), String> {
        let animator = self.anim.library.animator(body, clips)?;
        self.world.insert_one(e, Animated { animator, base: 0, count: 0 }).map_err(|_| "no such entity".to_string())?;
        if let Some(group) = hurt {
            let hb = hurtbox::humanoid_regions(&self.anim.library.bodies[body], group);
            let _ = self.world.insert_one(e, hb);
        }
        Ok(())
    }

    /// An animated entity's bone world matrices (model space) this step.
    pub fn bones_of(&self, e: Entity) -> &[Mat4] {
        match self.world.get::<&Animated>(e) {
            Ok(a) => self.anim.poses.slice(a.base, a.count),
            Err(_) => &[],
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resources_hold_one_value_per_type() {
        #[derive(Default, Debug, PartialEq)]
        struct Mine(u32);
        let mut r = Resources::default();
        r.entry::<Mine>().0 += 2;
        r.entry::<Mine>().0 += 3;
        assert_eq!(r.get::<Mine>(), Some(&Mine(5)));
        let m = r.take::<Mine>();
        assert_eq!(m.0, 5);
        assert!(r.get::<Mine>().is_none());
    }

    #[test]
    fn the_random_stream_is_seeded_and_the_cone_stays_in_its_spread() {
        let (mut a, mut b) = (Rng::new(7), Rng::new(7));
        assert_eq!(a.next_u64(), b.next_u64());
        for _ in 0..200 {
            let x = a.f32();
            assert!((0.0..1.0).contains(&x));
            let d = a.cone(Vec3::NEG_Z, 0.1);
            assert!(d.angle_between(Vec3::NEG_Z) <= 0.1001, "{d}");
        }
    }

    #[test]
    fn damage_soaks_armour_then_kills_once_with_events() {
        let mut s = Sim::default();
        let e = s.spawn_actor(kind::ENEMY, 0, Vec3::ZERO, 0.0);
        s.world.insert(e, (Health { armor: 5.0, ..Health::new(20.0) },)).unwrap();
        let id = s.net_of(e);
        assert!(id >= FIRST_NET_ID);
        assert_eq!(s.damage(e, 10.0, 1, None, Vec3::Z), Dealt { damage: 10.0, killed: false });
        assert_eq!(s.world.get::<&Health>(e).unwrap().hp, 15.0);
        assert!(s.damage(e, 50.0, 1, None, Vec3::Z).killed);
        assert_eq!(s.damage(e, 50.0, 1, None, Vec3::Z), Dealt::default(), "the dead take nothing");
        let kinds: Vec<u32> = s.events.tick_events().map(|e| e.kind()).collect();
        assert_eq!(kinds, [events::SPAWN, events::HIT, events::HIT, events::KILL]);
        s.despawn(e);
        s.despawn(e);
        s.flush_despawns();
        assert!(s.entity_of(id).is_none() && !s.world.contains(e));
        assert_eq!(s.events.tick_events().last().map(|e| e.kind()), Some(events::DESPAWN));
    }

    #[test]
    fn a_trace_finds_the_head_before_the_wall_and_the_wall_when_it_misses() {
        let mut s = Sim::default();
        s.physics.add_box(Vec3::new(-5.0, 0.0, -10.5), Vec3::new(5.0, 3.0, -10.0));
        s.physics.refresh();
        let e = s.spawn_actor(kind::ENEMY, 0, Vec3::new(0.0, 0.0, -5.0), 0.0);
        let head = HurtRegion { part: Part::Head, bone: NO_BONE, a: Vec3::new(0.0, 1.6, 0.0), b: Vec3::new(0.0, 1.7, 0.0), radius: 0.15, damage: 2.0, crit: true };
        let torso = HurtRegion { part: Part::Torso, bone: NO_BONE, a: Vec3::new(0.0, 0.6, 0.0), b: Vec3::new(0.0, 1.4, 0.0), radius: 0.25, damage: 1.0, crit: false };
        let mut hb = Hurtbox::new(vec![torso, head], groups::ENEMY);
        hurtbox::place(&mut hb, Mat4::from_translation(Vec3::new(0.0, 0.0, -5.0)), &[]);
        s.world.insert_one(e, hb).unwrap();
        let eye = Vec3::new(0.0, 1.65, 0.0);
        let h = s.trace(eye, Vec3::NEG_Z, 50.0, groups::WORLD | groups::ENEMY, None).unwrap();
        assert_eq!((h.part, h.crit, h.region, h.entity), (Part::Head, true, 1, Some(e)));
        assert!((h.dist - 4.85).abs() < 0.01, "{}", h.dist);
        let h = s.trace(eye + Vec3::X, Vec3::NEG_Z, 50.0, groups::WORLD | groups::ENEMY, None).unwrap();
        assert!(h.entity.is_none() && (h.dist - 10.0).abs() < 0.01, "the wall behind ({h:?})");
        assert!(s.trace(eye, Vec3::NEG_Z, 50.0, groups::WORLD | groups::ENEMY, Some(e)).unwrap().entity.is_none(), "excluded");
        assert!(s.trace(eye, Vec3::NEG_Z, 50.0, groups::WORLD, None).unwrap().entity.is_none(), "not asked for enemies");
    }
}
