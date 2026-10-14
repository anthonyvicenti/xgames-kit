//! Kills and debris (feel target 8, moments 11 and 12).
//!
//! - **A kill** (`feel.kills`) replaces the body on its kill step with physics bone pieces (the enemy row's `debris`,
//!   else `feel.kill.pieces`: 40-55), spread along its hit regions and flung out (`feel.kill.burst`) and along the
//!   killing blow, plus dust, sparks and bone chips (PARTICLES), coins that fly to the killer (`feel.coins`), and the
//!   kill's layered sound on the same step: `feel.kill.sounds` (crack, shatter, knock) and the enemy row's `sounds.die`.
//!   The body itself is despawned (the renderer swaps it for the pieces on that frame). An enemy row with `debris: 0`
//!   keeps its body (forge-ai plays its death).
//! - **Flying pieces** (`feel.debris`) that strike an enemy at `feel.kill.knockSpeed` or faster knock it down
//!   (`ev::KNOCK`, `knockTime` seconds, `knockDamage`, credited to the first kill's attacker) and sever the limb they hit
//!   (`ev::SEVER`: the part comes off as `feel.kill.shed` more pieces, its hit regions go, its bones collapse in the bone
//!   palette, `feel.severed`). forge-ai honours both: a knocked or severed enemy stops its attack.
//! - **The budget:** at most `feel.kill.budget` pieces flying at once (bodies the physics steps); a new burst removes
//!   the oldest of them first, so a phone never steps hundreds of bodies.
//! - **Pieces stay** (wave 2): a piece that has come to rest (slow for `REST_AFTER` s, or `physics.debrisLife` old and
//!   not falling) gives up its body and lies where it is, asleep: no physics, nothing collides with it, it is only
//!   drawn (`Rest`). At most `feel.kill.rest` lie about (about 400); past that the oldest shrink away over
//!   `feel.kill.restFade` seconds. Never in a snapshot (each copy's own, as before).
//! - **Coins** fly to the nearest player standing (wave 2: whoever is closest picks it up, not only the killer).
use std::collections::VecDeque;

use forge_core::cmd;
use forge_core::components::*;
use forge_core::events::Event;
use forge_core::glam::{Mat4, Quat, Vec3};
use forge_core::hecs::Entity;
use forge_core::physics::{groups, Body, Shape};
use forge_core::sim::{Animated, Sim};
use forge_core::STEP;

use crate::weapons::particles;
use crate::{ev, kinds, piece, W};

/// A debris piece: the body it came from, who made the kill (pieces that knock others down are theirs), and the seconds
/// it has left (`physics.debrisLife`; `feel.kills` takes it away, before the rapier step).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Piece {
    pub from: u32,
    pub by: u32,
    pub left: f32,
    /// Seconds it has been slow (it comes to rest after `REST_AFTER`).
    pub still: f32,
    /// Seconds it has hardly moved up or down (on the ground: after `LAND_AFTER` it is slowed, `landed`, so a ball
    /// does not roll across the yard until its time is up).
    pub low: f32,
    pub landed: bool,
}

/// A piece at rest (wave 2): no body, no physics, only drawn where it lies. `fade`: seconds left while it shrinks
/// away (negative: it stays).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Rest {
    pub fade: f32,
}

/// The pieces at rest, oldest first (the cap).
#[derive(Clone, Debug, Default)]
pub struct RestQueue {
    pub list: VecDeque<Entity>,
    /// Pieces that came to rest since the start, and that faded out past the cap.
    pub rested: u64,
    pub faded: u64,
}

/// The governor's shares of the pieces' caps (`op::QUALITY`): of those that stay lying and of those flying.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Quality {
    pub rest: f32,
    pub flying: f32,
}

impl Default for Quality {
    fn default() -> Self {
        Self { rest: 1.0, flying: 1.0 }
    }
}

/// The caps now: (pieces that stay lying, pieces flying), the tables' values times the governor's shares.
pub fn kept(sim: &Sim, cfg: &crate::Config) -> (usize, u32) {
    let q = sim.res.get::<Quality>().copied().unwrap_or_default();
    ((cfg.feel.kill.rest as f32 * q.rest).round() as usize, ((cfg.feel.kill.budget as f32 * q.flying).round() as u32).max(if cfg.feel.kill.budget > 0 { 8 } else { 0 }))
}

/// `op::QUALITY`: floats [rest share, flying share].
pub fn cmd_quality(sim: &mut Sim, r: &cmd::Record) {
    let share = |i: usize| { let v = r.f(i); if v.is_finite() { v.clamp(0.0, 1.0) } else { 1.0 } };
    sim.res.insert(Quality { rest: share(0), flying: share(1) });
}

/// Seconds a piece is slow before it lies still, and what slow is (m/s, rad/s).
pub const REST_AFTER: f32 = 0.25;
pub const REST_SPEED: f32 = 0.6;
pub const REST_SPIN: f32 = 5.0;
/// A piece falling slower than this (m/s) is on the ground, or as good as: it may be put to rest where it is.
pub const REST_FALL: f32 = 1.2;
/// On the ground (hardly moving up or down for `LAND_AFTER` s; an apex passes in a third of that): its roll and slide
/// are damped at these rates a second, so it stops within about half a second.
pub const LAND_AFTER: f32 = 0.1;
pub const LAND_SPEED: f32 = 0.3;
pub const LAND_DAMP: (f32, f32) = (4.0, 8.0);

/// The pieces alive, oldest first (the budget).
#[derive(Clone, Debug, Default)]
pub struct DebrisQueue {
    pub list: VecDeque<Entity>,
    /// Pieces spawned since the start, and removed by the budget.
    pub spawned: u64,
    pub culled: u64,
}

/// A knocked-down enemy: seconds left down.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Knocked {
    pub left: f32,
}

/// An enemy's severed parts (a bit per `Part`) and the bones that hang from them (collapsed in the palette).
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Severed {
    pub parts: u16,
    pub bones: Vec<u16>,
}

/// A coin flying to the player who made the kill.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Coin {
    pub to: u32,
    pub value: f32,
    pub t: f32,
    /// A joiner's own picture of the host's coin: it flies and sounds here, and the host's copy scores (its `coin`
    /// rule event comes with the snapshot).
    pub cosmetic: bool,
}

/// A joiner's memory of the host's bodies (replicas): where each stood and what it was, a step ago. The host's KILL
/// reaches a joiner after its body has left the snapshot, and the pieces burst from where it was.
#[derive(Clone, Debug, Default)]
pub struct Seen(pub std::collections::HashMap<u32, (Vec3, u8, u16)>);

/// A hit region in the world: its ends, radius and part.
type Cap = (Vec3, Vec3, f32, Part);

fn caps_of(sim: &Sim, e: Entity) -> Vec<Cap> {
    match sim.world.get::<&Hurtbox>(e) {
        Ok(hb) => hb.regions.iter().zip(hb.world.iter()).filter(|(r, _)| r.radius > 0.0).map(|(r, (a, b))| (*a, *b, r.radius, r.part)).collect(),
        Err(_) => Vec::new(),
    }
}

/// The kind of piece a part sheds (one skull from a head, one ribcage from a torso, long bones from limbs, chips).
fn piece_for(part: Part, i: u32, first_of_part: bool) -> (u16, Shape) {
    match part {
        Part::Head if first_of_part => (piece::SKULL, Shape::Ball(0.11)),
        Part::Torso if first_of_part => (piece::RIBCAGE, Shape::Cuboid(Vec3::new(0.15, 0.13, 0.1))),
        Part::Head | Part::Torso | Part::Pelvis => if i.is_multiple_of(3) { (piece::CHIP, Shape::Ball(0.035)) } else { (piece::SHORT_BONE, Shape::Cuboid(Vec3::new(0.03, 0.03, 0.07))) },
        _ => if i.is_multiple_of(4) { (piece::CHIP, Shape::Ball(0.03)) } else if i.is_multiple_of(2) { (piece::BONE, Shape::Cuboid(Vec3::new(0.035, 0.035, 0.13))) } else { (piece::SHORT_BONE, Shape::Cuboid(Vec3::new(0.03, 0.03, 0.08))) },
    }
}

/// Burst `n` pieces from these regions (weighted by their size), outward from `center` and along `dir`.
pub fn burst(sim: &mut Sim, caps: &[Cap], n: u32, center: Vec3, dir: Vec3, speed: f32, from: u32, by: u32) -> u32 {
    let cfg = crate::cfg(sim);
    let budget = kept(sim, &cfg).1;
    let n = n.min(budget);
    if n == 0 || caps.is_empty() {
        return 0;
    }
    // the budget: the oldest pieces still flying make room. One already on the ground lies still from now on (wave
    // 2: it stays); one in the air goes
    {
        let mut q = sim.res.remove::<DebrisQueue>().unwrap_or_default();
        q.list.retain(|e| sim.world.get::<&Piece>(*e).is_ok());
        let mut rest: Vec<(Entity, Body)> = Vec::new();
        while q.list.len() as u32 + n > budget {
            match q.list.pop_front() {
                Some(e) => {
                    let grounded = sim.world.query_one::<(&Velocity, &Body)>(e).get().ok().filter(|(v, _)| v.linear.y.abs() < REST_FALL).map(|(_, b)| *b);
                    match grounded {
                        Some(b) => rest.push((e, b)),
                        // now, before the rapier step (a removal seen by the step's collision refresh trips rapier)
                        None => sim.despawn_now(e),
                    }
                    q.culled += 1;
                }
                None => break,
            }
        }
        sim.res.insert(q);
        if !rest.is_empty() {
            settle(sim, &cfg, rest);
        }
    }
    let life = sim.tables.physics.debris_life;
    let weights: Vec<f32> = caps.iter().map(|(a, b, r, _)| (a.distance(*b) + 2.0 * r) * r.max(0.02)).collect();
    let total: f32 = weights.iter().sum::<f32>().max(1e-6);
    // how many pieces each region gives (at least one each while they last)
    let mut counts: Vec<u32> = weights.iter().map(|w| ((w / total) * n as f32).floor() as u32).collect();
    let mut given: u32 = counts.iter().sum();
    let mut k = 0;
    let len = counts.len();
    while given < n {
        counts[k % len] += 1;
        given += 1;
        k += 1;
    }
    let mut made = 0;
    let mut spawned = Vec::with_capacity(n as usize);
    for ((a, b, r, part), c) in caps.iter().zip(counts) {
        for i in 0..c {
            let u = sim.rng.f32();
            let jitter = Vec3::new(sim.rng.range(-1.0, 1.0), sim.rng.range(-1.0, 1.0), sim.rng.range(-1.0, 1.0)) * (*r * 0.6);
            let pos = a.lerp(*b, u) + jitter;
            let (type_, shape) = piece_for(*part, i, i == 0);
            let out = (pos - center).normalize_or(Vec3::Y);
            let vel = out * speed * sim.rng.range(0.6, 1.25) + dir * speed * sim.rng.range(0.4, 0.9) + Vec3::Y * sim.rng.range(1.2, 3.8);
            let spin = Vec3::new(sim.rng.range(-12.0, 12.0), sim.rng.range(-12.0, 12.0), sim.rng.range(-12.0, 12.0));
            let rot = Quat::from_euler(forge_core::glam::EulerRot::XYZ, sim.rng.range(0.0, std::f32::consts::TAU), sim.rng.range(0.0, std::f32::consts::TAU), sim.rng.range(0.0, std::f32::consts::TAU));
            let e = sim.spawn_local(kind::DEBRIS, type_, pos, 0.0);
            let body = sim.physics.add_dynamic(e, shape, pos, rot, vel, spin, groups::DEBRIS, 450.0);
            awake(sim, &body);
            if let Ok(mut t) = sim.world.get::<&mut Transform>(e) {
                t.rot = rot;
                t.prev_rot = rot;
            }
            let _ = sim.world.insert(e, (body, Piece { from, by, left: life, still: 0.0, low: 0.0, landed: false }, Team::NEUTRAL));
            spawned.push(e);
            made += 1;
        }
    }
    let q = sim.res.entry::<DebrisQueue>();
    q.list.extend(spawned);
    q.spawned += made as u64;
    made
}

/// Kills and severs that came after this step's Physics stage (a knock's damage in the Events stage), done at the next.
#[derive(Clone, Debug, Default)]
pub struct Pending {
    pub kills: Vec<forge_core::events::Kill>,
    pub severs: Vec<(Entity, Vec3, u32)>,
    /// How many of this step's events `feel.kills` had seen.
    pub seen: usize,
    /// op::CLEAR asked: every piece goes at the next `feel.kills`.
    pub clear: bool,
}

/// A body already broken (or kept whole: an enemy row with `debris: 0`).
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct Broken;

/// Physics, just before the rapier step (new bodies join rapier's islands in that step; a body added after it trips
/// rapier's own checks at the next step's refresh): every kill of this step so far, the late ones of the step before,
/// any dead body nobody broke (damage from a command), and the severs the debris asked for.
pub fn feel_kills(sim: &mut Sim) {
    let cfg = crate::cfg(sim);
    let mut pend = sim.res.remove::<Pending>().unwrap_or_default();
    let mut kills: Vec<forge_core::events::Kill> = std::mem::take(&mut pend.kills);
    kills.extend(sim.events.step_events().filter_map(|e| if let Event::Kill(k) = e { Some(*k) } else { None }));
    pend.seen = sim.events.step_events().count();
    // a body dead without a kill this step (a command dealt it, or the kill came before the first step)
    let missed: Vec<(u32, u32, Vec3)> = sim.world.query::<(&NetId, &Health, &Transform)>().without::<&Player>().without::<&Broken>().iter().filter(|(n, h, _)| h.dead && !kills.iter().any(|k| k.target == n.0)).map(|(n, h, t)| (n.0, h.last_hit_by, t.pos)).collect();
    for (target, attacker, pos) in missed {
        kills.push(forge_core::events::Kill { attacker, target, part: 0, point: pos + Vec3::Y, dir: Vec3::ZERO, damage: 0.0 });
    }
    let severs = std::mem::take(&mut pend.severs);
    let clear = std::mem::take(&mut pend.clear);
    sim.res.insert(pend);
    remote_kills(sim, &cfg);
    // pieces that have come to rest lie where they are from now on, without a body; one still falling when its time
    // is up goes (and every one, after op::CLEAR): now, before the rapier step
    let mut gone: Vec<Entity> = Vec::new();
    let mut rest: Vec<(Entity, Body)> = Vec::new();
    let mut landed: Vec<Body> = Vec::new();
    for (e, p, v, b) in sim.world.query_mut::<(Entity, &mut Piece, &Velocity, &Body)>() {
        p.left -= STEP;
        p.low = if v.linear.y.abs() < LAND_SPEED { p.low + STEP } else { 0.0 };
        if !p.landed && p.low >= LAND_AFTER {
            p.landed = true;
            landed.push(*b);
        }
        // slow on its way: a small ball rolls with a great spin and little speed, so the spin only counts for a piece
        // that is not moving at all
        let speed = v.linear.length();
        let slow = speed < REST_SPEED && (speed > 0.05 || v.angular.length() < REST_SPIN);
        p.still = if slow { p.still + STEP } else { 0.0 };
        if clear {
            gone.push(e);
        } else if p.still >= REST_AFTER || (p.left <= 0.0 && v.linear.y.abs() < REST_FALL) {
            rest.push((e, *b));
        } else if p.left <= 0.0 {
            gone.push(e);
        }
    }
    if clear {
        gone.extend(sim.world.query::<(Entity, &Rest)>().iter().map(|(e, _)| e));
    }
    for e in gone {
        sim.despawn_now(e);
    }
    for b in landed {
        if let Some(rb) = sim.physics.world.bodies.get_mut(b.body) {
            rb.set_linear_damping(LAND_DAMP.0);
            rb.set_angular_damping(LAND_DAMP.1);
        }
    }
    settle(sim, &cfg, rest);
    for (t, at, by) in severs {
        if sim.world.contains(t) && sim.world.get::<&Health>(t).map(|h| !h.dead).unwrap_or(false) {
            sever(sim, t, at, by);
        }
    }
    for k in kills {
        let Some(t) = sim.entity_of(k.target) else { continue };
        if sim.world.get::<&Player>(t).is_ok() || sim.world.get::<&Broken>(t).is_ok() {
            continue;
        }
        let _ = sim.world.insert_one(t, Broken);
        let (kd, ty) = sim.world.get::<&Kind>(t).map(|x| (x.kind, x.type_)).unwrap_or((0, 0));
        // what the kill pays, against the row's own (wave 7: an elite's coins × the elites table's `coins`)
        let bounty = sim.world.get::<&forge_core::components::Marked>(t).map(|b| b.bounty.max(0.0)).unwrap_or(1.0);
        let row = (kd == kind::ENEMY).then(|| sim.tables.enemies.get(ty as usize).cloned()).flatten();
        let pieces = row.as_ref().map(|r| r.int("debris", cfg.feel.kill.pieces as i64).clamp(0, 200) as u32).unwrap_or(cfg.feel.kill.pieces);
        if pieces == 0 {
            continue;
        }
        let pos = sim.world.get::<&Transform>(t).map(|x| x.pos).unwrap_or(k.point);
        let mut caps = caps_of(sim, t);
        if caps.is_empty() {
            caps.push((pos + Vec3::Y * 0.3, pos + Vec3::Y * 1.5, 0.3, Part::Body));
        }
        let center = pos + Vec3::Y * 1.0;
        // the body goes before its pieces come (they would start inside its capsule)
        sim.despawn_now(t);
        burst(sim, &caps, pieces, center, k.dir, cfg.feel.kill.burst, k.target, k.attacker);
        particles(sim, "dust", 10, center, Vec3::Y, 1.6, 1.2);
        particles(sim, "sparks", 14, k.point, k.dir, 4.0, 0.9);
        particles(sim, "bone", 10, k.point, k.dir, 3.0, 1.0);
        // the layered break, on this step: the feel's layers and the enemy's own, each sound once for this body
        // (forge-ai plays its enemy's `sounds.die` itself when it dies, in the Ai stage before this, and the
        // archetypes' is the same bone-break the feel's first layer is)
        let die = row.as_ref().and_then(|r| r.str("sounds.die")).map(str::to_string);
        for s in cfg.feel.kill.sounds.iter().chain(die.iter()) {
            let id = sim.names.id(s);
            let played = sim.events.step_events().any(|e| matches!(e, Event::Sound(x) if x.name == id && x.source == k.target));
            if !played {
                sim.sound(s, center, 0.0, k.target);
            }
        }
        // coins fly to the nearest player standing (the killer when nobody is)
        let killer_is_player = sim.entity_of(k.attacker).is_some_and(|e| sim.world.get::<&Player>(e).is_ok());
        if cfg.feel.kill.coins && killer_is_player {
            let n = row.as_ref().map(|r| r.int("coins", 1).clamp(0, 20) as u32).unwrap_or(1);
            let n = ((n as f32 * bounty).round() as u32).min(60);
            let to = nearest_player(sim, center).unwrap_or(k.attacker);
            for i in 0..n {
                let c = sim.spawn_local(kinds::COIN, 0, center + Vec3::Y * 0.2, 0.0);
                let a = i as f32 * 2.1;
                let _ = sim.world.insert_one(c, Coin { to, value: cfg.feel.kill.coin_value, t: 0.0, cosmetic: false });
                if let Ok(mut v) = sim.world.get::<&mut Velocity>(c) {
                    v.linear = Vec3::new(a.sin() * 1.2, 4.2, a.cos() * 1.2);
                }
            }
        }
    }
}

/// A joiner's copy of the host's kills (live co-op; the wave 1b integration). The host's KILL arrives between steps,
/// flagged REMOTE (`Events::early_events`), after its body left the snapshot: this copy bursts its own pieces from where
/// the body last stood (`Seen`) and, for this copy's own player's kill, its own picture of the coin. The dust, sparks,
/// chips and sounds are the host's (its PARTICLES and SOUND events come with the same snapshot), and so is the score.
fn remote_kills(sim: &mut Sim, cfg: &crate::Config) {
    let kills: Vec<forge_core::events::Kill> = sim.events.early_events().filter_map(|(e, f)| match e { Event::Kill(k) if f & forge_core::events::FLAG_REMOTE != 0 => Some(*k), _ => None }).collect();
    let mut seen = sim.res.remove::<Seen>().unwrap_or_default();
    for k in kills {
        if sim.entity_of(k.target).is_some_and(|t| sim.world.get::<&Player>(t).is_ok()) {
            continue;
        }
        let (pos, kd, ty) = match sim.entity_of(k.target).and_then(|t| sim.world.get::<&Transform>(t).ok().map(|x| x.pos)) {
            Some(p) => (p, seen.0.get(&k.target).map(|s| s.1).unwrap_or(kind::ENEMY), seen.0.get(&k.target).map(|s| s.2).unwrap_or(0)),
            None => seen.0.get(&k.target).copied().unwrap_or((k.point - Vec3::Y, kind::ENEMY, 0)),
        };
        let row = (kd == kind::ENEMY).then(|| sim.tables.enemies.get(ty as usize).cloned()).flatten();
        let pieces = row.as_ref().map(|r| r.int("debris", cfg.feel.kill.pieces as i64).clamp(0, 200) as u32).unwrap_or(cfg.feel.kill.pieces);
        if pieces == 0 {
            continue;
        }
        let caps = match sim.entity_of(k.target).map(|t| caps_of(sim, t)).filter(|c| !c.is_empty()) {
            Some(c) => c,
            None => vec![(pos + Vec3::Y * 0.3, pos + Vec3::Y * 1.5, 0.3, Part::Body)],
        };
        burst(sim, &caps, pieces, pos + Vec3::Y, k.dir, cfg.feel.kill.burst, k.target, k.attacker);
        // this copy's own picture of the host's coin, flying to the nearest player standing as the host's does
        let by_player = sim.entity_of(k.attacker).is_some_and(|e| sim.world.get::<&Player>(e).is_ok());
        if cfg.feel.kill.coins && by_player {
            let to = nearest_player(sim, pos + Vec3::Y).unwrap_or(k.attacker);
            let c = sim.spawn_local(kinds::COIN, 0, pos + Vec3::Y * 1.2, 0.0);
            let _ = sim.world.insert_one(c, Coin { to, value: cfg.feel.kill.coin_value, t: 0.0, cosmetic: true });
            if let Ok(mut v) = sim.world.get::<&mut Velocity>(c) {
                v.linear = Vec3::new(0.0, 4.2, 0.0);
            }
        }
        seen.0.remove(&k.target);
    }
    // where the host's bodies stand now, for the kills the next snapshots bring
    seen.0.retain(|net, _| sim.entity_of(*net).is_some());
    for (n, t, k) in sim.world.query::<(&NetId, &Transform, &Kind)>().with::<&Replica>().without::<&Player>().iter() {
        if k.kind == kind::ENEMY || k.kind == kinds::TARGET {
            seen.0.insert(n.0, (t.pos, k.kind, k.type_));
        }
    }
    sim.res.insert(seen);
}

/// Pieces striking enemies: knock-downs and severing; knocked enemies get up.
pub fn feel_debris(sim: &mut Sim) {
    let cfg = crate::cfg(sim);
    let kc = &cfg.feel.kill;
    // the knocked get up
    let mut up = Vec::new();
    for (e, k) in sim.world.query_mut::<(Entity, &mut Knocked)>() {
        k.left -= STEP;
        if k.left <= 0.0 {
            up.push(e);
        }
    }
    for e in up {
        let _ = sim.world.remove_one::<Knocked>(e);
    }
    if kc.knock_speed <= 0.0 {
        return;
    }
    let contacts = sim.physics.contacts.clone();
    for c in contacts {
        let (piece_e, other) = match (c.groups_a & groups::DEBRIS != 0, c.groups_b & groups::DEBRIS != 0) {
            (true, false) => (c.a, c.b),
            (false, true) => (c.b, c.a),
            _ => continue,
        };
        let (Some(pe), Some(t)) = (piece_e, other) else { continue };
        if c.speed < kc.knock_speed {
            continue;
        }
        let Ok(p) = sim.world.get::<&Piece>(pe).map(|p| *p) else { continue };
        if sim.net_of(t) == p.from || sim.world.get::<&Player>(t).is_ok() || sim.world.get::<&Knocked>(t).is_ok() || sim.world.get::<&Replica>(t).is_ok() {
            continue;
        }
        let alive = sim.world.get::<&Health>(t).map(|h| !h.dead).unwrap_or(false);
        if !alive || sim.world.get::<&Hurtbox>(t).map(|h| h.group & groups::ENEMY == 0).unwrap_or(true) {
            continue;
        }
        let at = sim.world.get::<&Transform>(pe).map(|x| x.pos).unwrap_or(Vec3::ZERO);
        let tpos = sim.world.get::<&Transform>(t).map(|x| x.pos).unwrap_or(at);
        let dir = Vec3::new(tpos.x - at.x, 0.0, tpos.z - at.z).normalize_or(Vec3::X);
        let net = sim.net_of(t);
        let _ = sim.world.insert_one(t, Knocked { left: kc.knock_time });
        sim.res.entry::<Pending>().severs.push((t, at, p.by));
        crate::custom(sim, ev::KNOCK, &[W::U(net), W::F(kc.knock_time), W::F(dir.x), W::F(dir.y), W::F(dir.z), W::U(p.by)]);
        let name = sim.names.id("launched");
        crate::custom(sim, ev::LABEL, &[W::U(name), W::F(tpos.x), W::F(tpos.y + 1.9), W::F(tpos.z), W::U(p.by), W::F(0.0)]);
        crate::hits::push(sim, t, dir * 3.0, 0.25);
        if kc.knock_damage > 0.0 {
            sim.damage(t, kc.knock_damage, p.by, None, dir);
        }
    }
}

/// Events, last of the kills: a kill that came after `feel.kills` ran this step waits for the next step's.
pub fn feel_late(sim: &mut Sim) {
    let seen = sim.res.get::<Pending>().map(|p| p.seen).unwrap_or(0);
    let late: Vec<forge_core::events::Kill> = sim.events.step_events().skip(seen).filter_map(|e| if let Event::Kill(k) = e { Some(*k) } else { None }).collect();
    let pend = sim.res.entry::<Pending>();
    pend.kills.extend(late);
    pend.seen = 0;
}

/// Sever the limb of `t` nearest `at`: it comes off as pieces, its regions go, its bones collapse.
pub fn sever(sim: &mut Sim, t: Entity, at: Vec3, by: u32) {
    let cfg = crate::cfg(sim);
    let limb = |p: Part| matches!(p, Part::UpperArmL | Part::ForearmL | Part::UpperArmR | Part::ForearmR | Part::ThighL | Part::ShinL | Part::ThighR | Part::ShinR);
    let caps = caps_of(sim, t);
    let Some((_, _, _, part)) = caps.iter().filter(|c| limb(c.3)).min_by(|x, y| crate::weapons::closest_on_segment(x.0, x.1, at).distance(at).total_cmp(&crate::weapons::closest_on_segment(y.0, y.1, at).distance(at))).copied() else { return };
    // the part and what hangs from it (an upper arm takes its forearm)
    let child = |p: Part| match p {
        Part::UpperArmL => Some(Part::ForearmL),
        Part::UpperArmR => Some(Part::ForearmR),
        Part::ThighL => Some(Part::ShinL),
        Part::ThighR => Some(Part::ShinR),
        _ => None,
    };
    let parts: Vec<Part> = std::iter::once(part).chain(child(part)).collect();
    let off: Vec<Cap> = caps.iter().filter(|c| parts.contains(&c.3)).copied().collect();
    let center = sim.world.get::<&Transform>(t).map(|x| x.pos + Vec3::Y).unwrap_or(at);
    let n = burst(sim, &off, cfg.feel.kill.shed, center, (at - center).normalize_or(Vec3::Y), cfg.feel.kill.burst * 0.6, sim.net_of(t), by);
    let net = sim.net_of(t);
    for p in &parts {
        crate::custom(sim, ev::SEVER, &[W::U(net), W::U(*p as u32), W::U(n), W::F(at.x), W::F(at.y), W::F(at.z)]);
    }
    // the regions go; the bones they were on (and every bone hanging from them) collapse
    let mut bones: Vec<u16> = Vec::new();
    if let Ok(mut hb) = sim.world.get::<&mut Hurtbox>(t) {
        for r in hb.regions.iter_mut() {
            if parts.contains(&r.part) {
                r.radius = 0.0;
                if r.bone != NO_BONE {
                    bones.push(r.bone);
                }
            }
        }
    }
    let hanging = sim.world.get::<&Animated>(t).ok().and_then(|a| sim.anim.library.bodies.get(a.animator.body).map(|b| {
        let mut all = Vec::new();
        for j in 0..b.joints.len() {
            let mut k = Some(j);
            while let Some(x) = k {
                if bones.contains(&(x as u16)) {
                    all.push(j as u16);
                    break;
                }
                k = b.joints[x].parent;
            }
        }
        all
    }));
    let mut s = sim.world.get::<&Severed>(t).map(|s| (*s).clone()).unwrap_or_default();
    for p in &parts {
        s.parts |= 1 << (*p as u16);
    }
    for b in hanging.unwrap_or(bones) {
        if !s.bones.contains(&b) {
            s.bones.push(b);
        }
    }
    let _ = sim.world.insert_one(t, s);
}

/// Post, after the animation: a severed part's bones are collapsed to the joint they hang from (nothing drawn there).
pub fn feel_severed(sim: &mut Sim) {
    let poses = &mut sim.anim.poses;
    for (a, s) in sim.world.query_mut::<(&Animated, &Severed)>() {
        if s.bones.is_empty() {
            continue;
        }
        let root = s.bones.iter().copied().min().unwrap_or(0) as usize;
        let base = a.base as usize;
        let Some(pivot) = poses.world.get(base + root).map(|m| m.w_axis.truncate()) else { continue };
        let collapse = Mat4::from_translation(pivot) * Mat4::from_scale(Vec3::ZERO);
        for &b in &s.bones {
            if let Some(m) = poses.skin.get_mut(base + b as usize) {
                *m = collapse;
            }
            // the renderer builds its palette per glTF skin from the bones' world matrices (forge-render
            // `Scene::push_palette`), not from `skin`: collapsed there too, so the part is not drawn
            if let Some(m) = poses.world.get_mut(base + b as usize) {
                *m = collapse;
            }
        }
    }
}

/// Coins: a short hop, then home in on their player, faster and faster; picked up within 0.6 m (a rule event, `coin`,
/// for rules.js: entity the player's id, a its value; and its sound). A coin whose player fell turns to the nearest
/// one standing.
pub fn feel_coins(sim: &mut Sim) {
    let cfg = crate::cfg(sim);
    let eye = sim.tables.player.eye;
    let mut got: Vec<(Entity, u32, f32, Vec3)> = Vec::new();
    // (this copy's own player: local and owned. A viewer's watched player is local too, and its coin's sound is the
    // host's event, which a viewer plays)
    let targets: Vec<(u32, Vec3, bool, bool)> = sim.world.query::<(&Player, &Transform, Option<&Health>)>().iter().map(|(p, t, h)| (p.id, t.pos + Vec3::Y * eye * 0.7, h.is_none_or(|h| !h.dead), p.local && p.owned)).collect();
    let local = targets.iter().find(|t| t.3).map(|t| t.0).unwrap_or(0);
    for (e, tr, v, c) in sim.world.query_mut::<(Entity, &mut Transform, &mut Velocity, &mut Coin)>().without::<&Replica>() {
        c.t += STEP;
        if !targets.iter().any(|t| t.0 == c.to && t.2)
            && let Some(n) = targets.iter().filter(|t| t.2).min_by(|a, b| a.1.distance_squared(tr.pos).total_cmp(&b.1.distance_squared(tr.pos)))
        {
            c.to = n.0;
        }
        let goal = targets.iter().find(|t| t.0 == c.to).map(|x| x.1);
        match goal {
            Some(g) if c.t > 0.25 => {
                let to = g - tr.pos;
                let d = to.length();
                if d < 0.6 {
                    got.push((e, c.to, if c.cosmetic { -1.0 } else { c.value }, tr.pos));
                    continue;
                }
                let speed = (6.0 + (c.t - 0.25) * 40.0).min(30.0);
                v.linear = v.linear.lerp(to / d * speed, 0.25);
            }
            Some(_) => v.linear.y -= 14.0 * STEP,
            None => {
                got.push((e, 0, 0.0, tr.pos));
                continue;
            }
        }
        tr.pos += v.linear * STEP;
        if c.t > 6.0 {
            got.push((e, 0, 0.0, tr.pos));
        }
    }
    for (e, to, value, pos) in got {
        sim.despawn(e);
        if to != 0 {
            // a joiner's own picture of the host's coin (value −1) never scores: the host's copy does. It sounds when
            // it is this copy's own player's (the host's sound for it is not played twice, forge-core net.rs); a
            // friend's coin sounds with the host's event
            if value >= 0.0 {
                // wave 7 (track P): into the player's purse, the host's to keep
                crate::shop::earn(sim, to, value);
                sim.rule("coin", to, value, 0.0, 0.0, 0.0);
                sim.sound(&cfg.feel.kill.sound_coin, pos, 0.0, to);
            } else if to == local {
                sim.sound(&cfg.feel.kill.sound_coin, pos, 0.0, to);
            }
        }
    }
}

/// The player standing nearest `at` (its id).
pub fn nearest_player(sim: &Sim, at: Vec3) -> Option<u32> {
    sim.world.query::<(&Player, &Transform, Option<&Health>)>().iter().filter(|(_, _, h)| h.is_none_or(|h| !h.dead)).min_by(|a, b| a.1.pos.distance_squared(at).total_cmp(&b.1.pos.distance_squared(at))).map(|(p, ..)| p.id)
}

/// Pieces come to rest: each gives up its body (before the rapier step) and stays as it lies; past `feel.kill.rest`
/// the oldest start to fade. With a cap of 0 a piece at rest goes at once (wave 1's way).
fn settle(sim: &mut Sim, cfg: &crate::Config, rest: Vec<(Entity, Body)>) {
    let cap = kept(sim, cfg).0;
    let fade = cfg.feel.kill.rest_fade;
    // also when nothing came to rest this step but more lie about than the cap now allows (the governor lowered it)
    if !rest.is_empty() || sim.res.get::<RestQueue>().is_some_and(|q| q.list.len() > cap) {
        let mut q = sim.res.remove::<RestQueue>().unwrap_or_default();
        for (e, b) in rest {
            if cap == 0 {
                sim.despawn_now(e);
                continue;
            }
            sim.physics.remove(&b);
            let _ = sim.world.remove::<(Body, Piece)>(e);
            if let Ok(mut v) = sim.world.get::<&mut Velocity>(e) {
                *v = Velocity::default();
            }
            let _ = sim.world.insert_one(e, Rest { fade: -1.0 });
            q.list.push_back(e);
            q.rested += 1;
        }
        while q.list.len() > cap {
            if let Some(old) = q.list.pop_front() {
                if let Ok(mut r) = sim.world.get::<&mut Rest>(old) {
                    r.fade = fade.max(STEP);
                }
                q.faded += 1;
            }
        }
        sim.res.insert(q);
    }
    // the ones fading shrink away
    let mut done: Vec<Entity> = Vec::new();
    for (e, r, tr) in sim.world.query_mut::<(Entity, &mut Rest, &mut Transform)>() {
        if r.fade < 0.0 {
            continue;
        }
        r.fade -= STEP;
        tr.scale = (r.fade / fade.max(STEP)).clamp(0.0, 1.0);
        if r.fade <= 0.0 {
            done.push(e);
        }
    }
    for e in done {
        sim.despawn_now(e);
    }
}

/// How many pieces lie at rest and stay (those fading out past the cap are on their way: `fading`).
pub fn resting(sim: &Sim) -> usize {
    sim.world.query::<&Rest>().iter().filter(|r| r.fade < 0.0).count()
}

/// How many resting pieces are fading out.
pub fn fading(sim: &Sim) -> usize {
    sim.world.query::<&Rest>().iter().filter(|r| r.fade >= 0.0).count()
}

/// op::CLEAR: every piece, coin and shot goes.
pub fn cmd_clear(sim: &mut Sim, _r: &cmd::Record) {
    // coins and shots have no rapier body: now; the pieces at the next `feel.kills`, before the rapier step
    let gone: Vec<Entity> = sim.world.query::<(Entity, Option<&Coin>, Option<&crate::weapons::Shot>)>().iter().filter(|(_, c, s)| c.is_some() || s.is_some()).map(|(e, ..)| e).collect();
    for e in gone {
        sim.despawn(e);
    }
    sim.res.entry::<Pending>().clear = true;
}

/// Keep a body out of rapier's sleep bookkeeping (debris lives seconds; a dummy stands still). rapier 0.36's debug
/// checks trip when a long-idle kinematic body is touched by new debris, or when many pieces come and go in a step.
pub fn awake(sim: &mut Sim, b: &Body) {
    if let Some(rb) = sim.physics.world.bodies.get_mut(b.body) {
        *rb.activation_mut() = forge_core::rapier3d::dynamics::RigidBodyActivation::cannot_sleep();
    }
}

/// How many debris pieces are alive (the budget's count).
pub fn alive(sim: &Sim) -> usize {
    sim.world.query::<(&Piece, &Body)>().iter().count()
}
