//! The wave director: the waves table (`spec.forge.waves`) run in order. Each wave's enemies rise one after another
//! (`delay`, then one every `spawnEvery`, never more than `maxAlive` at once) at an emerge point `distance.min`-`max`
//! from a player (the arena's mounds first, else a free cell on the grid), its types interleaved so the mix shows
//! early, and a boss wave's boss last. `attackers` is the attack tokens per player while it runs.
//!
//! The rules hear it as rule events (rules.event(ctx, name, data, 'forge')) and EV_WAVE:
//!   wave-start {a: wave number (1-based), b: waves, c: enemies, d: 1 boss wave} · wave-clear {a, b, c: 1 a reward follows,
//!   d: 1 the pedlar's cart opens (wave 7)}
//!   wave-reward {a, b, c: 1 a reward, d: 1 the cart}: the director waits (Phase::Reward) until OP_DIRECTOR resume (the
//!   kit deals the three cards and opens the cart, gf/forge/ai.js)
//!   waves-done {a: waves}
//! A wave changes inside a round without stopping play (moment 16), unless it asks for a reward.
use forge_core::components::*;
use forge_core::events::Event;
use forge_core::glam::{Vec2, Vec3};
use forge_core::hecs::Entity;
use forge_core::sim::Sim;

use crate::defs::{Arch, Next, Roster};
use crate::enemy::{self, h, Enemy, State};
use crate::nav::Nav;
use crate::EV_WAVE;

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
#[repr(u8)]
pub enum Phase {
    /// Not started (or stopped).
    #[default]
    Idle = 0,
    Running = 1,
    /// A wave was cleared and its reward is being chosen.
    Reward = 2,
    /// Every wave cleared.
    Done = 3,
}

#[derive(Default)]
pub struct Director {
    pub phase: Phase,
    /// The wave running (an index into the waves table).
    pub wave: usize,
    /// Seconds into it.
    pub t: f32,
    pub next_at: f32,
    /// Rows still to rise this wave, in order.
    pub queue: Vec<u16>,
    pub spawned: u32,
    pub total: u32,
    pub killed: u32,
    pub kills_total: u32,
    /// Emerge points (OP_MOUND): the arena's mounds.
    pub mounds: Vec<Vec3>,
    /// Waves started (QA).
    pub started: u32,
    /// The running wave's `attackers` (attack tokens per player), set as it starts.
    pub attackers_of: Option<u32>,
    /// How much bigger the running wave is for the players in it (wave 2: 1 + the wave's `friends` × the players after
    /// the first, counted as it starts): its enemies, the most alive at once, a boss's health.
    pub scale: f32,
    /// Endless (`spec.forge.endless`, wave 6): how many times the waves have gone round (0: the first time through).
    pub lap: u32,
    /// The wave's number as players count it, 1 on: the index plus one the first time through, and on with no end
    /// when the waves go round. Every wave event carries it.
    pub number: u32,
    /// The running wave's most alive at once before the friends' share (its own `maxAlive`, grown each lap).
    pub max_alive: u32,
}

impl Director {
    /// Attack tokens per player now (the running wave's `attackers`, else 3).
    pub fn attackers(&self) -> u32 {
        self.attackers_of.unwrap_or(3)
    }
}

/// OP_DIRECTOR actions.
pub mod action {
    pub const STOP: u32 = 0;
    pub const START: u32 = 1;
    pub const RESUME: u32 = 2;
    pub const SKIP: u32 = 3;
    pub const PAUSE: u32 = 4;
}

fn wave_event(what: u32, wave: u32, waves: u32, n: u32) -> Event {
    let mut w = [0u32; 14];
    w[0] = what;
    w[1] = wave;
    w[2] = waves;
    w[3] = n;
    Event::Custom { kind: EV_WAVE, words: w }
}

/// Start wave `i`: its queue (types interleaved, the boss last), its tokens, the rule event.
pub fn begin(sim: &mut Sim, i: usize) {
    let roster = sim.res.take::<Roster>();
    let mut d = sim.res.take::<Director>();
    if let Some(w) = roster.waves.get(i) {
        // more for each friend (the wave's `friends`): every type but a boss, whose health grows instead
        let players = sim.world.query::<&Player>().iter().count().max(1);
        let scale = 1.0 + w.friends * (players - 1) as f32;
        d.scale = scale;
        // endless: each lap more of every type but a boss, and more at once up to the crowd's cap
        let e = &roster.endless;
        let more = e.mul(e.enemies, d.lap);
        d.max_alive = if e.on && d.lap > 0 { ((w.max_alive as f32 * e.mul(e.alive, d.lap)).ceil() as u32).min(e.alive_most.max(w.max_alive)) } else { w.max_alive };
        // interleave the groups (one of each in turn) so the mix shows early; a boss wave's bosses last
        let mut left: Vec<(u16, u32)> = w.groups.iter().map(|(row, n)| (*row, if roster.def(*row).arch == Arch::Boss { *n } else { (*n as f32 * scale * more).ceil() as u32 })).collect();
        let mut q = Vec::new();
        while left.iter().any(|g| g.1 > 0) {
            for g in left.iter_mut() {
                if g.1 > 0 {
                    q.push(g.0);
                    g.1 -= 1;
                }
            }
        }
        if w.boss {
            let (boss, rest): (Vec<u16>, Vec<u16>) = q.iter().partition(|r| roster.def(**r).arch == Arch::Boss);
            q = rest;
            if boss.is_empty() {
                // a boss wave naming no boss type: its last enemy is the one to watch, as it is
            } else {
                q.extend(boss);
            }
        }
        d.phase = Phase::Running;
        d.wave = i;
        d.t = 0.0;
        d.next_at = w.delay;
        d.total = q.len() as u32;
        d.queue = q;
        d.queue.reverse();
        d.spawned = 0;
        d.killed = 0;
        d.started += 1;
        d.number += 1;
        d.attackers_of = Some(w.attackers);
        // wave 7: this wave's elites are counted from none
        crate::elite::wave_started(sim);
        // endless: the waves are counted with no last one (b: 0)
        let (n, total, boss, number) = (d.total, if roster.endless.on { 0 } else { roster.waves.len() }, w.boss, d.number);
        sim.rule("wave-start", 0, number as f32, total as f32, n as f32, boss as u8 as f32);
        sim.emit(wave_event(1, number, total as u32, n));
    } else {
        d.phase = Phase::Done;
    }
    sim.res.insert(d);
    sim.res.insert(roster);
}

/// OP_DIRECTOR: start (from wave `arg`), stop (and clear the enemies), resume after a reward, skip to wave `arg`, pause.
/// Start and skip take a lap too (`lap`, 0 the first time through: QA's way to a later lap, wave 7); a start is a new
/// run for the elites (their firsts and fires go), a skip is not.
pub fn command(sim: &mut Sim, act: u32, arg: u32, lap: u32) {
    match act {
        action::START | action::SKIP => {
            if act == action::SKIP {
                clear(sim);
            } else {
                crate::elite::reset(sim);
            }
            let waves = sim.res.get::<Roster>().map(|r| r.waves.len() as u32).unwrap_or(0);
            let d = sim.res.entry::<Director>();
            d.lap = lap;
            // the wave as players count it: the index, plus the waves of each lap before (a lap goes round from `from`)
            d.number = arg;
            if lap > 0 {
                let from = sim.res.get::<Roster>().map(|r| r.endless.from as u32).unwrap_or(0);
                let d = sim.res.entry::<Director>();
                d.number = waves + (lap - 1) * waves.saturating_sub(from) + arg.saturating_sub(from);
            }
            begin(sim, arg as usize);
        }
        action::RESUME => {
            let phase = sim.res.get::<Director>().map(|d| d.phase).unwrap_or_default();
            if phase == Phase::Reward || (phase == Phase::Idle && sim.res.get::<Director>().is_some_and(|d| d.started > 0)) {
                advance(sim);
            }
        }
        action::PAUSE => {
            let d = sim.res.entry::<Director>();
            if d.phase == Phase::Running {
                d.phase = Phase::Idle;
            }
        }
        _ => {
            clear(sim);
            crate::elite::reset(sim);
            let d = sim.res.entry::<Director>();
            let mounds = std::mem::take(&mut d.mounds);
            *d = Director { mounds, ..Director::default() };
        }
    }
}

/// After a wave (and its reward): the next one; past the last, the first of the next lap when the game is endless,
/// else every wave is done.
fn advance(sim: &mut Sim) {
    let wave = sim.res.get::<Director>().map(|d| d.wave).unwrap_or(0);
    let (waves, endless, from) = sim.res.get::<Roster>().map(|r| (r.waves.len(), r.endless.on, r.endless.from)).unwrap_or((0, false, 0));
    if wave + 1 < waves {
        begin(sim, wave + 1);
    } else if endless && waves > 0 {
        let d = sim.res.entry::<Director>();
        d.lap += 1;
        let lap = d.lap;
        sim.rule("lap", 0, lap as f32, (from + 1) as f32, 0.0, 0.0);
        begin(sim, from);
    } else {
        finish(sim);
    }
}

fn finish(sim: &mut Sim) {
    let waves = sim.res.get::<Roster>().map(|r| r.waves.len()).unwrap_or(0) as u32;
    sim.res.entry::<Director>().phase = Phase::Done;
    sim.rule("waves-done", 0, waves as f32, 0.0, 0.0, 0.0);
    sim.emit(wave_event(4, waves, waves, 0));
}

/// Despawn every enemy and projectile (a round's end, a skip).
pub fn clear(sim: &mut Sim) {
    let list: Vec<Entity> = sim.world.query::<(Entity, &Kind)>().without::<&Replica>().iter().filter(|(_, k)| k.kind == kind::ENEMY || k.kind == kind::PROJECTILE).map(|(e, _)| e).collect();
    for e in list {
        sim.despawn_now(e);
    }
    if let Some(t) = sim.res.get_mut::<enemy::Tokens>() {
        t.held.clear();
    }
}

/// The Ai-stage system: count the dead, raise the next enemy when it is due, end the wave.
pub fn system(sim: &mut Sim) {
    let phase = sim.res.get::<Director>().map(|d| d.phase).unwrap_or_default();
    if phase != Phase::Running {
        return;
    }
    let dt = sim.time.dt;
    let roster = sim.res.take::<Roster>();
    let mut d = sim.res.take::<Director>();
    let Some(w) = roster.waves.get(d.wave).cloned() else {
        sim.res.insert(d);
        sim.res.insert(roster);
        return;
    };
    d.t += dt;
    let wave_tag = d.wave as u16;
    let (mut alive, mut dead) = (0u32, 0u32);
    for en in sim.world.query::<&Enemy>().iter() {
        if en.wave == Some(wave_tag) {
            if en.state == State::Dead {
                dead += 1;
            } else {
                alive += 1;
            }
        }
    }
    let _ = dead;
    let newly = d.spawned.saturating_sub(alive).saturating_sub(d.killed);
    d.killed += newly;
    d.kills_total += newly;
    // the next enemy, when it is due and there is room
    let mut raise: Option<u16> = None;
    let scale = if d.scale > 0.0 { d.scale } else { 1.0 };
    let most = if d.max_alive > 0 { d.max_alive } else { w.max_alive };
    if !d.queue.is_empty() && d.t >= d.next_at && alive < (most as f32 * scale).ceil() as u32 {
        raise = d.queue.pop();
        d.next_at = d.t + w.spawn_every;
    }
    let done = d.queue.is_empty() && alive == 0 && raise.is_none();
    let timed_out = w.next == Next::Timer && w.time > 0.0 && d.t >= w.time;
    let (wave, waves, number, lap) = (d.wave, roster.waves.len(), d.number, d.lap);
    let endless_on = roster.endless.on;
    // wave 7 (track E): whether it rises as an elite (the host's seeded dice, once elites can rise; forced ones first)
    let elite = raise.map(|row| crate::elite::roll(sim, &roster, row, lap, number)).unwrap_or_default();
    // wave 7 (track P): whether the pedlar's cart opens after this wave
    let cart = roster.cart.after(number);
    sim.res.insert(d);
    sim.res.insert(roster);
    if let Some(row) = raise {
        let nav = sim.res.take::<Nav>();
        let at = spawn_point(sim, &nav, w.dmin, w.dmax);
        sim.res.insert(nav);
        // endless: each lap the risen are tougher, hit harder and (up to a cap) come faster; an elite more so
        // (Roster::variant: what the enemy reads every step, not only the health it rises with)
        let ix = sim.res.get_mut::<Roster>().map(|r| r.variant(row, lap, elite, false)).unwrap_or(row);
        let def = sim.res.get::<Roster>().map(|r| r.by_index(ix).into_owned()).unwrap_or_else(|| crate::defs::Def::base(Arch::Chaser));
        let yaw = face_players(sim, at);
        let e = enemy::spawn(sim, &def, row, at, yaw, true, Some(wave_tag));
        if let Ok(mut en) = sim.world.get::<&mut Enemy>(e) {
            en.def = ix;
        }
        crate::elite::raised(sim, e, row, elite, false);
        // a boss among friends: more health, not more bosses
        if def.arch == Arch::Boss
            && scale > 1.0
            && let Ok(mut h) = sim.world.get::<&mut Health>(e)
        {
            h.max *= scale;
            h.hp = h.max;
        }
        if let Some(d) = sim.res.get_mut::<Director>() {
            d.spawned += 1;
        }
    }
    if done || timed_out {
        let reward = w.reward;
        let shown = if endless_on { 0 } else { waves };
        let last = wave + 1 >= waves && !endless_on;
        let cart = cart && !last;
        sim.rule("wave-clear", 0, number as f32, shown as f32, reward as u8 as f32, cart as u8 as f32);
        sim.emit(wave_event(2, number, shown as u32, 0));
        if last {
            finish(sim);
        } else if reward || cart {
            sim.res.entry::<Director>().phase = Phase::Reward;
            sim.rule("wave-reward", 0, number as f32, shown as f32, reward as u8 as f32, cart as u8 as f32);
            sim.emit(wave_event(5, number, shown as u32, 0));
        } else {
            advance(sim);
        }
    }
}

fn face_players(sim: &Sim, at: Vec3) -> f32 {
    let near = enemy::targets(sim).into_iter().filter(|t| t.alive).min_by(|a, b| h(a.pos).distance_squared(h(at)).total_cmp(&h(b.pos).distance_squared(h(at))));
    near.map(|t| enemy::yaw_of(h(t.pos) - h(at))).unwrap_or(0.0)
}

/// Where the next enemy rises: a mound `dmin`-`dmax` from the nearest player and free of other enemies, picked at
/// random among those (moment 4: 7-10 m); else the mound nearest that band; with no mounds a free cell at that
/// distance from a random player; with no players the arena's middle.
pub fn spawn_point(sim: &mut Sim, nav: &Nav, dmin: f32, dmax: f32) -> Vec3 {
    let players: Vec<Vec3> = enemy::targets(sim).into_iter().filter(|t| t.alive).map(|t| t.pos).collect();
    let enemies: Vec<Vec2> = sim.world.query::<(&Enemy, &Transform)>().iter().map(|(_, t)| h(t.pos)).collect();
    let mounds = sim.res.get::<Director>().map(|d| d.mounds.clone()).unwrap_or_default();
    if !mounds.is_empty() && !players.is_empty() {
        let near = |m: &Vec3| players.iter().map(|p| h(*p).distance(h(*m))).fold(f32::MAX, f32::min);
        let free = |m: &Vec3| enemies.iter().all(|e| e.distance(h(*m)) > 1.2);
        let ok: Vec<Vec3> = mounds.iter().filter(|m| (dmin..=dmax).contains(&near(m)) && free(m)).copied().collect();
        if !ok.is_empty() {
            let k = (sim.rng.f32() * ok.len() as f32) as usize;
            return ok[k.min(ok.len() - 1)];
        }
        let off = |m: &Vec3| { let d = near(m); if d < dmin { dmin - d } else { d - dmax } };
        if let Some(m) = mounds.iter().filter(|m| free(m) && near(m) >= dmin * 0.6).min_by(|a, b| off(a).total_cmp(&off(b))) {
            return *m;
        }
    }
    let around = if players.is_empty() { Vec3::ZERO } else { players[(sim.rng.f32() * players.len() as f32) as usize % players.len()] };
    free_spot(sim, nav, around, dmin, dmax, Some(&players)).unwrap_or(Vec3::new(around.x, 0.05, around.z))
}

/// A free spot `dmin`-`dmax` from `around` on the grid (and `dmin` from every player when given), tried at 24 angles.
pub fn free_spot(sim: &mut Sim, nav: &Nav, around: Vec3, dmin: f32, dmax: f32, players: Option<&[Vec3]>) -> Option<Vec3> {
    let start = sim.rng.range(0.0, std::f32::consts::TAU);
    for k in 0..24 {
        let a = start + k as f32 * (std::f32::consts::TAU / 24.0) * 7.0;
        let r = sim.rng.range(dmin, dmax.max(dmin + 0.01));
        let p = h(around) + Vec2::new(a.cos(), a.sin()) * r;
        let ok_grid = match nav.grid.as_ref() {
            Some(g) => g.free_at(p),
            None => true,
        };
        let ok_players = players.is_none_or(|ps| ps.iter().all(|q| h(*q).distance(p) >= dmin * 0.9));
        if ok_grid && ok_players {
            return Some(Vec3::new(p.x, 0.05, p.y));
        }
    }
    None
}

/// Raise `count` enemies of `row` near `center` (a boss's summons): the mounds 2-10 m from it first, else free cells
/// 3-5 m round it.
pub fn raise_near(sim: &mut Sim, row: u16, count: u32, center: Vec3, wave: Option<u16>) {
    // as the lap makes them (never elites: a boss's summons are its own)
    let lap = sim.res.get::<Director>().map(|d| d.lap).unwrap_or(0);
    let ix = sim.res.get_mut::<Roster>().map(|r| r.variant(row, lap, crate::elite::Mod::None, false)).unwrap_or(row);
    let def = sim.res.get::<Roster>().map(|r| r.by_index(ix).into_owned()).unwrap_or_else(|| crate::defs::Def::base(Arch::Chaser));
    let mut mounds: Vec<Vec3> = sim.res.get::<Director>().map(|d| d.mounds.clone()).unwrap_or_default();
    mounds.retain(|m| (2.0..=10.0).contains(&h(*m).distance(h(center))));
    let nav = sim.res.take::<Nav>();
    for k in 0..count {
        let at = match mounds.get(k as usize) {
            Some(m) => *m,
            None => free_spot(sim, &nav, center, 3.0, 5.0, None).unwrap_or(center + Vec3::new(k as f32 - 1.0, 0.0, 2.0)),
        };
        let yaw = face_players(sim, at);
        let e = enemy::spawn(sim, &def, row, at, yaw, true, wave);
        if let Ok(mut en) = sim.world.get::<&mut Enemy>(e) {
            en.def = ix;
        }
        if wave.is_some()
            && let Some(d) = sim.res.get_mut::<Director>() {
                d.spawned += 1;
                d.total += 1;
            }
    }
    sim.res.insert(nav);
}
