//! Down and revive (wave 2, the game loop; `spec.forge.player.revive`).
//!
//! With a friend still standing, a player at zero health is **down**, not out: nothing fires (the weapons already
//! stop for the dead), the look turns slowly (`revive.look`, forge-core `LookScale`), the eyes sink to the ground
//! (`controller::feel_camera`), and enemies leave them alone (forge-ai goes for the living). A friend within
//! `revive.range` metres holding interact fills the revive (`revive.time` seconds of the helper's own value, so a card
//! can make a player a quicker helper); letting go or stepping away drains it at twice the speed. Full: the player is
//! back up at `revive.health` of their full health, unhurtable for `revive.grace` seconds. When nobody is left standing
//! nobody is down any more: everyone is out, and the rules end the run. Alone, zero health is out at once.
//!
//! The host decides (it simulates every player); a joiner's copy takes who is down and the revive's progress from the
//! snapshot (`cards::feel_sync`). Rule events for rules.js: `player-down` {entity: who, a: the attacker},
//! `player-revived` {entity: who, a: the helper, b: the health given}, `player-out` {entity} when a downed player's last
//! friend falls. `op::REVIVE` raises a player at once (the rules' own way back up).
use forge_core::cmd;
use forge_core::components::*;
use forge_core::glam::{Vec2, Vec3};
use forge_core::hecs::Entity;
use forge_core::sim::Sim;
use forge_core::STEP;

use crate::controller::{ensure_pilots, Pilot};

fn authority(sim: &Sim) -> bool {
    !sim.res.get::<forge_core::net::NetState>().is_some_and(|n| n.follows())
}

/// Bring a player back up at `share` of their full health (a revive, `op::REVIVE`).
pub fn raise(sim: &mut Sim, e: Entity, share: f32, grace: f32, by: u32) {
    let mut given = 0.0;
    if let Ok(mut h) = sim.world.get::<&mut Health>(e) {
        if !h.dead {
            return;
        }
        h.dead = false;
        h.hp = (h.max * share.clamp(0.01, 1.0)).max(1.0);
        h.invulnerable = grace;
        given = h.hp;
    }
    if let Ok(mut p) = sim.world.get::<&mut Pilot>(e) {
        p.downed = false;
        p.dead = false;
        p.revive = 0.0;
        p.reviver = 0;
        p.tint = 0.0;
        p.stage = 0;
    }
    let (id, pos) = sim.world.query_one::<(&Player, &Transform)>(e).get().map(|(p, t)| (p.id, t.pos)).unwrap_or((0, Vec3::ZERO));
    let sound = crate::cfg(sim).moves.sound_revive.clone();
    sim.sound(&sound, pos, 0.0, id);
    sim.rule("player-revived", id, by as f32, given, 0.0, 0.0);
}

/// `feel.revive` (Feel stage, after the controller): who is down, the revives under way, and the slow look of this
/// copy's own player while it is down.
pub fn feel_revive(sim: &mut Sim) {
    ensure_pilots(sim);
    let global = crate::cfg(sim);
    let look = global.moves.revive.look;
    // this copy's own player: the look turns slowly while it is at zero health
    let slow: Vec<(Entity, bool, bool)> = sim.world.query::<(Entity, &Player, &Health, Option<&LookScale>)>().iter().filter(|(_, p, ..)| p.local).map(|(e, _, h, s)| (e, h.dead, s.is_some())).collect();
    for (e, dead, has) in slow {
        if dead && !has {
            let _ = sim.world.insert_one(e, LookScale(look));
        } else if !dead && has {
            let _ = sim.world.remove_one::<LookScale>(e);
        }
    }
    if !authority(sim) {
        return;
    }
    // who stands: where, whether they hold interact, how long their revive takes
    let up: Vec<(u32, Vec3, bool, f32)> = sim
        .world
        .query::<(&Player, &Transform, &Control, &Health, Option<&crate::cards::Build>)>()
        .iter()
        .filter(|(_, _, _, h, _)| !h.dead)
        .map(|(p, t, c, _, b)| (p.id, t.pos, c.down(cmd::BTN_INTERACT), b.and_then(|b| b.cfg.as_deref()).map(|c| c.moves.revive.time).unwrap_or(global.moves.revive.time)))
        .collect();
    let range = global.moves.revive.range;
    let mut fell: Vec<(u32, Vec3, u32)> = Vec::new();
    let mut out: Vec<u32> = Vec::new();
    let mut raised: Vec<(Entity, u32)> = Vec::new();
    for (e, p, tr, pilot, hp) in sim.world.query_mut::<(Entity, &Player, &Transform, &mut Pilot, &Health)>() {
        if !hp.dead {
            pilot.downed = false;
            pilot.revive = 0.0;
            pilot.reviver = 0;
            continue;
        }
        let was = pilot.downed;
        pilot.downed = !up.is_empty();
        if pilot.downed && !was {
            fell.push((p.id, tr.pos, hp.last_hit_by));
        }
        if !pilot.downed {
            if was {
                out.push(p.id);
            }
            pilot.revive = 0.0;
            pilot.reviver = 0;
            continue;
        }
        let near = |q: &Vec3| Vec2::new(q.x - tr.pos.x, q.z - tr.pos.z).length();
        let helper = up.iter().filter(|(_, q, hold, _)| *hold && near(q) <= range && (q.y - tr.pos.y).abs() < 2.5).min_by(|a, b| near(&a.1).total_cmp(&near(&b.1)));
        match helper {
            Some((id, _, _, time)) => {
                pilot.revive += STEP / time.max(0.05);
                pilot.reviver = *id;
                if pilot.revive >= 1.0 {
                    raised.push((e, *id));
                }
            }
            None => {
                pilot.revive = (pilot.revive - 2.0 * STEP / global.moves.revive.time.max(0.05)).max(0.0);
                pilot.reviver = 0;
            }
        }
    }
    for (id, pos, by) in fell {
        sim.sound(&global.moves.sound_down, pos, 0.0, id);
        sim.rule("player-down", id, by as f32, 0.0, 0.0, 0.0);
    }
    for id in out {
        sim.rule("player-out", id, 0.0, 0.0, 0.0, 0.0);
    }
    for (e, by) in raised {
        raise(sim, e, global.moves.revive.health, global.moves.revive.grace, by);
    }
}

/// op::REVIVE: ints [player], floats [share of full health (0: the table's)]: back up now.
pub fn cmd_revive(sim: &mut Sim, r: &cmd::Record) {
    if !authority(sim) {
        return;
    }
    ensure_pilots(sim);
    let Some(&e) = sim.players.get(&r.u(0)) else { return };
    let rv = crate::cfg(sim).moves.revive.clone();
    let share = if r.f(1) > 0.0 { r.f(1) } else { rv.health };
    raise(sim, e, share, rv.grace, 0);
}
