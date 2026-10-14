//! Hurt regions: the capsules a hit lands on (`components::Hurtbox`), placed on the animated bones every step and
//! tested against rays (`Sim::trace`). The geometry here is plain math, no physics engine: a body has a dozen
//! capsules at most, and a trace tests every hurtbox in the world (a few hundred capsules, microseconds).
use glam::{Mat4, Vec3};

/// The first hit of the ray `o + t·d` (d normalised) on the capsule `a`–`b` of radius `r`, within `max`:
/// (t, the outward normal there). A ray starting inside hits at t = 0.
pub fn ray_capsule(o: Vec3, d: Vec3, a: Vec3, b: Vec3, r: f32, max: f32) -> Option<(f32, Vec3)> {
    let ab = b - a;
    let ao = o - a;
    let len2 = ab.length_squared();
    // inside: the nearest point of the segment to the origin within r
    let s0 = if len2 > 0.0 { (ao.dot(ab) / len2).clamp(0.0, 1.0) } else { 0.0 };
    let near0 = a + ab * s0;
    if (o - near0).length_squared() <= r * r {
        return Some((0.0, (o - near0).normalize_or(-d)));
    }
    let mut best: Option<f32> = None;
    // the cylinder between the caps
    if len2 > 1e-12 {
        let ab_d = ab.dot(d);
        let ab_ao = ab.dot(ao);
        let qa = len2 - ab_d * ab_d;
        let qb = len2 * ao.dot(d) - ab_ao * ab_d;
        let qc = len2 * ao.length_squared() - ab_ao * ab_ao - r * r * len2;
        if qa.abs() > 1e-12 {
            let disc = qb * qb - qa * qc;
            if disc >= 0.0 {
                let t = (-qb - disc.sqrt()) / qa;
                let s = ab_ao + t * ab_d;
                if t >= 0.0 && s >= 0.0 && s <= len2 {
                    best = Some(t);
                }
            }
        }
    }
    // the two caps
    for c in [a, b] {
        if let Some(t) = ray_sphere(o, d, c, r)
            && best.is_none_or(|x| t < x) {
                best = Some(t);
            }
    }
    let t = best.filter(|&t| t <= max)?;
    let p = o + d * t;
    let s = if len2 > 0.0 { ((p - a).dot(ab) / len2).clamp(0.0, 1.0) } else { 0.0 };
    Some((t, (p - (a + ab * s)).normalize_or(-d)))
}

fn ray_sphere(o: Vec3, d: Vec3, c: Vec3, r: f32) -> Option<f32> {
    let m = o - c;
    let b = m.dot(d);
    let cc = m.length_squared() - r * r;
    if cc > 0.0 && b > 0.0 {
        return None;
    }
    let disc = b * b - cc;
    if disc < 0.0 {
        return None;
    }
    Some((-b - disc.sqrt()).max(0.0))
}

/// Hurt regions for a body on gf-humanoid-1 (forge-anim `Body`): one capsule per ragdoll part (RIG.md §6, the order of
/// `components::Part`), from the part's bone to the first of its far-end bones the body has (a share of the body's
/// height up the bone when it has none), in the bone's own frame at bind, so they follow the animation. Radii are a
/// share of the body's height [E: track F tunes them]; the head is a critical region at double damage.
pub fn humanoid_regions(body: &forge_anim::Body, group: u32) -> crate::components::Hurtbox {
    use crate::components::{HurtRegion, Hurtbox, Part};
    use forge_anim::humanoid;
    let h = if body.height > 0.2 { body.height } else { 1.8 };
    // radius and the fallback length, as shares of the height, per part (pelvis … shin_r)
    const SHARE: [(f32, f32); 11] = [(0.08, 0.1), (0.09, 0.2), (0.065, 0.12), (0.035, 0.16), (0.03, 0.15), (0.035, 0.16), (0.03, 0.15), (0.05, 0.24), (0.04, 0.24), (0.05, 0.24), (0.04, 0.24)];
    let mut regions = Vec::new();
    for (i, (_, bone, far, _)) in humanoid::RAGDOLL.iter().enumerate() {
        let Some(j) = humanoid::index(bone).and_then(|x| body.humanoid[x]) else { continue };
        let bind = body.joints[j].bind;
        let start = bind.w_axis.truncate();
        let end = far.iter().filter_map(|n| humanoid::index(n).and_then(|x| body.bind_pos(x))).next().unwrap_or(start + Vec3::Y * SHARE[i].1 * h);
        let inv = bind.inverse();
        let radius = SHARE[i].0 * h;
        let head = i == 2;
        regions.push(HurtRegion { part: Part::from_u8(i as u8 + 1), bone: j as u16, a: inv.transform_point3(start), b: inv.transform_point3(end), radius, damage: if head { 2.0 } else { 1.0 }, crit: head });
    }
    Hurtbox::new(regions, group)
}

/// Place a hurtbox's capsules in the world: `entity` the entity's transform, `bones` its animated body's bone world
/// matrices (model space; empty when it has none).
pub fn place(hb: &mut crate::components::Hurtbox, entity: Mat4, bones: &[Mat4]) {
    hb.world.resize(hb.regions.len(), (Vec3::ZERO, Vec3::ZERO));
    for (i, r) in hb.regions.iter().enumerate() {
        let m = match bones.get(r.bone as usize) {
            Some(b) if r.bone != crate::components::NO_BONE => entity * *b,
            _ => entity,
        };
        hb.world[i] = (m.transform_point3(r.a), m.transform_point3(r.b));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_ray_hits_the_side_the_cap_and_misses_beside() {
        let (a, b) = (Vec3::new(0.0, 0.3, 0.0), Vec3::new(0.0, 1.5, 0.0));
        let (t, n) = ray_capsule(Vec3::new(-5.0, 1.0, 0.0), Vec3::X, a, b, 0.3, 100.0).unwrap();
        assert!((t - 4.7).abs() < 1e-4 && (n - Vec3::NEG_X).length() < 1e-4, "side {t} {n}");
        let (t, n) = ray_capsule(Vec3::new(0.0, 5.0, 0.0), Vec3::NEG_Y, a, b, 0.3, 100.0).unwrap();
        assert!((t - 3.2).abs() < 1e-4 && (n - Vec3::Y).length() < 1e-4, "top cap {t} {n}");
        assert!(ray_capsule(Vec3::new(-5.0, 1.0, 0.31), Vec3::X, a, b, 0.3, 100.0).is_none());
        assert!(ray_capsule(Vec3::new(-5.0, 1.0, 0.0), Vec3::X, a, b, 0.3, 4.0).is_none(), "beyond max");
        assert_eq!(ray_capsule(Vec3::new(0.0, 1.0, 0.1), Vec3::X, a, b, 0.3, 1.0).unwrap().0, 0.0, "from inside");
    }
}
