//! Track C2's open point, measured on the real files: the forge clip file's `taunt` and `emerge_leap` lift a 2.6 m body's
//! hips so high its head reaches 4-5 m (research/gf-forge/library/README.md "Gaps"). With the root pinned
//! (`Play::max_rise`, what forge-ai plays every enemy clip with) the head stays near the body's height.
//!
//! The files are research/gf-forge/library's, meshopt-decoded by `node research/gf-forge/tools/anim-fixture.mjs` into
//! ~/.cache/gf-forge/anim-fixture/forge (outside git, like rig_js.rs's fixture); without them this test says so and passes.
use std::path::PathBuf;

use forge_anim::{Library, Play, PoseBuffer};

fn dir() -> PathBuf {
    std::env::var("GF_ANIM_FIXTURE").map(PathBuf::from).unwrap_or_else(|_| PathBuf::from(std::env::var("HOME").unwrap_or_default()).join(".cache/gf-forge/anim-fixture")).join("forge")
}

/// The highest the head goes (model space, the body's feet at 0) through `clip`, root as authored or pinned.
fn head_top(lib: &mut Library, body: usize, set: usize, clip: &str, pin: Option<f32>) -> f32 {
    let mut a = lib.animator(body, set).unwrap();
    a.pin_xz = true;
    assert!(a.play(lib, clip, Play { fade: 0.0, looping: Some(false), max_rise: pin, ..Play::default() }), "{clip} is in the clip file");
    let mut poses = PoseBuffer::default();
    poses.resize(a.bone_count(lib));
    let head = lib.bone(body, "Head").unwrap();
    let d = lib.sets[set].clips[lib.sets[set].clip(clip).unwrap()].duration;
    let mut top: f32 = f32::MIN;
    let mut t = 0.0;
    while t <= d {
        a.evaluate(lib, &mut poses, 0);
        top = top.max(poses.world[head].w_axis.y);
        a.advance(1.0 / 60.0);
        t += 1.0 / 60.0;
    }
    top
}

#[test]
fn the_lords_taunt_and_leap_stay_on_the_ground_with_the_root_pinned() {
    let (clips, lord) = (dir().join("forge-clips.glb"), dir().join("skeleton-grim-lord.glb"));
    let (Ok(c), Ok(b)) = (std::fs::read(&clips), std::fs::read(&lord)) else {
        eprintln!("boss_root: no fixture at {} (node research/gf-forge/tools/anim-fixture.mjs writes it); skipped", dir().display());
        return;
    };
    let mut lib = Library::default();
    let set = lib.add_clips(&c).unwrap();
    let body = lib.add_body(&b).unwrap();
    let height = lib.bodies[body].height;
    let rest = head_top(&mut lib, body, set, "idle_combat", None);
    for clip in ["taunt", "emerge_leap"] {
        let free = head_top(&mut lib, body, set, clip, None);
        let pinned = head_top(&mut lib, body, set, clip, Some(0.12));
        eprintln!("{clip}: head at most {free:.2} m as authored, {pinned:.2} m pinned (idle {rest:.2} m, body {height:.2} m)");
        assert!(free > height + 1.0, "{clip}: the authored clip hops high ({free} m), as track C2 found");
        assert!(pinned < height + 0.35, "{clip}: pinned, the head stays near the body's height ({pinned} m for a {height} m body)");
    }
}
