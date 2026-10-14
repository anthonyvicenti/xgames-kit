//! A debugging aid (not a fixture): an idle kinematic body touched by a new dynamic body, then many bodies added and
//! removed, through forge-core's Physics, to find what keeps rapier 0.36's island checks (debug builds) quiet.
//!   cargo run -p forge-feel --example dbg-rapier -- <case> [keep]
use forge_core::glam::{Quat, Vec3};
use forge_core::hecs;
use forge_core::physics::{groups, Physics, Shape};

fn main() {
    let case = std::env::args().nth(1).unwrap_or_default();
    let keep = std::env::args().any(|a| a == "keep");
    // refresh (forge-core's detect_collisions) only before a step that follows no insert, as forge-feel now inserts
    let norefresh = std::env::args().any(|a| a == "norefresh");
    let mut p = Physics::new();
    let mut w = hecs::World::new();
    p.add_box(Vec3::new(-50.0, -1.0, -50.0), Vec3::new(50.0, 0.0, 50.0));
    let k = w.spawn(());
    let kb = p.add_kinematic(k, Shape::Capsule { half_height: 0.6, radius: 0.3 }, Vec3::new(0.0, 0.9, -4.0), Quat::IDENTITY, groups::ENEMY);
    for i in 0..200 {
        if keep {
            p.set_kinematic(&kb, Vec3::new(0.0, 0.9, -4.0), Quat::IDENTITY);
        }
        p.refresh();
        p.step();
        let _ = i;
    }
    println!("idle done");
    if case == "touch" || case.is_empty() {
        let d = w.spawn(());
        p.add_dynamic(d, Shape::Ball(0.05), Vec3::new(0.0, 0.9, -3.5), Quat::IDENTITY, Vec3::new(0.0, 0.0, -8.0), Vec3::ZERO, groups::DEBRIS, 400.0);
        for i in 0..60 {
            if keep {
                p.set_kinematic(&kb, Vec3::new(0.0, 0.9, -4.0), Quat::IDENTITY);
            }
            if !(norefresh && i == 0) {
                p.refresh();
            }
            p.step();
        }
        println!("touch done");
    }
    if case == "churn" || case.is_empty() {
        let mut live = Vec::new();
        for round in 0..6 {
            for i in 0..48 {
                let d = w.spawn(());
                let a = i as f32 * 0.7;
                let b = p.add_dynamic(d, Shape::Cuboid(Vec3::new(0.03, 0.03, 0.1)), Vec3::new(a.sin() * 0.3, 1.0 + (i % 5) as f32 * 0.1, a.cos() * 0.3), Quat::IDENTITY, Vec3::new(a.sin() * 4.0, 3.0, a.cos() * 4.0), Vec3::new(5.0, 2.0, 1.0), groups::DEBRIS, 450.0);
                live.push(b);
            }
            while live.len() > 100 {
                let b = live.remove(0);
                p.remove(&b);
            }
            for i in 0..40 {
                if !(norefresh && i == 0) {
                    p.refresh();
                }
                p.step();
            }
            println!("churn round {round} done");
        }
    }
}
