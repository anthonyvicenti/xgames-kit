//! forge-ai's tests: the plugin's ways in, and the behaviours the fixtures measure in numbers.
use forge_core::cmd::Writer;
use forge_core::components::*;
use forge_core::glam::Vec3;
use forge_core::Core;

use super::*;

fn arena(tables: &str) -> Core {
    let mut c = Core::new();
    assert!(c.add_plugin(&AiPlugin));
    c.load_tables(tables).unwrap();
    let mut w = Writer::default();
    w.add_box([-50.0, -1.0, -50.0], [50.0, 0.0, 50.0]);
    w.spawn(1, 0.0, 0.05, 0.0, 0.0, true);
    c.cmds[..w.words.len()].copy_from_slice(&w.words);
    c.tick(0.0, w.words.len());
    c
}

fn run(c: &mut Core, secs: f32) {
    for _ in 0..(secs * 60.0) as usize {
        c.tick(1.0 / 60.0, 0);
    }
}

fn send(c: &mut Core, w: &Writer) {
    c.cmds[..w.words.len()].copy_from_slice(&w.words);
    c.tick(1.0 / 60.0, w.words.len());
}

#[test]
fn a_command_spawns_an_enemy_from_its_row_and_it_rises_closes_in_and_attacks() {
    let mut c = arena(r#"{"enemies":[{"id":"chaser"},{"id":"runner","archetype":"runner","health":20}]}"#);
    assert_eq!(c.sim.res.get::<Roster>().unwrap().defs[1].speed, 4.2);
    let mut w = Writer::default();
    w.opf(OP_SPAWN, &[1], &[0.0, 0.05, -12.0, 0.0]);
    send(&mut c, &w);
    let e = c.sim.entity_of(256).expect("the enemy has the first actor net id");
    assert_eq!(c.sim.world.get::<&Health>(e).unwrap().hp, 20.0);
    assert_eq!(c.sim.world.get::<&Kind>(e).unwrap().type_, 1);
    assert_eq!(c.sim.world.get::<&Enemy>(e).unwrap().state, State::Arrive);
    run(&mut c, 1.2);
    assert_eq!(c.sim.world.get::<&Enemy>(e).unwrap().state, State::Chase, "it rose and chases");
    run(&mut c, 3.0);
    let z = c.sim.world.get::<&Transform>(e).unwrap().pos.z;
    assert!(z > -1.5 && z < -0.2, "it closed in from 12 m and stopped at its reach ({z})");
    let p = c.player(1).unwrap();
    let h = c.sim.world.get::<&Health>(p).unwrap();
    assert!(h.hp + h.armor < 120.0, "and hit the player ({} + {})", h.hp, h.armor);
    drop(h);
    // a trace from the player finds it
    let hit = c.sim.trace(Vec3::new(0.0, 1.5, 0.0), Vec3::NEG_Z, 30.0, forge_core::physics::groups::WORLD | forge_core::physics::groups::ENEMY, c.player(1)).unwrap();
    assert_eq!(hit.entity, Some(e));
}

#[test]
fn the_director_runs_waves_with_rule_events_and_waits_for_a_reward() {
    let mut c = arena(r#"{"enemies":[{"id":"grunt","health":5}],"waves":[{"id":"a","enemies":[{"type":"grunt","count":3}],"delay":0.2,"spawnEvery":0.2,"reward":true},{"id":"b","enemies":[{"type":"grunt","count":2}]}]}"#);
    let mut rules: Vec<String> = Vec::new();
    let collect = |c: &Core, rules: &mut Vec<String>| {
        for ev in c.events_out.chunks(16) {
            if let Some((forge_core::events::Event::Rule(r), _)) = forge_core::events::Event::decode(ev.try_into().unwrap()) {
                rules.push(c.sim.names.get(r.name).to_string());
            }
        }
    };
    let mut w = Writer::default();
    w.op(OP_DIRECTOR, &[1, 0]);
    send(&mut c, &w);
    collect(&c, &mut rules);
    for _ in 0..90 {
        c.tick(1.0 / 60.0, 0);
        collect(&c, &mut rules);
    }
    let alive: Vec<_> = c.sim.world.query::<(forge_core::hecs::Entity, &Enemy)>().iter().map(|(e, _)| e).collect();
    assert_eq!(alive.len(), 3, "three rose ({rules:?})");
    for e in alive {
        c.sim.damage(e, 50.0, 1, None, Vec3::Z);
    }
    for _ in 0..30 {
        c.tick(1.0 / 60.0, 0);
        collect(&c, &mut rules);
    }
    assert!(rules.contains(&"wave-start".into()) && rules.contains(&"wave-clear".into()) && rules.contains(&"wave-reward".into()), "{rules:?}");
    assert_eq!(rules.iter().filter(|r| *r == "enemy-down").count(), 3);
    assert_eq!(c.sim.res.get::<director::Director>().unwrap().phase, director::Phase::Reward);
    // resume: the next wave
    let mut w = Writer::default();
    w.op(OP_DIRECTOR, &[2, 0]);
    send(&mut c, &w);
    assert_eq!(c.sim.res.get::<director::Director>().unwrap().wave, 1);
    assert_eq!(c.sim.res.get::<director::Director>().unwrap().phase, director::Phase::Running);
}

#[test]
fn the_ai_view_carries_eye_glow_and_state() {
    let mut c = arena(r##"{"enemies":[{"id":"grunt","eye":{"color":"#ff0000","glow":2.4}}]}"##);
    let e = spawn(&mut c.sim, 0, Vec3::new(0.0, 0.05, -6.0), 0.0, false);
    run(&mut c, 0.1);
    let v = c.sim.res.get::<view::AiView>().unwrap();
    assert_eq!(v.count, 1);
    let at = |f: usize| v.rows[f * view::CAPACITY];
    assert_eq!(at(view::field::NET) as u32, c.sim.net_of(e));
    assert!((at(view::field::EYE_R) - 1.0).abs() < 1e-5 && at(view::field::EYE_G) < 1e-5);
    assert!((at(view::field::EYE_I) - 2.4).abs() < 1e-4);
    assert_eq!(at(view::field::STATE) as u8, State::Chase as u8);
}

#[test]
fn every_fixture_in_fixtures_ai_meets_its_targets() {
    let dir = concat!(env!("CARGO_MANIFEST_DIR"), "/../../fixtures/ai");
    let mut names: Vec<_> = std::fs::read_dir(dir).expect("research/gf-forge/fixtures/ai").filter_map(|e| e.ok()).map(|e| e.path()).filter(|p| p.extension().is_some_and(|x| x == "json")).collect();
    names.sort();
    for p in names {
        let script: forge_core::serde_json::Value = forge_core::serde_json::from_str(&std::fs::read_to_string(&p).unwrap()).unwrap();
        // the cost measures are for a release build (`node research/gf-forge/tools/fixtures.mjs ai`), not a test build
        let mut core = Core::new();
        core.add_plugin(&AiPlugin);
        let o = fixture::run(&mut core, &script).unwrap();
        for m in &o.measured {
            if m.name.contains("cost") || m.unit == "µs" {
                continue;
            }
            assert_ne!(m.ok, Some(false), "{}: {} = {:?} {}, target {:?}", o.name, m.name, m.value, m.unit, m.target);
        }
    }
}

/// The crowd's animation cadence (anim.rs): an enemy's pose is evaluated every other step, a player's every step. On
/// the real grim lord and the forge clip file (anim-fixture.mjs writes them, decoded, to
/// ~/.cache/gf-forge/anim-fixture/forge; without them this test says so and passes).
#[test]
fn enemies_animate_every_other_step_and_players_every_step() {
    let dir = std::path::PathBuf::from(std::env::var("HOME").unwrap_or_default()).join(".cache/gf-forge/anim-fixture/forge");
    let (Ok(clips), Ok(body)) = (std::fs::read(dir.join("forge-clips.glb")), std::fs::read(dir.join("skeleton-grim-lord.glb"))) else {
        eprintln!("anim cadence: no fixture at {} (node research/gf-forge/tools/anim-fixture.mjs); skipped", dir.display());
        return;
    };
    let mut c = arena(r#"{"enemies":[{"id":"grunt","speed":0}]}"#);
    let set = c.sim.anim.library.add_clips(&clips).unwrap();
    let b = c.sim.anim.library.add_body(&body).unwrap();
    let e = spawn(&mut c.sim, 0, Vec3::new(0.0, 0.05, -6.0), 0.0, false);
    let p = c.player(1).unwrap();
    for x in [e, p] {
        c.sim.animate(x, b, set, None).unwrap();
        let lib = &c.sim.anim.library;
        let mut a = c.sim.world.get::<&mut forge_core::sim::Animated>(x).unwrap();
        a.animator.play(lib, "walk", forge_core::forge_anim::Play { fade: 0.0, looping: Some(true), ..Default::default() });
    }
    // steps one at a time: how often each one's palette changes
    let snap = |c: &Core, x| {
        let a = c.sim.world.get::<&forge_core::sim::Animated>(x).unwrap();
        c.sim.anim.poses.slice(a.base, a.count).to_vec()
    };
    c.tick(forge_core::STEP, 0);
    let (mut pe, mut pp) = (snap(&c, e), snap(&c, p));
    let (mut ne, mut np) = (0, 0);
    for _ in 0..20 {
        c.tick(forge_core::STEP, 0);
        let (se, sp) = (snap(&c, e), snap(&c, p));
        if se != pe {
            ne += 1;
        }
        if sp != pp {
            np += 1;
        }
        (pe, pp) = (se, sp);
    }
    assert_eq!(np, 20, "the player's pose every step");
    assert_eq!(ne, 10, "the enemy's every other step");
}

/// Endless (wave 6, `spec.forge.endless`; the creator, 2026-10-11: "Can we make the game endless with increasing
/// difficulty and increasing buffs they can choose. We can use the same boss over"): past the last wave the director
/// starts again at `from`, a lap more, and each lap the waves are bigger and their enemies tougher; the wave's number
/// as players count it goes on with no end, and the rewards come round again.
#[test]
fn endless_waves_go_round_from_the_wave_asked_and_grow_each_lap() {
    let mut c = arena(r#"{"enemies":[{"id":"grunt","health":5}],
        "waves":[{"id":"a","enemies":[{"type":"grunt","count":2}],"delay":0.1,"spawnEvery":0.05,"maxAlive":10},
                 {"id":"b","enemies":[{"type":"grunt","count":4}],"delay":0.1,"spawnEvery":0.05,"maxAlive":10,"reward":true}],
        "endless":{"on":true,"from":2,"grow":{"enemies":0.5,"health":1.0,"damage":0.5,"speed":0.1},"speedMost":1.15}}"#);
    let mut rules: Vec<(String, f32, f32)> = Vec::new();
    let collect = |c: &Core, rules: &mut Vec<(String, f32, f32)>| {
        for ev in c.events_out.chunks(16) {
            if let Some((forge_core::events::Event::Rule(r), _)) = forge_core::events::Event::decode(ev.try_into().unwrap()) {
                rules.push((c.sim.names.get(r.name).to_string(), r.a, r.b));
            }
        }
    };
    // clear what stands, wave after wave; resume each reward
    let clear_wave = |c: &mut Core, rules: &mut Vec<(String, f32, f32)>| -> (usize, Vec<f32>) {
        for _ in 0..60 {
            c.tick(1.0 / 60.0, 0);
            collect(c, rules);
        }
        let list: Vec<(forge_core::hecs::Entity, f32)> = c.sim.world.query::<(forge_core::hecs::Entity, &Enemy, &forge_core::components::Health)>().iter().filter(|(_, e, _)| e.state != State::Dead).map(|(e, _, h)| (e, h.max)).collect();
        let n = list.len();
        let hp: Vec<f32> = list.iter().map(|x| x.1).collect();
        for (e, _) in list {
            c.sim.damage(e, 1.0e6, 1, None, Vec3::Z);
        }
        for _ in 0..30 {
            c.tick(1.0 / 60.0, 0);
            collect(c, rules);
        }
        if c.sim.res.get::<director::Director>().unwrap().phase == director::Phase::Reward {
            let mut w = Writer::default();
            w.op(OP_DIRECTOR, &[2, 0]);
            send(c, &w);
            collect(c, rules);
        }
        (n, hp)
    };
    let mut w = Writer::default();
    w.op(OP_DIRECTOR, &[1, 0]);
    send(&mut c, &w);
    collect(&c, &mut rules);
    let (a1, hp_a1) = clear_wave(&mut c, &mut rules);   // wave 1: a, lap 0
    let (b1, _) = clear_wave(&mut c, &mut rules);       // wave 2: b, lap 0 (a reward after)
    let (b2, hp_b2) = clear_wave(&mut c, &mut rules);   // wave 3: b again (from 2), lap 1
    let (b3, _) = clear_wave(&mut c, &mut rules);       // wave 4: b, lap 2
    assert_eq!((a1, b1), (2, 4), "the first time through is the waves as written");
    assert_eq!(b2, 6, "lap 1: half as many again (4 × 1.5)");
    assert_eq!(b3, 8, "lap 2: twice as many (4 × 2)");
    assert!((hp_a1[0] - 5.0).abs() < 1e-4 && hp_b2.iter().all(|h| (h - 10.0).abs() < 1e-3), "lap 1's enemies have twice the health ({hp_a1:?} → {hp_b2:?})");
    let starts: Vec<(f32, f32)> = rules.iter().filter(|r| r.0 == "wave-start").map(|r| (r.1, r.2)).collect();
    assert_eq!(starts, vec![(1.0, 0.0), (2.0, 0.0), (3.0, 0.0), (4.0, 0.0), (5.0, 0.0)], "numbered with no end, and no last wave (b: 0)");
    assert_eq!(rules.iter().filter(|r| r.0 == "wave-reward").count(), 3, "the reward comes round with its wave");
    assert_eq!(rules.iter().filter(|r| r.0 == "lap").map(|r| r.1 as u32).collect::<Vec<_>>(), vec![1, 2, 3]);
    assert!(!rules.iter().any(|r| r.0 == "waves-done"), "an endless run is never done");
    let d = c.sim.res.get::<director::Director>().unwrap();
    assert_eq!((d.wave, d.lap, d.number), (1, 3, 5));
}

#[test]
fn without_endless_the_last_wave_still_ends_the_waves() {
    let mut c = arena(r#"{"enemies":[{"id":"grunt","health":5}],"waves":[{"id":"a","enemies":[{"type":"grunt","count":1}],"delay":0.1}]}"#);
    let mut w = Writer::default();
    w.op(OP_DIRECTOR, &[1, 0]);
    send(&mut c, &w);
    run(&mut c, 0.5);
    let list: Vec<forge_core::hecs::Entity> = c.sim.world.query::<(forge_core::hecs::Entity, &Enemy)>().iter().map(|(e, _)| e).collect();
    for e in list {
        c.sim.damage(e, 1.0e6, 1, None, Vec3::Z);
    }
    run(&mut c, 0.5);
    let d = c.sim.res.get::<director::Director>().unwrap();
    assert_eq!((d.phase, d.number, d.lap), (director::Phase::Done, 1, 0));
}
