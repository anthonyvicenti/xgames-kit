//! The first-person controller (`feel.move`, in place of the core's `core.move`; `core.character` still resolves the
//! travel against the world) and the camera rig it composes (`feel.camera`, last in the Events stage).
//!
//! Measured targets (research/rust-engine/feel-targets.md, moments 5-7):
//! - **The first step:** a straight burst to `burst.share` of the walk in `burst.time` (5.3 m/s by 27 ms), then the rest
//!   closes exponentially to 90% at the table's `accelTime`; the same in every direction, no sprint key. Turning hard
//!   is a burst again. Letting go stops exponentially (under 10% at `stopTime`), and so does going faster than the stick
//!   asks (after an evade).
//! - **Jump:** the table's launch and gravity integrated exactly over the step, coyote time and a buffer; the eyes ride
//!   `bob.jumpLift` higher at the apex (fading with the vertical speed, so takeoff and landing do not jump); a landing
//!   dips the eyes `bob.landDip` and they come back over `bob.landTime`. Thuds: the core's `core.walk` (landing) and
//!   this system (takeoff), on their exact steps.
//! - **Evade:** a dash along the stick (forward with none) whose speed rises with `evade.rise` to the speed that carries
//!   it `evade.distance` (capped at `evade.peak`), driven for `evade.time`, then stopped by the ground's friction; the FOV
//!   punches `evade.fovPunch` on its first frame and falls back linearly by `evade.fovTime`; the eyes dip
//!   `evade.dip`. A cooldown, and the stamina it shares with the jump.
//! - **Head bob:** vertical only, `bob.amount` either way at `bob.rate` Hz, scaled by speed; no roll, no FOV change.
use forge_core::components::*;
use forge_core::events::{self, Event};
use forge_core::glam::{Quat, Vec2, Vec3};
use forge_core::hecs::Entity;
use forge_core::physics::Mover;
use forge_core::sim::{CameraRig, Sim, Walker};
use forge_core::systems::basis;
use forge_core::{cmd, STEP};


/// The frame the FOV punch holds before it falls (feel target 3: +2.6° "on the first frame").
pub const FOV_HOLD: f32 = 1.0 / 60.0;
/// A knock-down's hop, m/s (forge-ai's slam and charge lift a player a hand's width).
pub const KNOCK_HOP: f32 = 2.0;
/// Down with a friend standing: the eyes' height over the ground, the tip (radians) and the seconds they take to sink.
pub const DOWN_EYE: f32 = 0.42;
pub const DOWN_ROLL: f32 = 0.3;
pub const DOWN_SINK: f32 = 0.45;

/// A player's feel state (this crate's own component on every player).
#[derive(Clone, Debug)]
pub struct Pilot {
    pub stamina: f32,
    /// Seconds since the evade started (negative: none).
    pub evade_t: f32,
    pub evade_dir: Vec2,
    pub evade_cool: f32,
    /// Seconds since the FOV punch (≥ its time: none).
    pub fov_t: f32,
    pub bob_phase: f32,
    pub bob_amp: f32,
    /// Seconds since landing, and that landing's dip.
    pub land_t: f32,
    pub land_dip: f32,
    /// The red edge tint (0..1), the hurt jitter's seconds left and its clock.
    pub tint: f32,
    pub shake_left: f32,
    pub shake_clock: f32,
    pub stage: u8,
    /// The combo: kills in it, its multiplier and seconds left.
    pub combo: u32,
    pub combo_mult: f32,
    pub combo_left: f32,
    pub best_combo: u32,
    /// Aim help for this player (the host says which input it uses).
    pub assist: bool,
    /// The viewmodel's sway (radians it lags behind the look) and the look it last saw.
    pub sway: Vec2,
    pub sway_v: Vec2,
    pub last_look: Option<(f32, f32)>,
    pub dead: bool,
    /// The camera offsets this step (for the view): head (m, world), shake (m, world).
    pub head: Vec3,
    pub shake: Vec3,
    pub fov: f32,
    /// Knocked down (the wave 1b integration: forge-ai's brute slam and the boss's charge, `knock`): seconds left
    /// without control and the knock's length. Fair play bounds it (forge-ai: at most 0.8 s, one a player per 3 s).
    pub down: f32,
    pub down_total: f32,
    /// Down (wave 2): at zero health with a friend still standing, who can bring this player back (`revive.rs`).
    /// `down_t`: seconds since (the eyes sink over its first part); `revive`: the share of a revive done (0..1) and
    /// `reviver` who is doing it (a player id; 0: nobody). The host's; a joiner's copy takes them from the snapshot.
    pub downed: bool,
    pub down_t: f32,
    pub revive: f32,
    pub reviver: u32,
    /// The horizontal velocity this controller asked for last step. forge-core's `core.character` cuts the velocity
    /// "into a wall" from the character controller's contacts, and rapier sometimes reports a steep contact while the
    /// full travel went through (seen on a first step from standing: a (0.67, 0.14, 0.73) normal halved it): the cut is
    /// taken only when the travel really fell short.
    pub h: Vec2,
}

impl Pilot {
    pub fn new(stamina: f32) -> Self {
        Self { stamina, evade_t: -1.0, evade_dir: Vec2::ZERO, evade_cool: 0.0, fov_t: 10.0, bob_phase: 0.0, bob_amp: 0.0, land_t: 10.0, land_dip: 0.0, tint: 0.0, shake_left: 0.0, shake_clock: 0.0, stage: 0, combo: 0, combo_mult: 1.0, combo_left: 0.0, best_combo: 0, assist: false, sway: Vec2::ZERO, sway_v: Vec2::ZERO, last_look: None, dead: false, head: Vec3::ZERO, shake: Vec3::ZERO, fov: 0.0, down: 0.0, down_total: 0.0, downed: false, down_t: 0.0, revive: 0.0, reviver: 0, h: Vec2::ZERO }
    }
    /// Driven this step: `time` rounded to whole steps (0.17 s: 20 steps).
    pub fn evading(&self, time: f32) -> bool {
        self.evade_t >= 0.0 && self.evade_t < time - STEP * 0.5
    }
}

/// Every player without a Pilot gets one (spawned since the last step).
pub fn ensure_pilots(sim: &mut Sim) {
    let stamina = crate::cfg(sim).moves.stamina.max;
    let missing: Vec<Entity> = sim.world.query::<(Entity, &Player)>().without::<&Pilot>().iter().map(|(e, _)| e).collect();
    for e in missing {
        let _ = sim.world.insert_one(e, Pilot::new(stamina));
    }
}

/// One step of the walk's horizontal velocity toward `want` (m/s), with `ctl` of the ground's grip (air control).
pub fn walk_step(h: Vec2, want: Vec2, burst_a: f32, gap_s: f32, k_acc: f32, k_stop: f32, ctl: f32) -> Vec2 {
    let d = want - h;
    let gap = d.length();
    if gap < 1e-6 {
        return want;
    }
    let wl = want.length();
    let speeding_up = wl > 1e-3 && h.dot(want / wl) < wl - 1e-4;
    if speeding_up {
        // (a hair over the burst's end is its end: left to rounding, a walk speed whose `gap_s` rounds the other way
        // stayed in the burst for ever, at `burst.share` of its speed; wave 2's walk cards found it)
        if gap > gap_s + 1e-3 {
            let next = (gap - burst_a * ctl * STEP).max(gap_s);
            return want - d / gap * next;
        }
        return h + d * (1.0 - (-k_acc * ctl * STEP).exp());
    }
    h + d * (1.0 - (-k_stop * ctl * STEP).exp())
}

pub fn feel_move(sim: &mut Sim) {
    ensure_pilots(sim);
    let global = crate::cfg(sim);
    let mut jumps: Vec<(u32, Vec3, f32)> = Vec::new();
    let mut evades: Vec<(u32, Vec3, f32)> = Vec::new();
    for (p, c, look, tr, v, mv, w, pilot, hp, build, perks) in sim.world.query_mut::<(&Player, &Control, &Look, &mut Transform, &mut Velocity, &mut Mover, &mut Walker, &mut Pilot, Option<&Health>, Option<&crate::cards::Build>, Option<&crate::perks::Perks>)>().without::<&Replica>() {
        if !p.owned {
            continue;
        }
        // this player's own values: the tables', with the cards they hold (the same on the host and on a joiner
        // predicting its own player: the snapshot carries the cards)
        let cfg: &crate::Config = build.and_then(|b| b.cfg.as_deref()).unwrap_or(&global);
        let m = &cfg.moves;
        let t = &cfg.player;
        let k_stop = std::f32::consts::LN_10 / t.stop_time.max(1e-3);
        let share = m.burst_share.clamp(0.0, 0.98);
        // wave 7: faster while a rush lasts (perks.rs; a joiner's own from the snapshot)
        let walk = t.walk * crate::perks::haste(cfg, perks).0;
        let burst_a = share * walk / m.burst_time.max(1e-3);
        let gap_s = (1.0 - share) * walk;
        let rest = (t.accel_time - m.burst_time).max(0.01);
        let k_acc = ((1.0 - share).max(0.1001) / 0.1).ln() / rest;
        let alive = hp.is_none_or(|h| !h.dead);
        pilot.dead = !alive;
        // knocked down: no control until it is over (the walk stops, no jump, no evade)
        pilot.down = (pilot.down - STEP).max(0.0);
        let enabled = c.enabled && alive && pilot.down <= 0.0;
        tr.rot = Quat::from_rotation_y(look.yaw);
        let (fwd, right) = basis(look.yaw);
        let (mx, mz) = if enabled { (c.move_x, c.move_z) } else { (0.0, 0.0) };
        let mut wish = fwd * mz + right * mx;
        if wish.length() > 1.0 {
            wish = wish.normalize();
        }
        pilot.stamina = (pilot.stamina + m.stamina.regen * STEP).min(m.stamina.max);
        pilot.evade_cool = (pilot.evade_cool - STEP).max(0.0);
        // the evade: a press, its cooldown over, the stamina it costs
        if enabled && c.pressed(cmd::BTN_EVADE) && !pilot.evading(m.evade.time) && pilot.evade_cool <= 0.0 && pilot.stamina + 1e-4 >= m.stamina.evade_cost && cfg.evade_peak > 0.0 {
            pilot.evade_dir = if wish.length_squared() > 1e-4 { wish.normalize() } else { fwd };
            pilot.evade_t = 0.0;
            pilot.evade_cool = m.evade.cooldown;
            pilot.stamina -= m.stamina.evade_cost;
            pilot.fov_t = 0.0;
            evades.push((p.id, tr.pos, cfg.evade_peak));
        }
        let grounded = mv.grounded;
        // the velocity to go on from: what this controller asked for, unless the travel really fell short (a wall), or
        // the core stopped it (a teleport)
        let h_core = Vec2::new(v.linear.x, v.linear.z);
        let travelled = Vec2::new(mv.moved.x, mv.moved.z).length() / STEP;
        let blocked = travelled < pilot.h.length() * 0.9 - 0.05;
        let h = if h_core.length_squared() < 1e-10 || blocked { h_core } else { pilot.h };
        let h = if pilot.evading(m.evade.time) {
            pilot.evade_t += STEP;
            pilot.evade_dir * cfg.evade_peak * (1.0 - (-pilot.evade_t / m.evade.rise).exp())
        } else {
            if pilot.evade_t >= 0.0 {
                pilot.evade_t += STEP;
                if pilot.evade_t > m.evade.time + 1.0 {
                    pilot.evade_t = -1.0;
                }
            }
            let ctl = if grounded { 1.0 } else { t.air_control.max(1e-3) };
            walk_step(h, wish * walk, burst_a, gap_s, k_acc, k_stop, ctl)
        };
        v.linear.x = h.x;
        v.linear.z = h.y;
        pilot.h = h;
        // the jump (coyote time and a buffer, as the core's), with the stamina it may cost
        if grounded {
            w.coyote = t.coyote;
        } else {
            w.coyote = (w.coyote - STEP).max(0.0);
        }
        if enabled && c.pressed(cmd::BTN_JUMP) {
            w.jump_buffer = t.jump_buffer;
        }
        let mut vy = if grounded && v.linear.y < 0.0 { 0.0 } else { v.linear.y };
        if w.jump_buffer > 0.0 && (grounded || w.coyote > 0.0) && enabled && pilot.stamina + 1e-4 >= m.stamina.jump_cost {
            vy = t.jump;
            w.jump_buffer = 0.0;
            w.coyote = 0.0;
            pilot.stamina -= m.stamina.jump_cost;
            jumps.push((p.id, tr.pos, t.jump));
        }
        w.jump_buffer = (w.jump_buffer - STEP).max(0.0);
        // gravity, integrated exactly over the step (the travel is the mean of the velocities at its ends)
        // on the ground the body rests: no gravity pressing it into the floor (the controller's snap keeps it down).
        // Pressing it in every step, as the core's walk does, makes rapier's character controller stall about one step
        // in a hundred on a flat floor (no travel at all); resting, none in a thousand (examples/dbg-walk.rs).
        let rest = grounded && vy == 0.0;
        let v1 = if rest { 0.0 } else { (vy - t.gravity * STEP).max(-t.max_fall) };
        mv.nudge += Vec3::Y * ((vy + v1) * 0.5 * STEP - v1 * STEP);
        v.linear.y = v1;
    }
    let jump_sound = sim.tables.player.sound_jump.clone();
    for (id, pos, jump_speed) in jumps {
        sim.events.push(Event::Motion(events::Motion { what: events::MOTION_JUMP, player: id, pos, speed: jump_speed, air: 0.0 }));
        sim.sound(&jump_sound, pos, 0.0, id);
    }
    for (id, pos, speed) in evades {
        sim.events.push(Event::Motion(events::Motion { what: events::MOTION_EVADE, player: id, pos, speed, air: 0.0 }));
        sim.sound(&global.moves.sound_evade, pos, 0.0, id);
    }
}

/// The camera rig for the local player, every step (Events, after the hits and hurt): head bob, the landing and evade
/// dips, the eyes' lift in the air, the hurt jitter, the recoil spring (pitch and a hair of yaw) and the FOV punch. Each
/// player's own offsets are kept in its Pilot (the view reads them); the rig is the local player's.
pub fn feel_camera(sim: &mut Sim) {
    let global = crate::cfg(sim);
    let landings: Vec<(u32, f32)> = sim.events.step_events().filter_map(|e| if let Event::Motion(x) = e { (x.what == events::MOTION_LAND).then_some((x.player, x.speed)) } else { None }).collect();
    let mut rig: Option<CameraRig> = None;
    for (p, v, mv, pilot, arms, build, replica) in sim.world.query_mut::<(&Player, &Velocity, &Mover, &mut Pilot, Option<&crate::weapons::Arms>, Option<&crate::cards::Build>, Option<&Replica>)>() {
        let cfg: &crate::Config = build.and_then(|b| b.cfg.as_deref()).unwrap_or(&global);
        let m = &cfg.moves;
        let t = &cfg.player;
        let (walk, jump) = (t.walk.max(0.1), t.jump.max(0.1));
        if let Some((_, fall)) = landings.iter().find(|(id, _)| *id == p.id) {
            pilot.land_t = 0.0;
            pilot.land_dip = m.head.land_dip * (fall / 7.0).clamp(0.3, 1.5);
        }
        // (a replica's controller moves nothing here: its speed is the host's, between its last two samples. Wave 4:
        // a viewer's camera is a replica's eyes, and they bob as it walks)
        let speed = match replica {
            Some(r) => Vec2::new(r.vel.x, r.vel.z).length(),
            None => Vec2::new(mv.moved.x, mv.moved.z).length() / STEP,
        };
        // head bob: only on the ground, its size with the speed
        let want = if mv.grounded && !pilot.dead { m.head.bob * (speed / walk).min(1.2) } else { 0.0 };
        pilot.bob_amp += (want - pilot.bob_amp) * (1.0 - (-STEP / 0.06f32).exp());
        if pilot.bob_amp > 1e-5 {
            pilot.bob_phase = (pilot.bob_phase + std::f32::consts::TAU * m.head.bob_rate * STEP) % std::f32::consts::TAU;
        } else {
            pilot.bob_phase = 0.0;
        }
        let mut y = pilot.bob_amp * pilot.bob_phase.sin();
        // the landing dip, back with an ease-out
        if pilot.land_t < m.head.land_time {
            let k = 1.0 - pilot.land_t / m.head.land_time.max(1e-3);
            y -= pilot.land_dip * k * k;
            pilot.land_t += STEP;
        }
        // the eyes ride higher in the air, most at the apex (none at takeoff or landing)
        if !mv.grounded {
            y += m.head.jump_lift * (1.0 - (v.linear.y.abs() / jump)).clamp(0.0, 1.0);
        }
        // the evade's dip
        if pilot.evade_t >= 0.0 {
            let span = m.evade.time + 0.06;
            if pilot.evade_t < span {
                y -= m.evade.dip * (std::f32::consts::PI * pilot.evade_t / span).sin();
            }
        }
        pilot.head = Vec3::Y * y;
        // the hurt jitter: about ±shake at shakeRate, fading with the hit's time
        pilot.shake = Vec3::ZERO;
        if pilot.shake_left > 0.0 {
            let a = m.hurt.shake * (pilot.shake_left / m.hurt.shake_time.max(1e-3)).clamp(0.0, 1.0);
            let w = std::f32::consts::TAU * m.hurt.shake_rate;
            let c = pilot.shake_clock;
            pilot.shake = Vec3::new((w * c).sin(), 0.6 * (w * 1.37 * c + 1.0).sin(), (w * 0.79 * c + 2.0).sin()) * a;
            pilot.shake_clock += STEP;
            pilot.shake_left -= STEP;
        }
        // the FOV punch: held for its first frame, then back linearly
        pilot.fov = 0.0;
        if pilot.fov_t < m.evade.fov_time {
            // the time at the end of this step: held through the first frame, then back to nothing at `fovTime`
            let at = pilot.fov_t + STEP;
            let k = ((at - FOV_HOLD).max(0.0) / (m.evade.fov_time - FOV_HOLD).max(1e-3)).clamp(0.0, 1.0);
            pilot.fov = m.evade.fov_punch * (1.0 - k);
            pilot.fov_t += STEP;
        }
        // knocked down: the eyes drop and tip, and come back as it ends
        let mut roll = 0.0;
        if pilot.down > 0.0 && pilot.down_total > 0.0 {
            let k = (std::f32::consts::PI * (1.0 - pilot.down / pilot.down_total)).sin().max(0.0);
            pilot.head.y -= 0.55 * k;
            roll = 0.16 * k;
        }
        // down with a friend standing (wave 2): the eyes sink to the ground and tip over, and come back up on a revive
        pilot.down_t = if pilot.downed { pilot.down_t + STEP } else { (pilot.down_t.min(DOWN_SINK) - STEP * 2.0).max(0.0) };
        if pilot.down_t > 0.0 {
            let x = (pilot.down_t / DOWN_SINK).clamp(0.0, 1.0);
            let k = x * x * (3.0 - 2.0 * x);
            pilot.head.y -= (t.eye - DOWN_EYE).max(0.0) * k;
            roll += DOWN_ROLL * k;
        }
        if p.local {
            let (pitch, yaw) = arms.map(|a| (a.recoil.x, a.recoil_yaw.x)).unwrap_or((0.0, 0.0));
            rig = Some(CameraRig { offset: pilot.head + pilot.shake, pitch, yaw, roll, fov_add: pilot.fov });
        }
    }
    sim.camera = rig.unwrap_or_default();
}

/// Knock a player down for `secs` (at most 1.2 s), pushed along `dir` at `speed` (m/s, fading over the first part of
/// it through `hits::push`, which the character controller resolves: this controller keeps its own velocity, so a
/// push written to `Velocity` would be lost) with a small hop. The wave 1b integration calls it for forge-ai's knock
/// events. Since wave 2 it goes through `shove::shove`: a joiner's player is knocked on the joiner's own step, on both
/// copies, so the joiner's prediction plays it and is not corrected after.
pub fn knock(sim: &mut Sim, e: Entity, dir: Vec3, speed: f32, secs: f32) {
    ensure_pilots(sim);
    let secs = secs.clamp(0.0, 1.2);
    if sim.world.get::<&Pilot>(e).map(|p| p.dead || secs <= 0.0).unwrap_or(true) {
        return;
    }
    let d = Vec3::new(dir.x, 0.0, dir.z).normalize_or_zero() * speed;
    crate::shove::shove(sim, e, Vec3::new(d.x, KNOCK_HOP, d.z), (secs * 0.6).max(0.15), secs);
}

/// The local player's entity, if any.
pub fn local(sim: &Sim) -> Option<Entity> {
    sim.world.query::<(Entity, &Player)>().iter().find(|(_, p)| p.local).map(|(e, _)| e)
}

/// A player's eyes (feet + the table's eye height) and the look's forward (with the recoil on it).
pub fn eyes(sim: &Sim, e: Entity) -> Option<(Vec3, Vec3, f32, f32)> {
    let mut q = sim.world.query_one::<(&Transform, &Look, Option<&crate::weapons::Arms>)>(e);
    let (tr, look, arms) = q.get().ok()?;
    let pitch = look.pitch + arms.map(|a| a.recoil.x).unwrap_or(0.0);
    let yaw = look.yaw + arms.map(|a| a.recoil_yaw.x).unwrap_or(0.0);
    Some((tr.pos + Vec3::Y * sim.tables.player.eye, forward(yaw, pitch), yaw, pitch))
}

/// The direction a camera with this yaw and pitch looks (yaw 0 looks down −Z; +pitch looks up).
pub fn forward(yaw: f32, pitch: f32) -> Vec3 {
    let (sy, cy) = yaw.sin_cos();
    let (sp, cp) = pitch.sin_cos();
    Vec3::new(-sy * cp, sp, -cy * cp)
}


#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn forward_matches_the_core_basis() {
        for yaw in [0.0f32, 0.7, -2.0] {
            let f = forward(yaw, 0.0);
            let (b, _) = basis(yaw);
            assert!((Vec2::new(f.x, f.z) - b).length() < 1e-5);
        }
        assert!(forward(0.0, 0.5).y > 0.4);
    }

    #[test]
    fn the_walk_bursts_then_closes_and_stops_exponentially() {
        let (walk, share) = (7.8f32, 0.66f32);
        let (a, g) = (share * walk / 0.025, (1.0 - share) * walk);
        let k = ((1.0 - share) / 0.1f32).ln() / 0.075;
        let ks = std::f32::consts::LN_10 / 0.09;
        let mut h = Vec2::ZERO;
        let mut speeds = Vec::new();
        for _ in 0..24 {
            h = walk_step(h, Vec2::new(0.0, -walk), a, g, k, ks, 1.0);
            speeds.push(h.length());
        }
        assert!((speeds[2] - share * walk).abs() < 0.05, "the burst by 25 ms: {speeds:?}");
        let t90 = speeds.iter().position(|&s| s >= 0.9 * walk).unwrap() + 1;
        assert!((11..=13).contains(&t90), "90% at step {t90}");
        let mut stops = 0;
        while h.length() > 0.1 * walk {
            h = walk_step(h, Vec2::ZERO, a, g, k, ks, 1.0);
            stops += 1;
        }
        assert!((10..=12).contains(&stops), "under 10% in {stops} steps");
    }
}
