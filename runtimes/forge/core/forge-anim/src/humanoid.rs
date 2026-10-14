//! gf-humanoid-1, the games.fun character standard (research/gf-three/kit/character/RIG.md; its data is `rig.js`): the
//! bone names, their canonical parents and which are required, the swing and inherit sets the retarget uses, the
//! upper-body mask for overlay clips, the sockets, and the ragdoll parts (which `forge-core` hurt regions are named by).
//! The order is rig.js's `BONES` (parents first), so a humanoid index is the same number everywhere.

/// [name, canonical parent, required] in rig.js's order.
pub const BONES: [(&str, Option<&str>, bool); 54] = [
    ("Hips", None, true),
    ("Spine02", Some("Hips"), false),
    ("Spine01", Some("Spine02"), false),
    ("Spine", Some("Spine01"), true),
    ("neck", Some("Spine"), false),
    ("Head", Some("neck"), true),
    ("head_end", Some("Head"), false),
    ("headfront", Some("Head"), false),
    ("LeftShoulder", Some("Spine"), false),
    ("LeftArm", Some("LeftShoulder"), true),
    ("LeftForeArm", Some("LeftArm"), true),
    ("LeftHand", Some("LeftForeArm"), true),
    ("LeftHandThumb1", Some("LeftHand"), false),
    ("LeftHandThumb2", Some("LeftHandThumb1"), false),
    ("LeftHandThumb3", Some("LeftHandThumb2"), false),
    ("LeftHandIndex1", Some("LeftHand"), false),
    ("LeftHandIndex2", Some("LeftHandIndex1"), false),
    ("LeftHandIndex3", Some("LeftHandIndex2"), false),
    ("LeftHandMiddle1", Some("LeftHand"), false),
    ("LeftHandMiddle2", Some("LeftHandMiddle1"), false),
    ("LeftHandMiddle3", Some("LeftHandMiddle2"), false),
    ("LeftHandRing1", Some("LeftHand"), false),
    ("LeftHandRing2", Some("LeftHandRing1"), false),
    ("LeftHandRing3", Some("LeftHandRing2"), false),
    ("LeftHandPinky1", Some("LeftHand"), false),
    ("LeftHandPinky2", Some("LeftHandPinky1"), false),
    ("LeftHandPinky3", Some("LeftHandPinky2"), false),
    ("LeftUpLeg", Some("Hips"), true),
    ("LeftLeg", Some("LeftUpLeg"), true),
    ("LeftFoot", Some("LeftLeg"), true),
    ("LeftToeBase", Some("LeftFoot"), false),
    ("RightShoulder", Some("Spine"), false),
    ("RightArm", Some("RightShoulder"), true),
    ("RightForeArm", Some("RightArm"), true),
    ("RightHand", Some("RightForeArm"), true),
    ("RightHandThumb1", Some("RightHand"), false),
    ("RightHandThumb2", Some("RightHandThumb1"), false),
    ("RightHandThumb3", Some("RightHandThumb2"), false),
    ("RightHandIndex1", Some("RightHand"), false),
    ("RightHandIndex2", Some("RightHandIndex1"), false),
    ("RightHandIndex3", Some("RightHandIndex2"), false),
    ("RightHandMiddle1", Some("RightHand"), false),
    ("RightHandMiddle2", Some("RightHandMiddle1"), false),
    ("RightHandMiddle3", Some("RightHandMiddle2"), false),
    ("RightHandRing1", Some("RightHand"), false),
    ("RightHandRing2", Some("RightHandRing1"), false),
    ("RightHandRing3", Some("RightHandRing2"), false),
    ("RightHandPinky1", Some("RightHand"), false),
    ("RightHandPinky2", Some("RightHandPinky1"), false),
    ("RightHandPinky3", Some("RightHandPinky2"), false),
    ("RightUpLeg", Some("Hips"), true),
    ("RightLeg", Some("RightUpLeg"), true),
    ("RightFoot", Some("RightLeg"), true),
    ("RightToeBase", Some("RightFoot"), false),
];

pub const COUNT: usize = BONES.len();
pub const RIG: &str = "gf-humanoid-1";

/// A humanoid bone's index (its place in `BONES`).
pub fn index(name: &str) -> Option<usize> {
    BONES.iter().position(|b| b.0 == name)
}
pub fn name(i: usize) -> &'static str {
    BONES.get(i).map(|b| b.0).unwrap_or("")
}
pub fn parent(i: usize) -> Option<usize> {
    BONES.get(i).and_then(|b| b.1).and_then(index)
}
pub fn required(i: usize) -> bool {
    BONES.get(i).is_some_and(|b| b.2)
}
pub fn is_canonical(name: &str) -> bool {
    index(name).is_some()
}

/// The nearest canonical ancestor of `i` for which `has` is true (rig.js `canonicalParent`).
pub fn canonical_parent(i: usize, has: impl Fn(usize) -> bool) -> Option<usize> {
    let mut p = parent(i);
    while let Some(x) = p {
        if has(x) {
            return Some(x);
        }
        p = parent(x);
    }
    None
}

/// Bones lined up with the standard's own direction (`SWING[bone] = the child that defines it`).
pub const SWING: [(&str, &str); 8] = [
    ("LeftArm", "LeftForeArm"),
    ("LeftForeArm", "LeftHand"),
    ("RightArm", "RightForeArm"),
    ("RightForeArm", "RightHand"),
    ("LeftUpLeg", "LeftLeg"),
    ("LeftLeg", "LeftFoot"),
    ("RightUpLeg", "RightLeg"),
    ("RightLeg", "RightFoot"),
];

pub fn swing_child(i: usize) -> Option<usize> {
    let n = name(i);
    SWING.iter().find(|s| s.0 == n).and_then(|s| index(s.1))
}

/// Bones that take their parent's swing: hands, feet, toes and every finger bone (rig.js `INHERIT`).
pub fn inherits(i: usize) -> bool {
    let n = name(i);
    matches!(n, "LeftHand" | "RightHand" | "LeftFoot" | "RightFoot" | "LeftToeBase" | "RightToeBase") || finger_of(i).is_some() || thumb_of(i)
}

fn thumb_of(i: usize) -> bool {
    let n = name(i);
    (n.starts_with("LeftHandThumb") || n.starts_with("RightHandThumb")) && n.len() > 13
}

/// A finger segment that is not the thumb: (the bone's index without its digit, the segment 1..=3) (rig.js `FINGER_SEG`).
pub fn finger_of(i: usize) -> Option<(&'static str, u32)> {
    let n = name(i);
    for side in ["Left", "Right"] {
        for f in ["Index", "Middle", "Ring", "Pinky"] {
            let stem_len = side.len() + 4 + f.len();
            if n.len() == stem_len + 1 && n.starts_with(side) && n[side.len()..].starts_with("Hand") && n[side.len() + 4..].starts_with(f) {
                let seg = n.as_bytes()[stem_len] - b'0';
                if (1..=3).contains(&seg) {
                    return Some((&n[..stem_len], seg as u32));
                }
            }
        }
    }
    None
}

/// The finger bone `stem` + `seg` ("LeftHandIndex", 2 → LeftHandIndex2).
pub fn finger(stem: &str, seg: u32) -> Option<usize> {
    BONES.iter().position(|b| b.0.len() == stem.len() + 1 && b.0.starts_with(stem) && b.0.as_bytes()[stem.len()] == b'0' + seg as u8)
}

/// A finger whose bone 1 sits nearer the wrist than this share of bone 2's distance starts inside the palm.
pub const PALM_FIRST: f32 = 0.45;

/// The upper body (overlay clips: aim, hit, interact, throw): everything but the hips, the lowest spine and the legs.
pub fn upper(i: usize) -> bool {
    let n = name(i);
    !(n == "Hips" || n == "Spine02" || n.ends_with("UpLeg") || n.ends_with("Leg") || n.ends_with("Foot") || n.ends_with("ToeBase"))
}

/// The spine bend chain (`gfSpineBend` damps it).
pub const SPINE: [&str; 5] = ["Spine02", "Spine01", "Spine", "neck", "Head"];

/// Sockets: name → bone (RIG.md §5).
pub const SOCKETS: [(&str, &str); 4] = [("head", "Head"), ("hand_r", "RightHand"), ("hand_l", "LeftHand"), ("back", "Spine")];

/// The ragdoll parts (RIG.md §6): [part, the bone it drives, the bones at its far end (first present wins), the part it
/// hangs from]. forge-core's `Part` enum follows this order (from 1).
pub const RAGDOLL: [(&str, &str, &[&str], Option<&str>); 11] = [
    ("pelvis", "Hips", &["Spine02", "Spine01", "Spine"], None),
    ("torso", "Spine", &["neck", "Head"], Some("pelvis")),
    ("head", "Head", &["head_end"], Some("torso")),
    ("upperarm_l", "LeftArm", &["LeftForeArm"], Some("torso")),
    ("forearm_l", "LeftForeArm", &["LeftHand"], Some("upperarm_l")),
    ("upperarm_r", "RightArm", &["RightForeArm"], Some("torso")),
    ("forearm_r", "RightForeArm", &["RightHand"], Some("upperarm_r")),
    ("thigh_l", "LeftUpLeg", &["LeftLeg"], Some("pelvis")),
    ("shin_l", "LeftLeg", &["LeftFoot"], Some("thigh_l")),
    ("thigh_r", "RightUpLeg", &["RightLeg"], Some("pelvis")),
    ("shin_r", "RightLeg", &["RightFoot"], Some("thigh_r")),
];

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_table_is_parents_first_and_matches_rig_js() {
        for (i, b) in BONES.iter().enumerate() {
            if let Some(p) = b.1 {
                assert!(index(p).unwrap() < i, "{} before its parent", b.0);
            }
        }
        let req: Vec<&str> = BONES.iter().filter(|b| b.2).map(|b| b.0).collect();
        assert_eq!(req, ["Hips", "Spine", "Head", "LeftArm", "LeftForeArm", "LeftHand", "LeftUpLeg", "LeftLeg", "LeftFoot", "RightArm", "RightForeArm", "RightHand", "RightUpLeg", "RightLeg", "RightFoot"]);
        assert_eq!(finger_of(index("RightHandPinky3").unwrap()), Some(("RightHandPinky", 3)));
        assert_eq!(finger_of(index("LeftHandThumb1").unwrap()), None, "the thumb is not a finger segment");
        assert!(inherits(index("LeftHandThumb2").unwrap()) && inherits(index("RightToeBase").unwrap()) && !inherits(index("LeftArm").unwrap()));
        assert_eq!(finger("LeftHandRing", 2), index("LeftHandRing2"));
        assert_eq!(swing_child(index("RightLeg").unwrap()), index("RightFoot"));
        assert!(upper(index("Spine01").unwrap()) && !upper(index("LeftLeg").unwrap()) && !upper(index("Spine02").unwrap()));
        // a missing optional bone hangs under its nearest present ancestor
        let has = |i: usize| ["Hips", "Spine", "Head"].contains(&name(i));
        assert_eq!(canonical_parent(index("Head").unwrap(), has), index("Spine"));
    }
}

/// The bone a ragdoll part (`RAGDOLL`'s name, forge-core's `Part::name`) hangs on: "head" → "Head". None for "body"
/// (the whole: the hips).
pub fn part_bone(part: &str) -> Option<&'static str> {
    RAGDOLL.iter().find(|r| r.0 == part).map(|r| r.1)
}
