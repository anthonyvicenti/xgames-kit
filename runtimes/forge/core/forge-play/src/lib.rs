//! forge-play: gf-forge's tracks together (the wave 1b integration; research/gf-forge/INTEGRATION.md).
//!
//! forge-feel (track F) and forge-ai (track A) each plug into forge-core alone and never name each other. Most of what
//! one owes the other already flows through the core: a weapon's `Sim::damage` is the HIT and KILL forge-ai reacts to in
//! the same step (the Feel stage runs before the Ai stage), an enemy's `Sim::damage` on a player is the health forge-feel's
//! hurt path reads, and a bot's `Control` is the input forge-feel's controller and weapons play. Two things did not
//! meet, because each track gave its own event its own number and shape:
//!
//! | From | Event | To | Here |
//! |---|---|---|---|
//! | forge-ai | `EV_KNOCK` 41 [player, dir xyz, speed, seconds]: a slam or a charge knocks a player down | forge-feel's controller, which owns the player's velocity and had no knock-down | `play.knocks` (Physics, before `feel.push`): `forge_feel::controller::knock` |
//! | forge-feel | `ev::KNOCK` 35 [target, seconds, dir xyz, by]: a flying piece knocks an enemy down (and severs a limb) | forge-ai, which listens for its own `EV_KNOCK_REQUEST` 45 in the Ai stage, a stage before this one is emitted | `play.requests` (Events, after `feel.debris`): `forge_ai::enemy::Requests`, read by the next step's Ai stage |
//!
//! And one thing neither track had, which live co-op needs: **a joiner's copy of the host's enemies played no clip**
//! (forge-ai animates what it simulates; a replica is the host's). `play.replicas` (Post, before the animation) plays
//! each replica enemy's clip for the state the host's snapshot byte says (rise, chase, tell, attack, down, …), from its
//! type's clip names, so a friend's screen shows the same fight and not bodies sliding in their bind pose.
//!
//! `install` adds the feel plugin, the AI plugin and this one, in that order: forge-web and the native tests of the
//! tracks together both call it, so what a browser plays is what `cargo test -p forge-play` plays.
use forge_core::components::{kind, Kind, Player, Replica};
use forge_core::events::Event;
use forge_core::forge_anim::{Layer, Play};
use forge_core::glam::Vec3;
use forge_core::hecs::Entity;
use forge_core::schedule::Stage;
use forge_core::sim::{Animated, Sim};
use forge_core::snapshot::SnapByte;
use forge_core::{Core, Plugin};

pub struct PlayPlugin;

impl Plugin for PlayPlugin {
    fn name(&self) -> &'static str {
        "play"
    }
    fn install(&self, core: &mut Core) {
        let s = &mut core.schedule;
        // an enemy's knock (this step's Ai stage) becomes the player's knock-down and push before the character moves
        if !s.add_before("feel.push", "play.knocks", knocks) {
            s.add_before("core.character", "play.knocks", knocks);
        }
        // a flying piece's knock (feel.debris, this step's Events stage) waits in forge-ai's requests for its next step
        if !s.add_after("feel.debris", "play.requests", requests) {
            s.add(Stage::Events, "play.requests", requests);
        }
        // a joiner's copies of the host's enemies play the clip of the state the host says, before the poses are made
        if !s.add_before("core.anim", "play.replicas", replicas) {
            s.add(Stage::Post, "play.replicas", replicas);
        }
        // wave 2: a joiner's copies of the host's enemies get a body its own player bumps into, as on the host
        if !s.add_before("core.replicas", "play.bodies", bodies) {
            s.add(Stage::Post, "play.bodies", bodies);
        }
        // wave 7: a joiner's copies of the host's enemies are drawn at their type's size (a split elite's young smaller)
        if !s.add_before("core.anim", "play.sizes", sizes) {
            s.add(Stage::Post, "play.sizes", sizes);
        }
        // wave 7 (track P): the pedlar's prices read the wave director's lap
        s.add(Stage::Input, "play.lap", lap);
        // forge-feel's controller moves a knocked player (on the player's own step in co-op): forge-ai only says it
        core.sim.res.insert(forge_ai::enemy::KnockByEvent);
    }
}

/// The state a replica enemy's clip was last chosen for (this crate's component on a joiner's copies).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Shown(pub u8);

/// A joiner's copies of the host's enemies (replicas the host animates on its own copy only): each plays the clip its
/// type names for the state in the host's snapshot byte, chosen again when the state changes. The same root pinning
/// forge-ai plays its own with (no clip lifts or carries a body: the snapshots move it).
pub fn replicas(sim: &mut Sim) {
    use forge_ai::State;
    let list: Vec<(Entity, u16, u8)> = sim
        .world
        .query::<(Entity, &Kind, &SnapByte, &Animated, Option<&Shown>)>()
        .with::<&Replica>()
        .iter()
        .filter(|(_, k, sb, _, shown)| k.kind == kind::ENEMY && shown.is_none_or(|s| s.0 != sb.0 & 31))
        .map(|(e, k, sb, ..)| (e, k.type_, sb.0 & 31))
        .collect();
    if list.is_empty() {
        return;
    }
    let Some(roster) = sim.res.get::<forge_ai::Roster>() else { return };
    let lib = &sim.anim.library;
    let mut shown = Vec::with_capacity(list.len());
    for (e, row, state) in list {
        let def = roster.def(row);
        let c = &def.clips;
        // (the clip, looping, held on its last frame)
        let (clip, looping, hold): (&str, bool, bool) = match State::from_u8(state) {
            State::Arrive => (&c.arrive, false, true),
            State::Idle | State::Wait | State::Hold => (&c.idle, true, false),
            State::Chase => (&c.move_, true, false),
            State::Tell => (&c.tell, false, true),
            State::Attack => (&c.attack, false, true),
            State::Recover => (&c.recover, false, true),
            State::Stagger => (&c.hit[0], false, true),
            State::Down => (&c.fall, false, true),
            State::Rise => (&c.rise, false, true),
            State::Roar => (&c.roar, false, true),
            State::Dead => (&c.die, false, true),
        };
        if let Ok(mut a) = sim.world.get::<&mut Animated>(e) {
            a.animator.pin_xz = true;
            a.animator.play(lib, clip, Play { fade: 0.12, looping: Some(looping), rate: 1.0, layer: Some(Layer::Base), restart: !looping, hold, max_rise: Some(0.12) });
        }
        shown.push((e, state));
    }
    for (e, state) in shown {
        let _ = sim.world.insert_one(e, Shown(state));
    }
}

/// A joiner's copies of the host's enemies (wave 2; INTEGRATION.md mismatch 16): each gets the capsule its type has
/// on the host, so the joiner's own player is stopped by an enemy in its prediction as the host stops it (it walked
/// through them and was pulled back). `core.replicas` places the capsule where the host will have the enemy when it
/// replays the joiner's step (forge-core systems.rs); nothing here simulates the enemy.
pub fn bodies(sim: &mut Sim) {
    let list: Vec<(Entity, u16)> = sim.world.query::<(Entity, &Kind)>().with::<&Replica>().without::<&forge_core::physics::Body>().iter().filter(|(_, k)| k.kind == kind::ENEMY).map(|(e, k)| (e, k.type_)).collect();
    if list.is_empty() {
        return;
    }
    let sizes: Vec<(Entity, f32, f32)> = match sim.res.get::<forge_ai::Roster>() {
        Some(r) => list.iter().map(|(e, row)| { let d = r.def(*row); (*e, d.radius, d.height) }).collect(),
        None => return,
    };
    for (e, radius, height) in sizes {
        sim.add_character(e, radius, height, forge_core::physics::groups::ENEMY);
    }
}

/// A joiner's copies of the host's enemies (wave 7): drawn at their type's `scale` as the host draws them (a replica
/// was drawn at 1: a chaser 10% smaller than on the host), and a split elite's young (its snapshot mark, forge-ai
/// `elite::CHILD`) at the elites table's `splitting.scale` of that. Each step: a few multiplications a replica.
pub fn sizes(sim: &mut Sim) {
    let Some(roster) = sim.res.get::<forge_ai::Roster>() else { return };
    for (k, t, m) in sim.world.query_mut::<(&Kind, &mut forge_core::components::Transform, Option<&forge_core::components::Marked>)>().with::<&Replica>() {
        if k.kind == kind::ENEMY {
            let young = m.is_some_and(|m| m.mark & forge_ai::elite::CHILD != 0);
            t.scale = roster.defs.get(k.type_ as usize).map(|d| d.scale).unwrap_or(1.0) * if young { roster.elites.split_scale } else { 1.0 };
        }
    }
}

/// The wave director's lap → forge-feel's cart, whose prices read it (`shop::set_lap`: the host's; a joiner's copy has
/// no director and takes the lap from the snapshot's bytes).
pub fn lap(sim: &mut Sim) {
    if let Some(l) = sim.res.get::<forge_ai::director::Director>().map(|d| d.lap) {
        forge_feel::shop::set_lap(sim, l);
    }
}

/// The whole game core's plugins, in the order they need: the feel, the AI, then what joins them. → false when one
/// was there already.
pub fn install(core: &mut Core) -> bool {
    core.add_plugin(&forge_feel::FeelPlugin) & core.add_plugin(&forge_ai::AiPlugin) & core.add_plugin(&PlayPlugin)
}

fn f(w: u32) -> f32 {
    let v = f32::from_bits(w);
    if v.is_finite() { v } else { 0.0 }
}

/// forge-ai's knocks on players this step → forge-feel's knock-down (no control for its seconds, the eyes drop and
/// tip) and its push, which the character controller resolves against the world.
pub fn knocks(sim: &mut Sim) {
    let list: Vec<(u32, Vec3, f32, f32)> = sim
        .events
        .step_events()
        .filter_map(|e| match e {
            Event::Custom { kind, words } if *kind == forge_ai::EV_KNOCK => Some((words[0], Vec3::new(f(words[1]), f(words[2]), f(words[3])), f(words[4]), f(words[5]))),
            _ => None,
        })
        .collect();
    for (id, dir, speed, secs) in list {
        let Some(&e) = sim.players.get(&id) else { continue };
        // only where the player is simulated (the host for everyone; never a joiner's replica of a friend)
        if !sim.world.get::<&Player>(e).is_ok_and(|p| p.owned) {
            continue;
        }
        forge_feel::controller::knock(sim, e, dir, speed, secs);
    }
}

/// forge-feel's knocks on enemies this step (a kill's flying pieces) → forge-ai's requests: its next Ai stage stops the
/// enemy's attack and lays it down for the knock's seconds (its `fall` clip, then `rise`). A severed limb comes with a
/// knock, so the knock carries both.
pub fn requests(sim: &mut Sim) {
    let list: Vec<(u32, Vec3, f32)> = sim
        .events
        .step_events()
        .filter_map(|e| match e {
            Event::Custom { kind, words } if *kind == forge_feel::ev::KNOCK => Some((words[0], Vec3::new(f(words[2]), f(words[3]), f(words[4])), f(words[1]))),
            _ => None,
        })
        .collect();
    if list.is_empty() {
        return;
    }
    sim.res.entry::<forge_ai::enemy::Requests>().knocks.extend(list);
}
