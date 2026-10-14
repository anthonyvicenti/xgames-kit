//! Every hit's fan-out (`feel.hits`, Events stage: whoever dealt it, a weapon here or an enemy's attack in forge-ai):
//!
//! - **The body flash:** `ev::FLASH` for the hit body, `feel.hits.flash` seconds of `feel.hits.flashColor` (feel target
//!   7: flat white for 2-3 frames). The renderer draws it.
//! - **Damage numbers:** a UI event (`UI_DAMAGE`) at the hit point for the player who dealt it, with the crit flag (the
//!   DOM side, gf/forge/feel.js, draws crits larger and gold with a tag).
//! - **The combo:** each kill a player makes adds `combo.step` to their multiplier (×1.1, ×1.2, …, up to `combo.max`)
//!   and refills its timer (`combo.window`), which drains; at zero the combo ends. A UI event (`UI_COMBO`) on every change.
//! - **The flinch:** an animated body's hit bone gets a spring impulse away from the shot (forge-anim's per-bone springs).
//! - **The push:** a hit nudges a character back (`push`, applied before the character controller resolves the step).
//! - **No hit-stop:** the step never slows (the reference has none; the fixtures hold it).
//!
//! It also keeps the numbers verify and the fixtures read (`Stats`): every hit and every kill with the hits it took.
use forge_core::components::*;
use forge_core::events::{self, Event};
use forge_core::glam::{Quat, Vec3};
use forge_core::hecs::Entity;
use forge_core::physics::Mover;
use forge_core::sim::{Animated, Sim};
use forge_core::STEP;

use crate::controller::Pilot;
use crate::{ev, W};

/// The hits each body has taken, by net id (for hits per kill; the body itself may be gone by the Events stage: a kill
/// breaks it into debris before the rapier step).
#[derive(Clone, Debug, Default)]
pub struct HitCounts(pub std::collections::HashMap<u32, u32>);

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct HitRec {
    pub t: f64,
    pub by: u32,
    pub target: u32,
    pub damage: f32,
    pub crit: bool,
    pub part: u8,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct KillRec {
    pub t: f64,
    pub by: u32,
    pub target: u32,
    pub kind: u8,
    pub type_: u16,
    /// The hits it took, the killing one counted.
    pub hits: u32,
}

/// What verify's check 16 and the fixtures read: the last 256 hits and kills on the enemies' side.
#[derive(Clone, Debug, Default)]
pub struct Stats {
    pub hits: Vec<HitRec>,
    pub kills: Vec<KillRec>,
}

/// A push a hit gave a character: a velocity added to its travel for a short while, fading.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Push {
    pub vel: Vec3,
    pub left: f32,
    pub total: f32,
}

pub fn push(sim: &mut Sim, t: Entity, vel: Vec3, secs: f32) {
    if sim.world.get::<&Mover>(t).is_err() {
        return;
    }
    let next = match sim.world.get::<&Push>(t) {
        Ok(p) => Push { vel: p.vel * (p.left / p.total.max(1e-3)) + vel, left: secs, total: secs },
        Err(_) => Push { vel, left: secs, total: secs },
    };
    let _ = sim.world.insert_one(t, next);
}

/// Physics, before the character controller: each push moves its body a little more this step.
pub fn feel_push(sim: &mut Sim) {
    let mut done = Vec::new();
    for (e, p, m) in sim.world.query_mut::<(Entity, &mut Push, &mut Mover)>().without::<&Replica>() {
        let k = (p.left / p.total.max(1e-3)).clamp(0.0, 1.0);
        m.nudge += p.vel * k * STEP;
        p.left -= STEP;
        if p.left <= 0.0 {
            done.push(e);
        }
    }
    for e in done {
        let _ = sim.world.remove_one::<Push>(e);
    }
}

fn is_player(sim: &Sim, net: u32) -> bool {
    sim.entity_of(net).is_some_and(|e| sim.world.get::<&Player>(e).is_ok())
}

pub fn feel_hits(sim: &mut Sim) {
    let cfg = crate::cfg(sim);
    let f = &cfg.feel;
    // the combos drain
    let mut ended: Vec<(u32, Vec3)> = Vec::new();
    for (p, t, pilot) in sim.world.query_mut::<(&Player, &Transform, &mut Pilot)>() {
        if pilot.combo_left > 0.0 {
            pilot.combo_left -= STEP;
            if pilot.combo_left <= 0.0 {
                pilot.combo_left = 0.0;
                pilot.combo = 0;
                pilot.combo_mult = 1.0;
                ended.push((p.id, t.pos));
            }
        }
    }
    for (id, pos) in ended {
        sim.emit(Event::Ui(events::Ui { what: events::UI_COMBO, player: id, pos, value: 1.0, crit: false, count: 0, multiplier: 1.0, seconds: 0.0 }));
    }
    // this step's, and on a joiner the host's hits and kills that came with a snapshot since the last step (REMOTE,
    // `Events::early_events`): the same numbers, combo, flinch and stats there; the host's own rule events and sounds
    // come with the snapshot, so a remote kill emits none here
    let mut evs: Vec<(Event, bool)> = sim.events.early_events().filter(|(e, fl)| fl & events::FLAG_REMOTE != 0 && matches!(e, Event::Hit(_) | Event::Kill(_))).map(|(e, _)| (*e, true)).collect();
    evs.extend(sim.events.step_events().filter(|e| matches!(e, Event::Hit(_) | Event::Kill(_) | Event::Despawn(_))).map(|e| (*e, false)));
    let gone: Vec<forge_core::events::Despawn> = evs.iter().filter_map(|(e, _)| if let Event::Despawn(d) = e { Some(*d) } else { None }).collect();
    if evs.is_empty() {
        return;
    }
    let now = sim.time.now;
    for (e, remote) in evs {
        match e {
            Event::Hit(h) => {
                if is_player(sim, h.target) {
                    continue;
                }
                if f.flash > 0.0 && !remote {
                    crate::custom(sim, ev::FLASH, &[W::U(h.target), W::F(f.flash), W::F(f.flash_color[0]), W::F(f.flash_color[1]), W::F(f.flash_color[2])]);
                }
                let hits = {
                    let c = sim.res.entry::<HitCounts>().0.entry(h.target).or_insert(0);
                    *c += 1;
                    *c
                };
                if f.numbers && is_player(sim, h.attacker) {
                    sim.emit(Event::Ui(events::Ui { what: events::UI_DAMAGE, player: h.attacker, pos: h.point, value: h.damage, crit: h.crit, count: hits, multiplier: 0.0, seconds: 0.0 }));
                }
                if let Some(t) = sim.entity_of(h.target) {
                    flinch(sim, t, h.region, h.point - h.normal);
                }
                let st = sim.res.entry::<Stats>();
                st.hits.push(HitRec { t: now, by: h.attacker, target: h.target, damage: h.damage, crit: h.crit, part: h.part });
                if st.hits.len() > 256 {
                    st.hits.remove(0);
                }
            }
            Event::Kill(k) => {
                if is_player(sim, k.target) {
                    continue;
                }
                let t = sim.entity_of(k.target);
                let hits = sim.res.entry::<HitCounts>().0.remove(&k.target).unwrap_or(1).max(1);
                // the body may be broken already: its kind from its despawn
                let (kind, type_) = t.and_then(|t| sim.world.get::<&Kind>(t).ok().map(|k| (k.kind, k.type_))).or_else(|| gone.iter().find(|d| d.id == k.target).map(|d| (d.kind, d.type_))).unwrap_or((0, 0));
                let st = sim.res.entry::<Stats>();
                st.kills.push(KillRec { t: now, by: k.attacker, target: k.target, kind, type_, hits });
                if st.kills.len() > 256 {
                    st.kills.remove(0);
                }
                // the killer's combo
                let mut combo = None;
                if let Some(pe) = sim.entity_of(k.attacker)
                    && let Ok(mut p) = sim.world.get::<&mut Pilot>(pe) {
                        p.combo += 1;
                        p.combo_mult = (1.0 + f.combo_step * p.combo as f32).min(f.combo_max);
                        p.combo_left = f.combo_window;
                        p.best_combo = p.best_combo.max(p.combo);
                        combo = Some((p.combo, p.combo_mult));
                    }
                if let Some((n, mult)) = combo {
                    sim.emit(Event::Ui(events::Ui { what: events::UI_COMBO, player: k.attacker, pos: k.point, value: mult, crit: false, count: n, multiplier: mult, seconds: f.combo_window }));
                }
                if !remote {
                    sim.rule("kill", k.attacker, k.target as f32, type_ as f32, combo.map(|c| c.1).unwrap_or(1.0), hits as f32);
                }
            }
            Event::Despawn(d) => {
                sim.res.entry::<HitCounts>().0.remove(&d.id);
            }
            _ => {}
        }
    }
}

/// The hit bone of an animated body springs away from the blow (a flinch). A body whose owner plays its own reaction
/// (`components::Reacts`: forge-ai's enemies, on the copy that simulates them) is left to it.
fn flinch(sim: &mut Sim, t: Entity, region: u32, from: Vec3) {
    if sim.world.get::<&Reacts>(t).is_ok() {
        return;
    }
    let bone = match sim.world.get::<&Hurtbox>(t) {
        Ok(hb) => hb.regions.get(region as usize).map(|r| r.bone).filter(|&b| b != NO_BONE),
        Err(_) => None,
    };
    let Some(bone) = bone else { return };
    let (rot, pos) = match sim.world.get::<&Transform>(t) {
        Ok(tr) => (tr.rot, tr.pos),
        Err(_) => return,
    };
    let bones = sim.bones_of(t);
    let Some(m) = bones.get(bone as usize).copied() else { return };
    // the push's direction in the bone's own frame (close to its parent's for a flinch this small)
    let dir_world = (pos + Vec3::Y - from).normalize_or(Vec3::Z);
    let axis_world = Vec3::Y.cross(dir_world).normalize_or(Vec3::X);
    let (_, r, _) = m.to_scale_rotation_translation();
    let to_local: Quat = (rot * r).inverse();
    let axis = to_local * axis_world;
    if let Ok(mut a) = sim.world.get::<&mut Animated>(t) {
        a.animator.impulse(bone as usize, axis * 7.0, 20.0, 0.45);
    }
}
