//! Live co-op (track S; research/rust-engine/PLAN.md §4 "S", §9 decision 4: co-op for 2–4 players; CONTRACT §8 forge
//! "Live co-op"): the host's core owns the world, a joiner predicts its own player and reconciles.
//!
//! **Roles** (`NetState::role`, set from JS with `Core::net_role`): `Solo` (alone: nothing here runs), `Host`, `Joiner`,
//! and since wave 4 `Viewer` (watch then play, CONTRACT §9b: a copy that only watches).
//!
//! - **A viewer has no player of its own.** It applies the host's snapshots as a joiner does, and every player in them
//!   is a replica: nothing is predicted, recorded, sent or reconciled, and no event of the host's is left out as
//!   "already played here". Its camera is on one of those players (`NetState::watch`, set with `Core::net_watch`):
//!   that replica is this copy's `local` player though it is not `owned` (`net.watch`, Input stage), so the camera view
//!   is its eyes, the feel view is its state, and its own body is not drawn. The eyes turn between the last two
//!   samples as the body moves between them (`Replica::pitch_at`; the view's yaw is the interpolated body's).
//! - **A joiner's own player is simulated on its own copy at once** (prediction): every fixed step `net.record` (Input
//!   stage) writes that step's input (`StepInput`: the stick, the look, the buttons held and pressed, a teleport) under
//!   the step's number (`seq`), and `net.predict` (Post stage, last) remembers where the step left the player. JS takes
//!   the inputs in batches (`take_inputs`, about 20 a second) and sends them to the host (`net.send('fi', …, 'host')`).
//! - **The host simulates every joiner's player from those inputs**: `push_inputs` queues them per player; `net.inputs`
//!   (Input stage, first) applies one per step after a jitter buffer of `JITTER_STEPS`, repeats the last one when the
//!   queue runs dry (idle after `IDLE_AFTER` steps of nothing), folds the oldest in when more than `MAX_QUEUE` wait, and
//!   remembers the last step it applied (`ack`), which snapshot v2 sends with that player.
//! - **Reconciliation** (`reconcile`, from `apply` on a joiner): the host's state of the joiner's player at `ack`
//!   against what the joiner predicted for that step. The difference moves the present and every later prediction by
//!   it, so a later snapshot compares like with like; the camera stays where it was and catches up over `SMOOTH_TIME`
//!   (`smooth`, added to the camera view), unless the difference is over `SNAP_DISTANCE` (a teleport, a respawn): then
//!   it snaps. A velocity difference over 1 m/s (a knock) is added too. The joiner's health is the host's.
//! - **A joiner's word for where its own player is** (wave 2, track G; INTEGRATION.md mismatch 16): every input carries
//!   where the joiner's copy left its player after that step and how fast (`StepInput::claim`, from `net.predict`'s
//!   own record). The host still replays the input, then moves its copy of that player to the claim
//!   (`core.character`), through the world alone (a wall still stops it) and only when the two are within
//!   `ADOPT_MAX` (a teleport or a respawn the joiner has not heard of stays the host's, and reaches the joiner as the
//!   snap it always was). The two copies never see the enemies in quite the same places (a joiner's are the host's of
//!   a moment ago, carried forward), so what stops a player differs by a step here and there: without the claim each
//!   such step came back as a correction (up to 1.1 m in a crowd with four players). With it a player is stopped by
//!   what its own screen shows, and the host's copy follows. Friends play friends: there is no cheat to guard against
//!   beyond the wall and the distance.
//! - **Firing**: a joiner's weapons fire on its own copy at once (the muzzle flash, the recoil, the sound: forge-feel
//!   reads the same `Control`), and on the host from the same inputs. Damage to replicas is the host's alone
//!   (`Sim::damage` on a `Replica` deals nothing); the host's HIT and KILL come back in the next snapshot. `apply` does
//!   not play again what the joiner already predicted: the host's sounds and lights whose source is the joiner's own
//!   player, and particles of the same name within 1 m of one the joiner drew in the last 0.6 s.
//! - A reloaded joiner starts a new `epoch`: the host drops the old queue and its acks.
use std::collections::{BTreeMap, VecDeque};

use glam::{Quat, Vec3};
use hecs::Entity;

use crate::components::*;
use crate::physics::{Body, Mover};
use crate::schedule::{Schedule, Stage};
use crate::sim::{Sim, Walker};
use crate::{wrap, STEP};

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum Role {
    #[default]
    Solo,
    Host,
    Joiner,
    /// Wave 4: a copy that watches (a stream's viewer): the host's world from its snapshots, no player of its own.
    Viewer,
}

impl Role {
    pub fn from_u32(v: u32) -> Role {
        match v {
            1 => Role::Host,
            2 => Role::Joiner,
            3 => Role::Viewer,
            _ => Role::Solo,
        }
    }
    pub fn name(self) -> &'static str {
        ["solo", "host", "joiner", "viewer"][self as usize]
    }
}

/// One fixed step's input of a joiner's player (what the host replays for it).
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct StepInput {
    /// The joiner's step number.
    pub seq: u32,
    pub mx: f32,
    pub mz: f32,
    /// The look after this step's frame (absolute, the core's yaw and pitch).
    pub yaw: f32,
    pub pitch: f32,
    pub held: u32,
    pub pressed: u32,
    pub enabled: bool,
    /// A teleport the joiner made before this step (its own respawn): feet and yaw.
    pub teleport: Option<(Vec3, f32)>,
    /// Where the joiner's own copy left its player after this step, and its velocity (module docs, "a joiner's word").
    pub claim: Option<(Vec3, Vec3)>,
}

/// Steps a new or starved queue waits for before it plays (25 ms: a batch's jitter).
pub const JITTER_STEPS: usize = 3;
/// More than this many steps waiting (0.2 s) and the oldest are folded into the next one.
pub const MAX_QUEUE: usize = 24;
/// Steps of nothing (0.25 s) after which a starved player stands still instead of repeating its last input.
pub const IDLE_AFTER: u32 = 30;
/// Predictions a joiner keeps (3 s).
pub const HISTORY: usize = 360;
/// A difference over this snaps instead of smoothing (a teleport, a respawn).
pub const SNAP_DISTANCE: f32 = 2.0;
/// A difference under this is the snapshot's own rounding (1/64 m a component): nothing to correct.
pub const TOLERANCE: f32 = 0.03;
/// A height difference under this is the snapshot's rounding, never corrected (net.rs `reconcile`).
pub const VERTICAL_TOLERANCE: f32 = 0.06;
/// Seconds the camera takes to catch up with a correction (to 1/e).
pub const SMOOTH_TIME: f32 = 0.06;
/// Bytes of one input in a batch (+16 with a teleport, +`CLAIM_BYTES` with a claim).
pub const INPUT_BYTES: usize = 11;
/// Bytes of a claim: the feet (x y z f32) and the velocity (x y z i16, 1/256 m/s).
pub const CLAIM_BYTES: usize = 18;
/// The host takes a joiner's claim when it is within this of where its own replay left the player (m): past it the
/// host's place stands (a teleport, a respawn), and the joiner snaps as before.
pub const ADOPT_MAX: f32 = 2.0;
/// A claim this close to the host's replay is taken as it is; a further one is walked to through the world (m).
pub const ADOPT_FREE: f32 = 0.02;
/// The most inputs one batch carries.
pub const BATCH_MAX: usize = 255;

/// A joiner's queued inputs on the host.
#[derive(Clone, Debug, Default)]
pub struct InputQueue {
    q: VecDeque<StepInput>,
    last: StepInput,
    /// The last step of the joiner's that the host applied (0: none yet); snapshot v2 sends it.
    pub ack: u32,
    pub epoch: u32,
    last_seq: u32,
    buffering: bool,
    dry: u32,
    /// Steps played with no input waiting (the last one repeated), folded in to catch up, and received.
    pub starved: u32,
    pub folded: u32,
    pub received: u32,
    /// Claims the host took where its own replay differed by more than `TOLERANCE` (what would have come back to the
    /// joiner as a correction), the largest difference taken (m), and claims refused (over `ADOPT_MAX`).
    pub taken: u32,
    pub taken_max: f32,
    pub refused: u32,
}

impl InputQueue {
    pub fn len(&self) -> usize {
        self.q.len()
    }
    pub fn is_empty(&self) -> bool {
        self.q.is_empty()
    }
}

#[derive(Clone, Copy, Debug)]
struct Predicted {
    seq: u32,
    pos: Vec3,
    vel: Vec3,
}

/// Counts for the observation (`net_stats`).
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct NetStats {
    /// Reconciliations: checked, corrected (smoothed), snapped; the last and largest difference (m).
    pub checked: u32,
    pub corrected: u32,
    pub snapped: u32,
    pub last_error: f32,
    pub max_error: f32,
    /// Events from the host a joiner did not play again because it had already predicted them.
    pub suppressed: u32,
    /// Inputs a joiner sent, and batches.
    pub inputs_sent: u32,
    pub batches_sent: u32,
    /// Shoves from the host (PUSH events) a joiner played: on their own step, and late (heard after their step: what
    /// was left of them played). `max_shove` was the late catch-up's move before the host took a joiner's word for
    /// its place (module docs): there is no catch-up now, it stays 0.
    pub pushes: u32,
    pub shoved: u32,
    pub max_shove: f32,
}

/// The co-op state of this copy (`sim.res`).
#[derive(Clone, Debug, Default)]
pub struct NetState {
    pub role: Role,
    /// This copy's own player (its core id).
    pub local: u32,
    /// A joiner's page load (a reload is a new epoch).
    pub epoch: u32,
    out: VecDeque<StepInput>,
    history: VecDeque<Predicted>,
    teleport: Option<(Vec3, f32)>,
    /// The camera's lag behind a correction (added to the camera view, decaying to zero).
    pub smooth: Vec3,
    /// The host: every joiner's queued inputs, by player id.
    pub queues: BTreeMap<u32, InputQueue>,
    pub stats: NetStats,
    /// A joiner's own particle events of late: (name, where, when), so the host's copies of them are not drawn twice.
    recent_fx: VecDeque<(u32, Vec3, f64)>,
    /// A joiner: the last input step of its own the host had applied in the newest snapshot (0: none yet), and where
    /// the host had its player after that step.
    pub acked: u32,
    pub acked_at: Vec3,
    /// The host: this step's claims, by player id (`net.inputs` fills it, `core.character` takes them).
    pub claims: BTreeMap<u32, (Vec3, Vec3)>,
    /// A viewer: the player whose eyes this copy looks through (its core id; 0: nobody yet).
    pub watch: u32,
}

impl NetState {
    pub fn new(role: Role, local: u32, epoch: u32) -> Self {
        Self { role, local, epoch, ..Self::default() }
    }
    pub fn is_joiner(&self) -> bool {
        self.role == Role::Joiner
    }
    pub fn is_host(&self) -> bool {
        self.role == Role::Host
    }
    pub fn is_viewer(&self) -> bool {
        self.role == Role::Viewer
    }
    /// This copy shows the host's world from its snapshots (a joiner, a viewer): it decides nothing the host decides.
    pub fn follows(&self) -> bool {
        matches!(self.role, Role::Joiner | Role::Viewer)
    }
    /// The host: the last step of player `id` it applied (0: none, or not a joiner's player).
    pub fn ack_of(&self, id: u32) -> u32 {
        self.queues.get(&id).map(|q| q.ack).unwrap_or(0)
    }
    /// The joiner: remember a particle event its own copy drew.
    pub fn saw_fx(&mut self, name: u32, pos: Vec3, now: f64) {
        self.recent_fx.push_back((name, pos, now));
        while self.recent_fx.len() > 64 {
            self.recent_fx.pop_front();
        }
    }
    /// The joiner: did its own copy draw particles named `name` near `pos` lately?
    pub fn predicted_fx(&mut self, name: u32, pos: Vec3, now: f64) -> bool {
        while self.recent_fx.front().is_some_and(|f| now - f.2 > 1.0) {
            self.recent_fx.pop_front();
        }
        if let Some(i) = self.recent_fx.iter().position(|f| f.0 == name && f.1.distance(pos) < 1.0 && now - f.2 < 0.6) {
            self.recent_fx.remove(i);
            return true;
        }
        false
    }
    /// The joiner: predictions waiting for the host (for the observation).
    pub fn history_len(&self) -> usize {
        self.history.len()
    }
    /// The joiner: how many of its own steps it is ahead of what the host had applied in the newest snapshot, at its
    /// step `now` (the snapshot's world is that many steps behind what the host will hold when it replays `now`).
    pub fn lead(&self, now: u32) -> u32 {
        if self.acked == 0 { 0 } else { now.saturating_sub(self.acked).min(60) }
    }
    /// The joiner: where it predicted its own player after its step `seq`, if it still remembers.
    pub fn predicted_at(&self, seq: u32) -> Option<Vec3> {
        self.history.iter().find(|h| h.seq == seq).map(|h| h.pos)
    }
    /// The joiner: a shove from the host played on its own step (counted for the observation).
    pub fn note_push(&mut self) {
        self.stats.pushes += 1;
    }
    /// The joiner: a shove from the host heard after its step (a slow snapshot): what is left of it plays from here.
    pub fn note_late_push(&mut self) {
        self.stats.shoved += 1;
    }
}

/// The Input stage's `net.inputs` and `net.record` (first in the stage) and the Post stage's `net.predict` (last).
pub fn install_input(s: &mut Schedule) {
    s.add(Stage::Input, "net.inputs", net_inputs);
    s.add(Stage::Input, "net.record", net_record);
    s.add(Stage::Input, "net.watch", net_watch);
}
pub fn install_post(s: &mut Schedule) {
    s.add(Stage::Post, "net.predict", net_predict);
}

/// Move a player now: its feet, its look and where it falls back to (the TELEPORT command, a joiner's teleport replayed).
pub fn teleport_player(sim: &mut Sim, e: Entity, at: Vec3, yaw: f32, pitch: f32) {
    sim.teleport(e, at);
    if let Ok((look, w)) = sim.world.query_one_mut::<(&mut Look, &mut Walker)>(e) {
        look.yaw = wrap(yaw);
        look.pitch = pitch.clamp(-1.45, 1.45);
        w.spawn = at;
        w.spawn_yaw = look.yaw;
        w.walked = 0.0;
        w.air = 0.0;
        w.fall = 0.0;
    }
    if let Ok(mut t) = sim.world.get::<&mut Transform>(e) {
        t.rot = Quat::from_rotation_y(wrap(yaw));
        t.prev_rot = t.rot;
    }
}

/// A viewer: the player it watches is this copy's `local` one, and nobody else is (module docs). A replica the next
/// snapshot brings (a new round, a player back in the room) is found here on its first step.
pub fn net_watch(sim: &mut Sim) {
    let Some(watch) = sim.res.get::<NetState>().filter(|n| n.is_viewer()).map(|n| n.watch) else { return };
    for p in sim.world.query_mut::<&mut Player>() {
        let want = !p.owned && watch != 0 && p.id == watch;
        if p.local != want {
            p.local = want;
        }
    }
}

/// The host: one queued input per joiner's player, per step.
fn net_inputs(sim: &mut Sim) {
    if !sim.res.get::<NetState>().is_some_and(|n| n.is_host() && !n.queues.is_empty()) {
        return;
    }
    let mut st = sim.res.take::<NetState>();
    let mut teleports: Vec<(Entity, Vec3, f32, f32)> = Vec::new();
    let mut claims: BTreeMap<u32, (Vec3, Vec3)> = BTreeMap::new();
    for (id, q) in st.queues.iter_mut() {
        let Some(&e) = sim.players.get(id) else { continue };
        if !sim.world.get::<&Player>(e).is_ok_and(|p| p.owned && !p.local) {
            continue;
        }
        let next = if q.buffering && q.q.len() < JITTER_STEPS {
            None
        } else {
            q.buffering = false;
            q.q.pop_front()
        };
        let inp = match next {
            Some(mut i) => {
                // behind: fold the oldest waiting inputs into this one (their presses kept, the newest stick and look)
                while q.q.len() > MAX_QUEUE {
                    let n = q.q.pop_front().unwrap_or_default();
                    i = StepInput { pressed: i.pressed | n.pressed, teleport: n.teleport.or(i.teleport), ..n };
                    q.folded += 1;
                }
                q.dry = 0;
                q.ack = i.seq;
                q.last = i;
                i
            }
            None => {
                q.dry += 1;
                if !q.buffering {
                    q.starved += 1;
                }
                if q.dry > IDLE_AFTER {
                    q.buffering = true;
                    StepInput { mx: 0.0, mz: 0.0, held: 0, pressed: 0, teleport: None, claim: None, ..q.last }
                } else {
                    StepInput { pressed: 0, teleport: None, claim: None, ..q.last }
                }
            }
        };
        if let Ok((c, look)) = sim.world.query_one_mut::<(&mut Control, &mut Look)>(e) {
            c.move_x = inp.mx.clamp(-1.0, 1.0);
            c.move_z = inp.mz.clamp(-1.0, 1.0);
            c.held = inp.held;
            c.pressed |= inp.pressed;
            c.enabled = inp.enabled;
            look.yaw = wrap(inp.yaw);
            look.pitch = inp.pitch.clamp(-1.45, 1.45);
        }
        if let Some((at, yaw)) = inp.teleport {
            teleports.push((e, at, yaw, inp.pitch));
        }
        if let Some(c) = inp.claim {
            claims.insert(*id, c);
        }
    }
    st.claims = claims;
    sim.res.insert(st);
    for (e, at, yaw, pitch) in teleports {
        teleport_player(sim, e, at, yaw, pitch);
    }
}

/// The joiner: this step's input of its own player, under the step's number.
fn net_record(sim: &mut Sim) {
    let Some(local) = sim.res.get::<NetState>().filter(|n| n.is_joiner()).map(|n| n.local) else { return };
    let Some(&e) = sim.players.get(&local) else { return };
    let Ok((c, look)) = sim.world.query_one_mut::<(&Control, &Look)>(e).map(|(c, l)| (*c, *l)) else { return };
    let seq = sim.time.step as u32;
    let st = sim.res.entry::<NetState>();
    let teleport = st.teleport.take();
    st.out.push_back(StepInput { seq, mx: c.move_x, mz: c.move_z, yaw: look.yaw, pitch: look.pitch, held: c.held, pressed: c.pressed, enabled: c.enabled, teleport, claim: None });
    // nobody took them for 8 s (no connection): keep the newest
    while st.out.len() > 960 {
        st.out.pop_front();
    }
}

/// The joiner: where this step left its own player; the camera's correction decays.
fn net_predict(sim: &mut Sim) {
    let Some(local) = sim.res.get::<NetState>().filter(|n| n.is_joiner()).map(|n| n.local) else { return };
    let Some(&e) = sim.players.get(&local) else { return };
    let pos = sim.world.get::<&Transform>(e).map(|t| t.pos).unwrap_or(Vec3::ZERO);
    let vel = sim.world.get::<&Velocity>(e).map(|v| v.linear).unwrap_or(Vec3::ZERO);
    let seq = sim.time.step as u32;
    let st = sim.res.entry::<NetState>();
    st.history.push_back(Predicted { seq, pos, vel });
    while st.history.len() > HISTORY {
        st.history.pop_front();
    }
    st.smooth *= (-STEP / SMOOTH_TIME).exp();
    if st.smooth.length_squared() < 1e-8 {
        st.smooth = Vec3::ZERO;
    }
}

/// The joiner: the host's state of its own player at the joiner's step `ack` → correct the present (module docs).
pub fn reconcile(sim: &mut Sim, e: Entity, ack: u32, pos: Vec3, vel: Vec3) {
    if ack == 0 {
        return;
    }
    let mut st = sim.res.take::<NetState>();
    st.acked = ack;
    st.acked_at = pos;
    while st.history.front().is_some_and(|h| h.seq < ack) {
        st.history.pop_front();
    }
    let Some(h) = st.history.front().copied().filter(|h| h.seq == ack) else {
        sim.res.insert(st);
        return;
    };
    st.history.pop_front();
    st.stats.checked += 1;
    // a small height difference is the snapshot's rounding (1/64 m), not a disagreement: moving a grounded character
    // by it would put it inside the character controller's 1 cm skin over the floor, where its next step can be refused
    let mut err = pos - h.pos;
    if err.y.abs() < VERTICAL_TOLERANCE {
        err.y = 0.0;
    }
    let dist = err.length();
    st.stats.last_error = dist;
    st.stats.max_error = st.stats.max_error.max(dist);
    let dv = vel - h.vel;
    let knock = Vec3::new(dv.x, 0.0, dv.z).length() > 1.0 || dv.y.abs() > 2.5;
    if dist < TOLERANCE && !knock {
        sim.res.insert(st);
        return;
    }
    if dist >= TOLERANCE {
        for p in st.history.iter_mut() {
            p.pos += err;
        }
        if dist > SNAP_DISTANCE {
            st.smooth = Vec3::ZERO;
            st.stats.snapped += 1;
        } else {
            st.smooth = (st.smooth - err).clamp_length_max(1.0);
            st.stats.corrected += 1;
        }
        let moved = match sim.world.get::<&mut Transform>(e) {
            Ok(mut t) => {
                t.pos += err;
                t.prev_pos += err;
                Some(t.pos)
            }
            Err(_) => None,
        };
        if let Some(feet) = moved {
            let body = sim.world.get::<&Body>(e).map(|b| *b).ok();
            let center = sim.world.get::<&Mover>(e).map(|m| m.center(feet)).ok();
            if let (Some(b), Some(c)) = (body, center) {
                sim.physics.set_kinematic(&b, c, Quat::IDENTITY);
            }
        }
    }
    if knock {
        if let Ok(mut v) = sim.world.get::<&mut Velocity>(e) {
            v.linear += dv;
        }
        for p in st.history.iter_mut() {
            p.vel += dv;
        }
    }
    sim.res.insert(st);
}

// ---- the input batch: what a joiner sends the host (`net.send('fi', base64)`) ----
//
//   epoch u32, first seq u32, count u8, then each input: mx i8, mz i8 (×127), yaw u16 (a turn / 65536), pitch i16
//   (±π/2), held u16, pressed u16, flags u8 (1 enabled, 2 teleport follows, 4 claim follows),
//   [teleport: x y z yaw f32], [claim: feet x y z f32, velocity x y z i16 (1/256 m/s)]
//   Seqs run on from the first, one a step.

fn q_unit(v: f32) -> i8 {
    (v.clamp(-1.0, 1.0) * 127.0).round() as i8
}

/// The joiner: the inputs recorded since the last call, as one batch (empty when there are none).
pub fn take_inputs(st: &mut NetState) -> Vec<u8> {
    if st.out.is_empty() {
        return Vec::new();
    }
    let n = st.out.len().min(BATCH_MAX);
    let mut b = Vec::with_capacity(9 + n * (INPUT_BYTES + CLAIM_BYTES));
    b.extend_from_slice(&st.epoch.to_le_bytes());
    let first = st.out[0].seq;
    b.extend_from_slice(&first.to_le_bytes());
    // a gap in the seqs (never in practice: one record a step) ends the batch there
    let mut count = 0usize;
    let at = b.len();
    b.push(0);
    for i in 0..n {
        if st.out[i].seq != first.wrapping_add(i as u32) {
            break;
        }
        let s = st.out[i];
        // where this step left the player on this copy (`net.predict` wrote it; a correction since has moved it too)
        let claim = st.history.iter().rev().find(|h| h.seq == s.seq).map(|h| (h.pos, h.vel)).filter(|(p, v)| p.is_finite() && v.is_finite());
        b.push(q_unit(s.mx) as u8);
        b.push(q_unit(s.mz) as u8);
        b.extend_from_slice(&((wrap(s.yaw).rem_euclid(std::f32::consts::TAU) / std::f32::consts::TAU * 65536.0).round() as u32 as u16).to_le_bytes());
        b.extend_from_slice(&((s.pitch / std::f32::consts::FRAC_PI_2 * 32767.0).round().clamp(-32767.0, 32767.0) as i16).to_le_bytes());
        b.extend_from_slice(&(s.held.min(0xffff) as u16).to_le_bytes());
        b.extend_from_slice(&(s.pressed.min(0xffff) as u16).to_le_bytes());
        b.push((s.enabled as u8) | ((s.teleport.is_some() as u8) << 1) | ((claim.is_some() as u8) << 2));
        if let Some((p, yaw)) = s.teleport {
            for v in [p.x, p.y, p.z, yaw] {
                b.extend_from_slice(&v.to_le_bytes());
            }
        }
        if let Some((p, v)) = claim {
            for x in [p.x, p.y, p.z] {
                b.extend_from_slice(&x.to_le_bytes());
            }
            for x in [v.x, v.y, v.z] {
                b.extend_from_slice(&((x * 256.0).round().clamp(-32767.0, 32767.0) as i16).to_le_bytes());
            }
        }
        count += 1;
    }
    b[at] = count as u8;
    st.out.drain(..count);
    st.stats.inputs_sent += count as u32;
    st.stats.batches_sent += 1;
    b
}

/// Read a batch. → (epoch, inputs)
pub fn decode_inputs(b: &[u8]) -> Result<(u32, Vec<StepInput>), &'static str> {
    let get = |at: usize, n: usize| b.get(at..at + n).ok_or("an input batch cut short");
    let epoch = u32::from_le_bytes(get(0, 4)?.try_into().unwrap());
    let first = u32::from_le_bytes(get(4, 4)?.try_into().unwrap());
    let n = *get(8, 1)?.first().unwrap() as usize;
    let mut at = 9;
    let mut out = Vec::with_capacity(n);
    for i in 0..n {
        let r = get(at, INPUT_BYTES)?;
        at += INPUT_BYTES;
        let yaw = u16::from_le_bytes([r[2], r[3]]) as f32 / 65536.0 * std::f32::consts::TAU;
        let pitch = i16::from_le_bytes([r[4], r[5]]) as f32 / 32767.0 * std::f32::consts::FRAC_PI_2;
        let flags = r[10];
        let teleport = if flags & 2 != 0 {
            let t = get(at, 16)?;
            at += 16;
            let f = |k: usize| { let v = f32::from_le_bytes(t[k * 4..k * 4 + 4].try_into().unwrap()); if v.is_finite() { v } else { 0.0 } };
            Some((Vec3::new(f(0), f(1), f(2)), f(3)))
        } else {
            None
        };
        let claim = if flags & 4 != 0 {
            let t = get(at, CLAIM_BYTES)?;
            at += CLAIM_BYTES;
            let f = |k: usize| f32::from_le_bytes(t[k * 4..k * 4 + 4].try_into().unwrap());
            let v = |k: usize| i16::from_le_bytes([t[12 + k * 2], t[13 + k * 2]]) as f32 / 256.0;
            let p = Vec3::new(f(0), f(1), f(2));
            p.is_finite().then_some((p, Vec3::new(v(0), v(1), v(2))))
        } else {
            None
        };
        out.push(StepInput {
            seq: first.wrapping_add(i as u32),
            mx: r[0] as i8 as f32 / 127.0,
            mz: r[1] as i8 as f32 / 127.0,
            yaw: wrap(yaw),
            pitch,
            held: u16::from_le_bytes([r[6], r[7]]) as u32,
            pressed: u16::from_le_bytes([r[8], r[9]]) as u32,
            enabled: flags & 1 != 0,
            teleport,
            claim,
        });
    }
    Ok((epoch, out))
}

/// The host: queue a joiner's batch for player `id`. → the inputs queued (old or repeated ones are dropped).
pub fn push_inputs(st: &mut NetState, id: u32, bytes: &[u8]) -> Result<usize, &'static str> {
    let (epoch, inputs) = decode_inputs(bytes)?;
    let q = st.queues.entry(id).or_insert_with(|| InputQueue { buffering: true, epoch, ..InputQueue::default() });
    if q.epoch != epoch {
        // a reloaded joiner: its steps count from the start again
        *q = InputQueue { buffering: true, epoch, ..InputQueue::default() };
    }
    let mut n = 0;
    for i in inputs {
        if q.last_seq != 0 && i.seq <= q.last_seq {
            continue;
        }
        q.last_seq = i.seq;
        q.q.push_back(i);
        n += 1;
    }
    q.received += n as u32;
    // a queue that has fallen 2 s behind starts again from the newest
    while q.q.len() > 240 {
        q.q.pop_front();
        q.folded += 1;
    }
    Ok(n)
}

impl NetState {
    /// The host: `core.character` took (or refused) player `id`'s claim, `far` metres from its own replay.
    pub fn note_claim(&mut self, id: u32, far: f32, taken: bool) {
        let Some(q) = self.queues.get_mut(&id) else { return };
        if !taken {
            q.refused += 1;
        } else if far > TOLERANCE {
            q.taken += 1;
            q.taken_max = q.taken_max.max(far);
        }
    }
    /// The joiner: a teleport of its own player (replayed on the host at the next step's input).
    pub fn note_teleport(&mut self, at: Vec3, yaw: f32) {
        self.teleport = Some((at, yaw));
    }
    /// A short summary for the observation: JSON fields without the braces (`Core::net_stats_json` adds the snapshots').
    pub fn stats_fields(&self) -> String {
        let s = &self.stats;
        let queues: Vec<String> = self.queues.iter().map(|(id, q)| format!(r#"{{"id":{id},"queued":{},"ack":{},"received":{},"starved":{},"folded":{},"taken":{},"takenMax":{:.4},"refused":{}}}"#, q.q.len(), q.ack, q.received, q.starved, q.folded, q.taken, q.taken_max, q.refused)).collect();
        format!(
            r#""role":"{}","local":{},"watch":{},"epoch":{},"checked":{},"corrected":{},"snapped":{},"lastError":{:.4},"maxError":{:.4},"suppressed":{},"inputsSent":{},"batchesSent":{},"history":{},"smooth":{:.4},"pushes":{},"pushesLate":{},"maxPushCatchUp":{:.4},"lead":{},"queues":[{}]"#,
            self.role.name(), self.local, self.watch, self.epoch, s.checked, s.corrected, s.snapped, s.last_error, s.max_error, s.suppressed, s.inputs_sent, s.batches_sent, self.history.len(), self.smooth.length(), s.pushes, s.shoved, s.max_shove,
            self.history.back().map(|h| h.seq.saturating_sub(self.acked)).filter(|_| self.acked != 0).unwrap_or(0), queues.join(",")
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_batch_round_trips_and_a_queue_drops_repeats_and_restarts_on_a_new_epoch() {
        let mut j = NetState::new(Role::Joiner, 2, 77);
        for k in 0..5u32 {
            j.out.push_back(StepInput { seq: 100 + k, mx: 0.5, mz: -1.0, yaw: 1.25, pitch: -0.3, held: 8 | 1, pressed: if k == 0 { 8 } else { 0 }, enabled: true, teleport: (k == 2).then_some((Vec3::new(1.0, 0.05, -2.0), 0.7)), claim: None });
            // what `net.predict` remembers of steps 101 and 103: their claims
            if k % 2 == 1 {
                j.history.push_back(Predicted { seq: 100 + k, pos: Vec3::new(3.25, 0.05, -7.5 - k as f32), vel: Vec3::new(-6.5, 0.0, 1.25) });
            }
        }
        let b = take_inputs(&mut j);
        assert!(j.out.is_empty() && b.len() == 9 + 5 * INPUT_BYTES + 16 + 2 * CLAIM_BYTES);
        let (epoch, ins) = decode_inputs(&b).unwrap();
        assert_eq!((epoch, ins.len(), ins[0].seq, ins[4].seq), (77, 5, 100, 104));
        assert!((ins[0].mx - 0.5).abs() < 0.01 && ins[0].mz == -1.0 && (ins[0].yaw - 1.25).abs() < 1e-3 && (ins[0].pitch + 0.3).abs() < 1e-3);
        assert_eq!((ins[0].held, ins[0].pressed, ins[1].pressed), (9, 8, 0));
        assert_eq!(ins[2].teleport, Some((Vec3::new(1.0, 0.05, -2.0), 0.7)));
        assert_eq!((ins[0].claim, ins[2].claim), (None, None), "a step it does not remember carries no claim");
        assert_eq!(ins[1].claim, Some((Vec3::new(3.25, 0.05, -8.5), Vec3::new(-6.5, 0.0, 1.25))), "where the joiner's copy left its player after the step, and how fast");
        assert_eq!(ins[3].claim.map(|c| c.0.z), Some(-10.5));
        let mut h = NetState::new(Role::Host, 0, 0);
        assert_eq!(push_inputs(&mut h, 2, &b), Ok(5));
        assert_eq!(push_inputs(&mut h, 2, &b), Ok(0), "the same batch twice queues nothing");
        let mut again = NetState::new(Role::Joiner, 2, 78);
        again.out.push_back(StepInput { seq: 1, enabled: true, ..StepInput::default() });
        assert_eq!(push_inputs(&mut h, 2, &take_inputs(&mut again)), Ok(1), "a reload's new epoch starts the queue again");
        assert_eq!(h.queues[&2].len(), 1);
        assert!(decode_inputs(&b[..12]).is_err());
    }
}
