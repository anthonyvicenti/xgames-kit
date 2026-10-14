//! Aim help (a setting per player; `feel.aimAssist` says who gets it: by default players on a touch screen). With it a
//! shot bends toward the nearest enemy region within `cone` degrees of the aim and `range` metres with a clear line (the
//! help a thumb needs), and the look turns toward it at `pull` (a share of the gap a second) while it stays in the cone.
//! The host tells the core which input a player uses (`op::SETTINGS`).
use forge_core::cmd;
use forge_core::components::*;
use forge_core::glam::Vec3;
use forge_core::hecs::Entity;
use forge_core::physics::{groups, QueryMask};
use forge_core::sim::Sim;
use forge_core::STEP;

use crate::controller::{ensure_pilots, forward, Pilot};

/// The best target for an aim: the region centre with the smallest angle from it, inside the cone and range, with a
/// clear line. → (direction to it, its angle).
pub fn target(sim: &Sim, e: Entity, eye: Vec3, aim: Vec3, cone: f32, range: f32) -> Option<(Vec3, f32)> {
    let mut best: Option<(Vec3, f32, f32)> = None;
    for (t, hb, hp) in sim.world.query::<(Entity, &Hurtbox, &Health)>().iter() {
        if t == e || hp.dead || hb.group & groups::ENEMY == 0 {
            continue;
        }
        for (r, (a, b)) in hb.regions.iter().zip(hb.world.iter()) {
            if r.radius <= 0.0 {
                continue;
            }
            let c = (*a + *b) * 0.5;
            let to = c - eye;
            let d = to.length();
            if d > range || d < 0.05 {
                continue;
            }
            let ang = aim.angle_between(to / d);
            if ang <= cone && best.is_none_or(|x| ang < x.1) {
                best = Some((to / d, ang, d));
            }
        }
    }
    let (dir, ang, dist) = best?;
    // a clear line to it: no wall nearer than the region
    if sim.physics.cast_ray(eye, dir, (dist - 0.2).max(0.01), QueryMask::new(groups::WORLD)).is_some_and(|w| w.entity.is_none()) {
        return None;
    }
    Some((dir, ang))
}

/// The aim a shot takes: bent onto the best target for a player with aim help.
pub fn assist(sim: &Sim, e: Entity, eye: Vec3, aim: Vec3, range: f32) -> Vec3 {
    let on = sim.world.get::<&Pilot>(e).map(|p| p.assist).unwrap_or(false);
    if !on {
        return aim;
    }
    let cfg = crate::cfg(sim);
    match target(sim, e, eye, aim, cfg.feel.aim.cone.to_radians(), cfg.feel.aim.range.min(range)) {
        Some((dir, _)) => dir,
        None => aim,
    }
}

/// The look turns toward a target in the cone, for players with aim help.
pub fn feel_aim(sim: &mut Sim) {
    let cfg = crate::cfg(sim);
    let a = &cfg.feel.aim;
    if a.pull <= 0.0 {
        return;
    }
    let eye_h = sim.tables.player.eye;
    let who: Vec<(Entity, Vec3, f32, f32)> = sim.world.query::<(Entity, &Player, &Pilot, &Transform, &Look, &Control)>().iter().filter(|(_, p, pi, ..)| p.owned && pi.assist && !pi.dead).filter(|(.., c)| c.enabled).map(|(e, _, _, t, l, _)| (e, t.pos + Vec3::Y * eye_h, l.yaw, l.pitch)).collect();
    for (e, eye, yaw, pitch) in who {
        let aim = forward(yaw, pitch);
        let Some((dir, _)) = target(sim, e, eye, aim, a.cone.to_radians(), a.range) else { continue };
        let want_yaw = (-dir.x).atan2(-dir.z);
        let want_pitch = dir.y.clamp(-1.0, 1.0).asin();
        let k = 1.0 - (-a.pull * STEP).exp();
        if let Ok(mut l) = sim.world.get::<&mut Look>(e) {
            let dy = forge_core::wrap(want_yaw - l.yaw);
            l.yaw = forge_core::wrap(l.yaw + dy * k);
            l.pitch = (l.pitch + (want_pitch - l.pitch) * k).clamp(-1.45, 1.45);
        }
    }
}

/// op::SETTINGS: id, aim help (0 off, 1 a touch player, 2 a mouse player: the table says which are helped, 3 on).
pub fn cmd_settings(sim: &mut Sim, r: &cmd::Record) {
    ensure_pilots(sim);
    let cfg = crate::cfg(sim);
    let Some(&e) = sim.players.get(&r.u(0)) else { return };
    let on = match r.u(1) {
        1 => cfg.feel.aim.touch,
        2 => cfg.feel.aim.mouse,
        3 => true,
        _ => false,
    };
    if let Ok(mut p) = sim.world.get::<&mut Pilot>(e) {
        p.assist = on;
    }
}
