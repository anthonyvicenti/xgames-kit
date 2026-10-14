//! Snapshot v2 (PLAN §2 "multiplayer"; ARCHITECTURE.md "Snapshot"; live co-op in net.rs): `Core::snapshot()` → bytes on
//! the copy that owns the world, `Core::apply(bytes)` on the others. Sized for the live standard (CONTRACT §4.1, §6h;
//! gf-multiplayer `net.world`: at most 12 a second, under 3.5 KB of JSON): the bytes travel base64-encoded, so one
//! snapshot is at most `MAX_BYTES` (2600 bytes → 3468 base64 characters, room for the JSON around it). Quantized,
//! little endian.
//!
//! v3 (wave 2, the game loop) over v2: each player carries a plugin's bytes (`SnapBlob`: forge-feel's cards held, the
//! reward's deal and choice, being down and the revive under way), on every copy its own player included, so a joiner
//! predicts with the same card-changed values the host simulates with; and a PUSH event (a shove or a knock-down with
//! the joiner's own input step it starts at).
//!
//! v2 (track S, live co-op) over v1: each player carries the last input step of its owner the host applied (`ack`, for
//! the joiner's reconciliation) and the weapon in hand (`held`); a light carries its source; the header names the
//! previous snapshot's tick and the snapshot repeats that one's events first (`repeats`), so a joiner that missed it
//! (two snapshots arriving in one frame, where the page only sees the newest) still plays them, and one that saw it
//! skips them; a snapshot at or before one already applied is ignored.
//!
//! ```text
//! header   17 B  "GF", version 3, flags (1 actors cut, 2 events cut), tick u32 (the host's step), prev u32 (the tick of
//!                the snapshot before), players u8, actors u16, events u8, repeats u8 (the first `repeats` events are
//!                the previous snapshot's)
//! players  23 B  each: id u8, x y z i16 (1/64 m, ±512 m), yaw u16 (a turn / 65536), pitch i16 (±π/2), vx vy vz i8
//!                (0.25 m/s), flags u8 (1 grounded, 2 alive), hp u8 (share × 255), armour u8 (whole points, ≤ 255),
//!                state u8 (a plugin's), held u8 (the weapons row in hand, 255 none), ack u32 (its owner's last input
//!                step the host applied; 0 none), then blob: length u8 (≤ `BLOB_MAX`), that many bytes (a plugin's)
//! actors   14 B  each: net id u16, kind u8, type u8, x y z i16, yaw u8 (a turn / 256), hp u8 (share × 255), flags u8 (1 dead;
//!                bits 1..7 a plugin's mark, components::Marked: wave 7, forge-ai's elite modifier), state u8
//! names          count u8, then each: length u8, UTF-8 bytes (the sound, particle and rule names the events below use)
//! events         each: kind u8, then
//!                  HIT       attacker u16, target u16, part u8, point 3×i16, damage u16 (×10), crit << 7 | region u8   (15 B)
//!                  KILL      attacker u16, target u16, part u8, point 3×i16, dir 3×i8 (×127)                        (15 B)
//!                  DESPAWN   id u16, kind u8                                                                         (4 B)
//!                  SOUND     name u8 (index into names), source u16, pos 3×i16, gain i8 (dB)                         (11 B)
//!                  LIGHT     source u16, pos 3×i16, r g b u8 (linear × 255), radius u8 (0.1 m), intensity u8 (0.1),
//!                            frames u8                                                                               (15 B)
//!                  PARTICLES name u8, count u8, pos 3×i16, dir 3×i8, speed u8 (0.25 m/s)                             (13 B)
//!                  RULE      name u8, entity u16, a b c d f32                                                        (20 B)
//!                  PUSH      player u8, seq u32, vel x z i16 (1/256 m/s), hop u8 (1/16 m/s), secs u8 (1/100 s),
//!                            down u8 (1/100 s)                                                                       (13 B)
//! ```
//! Players are always sent. Then the new events (newest kept when there are more than fit `EVENTS_MAX_BYTES`), the
//! previous snapshot's again (within `REPEAT_MAX_BYTES`), then the actors, longest unsent first, nearest a player next,
//! until `MAX_BYTES`: an actor left out keeps its last state on the joiners (flag "actors cut"); in a complete snapshot
//! an actor that is missing is gone.
use std::collections::HashMap;

use glam::{Quat, Vec3};
use hecs::Entity;

use crate::components::*;
use crate::events::{self, Event, FLAG_REMOTE};
use crate::net::{self, NetState};
use crate::sim::Sim;
use crate::Core;

pub const VERSION: u8 = 3;
/// The largest snapshot: 2600 bytes is 3468 base64 characters, under the live standard's 3.5 KB with its JSON.
pub const MAX_BYTES: usize = 2600;
/// The most the new events may take of it.
pub const EVENTS_MAX_BYTES: usize = 900;
/// The most the previous snapshot's events, repeated, may take.
pub const REPEAT_MAX_BYTES: usize = 400;
pub const HEADER_BYTES: usize = 17;
/// A player's fixed part: 23 bytes and its blob's length byte (the blob's own bytes follow).
pub const PLAYER_BYTES: usize = 24;
/// The most bytes of a plugin's blob a player carries.
pub const BLOB_MAX: usize = 96;
pub const ACTOR_BYTES: usize = 14;
pub const FLAG_ACTORS_CUT: u8 = 1;
pub const FLAG_EVENTS_CUT: u8 = 2;
/// A snapshot more than a minute of steps older than the last one applied is a host that started again, not a stale one.
const RESTART_STEPS: u32 = 120 * 60;

/// The host's bookkeeping between snapshots (which actor was sent when, the last events), and a joiner's (the last
/// snapshot applied).
#[derive(Default, Debug)]
pub struct SnapState {
    pub count: u32,
    last_sent: HashMap<u32, u32>,
    /// The last snapshot's size, bytes.
    pub last_bytes: usize,
    /// On a joiner: the local player's state in the last snapshot applied: (the host's tick, feet, yaw, velocity).
    pub authority: Option<(u32, Vec3, f32, Vec3)>,
    /// The host: the tick of the last snapshot and the events it carried (the next one repeats them).
    pub prev_tick: u32,
    prev_events: Vec<Event>,
    /// A joiner: the last snapshot applied (its tick), how many were applied, ignored as stale, and the repeated events
    /// played because the snapshot that carried them first was missed.
    pub applied_tick: u32,
    pub applied: u32,
    pub stale: u32,
    pub recovered: u32,
}

fn q_pos(v: f32) -> i16 {
    (v * 64.0).round().clamp(-32768.0, 32767.0) as i16
}
fn dq_pos(v: i16) -> f32 {
    v as f32 / 64.0
}
fn q_unit(v: f32) -> i8 {
    (v * 127.0).round().clamp(-127.0, 127.0) as i8
}

struct W(Vec<u8>);
impl W {
    fn u8(&mut self, v: u8) {
        self.0.push(v);
    }
    fn i8(&mut self, v: i8) {
        self.0.push(v as u8);
    }
    fn u16(&mut self, v: u16) {
        self.0.extend_from_slice(&v.to_le_bytes());
    }
    fn i16(&mut self, v: i16) {
        self.0.extend_from_slice(&v.to_le_bytes());
    }
    fn u32(&mut self, v: u32) {
        self.0.extend_from_slice(&v.to_le_bytes());
    }
    fn f32(&mut self, v: f32) {
        self.0.extend_from_slice(&v.to_le_bytes());
    }
    fn pos(&mut self, p: Vec3) {
        self.i16(q_pos(p.x));
        self.i16(q_pos(p.y));
        self.i16(q_pos(p.z));
    }
    fn dir(&mut self, d: Vec3) {
        let d = d.normalize_or_zero();
        self.i8(q_unit(d.x));
        self.i8(q_unit(d.y));
        self.i8(q_unit(d.z));
    }
}

struct R<'a> {
    b: &'a [u8],
    at: usize,
}
impl R<'_> {
    fn take(&mut self, n: usize) -> Result<&[u8], &'static str> {
        let s = self.b.get(self.at..self.at + n).ok_or("snapshot cut short")?;
        self.at += n;
        Ok(s)
    }
    fn u8(&mut self) -> Result<u8, &'static str> {
        Ok(self.take(1)?[0])
    }
    fn i8(&mut self) -> Result<i8, &'static str> {
        Ok(self.u8()? as i8)
    }
    fn u16(&mut self) -> Result<u16, &'static str> {
        let s = self.take(2)?;
        Ok(u16::from_le_bytes([s[0], s[1]]))
    }
    fn i16(&mut self) -> Result<i16, &'static str> {
        Ok(self.u16()? as i16)
    }
    fn u32(&mut self) -> Result<u32, &'static str> {
        let s = self.take(4)?;
        Ok(u32::from_le_bytes([s[0], s[1], s[2], s[3]]))
    }
    fn f32(&mut self) -> Result<f32, &'static str> {
        let v = f32::from_bits(self.u32()?);
        Ok(if v.is_finite() { v } else { 0.0 })
    }
    fn pos(&mut self) -> Result<Vec3, &'static str> {
        Ok(Vec3::new(dq_pos(self.i16()?), dq_pos(self.i16()?), dq_pos(self.i16()?)))
    }
    fn dir(&mut self) -> Result<Vec3, &'static str> {
        Ok(Vec3::new(self.i8()? as f32 / 127.0, self.i8()? as f32 / 127.0, self.i8()? as f32 / 127.0))
    }
}

/// A player's state in a snapshot (decoded).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct PlayerSnap {
    pub id: u32,
    pub pos: Vec3,
    pub yaw: f32,
    pub pitch: f32,
    pub vel: Vec3,
    pub grounded: bool,
    pub alive: bool,
    pub hp: f32,
    pub armor: f32,
    pub state: u8,
    /// The weapons-table row in hand (`HELD_NONE`: nothing).
    pub held: u8,
    /// The last input step of this player's owner the host applied (0: none; the host's own player).
    pub ack: u32,
}

/// The bytes a plugin keeps on a player for the snapshots to carry (at most `BLOB_MAX`): the host's copy writes them,
/// `apply` puts the host's on every player of a joiner's copy, its own included. forge-feel's: the cards a player
/// holds, their reward choice, being down, a revive's progress (forge-feel `cards::blob`).
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct SnapBlob(pub Vec<u8>);

/// An actor's state in a snapshot (decoded).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct ActorSnap {
    pub id: u32,
    pub kind: u8,
    pub type_: u8,
    pub pos: Vec3,
    pub yaw: f32,
    pub hp: f32,
    pub dead: bool,
    pub state: u8,
    /// A plugin's mark (`components::Marked`, the flags byte's bits 1..7).
    pub mark: u8,
}

/// A whole snapshot, decoded (`decode`; `Core::apply` does the same and applies it).
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Decoded {
    pub flags: u8,
    pub tick: u32,
    /// The tick of the snapshot before this one (0: none).
    pub prev: u32,
    pub players: Vec<PlayerSnap>,
    pub actors: Vec<ActorSnap>,
    /// Each player's plugin bytes (`SnapBlob`), in the players' order.
    pub blobs: Vec<Vec<u8>>,
    /// Events with their names as strings (sound, particle and rule names); the first `repeats` are the previous
    /// snapshot's.
    pub events: Vec<(Event, Option<String>)>,
    pub repeats: usize,
}

fn yaw_of(rot: Quat) -> f32 {
    let f = rot * Vec3::NEG_Z;
    (-f.x).atan2(-f.z)
}

/// The per-entity "state" byte a plugin sets (a weapon's index, an AI phase): `SnapByte(n)`.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct SnapByte(pub u8);

fn encode_event(w: &mut W, e: &Event, names: &mut Vec<String>, sim: &Sim) -> bool {
    let mut name_ix = |id: u32| -> u8 {
        let s = sim.names.get(id).to_string();
        if let Some(i) = names.iter().position(|n| *n == s) {
            return i as u8;
        }
        names.push(s);
        (names.len() - 1) as u8
    };
    match *e {
        Event::Hit(h) => {
            w.u8(events::HIT as u8);
            w.u16(h.attacker as u16);
            w.u16(h.target as u16);
            w.u8(h.part);
            w.pos(h.point);
            w.u16((h.damage * 10.0).round().clamp(0.0, 65535.0) as u16);
            w.u8(((h.crit as u8) << 7) | (h.region.min(127) as u8));
        }
        Event::Kill(k) => {
            w.u8(events::KILL as u8);
            w.u16(k.attacker as u16);
            w.u16(k.target as u16);
            w.u8(k.part);
            w.pos(k.point);
            w.dir(k.dir);
        }
        Event::Despawn(d) => {
            w.u8(events::DESPAWN as u8);
            w.u16(d.id as u16);
            w.u8(d.kind);
        }
        Event::Sound(s) => {
            let n = name_ix(s.name);
            w.u8(events::SOUND as u8);
            w.u8(n);
            w.u16(s.source as u16);
            w.pos(s.pos);
            w.i8(s.gain_db.round().clamp(-127.0, 127.0) as i8);
        }
        Event::Light(l) => {
            w.u8(events::LIGHT as u8);
            w.u16(l.source as u16);
            w.pos(l.pos);
            for c in l.color {
                w.u8((c * 255.0).round().clamp(0.0, 255.0) as u8);
            }
            w.u8((l.radius * 10.0).round().clamp(0.0, 255.0) as u8);
            w.u8((l.intensity * 10.0).round().clamp(0.0, 255.0) as u8);
            w.u8(l.frames.min(255) as u8);
        }
        Event::Particles(p) => {
            let n = name_ix(p.name);
            w.u8(events::PARTICLES as u8);
            w.u8(n);
            w.u8(p.count.min(255) as u8);
            w.pos(p.pos);
            w.dir(p.dir);
            w.u8((p.speed * 4.0).round().clamp(0.0, 255.0) as u8);
        }
        Event::Rule(r) => {
            let n = name_ix(r.name);
            w.u8(events::RULE as u8);
            w.u8(n);
            w.u16(r.entity as u16);
            for v in [r.a, r.b, r.c, r.d] {
                w.f32(v);
            }
        }
        Event::Push(p) => {
            w.u8(events::PUSH as u8);
            w.u8(p.player.min(255) as u8);
            w.u32(p.seq);
            w.i16((p.vel.x * 256.0).round().clamp(-32767.0, 32767.0) as i16);
            w.i16((p.vel.z * 256.0).round().clamp(-32767.0, 32767.0) as i16);
            w.u8((p.vel.y * 16.0).round().clamp(0.0, 255.0) as u8);
            w.u8((p.secs * 100.0).round().clamp(0.0, 255.0) as u8);
            w.u8((p.down * 100.0).round().clamp(0.0, 255.0) as u8);
        }
        _ => return false,
    }
    true
}

fn decode_event(r: &mut R, names: &[String]) -> Result<(Event, Option<String>), &'static str> {
    let kind = r.u8()? as u32;
    let name = |i: u8| names.get(i as usize).cloned();
    Ok(match kind {
        events::HIT => {
            let (attacker, target, part, point) = (r.u16()? as u32, r.u16()? as u32, r.u8()?, r.pos()?);
            let damage = r.u16()? as f32 / 10.0;
            let cr = r.u8()?;
            (Event::Hit(events::Hit { attacker, target, part, point, normal: Vec3::ZERO, damage, crit: cr & 0x80 != 0, region: (cr & 0x7f) as u32 }), None)
        }
        events::KILL => (Event::Kill(events::Kill { attacker: r.u16()? as u32, target: r.u16()? as u32, part: r.u8()?, point: r.pos()?, dir: r.dir()?, damage: 0.0 }), None),
        events::DESPAWN => (Event::Despawn(events::Despawn { id: r.u16()? as u32, kind: r.u8()?, type_: 0 }), None),
        events::SOUND => {
            let n = r.u8()?;
            (Event::Sound(events::Sound { name: 0, source: r.u16()? as u32, pos: r.pos()?, gain_db: r.i8()? as f32, rate: 1.0 }), name(n))
        }
        events::LIGHT => {
            let source = r.u16()? as u32;
            let pos = r.pos()?;
            let color = [r.u8()? as f32 / 255.0, r.u8()? as f32 / 255.0, r.u8()? as f32 / 255.0];
            (Event::Light(events::Light { source, pos, color, radius: r.u8()? as f32 / 10.0, intensity: r.u8()? as f32 / 10.0, frames: r.u8()? as u32 }), None)
        }
        events::PARTICLES => {
            let n = r.u8()?;
            (Event::Particles(events::Particles { name: 0, count: r.u8()? as u32, pos: r.pos()?, dir: r.dir()?, speed: r.u8()? as f32 / 4.0, spread: 0.0 }), name(n))
        }
        events::RULE => {
            let n = r.u8()?;
            (Event::Rule(events::Rule { name: 0, entity: r.u16()? as u32, a: r.f32()?, b: r.f32()?, c: r.f32()?, d: r.f32()? }), name(n))
        }
        events::PUSH => {
            let (player, seq) = (r.u8()? as u32, r.u32()?);
            let (vx, vz) = (r.i16()? as f32 / 256.0, r.i16()? as f32 / 256.0);
            let hop = r.u8()? as f32 / 16.0;
            (Event::Push(events::Push { player, seq, vel: Vec3::new(vx, hop, vz), secs: r.u8()? as f32 / 100.0, down: r.u8()? as f32 / 100.0 }), None)
        }
        _ => return Err("an event kind the snapshot does not carry"),
    })
}

/// Decode a snapshot without applying it (tests, tools).
pub fn decode(bytes: &[u8]) -> Result<Decoded, &'static str> {
    if bytes.len() < HEADER_BYTES || &bytes[..2] != b"GF" {
        return Err("not a gf-forge snapshot");
    }
    if bytes[2] != VERSION {
        return Err("a gf-forge snapshot of another version");
    }
    let mut r = R { b: bytes, at: 3 };
    let flags = r.u8()?;
    let tick = r.u32()?;
    let prev = r.u32()?;
    let (np, na, ne, nr) = (r.u8()? as usize, r.u16()? as usize, r.u8()? as usize, r.u8()? as usize);
    let mut d = Decoded { flags, tick, prev, repeats: nr.min(ne), ..Decoded::default() };
    for _ in 0..np {
        let id = r.u8()? as u32;
        let pos = r.pos()?;
        let yaw = r.u16()? as f32 / 65536.0 * std::f32::consts::TAU;
        let pitch = r.i16()? as f32 / 32767.0 * std::f32::consts::FRAC_PI_2;
        let vel = Vec3::new(r.i8()? as f32 * 0.25, r.i8()? as f32 * 0.25, r.i8()? as f32 * 0.25);
        let fl = r.u8()?;
        let (hp, armor, state, held, ack) = (r.u8()? as f32 / 255.0, r.u8()? as f32, r.u8()?, r.u8()?, r.u32()?);
        d.players.push(PlayerSnap { id, pos, yaw: crate::wrap(yaw), pitch, vel, grounded: fl & 1 != 0, alive: fl & 2 != 0, hp, armor, state, held, ack });
        let n = r.u8()? as usize;
        d.blobs.push(r.take(n)?.to_vec());
    }
    for _ in 0..na {
        let (id, kind, type_, pos) = (r.u16()? as u32, r.u8()?, r.u8()?, r.pos()?);
        let yaw = crate::wrap(r.u8()? as f32 / 256.0 * std::f32::consts::TAU);
        let (hp, fl, state) = (r.u8()? as f32 / 255.0, r.u8()?, r.u8()?);
        d.actors.push(ActorSnap { id, kind, type_, pos, yaw, hp, dead: fl & 1 != 0, state, mark: fl >> 1 });
    }
    let nn = r.u8()? as usize;
    let mut names = Vec::with_capacity(nn);
    for _ in 0..nn {
        let len = r.u8()? as usize;
        names.push(String::from_utf8_lossy(r.take(len)?).into_owned());
    }
    for _ in 0..ne {
        d.events.push(decode_event(&mut r, &names)?);
    }
    Ok(d)
}

/// Point a replica at a new sample (from where it is drawn now; `span`: the time since the last sample).
pub fn replica_to(sim: &mut Sim, e: Entity, to: Vec3, yaw: f32) {
    let now = sim.world.get::<&Transform>(e).map(|t| (t.pos, yaw_of(t.rot))).ok();
    let Ok(mut r) = sim.world.get::<&mut Replica>(e) else { return };
    let (pos, cur_yaw) = now.unwrap_or((to, yaw));
    // its look up and down goes on from where it is drawn now (`replica_look` gives the new sample)
    r.from_pitch += (r.to_pitch - r.from_pitch) * r.share(0.0);
    r.to_pitch = r.from_pitch;
    // how fast the host moved it between the last two samples (a first sample, or a jump: none)
    let gap = r.t.max(1.0 / 120.0);
    let v = (to - r.to) / gap;
    r.vel = if r.span > 0.0 && gap < 0.5 && v.length() < 30.0 { v } else { Vec3::ZERO };
    r.span = r.t.clamp(1.0 / 120.0, 0.5);
    r.t = 0.0;
    r.from = pos;
    r.from_yaw = cur_yaw;
    r.to = to;
    r.to_yaw = yaw;
}

/// A replica player's look up and down in the sample `replica_to` just took (`first`: its first sample, nothing to
/// turn from). A viewer's camera turns between the two (`Replica::pitch_at`).
pub fn replica_look(sim: &mut Sim, e: Entity, pitch: f32, first: bool) {
    if let Ok(mut r) = sim.world.get::<&mut Replica>(e) {
        r.to_pitch = pitch;
        if first {
            r.from_pitch = pitch;
        }
    }
}

/// The yaw a rotation about the up axis looks along (the core's: 0 looks down −Z).
pub fn yaw_of_rot(rot: Quat) -> f32 {
    yaw_of(rot)
}

/// Encode as many of `list` (newest kept) as fit `budget` bytes with the names they add. → (their bytes in order, cut)
fn encode_within(list: &[Event], budget: usize, names: &mut Vec<String>, sim: &Sim) -> (Vec<Vec<u8>>, Vec<Event>, bool) {
    let mut chunks: Vec<(Vec<u8>, Event)> = Vec::new();
    let mut used = 0usize;
    let mut cut = false;
    let name_bytes = |ns: &[String]| -> usize { ns.iter().map(|n| 1 + n.len().min(255)).sum() };
    for e in list.iter().rev() {
        let mut ew = W(Vec::new());
        let mut trial = names.clone();
        if !encode_event(&mut ew, e, &mut trial, sim) {
            continue;
        }
        let added = name_bytes(&trial[names.len()..]);
        if used + ew.0.len() + added > budget || chunks.len() >= 255 || trial.len() > 255 {
            cut = true;
            break;
        }
        used += ew.0.len() + added;
        *names = trial;
        chunks.push((ew.0, *e));
    }
    chunks.reverse();
    let (bytes, kept) = chunks.into_iter().unzip();
    (bytes, kept, cut)
}

impl Core {
    /// The world as this copy owns it, for the others (at most `MAX_BYTES`). Takes the events waiting for it.
    pub fn snapshot(&mut self) -> Vec<u8> {
        let acks: HashMap<u32, u32> = self.sim.res.get::<NetState>().map(|n| n.queues.iter().map(|(id, q)| (*id, q.ack)).collect()).unwrap_or_default();
        let sim = &mut self.sim;
        let state = &mut self.snapshots;
        state.count += 1;
        let mut w = W(Vec::with_capacity(MAX_BYTES));
        w.0.extend_from_slice(b"GF");
        w.u8(VERSION);
        w.u8(0);
        let tick = sim.time.step as u32;
        w.u32(tick);
        w.u32(state.prev_tick);
        // players
        let mut players: Vec<(Player, Transform, Look, Velocity, bool, Option<Health>, u8, u8, Vec<u8>)> = sim
            .world
            .query::<(&Player, &Transform, &Look, Option<&Velocity>, Option<&crate::physics::Mover>, Option<&Health>, Option<&SnapByte>, Option<&Wear>, Option<&SnapBlob>)>()
            .iter()
            .map(|(p, t, l, v, m, h, s, wr, blob)| (*p, *t, *l, v.copied().unwrap_or_default(), m.map(|m| m.grounded).unwrap_or(true), h.copied(), s.map(|s| s.0).unwrap_or(0), wr.map(|w| w.held).unwrap_or(HELD_NONE), blob.map(|b| b.0[..b.0.len().min(BLOB_MAX)].to_vec()).unwrap_or_default()))
            .collect();
        players.sort_by_key(|p| p.0.id);
        players.truncate(crate::MAX_PLAYERS.min(255));
        w.u8(players.len() as u8);
        let actors_at = w.0.len();
        w.u16(0);
        let events_at = w.0.len();
        w.u8(0);
        w.u8(0);
        let mut player_pos = Vec::new();
        for (p, t, l, v, grounded, h, s, held, blob) in &players {
            w.u8(p.id.min(255) as u8);
            w.pos(t.pos);
            w.u16((crate::wrap(l.yaw).rem_euclid(std::f32::consts::TAU) / std::f32::consts::TAU * 65536.0).round() as u32 as u16);
            w.i16((l.pitch / std::f32::consts::FRAC_PI_2 * 32767.0).round().clamp(-32767.0, 32767.0) as i16);
            for c in [v.linear.x, v.linear.y, v.linear.z] {
                w.i8((c * 4.0).round().clamp(-127.0, 127.0) as i8);
            }
            let alive = h.map(|h| !h.dead).unwrap_or(true);
            w.u8((*grounded as u8) | ((alive as u8) << 1));
            w.u8(h.map(|h| (h.fraction() * 255.0).round() as u8).unwrap_or(255));
            w.u8(h.map(|h| h.armor.round().clamp(0.0, 255.0) as u8).unwrap_or(0));
            w.u8(*s);
            w.u8(*held);
            w.u32(acks.get(&p.id).copied().unwrap_or(0));
            w.u8(blob.len() as u8);
            w.0.extend_from_slice(blob);
            player_pos.push(t.pos);
        }
        // the events: the new ones first (they have the room), then the previous snapshot's again
        let mut flags = 0u8;
        let net = sim.events.take_net();
        let mut names: Vec<String> = Vec::new();
        let (fresh, kept, cut) = encode_within(&net, EVENTS_MAX_BYTES, &mut names, sim);
        if cut {
            flags |= FLAG_EVENTS_CUT;
        }
        let (again, _, _) = encode_within(&state.prev_events, REPEAT_MAX_BYTES, &mut names, sim);
        let names_bytes: usize = 1 + names.iter().map(|n| 1 + n.len().min(255)).sum::<usize>();
        let events_bytes: usize = fresh.iter().chain(again.iter()).map(|c| c.len()).sum();
        let repeats = again.len().min(255 - fresh.len().min(255));
        // the actors, longest unsent first, then nearest a player
        let mut actors: Vec<(u32, Kind, Transform, Option<Health>, u8, u32, f32, u8)> = sim
            .world
            .query::<(&NetId, &Kind, &Transform, Option<&Health>, Option<&SnapByte>, Option<&Player>, Option<&Marked>)>()
            // what is each copy's own (debris, coins, a player's own rounds: components::Local) never crowds a snapshot
            .without::<&Local>()
            .iter()
            .filter(|(.., p, _)| p.is_none())
            .map(|(n, k, t, h, s, _, m)| {
                let stale = state.count - state.last_sent.get(&n.0).copied().unwrap_or(0);
                let near = player_pos.iter().map(|p| p.distance(t.pos)).fold(f32::MAX, f32::min);
                (n.0, *k, *t, h.copied(), s.map(|s| s.0).unwrap_or(0), stale, near, m.map(|m| m.mark.min(Marked::MAX_MARK)).unwrap_or(0))
            })
            .collect();
        actors.sort_by(|a, b| b.5.cmp(&a.5).then(a.6.total_cmp(&b.6)).then(a.0.cmp(&b.0)));
        let room = MAX_BYTES.saturating_sub(w.0.len() + names_bytes + events_bytes);
        let fit = (room / ACTOR_BYTES).min(actors.len()).min(u16::MAX as usize);
        if fit < actors.len() {
            flags |= FLAG_ACTORS_CUT;
        }
        let mut sent: Vec<_> = actors[..fit].to_vec();
        sent.sort_by_key(|a| a.0);
        for (id, k, t, h, s, _, _, mark) in &sent {
            w.u16(*id as u16);
            w.u8(k.kind);
            w.u8(k.type_.min(255) as u8);
            w.pos(t.pos);
            w.u8((yaw_of(t.rot).rem_euclid(std::f32::consts::TAU) / std::f32::consts::TAU * 256.0).round() as u32 as u8);
            w.u8(h.map(|h| (h.fraction() * 255.0).round() as u8).unwrap_or(255));
            w.u8(h.map(|h| h.dead as u8).unwrap_or(0) | (*mark << 1));
            w.u8(*s);
            state.last_sent.insert(*id, state.count);
        }
        state.last_sent.retain(|id, _| sim.entity_of(*id).is_some());
        // the names, then the repeated events, then the new ones
        w.u8(names.len() as u8);
        for n in &names {
            let b = &n.as_bytes()[..n.len().min(255)];
            w.u8(b.len() as u8);
            w.0.extend_from_slice(b);
        }
        for c in again.iter().take(repeats) {
            w.0.extend_from_slice(c);
        }
        for c in &fresh {
            w.0.extend_from_slice(c);
        }
        let n_actors = sent.len() as u16;
        w.0[actors_at..actors_at + 2].copy_from_slice(&n_actors.to_le_bytes());
        w.0[events_at] = (repeats + fresh.len()).min(255) as u8;
        w.0[events_at + 1] = repeats as u8;
        w.0[3] = flags;
        state.last_bytes = w.0.len();
        state.prev_tick = tick;
        state.prev_events = kept;
        w.0
    }

    /// Take the host's snapshot on a joiner: every player this copy does not simulate and every actor become
    /// replicas moving toward their new state; the events are emitted here as REMOTE (but those this copy predicted);
    /// its own player is reconciled against the host's state of it (net.rs). → the players and actors read ((0, 0)
    /// for a stale snapshot, which is ignored).
    pub fn apply(&mut self, bytes: &[u8]) -> Result<(usize, usize), &'static str> {
        let d = decode(bytes)?;
        let applied = self.snapshots.applied_tick;
        if applied != 0 && d.tick <= applied && applied - d.tick < RESTART_STEPS {
            self.snapshots.stale += 1;
            return Ok((0, 0));
        }
        // the previous snapshot's events again: played only when that snapshot was missed
        let play_repeats = applied != 0 && applied < d.prev;
        self.snapshots.applied_tick = d.tick;
        self.snapshots.applied += 1;
        let local = self.sim.res.get::<NetState>().filter(|n| n.is_joiner()).map(|n| n.local);
        let sim = &mut self.sim;
        for (i, p) in d.players.iter().enumerate() {
            let blob = d.blobs.get(i).cloned().unwrap_or_default();
            match sim.players.get(&p.id).copied() {
                Some(e) => {
                    // a plugin's bytes, on this copy's own player too (the cards it holds change what it predicts)
                    if sim.world.get::<&SnapBlob>(e).map(|b| b.0 != blob).unwrap_or(true) {
                        let _ = sim.world.insert_one(e, SnapBlob(blob));
                    }
                    let own = sim.world.get::<&Player>(e).map(|x| x.owned).unwrap_or(false);
                    if own {
                        if sim.world.get::<&Player>(e).map(|x| x.local).unwrap_or(false) {
                            self.snapshots.authority = Some((d.tick, p.pos, p.yaw, p.vel));
                            // the joiner's own player: the host's health, and where the host has it at its last input
                            if local == Some(p.id) {
                                if let Ok(mut h) = sim.world.get::<&mut Health>(e) {
                                    h.hp = p.hp * h.max;
                                    h.armor = p.armor;
                                    h.dead = !p.alive;
                                }
                                net::reconcile(sim, e, p.ack, p.pos, p.vel);
                            }
                        }
                        continue;
                    }
                    replica_to(sim, e, p.pos, p.yaw);
                    replica_look(sim, e, p.pitch, false);
                    sync_player(sim, e, p);
                }
                None => {
                    let e = sim.spawn_player_flags(p.id, p.pos, p.yaw, false, false, FLAG_REMOTE);
                    let _ = sim.world.insert(e, (Replica::at(p.pos, p.yaw), SnapBlob(blob)));
                    replica_look(sim, e, p.pitch, true);
                    sync_player(sim, e, p);
                }
            }
        }
        let mut seen = std::collections::HashSet::new();
        for a in &d.actors {
            seen.insert(a.id);
            let e = match sim.entity_of(a.id) {
                Some(e) => e,
                None => {
                    let e = sim.world.spawn((Transform::facing(a.pos, a.yaw), Kind { kind: a.kind, type_: a.type_ as u16 }, Replica::at(a.pos, a.yaw), Health::new(1.0)));
                    sim.set_net_id(e, a.id);
                    sim.events.push_flags(Event::Spawn(events::Spawn { id: a.id, kind: a.kind, type_: a.type_ as u16, pos: a.pos, yaw: a.yaw }), FLAG_REMOTE);
                    e
                }
            };
            replica_to(sim, e, a.pos, a.yaw);
            if let Ok(mut h) = sim.world.get::<&mut Health>(e) {
                h.hp = a.hp;
                h.max = 1.0;
                h.dead = a.dead;
            }
            let _ = sim.world.insert_one(e, SnapByte(a.state));
            if a.mark != 0 {
                let _ = sim.world.insert_one(e, Marked { mark: a.mark, taken: 1.0, bounty: 1.0 });
            }
        }
        if d.flags & FLAG_ACTORS_CUT == 0 {
            let gone: Vec<Entity> = sim.world.query::<(Entity, &NetId, &Replica, Option<&Player>)>().iter().filter(|(_, n, _, p)| p.is_none() && !seen.contains(&n.0)).map(|(e, ..)| e).collect();
            for e in gone {
                let net = sim.net_of(e);
                sim.events.push_flags(Event::Despawn(events::Despawn { id: net, kind: 0, type_: 0 }), FLAG_REMOTE);
                sim.despawn_now_quiet(e);
            }
        }
        let now = sim.time.now;
        let mut suppressed = 0u32;
        for (i, (e, name)) in d.events.into_iter().enumerate() {
            if i < d.repeats {
                if !play_repeats {
                    continue;
                }
                self.snapshots.recovered += 1;
            }
            let e = match (e, name) {
                (Event::Sound(mut s), Some(n)) => {
                    s.name = sim.names.id(&n);
                    Event::Sound(s)
                }
                (Event::Particles(mut p), Some(n)) => {
                    p.name = sim.names.id(&n);
                    Event::Particles(p)
                }
                (Event::Rule(mut r), Some(n)) => {
                    r.name = sim.names.id(&n);
                    Event::Rule(r)
                }
                (Event::Despawn(dsp), _) => {
                    if let Some(x) = sim.entity_of(dsp.id)
                        && sim.world.get::<&Replica>(x).is_ok() {
                            sim.despawn_now_quiet(x);
                        }
                    Event::Despawn(dsp)
                }
                (e, _) => e,
            };
            // what this joiner already played for its own player (its shot's sound and muzzle light, the sparks it drew)
            if let Some(me) = local {
                let predicted = match e {
                    Event::Sound(s) => s.source == me,
                    Event::Light(l) => l.source == me,
                    Event::Particles(p) => sim.res.get_mut::<NetState>().is_some_and(|n| n.predicted_fx(p.name, p.pos, now)),
                    _ => false,
                };
                if predicted {
                    suppressed += 1;
                    continue;
                }
            }
            sim.events.push_flags(e, FLAG_REMOTE);
        }
        if suppressed > 0
            && let Some(n) = sim.res.get_mut::<NetState>() {
                n.stats.suppressed += suppressed;
            }
        Ok((d.players.len(), d.actors.len()))
    }
}

fn sync_player(sim: &mut Sim, e: Entity, p: &PlayerSnap) {
    if let Ok(mut l) = sim.world.get::<&mut Look>(e) {
        l.yaw = p.yaw;
        l.pitch = p.pitch;
    }
    if let Ok(mut v) = sim.world.get::<&mut Velocity>(e) {
        v.linear = p.vel;
    }
    if let Ok(mut h) = sim.world.get::<&mut Health>(e) {
        h.hp = p.hp * h.max;
        h.armor = p.armor;
        h.dead = !p.alive;
    }
    if let Ok(mut w) = sim.world.get::<&mut Wear>(e) {
        w.held = p.held;
    }
    if let Ok(mut m) = sim.world.get::<&mut crate::physics::Mover>(e) {
        m.grounded = p.grounded;
    }
    let _ = sim.world.insert_one(e, SnapByte(p.state));
}

impl Sim {
    /// Despawn without a DESPAWN event (a replica the host already announced).
    pub fn despawn_now_quiet(&mut self, e: Entity) {
        if let Ok(b) = self.world.get::<&crate::physics::Body>(e).map(|b| *b) {
            self.physics.remove(&b);
        }
        let net = self.net_of(e);
        if net != 0 {
            self.forget_net(net);
        }
        let _ = self.world.despawn(e);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cmd::{self, Writer};
    use crate::net::Role;
    use crate::sim::Sim;

    fn host_with(enemies: usize, events: usize) -> Core {
        let mut host = Core::new();
        host.sim.time.step = 100;
        host.sim.spawn_player(1, Vec3::new(1.0, 0.0, 2.0), 0.5, true, true);
        host.sim.spawn_player(2, Vec3::new(-3.0, 0.0, 4.0), 1.0, false, true);
        for i in 0..enemies {
            let e = host.sim.spawn_actor(kind::ENEMY, (i % 3) as u16, Vec3::new(i as f32 * 0.5 - 50.0, 0.0, -10.0), 0.3);
            host.sim.world.insert_one(e, Health::new(30.0)).unwrap();
        }
        let _ = host.sim.events.take_net();
        for i in 0..events {
            match i % 4 {
                0 => host.sim.sound("shot", Vec3::new(1.0, 1.5, 2.0), -3.0, 1),
                1 => host.sim.emit(Event::Hit(events::Hit { attacker: 1, target: 300, part: 3, point: Vec3::new(0.0, 1.7, -5.0), normal: Vec3::Z, damage: 12.5, crit: true, region: 1 })),
                2 => host.sim.rule("wave-cleared", 0, 2.0, 0.0, 0.0, 0.0),
                _ => host.sim.emit(Event::Light(events::Light { source: 1, pos: Vec3::new(0.0, 1.5, -1.0), color: [1.0, 0.48, 0.13], radius: 3.4, intensity: 1.8, frames: 4 })),
            }
        }
        host
    }

    #[test]
    fn a_small_world_round_trips_within_its_quantization() {
        let mut host = host_with(3, 8);
        let bytes = host.snapshot();
        let d = decode(&bytes).unwrap();
        assert_eq!((d.flags, d.prev, d.repeats), (0, 0, 0));
        assert_eq!((d.players.len(), d.actors.len(), d.events.len()), (2, 3, 8));
        let p = d.players[0];
        assert!((p.pos - Vec3::new(1.0, 0.0, 2.0)).length() < 1.0 / 64.0 && (p.yaw - 0.5).abs() < 1e-3 && p.alive && p.hp > 0.99);
        assert_eq!((p.held, p.ack), (HELD_NONE, 0));
        assert!((d.actors[0].yaw - 0.3).abs() < 0.03);
        let (Event::Hit(h), None) = &d.events[1] else { panic!("{:?}", d.events[1]) };
        assert!(h.crit && h.region == 1 && (h.damage - 12.5).abs() < 0.05 && (h.point.y - 1.7).abs() < 0.02);
        let (Event::Light(l), None) = &d.events[3] else { panic!("{:?}", d.events[3]) };
        assert_eq!(l.source, 1, "a light keeps its source");
        assert_eq!(d.events[0].1.as_deref(), Some("shot"));
        assert_eq!(d.events[2].1.as_deref(), Some("wave-cleared"));
        assert!(host.sim.events.net.is_empty(), "the snapshot took its events");
        // the next snapshot repeats them after its own, and names the tick before
        host.sim.sound("step", Vec3::ZERO, 0.0, 2);
        host.sim.time.step += 12;
        let d2 = decode(&host.snapshot()).unwrap();
        assert_eq!((d2.prev, d2.repeats, d2.events.len()), (d.tick, 8, 9));
        assert_eq!(d2.events[8].1.as_deref(), Some("step"), "the new events come last");
    }

    /// Snapshot v3: a plugin's bytes ride with each player and reach every player of a joiner's copy, its own too; a
    /// PUSH keeps its step, its push and its seconds.
    #[test]
    fn a_players_plugin_bytes_and_a_push_reach_the_joiner() {
        let mut host = host_with(0, 0);
        let (p1, p2) = (host.player(1).unwrap(), host.player(2).unwrap());
        host.sim.world.insert_one(p2, SnapBlob(vec![7, 0, 0, 0, 0, 255, 255, 255, 255, 2, 4, 4])).unwrap();
        host.sim.emit(Event::Push(events::Push { player: 2, seq: 123_456, vel: Vec3::new(4.5, 2.0, -6.25), secs: 0.42, down: 0.7 }));
        let bytes = host.snapshot();
        let d = decode(&bytes).unwrap();
        assert_eq!(d.blobs, vec![Vec::<u8>::new(), vec![7, 0, 0, 0, 0, 255, 255, 255, 255, 2, 4, 4]]);
        assert_eq!(bytes.len(), HEADER_BYTES + 2 * PLAYER_BYTES + 12 + 1 + 13, "a player with nothing to say costs one byte more than in v2");
        let (Event::Push(p), None) = &d.events[0] else { panic!("{:?}", d.events) };
        assert_eq!((p.player, p.seq), (2, 123_456));
        assert!((p.vel - Vec3::new(4.5, 2.0, -6.25)).length() < 0.01 && (p.secs - 0.42).abs() < 0.006 && (p.down - 0.7).abs() < 0.006);
        let mut joiner = Core::new();
        joiner.sim.spawn_player(2, Vec3::ZERO, 0.0, true, true);
        joiner.apply(&bytes).unwrap();
        let own = joiner.player(2).unwrap();
        assert_eq!(joiner.sim.world.get::<&SnapBlob>(own).unwrap().0.len(), 12, "the joiner's own player has the host's bytes for it");
        assert!(joiner.sim.world.get::<&SnapBlob>(joiner.player(1).unwrap()).unwrap().0.is_empty());
        assert!(joiner.sim.events.early_events().count() == 0 && joiner.sim.events.tick_events().any(|e| matches!(e, Event::Push(p) if p.seq == 123_456)), "the PUSH is emitted on the joiner for its next step");
        // a blob longer than the most is cut, never the snapshot's frame
        host.sim.world.insert_one(p1, SnapBlob(vec![1; 200])).unwrap();
        host.sim.time.step += 12;
        let d2 = decode(&host.snapshot()).unwrap();
        assert_eq!(d2.blobs[0].len(), BLOB_MAX);
    }

    #[test]
    fn a_crowded_world_stays_under_the_budget_and_sends_the_rest_next_time() {
        let mut host = host_with(400, 300);
        let a = host.snapshot();
        assert!(a.len() <= MAX_BYTES, "{} bytes", a.len());
        let d = decode(&a).unwrap();
        assert_eq!(d.flags & FLAG_ACTORS_CUT, FLAG_ACTORS_CUT);
        assert_eq!(d.flags & FLAG_EVENTS_CUT, FLAG_EVENTS_CUT);
        assert_eq!(d.players.len(), 2, "players always go");
        assert!(d.actors.len() > 60, "{} actors", d.actors.len());
        let first: std::collections::HashSet<u32> = d.actors.iter().map(|a| a.id).collect();
        let b = host.snapshot();
        let d2 = decode(&b).unwrap();
        assert!(b.len() <= MAX_BYTES && d2.repeats > 0);
        assert!(d2.actors.iter().all(|a| !first.contains(&a.id)), "the next snapshot sends who waited longest");
        // base64 of the largest snapshot, inside a {"f": "..."} message, fits the live standard's 3.5 KB
        assert!(MAX_BYTES.div_ceil(3) * 4 + 16 <= 3584);
    }

    #[test]
    fn a_joiner_shows_replicas_never_moves_its_own_player_and_hears_the_hosts_events() {
        let mut host = host_with(3, 4);
        let bytes = host.snapshot();
        let mut joiner = Core::new();
        joiner.sim.spawn_player(2, Vec3::ZERO, 0.0, true, true);
        joiner.tick(0.0, 0);
        assert_eq!(joiner.apply(&bytes), Ok((2, 3)));
        assert_eq!(joiner.apply(&bytes), Ok((0, 0)), "the same snapshot twice is ignored");
        assert_eq!(joiner.snapshots.stale, 1);
        let me = joiner.player(2).unwrap();
        assert_eq!(joiner.sim.world.get::<&Transform>(me).unwrap().pos, Vec3::ZERO, "the joiner's own player is never moved");
        assert!(joiner.snapshots.authority.is_some());
        let other = joiner.player(1).unwrap();
        assert!(joiner.sim.world.get::<&Replica>(other).is_ok());
        joiner.tick(0.1, 0);
        let p1 = joiner.sim.world.get::<&Transform>(other).unwrap().pos;
        assert!((p1 - Vec3::new(1.0, 0.0, 2.0)).length() < 0.05, "{p1}");
        let words = joiner.events_out.clone();
        let evs: Vec<(Event, u32)> = words.chunks(events::WORDS).filter_map(|w| Event::decode(w.try_into().unwrap())).collect();
        assert!(evs.iter().all(|(_, f)| f & FLAG_REMOTE != 0), "everything came from the host");
        let spawns = evs.iter().filter(|(e, _)| matches!(e, Event::Spawn(_))).count();
        assert!(spawns >= 3, "{spawns} spawns");
        let shot = evs.iter().find_map(|(e, _)| if let Event::Sound(s) = e { Some(joiner.sim.names.get(s.name).to_string()) } else { None });
        assert_eq!(shot.as_deref(), Some("shot"), "names travel as strings");
        // the host kills an actor: the joiner's replica goes; a replica takes no damage on the joiner
        let victim = host.sim.entity_of(256).unwrap();
        host.sim.despawn_now(victim);
        host.sim.time.step += 12;
        joiner.apply(&host.snapshot()).unwrap();
        assert!(joiner.sim.entity_of(256).is_none());
        let r = joiner.sim.entity_of(257).unwrap();
        assert_eq!(joiner.sim.damage(r, 50.0, 2, None, Vec3::Z), crate::sim::Dealt::default(), "the host decides a replica's damage");
        assert!(joiner.apply(b"nope").is_err() && decode(&[b'G', b'F', 9, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]).is_err());
        let _ = Sim::default();
    }

    #[test]
    fn a_joiner_that_missed_a_snapshot_plays_its_events_from_the_next_and_one_that_saw_it_does_not() {
        let mut host = host_with(1, 0);
        let s0 = host.snapshot();
        host.sim.time.step += 12;
        host.sim.sound("first", Vec3::ZERO, 0.0, 1);
        let s1 = host.snapshot();
        host.sim.time.step += 12;
        host.sim.sound("second", Vec3::ZERO, 0.0, 1);
        let s2 = host.snapshot();
        let sounds = |c: &Core| -> Vec<String> {
            c.events_out.chunks(events::WORDS).filter_map(|w| Event::decode(w.try_into().unwrap())).filter_map(|(e, _)| if let Event::Sound(s) = e { Some(c.sim.names.get(s.name).to_string()) } else { None }).collect()
        };
        let (mut saw, mut missed) = (Core::new(), Core::new());
        for j in [&mut saw, &mut missed] {
            j.sim.spawn_player(2, Vec3::ZERO, 0.0, true, true);
            j.apply(&s0).unwrap();
            j.tick(0.0, 0);
        }
        saw.apply(&s1).unwrap();
        saw.tick(0.0, 0);
        assert_eq!(sounds(&saw), ["first"]);
        saw.apply(&s2).unwrap();
        saw.tick(0.0, 0);
        assert_eq!(sounds(&saw), ["second"], "seen once, played once");
        missed.apply(&s2).unwrap();
        missed.tick(0.0, 0);
        assert_eq!(sounds(&missed), ["first", "second"], "the missed snapshot's sound comes with the next");
        assert_eq!(missed.snapshots.recovered, 1);
    }

    fn input(c: &mut Core, id: u32, mx: f32, mz: f32, held: u32, pressed: u32) -> usize {
        let mut w = Writer::default();
        w.input(id, mx, mz, 0.0, 0.0, held, true, pressed);
        c.cmds[..w.words.len()].copy_from_slice(&w.words);
        w.words.len()
    }

    fn room(c: &mut Core) {
        let mut w = Writer::default();
        w.add_box([-20.0, -0.2, -20.0], [20.0, 0.0, 20.0]);
        w.add_box([-20.0, 0.0, -20.5], [20.0, 3.0, -20.0]);
        c.cmds[..w.words.len()].copy_from_slice(&w.words);
        c.tick(0.0, w.words.len());
    }

    /// The host and a joiner in one process: the joiner walks its own player by prediction, the host replays the
    /// joiner's inputs, the joiner reconciles: the two agree, and a knock on the host reaches the joiner's player.
    #[test]
    fn a_joiner_predicts_its_walk_the_host_replays_it_and_a_knock_on_the_host_is_reconciled() {
        let (mut host, mut joiner) = (Core::new(), Core::new());
        room(&mut host);
        room(&mut joiner);
        host.net_role(Role::Host, 1, 0);
        joiner.net_role(Role::Joiner, 2, 9);
        host.sim.spawn_player(1, Vec3::new(0.0, 0.05, 5.0), 0.0, true, true);
        host.sim.spawn_player(2, Vec3::new(2.0, 0.05, 5.0), 0.0, false, true);
        joiner.sim.spawn_player(2, Vec3::new(2.0, 0.05, 5.0), 0.0, true, true);
        let mut last_err = 0.0f32;
        for frame in 0..260 {
            // the joiner stands, walks forward, then strafes, at 60 Hz; its inputs reach the host every 3 frames
            let (mx, mz) = if frame < 20 { (0.0, 0.0) } else if frame < 140 { (0.0, 1.0) } else { (1.0, 0.0) };
            let n = input(&mut joiner, 2, mx, mz, 0, 0);
            joiner.tick(1.0 / 60.0, n);
            if frame % 3 == 0 {
                let batch = joiner.net_take_inputs();
                assert!(host.net_push_inputs(2, &batch).unwrap() > 0);
            }
            let n = input(&mut host, 1, 0.0, 0.0, 0, 0);
            host.tick(1.0 / 60.0, n);
            if frame % 6 == 5 {
                joiner.apply(&host.snapshot()).unwrap();
                last_err = joiner.net().unwrap().stats.last_error;
            }
        }
        let n = joiner.net().unwrap();
        assert!(n.stats.checked > 20, "{:?}", n.stats);
        assert!(n.stats.max_error < 0.05 && last_err < 0.05, "the host replays the same walk ({:?})", n.stats);
        assert_eq!(n.stats.snapped, 0);
        let jp = joiner.sim.world.get::<&Transform>(joiner.player(2).unwrap()).unwrap().pos;
        let hp = host.sim.world.get::<&Transform>(host.player(2).unwrap()).unwrap().pos;
        assert!(jp.z < 0.0 && jp.x > 4.0, "the joiner walked ({jp})");
        assert!(jp.distance(hp) < 0.6, "the host's copy follows a few steps behind ({jp} vs {hp})");
        // the host moves the joiner's player (a knock, a respawn): the joiner's player follows on the next snapshot
        let he = host.player(2).unwrap();
        host.sim.teleport(he, hp + Vec3::new(0.0, 0.0, 6.0));
        for frame in 0..30 {
            let n = input(&mut joiner, 2, 0.0, 0.0, 0, 0);
            joiner.tick(1.0 / 60.0, n);
            if frame % 3 == 0 {
                let batch = joiner.net_take_inputs();
                host.net_push_inputs(2, &batch).unwrap();
            }
            host.tick(1.0 / 60.0, 0);
            if frame % 6 == 5 {
                joiner.apply(&host.snapshot()).unwrap();
            }
        }
        let jp2 = joiner.sim.world.get::<&Transform>(joiner.player(2).unwrap()).unwrap().pos;
        let hp2 = host.sim.world.get::<&Transform>(he).unwrap().pos;
        assert!(jp2.distance(hp2) < 0.1, "reconciled to the host's ({jp2} vs {hp2})");
        assert!(joiner.net().unwrap().stats.snapped >= 1, "a 6 m difference snaps");
    }

    /// Wave 4 (watch then play): a viewer has no player of its own. Every player in the host's snapshots is a replica
    /// there, the camera is the eyes of the one it watches and turns between the samples, and nothing of the host's is
    /// left out as "already played here".
    #[test]
    fn a_viewer_looks_through_a_replicas_eyes_and_plays_everything_the_host_sends() {
        use crate::views::camera as cam;
        let (mut host, mut viewer) = (Core::new(), Core::new());
        host.net_role(Role::Host, 1, 0);
        viewer.net_role(Role::Viewer, 0, 0);
        viewer.net_watch(2);
        host.sim.spawn_player(1, Vec3::new(0.0, 0.05, 5.0), 0.0, true, true);
        let h2 = host.sim.spawn_player(2, Vec3::new(2.0, 0.05, 5.0), 0.3, false, true);
        host.sim.time.step = 100;
        // what forge-feel does on the host for player 2's shot: on a joiner whose own player is 2 this is not played again
        host.sim.sound("shot", Vec3::new(2.0, 1.6, 5.0), 0.0, 2);
        assert_eq!(viewer.apply(&host.snapshot()), Ok((2, 0)));
        viewer.tick(0.1, 0);
        let mut who: Vec<(u32, bool, bool, bool)> = viewer.sim.world.query::<(&Player, Option<&Replica>)>().iter().map(|(p, r)| (p.id, p.local, p.owned, r.is_some())).collect();
        who.sort();
        assert_eq!(who, [(1, false, false, true), (2, true, false, true)], "nobody is this copy's own; the watched replica is its local one");
        let eye = viewer.sim.tables.player.eye;
        let c = viewer.views.camera.clone();
        assert_eq!(c[cam::PLAYER], 2.0);
        assert!((Vec3::new(c[cam::X], c[cam::Y], c[cam::Z]) - Vec3::new(2.0, 0.05 + eye, 5.0)).length() < 0.03, "the camera is the watched player's eyes ({c:?})");
        assert!((c[cam::YAW] - 0.3).abs() < 0.01 && c[cam::PITCH].abs() < 0.01);
        let sounds: Vec<String> = viewer.events_out.chunks(events::WORDS).filter_map(|w| Event::decode(w.try_into().unwrap())).filter_map(|(e, _)| if let Event::Sound(s) = e { Some(viewer.sim.names.get(s.name).to_string()) } else { None }).collect();
        assert_eq!(sounds, ["shot"], "a viewer predicts nothing, so it plays the watched player's own shot from the host");
        assert!(viewer.sim.events.net.is_empty() && viewer.net_take_inputs().is_empty(), "a viewer queues nothing to send");
        // the watched player walks a metre, turns and looks up: half a sample later the viewer's eyes are part of the way
        host.sim.teleport(h2, Vec3::new(3.0, 0.05, 5.0));
        if let Ok(mut l) = host.sim.world.get::<&mut Look>(h2) {
            l.yaw = 1.3;
            l.pitch = 0.6;
        }
        host.sim.time.step += 12;
        viewer.apply(&host.snapshot()).unwrap();
        viewer.tick(0.05, 0);
        let c = viewer.views.camera.clone();
        assert!(c[cam::X] > 2.3 && c[cam::X] < 2.7, "between the samples ({})", c[cam::X]);
        assert!(c[cam::YAW] > 0.6 && c[cam::YAW] < 1.0, "turning between the samples ({})", c[cam::YAW]);
        assert!(c[cam::PITCH] > 0.2 && c[cam::PITCH] < 0.4, "looking up between the samples ({})", c[cam::PITCH]);
        viewer.tick(0.1, 0);
        let c = viewer.views.camera.clone();
        assert!((c[cam::X] - 3.0).abs() < 0.03 && (c[cam::YAW] - 1.3).abs() < 0.01 && (c[cam::PITCH] - 0.6).abs() < 0.01, "then at the sample ({c:?})");
        let n = viewer.net().unwrap();
        assert_eq!((n.role, n.stats.checked, n.stats.suppressed), (Role::Viewer, 0, 0), "nothing reconciled, nothing left out");
        // watching nobody: no camera of the core's (the page keeps its own)
        viewer.net_watch(0);
        viewer.tick(0.0, 0);
        assert_eq!(viewer.views.camera[cam::PLAYER], 0.0);
        // on any other role the call does nothing
        host.net_watch(2);
        assert!(host.sim.world.query::<&Player>().iter().filter(|p| p.local).map(|p| p.id).eq([1]));
    }

    /// A joiner fires: its own copy plays the shot at once, and the host's copy of the same shot (from its inputs) is
    /// not played again on the joiner.
    #[test]
    fn the_hosts_sound_of_a_joiners_own_shot_is_not_played_twice_on_the_joiner() {
        let (mut host, mut joiner) = (Core::new(), Core::new());
        host.net_role(Role::Host, 1, 0);
        joiner.net_role(Role::Joiner, 2, 3);
        host.sim.spawn_player(1, Vec3::ZERO, 0.0, true, true);
        host.sim.spawn_player(2, Vec3::X, 0.0, false, true);
        joiner.sim.spawn_player(2, Vec3::X, 0.0, true, true);
        joiner.apply(&host.snapshot()).unwrap();
        // what forge-feel would do for the shot on each copy
        joiner.sim.sound("shot", Vec3::X, 0.0, 2);
        let sp = joiner.sim.names.id("sparks");
        joiner.sim.emit(Event::Particles(events::Particles { name: sp, count: 8, pos: Vec3::new(1.0, 1.0, -6.0), dir: Vec3::Z, speed: 4.0, spread: 0.3 }));
        joiner.tick(1.0 / 60.0, 0);
        host.sim.sound("shot", Vec3::X, 0.0, 2);
        host.sim.sound("growl", Vec3::NEG_Z, 0.0, 300);
        let sparks = host.sim.names.id("sparks");
        host.sim.emit(Event::Particles(events::Particles { name: sparks, count: 8, pos: Vec3::new(1.1, 1.0, -6.0), dir: Vec3::Z, speed: 4.0, spread: 0.3 }));
        host.tick(1.0 / 60.0, 0);
        joiner.apply(&host.snapshot()).unwrap();
        joiner.tick(0.0, 0);
        let kinds: Vec<String> = joiner.events_out.chunks(events::WORDS).filter_map(|w| Event::decode(w.try_into().unwrap())).filter_map(|(e, _)| match e {
            Event::Sound(s) => Some(joiner.sim.names.get(s.name).to_string()),
            Event::Particles(p) => Some(format!("fx:{}", joiner.sim.names.get(p.name))),
            _ => None,
        }).collect();
        assert_eq!(kinds, ["growl"], "only what the joiner did not already play");
        assert_eq!(joiner.net().unwrap().stats.suppressed, 2);
        let _ = cmd::BTN_FIRE;
    }
}
