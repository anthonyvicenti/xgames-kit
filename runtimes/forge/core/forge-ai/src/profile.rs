//! A profiler for QA (off unless asked): wraps forge-ai's systems and the core's systems a crowd costs (animation,
//! hurtboxes, the character controller, the rapier step) so each step's time in them adds up in `Profile`, with a
//! clock the host gives (performance.now in the browser: forge-web `ai_profile`; Instant natively). Wrapping keeps
//! each system's name, place and code; only the time around it is taken.
use std::collections::BTreeMap;

use forge_core::schedule::Stage;
use forge_core::sim::Sim;
use forge_core::Core;

/// Milliseconds spent per system name, and the steps counted.
#[derive(Default, Debug, Clone)]
pub struct Profile {
    pub steps: u64,
    pub ms: BTreeMap<&'static str, f64>,
}

/// The core's systems a crowd costs, wrapped beside forge-ai's own.
const CORE: [(&str, fn(&mut Sim)); 4] = [
    ("core.character", forge_core::systems::core_character),
    ("core.physics", forge_core::systems::core_physics),
    ("core.anim", crate::anim::system),
    ("core.hurtboxes", forge_core::systems::core_hurtboxes),
];

/// Wrap the systems with `clock` (milliseconds). Again after it is installed: nothing more.
pub fn install(core: &mut Core, clock: fn() -> f64) {
    if core.schedule.has("ai.profile.step") {
        return;
    }
    core.schedule.add(Stage::Input, "ai.profile.step", |sim: &mut Sim| sim.res.entry::<Profile>().steps += 1);
    let list = crate::SYSTEMS.iter().map(|(_, n, f)| (*n, *f)).chain(CORE.iter().map(|(n, f)| (*n, *f)));
    for (name, f) in list {
        core.schedule.replace(name, move |sim: &mut Sim| {
            let t0 = clock();
            f(sim);
            let dt = clock() - t0;
            *sim.res.entry::<Profile>().ms.entry(name).or_default() += dt;
        });
    }
}

/// The profile as JSON (µs per step per system, the AI's sum, the steps) and a fresh one started.
pub fn take(sim: &mut Sim) -> String {
    let p = sim.res.take::<Profile>();
    let steps = p.steps.max(1) as f64;
    let per: BTreeMap<&str, f64> = p.ms.iter().map(|(k, v)| (*k, (v * 1000.0 / steps * 100.0).round() / 100.0)).collect();
    let ai: f64 = p.ms.iter().filter(|(k, _)| k.starts_with("ai.")).map(|(_, v)| v).sum::<f64>() * 1000.0 / steps;
    let all: f64 = p.ms.values().sum::<f64>() * 1000.0 / steps;
    forge_core::serde_json::json!({ "steps": p.steps, "usPerStep": per, "aiUsPerStep": (ai * 100.0).round() / 100.0, "wrappedUsPerStep": (all * 100.0).round() / 100.0 }).to_string()
}
