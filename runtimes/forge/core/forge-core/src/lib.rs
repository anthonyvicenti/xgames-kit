//! gf-forge core (research/rust-engine/PLAN.md §2; research/gf-forge/core/ARCHITECTURE.md): the simulation, with no web
//! code, no window and no GPU.
//!
//! The boundary (PLAN §2): the host makes one call a frame, `tick(dt, words)`, after writing that many words of packed
//! commands (`cmd`) into `cmds`. The core applies them, runs the fixed 120 Hz steps `dt` owes (at most 100 ms of them a
//! frame: a longer stall is dropped, never caught up in a burst), then fills the views (`views`: players, entities and
//! the camera, interpolated between the last two steps) and the events (`events_out`, 16 words each).
//!
//! Each step runs the schedule's six stages (`schedule::Stage`): input → feel → ai → physics → post → events. Other
//! crates plug in with a `Plugin` (systems by name, their own components and resources, command ops in their range,
//! a hook when the tables load) and never edit this crate.
// `!(x > 0.0)` is on purpose: a NaN from JS must read as "not positive"; query rows are tuples of components
#![allow(clippy::neg_cmp_op_on_partial_ord, clippy::type_complexity)]
pub mod cmd;
pub mod components;
pub mod crowd;
pub mod events;
pub mod fixture;
pub mod hurtbox;
pub mod names;
pub mod net;
pub mod physics;
pub mod schedule;
pub mod sim;
pub mod snapshot;
pub mod systems;
pub mod tables;
pub mod views;

use std::collections::HashMap;

pub use forge_anim;
pub use glam;
pub use hecs;
pub use rapier3d;
pub use serde_json;

use components::*;
use glam::Vec3;
use schedule::{Schedule, Stage, STAGES};
use sim::Sim;

/// The fixed step: 120 Hz (feel target 1).
pub const HZ: u32 = 120;
pub const STEP: f32 = 1.0 / HZ as f32;
/// The most simulated time one frame may owe: a longer stall drops the rest (feel target 1: a 126 ms stall advanced
/// exactly 100 ms).
pub const MAX_CATCHUP: f32 = 0.1;
/// Steps one tick may run (MAX_CATCHUP / STEP).
pub const MAX_STEPS: u32 = 12;
/// Words the command buffer holds per tick.
pub const CMD_CAPACITY: usize = 16384;
pub use views::MAX_PLAYERS;

/// Wave 0's view names (the players view; its first 12 fields kept their places).
pub mod view {
    pub use crate::views::player::*;
}

/// A crate's way in: `install` adds its systems, components, resources, command ops and hooks to the core.
/// forge-web installs forge-feel's and forge-ai's; a native fixture installs what it measures.
pub trait Plugin {
    fn name(&self) -> &'static str;
    fn install(&self, core: &mut Core);
}

/// A plugin's command: its op's record, applied at the start of the tick (before any step).
pub type CommandFn = Box<dyn FnMut(&mut Sim, &cmd::Record)>;
/// A hook run after the tables load (a plugin parses its rows into its own types here).
pub type HookFn = Box<dyn FnMut(&mut Sim)>;

pub struct Core {
    pub sim: Sim,
    pub schedule: Schedule,
    pub views: views::Views,
    /// Where the host writes a tick's commands.
    pub cmds: Vec<u32>,
    /// The last tick's events, 16 words each (`events::WORDS`).
    pub events_out: Vec<u32>,
    pub ticks: u64,
    /// Steps the last tick ran.
    pub steps_last: u32,
    /// Seconds of simulation dropped by the catch-up cap since the start.
    pub dropped: f64,
    pub snapshots: snapshot::SnapState,
    acc: f64,
    alpha: f32,
    commands: HashMap<u32, (String, CommandFn)>,
    on_tables: Vec<(String, HookFn)>,
    plugins: Vec<&'static str>,
}

impl Default for Core {
    fn default() -> Self {
        Self::new()
    }
}

impl Core {
    pub fn new() -> Self {
        let mut schedule = Schedule::default();
        // live co-op's step systems sit first in the Input stage and last in the Post stage (net.rs)
        net::install_input(&mut schedule);
        systems::install(&mut schedule);
        net::install_post(&mut schedule);
        Self {
            sim: Sim::default(),
            schedule,
            views: views::Views::default(),
            cmds: vec![0; CMD_CAPACITY],
            events_out: Vec::with_capacity(events::EVENT_CAPACITY * events::WORDS),
            ticks: 0,
            steps_last: 0,
            dropped: 0.0,
            snapshots: snapshot::SnapState::default(),
            acc: 0.0,
            alpha: 0.0,
            commands: HashMap::new(),
            on_tables: Vec::new(),
            plugins: Vec::new(),
        }
    }

    // ---- extension ----

    /// Install a plugin once (a second install of the same name does nothing). → whether it was installed.
    pub fn add_plugin(&mut self, p: &dyn Plugin) -> bool {
        if self.plugins.contains(&p.name()) {
            return false;
        }
        self.plugins.push(p.name());
        p.install(self);
        true
    }
    pub fn plugins(&self) -> &[&'static str] {
        &self.plugins
    }
    /// Handle command `op` (a plugin's, above `cmd::CORE_LAST`). → false when the op is the core's or taken.
    pub fn on_command(&mut self, op: u32, name: &str, f: impl FnMut(&mut Sim, &cmd::Record) + 'static) -> bool {
        if op <= cmd::CORE_LAST || self.commands.contains_key(&op) {
            return false;
        }
        self.commands.insert(op, (name.to_string(), Box::new(f)));
        true
    }
    /// Run `f` every time the tables load (and once now, when they already have).
    pub fn on_tables(&mut self, name: &str, mut f: impl FnMut(&mut Sim) + 'static) {
        if self.sim.tables.version > 0 {
            f(&mut self.sim);
        }
        self.on_tables.push((name.to_string(), Box::new(f)));
    }

    // ---- the tables ----

    /// Load `config/game.json → forge` (JSON). Players already in the world take the new movement and shape; plugins'
    /// hooks run after.
    pub fn load_tables(&mut self, json: &str) -> Result<(), String> {
        self.sim.tables.load(json, &mut self.sim.names)?;
        self.sim.physics.set_gravity(self.sim.tables.physics.gravity);
        self.reshape_players();
        for (_, f) in self.on_tables.iter_mut() {
            f(&mut self.sim);
        }
        Ok(())
    }

    /// Every player's capsule and controller from the player table (after a load).
    fn reshape_players(&mut self) {
        let t = self.sim.tables.player.clone();
        let list: Vec<(hecs::Entity, Vec3, physics::Body)> = self.sim.world.query::<(hecs::Entity, &Player, &Transform, &physics::Body)>().iter().map(|(e, _, tr, b)| (e, tr.pos, *b)).collect();
        for (e, feet, old) in list {
            let mut m = physics::Mover::new(t.radius, t.half_height());
            m.step_height = t.step_height;
            m.slope_max = t.slope_max.to_radians();
            m.snap = t.snap;
            m.blocks = physics::groups::PLAYER_BLOCKS;
            if let Ok(prev) = self.sim.world.get::<&physics::Mover>(e) {
                m.grounded = prev.grounded;
                m.was_grounded = prev.was_grounded;
            }
            self.sim.physics.remove(&old);
            let body = self.sim.physics.add_character(e, feet, &m, physics::groups::PLAYER);
            let _ = self.sim.world.insert(e, (m, body, Hurtbox::upright(t.radius, t.height, physics::groups::PLAYER)));
            if let Ok(mut h) = self.sim.world.get::<&mut Health>(e)
                && h.hp >= h.max {
                    *h = Health { armor: t.armor, ..Health::new(t.health) };
                }
        }
    }

    // ---- the frame ----

    /// One frame: apply `words` words of commands from `cmds`, run the fixed steps `dt` (seconds) owes, fill the
    /// views and the events. → the steps run.
    pub fn tick(&mut self, dt: f32, words: usize) -> u32 {
        let n = words.min(self.cmds.len());
        let buf: Vec<u32> = self.cmds[..n].to_vec();
        for r in cmd::records(&buf) {
            self.command(r);
        }
        let dt = if dt.is_finite() { dt.max(0.0) } else { 0.0 };
        let owed = dt.min(MAX_CATCHUP);
        self.dropped += (dt - owed) as f64;
        self.acc += owed as f64;
        let step = STEP as f64;
        let mut steps = 0;
        // a frame of exactly two steps (16.67 ms at 120 Hz) runs two, whatever the rounding
        while self.acc >= step - 1e-6 && steps < MAX_STEPS {
            self.step();
            self.acc = (self.acc - step).max(0.0);
            steps += 1;
        }
        if self.acc >= step {
            self.dropped += self.acc - self.acc % step;
            self.acc %= step;
        }
        self.alpha = (self.acc / step).clamp(0.0, 1.0) as f32;
        self.ticks += 1;
        self.steps_last = steps;
        self.views.fill(&self.sim, self.alpha);
        // a joiner remembers the particles its own copy drew, so the host's copies of them are not drawn twice (net.rs)
        if self.sim.res.get::<net::NetState>().is_some_and(|n| n.is_joiner()) {
            let now = self.sim.time.now;
            let fx: Vec<(u32, Vec3)> = self.sim.events.tick_events_flags().filter_map(|(e, f)| match e { events::Event::Particles(p) if f & events::FLAG_REMOTE == 0 => Some((p.name, p.pos)), _ => None }).collect();
            let st = self.sim.res.entry::<net::NetState>();
            for (name, pos) in fx {
                st.saw_fx(name, pos, now);
            }
        }
        self.sim.events.drain_into(&mut self.events_out);
        steps
    }

    // ---- live co-op (net.rs) ----

    /// This copy's part in a live round: `Solo`, `Host` (owns the world; queues and replays each joiner's inputs) or
    /// `Joiner` (predicts its own player `local`, shows the host's world from snapshots). `epoch`: a joiner's page load.
    /// Wave 4: `Viewer` (no player of its own: every player is the host's replica; `net_watch` puts its camera on one).
    pub fn net_role(&mut self, role: net::Role, local: u32, epoch: u32) {
        let st = self.sim.res.entry::<net::NetState>();
        if st.role != role || st.local != local || st.epoch != epoch {
            *st = net::NetState::new(role, local, epoch);
        }
        // only the copy that owns the world queues events for snapshots
        let follows = matches!(role, net::Role::Joiner | net::Role::Viewer);
        self.sim.events.authority = !follows;
        if follows {
            let _ = self.sim.events.take_net();
        }
    }
    /// A viewer: look through player `id`'s eyes (0: nobody). That replica is this copy's `local` player from the next
    /// frame on (net.rs `net.watch`); on any other role this does nothing.
    pub fn net_watch(&mut self, id: u32) {
        match self.sim.res.get_mut::<net::NetState>() {
            Some(st) if st.is_viewer() => st.watch = id,
            _ => return,
        }
        net::net_watch(&mut self.sim);
    }
    pub fn net(&self) -> Option<&net::NetState> {
        self.sim.res.get::<net::NetState>()
    }
    /// The joiner: its inputs since the last call, as one batch for the host (empty: none).
    pub fn net_take_inputs(&mut self) -> Vec<u8> {
        match self.sim.res.get_mut::<net::NetState>() {
            Some(st) if st.is_joiner() => net::take_inputs(st),
            _ => Vec::new(),
        }
    }
    /// The co-op state and the snapshots' counts, as JSON (the observation's `forge.net`).
    pub fn net_stats_json(&self) -> String {
        let s = &self.snapshots;
        let snap = format!(r#""snapshots":{{"sent":{},"lastBytes":{},"appliedTick":{},"applied":{},"stale":{},"recovered":{}}}"#, s.count, s.last_bytes, s.applied_tick, s.applied, s.stale, s.recovered);
        match self.net() {
            Some(n) => format!("{{{},{}}}", n.stats_fields(), snap),
            None => format!(r#"{{"role":"solo",{}}}"#, snap),
        }
    }
    /// The host: a joiner's batch for its player `id`. → the inputs queued.
    pub fn net_push_inputs(&mut self, id: u32, bytes: &[u8]) -> Result<usize, &'static str> {
        let st = self.sim.res.entry::<net::NetState>();
        if !st.is_host() {
            return Ok(0);
        }
        net::push_inputs(st, id, bytes)
    }

    /// One fixed step: every transform remembers where it was, then the six stages run in order.
    pub fn step(&mut self) {
        let sim = &mut self.sim;
        sim.time.step += 1;
        sim.time.now = sim.time.step as f64 * STEP as f64;
        sim.time.dt = STEP;
        sim.events.begin_step();
        for t in sim.world.query_mut::<&mut Transform>() {
            t.begin_step();
        }
        sim.physics.refresh();
        for st in STAGES {
            self.schedule.run_stage(st, &mut self.sim);
            self.sim.flush_despawns();
        }
        // a press counts for one step
        for c in self.sim.world.query_mut::<&mut Control>() {
            c.pressed = 0;
        }
        self.sim.events.end_step();
    }

    /// How far between the last two steps the views were drawn (0..1).
    pub fn alpha(&self) -> f32 {
        self.alpha
    }

    fn command(&mut self, r: cmd::Record) {
        let sim = &mut self.sim;
        match r.op {
            cmd::INPUT => {
                let Some(&e) = sim.players.get(&r.u(0)) else { return };
                let held = r.u(5);
                let enabled = r.u(6) != 0;
                // wave 0's hosts send 7 words (a jump press is a bit of `held`); v1 sends the presses as an 8th word
                let pressed = if r.len() >= 8 { r.u(7) } else if held & cmd::BTN_JUMP_PRESSED != 0 { cmd::BTN_JUMP } else { 0 };
                if let Ok(mut c) = sim.world.get::<&mut Control>(e) {
                    c.move_x = r.f(1).clamp(-1.0, 1.0);
                    c.move_z = r.f(2).clamp(-1.0, 1.0);
                    c.held = held & !cmd::BTN_JUMP_PRESSED;
                    c.enabled = enabled;
                    if enabled {
                        c.pressed |= pressed;
                    }
                }
                if enabled {
                    // looking happens at the frame rate, never held back to the next step (a downed player's slowly:
                    // components::LookScale)
                    let k = sim.world.get::<&LookScale>(e).map(|s| s.0.clamp(0.0, 1.0)).unwrap_or(1.0);
                    if let Ok(mut look) = sim.world.get::<&mut Look>(e) {
                        look.yaw = wrap(look.yaw - r.f(3) * k);
                        look.pitch = (look.pitch - r.f(4) * k).clamp(-1.45, 1.45);
                    }
                }
            }
            cmd::TELEPORT => {
                let Some(&e) = sim.players.get(&r.u(0)) else { return };
                let at = Vec3::new(r.f(1), r.f(2), r.f(3));
                net::teleport_player(sim, e, at, r.f(4), r.f(5));
                // a joiner's own player: the host replays the teleport with the next step's input
                if let Some(st) = sim.res.get_mut::<net::NetState>()
                    && st.is_joiner() && st.local == r.u(0) {
                        st.note_teleport(at, r.f(4));
                    }
            }
            cmd::SPAWN => {
                sim.spawn_player(r.u(0), Vec3::new(r.f(1), r.f(2), r.f(3)), r.f(4), r.u(5) != 0, true);
            }
            cmd::DESPAWN => {
                if let Some(&e) = sim.players.get(&r.u(0)) {
                    sim.despawn_now(e);
                }
            }
            cmd::TUNING => {
                let t = &mut sim.tables.player;
                let pos = |v: f32, d: f32| if v > 0.0 { v } else { d };
                t.walk = pos(r.f(0), t.walk);
                t.jump = pos(r.f(2), t.jump);
                t.gravity = pos(r.f(3), t.gravity);
                t.step_every = pos(r.f(7), t.step_every);
            }
            cmd::ADD_BOX => {
                sim.physics.add_box(Vec3::new(r.f(0), r.f(1), r.f(2)), Vec3::new(r.f(3), r.f(4), r.f(5)));
            }
            cmd::CLEAR_BOXES => sim.physics.clear_static(),
            cmd::POSE => {
                let id = r.u(0);
                let at = Vec3::new(r.f(1), r.f(2), r.f(3));
                let e = match sim.players.get(&id) {
                    Some(&e) => e,
                    None => {
                        let e = sim.spawn_player(id, at, r.f(4), false, false);
                        let _ = sim.world.insert_one(e, Replica::at(at, r.f(4)));
                        e
                    }
                };
                snapshot::replica_to(sim, e, at, r.f(4));
                if let Ok(mut l) = sim.world.get::<&mut Look>(e) {
                    l.yaw = wrap(r.f(4));
                    l.pitch = r.f(5).clamp(-1.55, 1.55);
                }
            }
            cmd::FLOOR_LIMIT => sim.floor_limit = r.f(0),
            cmd::SEED => sim.rng = sim::Rng::new(r.u(0) as u64 | (r.u(1) as u64) << 32),
            cmd::DAMAGE => {
                if let Some(e) = sim.entity_of(r.u(0)) {
                    sim.damage(e, r.f(1), r.u(2), None, Vec3::new(r.f(3), r.f(4), r.f(5)));
                }
            }
            cmd::SET_HEALTH => {
                if let Some(e) = sim.entity_of(r.u(0)) {
                    let h = Health { hp: r.f(1).max(0.0), max: r.f(2).max(1.0), armor: r.f(3).max(0.0), dead: r.f(1) <= 0.0, invulnerable: 0.0, last_hit_by: 0 };
                    let _ = sim.world.insert_one(e, h);
                }
            }
            cmd::LOOK => {
                if let Some(&e) = sim.players.get(&r.u(0))
                    && let Ok(mut l) = sim.world.get::<&mut Look>(e) {
                        l.yaw = wrap(r.f(1));
                        l.pitch = r.f(2).clamp(-1.45, 1.45);
                    }
            }
            op => {
                if let Some((_, f)) = self.commands.get_mut(&op) {
                    f(&mut self.sim, &r);
                }
            }
        }
    }

    // ---- reading ----

    /// The local player's feet (interpolated), yaw and pitch, if there is one.
    pub fn local(&self) -> Option<(Vec3, f32, f32)> {
        self.sim.world.query::<(&Player, &Transform, &Look)>().iter().find(|(p, ..)| p.local).map(|(_, t, l)| (t.interpolated(self.alpha).0, l.yaw, l.pitch))
    }
    pub fn player(&self, id: u32) -> Option<hecs::Entity> {
        self.sim.players.get(&id).copied()
    }
    /// The systems in step order, as "stage name" lines (diagnostics; `forge.systems()` in JS).
    pub fn systems(&self) -> Vec<String> {
        self.schedule.list().into_iter().map(|(st, n, on)| format!("{} {}{}", st.name(), n, if on { "" } else { " (off)" })).collect()
    }
    /// Stage of a system by name (tests).
    pub fn stage_of(&self, name: &str) -> Option<Stage> {
        self.schedule.list().into_iter().find(|x| x.1 == name).map(|x| x.0)
    }
}

pub fn wrap(a: f32) -> f32 {
    let tau = std::f32::consts::TAU;
    let mut a = a % tau;
    if a > std::f32::consts::PI {
        a -= tau;
    }
    if a < -std::f32::consts::PI {
        a += tau;
    }
    a
}

#[cfg(test)]
mod tests {
    use super::*;
    use cmd::Writer;
    use glam::Quat;

    pub(crate) fn core_with_room() -> Core {
        let mut c = Core::new();
        let mut w = Writer::default();
        w.add_box([-6.0, -0.2, -6.0], [6.0, 0.0, 6.0]);
        w.add_box([-6.0, 0.0, -6.5], [6.0, 3.0, -6.0]);
        w.spawn(1, 0.0, 0.05, 0.0, 0.0, true);
        c.cmds[..w.words.len()].copy_from_slice(&w.words);
        c.tick(0.0, w.words.len());
        c
    }

    fn input(c: &mut Core, mx: f32, mz: f32, look: f32, held: u32, pressed: u32) -> usize {
        let mut w = Writer::default();
        w.input(1, mx, mz, look, 0.0, held, true, pressed);
        c.cmds[..w.words.len()].copy_from_slice(&w.words);
        w.words.len()
    }

    #[test]
    fn walks_forward_into_the_wall_and_stops() {
        let mut c = core_with_room();
        for _ in 0..240 {
            let n = input(&mut c, 0.0, 1.0, 0.0, 0, 0);
            c.tick(1.0 / 60.0, n);
        }
        let (at, _, _) = c.local().unwrap();
        assert!(at.z < -5.0 && at.z > -6.0 + 0.2, "z {}", at.z);
        assert_eq!(c.views.player_count, 1);
        assert_eq!(c.views.players[view::LOCAL * MAX_PLAYERS], 1.0);
        let eye = c.views.camera[views::camera::Y];
        assert!((eye - (at.y + c.sim.tables.player.eye)).abs() < 1e-4, "eye {eye} feet {}", at.y);
        let kinds: Vec<u32> = c.events_out.chunks(events::WORDS).map(|e| e[0]).collect();
        let _ = kinds;
    }

    #[test]
    fn jumps_and_lands_with_events_and_sounds() {
        let mut c = core_with_room();
        for _ in 0..10 {
            let n = input(&mut c, 0.0, 0.0, 0.0, 0, 0);
            c.tick(1.0 / 60.0, n);
        }
        let n = input(&mut c, 0.0, 0.0, 0.0, cmd::BTN_JUMP, cmd::BTN_JUMP);
        c.tick(1.0 / 60.0, n);
        let mut top: f32 = 0.0;
        let mut words: Vec<u32> = c.events_out.clone();
        for _ in 0..90 {
            let n = input(&mut c, 0.0, 0.0, 0.0, 0, 0);
            c.tick(1.0 / 60.0, n);
            top = top.max(c.local().unwrap().0.y);
            words.extend_from_slice(&c.events_out);
        }
        assert!(top > 1.0, "rose {top}");
        let evs: Vec<events::Event> = words.chunks(events::WORDS).filter_map(|w| events::Event::decode(w.try_into().unwrap()).map(|x| x.0)).collect();
        let motions: Vec<u32> = evs.iter().filter_map(|e| if let events::Event::Motion(m) = e { Some(m.what) } else { None }).collect();
        assert!(motions.contains(&events::MOTION_JUMP) && motions.contains(&events::MOTION_LAND), "{motions:?}");
        let sounds: Vec<&str> = evs.iter().filter_map(|e| if let events::Event::Sound(s) = e { Some(c.sim.names.get(s.name)) } else { None }).collect();
        assert!(sounds.contains(&"jump") && sounds.contains(&"land"), "{sounds:?}");
    }

    #[test]
    fn looking_turns_at_once_steps_are_120hz_and_a_stall_is_capped_at_100ms() {
        let mut c = core_with_room();
        let n = input(&mut c, 0.0, 0.0, 0.5, 0, 0);
        let steps = c.tick(0.001, n);
        assert_eq!(steps, 0);
        assert!((c.views.camera[views::camera::YAW] + 0.5).abs() < 1e-5, "yaw {}", c.views.camera[views::camera::YAW]);
        assert_eq!(c.tick(1.0 / 60.0, 0), 2, "a 60 Hz frame is two steps");
        // the body faces where the player looks (the entities view's quaternion: −Z turned by the yaw)
        let e = views::entity::QX;
        let q = Quat::from_xyzw(c.views.entities[e * views::MAX_ENTITIES], c.views.entities[(e + 1) * views::MAX_ENTITIES], c.views.entities[(e + 2) * views::MAX_ENTITIES], c.views.entities[(e + 3) * views::MAX_ENTITIES]);
        assert!(q.abs_diff_eq(Quat::from_rotation_y(-0.5), 1e-4), "{q}");
        let t0 = c.sim.time.step;
        assert_eq!(c.tick(0.126, 0), MAX_STEPS, "a 126 ms stall runs 100 ms (12 steps)");
        assert_eq!(c.sim.time.step - t0, 12);
        assert!(c.dropped > 0.025, "dropped {}", c.dropped);
        // two steps a frame, frame after frame, whatever the rounding
        for _ in 0..600 {
            assert_eq!(c.tick(1.0 / 60.0, 0), 2);
        }
    }

    #[test]
    fn render_interpolation_lies_between_the_last_two_steps() {
        let mut c = core_with_room();
        for _ in 0..60 {
            let n = input(&mut c, 0.0, 1.0, 0.0, 0, 0);
            c.tick(1.0 / 60.0, n);
        }
        let e = c.player(1).unwrap();
        let t = *c.sim.world.get::<&Transform>(e).unwrap();
        let n = input(&mut c, 0.0, 1.0, 0.0, 0, 0);
        c.tick(STEP * 0.5, n);
        let z = c.views.players[view::Z * MAX_PLAYERS];
        let t2 = *c.sim.world.get::<&Transform>(e).unwrap();
        assert_eq!(t, t2, "half a step runs no step");
        assert!((c.alpha() - 0.5).abs() < 0.02 || c.alpha() > 0.0, "alpha {}", c.alpha());
        let lo = t.prev_pos.z.min(t.pos.z) - 1e-4;
        let hi = t.prev_pos.z.max(t.pos.z) + 1e-4;
        assert!(z >= lo && z <= hi, "{z} not within [{lo}, {hi}]");
    }

    /// The cost of a frame in a small room (`cargo test --release -p forge-core -- --ignored --nocapture frame_cost`):
    /// 28 static boxes, one player walking into walls, two steps a frame.
    #[test]
    #[ignore]
    fn frame_cost() {
        let mut c = Core::new();
        let mut w = Writer::default();
        for i in 0..28 {
            let x = (i % 7) as f32 * 1.5 - 4.5;
            w.add_box([x, -0.2, -6.0 + (i / 7) as f32 * 3.0], [x + 1.0, if i % 3 == 0 { 2.0 } else { 0.0 }, -5.0 + (i / 7) as f32 * 3.0]);
        }
        w.add_box([-20.0, -1.0, -20.0], [20.0, 0.0, 20.0]);
        w.spawn(1, 0.0, 0.05, 0.0, 0.0, true);
        c.cmds[..w.words.len()].copy_from_slice(&w.words);
        c.tick(0.0, w.words.len());
        let t0 = std::time::Instant::now();
        let mut worst = std::time::Duration::ZERO;
        for i in 0..1200 {
            let n = input(&mut c, ((i / 60) % 3) as f32 - 1.0, 1.0, 0.01, 0, 0);
            let s = std::time::Instant::now();
            c.tick(1.0 / 60.0, n);
            worst = worst.max(s.elapsed());
        }
        eprintln!("a frame (two steps): mean {:?}, worst {:?}; systems: {:?}", t0.elapsed() / 1200, worst, c.systems());
    }

    /// A probe: a character spawned at 5 cm, standing then walking: its height over the floor and its blocked steps.
    #[test]
    #[ignore]
    fn kcc_probe() {
        let mut c = Core::new();
        let mut w = Writer::default();
        w.add_box([-50.0, -0.2, -50.0], [50.0, 0.0, 50.0]);
        w.spawn(1, 0.0, 0.05, 40.0, 0.0, true);
        c.cmds[..w.words.len()].copy_from_slice(&w.words);
        c.tick(0.0, w.words.len());
        let mut blocked = 0;
        let mut last = c.local().unwrap().0;
        for f in 0..400 {
            let walking = f >= 100;
            let mut w = Writer::default();
            w.input(1, 0.0, if walking { 1.0 } else { 0.0 }, 0.0, 0.0, 0, true, 0);
            c.cmds[..w.words.len()].copy_from_slice(&w.words);
            c.tick(1.0 / 120.0, w.words.len());
            let e = c.player(1).unwrap();
            let p = c.sim.world.get::<&Transform>(e).unwrap().pos;
            let v = c.sim.world.get::<&Velocity>(e).unwrap().linear;
            let moved = (p - last).length();
            if walking && v.z.abs() > 1.0 && moved < v.z.abs() * STEP * 0.3 {
                blocked += 1;
                eprintln!("step {f}: blocked at y {:.5} (v {:.3})", p.y, v.z);
            }
            if f % 25 == 0 {
                eprintln!("step {f}: y {:.5} z {:.4}", p.y, p.z);
            }
            last = p;
        }
        eprintln!("blocked steps: {blocked}");
    }

    #[test]
    fn unknown_ops_are_skipped_and_plugin_ops_reach_their_plugin() {
        let mut c = core_with_room();
        assert!(!c.on_command(cmd::TELEPORT, "x", |_, _| {}), "the core's ops are its own");
        assert!(c.on_command(70, "feel.test", |sim, r| sim.floor_limit = r.f(0)));
        assert!(!c.on_command(70, "again", |_, _| {}));
        let mut w = Writer::default();
        w.op(999, &[1, 2, 3]);
        w.opf(70, &[], &[-55.0]);
        w.opf(cmd::TELEPORT, &[1], &[2.0, 0.05, 3.0, 0.0, 0.0]);
        c.cmds[..w.words.len()].copy_from_slice(&w.words);
        c.tick(0.0, w.words.len());
        let (at, _, _) = c.local().unwrap();
        assert!((at.x - 2.0).abs() < 1e-4 && (at.z - 3.0).abs() < 1e-4, "{at}");
        assert_eq!(c.sim.floor_limit, -55.0);
    }

    #[test]
    fn a_plugin_installs_once_and_its_hook_sees_the_tables() {
        struct P;
        #[derive(Default)]
        struct Seen(u32, f32);
        impl Plugin for P {
            fn name(&self) -> &'static str {
                "test"
            }
            fn install(&self, core: &mut Core) {
                core.schedule.add(Stage::Ai, "test.count", |sim| sim.res.entry::<Seen>().0 += 1);
                core.on_tables("test.tables", |sim| sim.res.entry::<Seen>().1 = sim.tables.weapons.first().map(|w| w.num("damage", 0.0)).unwrap_or(0.0));
            }
        }
        let mut c = Core::new();
        assert!(c.add_plugin(&P));
        assert!(!c.add_plugin(&P));
        c.load_tables(r#"{"weapons":[{"id":"a","damage":12}]}"#).unwrap();
        c.tick(1.0 / 60.0, 0);
        let s = c.sim.res.get::<Seen>().unwrap();
        assert_eq!((s.0, s.1), (2, 12.0));
        assert_eq!(c.stage_of("test.count"), Some(Stage::Ai));
        assert!(c.systems().iter().any(|s| s == "ai test.count"));
    }

    #[test]
    fn loading_tables_reshapes_a_player_and_changes_its_walk() {
        let mut c = core_with_room();
        c.load_tables(r#"{"player":{"walk":4,"height":1.6,"radius":0.25}}"#).unwrap();
        for _ in 0..120 {
            let n = input(&mut c, 0.0, 1.0, 0.0, 0, 0);
            c.tick(1.0 / 60.0, n);
            if c.local().unwrap().0.z < -4.0 {
                break;
            }
        }
        let speed = c.views.players[view::SPEED * MAX_PLAYERS];
        assert!((speed - 4.0).abs() < 0.1, "speed {speed}");
        let e = c.player(1).unwrap();
        assert!((c.sim.world.get::<&physics::Mover>(e).unwrap().radius - 0.25).abs() < 1e-6);
    }
}
