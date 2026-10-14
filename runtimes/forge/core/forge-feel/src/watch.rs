//! Wave 4 (watch then play, CONTRACT §9b): the weapon in the hand of the player a viewer watches.
//!
//! A viewer looks through a replica's eyes (forge-core net.rs, `Role::Viewer`). What it sees of the weapon there is the
//! feel view's, and the feel view reads a player's `Arms`; but nothing simulates a replica's weapons (the host does,
//! and a snapshot carries only the row in hand). So the host says what a player's weapon is doing in **one byte a
//! player** (the snapshot's state byte for a player, `SnapByte`, which nothing else used):
//!
//! ```text
//! bits 0..=2   the shots fired so far, the low three bits of the count (a snapshot ten times a second sees every shot
//!              of anything slower than 80 a second)
//! bit  3       a reload is running
//! bits 4..=5   a swing is running: 0 none, 1 the weapon in hand, 2 the quick melee over it
//! bit  6       flips with every swing begun (two swings inside one snapshot's gap are still two)
//! ```
//!
//! `feel.acts` (Feel stage, after the weapons; the host's and a player alone) writes it. `feel.watch` (a viewer's, in
//! the same place) turns each change back into the same motion on the watched player's `Arms`: the viewmodel's snap
//! and the recoil spring for a shot, the reload's dip for the row's own reload time, a swing from its start, the raise
//! when the row in hand changes. The feel view, the camera rig and the renderer's glue then read that `Arms` exactly as
//! they read a local player's. What it cannot know stays unknown: the rounds left (the view says none, and the HUD
//! shows the weapon's name alone), a charge building, and a shot that is seen a snapshot late (about 0.1 s).
use forge_core::components::*;
use forge_core::hecs::Entity;
use forge_core::net::NetState;
use forge_core::sim::Sim;
use forge_core::snapshot::SnapByte;
use forge_core::STEP;

use crate::weapons::{Arms, Swing};

pub const SHOTS: u8 = 0b0000_0111;
pub const RELOADING: u8 = 0b0000_1000;
pub const SWING_SHIFT: u8 = 4;
pub const SWING: u8 = 0b0011_0000;
pub const SWING_FLIP: u8 = 0b0100_0000;
/// The most shots one change of the byte plays (a count that wrapped is one burst, not seven kicks).
const MAX_KICKS: u8 = 3;

/// What `arms` is doing, in the byte.
pub fn byte_of(a: &Arms) -> u8 {
    let swing = match a.swing {
        Some(s) if s.quick => 2u8,
        Some(_) => 1,
        None => 0,
    };
    (a.shots as u8 & SHOTS) | if a.reload_left > 0.0 { RELOADING } else { 0 } | (swing << SWING_SHIFT) | if a.swings & 1 == 1 { SWING_FLIP } else { 0 }
}

/// What a viewer's copy last heard of the watched player's weapon.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Seen {
    pub byte: u8,
    pub row: Option<usize>,
}

/// `feel.acts`: every player this copy simulates says what its weapon is doing (the next snapshot carries it).
pub fn feel_acts(sim: &mut Sim) {
    if sim.res.get::<NetState>().is_some_and(|n| n.follows()) {
        return;
    }
    let set: Vec<(Entity, u8)> = sim.world.query::<(Entity, &Player, &Arms, Option<&SnapByte>)>().without::<&Replica>().iter().filter(|(_, p, ..)| p.owned).map(|(e, _, a, old)| (e, byte_of(a), old.map(|o| o.0))).filter(|(_, b, old)| *old != Some(*b)).map(|(e, b, _)| (e, b)).collect();
    for (e, b) in set {
        let _ = sim.world.insert_one(e, SnapByte(b));
    }
}

/// `feel.watch` (a viewer's): the watched player's `Arms` follow what the host says of them (module docs).
pub fn feel_watch(sim: &mut Sim) {
    if !sim.res.get::<NetState>().is_some_and(|n| n.is_viewer()) {
        return;
    }
    crate::weapons::ensure(sim);
    let global = crate::cfg(sim);
    let mut first: Vec<(Entity, Seen)> = Vec::new();
    for (e, p, sb, wear, a, build, seen) in sim.world.query_mut::<(Entity, &Player, Option<&SnapByte>, &Wear, &mut Arms, Option<&crate::cards::Build>, Option<&mut Seen>)>().with::<&Replica>() {
        if !p.local {
            continue;
        }
        let cfg: &crate::Config = build.and_then(|b| b.cfg.as_deref()).unwrap_or(&global);
        let row = (wear.held != HELD_NONE).then_some(wear.held as usize).filter(|r| *r < cfg.weapons.len());
        let now = sb.map(|s| s.0).unwrap_or(0);
        let Some(seen) = seen else {
            // the first look: the weapon in hand as it is, nothing played for what happened before
            a.current = row;
            a.held = row.into_iter().collect();
            a.reload_left = 0.0;
            a.raise_left = 0.0;
            a.swing = None;
            a.shape = row.and_then(|r| cfg.weapons.get(r)).map(|w| w.shape).unwrap_or_default();
            first.push((e, Seen { byte: now, row }));
            continue;
        };
        // the clocks a local player's weapons step runs (weapons.rs): the raise, the viewmodel's snap, a reload, a swing
        a.raise_left = (a.raise_left - STEP).max(0.0);
        {
            let w = 55.0f32;
            let ex = (-w * STEP).exp();
            let b = a.view_v + w * a.view_kick;
            let k = (a.view_kick + b * STEP) * ex;
            a.view_v = (a.view_v - w * b * STEP) * ex;
            a.view_kick = if k.abs() < 1e-5 && a.view_v.abs() < 1e-4 { 0.0 } else { k };
        }
        // a reload is over when the host says so: until then it waits a step short of its end
        if a.reload_left > 0.0 {
            a.reload_left = (a.reload_left - STEP).max(STEP);
        }
        if let Some(mut s) = a.swing {
            s.t += STEP;
            let d = match s.row { Some(r) => cfg.weapons.get(r), None => cfg.blade.as_ref() };
            a.swing = d.filter(|d| s.t < d.melee.contact + d.melee.recover).map(|_| s);
        }
        // another row in hand: raised as after a switch
        if row != seen.row {
            seen.row = row;
            a.current = row;
            a.held = row.into_iter().collect();
            a.reload_left = 0.0;
            if let Some(d) = row.and_then(|r| cfg.weapons.get(r)) {
                a.raise_total = d.raise;
                a.raise_left = d.raise;
                a.shape = d.shape;
            }
        }
        let was = seen.byte;
        if now == was {
            continue;
        }
        seen.byte = now;
        let def = a.current.and_then(|r| cfg.weapons.get(r));
        // shots: each one's snap and kick (the light, the sound and the sparks are the host's events)
        let shots = (now & SHOTS).wrapping_sub(was & SHOTS) & SHOTS;
        if let Some(d) = def {
            for _ in 0..shots.min(MAX_KICKS) {
                a.shots += 1;
                a.shape = d.shape;
                a.recoil.kick(d.kick_impulse, d.shape);
                if d.kick_yaw > 0.0 {
                    let sign = if a.shots % 2 == 0 { 1.0 } else { -1.0 };
                    a.recoil_yaw.kick(sign * d.kick_yaw / crate::recoil::gain(d.shape).max(1e-4), d.shape);
                }
                a.view_v += d.view_kick * 55.0 * std::f32::consts::E;
            }
        }
        // a reload begun (its dip runs the row's own time), or done
        match (was & RELOADING != 0, now & RELOADING != 0) {
            (false, true) => {
                let secs = def.map(|d| d.reload).filter(|s| *s > 0.0).unwrap_or(1.0);
                a.reload_total = secs;
                a.reload_left = secs;
            }
            (true, false) => a.reload_left = 0.0,
            _ => {}
        }
        // a swing begun: the weapon in hand, or the quick melee over it (its hit and its sound are the host's)
        let kind = (now & SWING) >> SWING_SHIFT;
        if kind != 0 && (was & SWING_FLIP != now & SWING_FLIP || was & SWING == 0) {
            let quick = kind == 2;
            a.swing = Some(Swing { t: 0.0, row: if quick { cfg.quick_melee } else { a.current }, quick, whooshed: true, hit: true });
            a.swings = a.swings.wrapping_add(1);
        }
    }
    for (e, s) in first {
        let _ = sim.world.insert_one(e, s);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_byte_says_shots_a_reload_and_a_swing() {
        let mut a = Arms::default();
        assert_eq!(byte_of(&a), 0);
        a.shots = 13;
        a.reload_left = 0.4;
        assert_eq!(byte_of(&a), 5 | RELOADING);
        a.reload_left = 0.0;
        a.swing = Some(Swing { t: 0.0, row: None, quick: true, whooshed: false, hit: false });
        a.swings = 1;
        assert_eq!(byte_of(&a), 5 | (2 << SWING_SHIFT) | SWING_FLIP);
        a.swing = Some(Swing { t: 0.0, row: Some(0), quick: false, whooshed: false, hit: false });
        a.swings = 2;
        assert_eq!(byte_of(&a), 5 | (1 << SWING_SHIFT));
    }
}
