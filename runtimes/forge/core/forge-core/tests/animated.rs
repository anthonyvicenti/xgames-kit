//! An animated enemy in the core: a library body on gf-humanoid-1 playing the standard clips, its hurt regions on its
//! bones, its bones in the pose buffer and the entities view, a trace at its head landing on the head.
//!
//! Uses the forge-anim fixture (decoded library GLBs, outside git): `node research/gf-forge/tools/anim-fixture.mjs`
//! writes ~/.cache/gf-forge/anim-fixture (or $GF_ANIM_FIXTURE). Without it this test says so and passes.
use std::path::PathBuf;

use forge_core::components::*;
use forge_core::glam::Vec3;
use forge_core::physics::groups;
use forge_core::views::{entity, MAX_ENTITIES};
use forge_core::Core;

#[test]
fn an_animated_enemy_is_hit_where_its_bones_are() {
    let dir = std::env::var("GF_ANIM_FIXTURE").map(PathBuf::from).unwrap_or_else(|_| PathBuf::from(std::env::var("HOME").unwrap_or_default()).join(".cache/gf-forge/anim-fixture"));
    let (Ok(clips), Ok(body)) = (std::fs::read(dir.join("clips.glb")), std::fs::read(dir.join("quaternius-casual-man.glb"))) else {
        eprintln!("skipped: no fixture at {} (node research/gf-forge/tools/anim-fixture.mjs writes it)", dir.display());
        return;
    };
    let mut c = Core::new();
    let set = c.sim.anim.library.add_clips(&clips).unwrap();
    let b = c.sim.anim.library.add_body(&body).unwrap();
    let e = c.sim.spawn_actor(kind::ENEMY, 0, Vec3::new(0.0, 0.0, -6.0), 0.0);
    c.sim.world.insert_one(e, Health::new(50.0)).unwrap();
    c.sim.animate(e, b, set, Some(groups::ENEMY)).unwrap();
    {
        let lib = &c.sim.anim.library;
        let mut a = c.sim.world.get::<&mut forge_core::sim::Animated>(e).unwrap();
        assert!(a.animator.play(lib, "idle", forge_core::forge_anim::Play::default()));
    }
    c.tick(1.0 / 60.0, 0);
    let n = c.sim.anim.library.bodies[b].joints.len();
    assert_eq!(c.sim.anim.poses.len(), n, "one matrix per joint");
    // the entities view says where its bones are
    let net = c.sim.net_of(e) as f32;
    let row = (0..c.views.entity_count).find(|&i| c.views.entities[entity::NET * MAX_ENTITIES + i] == net).unwrap();
    assert_eq!(c.views.entities[entity::BONE_COUNT * MAX_ENTITIES + row], n as f32);
    assert_ne!(c.views.entities[entity::FLAGS * MAX_ENTITIES + row] as u32 & entity::FLAG_ANIMATED, 0);
    // eleven ragdoll-part capsules on its bones, the head among them
    let hb: Hurtbox = (*c.sim.world.get::<&Hurtbox>(e).unwrap()).clone();
    assert_eq!(hb.regions.len(), 11);
    let head = hb.regions.iter().position(|r| r.part == Part::Head).unwrap();
    let (a, bb) = hb.world[head];
    let head_at = (a + bb) * 0.5;
    assert!(head_at.y > 1.3 && head_at.y < 2.0 && (head_at.z + 6.0).abs() < 0.5, "the head capsule sits on the head ({head_at})");
    // a trace at the head from 6 m away lands on the head, critical
    let eye = Vec3::new(head_at.x, head_at.y, 0.0);
    let hit = c.sim.trace(eye, head_at - eye, 20.0, groups::WORLD | groups::ENEMY, None).unwrap();
    assert_eq!((hit.entity, hit.part, hit.crit), (Some(e), Part::Head, true));
    // and one at the belly lands lower on the body
    let low = c.sim.trace(Vec3::new(0.0, 0.95, 0.0), Vec3::NEG_Z, 20.0, groups::WORLD | groups::ENEMY, None).unwrap();
    assert!(matches!(low.part, Part::Pelvis | Part::Torso | Part::ForearmL | Part::ForearmR), "{:?}", low.part);
    let dealt = c.sim.damage(e, 10.0 * hit.damage, 1, Some(&hit), Vec3::NEG_Z);
    assert_eq!(dealt.damage, 20.0, "the head doubles the damage");
}
