//! Bots for playing alone and for verify (check 12 "something happens" and the bot parts of check 21): forge players
//! the host simulates whose stick, look and buttons come from a brain here instead of a keyboard. The brain writes the
//! player's `Control` and `Look` in the Input stage, exactly what an INPUT command writes (the same clamps), so the
//! controller, the weapons (track F) and everything after read a bot as they read a person.
//!
//! The JS side (gf/forge/ai.js) marks a session bot with OP_BOT every frame: enabled (the round is playing), a mode
//! the rules can set through the shared bot API (`p.bot.seek(pos)`, `wander()`, `stop()`, `aimAt(pos)`, `press(…)`),
//! and a skill. Modes:
//!   auto   fight the nearest enemy when there is one (keep a fighting distance, strafe, aim with a human error that
//!          settles, fire on target, a quick melee up close, an evade from a tell aimed at it); else seek the goal the
//!          rules set, else wander
//!   seek / flee / wander / idle / fight   as named (fight: auto without the goal)
//! Fair play: no fire for the first second it is enabled (the round's start grace).
use forge_core::cmd::{self, Record};
use forge_core::components::*;
use forge_core::glam::{Vec2, Vec3};
use forge_core::hecs::Entity;
use forge_core::sim::Sim;

use crate::defs::Roster;
use crate::enemy::{fwd, h, yaw_of, Enemy, State};
use crate::nav::Nav;

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
#[repr(u8)]
pub enum Mode {
    #[default]
    Auto = 0,
    Seek = 1,
    Flee = 2,
    Wander = 3,
    Idle = 4,
    Fight = 5,
}

impl Mode {
    pub fn from_u32(v: u32) -> Mode {
        [Mode::Auto, Mode::Seek, Mode::Flee, Mode::Wander, Mode::Idle, Mode::Fight].get(v as usize).copied().unwrap_or(Mode::Auto)
    }
}

/// A bot's brain: what the rules asked (mode, goal, aim, presses) and what it is doing.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct Bot {
    pub enabled: bool,
    pub mode: Mode,
    pub goal: Vec3,
    pub stop: f32,
    pub aim: Option<Vec3>,
    pub press: u32,
    pub hold: u32,
    /// 0..1: aim error, reaction and evading.
    pub skill: f32,
    pub target: Option<Entity>,
    pub target_net: u32,
    pub pick_in: f32,
    pub err: Vec2,
    pub strafe: f32,
    pub strafe_t: f32,
    pub wander: Option<Vec2>,
    pub wander_t: f32,
    pub fire_t: f32,
    pub melee_t: f32,
    pub evade_t: f32,
    pub grace: f32,
    pub firing: bool,
    /// Fire presses and melee presses so far (QA).
    pub shots: u32,
    pub swings: u32,
    pub evades: u32,
    pub path_t: f32,
    pub path: Option<Vec2>,
    pub last: Vec2,
    pub still: f32,
    pub seed: u32,
}

/// OP_BOT: ints [player id, enabled, mode, aim given, press, hold], floats [skill, goal x y z, stop, aim x y z].
pub fn command(sim: &mut Sim, r: &Record) {
    let Some(&e) = sim.players.get(&r.u(0)) else { return };
    let enabled = r.u(1) != 0;
    let fresh = sim.world.get::<&Bot>(e).is_err();
    let mut b = sim.world.get::<&Bot>(e).map(|b| *b).unwrap_or(Bot { strafe: 1.0, skill: 0.6, seed: r.u(0), ..Bot::default() });
    if enabled && (!b.enabled || fresh) {
        b.grace = 1.0;
    }
    b.enabled = enabled;
    b.mode = Mode::from_u32(r.u(2));
    b.aim = (r.u(3) != 0).then(|| Vec3::new(r.f(11), r.f(12), r.f(13)));
    b.press |= r.u(4);
    b.hold = r.u(5);
    b.skill = if r.len() > 6 { r.f(6).clamp(0.0, 1.0) } else { b.skill };
    b.goal = Vec3::new(r.f(7), r.f(8), r.f(9));
    b.stop = r.f(10).max(0.3);
    let _ = sim.world.insert_one(e, b);
}

struct Foe {
    e: Entity,
    net: u32,
    pos: Vec3,
    height: f32,
    melee: bool,
    telling_at: Option<Entity>,
    state: State,
}

/// The Input-stage system: every enabled bot's stick, look and buttons.
pub fn system(sim: &mut Sim) {
    let bots: Vec<(Entity, Bot, Vec3, f32, f32)> = sim.world.query::<(Entity, &Bot, &Transform, &Look)>().iter().map(|(e, b, t, l)| (e, *b, t.pos, l.yaw, l.pitch)).collect();
    if bots.is_empty() {
        return;
    }
    let dt = sim.time.dt;
    let step = sim.time.step;
    let eye = sim.tables.player.eye;
    let roster = sim.res.take::<Roster>();
    let mut nav = sim.res.take::<Nav>();
    if nav.grid.is_none() {
        nav.ensure(&sim.physics);
    }
    let foes: Vec<Foe> = sim
        .world
        .query::<(Entity, &NetId, &Enemy, &Transform, &Health)>()
        .iter()
        .filter(|(.., hp)| !hp.dead)
        .map(|(e, n, en, t, _)| {
            let d = roster.def(en.row);
            Foe { e, net: n.0, pos: t.pos, height: d.height, melee: d.arch.melee(), telling_at: (en.state == State::Tell).then_some(en.target).flatten(), state: en.state }
        })
        .collect();
    let mut out: Vec<(Entity, Bot, Vec2, f32, f32, u32, u32)> = Vec::new();
    for (e, mut b, pos, yaw, pitch) in bots {
        if !b.enabled {
            out.push((e, b, Vec2::ZERO, yaw, pitch, 0, 0));
            continue;
        }
        b.grace = (b.grace - dt).max(0.0);
        b.fire_t = (b.fire_t - dt).max(0.0);
        b.melee_t = (b.melee_t - dt).max(0.0);
        b.evade_t = (b.evade_t - dt).max(0.0);
        b.pick_in -= dt;
        b.path_t -= dt;
        b.strafe_t -= dt;
        let p2 = h(pos);
        let fight = matches!(b.mode, Mode::Auto | Mode::Fight);
        // the target: the nearest foe (prefer one in the open), re-picked twice a second
        if fight && (b.pick_in <= 0.0 || b.target.is_none_or(|t| !foes.iter().any(|f| f.e == t))) {
            let pick = foes.iter().filter(|f| !(f.state == State::Arrive)).min_by(|a, c| {
                let score = |f: &Foe| h(f.pos).distance(p2) + if nav.grid.as_ref().is_some_and(|g| !g.los(p2, h(f.pos))) { 6.0 } else { 0.0 };
                score(a).total_cmp(&score(c))
            });
            if pick.map(|f| f.e) != b.target {
                // a new target: the aim starts off by a human error that settles
                let k = (1.0 - b.skill) * 0.15 + 0.02;
                b.err = Vec2::new(rand(&mut b.seed) * k, rand(&mut b.seed) * k * 0.5);
            }
            b.target = pick.map(|f| f.e);
            b.target_net = pick.map(|f| f.net).unwrap_or(0);
            b.pick_in = 0.5;
        }
        if !fight {
            b.target = None;
        }
        b.err *= (-dt * (2.0 + 4.0 * b.skill)).exp();
        let foe = b.target.and_then(|t| foes.iter().find(|f| f.e == t));
        let mut move_dir = Vec2::ZERO;
        let mut look_at: Option<Vec3> = b.aim;
        let (mut held, mut pressed) = (b.hold, std::mem::take(&mut b.press));
        if let Some(f) = foe {
            let to = h(f.pos) - p2;
            let dist = to.length();
            let dir = to.normalize_or_zero();
            let los = nav.grid.as_ref().is_none_or(|g| g.los(p2, h(f.pos)));
            look_at = Some(f.pos + Vec3::Y * (f.height * 0.62));
            let (near, far) = if f.melee { (5.0, 9.0) } else { (4.0, 7.0) };
            if !los || dist > far + 2.0 {
                move_dir = path(&mut nav, &mut b, p2, h(f.pos), step);
            } else if dist < near {
                move_dir = -dir;
                if nav.grid.as_ref().is_some_and(|g| !g.free_at(p2 - dir * 1.0)) {
                    move_dir = Vec2::new(-dir.y, dir.x) * b.strafe;
                }
            } else {
                if b.strafe_t <= 0.0 {
                    b.strafe = if rand(&mut b.seed) > 0.0 { 1.0 } else { -1.0 };
                    b.strafe_t = 1.2 + (rand(&mut b.seed) + 1.0) * 0.6;
                }
                let side = Vec2::new(-dir.y, dir.x) * b.strafe;
                move_dir = if nav.grid.as_ref().is_none_or(|g| g.free_at(p2 + side * 1.2)) { side * 0.8 } else { -side * 0.8 };
                if dist > far {
                    move_dir += dir * 0.6;
                }
            }
            // fire when the aim is on it and the way is clear; a quick melee up close; an evade from a tell at it
            let want_yaw = yaw_of(Vec2::new(look_at.unwrap().x - pos.x, look_at.unwrap().z - pos.z)) + b.err.x;
            let off = forge_core::wrap(want_yaw - yaw).abs();
            if los && off < 0.06 && b.grace <= 0.0 && dist < 40.0 {
                held |= cmd::BTN_FIRE;
                if !b.firing || b.fire_t <= 0.0 {
                    pressed |= cmd::BTN_FIRE;
                    b.fire_t = 0.25;
                    b.shots += 1;
                }
                b.firing = true;
            } else {
                b.firing = false;
            }
            if dist < 1.7 && off < 0.5 && b.melee_t <= 0.0 && b.grace <= 0.0 {
                pressed |= cmd::BTN_MELEE;
                b.melee_t = 0.7;
                b.swings += 1;
            }
        } else {
            b.firing = false;
            match b.mode {
                Mode::Idle => {}
                Mode::Seek | Mode::Auto | Mode::Fight if b.mode == Mode::Seek || b.goal != Vec3::ZERO => {
                    let goal = h(b.goal);
                    if goal.distance(p2) > b.stop {
                        move_dir = path(&mut nav, &mut b, p2, goal, step);
                    }
                }
                Mode::Flee => move_dir = (p2 - h(b.goal)).normalize_or_zero(),
                _ => move_dir = wander(&mut nav, &mut b, p2, dt, step),
            }
        }
        for f in &foes {
            if f.telling_at == Some(e) && h(f.pos).distance(p2) < 2.6 && b.evade_t <= 0.0 && rand(&mut b.seed).abs() < b.skill {
                pressed |= cmd::BTN_EVADE;
                b.evade_t = 1.5;
                b.evades += 1;
                let away = (p2 - h(f.pos)).normalize_or_zero();
                move_dir = Vec2::new(-away.y, away.x) * b.strafe + away * 0.3;
            }
        }
        // stuck: barely moved for a second while meaning to → a new wander point, the other strafe side
        if move_dir.length_squared() > 0.01 {
            if p2.distance(b.last) < 0.05 {
                b.still += dt;
            } else {
                b.still = 0.0;
            }
            if b.still > 1.0 {
                b.still = 0.0;
                b.strafe = -b.strafe;
                b.wander = None;
                b.path = None;
            }
        }
        b.last = p2;
        // the look: toward what it aims at, at a turn rate (with the settling error)
        let (mut ny, mut np) = (yaw, pitch);
        if let Some(a) = look_at {
            let flat = Vec2::new(a.x - pos.x, a.z - pos.z);
            let want_yaw = yaw_of(flat) + b.err.x;
            let want_pitch = ((a.y - (pos.y + eye)).atan2(flat.length().max(0.01)) + b.err.y).clamp(-1.4, 1.4);
            let rate = (5.0 + 5.0 * b.skill) * dt;
            ny = forge_core::wrap(yaw + forge_core::wrap(want_yaw - yaw).clamp(-rate, rate));
            np = pitch + (want_pitch - pitch).clamp(-rate, rate);
        } else if move_dir.length_squared() > 0.01 {
            let rate = 4.0 * dt;
            ny = forge_core::wrap(yaw + forge_core::wrap(yaw_of(move_dir) - yaw).clamp(-rate, rate));
            np = pitch * (1.0 - 3.0 * dt).max(0.0);
        }
        out.push((e, b, move_dir, ny, np, held, pressed));
    }
    sim.res.insert(nav);
    sim.res.insert(roster);
    for (e, b, w, yaw, pitch, held, pressed) in out {
        let enabled = b.enabled;
        if let Ok((c, l, bot)) = sim.world.query_one_mut::<(&mut Control, &mut Look, &mut Bot)>(e) {
            *bot = b;
            // what INPUT writes: the stick in the look's axes (right, forward), the buttons, the look
            let f = fwd(yaw);
            let r = Vec2::new(-f.y, f.x);
            let w = if w.length() > 1.0 { w.normalize() } else { w };
            c.move_x = w.dot(r).clamp(-1.0, 1.0);
            c.move_z = w.dot(f).clamp(-1.0, 1.0);
            c.held = if enabled { held } else { 0 };
            c.pressed |= if enabled { pressed } else { 0 };
            c.enabled = enabled;
            l.yaw = yaw;
            l.pitch = pitch.clamp(-1.45, 1.45);
        }
    }
}

/// −1..1 from a bot's own little stream (its seed), so bots differ but replay the same.
fn rand(seed: &mut u32) -> f32 {
    *seed ^= *seed << 13;
    *seed ^= *seed >> 17;
    *seed ^= *seed << 5;
    (*seed as f32 / u32::MAX as f32) * 2.0 - 1.0
}

/// Which way to walk toward `to`: straight with a clear grid line, else the next waypoint of a field toward it
/// (re-planned at most every 0.4 s).
fn path(nav: &mut Nav, b: &mut Bot, from: Vec2, to: Vec2, step: u64) -> Vec2 {
    let Some(g) = nav.grid.as_ref() else { return (to - from).normalize_or_zero() };
    if g.los(from, to) {
        b.path = None;
        return (to - from).normalize_or_zero();
    }
    if b.path_t <= 0.0 || b.path.is_none_or(|w| w.distance(from) < 0.4) {
        b.path_t = 0.4;
        b.path = nav.waypoint_to(from, to, step, 24);
    }
    match b.path {
        Some(w) => (w - from).normalize_or_zero(),
        None => (to - from).normalize_or_zero(),
    }
}

/// Somewhere free on the grid, then the next.
fn wander(nav: &mut Nav, b: &mut Bot, from: Vec2, dt: f32, step: u64) -> Vec2 {
    b.wander_t -= dt;
    let need = b.wander.is_none_or(|w| w.distance(from) < 1.0) || b.wander_t <= 0.0;
    if need {
        b.wander = nav.grid.as_ref().and_then(|g| {
            for _ in 0..12 {
                let x = (rand(&mut b.seed) * 0.5 + 0.5) * g.w as f32 * 0.8 + g.w as f32 * 0.1;
                let z = (rand(&mut b.seed) * 0.5 + 0.5) * g.h as f32 * 0.8 + g.h as f32 * 0.1;
                let p = g.min + Vec2::new(x, z) * g.cell;
                if g.free_at(p) {
                    return Some(p);
                }
            }
            None
        });
        if b.wander.is_none() {
            b.wander = Some(from + Vec2::new(rand(&mut b.seed), rand(&mut b.seed)) * 4.0);
        }
        b.wander_t = 3.0 + (rand(&mut b.seed) + 1.0) * 2.0;
    }
    let w = b.wander.unwrap_or(from);
    path(nav, b, from, w, step)
}

/// The bots' state for QA and the HUD (`forge.ai_bots()`): per bot [id, mode, target net, firing, shots, swings, evades].
pub fn observe(sim: &Sim) -> Vec<f32> {
    let mut out = Vec::new();
    let mut list: Vec<(u32, Bot)> = sim.world.query::<(&Player, &Bot)>().iter().map(|(p, b)| (p.id, *b)).collect();
    list.sort_by_key(|x| x.0);
    for (id, b) in list {
        out.extend_from_slice(&[id as f32, b.mode as u8 as f32, b.target_net as f32, b.firing as u8 as f32, b.shots as f32, b.swings as f32, b.evades as f32, b.enabled as u8 as f32]);
    }
    out
}
