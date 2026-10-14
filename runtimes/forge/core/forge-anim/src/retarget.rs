//! The retarget: the standard skeleton's pose (a gf-humanoid-1 clip file) → a body's bones, as rig.js
//! `createRetarget` does it (RIG.md §3), so a forge body moves as the same body does in three.js:
//!
//!   world(b) = D(b) · R(b) · B(b),   local(b) = world(parent)⁻¹ · world(b)
//!
//! D is the standard bone's world rotation from the clip, B the body bone's bind rotation in character space, and R a
//! swing that lines the body's limbs up with the standard's T-pose (own swing for upper arms, forearms, thighs and
//! shins; hands, feet, toes and fingers inherit their parent's; the four fingers also line each segment up with the
//! clip's). A finger whose bone 1 starts inside the palm is shifted one bone outward (`humanoid::PALM_FIRST`). The hips
//! move by the clip's hip offset, scaled by the body's straight-leg reach over the standard's (`k`). `gfSpineBend`
//! damps the spine's bend relative to the hips.
use glam::{Mat4, Quat, Vec3};

use crate::body::Body;
use crate::clips::Standard;
use crate::humanoid;
use crate::pose::Trs;

#[derive(Clone, Debug)]
struct Driven {
    /// The body joint (a finger's tip bone).
    joint: usize,
    /// The humanoid bone whose standard rotation drives it.
    driver: usize,
    /// Its parent (a humanoid bone of the body).
    parent: usize,
    c: Quat,
}

#[derive(Clone, Debug)]
pub struct Retarget {
    /// Humanoid bones the body has, in `humanoid::BONES` order.
    pub order: Vec<usize>,
    /// Per humanoid bone: which standard bone drives it (itself, or the shifted finger's).
    pub driver: [usize; humanoid::COUNT],
    /// C = R · B per humanoid bone.
    c: [Quat; humanoid::COUNT],
    /// Per humanoid bone: its parent humanoid bone when that is its joint's direct parent; else None (static).
    parent_dyn: [Option<usize>; humanoid::COUNT],
    /// Per humanoid bone without a dynamic parent: its static parent's world rotation, inverted.
    static_inv: [Quat; humanoid::COUNT],
    hips_static_inv: Mat4,
    driven: Vec<Driven>,
    pub k: f32,
    pub ground: f32,
    pub height: f32,
    hips_lift: f32,
    std_ground: f32,
    pub spine_bend: f32,
    /// The swing per humanoid bone, degrees (rig-check's measure).
    pub swing_deg: [f32; humanoid::COUNT],
    /// Fingers shifted one bone outward: (side, finger) names.
    pub shifted: Vec<String>,
}

fn from_to(a: Vec3, b: Vec3) -> Quat {
    // three.js Quaternion.setFromUnitVectors
    let a = a.normalize_or_zero();
    let b = b.normalize_or_zero();
    if a == Vec3::ZERO || b == Vec3::ZERO {
        return Quat::IDENTITY;
    }
    Quat::from_rotation_arc(a, b)
}

impl Retarget {
    /// Build the per-body constants against a standard skeleton. Err when the body lacks a required bone.
    pub fn new(body: &Body, std: &Standard) -> Result<Retarget, String> {
        let missing = body.missing();
        if !missing.is_empty() {
            return Err(format!("gf-humanoid-1: the body is missing {}", missing.join(", ")));
        }
        let has = |h: usize| body.has(h);
        let order: Vec<usize> = (0..humanoid::COUNT).filter(|&h| has(h)).collect();
        let pos = |h: usize| body.bind_pos(h).unwrap_or(Vec3::ZERO);
        let srest = |h: usize| std.rest[h];
        let idx = |n: &str| humanoid::index(n).expect("a humanoid name");
        // leg scale: how high this body's hips stand once its legs are straight, over the standard's
        let reach = |p: &dyn Fn(usize) -> Vec3, g: f32| {
            let side = |s: &str| {
                let (up, leg, foot) = (idx(&format!("{s}UpLeg")), idx(&format!("{s}Leg")), idx(&format!("{s}Foot")));
                p(up).distance(p(leg)) + p(leg).distance(p(foot)) + (p(foot).y - g) + (p(0).y - p(up).y)
            };
            (side("Left") + side("Right")) / 2.0
        };
        let std_reach = if std.rest[idx("LeftUpLeg")].is_some() && std.rest[idx("RightUpLeg")].is_some() { reach(&|h| srest(h).unwrap_or(Vec3::ZERO), std.ground) } else { std.hips_height };
        let k = if std_reach > 0.0 { reach(&pos, body.ground) / std_reach } else { 1.0 };
        // fingers whose bone 1 starts inside the palm
        let mut driver: [usize; humanoid::COUNT] = std::array::from_fn(|i| i);
        let mut driven_tips: Vec<(usize, usize, Vec3)> = Vec::new(); // (tip joint, bone 3 humanoid, tip bind pos)
        let mut tip_pos: [Option<Vec3>; humanoid::COUNT] = [None; humanoid::COUNT];
        let mut shifted = Vec::new();
        if !body.fingers_by_name {
            for s in ["Left", "Right"] {
                for f in ["Index", "Middle", "Ring", "Pinky"] {
                    let stem = format!("{s}Hand{f}");
                    let (n1, n2, n3) = (humanoid::finger(&stem, 1).unwrap(), humanoid::finger(&stem, 2).unwrap(), humanoid::finger(&stem, 3).unwrap());
                    let hand = idx(&format!("{s}Hand"));
                    if !has(n1) || !has(n2) || !has(hand) {
                        continue;
                    }
                    let w = pos(hand);
                    let (d1, d2) = (pos(n1).distance(w), pos(n2).distance(w));
                    if !(d2 > 0.0 && d1 / d2 < humanoid::PALM_FIRST) {
                        continue;
                    }
                    driver[n1] = hand;
                    driver[n2] = n1;
                    if has(n3) {
                        driver[n3] = n2;
                        let j3 = body.humanoid[n3].unwrap();
                        if let Some((tj, tip)) = body.joints.iter().enumerate().find(|(_, j)| j.parent == Some(j3) && j.skin && !humanoid::is_canonical(&j.name)) {
                            let p = tip.bind.w_axis.truncate();
                            driven_tips.push((tj, n3, p));
                            tip_pos[n3] = Some(p);
                        }
                    }
                    shifted.push(format!("{s}{f}"));
                }
            }
        }
        // R: own swing or inherited
        let mut r = [Quat::IDENTITY; humanoid::COUNT];
        let mut swing_deg = [0f32; humanoid::COUNT];
        for &h in &order {
            let mut q = Quat::IDENTITY;
            if let Some(child) = humanoid::swing_child(h).filter(|&c| has(c) && srest(h).is_some() && srest(c).is_some()) {
                let db = pos(child) - pos(h);
                let ds = srest(child).unwrap() - srest(h).unwrap();
                if db.length_squared() > 0.0 && ds.length_squared() > 0.0 {
                    q = from_to(db, ds);
                }
            } else if humanoid::inherits(h) {
                if let Some(p) = humanoid::canonical_parent(h, has) {
                    q = r[p];
                }
                let dn = driver[h];
                if let (Some((fstem, fseg)), Some((sstem, sseg))) = (humanoid::finger_of(h), humanoid::finger_of(dn)) {
                    let next = humanoid::finger(fstem, fseg + 1).filter(|&x| has(x)).map(pos).or(tip_pos[h]);
                    let snext = humanoid::finger(sstem, sseg + 1).and_then(srest);
                    if let (Some(next), Some(snext), Some(sdn)) = (next, snext, srest(dn)) {
                        let db = q * (next - pos(h));
                        let ds = snext - sdn;
                        if db.length_squared() > 0.0 && ds.length_squared() > 0.0 {
                            q = from_to(db, ds) * q;
                        }
                    }
                }
            }
            r[h] = q;
            swing_deg[h] = (2.0 * q.w.abs().min(1.0).acos()).to_degrees();
        }
        // C = R · B, and each bone's parent: a humanoid bone when it is the joint's direct parent, else static
        let mut c = [Quat::IDENTITY; humanoid::COUNT];
        let mut parent_dyn = [None; humanoid::COUNT];
        let mut static_inv = [Quat::IDENTITY; humanoid::COUNT];
        let mut hips_static_inv = Mat4::IDENTITY;
        for &h in &order {
            let j = &body.joints[body.humanoid[h].unwrap()];
            let (_, b, _) = j.bind.to_scale_rotation_translation();
            c[h] = r[h] * b.normalize();
            let pj = j.parent.map(|p| &body.joints[p]);
            match pj.and_then(|p| humanoid::index(&p.name).filter(|&ph| body.humanoid[ph] == j.parent)) {
                Some(ph) => parent_dyn[h] = Some(ph),
                None => {
                    // the static parent's world: the parent joint's bind when it is a joint (posed to bind), else its node
                    let pw = match j.parent {
                        Some(p) => body.joints[p].bind,
                        None => j.static_parent,
                    };
                    let (_, q, _) = pw.to_scale_rotation_translation();
                    static_inv[h] = q.normalize().inverse();
                    if h == 0 {
                        hips_static_inv = pw.inverse();
                    }
                }
            }
        }
        let driven = driven_tips
            .into_iter()
            .map(|(tj, n3, _)| {
                let (_, q, _) = body.joints[tj].bind.to_scale_rotation_translation();
                Driven { joint: tj, driver: n3, parent: n3, c: r[n3] * q.normalize() }
            })
            .collect();
        let hips_lift = if std_reach > 0.0 { std.hips_height / std_reach } else { 1.0 };
        Ok(Retarget { order, driver, c, parent_dyn, static_inv, hips_static_inv, driven, k, ground: body.ground, height: body.height, hips_lift, std_ground: std.ground, spine_bend: body.spine_bend, swing_deg, shifted })
    }

    /// The standard skeleton's world rotations from its local pose (`std_local[h]`: a humanoid bone's local rotation;
    /// None where the clip file has no such bone), down the canonical tree.
    pub fn standard_world(std_local: &[Option<Quat>; humanoid::COUNT]) -> [Option<Quat>; humanoid::COUNT] {
        let mut sw: [Option<Quat>; humanoid::COUNT] = [None; humanoid::COUNT];
        for h in 0..humanoid::COUNT {
            let Some(q) = std_local[h] else { continue };
            let p = humanoid::canonical_parent(h, |x| std_local[x].is_some());
            sw[h] = Some(match p.and_then(|p| sw[p]) {
                Some(pw) => pw * q,
                None => q,
            });
        }
        sw
    }

    /// Write the body's pose: `local` (one `Trs` per body joint, at rest on entry) takes the retargeted rotations of
    /// every humanoid bone and the shifted fingers' tips, and the hips' position. `std_local`: the standard's local
    /// rotations; `std_hips`: the standard hips' local position.
    pub fn apply(&self, body: &Body, std_local: &[Option<Quat>; humanoid::COUNT], std_hips: Vec3, pin_xz: bool, local: &mut [Trs]) {
        let mut sw = Self::standard_world(std_local);
        if self.spine_bend < 1.0
            && let Some(hq) = sw[0] {
                let inv = hq.inverse();
                for n in humanoid::SPINE {
                    let i = humanoid::index(n).unwrap();
                    if let Some(d) = sw[i] {
                        let rel = (inv * d).slerp(Quat::IDENTITY, 1.0 - self.spine_bend);
                        sw[i] = Some(hq * rel);
                    }
                }
            }
        let mut w = [Quat::IDENTITY; humanoid::COUNT];
        for &h in &self.order {
            let dn = self.driver[h];
            let d = sw[dn].or_else(|| humanoid::canonical_parent(dn, |x| sw[x].is_some()).and_then(|p| sw[p])).unwrap_or(Quat::IDENTITY);
            w[h] = d * self.c[h];
            let q = match self.parent_dyn[h] {
                Some(p) => w[p].inverse() * w[h],
                None => self.static_inv[h] * w[h],
            };
            local[body.humanoid[h].unwrap()].r = q.normalize();
        }
        for t in &self.driven {
            let wk = sw[t.driver].unwrap_or(w[t.parent]) * t.c;
            local[t.joint].r = (w[t.parent].inverse() * wk).normalize();
        }
        // the hips: the standard's position (character space), legs scaled, feet on this body's ground
        let hp = Vec3::new(if pin_xz { 0.0 } else { std_hips.x * self.k }, self.ground + (std_hips.y - self.std_ground) * self.k * self.hips_lift, if pin_xz { 0.0 } else { std_hips.z * self.k });
        let hj = body.humanoid[0].unwrap();
        local[hj].t = if self.parent_dyn[0].is_some() { hp } else { self.hips_static_inv.transform_point3(hp) };
    }
}
