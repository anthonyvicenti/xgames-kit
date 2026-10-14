//! Animation for crowds: forge-ai replaces the core's `core.anim` (as track F replaces `core.move`) with the same
//! system, except that an enemy's pose is evaluated every other step, half the crowd on each (players' and every other
//! animated entity's every step, as before). Every animator's clock and springs still advance each step; the palette
//! keeps an enemy's last pose in place between its evaluations (the layout is the core's: every animated entity in
//! entity order), and when the layout changes (a spawn, a despawn) everyone is evaluated that step. The renderer draws
//! at 60 Hz, so a drawn pose is never more than one 120 Hz step old; hurtboxes ride bones at most 8 ms stale.
//! Measured in the browser at 4× CPU throttle with 30 enemies: `core.anim` 543 µs a step before this (research/
//! gf-forge/evidence: track A).
use forge_core::hecs::Entity;
use forge_core::sim::{Animated, Sim};
use forge_core::STEP;

use crate::enemy::Enemy;

/// The last step's palette layout: (entity bits, bone count) in order.
#[derive(Default)]
pub struct Layout(pub Vec<(u64, u32)>);

pub fn system(sim: &mut Sim) {
    let step = sim.time.step;
    let lib = &sim.anim.library;
    let poses = &mut sim.anim.poses;
    let mut list: Vec<(Entity, u32, bool)> = sim.world.query::<(Entity, &Animated, Option<&Enemy>)>().iter().map(|(e, a, en)| (e, a.animator.bone_count(lib) as u32, en.is_some())).collect();
    list.sort_by_key(|(e, ..)| e.to_bits());
    let layout: Vec<(u64, u32)> = list.iter().map(|(e, n, _)| (e.to_bits().get(), *n)).collect();
    let same = sim.res.get::<Layout>().is_some_and(|l| l.0 == layout);
    let total: u32 = list.iter().map(|(_, n, _)| *n).sum();
    poses.resize(total as usize);
    let mut base = 0u32;
    for (k, (e, n, enemy)) in list.iter().enumerate() {
        if let Ok(mut a) = sim.world.get::<&mut Animated>(*e) {
            a.base = base;
            a.count = *n;
            a.animator.advance(STEP);
            if !enemy || !same || (step + k as u64) % 2 == 0 {
                a.animator.evaluate(lib, poses, base as usize);
            }
        }
        base += n;
    }
    sim.res.insert(Layout(layout));
}
