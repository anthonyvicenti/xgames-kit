//! Weapons in hand (`feel.weapons`, `feel.shots`, `feel.pickups`): the weapons table's rows as each player holds them.
//!
//! - **Firing:** a trigger press (or held, for `auto`), once the cooldown, the raise and any reload are over. The
//!   cooldown carries its remainder, so a 0.108 s interval fires every 13th step and keeps 9.26 shots a second. Hitscan
//!   traces every pellet within the spread's cone (the core's seeded random stream: the same seed, the same pellets) and
//!   sums a shot's pellets per target into one hit; projectiles fly as swept rays at their speed (a pistol round lands
//!   about 120 ms after the shot on a target 10 m away); beams are hitscan every interval; charged shots fire on release
//!   with the share of the charge they held.
//! - **On the shot's own step:** the shot sound, the muzzle light (`muzzle`, about 1 m in front of the eyes), sparks at
//!   the barrel, a smoke puff `muzzle.smoke` later, the recoil spring's kick (pitch, and an alternating hair of yaw), the
//!   viewmodel's snap (`kick.view`), a FIRE cue, tracers.
//! - **Magazines:** a shot that empties the magazine starts the reload at once (the reference never dry-fires); R reloads
//!   by hand; switching cancels a reload; the reload sound plays as it starts.
//! - **Melee:** the quick melee (V) swings the table's first melee weapon (the built-in blade with none) over the gun; a
//!   melee weapon in hand swings on fire. The swing's whoosh at `melee.whoosh`, contact at `melee.contact` (moment 11:
//!   about 156 ms), hitting up to `melee.targets` enemies within `melee.reach` and the `melee.arc` ahead with a clear
//!   line; the camera stays still. Firing waits for the swing to recover.
//! - **Pickups:** a weapon lying in the world; walking over it gives it, draws it and refills it.
use forge_core::components::*;
use forge_core::events::{self, Event};
use forge_core::glam::{Vec2, Vec3};
use forge_core::hecs::Entity;
use forge_core::physics::{groups, QueryMask};
use forge_core::sim::{Sim, TraceHit};
use forge_core::{cmd, STEP};

use crate::controller::{eyes, forward};
use crate::recoil::Spring;
use crate::weapon_defs::{Kind, WeaponDef};
use crate::{cue, ev, W};

/// A swing in progress.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Swing {
    pub t: f32,
    /// The weapon swung (a row), or None: the built-in blade.
    pub row: Option<usize>,
    pub quick: bool,
    pub whooshed: bool,
    pub hit: bool,
}

/// A player's weapons (this crate's component on every player).
#[derive(Clone, Debug, Default)]
pub struct Arms {
    /// The rows held, in order; the one drawn.
    pub held: Vec<usize>,
    pub current: Option<usize>,
    /// Rounds in each row's magazine (by row).
    pub ammo: Vec<u32>,
    pub cooldown: f32,
    pub reload_left: f32,
    pub reload_total: f32,
    pub raise_left: f32,
    pub raise_total: f32,
    pub swing: Option<Swing>,
    /// Seconds the trigger of a charge weapon has been held (negative: not charging).
    pub charge: f32,
    pub recoil: Spring,
    pub recoil_yaw: Spring,
    /// The spring's shape (the weapon drawn, or the last that fired).
    pub shape: crate::recoil::Shape,
    pub shots: u32,
    /// The viewmodel's snap (a share of the screen height) and its speed.
    pub view_kick: f32,
    pub view_v: f32,
    /// Smoke puffs to come: seconds left, where, which way.
    pub smoke: Vec<(f32, Vec3, Vec3)>,
    pub version: u32,
    pub made: bool,
    /// Swings begun so far (wave 4: `watch::byte_of` tells a viewer of each new one).
    pub swings: u32,
}

impl Arms {
    pub fn current_def<'a>(&self, cfg: &'a crate::Config) -> Option<&'a WeaponDef> {
        self.current.and_then(|r| cfg.weapons.get(r))
    }
    pub fn ammo_of(&self, row: usize) -> u32 {
        self.ammo.get(row).copied().unwrap_or(0)
    }
}

/// The loadout a player starts with: every row marked `start`, by slot.
pub fn start_loadout(cfg: &crate::Config) -> Vec<usize> {
    let mut rows: Vec<usize> = (0..cfg.weapons.len()).filter(|&i| cfg.weapons[i].start).collect();
    rows.sort_by_key(|&i| (cfg.weapons[i].slot, i));
    rows
}

fn arm(a: &mut Arms, cfg: &crate::Config, rows: Vec<usize>) {
    a.ammo = cfg.weapons.iter().map(|w| w.magazine).collect();
    a.current = rows.iter().copied().find(|&r| cfg.weapons[r].kind != Kind::Melee).or_else(|| rows.first().copied());
    a.held = rows;
    a.reload_left = 0.0;
    a.raise_left = 0.0;
    a.cooldown = 0.0;
    a.charge = -1.0;
    a.swing = None;
    a.version = cfg.version;
    a.made = true;
    a.shape = a.current.and_then(|r| cfg.weapons.get(r)).map(|w| w.shape).unwrap_or_default();
}

/// After a tables load: every player's weapons follow the new table (rows that are gone are dropped; a player whose
/// table changed from nothing gets the start loadout).
pub fn rearm(sim: &mut Sim) {
    let cfg = crate::cfg(sim);
    for a in sim.world.query_mut::<&mut Arms>() {
        let n = cfg.weapons.len();
        let held: Vec<usize> = a.held.iter().copied().filter(|&r| r < n).collect();
        let current = a.current.filter(|&r| r < n);
        let ammo = a.ammo.clone();
        if held.is_empty() {
            arm(a, &cfg, start_loadout(&cfg));
        } else {
            arm(a, &cfg, held);
            if current.is_some() {
                a.current = current;
            }
            for (r, x) in ammo.into_iter().enumerate().take(n) {
                a.ammo[r] = x.min(cfg.weapons[r].magazine);
            }
        }
    }
}

/// Every player without weapons gets the start loadout (spawned since the last step).
pub fn ensure(sim: &mut Sim) {
    ensure_arms(sim);
}

fn ensure_arms(sim: &mut Sim) {
    let missing: Vec<Entity> = sim.world.query::<(Entity, &Player)>().without::<&Arms>().iter().map(|(e, _)| e).collect();
    if missing.is_empty() {
        return;
    }
    let cfg = crate::cfg(sim);
    for e in missing {
        let mut a = Arms::default();
        arm(&mut a, &cfg, start_loadout(&cfg));
        let _ = sim.world.insert_one(e, a);
    }
}

/// What a player's step decided, done after the query (it needs the whole sim).
enum Act {
    Fire { e: Entity, id: u32, row: usize, share: f32, eye: Vec3, dir: Vec3 },
    Contact { e: Entity, id: u32, row: Option<usize>, eye: Vec3, yaw: f32, pitch: f32 },
    Sound(String, Vec3, u32),
    Cue(u32, u32, u32, f32),
    Smoke(Vec3, Vec3),
}

pub fn feel_weapons(sim: &mut Sim) {
    ensure_arms(sim);
    let global = crate::cfg(sim);
    let eye_h = sim.tables.player.eye;
    let mut acts: Vec<Act> = Vec::new();
    for (e, p, c, tr, look, a, hp, wear, pilot, build, perks) in sim.world.query_mut::<(Entity, &Player, &Control, &Transform, &Look, &mut Arms, Option<&Health>, Option<&mut Wear>, Option<&crate::controller::Pilot>, Option<&crate::cards::Build>, Option<&crate::perks::Perks>)>().without::<&Replica>() {
        if !p.owned {
            continue;
        }
        // this player's own weapons: the table's rows with the cards they hold
        let cfg: &crate::Config = build.and_then(|b| b.cfg.as_deref()).unwrap_or(&global);
        let def_of = |row: Option<usize>| -> Option<&WeaponDef> { match row { Some(r) => cfg.weapons.get(r), None => cfg.blade.as_ref() } };
        if a.ammo.len() < cfg.weapons.len() {
            a.ammo.resize(cfg.weapons.len(), 0);
        }
        // what friends see in this player's hand (forge-core `Wear::held`, which snapshots carry): the weapon drawn,
        // as it was at the start of this step (a switch shows on the next)
        if let Some(w) = wear {
            w.held = a.current.map(|r| r.min(254) as u8).unwrap_or(HELD_NONE);
        }
        let eye = tr.pos + Vec3::Y * eye_h;
        let (aim_yaw, aim_pitch) = (look.yaw + a.recoil_yaw.x, look.pitch + a.recoil.x);
        let aim = forward(aim_yaw, aim_pitch);
        // the clocks run whatever the player does (wave 7: the trigger's faster while a rush lasts, perks.rs)
        a.cooldown -= STEP * crate::perks::haste(cfg, perks).1;
        a.raise_left = (a.raise_left - STEP).max(0.0);
        // the viewmodel's snap: a fast critically damped return (back by about 90 ms; moment 8)
        {
            let w = 55.0f32;
            let ex = (-w * STEP).exp();
            let b = a.view_v + w * a.view_kick;
            let k = (a.view_kick + b * STEP) * ex;
            a.view_v = (a.view_v - w * b * STEP) * ex;
            a.view_kick = if k.abs() < 1e-5 && a.view_v.abs() < 1e-4 { 0.0 } else { k };
        }
        for s in a.smoke.iter_mut() {
            s.0 -= STEP;
        }
        // on the step nearest its time
        for (_, at, dir) in a.smoke.iter().filter(|s| s.0 <= STEP * 0.5) {
            acts.push(Act::Smoke(*at, *dir));
        }
        a.smoke.retain(|s| s.0 > STEP * 0.5);
        if a.reload_left > 0.0 {
            a.reload_left -= STEP;
            if a.reload_left <= 1e-6 {
                a.reload_left = 0.0;
                if let Some(r) = a.current {
                    a.ammo[r] = cfg.weapons[r].magazine;
                    acts.push(Act::Cue(p.id, cue::RELOADED, r as u32, 0.0));
                }
            }
        }
        // the swing: its whoosh, its contact, its end
        if let Some(mut s) = a.swing {
            s.t += STEP;
            if let Some(d) = def_of(s.row) {
                if !s.whooshed && s.t + 1e-6 >= d.melee.whoosh {
                    s.whooshed = true;
                    acts.push(Act::Sound(d.sound_swing.clone(), eye, p.id));
                }
                if !s.hit && s.t + 1e-6 >= d.melee.contact {
                    s.hit = true;
                    acts.push(Act::Contact { e, id: p.id, row: s.row, eye, yaw: look.yaw, pitch: look.pitch });
                }
                a.swing = if s.t >= d.melee.contact + d.melee.recover { None } else { Some(s) };
            } else {
                a.swing = None;
            }
        }
        let alive = hp.is_none_or(|h| !h.dead);
        // dead, not in play, or knocked down (no control: forge-ai's slam): nothing fires, switches or swings
        if !alive || !c.enabled || pilot.is_some_and(|p| p.down > 0.0) {
            a.charge = -1.0;
            continue;
        }
        // switching: a slot key, or the next and previous
        let mut to: Option<usize> = None;
        for n in 1..=4u32 {
            if c.pressed(cmd::BTN_SLOT1 << (n - 1)) {
                let same: Vec<usize> = a.held.iter().copied().filter(|&r| cfg.weapons[r].slot == n).collect();
                if !same.is_empty() {
                    let at = a.current.and_then(|cur| same.iter().position(|&r| r == cur));
                    to = Some(same[at.map(|i| (i + 1) % same.len()).unwrap_or(0)]);
                }
            }
        }
        if (c.pressed(cmd::BTN_NEXT) || c.pressed(cmd::BTN_PREV)) && a.held.len() > 1 {
            let i = a.current.and_then(|cur| a.held.iter().position(|&r| r == cur)).unwrap_or(0) as i32;
            let n = a.held.len() as i32;
            let j = if c.pressed(cmd::BTN_NEXT) { (i + 1).rem_euclid(n) } else { (i - 1).rem_euclid(n) };
            to = Some(a.held[j as usize]);
        }
        if let Some(r) = to.filter(|&r| Some(r) != a.current) {
            a.current = Some(r);
            a.raise_total = cfg.weapons[r].raise;
            a.raise_left = a.raise_total;
            a.reload_left = 0.0;
            a.charge = -1.0;
            a.shape = cfg.weapons[r].shape;
            acts.push(Act::Sound(cfg.moves.sound_switch.clone(), eye, p.id));
            acts.push(Act::Cue(p.id, cue::SWITCH, r as u32, a.raise_total));
        }
        let def = a.current.and_then(|r| cfg.weapons.get(r));
        // a reload by hand
        if let (Some(r), Some(d)) = (a.current, def)
            && c.pressed(cmd::BTN_RELOAD) && d.magazine > 0 && a.ammo[r] < d.magazine && a.reload_left <= 0.0 && d.reload > 0.0 {
                a.reload_total = d.reload;
                a.reload_left = d.reload;
                acts.push(Act::Sound(d.sound_reload.clone(), eye, p.id));
                acts.push(Act::Cue(p.id, cue::RELOAD, r as u32, d.reload));
            }
        // the quick melee: a swing over the gun
        if c.pressed(cmd::BTN_MELEE) && a.swing.is_none() {
            a.swing = Some(Swing { t: 0.0, row: cfg.quick_melee, quick: true, whooshed: false, hit: false });
            a.swings = a.swings.wrapping_add(1);
            acts.push(Act::Cue(p.id, cue::SWING, cfg.quick_melee.map(|r| r as u32).unwrap_or(u32::MAX), 1.0));
        }
        let (Some(row), Some(d)) = (a.current, def) else { continue };
        let ready = a.cooldown <= 1e-6 && a.raise_left <= 0.0 && a.swing.is_none() && a.reload_left <= 0.0;
        let trigger = if d.auto { c.down(cmd::BTN_FIRE) } else { c.pressed(cmd::BTN_FIRE) };
        let mut fire_share: Option<f32> = None;
        match d.kind {
            Kind::Melee => {
                if trigger && ready {
                    a.swing = Some(Swing { t: 0.0, row: Some(row), quick: false, whooshed: false, hit: false });
                    a.swings = a.swings.wrapping_add(1);
                    a.cooldown = a.cooldown.max(-STEP) + d.interval;
                    acts.push(Act::Cue(p.id, cue::SWING, row as u32, 0.0));
                }
            }
            Kind::Charge => {
                if c.down(cmd::BTN_FIRE) && ready {
                    a.charge = if a.charge < 0.0 { 0.0 } else { (a.charge + STEP).min(d.interval) };
                } else if a.charge >= 0.0 {
                    fire_share = Some((a.charge / d.interval.max(1e-3)).clamp(0.25, 1.0));
                    a.charge = -1.0;
                }
            }
            _ => {
                if trigger && ready {
                    fire_share = Some(1.0);
                }
            }
        }
        if let Some(share) = fire_share {
            if d.magazine > 0 && a.ammo[row] == 0 {
                // empty: the reload (no dry fire, as the reference)
                if a.reload_left <= 0.0 && d.reload > 0.0 {
                    a.reload_total = d.reload;
                    a.reload_left = d.reload;
                    acts.push(Act::Sound(d.sound_reload.clone(), eye, p.id));
                    acts.push(Act::Cue(p.id, cue::RELOAD, row as u32, d.reload));
                } else if !d.sound_empty.is_empty() {
                    acts.push(Act::Sound(d.sound_empty.clone(), eye, p.id));
                    acts.push(Act::Cue(p.id, cue::EMPTY, row as u32, 0.0));
                }
                continue;
            }
            if d.magazine > 0 {
                a.ammo[row] -= 1;
            }
            a.cooldown = a.cooldown.max(-STEP) + d.interval;
            a.shots += 1;
            acts.push(Act::Fire { e, id: p.id, row, share, eye, dir: aim });
            // the kick: the spring, a hair of yaw (alternating), the viewmodel's snap
            a.shape = d.shape;
            a.recoil.kick(d.kick_impulse * share.max(0.25), d.shape);
            if d.kick_yaw > 0.0 {
                let sign = if a.shots % 2 == 0 { 1.0 } else { -1.0 };
                a.recoil_yaw.kick(sign * d.kick_yaw / crate::recoil::gain(d.shape).max(1e-4), d.shape);
            }
            a.view_v += d.view_kick * 55.0 * std::f32::consts::E;
            if d.smoke > 0.0 {
                a.smoke.push((d.smoke, eye + aim * 0.9, aim));
            }
            acts.push(Act::Cue(p.id, cue::FIRE, row as u32, share));
            // the shot that empties the magazine starts the reload at once
            if d.magazine > 0 && a.ammo[row] == 0 && d.reload > 0.0 {
                a.reload_total = d.reload;
                a.reload_left = d.reload;
                acts.push(Act::Sound(d.sound_reload.clone(), eye, p.id));
                acts.push(Act::Cue(p.id, cue::RELOAD, row as u32, d.reload));
            }
        }
        let _ = (aim_yaw, aim_pitch);
    }
    // the recoil springs step after this step's kicks, so a shot's kick shows on its own step (it peaks on frame 2)
    for a in sim.world.query_mut::<&mut Arms>() {
        a.recoil.step(a.shape.omega, STEP);
        a.recoil_yaw.step(a.shape.omega, STEP);
    }
    for act in acts {
        match act {
            Act::Fire { e, id, row, share, eye, dir } => {
                let cfg = crate::cards::of(sim, e);
                if row < cfg.weapons.len() {
                    fire(sim, &cfg, e, id, row, share, eye, dir);
                }
            }
            Act::Contact { e, id, row, eye, yaw, pitch } => {
                let cfg = crate::cards::of(sim, e);
                let d = match row { Some(r) => cfg.weapons.get(r).cloned(), None => cfg.blade.clone() };
                if let Some(d) = d {
                    contact(sim, e, id, &d, eye, yaw, pitch);
                }
            }
            Act::Sound(name, at, id) => sim.sound(&name, at, 0.0, id),
            Act::Cue(id, what, row, x) => crate::custom(sim, ev::WEAPON, &[W::U(id), W::U(what), W::U(row), W::F(x)]),
            Act::Smoke(at, dir) => particles(sim, "smoke", 3, at, dir, 0.6, 0.5),
        }
    }
}

/// A PARTICLES event by name.
pub fn particles(sim: &mut Sim, name: &str, count: u32, pos: Vec3, dir: Vec3, speed: f32, spread: f32) {
    if count == 0 {
        return;
    }
    let n = sim.names.id(name);
    sim.emit(Event::Particles(events::Particles { name: n, count, pos, dir, speed, spread }));
}

/// A LIGHT event.
pub fn light(sim: &mut Sim, source: u32, pos: Vec3, l: &crate::weapon_defs::Light, scale: f32) {
    if l.intensity <= 0.0 || l.radius <= 0.0 {
        return;
    }
    sim.emit(Event::Light(events::Light { source, pos, color: l.color, radius: l.radius, intensity: l.intensity * scale, frames: l.frames }));
}

/// Where the shots of a player's weapon leave from: about 1 m in front of the eyes, a little right and down.
pub fn muzzle(eye: Vec3, dir: Vec3) -> Vec3 {
    let right = dir.cross(Vec3::Y).normalize_or(Vec3::X);
    let up = right.cross(dir).normalize_or(Vec3::Y);
    eye + dir * 1.0 + right * 0.12 - up * 0.08
}

/// What a trace may hit: the world and the enemies' side (players do not shoot each other).
pub const SHOT_HITS: u32 = groups::WORLD | groups::ENEMY;

/// A hit's damage multiplier: the feel table's for the part (or the weapon's crit), times the region's own when that is
/// under 1: a region that lets only a share through is armour (forge-ai's shield is a hurt region whose multiplier is
/// its `shield.block`), whatever part it names. Regions at 1 or more are the table's to scale (a head's crit).
pub fn region_mult(cfg: &crate::Config, d: &WeaponDef, h: &TraceHit) -> f32 {
    cfg.feel.region(h.part, h.crit, d.crit) * if h.damage > 0.0 && h.damage < 1.0 { h.damage } else { 1.0 }
}

fn fire(sim: &mut Sim, cfg: &crate::Config, e: Entity, id: u32, row: usize, share: f32, eye: Vec3, aim: Vec3) {
    let d = &cfg.weapons[row];
    // wave 7 (perks.rs, ambush): the shot after an evade is a sure critical, wherever it lands
    let sure = d.kind != Kind::Melee && crate::perks::take_primed(sim, e);
    let crit = |h: TraceHit| if sure { TraceHit { crit: true, ..h } } else { h };
    let dir = crate::aim::assist(sim, e, eye, aim, d.range);
    let mz = muzzle(eye, dir);
    sim.sound(&d.sound_fire, mz, 0.0, id);
    light(sim, id, mz, &d.muzzle, 1.0);
    particles(sim, "sparks", d.sparks, mz, dir, 3.5, 0.5);
    match d.kind {
        Kind::Hitscan | Kind::Beam => {
            let mut per: Vec<(Entity, TraceHit, f32, u32)> = Vec::new();
            let mut world: Option<TraceHit> = None;
            for _ in 0..d.pellets.max(1) {
                let dd = if d.spread > 0.0 { sim.rng.cone(dir, d.spread * 0.5) } else { dir };
                let hit = sim.trace(eye, dd, d.range, SHOT_HITS, Some(e));
                let end = hit.map(|h| h.point).unwrap_or(eye + dd * d.range);
                crate::custom(sim, ev::TRACER, &[W::F(mz.x), W::F(mz.y), W::F(mz.z), W::F(end.x), W::F(end.y), W::F(end.z), W::F(d.tracer[0]), W::F(d.tracer[1]), W::F(d.tracer[2]), W::F(if d.kind == Kind::Beam { d.interval * 1.5 } else { 0.05 }), W::F(if d.pellets > 1 { 0.012 } else { 0.02 }), W::U(id)]);
                match hit.map(crit) {
                    Some(h) if h.entity.is_some_and(|t| sim.world.get::<&Health>(t).is_ok()) => {
                        let t = h.entity.unwrap();
                        let dmg = d.damage * share * region_mult(cfg, d, &h);
                        match per.iter_mut().find(|x| x.0 == t) {
                            Some(x) => {
                                x.2 += dmg;
                                x.3 += 1;
                                if h.crit && !x.1.crit {
                                    x.1 = h;
                                }
                            }
                            None => per.push((t, h, dmg, 1)),
                        }
                    }
                    Some(h) => {
                        world.get_or_insert(h);
                    }
                    None => {}
                }
            }
            for (t, h, dmg, _) in per {
                strike(sim, d, id, t, &h, dmg, dir);
            }
            if let Some(h) = world {
                particles(sim, "sparks", 5, h.point, h.normal, 3.0, 0.8);
                particles(sim, "dust", 2, h.point, h.normal, 0.8, 0.6);
            }
        }
        Kind::Projectile | Kind::Charge => {
            // point blank: anything between the eyes and the muzzle is hit now
            let start = mz - eye;
            if let Some(h) = sim.trace(eye, dir, start.length(), SHOT_HITS, Some(e)).map(crit) {
                if let Some(t) = h.entity.filter(|t| sim.world.get::<&Health>(*t).is_ok()) {
                    let mult = region_mult(cfg, d, &h);
                    strike(sim, d, id, t, &h, d.damage * share * mult, dir);
                } else {
                    particles(sim, "sparks", 5, h.point, h.normal, 3.0, 0.8);
                }
                return;
            }
            // the round leaves the muzzle for the point under the crosshair (the eyes' ray), not parallel to it
            let goal = sim.trace(eye, dir, d.range, SHOT_HITS, Some(e)).map(|h| h.point).unwrap_or(eye + dir * d.range);
            let pdir = (goal - mz).normalize_or(dir);
            // each copy's own (never in a snapshot): a round crosses a room in about 0.1 s, and friends see the shot's
            // light and its impact, which the events carry
            let shot = sim.spawn_local(kind::PROJECTILE, row as u16, mz, 0.0);
            let _ = sim.world.insert(shot, (Shot { row, owner: id, owner_e: e, damage: d.damage * share, left: d.range, radius: d.radius, crit: sure }, Team::PLAYERS));
            if let Ok(mut v) = sim.world.get::<&mut Velocity>(shot) {
                v.linear = pdir * d.speed;
            }
        }
        Kind::Melee => {}
    }
}

/// A hit lands on a target with health: the damage (the core's: armour, HIT, KILL), the impact light and sound at the
/// point, sparks, a push.
pub fn strike(sim: &mut Sim, d: &WeaponDef, attacker: u32, t: Entity, h: &TraceHit, dmg: f32, dir: Vec3) {
    // wave 7 (perks.rs): fury's more as the attacker's health drops; a shot that lands explodes with blast
    let dmg = crate::perks::outgoing(sim, attacker, dmg);
    let dealt = sim.damage(t, dmg, attacker, Some(h), dir);
    if d.kind != Kind::Melee {
        crate::perks::blast(sim, attacker, t, h.point, dealt.damage);
    }
    if dealt.damage <= 0.0 {
        // a joiner's own shot on the host's enemy (a replica: only the host deals damage, and its HIT comes back with
        // the next snapshot): the impact's light, sound and sparks are drawn now, as the prediction; the host's copies
        // of them are then not played twice (forge-core net.rs: sounds and lights by their source, sparks by place)
        let predicted = sim.world.get::<&Replica>(t).is_ok() && sim.world.get::<&Health>(t).is_ok_and(|x| !x.dead);
        if !predicted {
            return;
        }
    }
    light(sim, attacker, h.point + h.normal * 0.15, &d.impact, 1.0);
    sim.sound(&d.sound_impact, h.point, 0.0, attacker);
    particles(sim, "sparks", 4, h.point, h.normal, 2.5, 0.9);
    if d.knockback > 0.0 && dealt.damage > 0.0 && !dealt.killed {
        crate::hits::push(sim, t, Vec3::new(dir.x, 0.0, dir.z).normalize_or_zero() * d.knockback, 0.12);
    }
}

/// A projectile in flight.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Shot {
    pub row: usize,
    pub owner: u32,
    pub owner_e: Entity,
    pub damage: f32,
    /// Metres it may still fly.
    pub left: f32,
    pub radius: f32,
    /// Wave 7: a sure critical (perks.rs, ambush), wherever it lands.
    pub crit: bool,
}

/// Projectiles fly as swept rays: the first hurt region, body or wall along this step's travel.
pub fn feel_shots(sim: &mut Sim) {
    let cfg = crate::cfg(sim);
    let list: Vec<(Entity, Vec3, Vec3, Shot)> = sim.world.query::<(Entity, &Transform, &Velocity, &Shot)>().without::<&Replica>().iter().map(|(e, t, v, s)| (e, t.pos, v.linear, *s)).collect();
    for (e, pos, vel, mut s) in list {
        let step = vel * STEP;
        let len = step.length();
        let dir = step.normalize_or(Vec3::NEG_Z);
        let hit = sim.trace(pos, dir, len + s.radius, SHOT_HITS, Some(s.owner_e));
        match hit {
            Some(h) => {
                // the weapon as its owner holds it (their cards)
                let d = if sim.world.contains(s.owner_e) { crate::cards::of(sim, s.owner_e).weapons.get(s.row).cloned() } else { cfg.weapons.get(s.row).cloned() };
                let h = if s.crit { TraceHit { crit: true, ..h } } else { h };
                match (h.entity.filter(|t| sim.world.get::<&Health>(*t).is_ok()), d) {
                    (Some(t), Some(d)) => {
                        let mult = region_mult(&cfg, &d, &h);
                        strike(sim, &d, s.owner, t, &h, s.damage * mult, dir);
                    }
                    _ => {
                        particles(sim, "sparks", 5, h.point, h.normal, 3.0, 0.8);
                        particles(sim, "dust", 2, h.point, h.normal, 0.8, 0.6);
                    }
                }
                sim.despawn(e);
            }
            None => {
                s.left -= len;
                if let Ok(mut t) = sim.world.get::<&mut Transform>(e) {
                    t.pos = pos + step;
                }
                if s.left <= 0.0 {
                    sim.despawn(e);
                } else if let Ok(mut x) = sim.world.get::<&mut Shot>(e) {
                    *x = s;
                }
            }
        }
    }
}

/// The melee contact: up to `targets` enemies within reach and the arc ahead, each on its nearest region to the aim, a
/// clear line from the eyes; their damage, an impact sound and light, a push. The camera does not move.
fn contact(sim: &mut Sim, e: Entity, id: u32, d: &WeaponDef, eye: Vec3, yaw: f32, pitch: f32) {
    let fwd = forward(yaw, pitch);
    let flat = Vec2::new(fwd.x, fwd.z).normalize_or(Vec2::NEG_Y);
    let half = d.melee.arc * 0.5;
    let mut found: Vec<(f32, Entity, TraceHit)> = Vec::new();
    for (t, hb, hp) in sim.world.query::<(Entity, &Hurtbox, &Health)>().iter() {
        if t == e || hp.dead || hb.group & groups::ENEMY == 0 {
            continue;
        }
        let mut best: Option<(f32, f32, TraceHit)> = None;
        for (i, (r, (a, b))) in hb.regions.iter().zip(hb.world.iter()).enumerate() {
            if r.radius <= 0.0 {
                continue;
            }
            let p = closest_on_segment(*a, *b, eye);
            let to = p - eye;
            let dist = (to.length() - r.radius).max(0.0);
            if dist > d.melee.reach {
                continue;
            }
            let fl = Vec2::new(to.x, to.z);
            let ang = if fl.length() < 0.05 { 0.0 } else { flat.angle_to(fl.normalize()).abs() };
            if ang > half {
                continue;
            }
            let aim_off = fwd.angle_between(to.normalize_or(fwd));
            let n = (eye - p).normalize_or(-fwd);
            let hit = TraceHit { entity: Some(t), net: 0, dist, point: p + n * r.radius, normal: n, part: r.part, region: i as u32, damage: r.damage, crit: r.crit };
            if best.as_ref().is_none_or(|x| aim_off < x.1) {
                best = Some((dist, aim_off, hit));
            }
        }
        if let Some((dist, _, hit)) = best {
            found.push((dist, t, hit));
        }
    }
    found.sort_by(|a, b| a.0.total_cmp(&b.0));
    let mut n = 0;
    for (_, t, mut hit) in found {
        if n >= d.melee.targets {
            break;
        }
        // a clear line: no wall between the eyes and the point
        let to = hit.point - eye;
        if let Some(w) = sim.physics.cast_ray(eye, to, to.length() * 0.98, QueryMask::new(groups::WORLD))
            && w.entity.is_none() {
                continue;
            }
        hit.net = sim.net_of(t);
        let dmg = d.damage * region_mult(&crate::cfg(sim), d, &hit);
        strike(sim, d, id, t, &hit, dmg, to.normalize_or(fwd));
        n += 1;
    }
    crate::custom(sim, ev::WEAPON, &[W::U(id), W::U(cue::CONTACT), W::U(n), W::F(d.melee.reach)]);
}

pub fn closest_on_segment(a: Vec3, b: Vec3, p: Vec3) -> Vec3 {
    let ab = b - a;
    let l2 = ab.length_squared();
    if l2 < 1e-12 {
        return a;
    }
    a + ab * ((p - a).dot(ab) / l2).clamp(0.0, 1.0)
}

/// A weapon pickup that comes back: (row, where, seconds before it is back (0: once), its entity now, seconds left).
#[derive(Clone, Debug, Default)]
pub struct Pickups {
    pub list: Vec<(usize, Vec3, f32, Option<Entity>, f32)>,
}

/// A weapon lying in the world (its entity: kind PICKUP, type = the weapon row).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Pickup {
    pub row: usize,
}

pub fn feel_pickups(sim: &mut Sim) {
    let Some(mut ps) = sim.res.remove::<Pickups>() else { return };
    let cfg = crate::cfg(sim);
    let players: Vec<(Entity, u32, Vec3)> = sim.world.query::<(Entity, &Player, &Transform, Option<&Health>)>().without::<&Replica>().iter().filter(|(_, p, _, h)| p.owned && h.is_none_or(|h| !h.dead)).map(|(e, p, t, _)| (e, p.id, t.pos)).collect();
    for (row, at, every, ent, left) in ps.list.iter_mut() {
        if ent.is_none() {
            *left -= STEP;
            if *left <= 0.0 && *row < cfg.weapons.len() {
                let x = sim.spawn_actor(kind::PICKUP, *row as u16, *at, 0.0);
                let _ = sim.world.insert_one(x, Pickup { row: *row });
                *ent = Some(x);
            }
            continue;
        }
        let Some((pe, pid, _)) = players.iter().find(|(_, _, p)| Vec2::new(p.x - at.x, p.z - at.z).length() < 1.1 && (p.y - at.y).abs() < 2.0) else { continue };
        let own = crate::cards::of(sim, *pe);
        give(sim, *pe, *row, true, &own);
        if let Some(r) = *ent {
            sim.despawn(r);
        }
        *ent = None;
        *left = if *every > 0.0 { *every } else { f32::INFINITY };
        sim.rule("pickup", *pid, *row as f32, 0.0, 0.0, 0.0);
        let name = cfg.moves.sound_switch.clone();
        sim.sound(&name, *at, 0.0, *pid);
    }
    sim.res.insert(ps);
}

/// Give a player a weapon (refilled), and draw it.
pub fn give(sim: &mut Sim, e: Entity, row: usize, equip: bool, cfg: &crate::Config) {
    if row >= cfg.weapons.len() {
        return;
    }
    let Ok(mut a) = sim.world.get::<&mut Arms>(e) else { return };
    if !a.held.contains(&row) {
        a.held.push(row);
    }
    if a.ammo.len() < cfg.weapons.len() {
        a.ammo.resize(cfg.weapons.len(), 0);
    }
    a.ammo[row] = cfg.weapons[row].magazine;
    if equip && a.current != Some(row) {
        a.current = Some(row);
        a.reload_left = 0.0;
        a.raise_total = cfg.weapons[row].raise;
        a.raise_left = a.raise_total;
        a.shape = cfg.weapons[row].shape;
    }
}

fn player_entity(sim: &Sim, id: u32) -> Option<Entity> {
    sim.players.get(&id).copied()
}

pub fn cmd_loadout(sim: &mut Sim, r: &cmd::Record) {
    ensure_arms(sim);
    let Some(e) = player_entity(sim, r.u(0)) else { return };
    let cfg = crate::cards::of(sim, e);
    let rows: Vec<usize> = (1..r.len()).map(|i| r.u(i) as usize).filter(|&x| x < cfg.weapons.len()).collect();
    if let Ok(mut a) = sim.world.get::<&mut Arms>(e) {
        arm(&mut a, &cfg, rows);
    }
}

pub fn cmd_give(sim: &mut Sim, r: &cmd::Record) {
    ensure_arms(sim);
    if let Some(e) = player_entity(sim, r.u(0)) {
        let cfg = crate::cards::of(sim, e);
        give(sim, e, r.u(1) as usize, r.u(2) != 0, &cfg);
    }
}

pub fn cmd_equip(sim: &mut Sim, r: &cmd::Record) {
    ensure_arms(sim);
    let Some(e) = player_entity(sim, r.u(0)) else { return };
    let cfg = crate::cards::of(sim, e);
    let row = r.u(1) as usize;
    if let Ok(a) = sim.world.get::<&Arms>(e)
        && !a.held.contains(&row) {
            return;
        }
    give(sim, e, row, true, &cfg);
}

pub fn cmd_refill(sim: &mut Sim, r: &cmd::Record) {
    let Some(e) = player_entity(sim, r.u(0)) else { return };
    let cfg = crate::cards::of(sim, e);
    if let Ok(mut a) = sim.world.get::<&mut Arms>(e) {
        a.ammo = cfg.weapons.iter().map(|w| w.magazine).collect();
        a.reload_left = 0.0;
    }
}

pub fn cmd_pickup(sim: &mut Sim, r: &cmd::Record) {
    let row = r.u(0) as usize;
    let at = Vec3::new(r.f(1), r.f(2), r.f(3));
    let every = r.f(4).max(0.0);
    sim.res.entry::<Pickups>().list.push((row, at, every, None, 0.0));
}

/// The eyes and aim of a player (for other crates and the fixtures).
pub fn aim_of(sim: &Sim, e: Entity) -> Option<(Vec3, Vec3)> {
    eyes(sim, e).map(|(p, d, _, _)| (p, d))
}
