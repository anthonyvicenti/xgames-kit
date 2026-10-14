//! The AI view: what forge-ai knows about each enemy and projectile that the renderer and the JS side draw from, as one
//! flat f32 array (structure-of-arrays like the core's views: field `f` of row `i` at `f × CAPACITY + i`), sorted by
//! net id, refilled at the end of every step (Post stage). forge-web exports it (`ai_view_ptr`, `ai_count`, …);
//! `gf/forge/ai.js` reads it.
//!
//! **Eye glow (track R):** draw each enemy's `glow_eyes` material with emissive colour `EYE_R/G/B` (linear) times
//! `EYE_I` (the intensity: rest 2.4, ramping +12-15% through a tell, white for a moment on a hit, 0 dead), and its
//! body's white hit flash with `FLASH` (1 → 0 over about 45 ms). Until R's per-instance emissive lands this view is the
//! fallback: nothing else carries it. An orb's light is `EYE_R/G/B` × `EYE_I` with radius `LIGHT` at its entity's
//! place. `OFFSET` is where to draw a body above its feet when no clip carries it (the rise from the ground, the
//! lunge's dip): an animated body's clips carry both, so add it only to a body drawn without an animator.
//! On a joiner (replicas) the state comes from the host's snapshot byte and the rest from the type's row.
use forge_core::components::*;
use forge_core::sim::Sim;
use forge_core::snapshot::SnapByte;

use crate::defs::{Arch, Roster};
use crate::director::Director;
use crate::enemy::{BossBar, Enemy, State, Tokens};
use crate::projectile::Orb;

pub const FIELDS: usize = 17;
pub const CAPACITY: usize = 512;

pub mod field {
    pub const NET: usize = 0;
    /// 2 an enemy, 3 a projectile (forge-core `kind`).
    pub const KIND: usize = 1;
    /// Its table row (enemies).
    pub const TYPE: usize = 2;
    /// `Arch` (0 chaser … 5 boss; 255 a projectile).
    pub const ARCH: usize = 3;
    /// `enemy::State`.
    pub const STATE: usize = 4;
    /// Seconds in the state.
    pub const STATE_T: usize = 5;
    pub const EYE_R: usize = 6;
    pub const EYE_G: usize = 7;
    pub const EYE_B: usize = 8;
    pub const EYE_I: usize = 9;
    pub const FLASH: usize = 10;
    pub const OFFSET: usize = 11;
    /// Its target's net id (0: none).
    pub const TARGET: usize = 12;
    /// `flag` bits.
    pub const FLAGS: usize = 13;
    /// A projectile's light radius, m (0: none).
    pub const LIGHT: usize = 14;
    /// Health as a share of the most.
    pub const HP: usize = 15;
    /// Wave 7: its elite mark (elite.rs): the modifier in the low three bits (1 burning, 2 armoured, 3 splitting,
    /// 4 fast), + 8 for a split one's young; 0 an ordinary one. A replica's from the host's snapshot (forge-core `Marked`).
    pub const ELITE: usize = 16;
}

pub mod flag {
    pub const TOKEN: u32 = 1;
    pub const GUARD: u32 = 2;
    pub const SHIELD_BROKEN: u32 = 4;
    pub const BOSS: u32 = 8;
    pub const ARRIVING: u32 = 16;
    pub const TELL: u32 = 32;
    pub const ATTACK: u32 = 64;
    pub const DOWN: u32 = 128;
    pub const REPLICA: u32 = 256;
}

/// The director's state (`forge.ai_director()`): phase (0 idle, 1 running, 2 waiting for a reward, 3 done), wave
/// (1-based), waves, spawned, total, killed, alive, seconds into it, kills in all, waves started, attackers, emerge points,
/// the wave's number as players count it (endless: with no end), the lap (endless: times the waves have gone round), and
/// 1 when the waves are endless.
pub const DIRECTOR_FIELDS: usize = 15;

#[derive(Default)]
pub struct AiView {
    pub rows: Vec<f32>,
    pub count: usize,
    pub director: [f32; DIRECTOR_FIELDS],
    /// The boss (`forge.ai_boss()`): net id (0: none), hp, max, phase, phases, state, row, invulnerable (0/1).
    pub boss: [f32; 8],
}

pub fn system(sim: &mut Sim) {
    let mut v = sim.res.take::<AiView>();
    if v.rows.len() != FIELDS * CAPACITY {
        v.rows = vec![0.0; FIELDS * CAPACITY];
    }
    let roster = sim.res.get::<Roster>();
    let tokens = sim.res.get::<Tokens>();
    let fallback = crate::defs::Def::base(Arch::Chaser);
    let mut rows: Vec<(u32, [f32; FIELDS])> = Vec::new();
    // never what is a copy's own (`Local`: a player's round in flight is a PROJECTILE too, and no orb)
    for (e, n, k, en, sb, hp, rep, orb, sm) in sim.world.query::<(forge_core::hecs::Entity, &NetId, &Kind, Option<&Enemy>, Option<&SnapByte>, Option<&Health>, Option<&Replica>, Option<&Orb>, Option<&Marked>)>().without::<&Local>().iter() {
        if k.kind != kind::ENEMY && k.kind != kind::PROJECTILE {
            continue;
        }
        // the type's row, borrowed (a Def carries its names and clips: never cloned per step)
        let def = roster.and_then(|r| r.defs.get(k.type_ as usize)).unwrap_or(&fallback);
        let mut r = [0f32; FIELDS];
        r[field::NET] = n.0 as f32;
        r[field::KIND] = k.kind as f32;
        r[field::TYPE] = k.type_ as f32;
        r[field::HP] = hp.map(|h| h.fraction()).unwrap_or(1.0);
        r[field::ELITE] = en.map(|en| en.mark).or(sm.map(|m| m.mark)).unwrap_or(0) as f32;
        let mut flags = 0u32;
        if rep.is_some() {
            flags |= flag::REPLICA;
        }
        if k.kind == kind::PROJECTILE {
            r[field::ARCH] = 255.0;
            let (c, i, l) = orb.map(|o| (o.color, o.intensity, o.light)).unwrap_or((def.shot_color, def.shot_intensity, def.shot_light));
            r[field::EYE_R] = c[0];
            r[field::EYE_G] = c[1];
            r[field::EYE_B] = c[2];
            r[field::EYE_I] = i;
            r[field::LIGHT] = l;
            r[field::FLAGS] = flags as f32;
            rows.push((n.0, r));
            continue;
        }
        r[field::ARCH] = def.arch as u8 as f32;
        let (state, t, eye, white, flash, offset, target) = match en {
            Some(en) => {
                if en.guarding() {
                    flags |= flag::GUARD;
                }
                if en.guard.broken {
                    flags |= flag::SHIELD_BROKEN;
                }
                if tokens.is_some_and(|tk| tk.has(e)) {
                    flags |= flag::TOKEN;
                }
                (en.state, en.t, en.eye, en.eye_white > 0.0, en.flash, en.offset, en.target_net)
            }
            None => {
                // a replica: the host's state byte; the eyes from the type's row
                let b = sb.map(|s| s.0).unwrap_or(State::Chase as u8);
                if b & 32 != 0 {
                    flags |= flag::GUARD;
                }
                let st = State::from_u8(b & 31);
                let eye = match st {
                    State::Dead => 0.0,
                    State::Tell | State::Attack => def.eye_glow * (1.0 + def.eye_windup),
                    _ => def.eye_glow,
                };
                (st, 0.0, eye, false, 0.0, 0.0, 0)
            }
        };
        if def.arch == Arch::Boss {
            flags |= flag::BOSS;
        }
        match state {
            State::Arrive => flags |= flag::ARRIVING,
            State::Tell => flags |= flag::TELL,
            State::Attack => flags |= flag::ATTACK,
            State::Down | State::Rise => flags |= flag::DOWN,
            _ => {}
        }
        let c = if white { [1.0, 1.0, 1.0] } else { def.eye_color };
        r[field::STATE] = state as u8 as f32;
        r[field::STATE_T] = t;
        r[field::EYE_R] = c[0];
        r[field::EYE_G] = c[1];
        r[field::EYE_B] = c[2];
        r[field::EYE_I] = eye;
        r[field::FLASH] = flash;
        r[field::OFFSET] = offset;
        r[field::TARGET] = target as f32;
        r[field::FLAGS] = flags as f32;
        rows.push((n.0, r));
    }
    rows.sort_by_key(|r| r.0);
    v.count = rows.len().min(CAPACITY);
    for (i, (_, r)) in rows.iter().take(CAPACITY).enumerate() {
        for (f, x) in r.iter().enumerate() {
            v.rows[f * CAPACITY + i] = *x;
        }
    }
    let waves = roster.map(|r| r.waves.len()).unwrap_or(0);
    let endless = roster.is_some_and(|r| r.endless.on);
    let d = sim.res.get::<Director>();
    let alive = sim.world.query::<&Enemy>().iter().filter(|e| e.state != State::Dead && d.is_some_and(|d| e.wave == Some(d.wave as u16))).count();
    v.director = match d {
        Some(d) => [d.phase as u8 as f32, (d.wave + 1) as f32, waves as f32, d.spawned as f32, d.total as f32, d.killed as f32, alive as f32, d.t, d.kills_total as f32, d.started as f32, d.attackers() as f32, d.mounds.len() as f32, d.number as f32, d.lap as f32, endless as u8 as f32],
        None => {
            let mut x = [0.0; DIRECTOR_FIELDS];
            x[2] = waves as f32;
            x
        }
    };
    let b = sim.res.get::<BossBar>().copied().unwrap_or_default();
    v.boss = [b.net as f32, b.hp, b.max, b.phase as f32, b.phases as f32, b.state as f32, b.row as f32, b.invulnerable as u8 as f32];
    sim.res.insert(v);
}
