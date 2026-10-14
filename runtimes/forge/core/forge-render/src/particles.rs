//! Particles: camera-facing billboards simulated on the CPU (a few thousand at most) and drawn as one instanced draw
//! per layer. Bursts come from the core's PARTICLES events (by name: a kind's id or alias), from the host
//! (`burst`), and from emitters the renderer runs itself: embers and smoke over every fire light, ash drifting around
//! the eye. Every kind's numbers are `look.particles.<kind>.*` slots (kit/look.js); each kind's picture is the
//! library's `fx/*.png` (an `fx.*` image slot) when the host gives it (`set_fx`), else a shape drawn in the shader.
//!
//! The default numbers follow research/rust-engine/feel-targets.md: a grey-white barrel smoke puff from about 130 ms
//! after a shot that lingers about 0.3 s; a few orange sparks at the barrel; kills into dust puffs and sparks spread
//! over about 0.4 s or more; about 400 ambient particles over the fires in a live scene.
use glam::{Mat4, Vec3};

pub const MAX_PARTICLES: usize = 4096;
/// Floats a particle sends the GPU (4 × vec4).
pub const PARTICLE_FLOATS: usize = 16;

/// Procedural shapes (the shader draws them when a kind has no picture).
pub const SHAPE_DISC: u32 = 0;
pub const SHAPE_STAR: u32 = 1;
pub const SHAPE_STREAK: u32 = 2;
pub const SHAPE_RING: u32 = 3;
pub const SHAPE_CHIP: u32 = 4;
/// A tracer's strip between two points (`Scene::write_tracers`), not a billboard.
pub const SHAPE_BEAM: u32 = 5;

/// One kind's numbers (each a look slot).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Kind {
    pub color: [f32; 3],
    pub alpha: f32,
    /// HDR multiplier on the colour (over 1 blooms).
    pub glow: f32,
    /// Particles a burst makes when its event says 0.
    pub count: f32,
    /// Seconds (each particle ±25%).
    pub life: f32,
    pub size0: f32,
    pub size1: f32,
    /// m/s when the event says 0.
    pub speed: f32,
    /// Cone half-angle, radians, when the event says 0 (over π: every way).
    pub spread: f32,
    /// m/s² down (negative rises).
    pub gravity: f32,
    pub drag: f32,
    /// 0 alpha-blended, 1 added (fire, sparks).
    pub additive: f32,
    /// Seconds of motion a particle is stretched along (sparks).
    pub stretch: f32,
    /// Seconds before it shows (the barrel smoke comes after the flash).
    pub delay: f32,
    /// Bounce off the ground (0: falls through).
    pub bounce: f32,
    /// Spin, rad/s (±).
    pub spin: f32,
}

impl Kind {
    pub fn from_fields(f: &[f32], d: &Kind) -> Kind {
        let g = |i: usize, x: f32| f.get(i).copied().filter(|v| v.is_finite()).unwrap_or(x);
        Kind {
            color: [g(0, d.color[0]).max(0.0), g(1, d.color[1]).max(0.0), g(2, d.color[2]).max(0.0)],
            alpha: g(3, d.alpha).clamp(0.0, 1.0),
            glow: g(4, d.glow).clamp(0.0, 64.0),
            count: g(5, d.count).clamp(0.0, 256.0),
            life: g(6, d.life).clamp(0.01, 30.0),
            size0: g(7, d.size0).clamp(0.0, 20.0),
            size1: g(8, d.size1).clamp(0.0, 20.0),
            speed: g(9, d.speed).clamp(0.0, 200.0),
            spread: g(10, d.spread).clamp(0.0, 4.0),
            gravity: g(11, d.gravity).clamp(-50.0, 50.0),
            drag: g(12, d.drag).clamp(0.0, 50.0),
            additive: g(13, d.additive).clamp(0.0, 1.0),
            stretch: g(14, d.stretch).clamp(0.0, 1.0),
            delay: g(15, d.delay).clamp(0.0, 5.0),
            bounce: g(16, d.bounce).clamp(0.0, 1.0),
            spin: g(17, d.spin).clamp(0.0, 60.0),
        }
    }
}

/// A kind's id, the names an event may use for it, its shape without a picture, and its default numbers.
pub struct KindDef {
    pub id: &'static str,
    pub aliases: &'static [&'static str],
    pub shape: u32,
    /// Drawn after the first-person layer when it is born this close to the eye (the local muzzle flash).
    pub on_top: bool,
    pub d: [f32; 18],
}

impl KindDef {
    pub fn default_kind(&self) -> Kind {
        Kind::from_fields(&self.d, &Kind { color: [1.0; 3], alpha: 1.0, glow: 1.0, count: 1.0, life: 1.0, size0: 0.1, size1: 0.1, speed: 0.0, spread: 0.0, gravity: 0.0, drag: 0.0, additive: 0.0, stretch: 0.0, delay: 0.0, bounce: 0.0, spin: 0.0 })
    }
}

//                    r     g     b    alpha glow count life size0 size1 speed spread grav  drag  add  stretch delay bounce spin
pub const KINDS: [KindDef; 10] = [
    KindDef { id: "smoke", aliases: &["muzzle-smoke", "puff"], shape: SHAPE_DISC, on_top: false, d: [0.78, 0.76, 0.72, 0.30, 1.0, 3.0, 0.45, 0.10, 0.45, 0.35, 0.6, -0.4, 2.0, 0.0, 0.0, 0.13, 0.0, 0.6] },
    KindDef { id: "sparks", aliases: &["spark"], shape: SHAPE_STREAK, on_top: false, d: [1.0, 0.55, 0.18, 1.0, 3.0, 8.0, 0.25, 0.035, 0.012, 6.0, 0.7, 9.8, 1.5, 1.0, 0.035, 0.0, 0.3, 0.0] },
    KindDef { id: "embers", aliases: &["ember", "fire"], shape: SHAPE_DISC, on_top: false, d: [1.0, 0.42, 0.10, 1.0, 2.5, 1.0, 2.2, 0.035, 0.012, 0.6, 0.5, -0.9, 0.6, 1.0, 0.0, 0.0, 0.0, 0.0] },
    KindDef { id: "dust", aliases: &["dust-puff"], shape: SHAPE_DISC, on_top: false, d: [0.80, 0.76, 0.68, 0.45, 1.0, 10.0, 0.8, 0.18, 0.6, 2.2, 1.4, -0.3, 3.0, 0.0, 0.0, 0.0, 0.0, 0.4] },
    KindDef { id: "bone", aliases: &["bones", "bone-chip", "bone-chips", "debris", "chips"], shape: SHAPE_CHIP, on_top: false, d: [0.88, 0.85, 0.76, 1.0, 1.0, 14.0, 0.9, 0.06, 0.05, 4.5, 1.1, 12.0, 0.4, 0.0, 0.0, 0.0, 0.35, 8.0] },
    KindDef { id: "blood", aliases: &["blood-mist", "mist"], shape: SHAPE_DISC, on_top: false, d: [0.32, 0.02, 0.02, 0.65, 1.0, 8.0, 0.55, 0.12, 0.45, 1.6, 1.0, 1.0, 2.5, 0.0, 0.0, 0.0, 0.0, 0.5] },
    KindDef { id: "muzzle", aliases: &["muzzle-flash", "flash"], shape: SHAPE_STAR, on_top: true, d: [1.0, 0.85, 0.55, 1.0, 4.0, 1.0, 0.05, 0.28, 0.18, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0] },
    KindDef { id: "impact", aliases: &["impact-ring", "hit"], shape: SHAPE_RING, on_top: false, d: [1.0, 0.7, 0.4, 1.0, 2.5, 1.0, 0.08, 0.08, 0.45, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0] },
    KindDef { id: "orb", aliases: &["glow", "orb-burst"], shape: SHAPE_DISC, on_top: false, d: [0.10, 1.0, 0.45, 1.0, 3.0, 1.0, 0.25, 0.35, 0.15, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0] },
    KindDef { id: "ash", aliases: &["ashes", "snow"], shape: SHAPE_CHIP, on_top: false, d: [0.45, 0.42, 0.40, 0.7, 1.0, 1.0, 6.0, 0.025, 0.02, 0.3, 1.0, 0.25, 0.8, 0.0, 0.0, 0.0, 0.0, 2.0] },
];

pub const SMOKE: usize = 0;
pub const EMBERS: usize = 2;
pub const ASH: usize = 9;

/// The kind an event's name means: its id or an alias, with an `fx.` or `particles.` prefix allowed.
pub fn kind_of(name: &str) -> Option<usize> {
    let n = name.trim().to_ascii_lowercase();
    let n = n.strip_prefix("fx.").or_else(|| n.strip_prefix("particles.")).unwrap_or(&n).to_string();
    KINDS.iter().position(|k| k.id == n || k.aliases.contains(&n.as_str()))
}

#[derive(Clone, Copy, Debug)]
pub struct Particle {
    pub pos: Vec3,
    pub vel: Vec3,
    pub age: f32,
    pub life: f32,
    pub rot: f32,
    pub spin: f32,
    pub kind: u8,
    pub on_top: bool,
    pub seed: f32,
}

#[derive(Default)]
pub struct Particles {
    pub list: Vec<Particle>,
    rng: u64,
    /// Continuous emitters' leftover (a fraction of a particle carried to the next frame), by emitter key.
    carry: std::collections::HashMap<u64, f32>,
    /// Particles born since the start (for stats).
    pub born: u64,
    pub dropped: u64,
}

impl Particles {
    fn rand(&mut self) -> f32 {
        if self.rng == 0 {
            self.rng = 0x9E37_79B9_7F4A_7C15;
        }
        let mut x = self.rng;
        x ^= x << 13;
        x ^= x >> 7;
        x ^= x << 17;
        self.rng = x;
        (x >> 40) as f32 / (1u64 << 24) as f32
    }
    fn range(&mut self, a: f32, b: f32) -> f32 {
        a + (b - a) * self.rand()
    }
    /// A unit direction within `spread` radians of `dir` (over π: anywhere).
    fn cone(&mut self, dir: Vec3, spread: f32) -> Vec3 {
        let d = dir.normalize_or(Vec3::Y);
        let cos_max = spread.min(std::f32::consts::PI).cos();
        let z = self.range(cos_max, 1.0);
        let phi = self.range(0.0, std::f32::consts::TAU);
        let r = (1.0 - z * z).max(0.0).sqrt();
        let local = Vec3::new(r * phi.cos(), r * phi.sin(), z);
        // a basis with d as +Z
        let up = if d.y.abs() > 0.99 { Vec3::X } else { Vec3::Y };
        let x = up.cross(d).normalize();
        let y = d.cross(x);
        x * local.x + y * local.y + d * local.z
    }

    /// A burst of `kind`: `count`, `speed` and `spread` of 0 take the kind's own; `dir` zero goes up.
    pub fn burst(&mut self, kinds: &[Kind], kind: usize, count: u32, pos: Vec3, dir: Vec3, speed: f32, spread: f32, budget: usize, eye: Vec3) {
        let Some(k) = kinds.get(kind).copied() else { return };
        let n = if count > 0 { count as usize } else { k.count.round() as usize };
        let speed = if speed > 0.0 { speed } else { k.speed };
        let spread = if spread > 0.0 { spread } else { k.spread };
        let dir = if dir.length_squared() > 1e-8 { dir } else { Vec3::Y };
        let on_top = KINDS[kind].on_top && pos.distance(eye) < 1.6;
        for _ in 0..n.min(512) {
            if self.list.len() >= budget.min(MAX_PARTICLES) {
                self.dropped += 1;
                continue;
            }
            let v = self.cone(dir, spread) * speed * self.range(0.6, 1.2);
            let life = k.life * self.range(0.75, 1.25);
            let rot = self.range(0.0, std::f32::consts::TAU);
            let spin = k.spin * self.range(-1.0, 1.0);
            let seed = self.rand();
            let age = -k.delay * self.range(0.85, 1.15);
            self.list.push(Particle { pos, vel: v, age, life, rot, spin, kind: kind as u8, on_top, seed });
            self.born += 1;
        }
    }

    /// A continuous emitter: `rate` a second of `kind` at `pos` (fractions carried by `key`).
    pub fn emit(&mut self, kinds: &[Kind], key: u64, kind: usize, rate: f32, dt: f32, pos: Vec3, jitter: Vec3, budget: usize, eye: Vec3) {
        if rate <= 0.0 || dt <= 0.0 {
            return;
        }
        let acc = self.carry.entry(key).or_insert(0.0);
        *acc += rate * dt;
        let n = (*acc + 1e-4).floor();
        *acc = (*acc - n).max(0.0);
        for _ in 0..n as u32 {
            let off = Vec3::new(self.range(-1.0, 1.0) * jitter.x, self.range(-1.0, 1.0) * jitter.y, self.range(-1.0, 1.0) * jitter.z);
            self.burst(kinds, kind, 1, pos + off, Vec3::ZERO, 0.0, 0.0, budget, eye);
        }
    }

    /// Advance every particle by `dt` seconds; the dead go.
    pub fn update(&mut self, kinds: &[Kind], dt: f32) {
        if dt <= 0.0 {
            return;
        }
        for p in self.list.iter_mut() {
            p.age += dt;
            if p.age < 0.0 {
                continue;
            }
            let k = &kinds[p.kind as usize];
            p.vel.y -= k.gravity * dt;
            if k.gravity < 0.0 || p.kind as usize == ASH {
                // a drifting swirl for what rises or floats (embers, smoke, ash)
                let w = p.age * 2.3 + p.seed * 17.0;
                p.vel.x += w.sin() * 0.6 * dt;
                p.vel.z += (w * 0.8 + 1.3).cos() * 0.6 * dt;
            }
            p.vel *= (-k.drag * dt).exp();
            p.pos += p.vel * dt;
            p.rot += p.spin * dt;
            if k.bounce > 0.0 && p.pos.y < 0.02 && p.vel.y < 0.0 {
                p.pos.y = 0.02;
                p.vel.y = -p.vel.y * k.bounce;
                p.vel.x *= 0.6;
                p.vel.z *= 0.6;
                p.spin *= 0.5;
            }
        }
        self.list.retain(|p| p.age < p.life);
    }

    /// The live particles of one layer (on top or not) as instance floats, far first: [pos, size] [vel, rot]
    /// [rgb (× glow), alpha] [cell, additive, stretch, shape]. `cells[kind]` is its picture's place in the fx atlas
    /// (−1: the shape).
    pub fn write(&self, kinds: &[Kind], cells: &[i32], eye: Vec3, view: &Mat4, on_top: bool, out: &mut Vec<f32>) -> u32 {
        let mut order: Vec<(f32, usize)> = self.list.iter().enumerate().filter(|(_, p)| p.on_top == on_top && p.age >= 0.0).map(|(i, p)| (view.transform_point3(p.pos).z, i)).collect();
        // view space looks down −Z: the most negative z is the farthest
        order.sort_by(|a, b| a.0.partial_cmp(&b.0).unwrap_or(std::cmp::Ordering::Equal));
        let _ = eye;
        for (_, i) in &order {
            let p = &self.list[*i];
            let k = &kinds[p.kind as usize];
            let x = (p.age / p.life.max(1e-4)).clamp(0.0, 1.0);
            let size = k.size0 + (k.size1 - k.size0) * x;
            let fade_in = (x / 0.08).min(1.0);
            let fade_out = (1.0 - x) * (1.0 - x).sqrt();
            let a = k.alpha * fade_in * fade_out;
            let g = k.glow;
            let cell = cells.get(p.kind as usize).copied().unwrap_or(-1);
            out.extend_from_slice(&[p.pos.x, p.pos.y, p.pos.z, size, p.vel.x, p.vel.y, p.vel.z, p.rot, k.color[0] * g, k.color[1] * g, k.color[2] * g, a, cell as f32, k.additive, k.stretch, KINDS[p.kind as usize].shape as f32]);
        }
        order.len() as u32
    }

    pub fn clear(&mut self) {
        self.list.clear();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn kinds() -> Vec<Kind> {
        KINDS.iter().map(|k| k.default_kind()).collect()
    }

    #[test]
    fn names_find_their_kinds() {
        assert_eq!(kind_of("sparks"), Some(1));
        assert_eq!(kind_of("fx.spark"), Some(1));
        assert_eq!(kind_of("particles.bone-chips"), Some(4));
        assert_eq!(kind_of("Muzzle-Flash"), Some(6));
        assert_eq!(kind_of("confetti"), None);
    }

    #[test]
    fn a_burst_lives_its_life_and_goes() {
        let k = kinds();
        let mut p = Particles::default();
        p.burst(&k, 1, 0, Vec3::new(0.0, 1.0, 0.0), Vec3::Z, 0.0, 0.0, 4096, Vec3::new(0.0, 1.0, 10.0));
        assert_eq!(p.list.len(), 8, "the kind's own count");
        let start = p.list[0].pos;
        p.update(&k, 0.05);
        assert!(p.list.iter().all(|q| q.pos != start), "they moved");
        for _ in 0..40 {
            p.update(&k, 0.05);
        }
        assert!(p.list.is_empty(), "sparks live about 0.25 s");
    }

    #[test]
    fn smoke_waits_before_it_shows_and_the_budget_holds() {
        let k = kinds();
        let mut p = Particles::default();
        p.burst(&k, SMOKE, 3, Vec3::ZERO, Vec3::Y, 0.0, 0.0, 4096, Vec3::new(0.0, 0.0, 9.0));
        let mut out = Vec::new();
        let view = Mat4::IDENTITY;
        assert_eq!(p.write(&k, &[-1; 10], Vec3::ZERO, &view, false, &mut out), 0, "not shown during its delay");
        p.update(&k, 0.2);
        assert_eq!(p.write(&k, &[-1; 10], Vec3::ZERO, &view, false, &mut out), 3);
        assert_eq!(out.len(), 3 * PARTICLE_FLOATS);
        let mut q = Particles::default();
        q.burst(&k, 3, 100, Vec3::ZERO, Vec3::Y, 0.0, 0.0, 16, Vec3::ZERO);
        assert_eq!(q.list.len(), 16);
        assert_eq!(q.dropped, 84);
    }

    #[test]
    fn an_emitter_carries_its_fractions() {
        let k = kinds();
        let mut p = Particles::default();
        for _ in 0..60 {
            p.emit(&k, 7, EMBERS, 12.0, 1.0 / 60.0, Vec3::ZERO, Vec3::splat(0.1), 4096, Vec3::ZERO);
        }
        assert_eq!(p.born, 12, "12 a second for one second");
    }
}
