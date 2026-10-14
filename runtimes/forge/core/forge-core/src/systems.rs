//! The core's own systems (ARCHITECTURE.md "Schedule"), each named so a plugin can order around it or replace it
//! (and `net.inputs`, `net.record`, `net.predict`: live co-op, net.rs):
//!
//! - `core.held` (Input): the weapons-table row in hand (`Wear::held`) from the slot keys and the wheel.
//! - `core.move` (Feel): the basic first-person walk from the player table: top speed in every direction with an
//!   exponential approach (`accelTime` to 90%, `stopTime` to under 10%), less control in the air, a jump with coyote
//!   time and a buffer, gravity integrated exactly. Track F replaces it (`schedule.replace("core.move", …)`) with the
//!   full controller (evade, stamina, air control) and keeps `core.character` underneath.
//! - `core.character` (Physics): every `Mover` through rapier's character controller (steps, slopes, ground snap).
//! - `core.physics` (Physics): the rapier step; dynamic bodies write their pose back; contacts gathered.
//! - `core.walk` (Post): footsteps, landings, falling out of the world (players).
//! - `core.lifetime` (Post): counts `Lifetime` down and despawns.
//! - `core.replicas` (Post): moves replicas between the host's last two snapshots.
//! - `core.anim` (Post): advances every animator and writes the bone matrices.
//! - `core.hurtboxes` (Post): places every hurtbox's capsules on its bones.
use glam::{Mat4, Quat, Vec2, Vec3};
use hecs::Entity;

use crate::components::*;
use crate::events::{self, Event};
use crate::physics::{Body, BodyKind, Mover};
use crate::schedule::{Schedule, Stage};
use crate::sim::{Animated, Sim, Walker};
use crate::STEP;

pub fn install(s: &mut Schedule) {
    s.add(Stage::Input, "core.held", core_held);
    s.add(Stage::Feel, "core.move", core_move);
    s.add(Stage::Physics, "core.character", core_character);
    s.add(Stage::Physics, "core.physics", core_physics);
    s.add(Stage::Post, "core.walk", core_walk);
    s.add(Stage::Post, "core.lifetime", core_lifetime);
    s.add(Stage::Post, "core.replicas", core_replicas);
    s.add(Stage::Post, "core.anim", core_anim);
    s.add(Stage::Post, "core.hurtboxes", core_hurtboxes);
}

/// The weapon in hand (`Wear::held`, what other players see a player hold): the slot keys pick the weapons-table row
/// whose `slot` is that key (else the key's row by order), the wheel the next or previous row. forge-feel owns weapon
/// switching (draw and holster times); it may set `Wear::held` itself, after this, in the Feel stage.
pub fn core_held(sim: &mut Sim) {
    let rows = sim.tables.weapons.len();
    if rows == 0 {
        return;
    }
    let slots: Vec<i64> = sim.tables.weapons.iter().map(|w| w.num("slot", 0.0) as i64).collect();
    for (p, c, w) in sim.world.query_mut::<(&Player, &Control, &mut Wear)>() {
        if !p.owned || c.pressed == 0 {
            continue;
        }
        for n in 1..=4u32 {
            if c.pressed(crate::cmd::BTN_SLOT1 << (n - 1)) {
                let row = slots.iter().position(|s| *s == n as i64).or(((n as usize) <= rows).then_some(n as usize - 1));
                if let Some(r) = row {
                    w.held = r as u8;
                }
            }
        }
        let cur = if (w.held as usize) < rows { w.held as usize } else { 0 };
        if c.pressed(crate::cmd::BTN_NEXT) {
            w.held = ((cur + 1) % rows) as u8;
        }
        if c.pressed(crate::cmd::BTN_PREV) {
            w.held = ((cur + rows - 1) % rows) as u8;
        }
    }
}

/// Forward and right on the ground for a yaw (yaw 0 looks down −Z, as three.js cameras do; +yaw turns left).
pub fn basis(yaw: f32) -> (Vec2, Vec2) {
    let (s, c) = yaw.sin_cos();
    (Vec2::new(-s, -c), Vec2::new(c, -s))
}

/// The share of the gap closed in one step by an exponential approach that closes 90% in `t90` seconds.
pub fn approach(t90: f32, dt: f32) -> f32 {
    if t90 <= 0.0 { 1.0 } else { 1.0 - (-dt * std::f32::consts::LN_10 / t90).exp() }
}

pub fn core_move(sim: &mut Sim) {
    let t = sim.tables.player.clone();
    let mut jumps: Vec<(u32, Vec3)> = Vec::new();
    for (p, c, look, tr, v, m, w) in sim.world.query_mut::<(&Player, &Control, &Look, &mut Transform, &mut Velocity, &mut Mover, &mut Walker)>() {
        if !p.owned {
            continue;
        }
        // the body faces where the player looks (an entity's forward is −Z turned by its rot: the core's yaw)
        tr.rot = Quat::from_rotation_y(look.yaw);
        let (fwd, right) = basis(look.yaw);
        let (mx, mz) = if c.enabled { (c.move_x, c.move_z) } else { (0.0, 0.0) };
        let mut wish = fwd * mz + right * mx;
        if wish.length() > 1.0 {
            wish = wish.normalize();
        }
        let want = wish * t.walk;
        let grounded = m.grounded;
        let h = Vec2::new(v.linear.x, v.linear.z);
        let t90 = if want.length_squared() > 1e-6 { t.accel_time } else { t.stop_time };
        let k = if grounded { approach(t90, STEP) } else { approach(t90 / t.air_control.max(1e-3), STEP) };
        let h = h + (want - h) * k;
        v.linear.x = h.x;
        v.linear.z = h.y;
        if grounded {
            w.coyote = t.coyote;
        } else {
            w.coyote = (w.coyote - STEP).max(0.0);
        }
        if c.pressed(crate::cmd::BTN_JUMP) {
            w.jump_buffer = t.jump_buffer;
        }
        let mut vy = if grounded && v.linear.y < 0.0 { 0.0 } else { v.linear.y };
        if w.jump_buffer > 0.0 && (grounded || w.coyote > 0.0) && c.enabled {
            vy = t.jump;
            w.jump_buffer = 0.0;
            w.coyote = 0.0;
            jumps.push((p.id, Vec3::ZERO));
        }
        w.jump_buffer = (w.jump_buffer - STEP).max(0.0);
        // gravity, integrated exactly over the step: the travel is the mean of the velocities at its ends
        let v1 = (vy - t.gravity * STEP).max(-t.max_fall);
        m.nudge += Vec3::Y * ((vy + v1) * 0.5 * STEP - v1 * STEP);
        v.linear.y = v1;
    }
    for (id, _) in jumps {
        let Some(&e) = sim.players.get(&id) else { continue };
        let pos = sim.world.get::<&Transform>(e).map(|t| t.pos).unwrap_or(Vec3::ZERO);
        sim.events.push(Event::Motion(events::Motion { what: events::MOTION_JUMP, player: id, pos, speed: t.jump, air: 0.0 }));
        sim.sound(&t.sound_jump, pos, 0.0, id);
    }
}

pub fn core_character(sim: &mut Sim) {
    sim.physics.refresh();
    // the host: where each joiner's own copy says this step left its player (net.rs "a joiner's word")
    let claims = sim.res.get::<crate::net::NetState>().filter(|n| n.is_host() && !n.claims.is_empty()).map(|n| n.claims.clone());
    let mut claimed: Vec<(u32, f32, bool)> = Vec::new();
    let physics = &sim.physics;
    let mut placed: Vec<(Body, Vec3)> = Vec::new();
    let mut still: Vec<(Body, Vec3)> = Vec::new();
    // every character seen from above, for the crowd's mover (crowd.rs): filled as each one is moved, replicas where
    // they stand
    let mut discs: Vec<crate::crowd::Disc> = Vec::new();
    let mut crowd: Vec<Entity> = Vec::new();
    for (e, tr, m, b, replica) in sim.world.query_mut::<(Entity, &Transform, &Mover, &Body, Option<&Replica>)>() {
        if b.kind != BodyKind::Character {
            continue;
        }
        if replica.is_none() && m.crowd {
            crowd.push(e);
        } else if replica.is_some() {
            discs.push(crate::crowd::Disc::of(e, tr.pos, m));
        }
    }
    // first everyone who is not of a crowd (players, bots, enemies that climb), through rapier's controller
    for (e, tr, v, m, b, player) in sim.world.query_mut::<(Entity, &mut Transform, &mut Velocity, &mut Mover, &Body, Option<&Player>)>().without::<&Replica>() {
        if b.kind != BodyKind::Character || m.crowd {
            continue;
        }
        let desired = v.linear * STEP + m.nudge;
        m.nudge = Vec3::ZERO;
        // no snapping while going up (a jump must leave the ground)
        let snap = m.grounded && v.linear.y <= 0.0;
        let mut r = physics.move_character(b, m, tr.pos, desired, STEP, snap);
        // rapier's controller now and then refuses a whole step along flat ground (no wall, no ceiling: only the
        // floor touched inside its 1 cm skin): about one step in 70 at a full walk, a 65 mm hitch, and on a joiner a
        // step its prediction and the host's replay disagree on. Again from just above the skin, then down. Players
        // only (the wave 1b integration): an enemy held back by the crowd round it is stopped on purpose, and the
        // second move let it through (forge-ai's token fixture: the last of eight chasers never got its turn) at twice
        // the controller's cost, a crowd's biggest.
        let want = Vec2::new(desired.x, desired.z).length();
        let got = Vec2::new(r.translation.x, r.translation.z).length();
        if player.is_some() && m.grounded && want > 1e-4 && got < want * 0.5 && r.wall == Vec3::ZERO && !r.ceiling {
            let lift = Vec3::Y * 0.012;
            let again = physics.move_character(b, m, tr.pos + lift, desired - lift, STEP, snap);
            if Vec2::new(again.translation.x, again.translation.z).length() > got {
                r = crate::physics::CharacterMove { translation: again.translation + lift, ..again };
            }
        }
        moved(tr, v, m, &r);
        // the host, a joiner's player: its own copy's word for where this step left it
        let claim = match (player, claims.as_ref()) {
            (Some(p), Some(all)) if p.owned && !p.local => all.get(&p.id).copied().map(|c| (p.id, c)),
            _ => None,
        };
        if let Some((id, (at, vel))) = claim {
            let d = at - tr.pos;
            let far = d.length();
            let taken = far <= crate::net::ADOPT_MAX;
            if taken {
                if far <= crate::net::ADOPT_FREE {
                    tr.pos = at;
                } else {
                    // through the world alone: an enemy the joiner's copy had elsewhere does not hold it, a wall does
                    let through = Mover { blocks: crate::physics::groups::WORLD, ..*m };
                    tr.pos += physics.move_character(b, &through, tr.pos, d, STEP, false).translation;
                }
                if tr.pos.distance(at) <= crate::net::ADOPT_FREE {
                    v.linear = vel;
                }
            }
            claimed.push((id, far, taken));
        }
        placed.push((*b, m.center(tr.pos)));
        discs.push(crate::crowd::Disc::of(e, tr.pos, m));
    }
    // then the crowd, one after another: each sees where everyone before it now stands (crowd.rs)
    let first = discs.len();
    for &e in &crowd {
        if let Ok((tr, m)) = sim.world.query_one_mut::<(&Transform, &Mover)>(e) {
            discs.push(crate::crowd::Disc::of(e, tr.pos, m));
        }
    }
    for (k, &e) in crowd.iter().enumerate() {
        let Ok((tr, v, m, b)) = sim.world.query_one_mut::<(&mut Transform, &mut Velocity, &mut Mover, &Body)>(e) else { continue };
        let me = first + k;
        let desired = v.linear * STEP + m.nudge;
        m.nudge = Vec3::ZERO;
        let snap = m.grounded && v.linear.y <= 0.0;
        // flat walking is the crowd's own; in the air, on a slope or at a step it is the controller's
        let walk = if snap && desired.y <= 0.0 { crate::crowd::walk(physics, m, tr.pos, desired, &discs, me) } else { None };
        let r = match walk {
            Some(w) => crate::physics::CharacterMove { translation: w.translation, grounded: true, sliding: false, ceiling: false, wall: w.wall, ground_normal: Vec3::Y },
            None => physics.move_character(b, m, tr.pos, desired, STEP, snap),
        };
        moved(tr, v, m, &r);
        still.push((*b, m.center(tr.pos)));
        if let Some(d) = discs.get_mut(me) {
            d.at = Vec2::new(tr.pos.x, tr.pos.z);
            d.y = tr.pos.y;
        }
    }
    for (b, center) in placed {
        sim.physics.set_kinematic(&b, center, Quat::IDENTITY);
    }
    // a crowd's bodies carry no velocity: a player is stopped by one, never pushed or drawn along (Physics::set_still)
    for (b, center) in still {
        sim.physics.set_still(&b, center, Quat::IDENTITY);
    }
    if !claimed.is_empty() {
        let st = sim.res.entry::<crate::net::NetState>();
        for (id, far, taken) in claimed {
            st.note_claim(id, far, taken);
        }
    }
}

/// What a character's step did, written back: where it is, what it stands on, the speed it lost into a wall.
fn moved(tr: &mut Transform, v: &mut Velocity, m: &mut Mover, r: &crate::physics::CharacterMove) {
    tr.pos += r.translation;
    m.moved = r.translation;
    m.was_grounded = m.grounded;
    m.grounded = r.grounded;
    m.ground_normal = r.ground_normal;
    m.ceiling = r.ceiling;
    m.wall = r.wall;
    m.wall_speed = 0.0;
    if r.grounded && v.linear.y < 0.0 {
        v.linear.y = 0.0;
    }
    if r.ceiling && v.linear.y > 0.0 {
        v.linear.y = 0.0;
    }
    // speed into a wall is lost (sliding along it is kept)
    let n = Vec3::new(r.wall.x, 0.0, r.wall.z).normalize_or_zero();
    if n != Vec3::ZERO {
        let into = Vec3::new(v.linear.x, 0.0, v.linear.z).dot(n);
        if into < 0.0 {
            m.wall_speed = -into;
            v.linear -= n * into;
        }
    }
}

pub fn core_physics(sim: &mut Sim) {
    sim.physics.step();
    let physics = &sim.physics;
    for (tr, v, b) in sim.world.query_mut::<(&mut Transform, &mut Velocity, &Body)>() {
        if b.kind != BodyKind::Dynamic {
            continue;
        }
        if let Some((p, r, lin, ang)) = physics.state(b) {
            tr.pos = p;
            tr.rot = r;
            v.linear = lin;
            v.angular = ang;
        }
    }
}

pub fn core_walk(sim: &mut Sim) {
    let t = sim.tables.player.clone();
    let floor = sim.floor_limit;
    let mut out: Vec<Event> = Vec::new();
    let mut sounds: Vec<(&str, Vec3, f32, u32)> = Vec::new();
    let mut fell: Vec<Entity> = Vec::new();
    for (e, p, tr, v, m, w) in sim.world.query_mut::<(Entity, &Player, &Transform, &Velocity, &Mover, &mut Walker)>() {
        if !p.owned {
            continue;
        }
        if !m.grounded {
            w.air += STEP;
            w.fall = w.fall.max(-v.linear.y);
        }
        if m.grounded && !w.was_grounded && w.air > 0.12 {
            out.push(Event::Motion(events::Motion { what: events::MOTION_LAND, player: p.id, pos: tr.pos, speed: w.fall, air: w.air }));
            sounds.push((t.sound_land.as_str(), tr.pos, (-10.0 + w.fall).min(0.0), p.id));
        }
        if m.grounded {
            w.air = 0.0;
            w.fall = 0.0;
            w.walked += Vec2::new(m.moved.x, m.moved.z).length();
            if w.walked >= t.step_every {
                w.walked -= t.step_every;
                out.push(Event::Motion(events::Motion { what: events::MOTION_STEP, player: p.id, pos: tr.pos, speed: Vec2::new(v.linear.x, v.linear.z).length(), air: 0.0 }));
                sounds.push((t.sound_step.as_str(), tr.pos, -6.0, p.id));
            }
        }
        if m.wall_speed > 3.0 {
            out.push(Event::Motion(events::Motion { what: events::MOTION_BUMP, player: p.id, pos: tr.pos, speed: m.wall_speed, air: 0.0 }));
        }
        w.was_grounded = m.grounded;
        if tr.pos.y < floor {
            fell.push(e);
            out.push(Event::Motion(events::Motion { what: events::MOTION_FELL, player: p.id, pos: tr.pos, speed: 0.0, air: w.air }));
        }
    }
    for e in out {
        sim.events.push(e);
    }
    for (name, pos, gain, id) in sounds {
        let name = name.to_string();
        sim.sound(&name, pos, gain, id);
    }
    for e in fell {
        let (spawn, yaw) = sim.world.get::<&Walker>(e).map(|w| (w.spawn, w.spawn_yaw)).unwrap_or((Vec3::ZERO, 0.0));
        sim.teleport(e, spawn);
        if let Ok(mut l) = sim.world.get::<&mut Look>(e) {
            l.yaw = yaw;
        }
        if let Ok(mut w) = sim.world.get::<&mut Walker>(e) {
            w.air = 0.0;
            w.fall = 0.0;
        }
    }
}

pub fn core_lifetime(sim: &mut Sim) {
    let mut dead = Vec::new();
    for (e, l) in sim.world.query_mut::<(Entity, &mut Lifetime)>() {
        l.left -= STEP;
        if l.left <= 0.0 {
            dead.push(e);
        }
    }
    for (_, h) in sim.world.query_mut::<(Entity, &mut Health)>() {
        h.invulnerable = (h.invulnerable - STEP).max(0.0);
    }
    for e in dead {
        sim.despawn(e);
    }
}

/// The most a replica's capsule is carried ahead of its last sample (seconds): past it the sample is stale, not ahead.
pub const MAX_LEAD: f32 = 0.35;

pub fn core_replicas(sim: &mut Sim) {
    // a joiner's lead over the newest snapshot, seconds: its own step now against the last of its steps the host had
    // applied then. The host will replay this step that much later than the snapshot, with its enemies that much
    // further on, so what the joiner's own player bumps into is each enemy's capsule carried forward by its velocity
    // (the body is still drawn between its samples). Wave 2: without it a joiner walked through enemies the host stopped
    // it at, and was pulled back (INTEGRATION.md mismatch 16).
    let lead = sim.res.get::<crate::net::NetState>().filter(|n| n.is_joiner()).map(|n| n.lead(sim.time.step as u32) as f32 * STEP).unwrap_or(0.0).min(MAX_LEAD);
    let me: Option<(Vec3, f32)> = sim.world.query::<(&Player, &Transform, &Mover)>().iter().find(|(p, ..)| p.local && p.owned).map(|(_, t, m)| (t.pos, m.radius));
    let mut bodies: Vec<(Body, Vec3, Quat, bool)> = Vec::new();
    for (tr, r, b, m, player) in sim.world.query_mut::<(&mut Transform, &mut Replica, Option<&Body>, Option<&Mover>, Option<&Player>)>() {
        r.t += STEP;
        let k = if r.span > 0.0 { (r.t / r.span).clamp(0.0, 1.0) } else { 1.0 };
        tr.pos = r.from.lerp(r.to, k);
        let d = (r.to_yaw - r.from_yaw + std::f32::consts::PI).rem_euclid(std::f32::consts::TAU) - std::f32::consts::PI;
        tr.rot = Quat::from_rotation_y(r.from_yaw + d * k);
        // its body follows, so characters still bump into it and rays still find it
        if let Some(b) = b {
            match m {
                Some(m) if player.is_none() && lead > 0.0 => {
                    let mut at = r.to + Vec3::new(r.vel.x, 0.0, r.vel.z) * lead;
                    at.y = tr.pos.y;
                    // never carried into this copy's own player (an enemy that stopped since its last sample)
                    if let Some((mine, radius)) = me {
                        let gap = Vec2::new(at.x - mine.x, at.z - mine.z);
                        let least = m.radius + radius + 0.02;
                        if gap.length() < least {
                            let from = Vec2::new(r.to.x - mine.x, r.to.z - mine.z);
                            let dir = if from.length() > 1e-3 { from.normalize() } else { gap.normalize_or(Vec2::X) };
                            let hold = dir * least.max(from.length().min(least));
                            at.x = mine.x + hold.x;
                            at.z = mine.z + hold.y;
                        }
                    }
                    bodies.push((*b, m.center(at), Quat::IDENTITY, true));
                }
                Some(m) => bodies.push((*b, m.center(tr.pos), Quat::IDENTITY, player.is_none())),
                None => bodies.push((*b, tr.pos, tr.rot, false)),
            }
        }
    }
    for (b, p, q, crowd) in bodies {
        // a joiner's copy of an enemy stops its player as the host's does: without a velocity (Physics::set_still)
        if crowd {
            sim.physics.set_still(&b, p, q);
        } else {
            sim.physics.set_kinematic(&b, p, q);
        }
    }
}

pub fn core_anim(sim: &mut Sim) {
    // every animated entity gets its bones' place in the pose buffer, in a stable order (by entity), then is evaluated
    let lib = &sim.anim.library;
    let poses = &mut sim.anim.poses;
    let mut list: Vec<(Entity, u32)> = sim.world.query::<(Entity, &Animated)>().iter().map(|(e, a)| (e, a.animator.bone_count(lib) as u32)).collect();
    list.sort_by_key(|(e, _)| e.to_bits());
    let total: u32 = list.iter().map(|(_, n)| *n).sum();
    poses.resize(total as usize);
    let mut base = 0u32;
    for (e, n) in list {
        if let Ok(mut a) = sim.world.get::<&mut Animated>(e) {
            a.base = base;
            a.count = n;
            a.animator.advance(STEP);
            a.animator.evaluate(lib, poses, base as usize);
        }
        base += n;
    }
}

pub fn core_hurtboxes(sim: &mut Sim) {
    let poses = &sim.anim.poses;
    for (tr, hb, a) in sim.world.query_mut::<(&Transform, &mut Hurtbox, Option<&Animated>)>() {
        let bones: &[Mat4] = a.map(|a| poses.slice(a.base, a.count)).unwrap_or(&[]);
        crate::hurtbox::place(hb, tr.matrix(), bones);
    }
}
