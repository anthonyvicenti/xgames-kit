//! forge-ai: gf-forge's enemies and encounters (track A, research/rust-engine/PLAN.md §4), plugged into forge-core's
//! schedule (research/gf-forge/core/ARCHITECTURE.md), every number from the tables (`spec.forge.enemies`, `waves`).
//!
//! | Module | What |
//! |---|---|
//! | `defs` | table rows → typed enemy types and waves (the kit's archetype defaults, held equal by a test) |
//! | `nav` | the walkable grid from the static world, flow fields per target, grid line of sight |
//! | `enemy` | the archetypes' state machines: arrival, chase, tokens, tells, attacks, recovery, reactions, the shield, the brute's slam, the boss's phases; crowd separation, stuck recovery |
//! | `projectile` | casters' orbs |
//! | `director` | the waves: spawn mix and pacing, emerge points, wave rule events, the reward pause, the boss wave |
//! | `elite` | wave 7: elites (burning, armoured, splitting, fast) from a lap or a wave on; burns and fire on the ground |
//! | `bots` | forge bot players (their Control and Look, as an INPUT command writes them) |
//! | `anim` | `core.anim` replaced: enemies' poses evaluated every other step, staggered (a crowd's animation cost halved) |
//! | `view` | the AI view: eye glow, flash, state, flags per enemy; the director and the boss bar |
//! | `fixture` | the AI fixture runner (research/gf-forge/fixtures/ai) |
//! | `profile` | QA only: time per system per step, forge-ai's and the core's a crowd costs (forge-web `ai_profile`) |
//!
//! **Systems** (`SYSTEMS`): `ai.bots` (Input), `ai.director`, `ai.enemies`, `ai.projectiles`, `ai.elites` (Ai),
//! `ai.view` (Post);
//! and `core.anim` replaced by `anim::system` (the same, with enemies' poses every other step).
//!
//! **Commands** (A's ops 96..=127; host.cmd.raw(op, ints, floats)):
//!
//! | op | name | ints | floats |
//! |---|---|---|---|
//! | 96 | SPAWN | row, [no emerge: 1], [elite modifier 1-4: wave 7] | x, y, z, yaw |
//! | 97 | ARENA | — | min x, min z, max x, max z, cell (the nav grid's bounds) |
//! | 98 | MOUND | — | x, y, z (an emerge point; no floats: clear them) |
//! | 99 | DIRECTOR | action (0 stop and clear, 1 start, 2 resume after a reward, 3 skip to, 4 pause), wave, [lap] | — |
//! | 100 | BOT | player id, enabled, mode, aim given, press, hold | skill, goal x y z, stop, aim x y z |
//! | 101 | CLEAR | — | — (every enemy and projectile despawned) |
//! | 102 | KNOCK | net id | dir x y z, seconds (knock an enemy down) |
//! | 103 | EMERGE | row, count | (rise at emerge points near the players, as the director does) |
//! | 104 | ELITE | modifier (0: none, clears what is queued; 1 burning, 2 armoured, 3 splitting, 4 fast), count | — (QA: the director's next `count` arrivals rise with it) |
//!
//! **Events out** (A's custom kinds 40..=47, 14 words): 40 STATE [net, state, arch, previous] · 41 KNOCK [player id, dir
//! xyz, speed, seconds]: an attack knocks a player down (track F's controller honours it; fair play: at most one a
//! player per 3 s, at most 0.8 s) · 42 (unused) · 43 WAVE [what (1 start, 2 cleared, 4 all done, 5 reward), wave, waves,
//! enemies] · 44 TELL [net, move (1 lunge, 2 cast, 3 slam, 4 combo, 5 charge, 6 summon), seconds, x y z, target] ·
//! 45 KNOCK_REQUEST, in: [net, dir xyz, seconds] (another crate asks the AI to knock an enemy down).
//! Rule events for rules.js: wave-start, wave-clear, wave-reward, waves-done, enemy-down, boss-arrive, boss-phase,
//! boss-summon, boss-down, shield-break, guard-down (director.rs and enemy.rs say what each carries); wave 7: elite,
//! burning, elite-split (elite.rs).
//!
//! **What others honour:** weapons multiply damage by the trace's region multiplier (`TraceHit::damage`: the shield
//! region is `shield.block`) and pass the trace to `Sim::damage` (the HIT carries the region); a kill's debris comes
//! from track F on KILL while the body stays 0.15 s flagged DEAD; R draws `view` (eye glow, flash, orb lights).
pub mod anim;
pub mod bots;
pub mod defs;
pub mod director;
pub mod elite;
pub mod enemy;
pub mod fixture;
pub mod nav;
pub mod profile;
pub mod projectile;
pub mod view;

use forge_core::glam::{Vec2, Vec3};
use forge_core::schedule::Stage;
use forge_core::sim::Sim;
use forge_core::{Core, Plugin};

pub use defs::{Arch, Def, Roster, WaveDef};
pub use enemy::{BossBar, Enemy, State, Tokens};

/// A's command ops (`forge_core::cmd::AI_OPS`, 96..=127).
pub const OP_SPAWN: u32 = 96;
pub const OP_ARENA: u32 = 97;
pub const OP_MOUND: u32 = 98;
pub const OP_DIRECTOR: u32 = 99;
pub const OP_BOT: u32 = 100;
pub const OP_CLEAR: u32 = 101;
pub const OP_KNOCK: u32 = 102;
pub const OP_EMERGE: u32 = 103;
pub const OP_ELITE: u32 = 104;

/// A's event kinds (`Event::Custom`, 40..=47).
pub const EV_STATE: u32 = 40;
pub const EV_KNOCK: u32 = 41;
pub const EV_WAVE: u32 = 43;
pub const EV_TELL: u32 = 44;
pub const EV_KNOCK_REQUEST: u32 = 45;

/// Every system, its stage and name (a fixture wraps them to time them).
pub const SYSTEMS: [(Stage, &str, fn(&mut Sim)); 6] = [
    (Stage::Input, "ai.bots", bots::system),
    (Stage::Ai, "ai.director", director::system),
    (Stage::Ai, "ai.enemies", enemy::system),
    (Stage::Ai, "ai.projectiles", projectile::system),
    (Stage::Ai, "ai.elites", elite::system),
    (Stage::Post, "ai.view", view::system),
];

pub struct AiPlugin;

impl Plugin for AiPlugin {
    fn name(&self) -> &'static str {
        "ai"
    }
    fn install(&self, core: &mut Core) {
        for (stage, name, f) in SYSTEMS {
            core.schedule.add(stage, name, f);
        }
        // the core's animation, with enemies' poses every other step (anim.rs)
        core.schedule.replace("core.anim", anim::system);
        core.on_command(OP_SPAWN, "ai.spawn", |sim, r| {
            let row = r.u(0) as u16;
            // SPAWN: ints [row] (or [row, 1] for no rise; wave 7: [row, rise, elite]), floats [x, y, z, yaw]; wave 1a's
            // stub sent [row] + floats
            let (fl, emerge, elite) = if r.len() >= 7 { (3, r.u(1) == 0, r.u(2) as u8) } else if r.len() >= 6 { (2, r.u(1) == 0, 0) } else { (1, true, 0) };
            let at = Vec3::new(r.f(fl), r.f(fl + 1), r.f(fl + 2));
            let yaw = r.f(fl + 3);
            let e = spawn(sim, row, at, yaw, emerge);
            if elite != 0 {
                make_elite(sim, e, row, elite::Mod::from_u8(elite));
            }
        });
        core.on_command(OP_ARENA, "ai.arena", |sim, r| {
            let nav = sim.res.entry::<nav::Nav>();
            nav.set_bounds(Vec2::new(r.f(0), r.f(1)), Vec2::new(r.f(2), r.f(3)), if r.f(4) > 0.0 { r.f(4) } else { 0.5 });
        });
        core.on_command(OP_MOUND, "ai.mound", |sim, r| {
            let d = sim.res.entry::<director::Director>();
            if r.len() >= 3 {
                d.mounds.push(Vec3::new(r.f(0), r.f(1), r.f(2)));
            } else {
                d.mounds.clear();
            }
        });
        core.on_command(OP_DIRECTOR, "ai.director", |sim, r| director::command(sim, r.u(0), r.u(1), if r.len() >= 3 { r.u(2) } else { 0 }));
        core.on_command(OP_ELITE, "ai.elite", |sim, r| {
            let (m, n) = (elite::Mod::from_u8(r.u(0) as u8), if r.len() >= 2 { r.u(1).clamp(1, 64) } else { 1 });
            let st = sim.res.entry::<elite::EliteState>();
            if m == elite::Mod::None {
                st.force.clear();
            } else {
                st.force.extend(std::iter::repeat_n(m, n as usize));
            }
        });
        core.on_command(OP_BOT, "ai.bot", bots::command);
        core.on_command(OP_CLEAR, "ai.clear", |sim, _| director::clear(sim));
        core.on_command(OP_KNOCK, "ai.knock", |sim, r| {
            sim.res.entry::<enemy::Requests>().knocks.push((r.u(0), Vec3::new(r.f(1), r.f(2), r.f(3)), r.f(4)));
        });
        core.on_command(OP_EMERGE, "ai.emerge", |sim, r| {
            let (row, count) = (r.u(0) as u16, r.u(1).clamp(1, 64));
            for _ in 0..count {
                let nav = sim.res.take::<nav::Nav>();
                let at = director::spawn_point(sim, &nav, 7.0, 10.0);
                sim.res.insert(nav);
                spawn(sim, row, at, 0.0, true);
            }
        });
        core.on_tables("ai.roster", |sim| {
            let r = Roster::load(&sim.tables);
            sim.res.insert(r);
        });
    }
}

/// Spawn an enemy of table row `row` (the chaser's defaults when the tables have no such row), facing the nearest
/// player when `yaw` is 0.
pub fn spawn(sim: &mut Sim, row: u16, at: Vec3, yaw: f32, emerge: bool) -> forge_core::hecs::Entity {
    let def = sim.res.get::<Roster>().map(|r| r.def(row).into_owned()).unwrap_or_else(|| Def::base(Arch::Chaser));
    let yaw = if yaw == 0.0 {
        enemy::targets(sim).into_iter().filter(|t| t.alive).min_by(|a, b| a.pos.distance_squared(at).total_cmp(&b.pos.distance_squared(at))).map(|t| enemy::yaw_of(enemy::h(t.pos) - enemy::h(at))).unwrap_or(0.0)
    } else {
        yaw
    };
    enemy::spawn(sim, &def, row, at, yaw, emerge, None)
}

/// An enemy raised by hand (OP_SPAWN's elite) made an elite with modifier `m`: as the director's would rise at this lap
/// (its health set again from the elite's type).
pub fn make_elite(sim: &mut Sim, e: forge_core::hecs::Entity, row: u16, m: elite::Mod) {
    if m == elite::Mod::None {
        return;
    }
    let lap = sim.res.get::<director::Director>().map(|d| d.lap).unwrap_or(0);
    let Some(ix) = sim.res.get_mut::<Roster>().map(|r| r.variant(row, lap, m, false)) else { return };
    let (hp, scale) = sim.res.get::<Roster>().map(|r| { let d = r.by_index(ix); (d.health, d.scale) }).unwrap_or((30.0, 1.0));
    if let Ok(mut en) = sim.world.get::<&mut enemy::Enemy>(e) {
        en.def = ix;
    }
    if let Ok(mut h) = sim.world.get::<&mut forge_core::components::Health>(e) {
        h.max = hp;
        h.hp = hp;
    }
    if let Ok(mut t) = sim.world.get::<&mut forge_core::components::Transform>(e) {
        t.scale = scale;
    }
    elite::raised(sim, e, row, m, false);
}

#[cfg(test)]
mod tests;
#[cfg(test)]
mod elite_tests;
