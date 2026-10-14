//! The crowd's mover (wave 3, track M; ARCHITECTURE.md "The crowd"): how a member of a crowd (`Mover::crowd`: forge-ai's
//! enemies) walks on flat ground without rapier's character controller.
//!
//! Why: the controller was 85 to 92% of a step with a wave packed round a player (wave 2, track G), and a phone has a
//! quarter of this machine's time. For every character it touches the controller computes contact manifolds, sweeps
//! its capsule up to twenty times, and lets every kinematic body it touches push and drag it; a crowd is all touching.
//!
//! What a crowd member does instead, each step:
//! - **Other characters are discs** (their capsules seen from above, a `SKIN` apart): its move is swept against them
//!   and slides round them, at most `SLIDES` times. Members move one after another and each sees where the ones before
//!   it now stand (the controller saw everyone where the last step left them), and players have moved before any of
//!   them. Nobody is pushed: a member stops at a body, and the AI's own separation is what spreads a crowd out. A
//!   member that overlaps a body (a joiner's word moved a player into it, a spawn) backs out `PUSH_OUT` a step.
//! - **The world is one sweep** of its capsule, lifted `LIFT` so the floor is not in it, along what is left, and one
//!   more along the wall it meets.
//! - **The ground is one ray** under where it then stands: the same flat floor (`FLAT`) holds it.
//!
//! Anything else is the controller's, as before: a member in the air, on a slope, at a step or a ledge, or one whose
//! row climbs (`Mover::crowd` is off: forge-ai sets it only for rows with no `climb`). `walk` returns None then and
//! `core.character` moves it through rapier. Its body stays a kinematic capsule in rapier either way, so players (who
//! always walk through the controller), rays and debris meet it as before.
use glam::{Vec2, Vec3};
use hecs::Entity;

use crate::physics::{groups, Mover, Physics, QueryMask};

/// The gap kept to a body or a wall, m (the controller's own offset).
pub const SKIN: f32 = 0.01;
/// How far the swept capsule's foot is lifted, m: what a member walks over without a step (a capsule's round foot
/// rolled over about 0.1 m in the controller).
pub const LIFT: f32 = 0.12;
/// Ground within this of its feet is the floor it stands on, m; further is a step or a ledge (the controller's).
pub const FLAT: f32 = 0.03;
/// How far a member backs out of a body it overlaps, m a step (1.2 m/s).
pub const PUSH_OUT: f32 = 0.01;
/// Slides round other bodies in one step.
pub const SLIDES: usize = 3;
/// A ground normal at least this upright is flat (about 8°).
pub const UPRIGHT: f32 = 0.99;

/// A character seen from above: where it stands, its feet and height, its radius.
#[derive(Clone, Copy, Debug)]
pub struct Disc {
    pub e: Entity,
    pub at: Vec2,
    pub y: f32,
    pub height: f32,
    pub radius: f32,
}

impl Disc {
    pub fn of(e: Entity, feet: Vec3, m: &Mover) -> Disc {
        Disc { e, at: Vec2::new(feet.x, feet.z), y: feet.y, height: (m.half_height + m.radius) * 2.0, radius: m.radius }
    }
    /// Their heights overlap (a player in the air above a head is not in the way).
    fn level_with(&self, o: &Disc) -> bool {
        self.y < o.y + o.height && o.y < self.y + self.height
    }
}

/// What one step of walking did.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Walk {
    pub translation: Vec3,
    /// The body or wall that stopped it last (its normal, toward the walker, level; zero: nothing did).
    pub wall: Vec3,
}

/// Sweep `me` from `pos` along `rem` against the other discs, sliding round them. → where it stands, and the last
/// normal that stopped it.
pub fn sweep(discs: &[Disc], me: usize, mut pos: Vec2, mut rem: Vec2) -> (Vec2, Vec2) {
    let mine = discs[me];
    let mut wall = Vec2::ZERO;
    for _ in 0..SLIDES {
        let len = rem.length();
        if len < 1e-7 {
            break;
        }
        let u = rem / len;
        // the nearest body in the way: (how far it gets, the normal toward it at that point)
        let mut best: Option<(f32, Vec2)> = None;
        for (i, d) in discs.iter().enumerate() {
            if i == me || !mine.level_with(d) {
                continue;
            }
            let p = d.at - pos;
            let along = p.dot(u);
            if along <= 0.0 {
                continue; // behind it, or it is walking away
            }
            let rr = mine.radius + d.radius + SKIN;
            let l2 = p.length_squared();
            if l2 <= rr * rr {
                // touching already: no nearer (along it is free: a slide leaves the body, it does not enter it)
                let l = l2.sqrt();
                if along <= l * 1e-3 {
                    continue;
                }
                let n = if l > 1e-5 { -p / l } else { -u };
                best = Some((0.0, n));
                break;
            }
            let off2 = l2 - along * along;
            if off2 >= rr * rr {
                continue; // passes beside it
            }
            let t = along - (rr * rr - off2).sqrt();
            if t < len && best.is_none_or(|b| t < b.0) {
                let t = t.max(0.0);
                best = Some((t, (pos + u * t - d.at) / rr));
            }
        }
        match best {
            None => {
                pos += rem;
                break;
            }
            Some((t, n)) => {
                pos += u * t;
                rem -= u * t;
                // what goes into the body is lost; what goes along it is kept
                rem -= n * rem.dot(n).min(0.0);
                wall = n;
            }
        }
    }
    (pos, wall)
}

/// One step of a crowd member standing on flat ground: from `feet` by `desired` (this step's travel; only its level
/// part is walked). `discs`: every character, where it stands now, `me` among them. → None when this is not flat
/// walking (the caller moves it through the controller).
pub fn walk(physics: &Physics, m: &Mover, feet: Vec3, desired: Vec3, discs: &[Disc], me: usize) -> Option<Walk> {
    let from = Vec2::new(feet.x, feet.z);
    let mine = discs[me];
    // out of any body it overlaps, a little a step
    let mut out = Vec2::ZERO;
    for (i, d) in discs.iter().enumerate() {
        if i == me || !mine.level_with(d) {
            continue;
        }
        let gap = from - d.at;
        let (l, least) = (gap.length(), mine.radius + d.radius);
        if l < least - 0.002 {
            // exactly on top of each other: apart along x, the later one the other way
            let n = if l > 1e-5 { gap / l } else { Vec2::new(if i < me { 1.0 } else { -1.0 }, 0.0) };
            out += n * (least + SKIN - l).min(PUSH_OUT);
        }
    }
    let want = Vec2::new(desired.x, desired.z) + out.clamp_length_max(PUSH_OUT);
    let (to, wall2) = sweep(discs, me, from, want);
    let mut wall = Vec3::new(wall2.x, 0.0, wall2.y);
    let mut t = Vec3::new(to.x - from.x, 0.0, to.y - from.y);
    let dist = t.length();
    if dist > 1e-7 {
        // the world: the capsule with its foot lifted (the floor is not in the way of a level walk)
        let dir = t / dist;
        let half = (m.half_height - LIFT * 0.5).max(0.0);
        let center = m.center(feet) + Vec3::Y * (LIFT * 0.5);
        if let Some((toi, n)) = physics.sweep_world(half, m.radius, center, dir, dist, SKIN) {
            if n.y.abs() > 0.3 {
                return None; // not a wall: a slope, a ledge's edge, something overhead
            }
            let nh = Vec3::new(n.x, 0.0, n.z).normalize_or_zero();
            let rest = t - dir * toi;
            t = dir * toi;
            // along the wall, once, leaning off it a hair so the next sweep does not start inside its skin
            let slide = rest - nh * rest.dot(nh).min(0.0);
            let sl = slide.length();
            if sl > 1e-7 {
                let sd = (slide / sl + nh * 1e-3).normalize_or_zero();
                let far = match physics.sweep_world(half, m.radius, center + t, sd, sl, SKIN) {
                    Some((t2, _)) => t2,
                    None => sl,
                };
                // never into a body it had already been swept clear of
                let at = from + Vec2::new(t.x + sd.x * far, t.z + sd.z * far);
                let clear = discs.iter().enumerate().all(|(i, d)| i == me || !mine.level_with(d) || (d.at - at).length() >= mine.radius + d.radius + SKIN * 0.5);
                if clear {
                    t += sd * far;
                }
            }
            wall = nh;
        }
    } else if desired.x == 0.0 && desired.z == 0.0 {
        // standing still on the ground it stood on: nothing to ask
        return Some(Walk { translation: Vec3::ZERO, wall: Vec3::ZERO });
    }
    // the ground under where it now stands: the same flat floor, or this is the controller's
    let at = feet + t;
    let hit = physics.cast_ray(at + Vec3::Y * 0.5, Vec3::NEG_Y, 0.5 + m.snap.max(0.05), QueryMask::new(groups::WORLD))?;
    if hit.normal.y < UPRIGHT {
        return None;
    }
    let ground = at.y + 0.5 - hit.dist + SKIN;
    if (ground - feet.y).abs() > FLAT {
        return None;
    }
    t.y = ground - feet.y;
    Some(Walk { translation: t, wall })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn disc(w: &mut hecs::World, x: f32, z: f32, r: f32) -> Disc {
        Disc { e: w.spawn(()), at: Vec2::new(x, z), y: 0.0, height: 1.8, radius: r }
    }

    #[test]
    fn a_walker_stops_a_skin_from_a_body_and_slides_round_one_it_meets_off_centre() {
        let mut w = hecs::World::new();
        // head on: stopped a skin short of touching
        let discs = [disc(&mut w, 0.0, 0.0, 0.35), disc(&mut w, 0.0, -2.0, 0.3)];
        let (at, wall) = sweep(&discs, 0, discs[0].at, Vec2::new(0.0, -3.0));
        assert!((at.y - (-2.0 + 0.65 + SKIN)).abs() < 1e-4 && at.x.abs() < 1e-5, "{at:?}");
        assert!((wall - Vec2::new(0.0, 1.0)).length() < 1e-4, "the body's normal faces the walker: {wall:?}");
        // off centre: it slides past and ends beyond the body, never inside it
        let discs = [disc(&mut w, 0.3, 0.0, 0.35), disc(&mut w, 0.0, -2.0, 0.3)];
        let mut pos = discs[0].at;
        for _ in 0..240 {
            let mut d = discs;
            d[0].at = pos;
            pos = sweep(&d, 0, pos, Vec2::new(0.0, -3.3 / 120.0)).0;
            assert!((pos - discs[1].at).length() >= 0.65 + SKIN - 1e-4, "inside the body at {pos:?}");
        }
        assert!(pos.y < -2.5, "walked round it to {pos:?}");
        // walking away from a body it touches is free
        let discs = [disc(&mut w, 0.0, 0.0, 0.35), disc(&mut w, 0.0, -0.6, 0.3)];
        let (at, _) = sweep(&discs, 0, discs[0].at, Vec2::new(0.0, 0.5));
        assert!((at.y - 0.5).abs() < 1e-5);
        // a player in the air above its head is not in the way
        let mut high = discs;
        high[1].y = 2.5;
        let (at, _) = sweep(&high, 0, high[0].at, Vec2::new(0.0, -1.5));
        assert!((at.y + 1.5).abs() < 1e-5);
    }

    #[test]
    fn a_crowd_member_walks_the_flat_floor_is_stopped_by_a_wall_and_leaves_a_ledge_to_the_controller() {
        let mut p = Physics::new();
        p.add_box(Vec3::new(-10.0, -0.5, -10.0), Vec3::new(10.0, 0.0, 10.0));
        p.add_box(Vec3::new(5.0, 0.0, -10.0), Vec3::new(6.0, 3.0, 10.0));
        p.add_box(Vec3::new(-6.0, 0.0, -2.0), Vec3::new(-3.0, 1.0, 2.0)); // a block a metre high: a wall to a walker
        p.add_box(Vec3::new(-2.0, 0.0, 4.0), Vec3::new(2.0, 0.3, 8.0)); // a 0.3 m ledge
        p.refresh();
        let mut w = hecs::World::new();
        let m = Mover::new(0.35, 0.55);
        let e = w.spawn(());
        // toward the wall at x 5, a little across it: it stops a skin off and slides along
        let mut feet = Vec3::new(0.0, SKIN, 0.0);
        for _ in 0..360 {
            let discs = [Disc::of(e, feet, &m)];
            let r = walk(&p, &m, feet, Vec3::new(3.3 / 120.0, 0.0, 0.6 / 120.0), &discs, 0).expect("flat ground");
            feet += r.translation;
        }
        assert!((feet.x - (5.0 - 0.35 - SKIN)).abs() < 2e-3, "a skin off the wall: x {}", feet.x);
        assert!(feet.z > 1.5, "slid along it: z {}", feet.z);
        assert!((feet.y - SKIN).abs() < 1e-3, "on the floor: y {}", feet.y);
        // toward the block: stopped by its face
        let mut feet = Vec3::new(0.0, SKIN, 0.0);
        for _ in 0..240 {
            let discs = [Disc::of(e, feet, &m)];
            feet += walk(&p, &m, feet, Vec3::new(-3.3 / 120.0, 0.0, 0.0), &discs, 0).expect("flat ground").translation;
        }
        assert!((feet.x - (-3.0 + 0.35 + SKIN)).abs() < 2e-3, "stopped at the block's face: x {}", feet.x);
        // toward the ledge: its edge meets the capsule's round foot, which is not a wall and not the floor: the
        // controller's (and without a climb the controller stops it there)
        let mut feet = Vec3::new(0.0, SKIN, 0.0);
        let mut left = None;
        for _ in 0..240 {
            let discs = [Disc::of(e, feet, &m)];
            match walk(&p, &m, feet, Vec3::new(0.0, 0.0, 3.3 / 120.0), &discs, 0) {
                Some(r) => feet += r.translation,
                None => {
                    left = Some(feet.z);
                    break;
                }
            }
        }
        assert!(left.is_some_and(|z| z > 3.5 && z < 4.0), "left to the controller at the ledge: {left:?} (z {})", feet.z);
        // over the floor's edge there is no ground: the controller's
        let discs = [Disc::of(e, Vec3::new(0.0, SKIN, 10.6), &m)];
        assert!(walk(&p, &m, Vec3::new(0.0, SKIN, 10.6), Vec3::new(0.0, 0.0, 0.01), &discs, 0).is_none());
    }
}
