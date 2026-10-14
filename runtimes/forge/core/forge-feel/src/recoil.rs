//! Recoil: a deterministic pitch-only spring (feel target 5). A shot displaces a critically damped spring
//! (`Spring::kick`); the camera's kick (`x`) follows the spring with a short lag (`LAG`), so the kick lands over two
//! frames and peaks on frame 2; then the spring brings it back. `snap` is the share of the way back that starts at once:
//! 0 comes back from a soft shoulder (the shotgun: 77% still up at 62 ms), 1 falls away at once. Each weapon gives its
//! measured 50%-back and 90%-back times (`kick.half`, `kick.back`) and `fit` finds the spring's rate and snap that make
//! them; `kick.pitch` is the visible peak (`gain` turns it into the spring's displacement).
//!
//! The shotgun's curve (moment 8) fitted with snap 0 and ω = 28 /s: 80% of the peak on frame 1, the peak on frame 2,
//! 78% at 62 ms, 46% at 95 ms, 17% at 145 ms, 6% at 195 ms, nothing by 300 ms (`tests`). No randomness: two identical
//! shots give identical curves.

/// The share of the gap the visible kick closes each fixed step (120 Hz).
pub const LAG: f32 = 0.36;

#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct Spring {
    /// The spring's displacement and speed (radians, radians a second).
    pub s: f32,
    pub v: f32,
    /// What the camera shows.
    pub x: f32,
}

/// A weapon's return: the spring's rate and the share that starts back at once.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Shape {
    pub omega: f32,
    pub snap: f32,
}

impl Default for Shape {
    fn default() -> Self {
        Shape { omega: 28.0, snap: 0.0 }
    }
}

impl Spring {
    /// A shot: the spring is displaced by `k` and starts back at `snap` of the speed that would take it straight home.
    pub fn kick(&mut self, k: f32, shape: Shape) {
        self.s += k;
        self.v -= shape.snap * shape.omega * k;
    }
    /// One fixed step: the exact critically damped solution over `dt`, then the visible kick follows.
    pub fn step(&mut self, omega: f32, dt: f32) {
        let e = (-omega * dt).exp();
        let b = self.v + omega * self.s;
        let s = (self.s + b * dt) * e;
        let v = (self.v - omega * b * dt) * e;
        self.s = s;
        self.v = v;
        self.x += LAG * (self.s - self.x);
        if self.s.abs() < 1e-7 && self.v.abs() < 1e-6 && self.x.abs() < 1e-7 {
            *self = Spring::default();
        }
    }
    pub fn settled(&self) -> bool {
        self.s == 0.0 && self.v == 0.0 && self.x == 0.0
    }
}

/// The visible kick after each step of a unit kick (step 1 is the shot's own step).
pub fn response(shape: Shape, steps: usize) -> Vec<f32> {
    let mut s = Spring::default();
    s.kick(1.0, shape);
    (0..steps)
        .map(|_| {
            s.step(shape.omega, forge_core::STEP);
            s.x
        })
        .collect()
}

/// The visible peak of a unit kick.
pub fn gain(shape: Shape) -> f32 {
    response(shape, 60).into_iter().fold(0.0, f32::max)
}

/// Seconds from the shot until the visible kick is back under `share` of its peak (after the peak), between steps.
pub fn back_time(shape: Shape, share: f32) -> f32 {
    let r = response(shape, 200);
    let peak = r.iter().copied().fold(0.0, f32::max);
    let at = r.iter().position(|&x| x == peak).unwrap_or(0);
    let lim = share * peak;
    for i in at.max(1)..r.len() {
        if r[i] <= lim {
            let (a, b) = (r[i - 1], r[i]);
            let f = if a > b { (a - lim) / (a - b) } else { 1.0 };
            return (i as f32 + f) * forge_core::STEP;
        }
    }
    2.0
}

/// The rate whose kick is 90% back `back` seconds after the shot, for a snap (slower springs come back later).
pub fn omega_for(back: f32, snap: f32) -> f32 {
    let (mut lo, mut hi) = (2.0f32, 600.0f32);
    for _ in 0..36 {
        let mid = 0.5 * (lo + hi);
        if back_time(Shape { omega: mid, snap }, 0.1) > back {
            lo = mid;
        } else {
            hi = mid;
        }
    }
    0.5 * (lo + hi)
}

/// The shape whose kick is half back at `half` and 90% back at `back` (seconds from the shot). The snap is held to
/// 0..1: a `half` later than the shoulder allows gives snap 0, earlier than straight back gives snap 1.
pub fn fit(half: f32, back: f32) -> Shape {
    let at = |snap: f32| {
        let omega = omega_for(back, snap);
        (Shape { omega, snap }, back_time(Shape { omega, snap }, 0.5))
    };
    let (s0, h0) = at(0.0);
    if half >= h0 {
        return s0;
    }
    let (s1, h1) = at(1.0);
    if half <= h1 {
        return s1;
    }
    let (mut lo, mut hi) = (0.0f32, 1.0f32);
    for _ in 0..24 {
        let mid = 0.5 * (lo + hi);
        if at(mid).1 > half {
            lo = mid;
        } else {
            hi = mid;
        }
    }
    at(0.5 * (lo + hi)).0
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The shotgun's measured curve (moment 8), as shares of its peak, against ω = 28 and no snap.
    #[test]
    fn the_spring_traces_the_measured_shotgun_curve() {
        let sh = Shape { omega: 28.0, snap: 0.0 };
        let r = response(sh, 40);
        let peak = gain(sh);
        let frame = |k: usize| r[2 * k - 1] / peak;
        assert!((frame(2) - 1.0).abs() < 1e-6, "the peak is frame 2");
        assert!(frame(1) > 0.74 && frame(1) < 0.86, "frame 1 {}", frame(1));
        for (step, want) in [(8, 0.77), (12, 0.46), (18, 0.18), (24, 0.07)] {
            let got = r[step - 1] / peak;
            assert!((got - want).abs() < 0.04, "step {step}: {got} vs {want}");
        }
        assert!(r[35] / peak < 0.01, "settled by 300 ms");
    }

    #[test]
    fn a_weapons_half_and_back_times_pick_its_shape() {
        // the shotgun's (95 ms, 175 ms) is the shoulder; the pistol's (70 ms, 150 ms) snaps back sooner
        let shotgun = fit(0.095, 0.175);
        assert!(shotgun.snap < 0.2 && (shotgun.omega - 28.0).abs() < 2.0, "{shotgun:?}");
        assert!((back_time(shotgun, 0.5) - 0.095).abs() < 0.004, "{shotgun:?}");
        // the pistol's measured curve is steeper than any of these shapes can be at both times (50% by 70 ms and 90%
        // by 150 ms): the fit holds 90% and gets as close to 50% as straight back allows
        let pistol = fit(0.07, 0.15);
        assert!(pistol.snap > 0.5, "{pistol:?}");
        assert!(back_time(pistol, 0.5) < 0.085 && (back_time(pistol, 0.1) - 0.15).abs() < 0.004, "{pistol:?}");
        assert_eq!(response(pistol, 30), response(pistol, 30), "deterministic");
    }
}
