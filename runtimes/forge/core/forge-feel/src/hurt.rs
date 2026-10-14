//! The player taking damage and dying (`feel.hurt`, Events stage; feel target 10, moments 14, 15 and 19).
//!
//! - **Each hit** adds `hurt.tint` to a red, edge-weighted tint (capped at 1) that fades at `hurt.fade` a second
//!   (0.6 → 0 in 400 ms), starts `hurt.shakeTime` of camera jitter (about ±1.6 cm at 10-15 Hz: `feel.camera`), and plays
//!   the thud (`player.sounds.hurt`) on the hit's own step. The DOM side (gf/forge/feel.js) draws the tint.
//! - **Low health:** stages at `feel.lowHealth` stage1/2/3 of the health (15%, 10%, 5%), each entered with its sound;
//!   the view carries the stage and feel.js darkens the edges more at each.
//! - **Down or out** (wave 2, `revive.rs`): with a friend standing a player at zero health is down and can be brought
//!   back; the sting and `player-dead` below are sent either way, on the step the health reaches zero.
//! - **Death:** on the fatal step the sting (`player.sounds.death`) and a rule event for rules.js, `player-dead`
//!   (entity: the player's id; a: the attacker's net id; b: the final blow's damage; c: the health before it; d: the
//!   armour it took). The last `feel.death.recap` seconds of hits stay readable (`recap_json`) so the shared results can
//!   explain the death; rules.js ends the round (a hard cut: the boot's results follow on the next frame).
use std::collections::VecDeque;

use forge_core::cmd;
use forge_core::components::*;
use forge_core::events::Event;
use forge_core::glam::Vec3;
use forge_core::hecs::Entity;
use forge_core::serde_json::{self, json, Value};
use forge_core::sim::Sim;
use forge_core::STEP;

use crate::controller::{ensure_pilots, Pilot};

/// One hit a player took.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Taken {
    pub t: f64,
    pub by: u32,
    pub kind: u8,
    pub type_: u16,
    pub damage: f32,
    pub hp_before: f32,
    pub hp_after: f32,
    pub armor: f32,
    pub part: u8,
}

/// A player's hits taken (the recap) and the health it last saw.
#[derive(Clone, Debug, Default)]
pub struct HitLog {
    pub list: VecDeque<Taken>,
    pub last: Option<(f32, f32)>,
    pub died: Option<Taken>,
    pub died_at: f64,
}

pub fn feel_hurt(sim: &mut Sim) {
    ensure_pilots(sim);
    let cfg = crate::cfg(sim);
    let h = &cfg.moves.hurt;
    let now = sim.time.now;
    let missing: Vec<Entity> = sim.world.query::<(Entity, &Player)>().without::<&HitLog>().iter().map(|(e, _)| e).collect();
    for e in missing {
        let _ = sim.world.insert_one(e, HitLog::default());
    }
    let hits: Vec<forge_core::events::Hit> = sim.events.step_events().filter_map(|e| if let Event::Hit(x) = e { Some(*x) } else { None }).collect();
    let kind_of = |sim: &Sim, net: u32| sim.entity_of(net).and_then(|a| sim.world.get::<&Kind>(a).ok().map(|k| (k.kind, k.type_))).unwrap_or((0, 0));
    let attackers: Vec<(u8, u16)> = hits.iter().map(|x| kind_of(sim, x.attacker)).collect();
    let mut sounds: Vec<(String, Vec3, u32)> = Vec::new();
    let mut stage_sounds: Vec<(Vec3, u32)> = Vec::new();
    let mut deaths: Vec<(u32, Taken, Vec3)> = Vec::new();
    // (a viewer's copy, wave 4: every player there is the host's replica and it predicts nothing, so their thuds and
    // stings are the host's events, which it plays; made here as well they sounded twice. A joiner's are as they were)
    let watching = sim.res.get::<forge_core::net::NetState>().is_some_and(|n| n.is_viewer());
    for (p, net, pilot, log, hp, tr) in sim.world.query_mut::<(&Player, &NetId, &mut Pilot, &mut HitLog, &Health, &Transform)>() {
        pilot.tint = (pilot.tint - h.fade * STEP).max(0.0);
        // what this step took, by the hits it names, or by the health it lost (damage from a command comes before any
        // step's events)
        let (mut hp0, mut ar0) = log.last.unwrap_or((hp.hp, hp.armor));
        let mut taken: Vec<Taken> = Vec::new();
        for (x, (kind, type_)) in hits.iter().zip(attackers.iter()).filter(|(x, _)| x.target == net.0) {
            let soak = ar0.min(x.damage);
            let hp1 = (hp0 - (x.damage - soak)).max(0.0);
            taken.push(Taken { t: now, by: x.attacker, kind: *kind, type_: *type_, damage: x.damage, hp_before: hp0, hp_after: hp1, armor: soak, part: x.part });
            hp0 = hp1;
            ar0 -= soak;
        }
        let (lost_hp, lost_ar) = (hp0 - hp.hp, ar0 - hp.armor);
        if lost_hp + lost_ar > 1e-4 {
            taken.push(Taken { t: now, by: hp.last_hit_by, kind: 0, type_: 0, damage: lost_hp + lost_ar, hp_before: hp0, hp_after: hp.hp, armor: lost_ar.max(0.0), part: 0 });
        }
        if !taken.is_empty() {
            pilot.tint = (pilot.tint + h.tint * taken.len() as f32).min(1.0);
            pilot.shake_left = h.shake_time;
            sounds.push((cfg.moves.sound_hurt.clone(), tr.pos, p.id));
        }
        log.list.extend(taken.iter().copied());
        if hp.dead && log.died.is_none() {
            let last = taken.last().copied().unwrap_or(Taken { t: now, by: hp.last_hit_by, kind: 0, type_: 0, damage: 0.0, hp_before: 0.0, hp_after: 0.0, armor: 0.0, part: 0 });
            log.died = Some(last);
            log.died_at = now;
            pilot.dead = true;
            deaths.push((p.id, last, tr.pos));
        } else if !hp.dead && log.died.is_some() {
            // back up (a respawn)
            log.died = None;
            pilot.dead = false;
        }
        let stage = if hp.dead { 0 } else { cfg.feel.stage(hp.fraction()) };
        if stage > pilot.stage && stage > 0 {
            stage_sounds.push((tr.pos, p.id));
        }
        pilot.stage = stage;
        log.last = Some((hp.hp, hp.armor));
        while log.list.front().is_some_and(|t| now - t.t > cfg.feel.recap as f64) {
            log.list.pop_front();
        }
    }
    if watching {
        return;
    }
    for (name, pos, id) in sounds {
        sim.sound(&name, pos, 0.0, id);
    }
    for (pos, id) in stage_sounds {
        sim.sound(&cfg.feel.sound_low, pos, 0.0, id);
    }
    for (id, t, pos) in deaths {
        sim.sound(&cfg.moves.sound_death, pos, 0.0, id);
        sim.rule("player-dead", id, t.by as f32, t.damage, t.hp_before, t.armor);
    }
}

/// The recap of a player's death (or of the last seconds, alive), as JSON: {player, dead, final: {...} | null, hits:
/// [{ago (s before the end), by, kind, type, damage, hpBefore, hpAfter, armor, part}], seconds, bestCombo}.
pub fn recap_json(sim: &Sim, id: u32) -> String {
    let Some(e) = sim.players.get(&id).copied() else { return "null".into() };
    let Ok(log) = sim.world.get::<&HitLog>(e) else { return "null".into() };
    let best = sim.world.get::<&Pilot>(e).map(|p| p.best_combo).unwrap_or(0);
    let end = if log.died.is_some() { log.died_at } else { sim.time.now };
    let cfg = crate::cfg(sim);
    let one = |t: &Taken| json!({ "ago": ((end - t.t) * 1000.0).round() / 1000.0, "by": t.by, "kind": t.kind, "type": t.type_, "damage": r2(t.damage), "hpBefore": r2(t.hp_before), "hpAfter": r2(t.hp_after), "armor": r2(t.armor), "part": Part::from_u8(t.part).name() });
    let hits: Vec<Value> = log.list.iter().filter(|t| end - t.t <= cfg.feel.recap as f64 + 1e-6).map(one).collect();
    serde_json::to_string(&json!({ "player": id, "dead": log.died.is_some(), "final": log.died.as_ref().map(one), "hits": hits, "seconds": cfg.feel.recap, "bestCombo": best })).unwrap_or_else(|_| "null".into())
}

fn r2(v: f32) -> f32 {
    (v * 100.0).round() / 100.0
}

/// op::RESET: a player starts over: health and armour from the table, the tint, stages, combo, recap and the dead flag
/// cleared, every weapon refilled.
pub fn cmd_reset(sim: &mut Sim, r: &cmd::Record) {
    ensure_pilots(sim);
    let Some(&e) = sim.players.get(&r.u(0)) else { return };
    // the coins and honed cards of the run before go (wave 7), the cards (wave 2), and the player's part in a reward
    // or a cart left open
    crate::shop::reset_player(sim, e, r.u(0));
    if sim.world.get::<&crate::cards::Build>(e).is_ok_and(|b| !b.cards.is_empty()) {
        crate::cards::set_cards(sim, e, Vec::new(), true);
    }
    if let Some(rw) = sim.res.get_mut::<crate::cards::Reward>() {
        rw.choices.remove(&r.u(0));
    }
    let t = sim.tables.player.clone();
    let stamina = crate::cfg(sim).moves.stamina.max;
    let _ = sim.world.insert_one(e, Health { armor: t.armor, ..Health::new(t.health) });
    let _ = sim.world.insert_one(e, HitLog::default());
    // wave 7: no rush, sure critical or cooldown carried into the new run
    let _ = sim.world.insert_one(e, crate::perks::Perks::default());
    if let Ok(mut p) = sim.world.get::<&mut Pilot>(e) {
        let assist = p.assist;
        *p = Pilot::new(stamina);
        p.assist = assist;
    }
    crate::weapons::cmd_refill(sim, r);
}
