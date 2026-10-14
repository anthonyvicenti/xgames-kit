//! A debugging aid (not a fixture): walks a player on a flat floor (stand, walk, stop, strafe, turn, diagonal) and
//! counts the steps whose travel fell short of the velocity asked for (the character controller stalling), with or
//! without forge-feel, with any tables.
//!   DBG_TABLES='{"player":{"snap":0}}' cargo run -p forge-feel --example dbg-walk [core]
use std::cell::RefCell;
use std::rc::Rc;

use forge_core::cmd::Writer;
use forge_core::components::*;
use forge_core::glam::Vec2;
use forge_core::physics::Mover;
use forge_core::Core;

fn main() {
    let mut c = Core::new();
    let arg = std::env::args().nth(1).unwrap_or_default();
    if arg != "core" {
        c.add_plugin(&forge_feel::FeelPlugin);
    }
    let want: Rc<RefCell<Vec2>> = Rc::new(RefCell::new(Vec2::ZERO));
    let w1 = want.clone();
    c.schedule.add_before("core.character", "dbg.want", move |sim| {
        for (p, v) in sim.world.query::<(&Player, &Velocity)>().iter() {
            if p.local {
                *w1.borrow_mut() = Vec2::new(v.linear.x, v.linear.z);
            }
        }
    });
    let stalls = Rc::new(RefCell::new((0u32, 0u32, Vec::new())));
    let s2 = stalls.clone();
    let w2 = want.clone();
    c.schedule.add_after("core.character", "dbg.got", move |sim| {
        for (p, m) in sim.world.query::<(&Player, &Mover)>().iter() {
            if !p.local {
                continue;
            }
            let got = Vec2::new(m.moved.x, m.moved.z).length() / forge_core::STEP;
            let want = w2.borrow().length();
            let mut s = s2.borrow_mut();
            if want > 1.0 {
                s.1 += 1;
                if got < want * 0.8 {
                    s.0 += 1;
                    s.2.push((sim.time.step, got, want, m.moved.y));
                }
            }
        }
    });
    if let Ok(t) = std::env::var("DBG_TABLES") {
        c.load_tables(&t).unwrap();
    }
    let mut w = Writer::default();
    w.add_box([-100.0, -1.0, -100.0], [100.0, 0.0, 100.0]);
    w.spawn(1, 0.0, 0.05, 0.0, 0.0, true);
    c.cmds[..w.words.len()].copy_from_slice(&w.words);
    c.tick(0.0, w.words.len());
    for i in 0..600 {
        w.clear();
        let (mx, mz, dx) = match i {
            0..=29 => (0.0, 0.0, 0.0),
            30..=149 => (0.0, 1.0, 0.0),
            150..=199 => (0.0, 0.0, 0.0),
            200..=349 => (1.0, 0.0, 0.0),
            350..=449 => (0.0, 1.0, 0.02),
            _ => (-1.0, 1.0, 0.0),
        };
        w.input(1, mx, mz, dx, 0.0, 0, true, 0);
        c.cmds[..w.words.len()].copy_from_slice(&w.words);
        c.tick(1.0 / 60.0, w.words.len());
    }
    let s = stalls.borrow();
    println!("{} of {} moving steps fell short of the velocity (under 80%)", s.0, s.1);
    for (step, got, want, dy) in s.2.iter().take(12) {
        println!("  step {step}: travelled {got:.2} m/s of {want:.2}, dy {dy:.4}");
    }
}
