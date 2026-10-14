//! Wave 7, track E: elites (elite.rs; the creator, 2026-10-12, chose "Elite zombies"): the table held to the kit's,
//! lap and wave gating, the chance, the cap a wave, the boss left out, each modifier's effect, the burn's bites and
//! refresh, the fire on the ground, the split's young, and endless growth reaching what an enemy does each step.
use forge_core::cmd::Writer;
use forge_core::components::*;
use forge_core::glam::Vec3;
use forge_core::Core;

use crate::elite::{self, EliteState, Elites, Mod, CHILD};
use crate::*;

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
    for _ in 0..(secs * 60.0).round() as usize {
        c.tick(1.0 / 60.0, 0);
    }
}

fn send(c: &mut Core, w: &Writer) {
    c.cmds[..w.words.len()].copy_from_slice(&w.words);
    c.tick(1.0 / 60.0, w.words.len());
}

/// The Rust defaults equal the kit's (research/gf-forge/kit/tables/defaults.json → elites, written by
/// `node research/gf-forge/tools/tables.mjs --write`).
#[test]
fn elites_defaults_equal_the_kits() {
    let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../../kit/tables/defaults.json");
    let v: forge_core::serde_json::Value = forge_core::serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
    let row = forge_core::tables::Row(v.get("elites").and_then(|e| e.as_object()).expect("defaults.json has elites (tables.mjs --write)").clone());
    assert_eq!(Elites::from_row(&row), Elites::default(), "the kit's elites (left) and Elites::default (right) differ");
}

const ELITE_TABLES: &str = r#"{"enemies":[{"id":"grunt","health":30},{"id":"lord","archetype":"boss","health":100}],
    "waves":[{"id":"a","enemies":[{"type":"grunt","count":40},{"type":"lord","count":1}],"delay":0.0,"spawnEvery":0.0,"maxAlive":60,"boss":true}],
    "endless":{"on":true,"from":1,"grow":{"enemies":0,"alive":0,"health":0,"damage":0,"speed":0}},
    "elites":{"on":true,"lap":1,"chance":0.5,"grow":0.1,"chanceMost":0.6,"perWave":100}}"#;

/// Start the director at wave `wave` (0-based) of lap `lap` and let its arrivals rise. → every enemy's (row, mark).
fn rise_wave(c: &mut Core, wave: u32, lap: u32) -> Vec<(u16, u8)> {
    let mut w = Writer::default();
    w.op(OP_DIRECTOR, &[1, wave, lap]);
    send(c, &w);
    run(c, 0.6);
    c.sim.world.query::<&Enemy>().iter().map(|e| (e.row, e.mark)).collect()
}

#[test]
fn elites_rise_from_their_lap_at_their_chance_and_never_as_the_boss() {
    let mut c = arena(ELITE_TABLES);
    let first = rise_wave(&mut c, 0, 0);
    assert_eq!(first.len(), 41, "the wave rose ({})", first.len());
    assert!(first.iter().all(|e| e.1 == 0), "the first time through: no elite");
    let lap1 = rise_wave(&mut c, 0, 1);
    let grunts: Vec<_> = lap1.iter().filter(|e| e.0 == 0).collect();
    let elites = grunts.iter().filter(|e| e.1 != 0).count();
    assert!((12..=28).contains(&elites), "lap 1: about half of 40 grunts are elites at chance 0.5 ({elites})");
    assert!(lap1.iter().filter(|e| e.0 == 1).all(|e| e.1 == 0), "the boss is never an elite by default");
    let mods: std::collections::HashSet<u8> = grunts.iter().map(|e| e.1 & 7).filter(|m| *m != 0).collect();
    assert_eq!(mods.len(), 4, "every modifier comes up ({mods:?})");
    // the chance grows a lap and stops at its most: lap 3 is 0.5 + 0.1 × 2 = 0.7, held to 0.6
    assert!((c.sim.res.get::<Roster>().unwrap().elites.chance_at(3) - 0.6).abs() < 1e-6);
    // a wave holds at most `perWave`
    let mut c = arena(&ELITE_TABLES.replace(r#""perWave":100"#, r#""perWave":3"#));
    let capped = rise_wave(&mut c, 0, 2);
    assert_eq!(capped.iter().filter(|e| e.1 != 0).count(), 3, "at most perWave a wave");
    // from a wave as players count it, before the lap: `wave` 3 with `lap` 99 (one wave a lap here: lap 1 is wave 2)
    let mut c = arena(&ELITE_TABLES.replace(r#""lap":1,"#, r#""lap":99,"wave":3,"#));
    assert!(rise_wave(&mut c, 0, 1).iter().all(|e| e.1 == 0), "wave 2: not yet");
    assert!(rise_wave(&mut c, 0, 2).iter().any(|e| e.1 != 0), "wave 3 on: elites");
    // the boss may be one when the table says so
    let e = Elites { boss: true, ..Elites::default() };
    assert!(e.allows(&defs::Def::base(Arch::Boss)) && !Elites::default().allows(&defs::Def::base(Arch::Boss)));
    // a kind not named is never one
    let only = Elites { kinds: vec!["other".into()], ..Elites::default() };
    assert!(!only.allows(&c.sim.res.get::<Roster>().unwrap().def(0)));
}

#[test]
fn the_same_seed_raises_the_same_elites() {
    let marks = |seed: u32| {
        let mut c = arena(ELITE_TABLES);
        let mut w = Writer::default();
        w.op(forge_core::cmd::SEED, &[seed, 0]);
        send(&mut c, &w);
        let mut v = rise_wave(&mut c, 0, 1);
        v.sort();
        v
    };
    assert_eq!(marks(7), marks(7), "the host's seeded dice decide");
    assert_ne!(marks(7), marks(8));
}

/// An enemy of `row` standing at `at` (no rise), an elite with modifier `m` (0: an ordinary one). → its entity.
fn elite_at(c: &mut Core, row: u32, m: u32, at: Vec3) -> forge_core::hecs::Entity {
    let before: Vec<u32> = c.sim.world.query::<(&NetId, &Enemy)>().iter().map(|(n, _)| n.0).collect();
    let mut w = Writer::default();
    w.opf(OP_SPAWN, &[row, 1, m], &[at.x, at.y, at.z, 0.0]);
    send(c, &w);
    let net = c.sim.world.query::<(&NetId, &Enemy)>().iter().map(|(n, _)| n.0).find(|n| !before.contains(n)).expect("spawned");
    c.sim.entity_of(net).unwrap()
}

#[test]
fn an_armoured_elite_takes_its_share_of_a_hit_and_is_knocked_about_less() {
    let t = r#"{"enemies":[{"id":"grunt","health":30,"speed":0}],"elites":{"on":true}}"#;
    let mut c = arena(t);
    let plain = elite_at(&mut c, 0, 0, Vec3::new(-3.0, 0.05, -8.0));
    let iron = elite_at(&mut c, 0, Mod::Armoured as u32, Vec3::new(3.0, 0.05, -8.0));
    assert_eq!(c.sim.world.get::<&Enemy>(iron).unwrap().mark, Mod::Armoured as u8);
    assert_eq!(c.sim.world.get::<&Health>(iron).unwrap().max, 45.0, "an elite's health × 1.5");
    let a = c.sim.damage(plain, 10.0, 1, None, Vec3::Z);
    let b = c.sim.damage(iron, 10.0, 1, None, Vec3::Z);
    assert_eq!((a.damage, b.damage), (10.0, 5.0), "the armoured one takes half of the same hit");
    // what staggers, downs and flinches it: an ordinary one staggers at a hit of 0.35 of its most, the armoured one at
    // 1.0 (÷ 0.35); downs at 0.6 → 1.71; its flinch spring × 0.35
    {
        let r = c.sim.res.get::<Roster>().unwrap();
        let p = r.of(&c.sim.world.get::<&Enemy>(plain).unwrap()).into_owned();
        let q = r.of(&c.sim.world.get::<&Enemy>(iron).unwrap()).into_owned();
        assert!((q.stagger_at - p.stagger_at / 0.35).abs() < 1e-5 && (q.knock_at - p.knock_at / 0.35).abs() < 1e-5, "{} → {}", p.stagger_at, q.stagger_at);
        assert!((q.spring - p.spring * 0.35).abs() < 1e-5);
    }
    run(&mut c, 0.1);
    // a flying piece's knock: down for its seconds, the armoured one for 0.35 of them
    let mut w = Writer::default();
    w.opf(OP_KNOCK, &[c.sim.net_of(iron)], &[0.0, 0.0, 1.0, 1.0]);
    send(&mut c, &w);
    c.tick(forge_core::STEP, 0);
    let en = *c.sim.world.get::<&Enemy>(iron).unwrap();
    assert_eq!(en.state, State::Down);
    assert!((en.hold_for - 0.35).abs() < 1e-4, "down for {} s", en.hold_for);
}

#[test]
fn a_fast_elite_moves_and_attacks_faster() {
    let mut c = arena(r#"{"enemies":[{"id":"grunt","health":30}],"elites":{"on":true}}"#);
    let plain = elite_at(&mut c, 0, 0, Vec3::new(-1.0, 0.05, -14.0));
    let quick = elite_at(&mut c, 0, Mod::Fast as u32, Vec3::new(1.0, 0.05, -14.0));
    {
        let r = c.sim.res.get::<Roster>().unwrap();
        let p = r.of(&c.sim.world.get::<&Enemy>(plain).unwrap()).into_owned();
        let q = r.of(&c.sim.world.get::<&Enemy>(quick).unwrap()).into_owned();
        assert!((q.speed - p.speed * 1.45).abs() < 1e-4, "speed {} → {}", p.speed, q.speed);
        assert!((q.windup - p.windup / 1.35).abs() < 1e-5 && (q.cooldown - p.cooldown / 1.35).abs() < 1e-5 && (q.recover - p.recover / 1.35).abs() < 1e-5);
    }
    let z = |c: &Core, e| c.sim.world.get::<&Transform>(e).unwrap().pos.z;
    run(&mut c, 1.5);
    let (dp, dq) = (z(&c, plain) + 14.0, z(&c, quick) + 14.0);
    assert!(dq > dp * 1.3, "in 1.5 s the fast one covered {dq:.2} m, the ordinary one {dp:.2} m");
}

#[test]
fn a_burning_elites_blow_sets_the_player_alight_and_the_burn_bites_and_refreshes() {
    let mut c = arena(r#"{"enemies":[{"id":"grunt","health":30,"damage":10}],"elites":{"on":true,"burning":{"dps":4,"seconds":2,"tick":0.5}}}"#);
    let p = c.player(1).unwrap();
    let hp = |c: &Core| {
        let h = c.sim.world.get::<&Health>(p).unwrap();
        h.hp + h.armor
    };
    // the burn alone: 4 a second for 2 s, a bite every 0.5 s → 4 bites of 2
    elite::ignite(&mut c.sim, p, 999, 4.0, 2.0);
    let before = hp(&c);
    run(&mut c, 3.0);
    {
        let st = c.sim.res.get::<EliteState>().unwrap();
        assert_eq!((st.bites, st.burned), (4, 8.0), "4 bites of 2 ({} bites, {} damage)", st.bites, st.burned);
        assert!(st.burns.is_empty(), "it went out");
    }
    assert!((before - hp(&c) - 8.0).abs() < 1e-3);
    // a new blow while burning starts its seconds again: lit at 0, again at 1.5 s → 3.5 s of burning, 7 bites
    let mut c = arena(r#"{"enemies":[{"id":"grunt"}],"elites":{"on":true,"burning":{"dps":4,"seconds":2,"tick":0.5}}}"#);
    let p = c.player(1).unwrap();
    elite::ignite(&mut c.sim, p, 999, 4.0, 2.0);
    run(&mut c, 1.5);
    elite::ignite(&mut c.sim, p, 999, 4.0, 2.0);
    assert_eq!(c.sim.res.get::<EliteState>().unwrap().ignitions, 1, "a refresh is not a new ignition");
    run(&mut c, 3.0);
    assert_eq!(c.sim.res.get::<EliteState>().unwrap().bites, 7, "refreshed: 3.5 s of burning");
    // a burning elite's own lunge sets alight; an ordinary one's does not
    let mut c = arena(r#"{"enemies":[{"id":"grunt","health":30,"damage":10}],"elites":{"on":true}}"#);
    elite_at(&mut c, 0, Mod::Burning as u32, Vec3::new(0.0, 0.05, -2.0));
    let mut lit = false;
    for _ in 0..240 {
        c.tick(1.0 / 60.0, 0);
        lit |= c.sim.res.get::<EliteState>().is_some_and(|s| !s.burns.is_empty());
    }
    assert!(lit, "its blow set the player alight");
    let mut c = arena(r#"{"enemies":[{"id":"grunt","health":30,"damage":10}],"elites":{"on":true}}"#);
    elite_at(&mut c, 0, 0, Vec3::new(0.0, 0.05, -2.0));
    run(&mut c, 4.0);
    assert!(c.sim.res.get::<EliteState>().is_none_or(|s| s.ignitions == 0), "an ordinary one's does not");
}

#[test]
fn a_burning_elite_leaves_fire_where_it_falls_that_burns_whoever_stands_in_it() {
    let mut c = arena(r#"{"enemies":[{"id":"grunt","health":30,"speed":0}],"elites":{"on":true,"burning":{"patch":{"seconds":2,"radius":1.5,"dps":6}}}}"#);
    let e = elite_at(&mut c, 0, Mod::Burning as u32, Vec3::new(0.0, 0.05, -1.0));
    c.sim.damage(e, 1.0e6, 1, None, Vec3::Z);
    run(&mut c, 0.1);
    {
        let st = c.sim.res.get::<EliteState>().unwrap();
        assert_eq!(st.patches.len(), 1, "fire where it fell");
        assert!(st.burns.iter().any(|b| b.id == 1), "the player standing in it burns");
    }
    run(&mut c, 3.5);
    let st = c.sim.res.get::<EliteState>().unwrap();
    assert!(st.patches.is_empty() && st.burns.is_empty(), "it burned out, and so did the player a second after");
    assert!((4..=7).contains(&st.bites), "{} bites", st.bites);
}

#[test]
fn a_splitting_elite_splits_into_two_smaller_ones_that_never_split_again() {
    let mut c = arena(r#"{"enemies":[{"id":"grunt","health":40,"speed":0,"score":10},{"id":"crawler","archetype":"runner","health":20}],"elites":{"on":true,"splitting":{"into":"","count":2,"health":0.35,"scale":0.7}}}"#);
    let e = elite_at(&mut c, 0, Mod::Splitting as u32, Vec3::new(0.0, 0.05, -8.0));
    let max = c.sim.world.get::<&Health>(e).unwrap().max;
    assert_eq!(max, 60.0);
    c.sim.damage(e, 1.0e6, 1, None, Vec3::Z);
    run(&mut c, 0.3);
    let kids: Vec<(forge_core::hecs::Entity, Enemy, Health, f32)> = c.sim.world.query::<(forge_core::hecs::Entity, &Enemy, &Health, &Transform)>().iter().filter(|(_, en, ..)| en.state != State::Dead).map(|(e, en, h, t)| (e, *en, *h, t.scale)).collect();
    assert_eq!(kids.len(), 2, "two crawled out");
    let base = c.sim.res.get::<Roster>().unwrap().def(0).scale;
    for (_, en, h, s) in &kids {
        assert_eq!(en.mark, CHILD, "a split one's young, no modifier of its own");
        assert!((h.max - 60.0 * 0.35).abs() < 1e-4, "35% of its most ({})", h.max);
        assert!((s - base * 0.7).abs() < 1e-5, "drawn at 0.7 (scale {s})");
    }
    assert_eq!(c.sim.res.get::<EliteState>().unwrap().splits, 1);
    // unhurt for a moment as they crawl out (the burst of the body they came from is not theirs to take)
    assert!(kids.iter().all(|k| k.2.invulnerable > 0.0));
    let blocked = c.sim.damage(kids[0].0, 5.0, 1, None, Vec3::Z);
    assert_eq!(blocked.damage, 0.0);
    run(&mut c, 0.2);
    for (e, ..) in kids {
        c.sim.damage(e, 1.0e6, 1, None, Vec3::Z);
    }
    run(&mut c, 0.3);
    assert_eq!(c.sim.world.query::<&Enemy>().iter().count(), 0, "they never split again");
    assert_eq!(c.sim.res.get::<EliteState>().unwrap().splits, 1);
    // into another kind, three of them
    let mut c = arena(r#"{"enemies":[{"id":"grunt","health":40,"speed":0},{"id":"crawler","archetype":"runner","health":20}],"elites":{"on":true,"splitting":{"into":"crawler","count":3}}}"#);
    let e = elite_at(&mut c, 0, Mod::Splitting as u32, Vec3::new(0.0, 0.05, -8.0));
    c.sim.damage(e, 1.0e6, 1, None, Vec3::Z);
    run(&mut c, 0.3);
    let rows: Vec<u16> = c.sim.world.query::<&Enemy>().iter().filter(|en| en.state != State::Dead).map(|en| en.row).collect();
    assert_eq!(rows, vec![1, 1, 1]);
}

#[test]
fn a_split_in_a_wave_is_counted_by_the_director() {
    let mut c = arena(r#"{"enemies":[{"id":"grunt","health":40,"speed":0}],"waves":[{"id":"a","enemies":[{"type":"grunt","count":1}],"delay":0.0}],"elites":{"on":true}}"#);
    let mut w = Writer::default();
    w.op(OP_ELITE, &[Mod::Splitting as u32, 1]);
    w.op(OP_DIRECTOR, &[1, 0]);
    send(&mut c, &w);
    run(&mut c, 1.5);
    let list: Vec<forge_core::hecs::Entity> = c.sim.world.query::<(forge_core::hecs::Entity, &Enemy)>().iter().map(|(e, _)| e).collect();
    assert_eq!(list.len(), 1);
    assert_eq!(c.sim.world.get::<&Enemy>(list[0]).unwrap().mark, Mod::Splitting as u8, "forced");
    c.sim.damage(list[0], 1.0e6, 1, None, Vec3::Z);
    run(&mut c, 0.3);
    {
        let d = c.sim.res.get::<director::Director>().unwrap();
        assert_eq!((d.total, d.phase), (3, director::Phase::Running), "the young are the wave's: it is not clear until they fall");
    }
    run(&mut c, 0.2);
    let kids: Vec<forge_core::hecs::Entity> = c.sim.world.query::<(forge_core::hecs::Entity, &Enemy)>().iter().filter(|(_, e)| e.state != State::Dead).map(|(e, _)| e).collect();
    for e in kids {
        c.sim.damage(e, 1.0e6, 1, None, Vec3::Z);
    }
    run(&mut c, 0.3);
    assert_ne!(c.sim.res.get::<director::Director>().unwrap().phase, director::Phase::Running, "then it is cleared");
}

/// Wave 6's endless growth reaches what an enemy does each step (its damage and speed), not only its health.
#[test]
fn a_later_laps_enemies_hit_harder_and_move_faster_each_step() {
    let mut c = arena(r#"{"enemies":[{"id":"grunt","health":10,"damage":10,"speed":3}],
        "waves":[{"id":"a","enemies":[{"type":"grunt","count":1}],"delay":0.0}],
        "endless":{"on":true,"grow":{"enemies":0,"health":1.0,"damage":0.5,"speed":0.1},"speedMost":1.5}}"#);
    let one = rise_wave(&mut c, 0, 2);
    assert_eq!(one.len(), 1);
    let e = c.sim.world.query::<(forge_core::hecs::Entity, &Enemy)>().iter().map(|(e, _)| e).next().unwrap();
    let r = c.sim.res.get::<Roster>().unwrap();
    let d = r.of(&c.sim.world.get::<&Enemy>(e).unwrap()).into_owned();
    assert_eq!((d.health, d.damage), (30.0, 20.0), "lap 2: health ×3, damage ×2");
    assert!((d.speed - 3.6).abs() < 1e-5, "speed × 1.2 ({})", d.speed);
}

/// The rule events rules.js hears: `elite` for each elite raised (the first of its modifier a run says so), and a
/// split's young.
#[test]
fn an_elite_is_said_once_first_and_its_young_are_said_too() {
    let mut c = arena(r#"{"enemies":[{"id":"grunt","health":40,"speed":0}],"elites":{"on":true}}"#);
    let mut rules: Vec<(String, u32, f32, f32, f32, f32)> = Vec::new();
    let collect = |c: &Core, rules: &mut Vec<(String, u32, f32, f32, f32, f32)>| {
        for ev in c.events_out.chunks(16) {
            if let Some((forge_core::events::Event::Rule(r), _)) = forge_core::events::Event::decode(ev.try_into().unwrap()) {
                rules.push((c.sim.names.get(r.name).to_string(), r.entity, r.a, r.b, r.c, r.d));
            }
        }
    };
    let a = elite_at(&mut c, 0, Mod::Splitting as u32, Vec3::new(0.0, 0.05, -8.0));
    collect(&c, &mut rules);
    elite_at(&mut c, 0, Mod::Splitting as u32, Vec3::new(3.0, 0.05, -8.0));
    collect(&c, &mut rules);
    c.sim.damage(a, 1.0e6, 1, None, Vec3::Z);
    for _ in 0..20 {
        c.tick(1.0 / 60.0, 0);
        collect(&c, &mut rules);
    }
    let elites: Vec<_> = rules.iter().filter(|r| r.0 == "elite").collect();
    assert_eq!(elites.len(), 4, "{rules:?}");
    assert_eq!((elites[0].2, elites[0].4), (3.0, 1.0), "the first splitting one: first");
    assert_eq!(elites[1].4, 0.0, "the second: not");
    assert!(elites[2..].iter().all(|r| r.2 == 0.0 && r.5 == 1.0), "the young");
    assert_eq!(rules.iter().filter(|r| r.0 == "elite-split").count(), 1);
}
