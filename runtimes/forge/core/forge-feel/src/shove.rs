//! Shoves (wave 2; research/gf-forge/INTEGRATION.md mismatch 16): something pushes a player or knocks it down (a
//! brute's slam, the boss's charge: `controller::knock`).
//!
//! Alone, and for the host's own player and bots, a shove starts at once. A **joiner's player** is simulated twice: on
//! the host from the joiner's inputs, and on the joiner itself a few steps ahead (prediction). A shove the host
//! applied at once reached the joiner as corrections (it kept walking while the host had it down: up to 0.69 m with
//! four players, worse while running). So the host **schedules** it: it starts `DELAY` of the joiner's own input steps
//! after the last one the host applied, and a PUSH event (forge-core `events::Push`, carried by the snapshot) tells
//! the joiner that step's number. Both copies start it as they simulate that same step (`feel.shoves`, before the
//! controller), so the joiner's prediction and the host's replay agree and nothing is corrected. A PUSH that arrives
//! after its step (a slow snapshot) plays what is left of it from there (counted in the co-op stats as `pushesLate`):
//! the host keeps its copy of a joiner's player where the joiner's own copy says it is (forge-core net.rs, "a
//! joiner's word"), so a late shove is a shorter one on every screen, never a correction.
use forge_core::components::*;
use forge_core::events::{self, Event, FLAG_REMOTE};
use forge_core::glam::{Vec2, Vec3};
use forge_core::hecs::Entity;
use forge_core::net::NetState;
use forge_core::sim::Sim;
use forge_core::STEP;

use crate::controller::Pilot;
use crate::hits::Push;

/// A joiner's player is shoved this many of its own steps after the last the host applied (0.2 s: an input batch, the
/// snapshot's wait and the trip back, on one machine or a home network; a slower link catches up, see above).
pub const DELAY: u32 = 24;
/// The host gives up waiting for a joiner's step (its inputs stopped coming) after this long, and shoves it now.
pub const GIVE_UP: f64 = 1.0;

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Shove {
    pub player: u32,
    /// The player's own input step it starts at.
    pub seq: u32,
    /// m/s: x and z fade over `secs`; y is a hop.
    pub vel: Vec3,
    pub secs: f32,
    /// Seconds without control (a knock-down).
    pub down: f32,
    /// When it was decided (the host's clock).
    pub at: f64,
}

/// Shoves waiting for their step.
#[derive(Clone, Debug, Default)]
pub struct Shoves {
    pub pending: Vec<Shove>,
}

/// Shove a player: `vel` (m/s; x and z fade over `secs` through `hits::push`, y is a hop), and `down` seconds without
/// control. On the host a joiner's player takes it on the joiner's own step (the module's docs); anyone else now.
pub fn shove(sim: &mut Sim, e: Entity, vel: Vec3, secs: f32, down: f32) {
    let Ok(p) = sim.world.get::<&Player>(e).map(|p| *p) else { return };
    let ack = sim.res.get::<NetState>().filter(|n| n.is_host()).map(|n| n.ack_of(p.id)).unwrap_or(0);
    if p.owned && !p.local && ack > 0 {
        let seq = ack + DELAY;
        sim.emit(Event::Push(events::Push { player: p.id, seq, vel, secs, down }));
        let at = sim.time.now;
        sim.res.entry::<Shoves>().pending.push(Shove { player: p.id, seq, vel, secs, down, at });
        return;
    }
    start(sim, e, vel, secs, down, 0);
}

/// How far a shove of `vel` fading over `secs` carries in its first `k` steps (what `hits::feel_push` adds up).
pub fn travel(vel: Vec3, secs: f32, k: u32) -> Vec3 {
    let h = Vec3::new(vel.x, 0.0, vel.z);
    if secs <= 0.0 {
        return Vec3::ZERO;
    }
    let mut left = secs;
    let mut out = Vec3::ZERO;
    for _ in 0..k {
        if left <= 0.0 {
            break;
        }
        out += h * (left / secs).clamp(0.0, 1.0) * STEP;
        left -= STEP;
    }
    out
}

/// The shove begins (`late` steps ago, on a joiner whose snapshot was slow: what is left of it plays from here).
fn start(sim: &mut Sim, e: Entity, vel: Vec3, secs: f32, down: f32, late: u32) {
    crate::controller::ensure_pilots(sim);
    let gone = late as f32 * STEP;
    if sim.world.get::<&Health>(e).is_ok_and(|h| h.dead) {
        return;
    }
    if down > gone
        && let Ok(mut p) = sim.world.get::<&mut Pilot>(e)
    {
        p.down = down - gone;
        p.down_total = down;
        p.evade_t = -1.0;
        p.h = Vec2::ZERO;
    }
    if late == 0
        && vel.y > 0.0
        && let Ok(mut v) = sim.world.get::<&mut Velocity>(e)
    {
        v.linear.y = v.linear.y.max(vel.y);
    }
    let h = Vec3::new(vel.x, 0.0, vel.z);
    if secs > gone && h.length_squared() > 1e-8 {
        if late == 0 {
            crate::hits::push(sim, e, h, secs);
        } else {
            let _ = sim.world.insert_one(e, Push { vel: h, left: secs - gone, total: secs });
        }
    }
}

/// `feel.shoves` (Feel stage, before the controller): each waiting shove starts as its player's own step comes up: on
/// the host when it has applied that step's input, on the joiner when it simulates that step.
pub fn feel_shoves(sim: &mut Sim) {
    let (joiner, local) = sim.res.get::<NetState>().map(|n| (n.is_joiner(), n.local)).unwrap_or((false, 0));
    if joiner {
        // the host's shoves of this copy's own player (with the snapshot applied since the last step)
        let got: Vec<events::Push> = sim.events.early_events().filter_map(|(e, f)| match e { Event::Push(p) if f & FLAG_REMOTE != 0 && p.player == local => Some(*p), _ => None }).collect();
        if !got.is_empty() {
            let at = sim.time.now;
            sim.res.entry::<Shoves>().pending.extend(got.into_iter().map(|p| Shove { player: p.player, seq: p.seq, vel: p.vel, secs: p.secs, down: p.down, at }));
        }
    }
    if !sim.res.get::<Shoves>().is_some_and(|s| !s.pending.is_empty()) {
        return;
    }
    let list = std::mem::take(&mut sim.res.entry::<Shoves>().pending);
    let (step, now) = (sim.time.step as u32, sim.time.now);
    let mut keep = Vec::new();
    for s in list {
        let Some(&e) = sim.players.get(&s.player) else { continue };
        if joiner {
            if step < s.seq {
                keep.push(s);
                continue;
            }
            let late = step - s.seq;
            // heard after its step (a slow snapshot): what is left of it plays from here, with no catch-up move. The
            // host has its copy of this player where this copy says it is (forge-core net.rs, "a joiner's word"), so
            // the two still agree; the shove is that much shorter
            if let Some(n) = sim.res.get_mut::<NetState>() {
                if late > 0 { n.note_late_push() } else { n.note_push() }
            }
            start(sim, e, s.vel, s.secs, s.down, late);
        } else {
            let ack = sim.res.get::<NetState>().map(|n| n.ack_of(s.player)).unwrap_or(0);
            if ack >= s.seq || now - s.at > GIVE_UP {
                start(sim, e, s.vel, s.secs, s.down, 0);
            } else {
                keep.push(s);
            }
        }
    }
    sim.res.entry::<Shoves>().pending.extend(keep);
}
