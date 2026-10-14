//! The packed command buffer (PLAN §2 "the boundary"; ARCHITECTURE.md "Commands"): the host writes one buffer of
//! 32-bit words per tick, the core reads it once at the start of the tick. A record is `[op, n, payload × n]`; floats
//! travel as their bits. A reader skips an op it does not know by its `n`, so an older core reads a newer host's
//! buffer without breaking. Ops 1..=63 are the core's; a plugin registers its own in its range (`Core::on_command`).
//!
//! | op | name | payload |
//! |---|---|---|
//! | 1 | INPUT | id, move x, move z (−1..1: right, forward), look dx, dy (radians this frame), held (`BTN_*`), enabled (0/1), [pressed (`BTN_*` that went down since the last frame)] |
//! | 2 | TELEPORT | id, x, y, z, yaw, pitch |
//! | 3 | SPAWN | id, x, y, z, yaw, local (0/1): a player this copy simulates |
//! | 4 | DESPAWN | id (a player) |
//! | 5 | TUNING | walk, (unused), jump, gravity, radius, height, eye, step every (wave 0's; `load_tables` is the way now) |
//! | 6 | ADD_BOX | min x, y, z, max x, y, z: a static collider, metres |
//! | 7 | CLEAR_BOXES | — (every static collider the world added) |
//! | 8 | POSE | id, x, y, z, yaw, pitch: a player this copy does not simulate |
//! | 9 | FLOOR_LIMIT | y (below it a player is brought back to where it spawned) |
//! | 10 | SEED | low, high (u32 halves of the random stream's seed) |
//! | 11 | DAMAGE | target net id, amount, attacker net id, dir x, y, z |
//! | 12 | SET_HEALTH | net id, hp, max, armour (a respawn, a pickup) |
//! | 13 | LOOK | id, yaw, pitch (absolute) |
//! | 64..=95 | forge-feel's | (its own, registered in its plugin) |
//! | 96..=127 | forge-ai's | |
//! | 128..=159 | the system's (track S: multiplayer) | |
//! | 160..=191 | the renderer's (track R), if it ever needs one | |

pub const INPUT: u32 = 1;
pub const TELEPORT: u32 = 2;
pub const SPAWN: u32 = 3;
pub const DESPAWN: u32 = 4;
pub const TUNING: u32 = 5;
pub const ADD_BOX: u32 = 6;
pub const CLEAR_BOXES: u32 = 7;
pub const POSE: u32 = 8;
pub const FLOOR_LIMIT: u32 = 9;
pub const SEED: u32 = 10;
pub const DAMAGE: u32 = 11;
pub const SET_HEALTH: u32 = 12;
pub const LOOK: u32 = 13;

/// The highest op number the core keeps for itself.
pub const CORE_LAST: u32 = 63;
pub const FEEL_OPS: std::ops::RangeInclusive<u32> = 64..=95;
pub const AI_OPS: std::ops::RangeInclusive<u32> = 96..=127;
pub const SYSTEM_OPS: std::ops::RangeInclusive<u32> = 128..=159;
pub const RENDER_OPS: std::ops::RangeInclusive<u32> = 160..=191;

/// Buttons (INPUT's `held` and `pressed` words). The JS host maps keys and touch buttons onto them
/// (`gf/forge/host.js` BTN, ARCHITECTURE.md "Input").
pub const BTN_JUMP: u32 = 1 << 0;
/// Wave 0's "jump went down this frame" (an INPUT of 7 words); a v1 host sends `pressed` instead.
pub const BTN_JUMP_PRESSED: u32 = 1 << 1;
pub const BTN_SPRINT: u32 = 1 << 2;
pub const BTN_FIRE: u32 = 1 << 3;
pub const BTN_ALT: u32 = 1 << 4;
pub const BTN_MELEE: u32 = 1 << 5;
pub const BTN_EVADE: u32 = 1 << 6;
pub const BTN_RELOAD: u32 = 1 << 7;
pub const BTN_INTERACT: u32 = 1 << 8;
pub const BTN_NEXT: u32 = 1 << 9;
pub const BTN_PREV: u32 = 1 << 10;
/// Weapon slots 1..=4: `BTN_SLOT1 << (n - 1)`.
pub const BTN_SLOT1: u32 = 1 << 11;
pub const BTN_CROUCH: u32 = 1 << 15;

/// One record read from the buffer.
#[derive(Clone, Copy, Debug)]
pub struct Record<'a> {
    pub op: u32,
    pub words: &'a [u32],
}

impl Record<'_> {
    pub fn u(&self, i: usize) -> u32 {
        self.words.get(i).copied().unwrap_or(0)
    }
    pub fn f(&self, i: usize) -> f32 {
        let v = f32::from_bits(self.u(i));
        if v.is_finite() { v } else { 0.0 }
    }
    pub fn len(&self) -> usize {
        self.words.len()
    }
    pub fn is_empty(&self) -> bool {
        self.words.is_empty()
    }
}

/// The records in a buffer, in order. A record that claims more words than are left ends the walk.
pub fn records(buf: &[u32]) -> impl Iterator<Item = Record<'_>> {
    let mut at = 0usize;
    core::iter::from_fn(move || {
        if at + 2 > buf.len() {
            return None;
        }
        let op = buf[at];
        let n = buf[at + 1] as usize;
        let start = at + 2;
        let end = start.checked_add(n)?;
        if end > buf.len() {
            return None;
        }
        at = end;
        Some(Record { op, words: &buf[start..end] })
    })
}

/// Write records (tests, fixtures and native hosts; the web host writes the same words from JS).
#[derive(Default, Clone, Debug)]
pub struct Writer {
    pub words: Vec<u32>,
}

impl Writer {
    pub fn op(&mut self, op: u32, payload: &[u32]) -> &mut Self {
        self.words.push(op);
        self.words.push(payload.len() as u32);
        self.words.extend_from_slice(payload);
        self
    }
    pub fn opf(&mut self, op: u32, head: &[u32], floats: &[f32]) -> &mut Self {
        let mut p: Vec<u32> = head.to_vec();
        p.extend(floats.iter().map(|f| f.to_bits()));
        self.op(op, &p)
    }
    /// INPUT for player `id`: the stick, the look this frame, the buttons held and those pressed this frame.
    #[allow(clippy::too_many_arguments)]
    pub fn input(&mut self, id: u32, mx: f32, mz: f32, dx: f32, dy: f32, held: u32, enabled: bool, pressed: u32) -> &mut Self {
        self.op(INPUT, &[id, mx.to_bits(), mz.to_bits(), dx.to_bits(), dy.to_bits(), held, enabled as u32, pressed])
    }
    pub fn spawn(&mut self, id: u32, x: f32, y: f32, z: f32, yaw: f32, local: bool) -> &mut Self {
        self.op(SPAWN, &[id, x.to_bits(), y.to_bits(), z.to_bits(), yaw.to_bits(), local as u32])
    }
    pub fn add_box(&mut self, min: [f32; 3], max: [f32; 3]) -> &mut Self {
        self.opf(ADD_BOX, &[], &[min[0], min[1], min[2], max[0], max[1], max[2]])
    }
    pub fn clear(&mut self) {
        self.words.clear();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn records_read_back_and_a_short_record_ends_the_walk() {
        let mut w = Writer::default();
        w.op(999, &[1, 2, 3]).spawn(1, 0.0, 0.1, 0.0, 0.0, true);
        let r: Vec<_> = records(&w.words).collect();
        assert_eq!(r.len(), 2);
        assert_eq!((r[0].op, r[0].len()), (999, 3));
        assert_eq!((r[1].op, r[1].u(5)), (SPAWN, 1));
        assert!((r[1].f(2) - 0.1).abs() < 1e-7);
        let mut cut = w.words.clone();
        cut.truncate(cut.len() - 1);
        assert_eq!(records(&cut).count(), 1);
        assert_eq!(records(&[INPUT, u32::MAX]).count(), 0);
    }
}
