//! Target dummies: static bodies with a humanoid's hit regions on the enemies' side (kind `kinds::TARGET`), for the feel
//! room and the fixtures. A dummy is shot, flashes, takes damage numbers, breaks into debris and stands again after its
//! `every` seconds (`op::DUMMY`). It has a kinematic capsule, so the player bumps into it and flying pieces knock it.
use forge_core::cmd;
use forge_core::components::*;
use forge_core::glam::{Quat, Vec3};
use forge_core::hecs::Entity;
use forge_core::physics::{groups, Shape};
use forge_core::sim::Sim;
use forge_core::STEP;

use crate::kinds;

/// Where a dummy stands and comes back: (at, yaw, hit points, seconds before it stands again (0: never), its entity
/// now, seconds left).
#[derive(Clone, Debug, Default)]
pub struct Dummies {
    pub list: Vec<(Vec3, f32, f32, f32, Option<Entity>, f32)>,
}

/// The hit regions of a 1.8 m humanoid standing at the origin (no bones: they move with the body), scaled to `h`.
pub fn regions(h: f32) -> Vec<HurtRegion> {
    let s = h / 1.8;
    let r = |part: Part, a: [f32; 3], b: [f32; 3], radius: f32, crit: bool| HurtRegion { part, bone: NO_BONE, a: Vec3::from(a) * s, b: Vec3::from(b) * s, radius: radius * s, damage: if crit { 2.0 } else { 1.0 }, crit };
    vec![
        r(Part::Pelvis, [0.0, 0.86, 0.0], [0.0, 0.98, 0.0], 0.16, false),
        r(Part::Torso, [0.0, 1.06, 0.0], [0.0, 1.38, 0.0], 0.2, false),
        r(Part::Head, [0.0, 1.57, 0.0], [0.0, 1.69, 0.0], 0.115, true),
        r(Part::UpperArmL, [-0.24, 1.42, 0.0], [-0.3, 1.13, 0.0], 0.06, false),
        r(Part::ForearmL, [-0.3, 1.13, 0.0], [-0.33, 0.86, 0.0], 0.055, false),
        r(Part::UpperArmR, [0.24, 1.42, 0.0], [0.3, 1.13, 0.0], 0.06, false),
        r(Part::ForearmR, [0.3, 1.13, 0.0], [0.33, 0.86, 0.0], 0.055, false),
        r(Part::ThighL, [-0.1, 0.84, 0.0], [-0.11, 0.48, 0.0], 0.08, false),
        r(Part::ShinL, [-0.11, 0.48, 0.0], [-0.11, 0.08, 0.0], 0.065, false),
        r(Part::ThighR, [0.1, 0.84, 0.0], [0.11, 0.48, 0.0], 0.08, false),
        r(Part::ShinR, [0.11, 0.48, 0.0], [0.11, 0.08, 0.0], 0.065, false),
    ]
}

/// A dummy now: → its entity.
pub fn spawn(sim: &mut Sim, at: Vec3, yaw: f32, hp: f32) -> Entity {
    let e = sim.spawn_actor(kinds::TARGET, 0, at, yaw);
    let mut hb = Hurtbox::new(regions(1.8), groups::ENEMY);
    forge_core::hurtbox::place(&mut hb, Transform::facing(at, yaw).matrix(), &[]);
    let body = sim.physics.add_kinematic(e, Shape::Capsule { half_height: 0.6, radius: 0.3 }, at + Vec3::Y * 0.9, Quat::IDENTITY, groups::ENEMY);
    crate::kills::awake(sim, &body);
    let _ = sim.world.insert(e, (Health::new(hp.max(1.0)), Team::ENEMIES, hb, body));
    e
}

/// op::DUMMY: (floats) x, y, z, yaw, hit points, seconds before it stands again.
pub fn cmd_dummy(sim: &mut Sim, r: &cmd::Record) {
    let at = Vec3::new(r.f(0), r.f(1), r.f(2));
    let (yaw, hp, every) = (r.f(3), if r.f(4) > 0.0 { r.f(4) } else { 60.0 }, r.f(5).max(0.0));
    let e = spawn(sim, at, yaw, hp);
    sim.res.entry::<Dummies>().list.push((at, yaw, hp, every, Some(e), 0.0));
}

/// Dummies that broke stand again after their time; the standing ones are posed again every step (a kinematic body that
/// sits idle drops out of rapier 0.36's active islands, and a piece of debris striking it then trips rapier's checks).
pub fn feel_dummies(sim: &mut Sim) {
    let Some(mut d) = sim.res.remove::<Dummies>() else { return };
    for (at, _, _, _, ent, _) in d.list.iter() {
        if let Some(b) = ent.and_then(|e| sim.world.get::<&forge_core::physics::Body>(e).ok().map(|b| *b)) {
            sim.physics.set_kinematic(&b, *at + Vec3::Y * 0.9, Quat::IDENTITY);
        }
    }
    for (at, yaw, hp, every, ent, left) in d.list.iter_mut() {
        if let Some(e) = *ent {
            let gone = !sim.world.contains(e) || sim.world.get::<&Health>(e).map(|h| h.dead).unwrap_or(true);
            if gone {
                *ent = None;
                *left = if *every > 0.0 { *every } else { f32::INFINITY };
            }
            continue;
        }
        *left -= STEP;
        if *left <= 0.0 {
            *ent = Some(spawn(sim, *at, *yaw, *hp));
        }
    }
    sim.res.insert(d);
}
