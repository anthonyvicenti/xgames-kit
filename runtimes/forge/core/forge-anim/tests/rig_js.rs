//! forge-anim against rig.js (PLAN §2: "forge skinning must match rig.js on a fixture"): library bodies posed through
//! the gf-humanoid-1 clips by forge-anim must put every canonical bone where the kit's own rig.js puts it.
//!
//! The fixture lives outside git (decoded GLBs and rig.js's poses): `node research/gf-forge/tools/anim-fixture.mjs`
//! writes it to ~/.cache/gf-forge/anim-fixture (or $GF_ANIM_FIXTURE). Without it this test says so and passes.
use std::path::PathBuf;

use forge_anim::glam::{Quat, Vec3};
use forge_anim::*;

fn fixture_dir() -> PathBuf {
    std::env::var("GF_ANIM_FIXTURE").map(PathBuf::from).unwrap_or_else(|_| PathBuf::from(std::env::var("HOME").unwrap_or_default()).join(".cache/gf-forge/anim-fixture"))
}

fn v3(v: &serde_json::Value) -> Vec3 {
    let a: Vec<f32> = v.as_array().unwrap().iter().map(|x| x.as_f64().unwrap() as f32).collect();
    Vec3::new(a[0], a[1], a[2])
}

#[test]
fn library_bodies_pose_as_rig_js_poses_them() {
    let dir = fixture_dir();
    let Ok(text) = std::fs::read_to_string(dir.join("rig-js.json")) else {
        eprintln!("skipped: no fixture at {} (node research/gf-forge/tools/anim-fixture.mjs writes it)", dir.display());
        return;
    };
    let rec: serde_json::Value = serde_json::from_str(&text).unwrap();
    let clips = std::fs::read(dir.join("clips.glb")).unwrap();
    let bodies = rec["bodies"].as_array().unwrap();
    assert!(!bodies.is_empty());
    let mut worst_pos: (f32, String) = (0.0, String::new());
    let mut worst_rot: (f32, String) = (0.0, String::new());
    let mut compared = 0;
    for b in bodies {
        let name = b["name"].as_str().unwrap();
        let mut lib = Library::default();
        let s = lib.add_clips(&clips).unwrap();
        let body = lib.add_body(&std::fs::read(dir.join(b["file"].as_str().unwrap())).unwrap()).unwrap_or_else(|e| panic!("{name}: {e}"));
        let mut an = lib.animator(body, s).unwrap_or_else(|e| panic!("{name}: {e}"));
        assert!(!an.is_direct(), "{name} is retargeted");
        let rt = lib.retarget(body, s).unwrap();
        assert!((rt.k - b["k"].as_f64().unwrap() as f32).abs() < 1e-3, "{name}: leg scale {} vs rig.js {}", rt.k, b["k"]);
        assert!((rt.ground - b["ground"].as_f64().unwrap() as f32).abs() < 1e-3, "{name}: ground {} vs rig.js {}", rt.ground, b["ground"]);
        let mut shifted: Vec<String> = rt.shifted.clone();
        let mut want: Vec<String> = b["shifted"].as_array().unwrap().iter().map(|x| x.as_str().unwrap().to_string()).collect();
        shifted.sort();
        want.sort();
        assert_eq!(shifted, want, "{name}: the fingers that start in the palm");
        let mut poses = PoseBuffer::default();
        poses.resize(an.bone_count(&lib));
        for p in b["poses"].as_array().unwrap() {
            let clip = p["clip"].as_str().unwrap();
            let t = p["t"].as_f64().unwrap() as f32;
            an.stop(Layer::Base);
            assert!(an.play(&lib, clip, Play { fade: 0.0, layer: Some(Layer::Base), looping: Some(false), ..Play::default() }), "{clip}");
            an.base.as_mut().unwrap().time = t;
            an.evaluate(&lib, &mut poses, 0);
            for (bone, want) in p["bones"].as_object().unwrap() {
                let Some(j) = lib.bone(body, bone) else { panic!("{name}: forge-anim has no {bone}") };
                let (_, q, pos) = poses.world[j].to_scale_rotation_translation();
                let dp = pos.distance(v3(&want["p"]));
                let wq = want["q"].as_array().unwrap().iter().map(|x| x.as_f64().unwrap() as f32).collect::<Vec<_>>();
                let wq = Quat::from_xyzw(wq[0], wq[1], wq[2], wq[3]).normalize();
                let dr = q.normalize().angle_between(wq);
                let at = format!("{name} {clip}@{t:.3} {bone}");
                if dp > worst_pos.0 {
                    worst_pos = (dp, at.clone());
                }
                if dr > worst_rot.0 {
                    worst_rot = (dr, at.clone());
                }
                compared += 1;
            }
        }
    }
    eprintln!("compared {compared} bone poses; worst position {:.5} m ({}), worst rotation {:.4} rad ({})", worst_pos.0, worst_pos.1, worst_rot.0, worst_rot.1);
    assert!(worst_pos.0 < 0.002, "a bone is {} m from where rig.js puts it ({})", worst_pos.0, worst_pos.1);
    assert!(worst_rot.0 < 0.01, "a bone is turned {} rad from rig.js ({})", worst_rot.0, worst_rot.1);
}
