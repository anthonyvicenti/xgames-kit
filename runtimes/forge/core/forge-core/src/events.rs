//! Events v1 (PLAN §2 "events out"; ARCHITECTURE.md "Events"): what happened during a tick, typed in Rust and packed
//! for JS as 16 u32 words each (`WORDS`). The JS host (`gf/forge/host.js` `decodeEvents`) reads them after every tick
//! and routes them: sounds to gf-audio by name (`assets.json` declares every one), rule events to `rules.js`, the rest
//! to whoever listens (the renderer's flashes and particles, the HUD's numbers, the camera).
//!
//! Layout: word 0 the kind, words 1..=14 the payload (floats as their bits), word 15 the flags (`FLAG_*`). The table:
//!
//! | kind | name | words 1..=14 |
//! |---|---|---|
//! | 1 | HIT | attacker, target (net ids), part (`Part`), point x y z, normal x y z, damage, crit (0/1), region |
//! | 2 | KILL | attacker, target, part, point x y z, dir x y z (the killing blow's direction), damage |
//! | 3 | SPAWN | id, kind (`components::kind`), type, x y z, yaw |
//! | 4 | DESPAWN | id, kind, type |
//! | 5 | SOUND | name (a `Names` id: an assets.json sound), source (net id or 0), x y z, gain (dB), rate |
//! | 6 | LIGHT | source, x y z, r g b (linear), radius (m), intensity, frames |
//! | 7 | PARTICLES | name (kind), count, x y z, dir x y z, speed (m/s), spread (rad) |
//! | 8 | CAMERA | player, kick pitch (°), kick yaw (°), fov punch (°), fov time (s), shake (m), shake time (s) |
//! | 9 | UI | what (`UI_*`), player (0: everyone), x y z, value, crit (0/1), count, multiplier, seconds |
//! | 10 | RULE | name, entity, a, b, c, d |
//! | 11 | MOTION | what (`MOTION_*`), player, x y z, speed (m/s), air time (s) |
//! | 12 | PUSH | player, seq (the player's own input step it starts at; 0: now), vel x y z (m/s; y: a hop), seconds (the push fades over them), down (seconds without control) |
//! | 32..=63 | a plugin's own (`Event::Custom`): F 32..=39, A 40..=47, S 48..=55, R 56..=63 | its own 14 words |
//!
//! The ring keeps `EVENT_CAPACITY` events a tick; past that the oldest are dropped and counted (`dropped`), so a slow
//! host never stalls the simulation. Systems of a later stage read what this step emitted (`step_events`).
use glam::Vec3;

pub const WORDS: usize = 16;

pub const HIT: u32 = 1;
pub const KILL: u32 = 2;
pub const SPAWN: u32 = 3;
pub const DESPAWN: u32 = 4;
pub const SOUND: u32 = 5;
pub const LIGHT: u32 = 6;
pub const PARTICLES: u32 = 7;
pub const CAMERA: u32 = 8;
pub const UI: u32 = 9;
pub const RULE: u32 = 10;
pub const MOTION: u32 = 11;
/// Wave 2: something shoves a player (a brute's slam, a boss's charge). The host emits it for a joiner's player with the
/// joiner's own input step it will start at, so the joiner's prediction plays the same push on the same step
/// (forge-feel `hits::shove`) instead of being corrected afterwards.
pub const PUSH: u32 = 12;
/// The first and last kind a plugin may use for its own events (see the table above for who has which).
pub const CUSTOM_FIRST: u32 = 32;
pub const CUSTOM_LAST: u32 = 63;

/// Flags (word 15). REMOTE: re-emitted from the host's snapshot on a joiner (it happened on the host's copy).
pub const FLAG_REMOTE: u32 = 1;

pub const UI_DAMAGE: u32 = 1;
pub const UI_COMBO: u32 = 2;

pub const MOTION_STEP: u32 = 1;
pub const MOTION_JUMP: u32 = 2;
pub const MOTION_LAND: u32 = 3;
pub const MOTION_FELL: u32 = 4;
pub const MOTION_BUMP: u32 = 5;
pub const MOTION_EVADE: u32 = 6;

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Hit {
    pub attacker: u32,
    pub target: u32,
    pub part: u8,
    pub point: Vec3,
    pub normal: Vec3,
    pub damage: f32,
    pub crit: bool,
    /// The hurt region's index in the target's `Hurtbox` (or 0).
    pub region: u32,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Kill {
    pub attacker: u32,
    pub target: u32,
    pub part: u8,
    pub point: Vec3,
    pub dir: Vec3,
    pub damage: f32,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Spawn {
    pub id: u32,
    pub kind: u8,
    pub type_: u16,
    pub pos: Vec3,
    pub yaw: f32,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Despawn {
    pub id: u32,
    pub kind: u8,
    pub type_: u16,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Sound {
    /// A `Names` id: the name of a sound in the game's assets.json.
    pub name: u32,
    pub source: u32,
    pub pos: Vec3,
    pub gain_db: f32,
    pub rate: f32,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Light {
    pub source: u32,
    pub pos: Vec3,
    pub color: [f32; 3],
    pub radius: f32,
    pub intensity: f32,
    pub frames: u32,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Particles {
    pub name: u32,
    pub count: u32,
    pub pos: Vec3,
    pub dir: Vec3,
    pub speed: f32,
    pub spread: f32,
}

#[derive(Clone, Copy, Debug, PartialEq, Default)]
pub struct CameraFx {
    pub player: u32,
    pub kick_pitch: f32,
    pub kick_yaw: f32,
    pub fov_punch: f32,
    pub fov_time: f32,
    pub shake: f32,
    pub shake_time: f32,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Ui {
    pub what: u32,
    pub player: u32,
    pub pos: Vec3,
    pub value: f32,
    pub crit: bool,
    pub count: u32,
    pub multiplier: f32,
    pub seconds: f32,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Rule {
    pub name: u32,
    pub entity: u32,
    pub a: f32,
    pub b: f32,
    pub c: f32,
    pub d: f32,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Motion {
    pub what: u32,
    pub player: u32,
    pub pos: Vec3,
    pub speed: f32,
    pub air: f32,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Push {
    pub player: u32,
    /// The player's own input step the push starts at (a joiner's step number; 0: at once).
    pub seq: u32,
    /// m/s: x and z fade to nothing over `secs`; y is a hop (an upward speed set once).
    pub vel: Vec3,
    pub secs: f32,
    /// Seconds without control (a knock-down; 0: none).
    pub down: f32,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Event {
    Hit(Hit),
    Kill(Kill),
    Spawn(Spawn),
    Despawn(Despawn),
    Sound(Sound),
    Light(Light),
    Particles(Particles),
    Camera(CameraFx),
    Ui(Ui),
    Rule(Rule),
    Motion(Motion),
    Push(Push),
    /// A plugin's own event: `kind` in CUSTOM_FIRST..=CUSTOM_LAST, 14 words of its own.
    Custom { kind: u32, words: [u32; 14] },
}

const fn b(x: f32) -> u32 {
    x.to_bits()
}
fn f(w: u32) -> f32 {
    let v = f32::from_bits(w);
    if v.is_finite() { v } else { 0.0 }
}
fn v3(w: &[u32]) -> Vec3 {
    Vec3::new(f(w[0]), f(w[1]), f(w[2]))
}

impl Event {
    pub fn kind(&self) -> u32 {
        match self {
            Event::Hit(_) => HIT,
            Event::Kill(_) => KILL,
            Event::Spawn(_) => SPAWN,
            Event::Despawn(_) => DESPAWN,
            Event::Sound(_) => SOUND,
            Event::Light(_) => LIGHT,
            Event::Particles(_) => PARTICLES,
            Event::Camera(_) => CAMERA,
            Event::Ui(_) => UI,
            Event::Rule(_) => RULE,
            Event::Motion(_) => MOTION,
            Event::Push(_) => PUSH,
            Event::Custom { kind, .. } => *kind,
        }
    }

    /// The 16 words JS reads.
    pub fn encode(&self, flags: u32) -> [u32; WORDS] {
        let mut w = [0u32; WORDS];
        w[0] = self.kind();
        w[15] = flags;
        let p = &mut w[1..15];
        match *self {
            Event::Hit(e) => p[..12].copy_from_slice(&[e.attacker, e.target, e.part as u32, b(e.point.x), b(e.point.y), b(e.point.z), b(e.normal.x), b(e.normal.y), b(e.normal.z), b(e.damage), e.crit as u32, e.region]),
            Event::Kill(e) => p[..10].copy_from_slice(&[e.attacker, e.target, e.part as u32, b(e.point.x), b(e.point.y), b(e.point.z), b(e.dir.x), b(e.dir.y), b(e.dir.z), b(e.damage)]),
            Event::Spawn(e) => p[..7].copy_from_slice(&[e.id, e.kind as u32, e.type_ as u32, b(e.pos.x), b(e.pos.y), b(e.pos.z), b(e.yaw)]),
            Event::Despawn(e) => p[..3].copy_from_slice(&[e.id, e.kind as u32, e.type_ as u32]),
            Event::Sound(e) => p[..7].copy_from_slice(&[e.name, e.source, b(e.pos.x), b(e.pos.y), b(e.pos.z), b(e.gain_db), b(e.rate)]),
            Event::Light(e) => p[..10].copy_from_slice(&[e.source, b(e.pos.x), b(e.pos.y), b(e.pos.z), b(e.color[0]), b(e.color[1]), b(e.color[2]), b(e.radius), b(e.intensity), e.frames]),
            Event::Particles(e) => p[..10].copy_from_slice(&[e.name, e.count, b(e.pos.x), b(e.pos.y), b(e.pos.z), b(e.dir.x), b(e.dir.y), b(e.dir.z), b(e.speed), b(e.spread)]),
            Event::Camera(e) => p[..7].copy_from_slice(&[e.player, b(e.kick_pitch), b(e.kick_yaw), b(e.fov_punch), b(e.fov_time), b(e.shake), b(e.shake_time)]),
            Event::Ui(e) => p[..10].copy_from_slice(&[e.what, e.player, b(e.pos.x), b(e.pos.y), b(e.pos.z), b(e.value), e.crit as u32, e.count, b(e.multiplier), b(e.seconds)]),
            Event::Rule(e) => p[..6].copy_from_slice(&[e.name, e.entity, b(e.a), b(e.b), b(e.c), b(e.d)]),
            Event::Motion(e) => p[..7].copy_from_slice(&[e.what, e.player, b(e.pos.x), b(e.pos.y), b(e.pos.z), b(e.speed), b(e.air)]),
            Event::Push(e) => p[..7].copy_from_slice(&[e.player, e.seq, b(e.vel.x), b(e.vel.y), b(e.vel.z), b(e.secs), b(e.down)]),
            Event::Custom { words, .. } => p.copy_from_slice(&words),
        }
        w
    }

    /// The event 16 words hold (the inverse of `encode`), and its flags. Unknown kinds below 32 → None.
    pub fn decode(w: &[u32; WORDS]) -> Option<(Event, u32)> {
        let p = &w[1..15];
        let e = match w[0] {
            HIT => Event::Hit(Hit { attacker: p[0], target: p[1], part: p[2] as u8, point: v3(&p[3..6]), normal: v3(&p[6..9]), damage: f(p[9]), crit: p[10] != 0, region: p[11] }),
            KILL => Event::Kill(Kill { attacker: p[0], target: p[1], part: p[2] as u8, point: v3(&p[3..6]), dir: v3(&p[6..9]), damage: f(p[9]) }),
            SPAWN => Event::Spawn(Spawn { id: p[0], kind: p[1] as u8, type_: p[2] as u16, pos: v3(&p[3..6]), yaw: f(p[6]) }),
            DESPAWN => Event::Despawn(Despawn { id: p[0], kind: p[1] as u8, type_: p[2] as u16 }),
            SOUND => Event::Sound(Sound { name: p[0], source: p[1], pos: v3(&p[2..5]), gain_db: f(p[5]), rate: f(p[6]) }),
            LIGHT => Event::Light(Light { source: p[0], pos: v3(&p[1..4]), color: [f(p[4]), f(p[5]), f(p[6])], radius: f(p[7]), intensity: f(p[8]), frames: p[9] }),
            PARTICLES => Event::Particles(Particles { name: p[0], count: p[1], pos: v3(&p[2..5]), dir: v3(&p[5..8]), speed: f(p[8]), spread: f(p[9]) }),
            CAMERA => Event::Camera(CameraFx { player: p[0], kick_pitch: f(p[1]), kick_yaw: f(p[2]), fov_punch: f(p[3]), fov_time: f(p[4]), shake: f(p[5]), shake_time: f(p[6]) }),
            UI => Event::Ui(Ui { what: p[0], player: p[1], pos: v3(&p[2..5]), value: f(p[5]), crit: p[6] != 0, count: p[7], multiplier: f(p[8]), seconds: f(p[9]) }),
            RULE => Event::Rule(Rule { name: p[0], entity: p[1], a: f(p[2]), b: f(p[3]), c: f(p[4]), d: f(p[5]) }),
            MOTION => Event::Motion(Motion { what: p[0], player: p[1], pos: v3(&p[2..5]), speed: f(p[5]), air: f(p[6]) }),
            PUSH => Event::Push(Push { player: p[0], seq: p[1], vel: v3(&p[2..5]), secs: f(p[5]), down: f(p[6]) }),
            k if (CUSTOM_FIRST..=CUSTOM_LAST).contains(&k) => {
                let mut words = [0u32; 14];
                words.copy_from_slice(p);
                Event::Custom { kind: k, words }
            }
            _ => return None,
        };
        Some((e, w[15]))
    }
}

/// The events of one tick: pushed by systems in step order, drained into `out` (16 words each) at the end of the tick.
pub struct Events {
    pending: Vec<(Event, u32)>,
    cap: usize,
    step_start: usize,
    /// Events dropped since the start (the oldest go first when a tick emits more than the capacity).
    pub dropped: u32,
    /// Events the host's snapshot carries to joiners (hits, kills, sounds, lights, particles, rules, despawns), kept
    /// until the next `snapshot()` takes them. Only filled on the copy that owns the world (`authority`).
    pub net: Vec<Event>,
    pub net_dropped: u32,
    pub authority: bool,
    /// Events pushed between steps (a command's damage, a host's snapshot applied on a joiner), kept for the next
    /// step's systems to read once (`early_events`): no step's `step_events` sees them otherwise.
    early: Vec<(Event, u32)>,
    early_now: Vec<(Event, u32)>,
    in_step: bool,
}

/// Events a tick keeps.
pub const EVENT_CAPACITY: usize = 1024;
/// Events kept for the next snapshot.
pub const NET_CAPACITY: usize = 256;

impl Default for Events {
    fn default() -> Self {
        Self::new(EVENT_CAPACITY)
    }
}

impl Events {
    pub fn new(cap: usize) -> Self {
        Self { pending: Vec::with_capacity(cap.min(4096)), cap: cap.max(1), step_start: 0, dropped: 0, net: Vec::new(), net_dropped: 0, authority: true, early: Vec::new(), early_now: Vec::new(), in_step: false }
    }
    pub fn push(&mut self, e: Event) {
        self.push_flags(e, 0);
    }
    pub fn push_flags(&mut self, e: Event, flags: u32) {
        if self.pending.len() >= self.cap {
            self.pending.remove(0);
            self.step_start = self.step_start.saturating_sub(1);
            self.dropped += 1;
        }
        if self.authority && flags & FLAG_REMOTE == 0 && replicated(&e) {
            if self.net.len() >= NET_CAPACITY {
                self.net.remove(0);
                self.net_dropped += 1;
            }
            self.net.push(e);
        }
        if !self.in_step && self.early.len() < self.cap {
            self.early.push((e, flags));
        }
        self.pending.push((e, flags));
    }
    /// What was emitted between the step before and this one (a command's events, a snapshot's REMOTE ones), with
    /// each event's flags. Each is here for one step only: a system that reads `step_events` and wants these too
    /// chains them (forge-feel's hit and kill fan-out on a joiner: the host's HIT and KILL arrive this way).
    pub fn early_events(&self) -> impl Iterator<Item = &(Event, u32)> {
        self.early_now.iter()
    }
    pub(crate) fn end_step(&mut self) {
        self.early_now.clear();
        self.in_step = false;
    }
    /// What this step has emitted so far (a later stage's system reads it: the feel turning hits into flashes).
    pub fn step_events(&self) -> impl Iterator<Item = &Event> {
        self.pending[self.step_start.min(self.pending.len())..].iter().map(|(e, _)| e)
    }
    /// Every event this tick has emitted so far.
    pub fn tick_events(&self) -> impl Iterator<Item = &Event> {
        self.pending.iter().map(|(e, _)| e)
    }
    /// The same, with each event's flags (`FLAG_REMOTE`: re-emitted from a host's snapshot).
    pub fn tick_events_flags(&self) -> impl Iterator<Item = &(Event, u32)> {
        self.pending.iter()
    }
    pub(crate) fn begin_step(&mut self) {
        self.step_start = self.pending.len();
        self.early_now = std::mem::take(&mut self.early);
        self.in_step = true;
    }
    pub fn len(&self) -> usize {
        self.pending.len()
    }
    pub fn is_empty(&self) -> bool {
        self.pending.is_empty()
    }
    /// Pack this tick's events into `out` (cleared first, 16 words each); the tick's list is empty after.
    pub fn drain_into(&mut self, out: &mut Vec<u32>) {
        out.clear();
        for (e, flags) in self.pending.drain(..) {
            out.extend_from_slice(&e.encode(flags));
        }
        self.step_start = 0;
    }
    /// Take the events waiting for the next snapshot.
    pub fn take_net(&mut self) -> Vec<Event> {
        std::mem::take(&mut self.net)
    }
}

/// The kinds a joiner needs from the host's copy (camera, UI and motion are each copy's own; so is the end of an
/// entity that was this copy's own: a debris piece, a coin, `Sim::spawn_local`).
pub fn replicated(e: &Event) -> bool {
    match e {
        Event::Despawn(d) => d.id < crate::sim::LOCAL_NET_ID,
        _ => matches!(e, Event::Hit(_) | Event::Kill(_) | Event::Sound(_) | Event::Light(_) | Event::Particles(_) | Event::Rule(_) | Event::Push(_)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn all() -> Vec<Event> {
        let p = Vec3::new(1.5, -2.0, 3.25);
        vec![
            Event::Hit(Hit { attacker: 1, target: 300, part: 3, point: p, normal: Vec3::Y, damage: 12.5, crit: true, region: 2 }),
            Event::Kill(Kill { attacker: 1, target: 300, part: 2, point: p, dir: Vec3::Z, damage: 30.0 }),
            Event::Spawn(Spawn { id: 301, kind: 2, type_: 1, pos: p, yaw: 0.5 }),
            Event::Despawn(Despawn { id: 301, kind: 2, type_: 1 }),
            Event::Sound(Sound { name: 4, source: 1, pos: p, gain_db: -6.0, rate: 1.0 }),
            Event::Light(Light { source: 1, pos: p, color: [1.0, 0.48, 0.13], radius: 3.4, intensity: 1.8, frames: 4 }),
            Event::Particles(Particles { name: 5, count: 40, pos: p, dir: Vec3::X, speed: 6.0, spread: 0.6 }),
            Event::Camera(CameraFx { player: 1, kick_pitch: 1.19, kick_yaw: 0.01, fov_punch: 2.6, fov_time: 0.165, shake: 0.016, shake_time: 0.2 }),
            Event::Ui(Ui { what: UI_DAMAGE, player: 1, pos: p, value: 25.0, crit: true, count: 3, multiplier: 1.2, seconds: 2.0 }),
            Event::Rule(Rule { name: 7, entity: 300, a: 1.0, b: 2.0, c: 3.0, d: 4.0 }),
            Event::Motion(Motion { what: MOTION_LAND, player: 1, pos: p, speed: 6.0, air: 0.65 }),
            Event::Push(Push { player: 2, seq: 4242, vel: Vec3::new(3.0, 2.0, -4.5), secs: 0.4, down: 0.7 }),
            Event::Custom { kind: 33, words: [9; 14] },
        ]
    }

    #[test]
    fn every_kind_round_trips_through_its_words() {
        for e in all() {
            let w = e.encode(FLAG_REMOTE);
            assert_eq!(w[0], e.kind());
            assert_eq!(w[15], FLAG_REMOTE);
            let (back, flags) = Event::decode(&w).unwrap();
            assert_eq!(back, e);
            assert_eq!(flags, FLAG_REMOTE);
        }
        assert!(Event::decode(&[999; WORDS]).is_none());
    }

    #[test]
    fn a_full_tick_drops_the_oldest_and_counts_them() {
        let mut ev = Events::new(4);
        for i in 0..6 {
            ev.push(Event::Rule(Rule { name: i, entity: 0, a: 0.0, b: 0.0, c: 0.0, d: 0.0 }));
        }
        assert_eq!(ev.dropped, 2);
        let mut out = Vec::new();
        ev.drain_into(&mut out);
        assert_eq!(out.len(), 4 * WORDS);
        assert_eq!(out[1], 2, "the oldest kept is the third");
        assert!(ev.is_empty());
    }

    #[test]
    fn a_later_stage_sees_only_this_steps_events_and_the_snapshot_queue_only_replicated_ones() {
        let mut ev = Events::default();
        ev.push(Event::Motion(Motion { what: MOTION_STEP, player: 1, pos: Vec3::ZERO, speed: 7.8, air: 0.0 }));
        ev.begin_step();
        ev.push(Event::Sound(Sound { name: 1, source: 1, pos: Vec3::ZERO, gain_db: 0.0, rate: 1.0 }));
        assert_eq!(ev.step_events().count(), 1);
        assert_eq!(ev.tick_events().count(), 2);
        assert_eq!(ev.net.len(), 1, "motion is each copy's own; the sound goes to joiners");
        ev.push_flags(Event::Sound(Sound { name: 1, source: 1, pos: Vec3::ZERO, gain_db: 0.0, rate: 1.0 }), FLAG_REMOTE);
        assert_eq!(ev.net.len(), 1, "a remote event is never sent back");
    }
}
