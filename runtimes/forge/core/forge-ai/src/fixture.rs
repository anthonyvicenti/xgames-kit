//! The AI fixture runner (research/gf-forge/fixtures/ai/*.json): an arena, players standing or walking, enemies, the
//! director and bots, run headless through the real core with forge-ai installed, a sample of every enemy every step,
//! and measures against the feel targets (research/rust-engine/feel-targets.md moment 13, target 9) and the budgets.
//!
//!   cargo run --release -p forge-ai --example ai-fixture -- research/gf-forge/fixtures/ai/<name>.json [--json] [--trace]
//!   node research/gf-forge/tools/fixtures.mjs ai
//!
//! A script:
//! ```json
//! { "name": "chaser", "frame": 0.016667, "seed": 7,
//!   "tables": { "enemies": [ { "id": "grunt" } ], "waves": [ … ] },     // the tables (over the defaults)
//!   "boxes": [[minx, miny, minz, maxx, maxy, maxz]],                      // static boxes (default: a 200 m floor)
//!   "arena": [minx, minz, maxx, maxz, cell], "mounds": [[x, y, z]],
//!   "players": [ { "id": 1, "at": [0, 0.05, 0], "yaw": 0, "health": 100000 } ],   // the first is the local one
//!   "bots": [ { "id": 2, "at": [2, 0.05, 0], "mode": "auto", "skill": 0.6 } ],
//!   "spawn": [ { "type": "grunt", "at": [0, 0.05, -8], "emerge": true } ],
//!   "script": [ { "for": 3.0, "mark": "go", "spawn": […], "director": "start", "move": { "1": [0, 1] },
//!                 "shoot": [ { "from": [x, y, z], "at": 0 | [x, y, z], "damage": 10, "by": 1, "every": 0.25 } ] } ],
//!   "measure": [ { "name": "…", "what": "stop_distance", "enemy": 0, "target": [0.8, 0.95], "unit": "m" } ] }
//! ```
//! `enemy` is the n-th enemy spawned (0 first) or a type id; times are marks ("go+1.5"). `shoot` is what a weapon does:
//! a trace through the hurt regions, the region's multiplier on the damage, `Sim::damage` with the trace.
//! Measures: stop_distance, tell_time, glow_rise, lunge_distance, lunge_time, lunge_dip, recover_time,
//! recover_distance, repeat, hit_damage, emerge_depth, emerge_hold, emerge_overshoot, emerge_time, speed,
//! time_to_speed, max_attackers, min_separation, overlap_share, reach_time, orb_speed, rule_count, event_count,
//! player_damage, enemy_health, state_at, phase, alive_at, ai_cost_mean_us, ai_cost_p99_us, ai_cost_max_us, bot_shots.
use std::collections::HashMap;

use forge_core::cmd::Writer;
use forge_core::components::*;
use forge_core::events::{self, Event};
use forge_core::fixture::Measured;
use forge_core::glam::{Vec2, Vec3};
use forge_core::physics::groups;
use forge_core::schedule::Stage;
use forge_core::serde_json::{self, Value};
use forge_core::sim::Sim;
use forge_core::{Core, STEP};

use crate::enemy::{h, BossBar, Enemy, State};
use crate::projectile::Orb;

#[derive(Clone, Debug)]
pub struct ESample {
    pub net: u32,
    pub row: u16,
    pub state: State,
    pub st: f32,
    pub pos: Vec3,
    pub eye: f32,
    pub offset: f32,
    pub speed: f32,
    pub dist: f32,
    pub target: u32,
    pub hp: f32,
    pub detours: u32,
    pub reemerged: u32,
}

#[derive(Clone, Debug)]
pub enum Ev {
    HitPlayer { attacker: u32, target: u32, damage: f32 },
    /// A rule event: its name, `a` and `d` (enemy-down: d is who killed it).
    Rule(String, f32, f32),
    Custom(u32),
}

#[derive(Clone, Debug, Default)]
pub struct Sample {
    pub t: f64,
    pub enemies: Vec<ESample>,
    pub orbs: Vec<(u32, Vec3)>,
    pub players: Vec<(u32, f32)>,
    pub events: Vec<Ev>,
    pub boss_phase: u8,
    pub cost_ns: u64,
    pub bot_shots: u32,
    /// Nanoseconds this step per timed system (crate::profile).
    pub systems: Vec<(&'static str, u64)>,
}

#[derive(Default)]
pub struct Trace {
    pub samples: Vec<Sample>,
}

pub struct Outcome {
    pub name: String,
    pub trace: Trace,
    pub marks: HashMap<String, f64>,
    pub measured: Vec<Measured>,
    /// Net ids in spawn order.
    pub order: Vec<u32>,
    pub types: Vec<(u32, String)>,
}

fn f(v: Option<&Value>, d: f64) -> f64 {
    v.and_then(Value::as_f64).filter(|x| x.is_finite()).unwrap_or(d)
}
fn v3(v: Option<&Value>, d: Vec3) -> Vec3 {
    v.and_then(Value::as_array).map(|a| Vec3::new(f(a.first(), d.x as f64) as f32, f(a.get(1), d.y as f64) as f32, f(a.get(2), d.z as f64) as f32)).unwrap_or(d)
}

/// The sampling system (Events stage, after everything).
fn sample(sim: &mut Sim) {
    let roster = sim.res.get::<crate::defs::Roster>();
    let players: Vec<(u32, Vec3, f32)> = sim.world.query::<(&Player, &Transform, &Health)>().iter().map(|(p, t, hp)| (p.id, t.pos, hp.hp + hp.armor)).collect();
    let pos_of = |net: u32| players.iter().find(|p| p.0 == net).map(|p| p.1);
    let enemies: Vec<ESample> = sim
        .world
        .query::<(&NetId, &Enemy, &Transform, &forge_core::physics::Mover, &Health)>()
        .iter()
        .map(|(n, en, t, m, hp)| ESample { net: n.0, row: en.row, state: en.state, st: en.t, pos: t.pos, eye: en.eye, offset: en.offset, speed: h(m.moved).length() / STEP, dist: pos_of(en.target_net).map(|p| h(p).distance(h(t.pos))).unwrap_or(f32::NAN), target: en.target_net, hp: hp.fraction(), detours: en.stuck.detours, reemerged: en.stuck.reemerged })
        .collect();
    let orbs: Vec<(u32, Vec3)> = sim.world.query::<(&NetId, &Orb, &Transform)>().iter().map(|(n, _, t)| (n.0, t.pos)).collect();
    let evs = Vec::new();
    let _ = roster;
    let boss_phase = sim.res.get::<BossBar>().map(|b| b.phase).unwrap_or(0);
    let bot_shots = sim.world.query::<&crate::bots::Bot>().iter().map(|b| b.shots).sum();
    // this step's time per system (the profiler adds up; the sampler takes the step's share and starts again)
    let p = sim.res.take::<crate::profile::Profile>();
    let ai_ms: f64 = p.ms.iter().filter(|(k, _)| k.starts_with("ai.")).map(|(_, v)| v).sum();
    let cost_ns = (ai_ms * 1e6) as u64;
    let systems: Vec<(&'static str, u64)> = p.ms.iter().map(|(k, v)| (*k, (v * 1e6) as u64)).collect();
    let t = sim.time.now;
    sim.res.entry::<Trace>().samples.push(Sample { t, enemies, orbs, players: players.iter().map(|p| (p.0, p.2)).collect(), events: evs, boss_phase, cost_ns, bot_shots, systems });
}

/// Shots queued for the next step (the fixture's stand-in for a weapon): from, at, damage, by.
#[derive(Default)]
struct Pending {
    shots: Vec<(Vec3, Vec3, f32, u32)>,
}

/// The bots' stand-in weapon: each fire press a trace along the bot's look for this much damage.
struct BotWeapon(f32);

/// The fixture's weapons, in the Feel stage where track F's hit: queued shots, and each bot's fire press.
fn weapons(sim: &mut Sim) {
    let shots = std::mem::take(&mut sim.res.entry::<Pending>().shots);
    let mut fire: Vec<(Vec3, Vec3, f32, u32, Option<forge_core::hecs::Entity>)> = shots.into_iter().map(|(from, at, d, by)| (from, (at - from).normalize_or_zero(), d, by, None)).collect();
    if let Some(dmg) = sim.res.get::<BotWeapon>().map(|b| b.0) {
        let eye = sim.tables.player.eye;
        for (e, p, c, t, l) in sim.world.query::<(forge_core::hecs::Entity, &Player, &Control, &Transform, &Look)>().with::<&crate::bots::Bot>().iter() {
            if c.pressed & forge_core::cmd::BTN_FIRE != 0 {
                let dir = Vec3::new(-l.yaw.sin() * l.pitch.cos(), l.pitch.sin(), -l.yaw.cos() * l.pitch.cos());
                fire.push((t.pos + Vec3::Y * eye, dir, dmg, p.id, Some(e)));
            }
        }
    }
    for (from, dir, dmg, by, me) in fire {
        if let Some(hit) = sim.trace(from, dir, 60.0, groups::WORLD | groups::ENEMY, me)
            && let Some(e) = hit.entity {
                sim.damage(e, dmg * hit.damage, by, Some(&hit), dir);
            }
    }
}

thread_local! {
    static START: std::time::Instant = std::time::Instant::now();
}
fn clock_ms() -> f64 {
    START.with(|s| s.elapsed().as_secs_f64() * 1000.0)
}

/// Time forge-ai's systems and the core's a crowd costs (crate::profile), every step (native).
pub fn time_systems(core: &mut Core) {
    crate::profile::install(core, clock_ms);
}

fn spawn_list(core: &mut Core, list: Option<&Value>, order: &mut Vec<u32>, types: &mut Vec<(u32, String)>) {
    for s in list.and_then(Value::as_array).cloned().unwrap_or_default() {
        let ty = s.get("type").and_then(Value::as_str).unwrap_or("");
        let row = core.sim.res.get::<crate::defs::Roster>().and_then(|r| r.row_of(ty)).unwrap_or(0);
        let at = v3(s.get("at"), Vec3::new(0.0, 0.05, -8.0));
        let emerge = s.get("emerge").and_then(Value::as_bool).unwrap_or(true);
        let count = f(s.get("count"), 1.0).max(1.0) as usize;
        let spread = f(s.get("spread"), 1.2) as f32;
        for k in 0..count {
            let off = if count > 1 { Vec3::new(((k % 6) as f32 - 2.5) * spread, 0.0, (k / 6) as f32 * -spread) } else { Vec3::ZERO };
            let e = crate::spawn(&mut core.sim, row, at + off, 0.0, emerge);
            let net = core.sim.net_of(e);
            order.push(net);
            types.push((net, ty.to_string()));
        }
    }
}

/// Run a script on a core with forge-ai installed.
pub fn run(core: &mut Core, script: &Value) -> Result<Outcome, String> {
    let name = script.get("name").and_then(Value::as_str).unwrap_or("ai").to_string();
    if let Some(t) = script.get("tables").filter(|t| t.is_object()) {
        core.load_tables(&t.to_string())?;
    } else {
        core.load_tables("{}")?;
    }
    time_systems(core);
    core.schedule.add(Stage::Events, "aifix.sample", sample);
    core.schedule.add(Stage::Feel, "aifix.weapons", weapons);
    let mut w = Writer::default();
    w.op(forge_core::cmd::SEED, &[f(script.get("seed"), 1.0) as u32, 0]);
    match script.get("boxes").and_then(Value::as_array) {
        Some(list) => {
            for b in list {
                let v: Vec<f32> = b.as_array().map(|a| a.iter().filter_map(|x| x.as_f64()).map(|x| x as f32).collect()).unwrap_or_default();
                if v.len() == 6 {
                    w.add_box([v[0], v[1], v[2]], [v[3], v[4], v[5]]);
                }
            }
        }
        None => {
            w.add_box([-100.0, -1.0, -100.0], [100.0, 0.0, 100.0]);
        }
    }
    if let Some(a) = script.get("arena").and_then(Value::as_array) {
        let v: Vec<f32> = a.iter().filter_map(|x| x.as_f64()).map(|x| x as f32).collect();
        if v.len() >= 4 {
            w.opf(crate::OP_ARENA, &[], &[v[0], v[1], v[2], v[3], *v.get(4).unwrap_or(&0.5)]);
        }
    }
    for m in script.get("mounds").and_then(Value::as_array).cloned().unwrap_or_default() {
        let p = v3(Some(&m), Vec3::ZERO);
        w.opf(crate::OP_MOUND, &[], &[p.x, p.y, p.z]);
    }
    let players = script.get("players").and_then(Value::as_array).cloned().unwrap_or_else(|| vec![serde_json::json!({ "id": 1, "at": [0, 0.05, 0] })]);
    for (i, p) in players.iter().enumerate() {
        let at = v3(p.get("at"), Vec3::new(0.0, 0.05, 0.0));
        w.spawn(f(p.get("id"), 1.0) as u32, at.x, at.y, at.z, f(p.get("yaw"), 0.0) as f32, i == 0);
    }
    let bots = script.get("bots").and_then(Value::as_array).cloned().unwrap_or_default();
    for b in &bots {
        let at = v3(b.get("at"), Vec3::new(2.0, 0.05, 0.0));
        w.spawn(f(b.get("id"), 2.0) as u32, at.x, at.y, at.z, 0.0, false);
    }
    core.cmds[..w.words.len()].copy_from_slice(&w.words);
    core.tick(0.0, w.words.len());
    for p in players.iter().chain(bots.iter()) {
        if let Some(hp) = p.get("health").and_then(Value::as_f64)
            && let Some(e) = core.player(f(p.get("id"), 1.0) as u32) {
                let _ = core.sim.world.insert_one(e, Health::new(hp as f32));
            }
    }
    let bot_cmd = |w: &mut Writer, b: &Value| {
        let mode = match b.get("mode").and_then(Value::as_str).unwrap_or("auto") {
            "seek" => 1,
            "flee" => 2,
            "wander" => 3,
            "idle" => 4,
            "fight" => 5,
            _ => 0,
        };
        let g = v3(b.get("goal"), Vec3::ZERO);
        w.opf(crate::OP_BOT, &[f(b.get("id"), 2.0) as u32, 1, mode, 0, 0, 0], &[f(b.get("skill"), 0.6) as f32, g.x, g.y, g.z, 0.8, 0.0, 0.0, 0.0]);
    };
    let mut order = Vec::new();
    let mut types = Vec::new();
    spawn_list(core, script.get("spawn"), &mut order, &mut types);
    let frame = f(script.get("frame"), 1.0 / 60.0).max(1e-4);
    let mut marks = HashMap::new();
    let mut shot_t: HashMap<usize, f64> = HashMap::new();
    if let Some(d) = script.get("botWeapon").and_then(Value::as_f64) {
        core.sim.res.insert(BotWeapon(d as f32));
    }
    for seg in script.get("script").and_then(Value::as_array).cloned().unwrap_or_default() {
        if let Some(m) = seg.get("mark").and_then(Value::as_str) {
            marks.insert(m.to_string(), core.sim.time.now);
        }
        spawn_list(core, seg.get("spawn"), &mut order, &mut types);
        let mut first = Writer::default();
        if let Some(d) = seg.get("director").and_then(Value::as_str) {
            let act = match d {
                "start" => 1,
                "resume" => 2,
                "skip" => 3,
                "pause" => 4,
                _ => 0,
            };
            first.op(crate::OP_DIRECTOR, &[act, f(seg.get("wave"), 0.0) as u32]);
        }
        if let Some(k) = seg.get("knock").and_then(Value::as_u64)
            && let Some(net) = order.get(k as usize) {
                first.opf(crate::OP_KNOCK, &[*net], &[0.0, 0.0, 1.0, 1.0]);
            }
        let dur = f(seg.get("for"), 0.0);
        let fr = f(seg.get("frame"), frame).max(1e-4);
        let moves: Vec<(u32, f32, f32)> = seg.get("move").and_then(Value::as_object).map(|o| o.iter().map(|(k, v)| (k.parse().unwrap_or(1), f(v.get(0), 0.0) as f32, f(v.get(1), 0.0) as f32)).collect()).unwrap_or_default();
        let shots = seg.get("shoot").and_then(Value::as_array).cloned().unwrap_or_default();
        let frames = ((dur / fr).round() as usize).max(if dur > 0.0 { 1 } else { 0 });
        for i in 0..frames {
            let mut w = if i == 0 { first.clone() } else { Writer::default() };
            for (id, mx, mz) in &moves {
                w.input(*id, *mx, *mz, 0.0, 0.0, 0, true, 0);
            }
            for b in &bots {
                bot_cmd(&mut w, b);
            }
            // a weapon's shot, queued for the next step's Feel stage (where track F's weapons hit): a trace through the
            // hurt regions, the region's multiplier, Sim::damage with the trace
            for (k, s) in shots.iter().enumerate() {
                let every = f(s.get("every"), 0.0);
                let last = shot_t.get(&k).copied().unwrap_or(-1e9);
                if (every <= 0.0 && i > 0) || core.sim.time.now - last < every - 1e-6 {
                    continue;
                }
                shot_t.insert(k, core.sim.time.now);
                let from = v3(s.get("from"), Vec3::new(0.0, 1.6, 0.0));
                let at = match s.get("at") {
                    Some(Value::Number(n)) => order.get(n.as_u64().unwrap_or(0) as usize).and_then(|net| core.sim.entity_of(*net)).and_then(|e| core.sim.world.get::<&Transform>(e).ok().map(|t| t.pos + Vec3::Y * 1.0)),
                    Some(Value::String(w)) if w == "nearest" => core.sim.world.query::<(&Enemy, &Transform, &Health)>().iter().filter(|(en, _, hp)| !hp.dead && en.state != State::Arrive).map(|(_, t, _)| t.pos + Vec3::Y * 1.0).min_by(|a, b| a.distance(from).total_cmp(&b.distance(from))),
                    other => Some(v3(other, Vec3::ZERO)),
                };
                if let Some(at) = at {
                    core.sim.res.entry::<Pending>().shots.push((from, at, f(s.get("damage"), 10.0) as f32, f(s.get("by"), 1.0) as u32));
                }
            }
            core.cmds[..w.words.len()].copy_from_slice(&w.words);
            core.tick(fr as f32, w.words.len());
            // what this tick emitted, commands' too (a director started by a command emits before any step)
            let evs: Vec<Ev> = core.events_out.chunks(events::WORDS).filter_map(|c| Event::decode(c.try_into().ok()?)).filter_map(|(e, _)| match e {
                Event::Hit(hh) if hh.target < forge_core::sim::FIRST_NET_ID => Some(Ev::HitPlayer { attacker: hh.attacker, target: hh.target, damage: hh.damage }),
                Event::Rule(r) => Some(Ev::Rule(core.sim.names.get(r.name).to_string(), r.a, r.d)),
                Event::Custom { kind, .. } => Some(Ev::Custom(kind)),
                _ => None,
            }).collect();
            if let Some(last) = core.sim.res.entry::<Trace>().samples.last_mut() {
                last.events.extend(evs);
            }
        }
    }
    let trace = core.sim.res.remove::<Trace>().unwrap_or_default();
    let defs: HashMap<u16, f32> = core.sim.res.get::<crate::defs::Roster>().map(|r| r.defs.iter().enumerate().map(|(i, d)| (i as u16, d.speed)).collect()).unwrap_or_default();
    let measured = script.get("measure").and_then(Value::as_array).map(|list| list.iter().map(|m| measure(m, &trace, &marks, &order, &types, &defs)).collect()).unwrap_or_default();
    Ok(Outcome { name, trace, marks, measured, order, types })
}

fn time_of(spec: Option<&Value>, marks: &HashMap<String, f64>) -> Option<f64> {
    let s = spec?.as_str()?;
    let (m, off) = match s.find(['+', '-']) {
        Some(i) => (&s[..i], s[i..].parse::<f64>().ok()?),
        None => (s, 0.0),
    };
    Some(marks.get(m)? + off)
}

fn pair(v: Option<&Value>) -> Option<(f64, f64)> {
    let a = v?.as_array()?;
    Some((a.first()?.as_f64()?, a.get(1)?.as_f64()?))
}

/// One measurement over the trace.
pub fn measure(m: &Value, trace: &Trace, marks: &HashMap<String, f64>, order: &[u32], types: &[(u32, String)], speeds: &HashMap<u16, f32>) -> Measured {
    let name = m.get("name").and_then(Value::as_str).unwrap_or("?").to_string();
    let unit = m.get("unit").and_then(Value::as_str).unwrap_or("").to_string();
    let target = pair(m.get("target"));
    let what = m.get("what").and_then(Value::as_str).unwrap_or("");
    let s = &trace.samples;
    let from = time_of(m.get("from"), marks).unwrap_or(f64::MIN);
    let to = time_of(m.get("to"), marks).unwrap_or(f64::MAX);
    let at = time_of(m.get("at"), marks);
    let net = match m.get("enemy") {
        Some(Value::Number(n)) => order.get(n.as_u64().unwrap_or(0) as usize).copied(),
        Some(Value::String(t)) => types.iter().find(|x| &x.1 == t).map(|x| x.0),
        _ => order.first().copied(),
    };
    let rows = |net: Option<u32>| -> Vec<(f64, ESample)> { s.iter().filter(|x| x.t >= from && x.t <= to).filter_map(|x| x.enemies.iter().find(|e| Some(e.net) == net).map(|e| (x.t, e.clone()))).collect() };
    let mine = rows(net);
    let first_in = |st: State| mine.iter().position(|(_, e)| e.state == st);
    let run_of = |st: State| -> Option<(usize, usize)> {
        let a = first_in(st)?;
        let b = mine[a..].iter().position(|(_, e)| e.state != st).map(|k| a + k).unwrap_or(mine.len());
        Some((a, b))
    };
    let hits_by = |net: Option<u32>| -> Vec<(f64, f32)> { s.iter().filter(|x| x.t >= from && x.t <= to).flat_map(|x| x.events.iter().filter_map(move |e| if let Ev::HitPlayer { attacker, damage, .. } = e { (Some(*attacker) == net).then_some((x.t, *damage)) } else { None })).collect() };
    let value: Option<f64> = match what {
        "stop_distance" => first_in(State::Tell).map(|k| mine[k].1.dist as f64),
        "tell_time" => run_of(State::Tell).map(|(a, b)| (b - a) as f64 * STEP as f64),
        "glow_rise" => first_in(State::Tell).and_then(|k| {
            let rest = mine[..k].last().map(|x| x.1.eye).unwrap_or(mine[k].1.eye);
            let top = mine[k..].iter().take_while(|x| matches!(x.1.state, State::Tell | State::Attack)).map(|x| x.1.eye).fold(0.0f32, f32::max);
            (rest > 0.0).then(|| (top / rest - 1.0) as f64)
        }),
        "glow_snap" => first_in(State::Recover).and_then(|k| {
            // the eyes back at rest on the step the hit lands (the first step of the recovery)
            let rest = mine[..first_in(State::Tell)?].last().map(|x| x.1.eye)?;
            Some((mine[k].1.eye / rest - 1.0).abs() as f64)
        }),
        "lunge_distance" => run_of(State::Attack).and_then(|(a, b)| mine.get(b).map(|end| h(end.1.pos).distance(h(mine[a].1.pos)) as f64)),
        "lunge_time" => run_of(State::Attack).map(|(a, b)| (b - a) as f64 * STEP as f64),
        "lunge_dip" => run_of(State::Attack).map(|(a, b)| -mine[a..b].iter().map(|x| x.1.offset).fold(0.0f32, f32::min) as f64),
        "recover_time" => run_of(State::Recover).map(|(a, b)| (b - a) as f64 * STEP as f64),
        "recover_distance" => run_of(State::Recover).map(|(_, b)| mine[b.saturating_sub(1)].1.dist as f64),
        "recover_back" => run_of(State::Recover).map(|(a, b)| (mine[b.saturating_sub(1)].1.dist - mine[a].1.dist) as f64),
        "contact_distance" => run_of(State::Recover).map(|(a, _)| mine[a].1.dist as f64),
        "repeat" => {
            let hs = hits_by(net);
            (hs.len() >= 2).then(|| hs[1].0 - hs[0].0)
        }
        "hit_damage" => hits_by(net).first().map(|x| x.1 as f64),
        "emerge_depth" => mine.first().map(|x| -x.1.offset as f64),
        "emerge_hold" => mine.first().map(|x0| {
            let d = x0.1.offset;
            mine.iter().take_while(|x| (x.1.offset - d).abs() < 1e-3).count() as f64 * STEP as f64
        }),
        "emerge_overshoot" => run_of(State::Arrive).map(|(a, b)| mine[a..b].iter().map(|x| x.1.offset).fold(f32::MIN, f32::max) as f64),
        "emerge_time" => run_of(State::Arrive).map(|(a, b)| (b - a) as f64 * STEP as f64),
        "speed" => at.and_then(|t| mine.iter().min_by(|a, b| (a.0 - t).abs().total_cmp(&(b.0 - t).abs()))).map(|x| x.1.speed as f64),
        "time_to_speed" => run_of(State::Arrive).and_then(|(_, b)| {
            let share = f(m.get("share"), 0.9) as f32;
            let top = speeds.get(&mine.get(b)?.1.row).copied().unwrap_or(3.3) * share;
            mine[b..].iter().find(|x| x.1.speed >= top).map(|x| x.0 - mine[b].0)
        }),
        "max_attackers" => s.iter().filter(|x| x.t >= from && x.t <= to).map(|x| {
            let mut per: HashMap<u32, u32> = HashMap::new();
            for e in &x.enemies {
                if matches!(e.state, State::Tell | State::Attack) {
                    *per.entry(e.target).or_default() += 1;
                }
            }
            per.values().copied().max().unwrap_or(0)
        }).max().map(|x| x as f64),
        "min_separation" => s.iter().filter(|x| x.t >= from && x.t <= to).filter_map(|x| {
            let act: Vec<Vec2> = x.enemies.iter().filter(|e| !matches!(e.state, State::Arrive | State::Dead)).map(|e| h(e.pos)).collect();
            let mut best = f32::MAX;
            for i in 0..act.len() {
                for j in i + 1..act.len() {
                    best = best.min(act[i].distance(act[j]));
                }
            }
            (best < f32::MAX).then_some(best)
        }).fold(None, |a: Option<f32>, b| Some(a.map_or(b, |a| a.min(b)))).map(|x| x as f64),
        "overlap_share" => {
            let within = f(m.get("within"), 0.6) as f32;
            let w: Vec<bool> = s.iter().filter(|x| x.t >= from && x.t <= to).map(|x| {
                let act: Vec<Vec2> = x.enemies.iter().filter(|e| !matches!(e.state, State::Arrive | State::Dead)).map(|e| h(e.pos)).collect();
                (0..act.len()).any(|i| (i + 1..act.len()).any(|j| act[i].distance(act[j]) < within))
            }).collect();
            (!w.is_empty()).then(|| w.iter().filter(|b| **b).count() as f64 / w.len() as f64)
        }
        "reach_time" => {
            let within = f(m.get("within"), 1.5) as f32;
            mine.iter().find(|x| x.1.dist <= within).map(|x| x.0 - from.max(mine.first().map(|y| y.0).unwrap_or(0.0)))
        }
        "orb_speed" => s.iter().find_map(|x| x.orbs.first().copied()).and_then(|first| {
            let pts: Vec<(f64, Vec3)> = s.iter().filter_map(|x| x.orbs.iter().find(|o| o.0 == first.0).map(|o| (x.t, o.1))).collect();
            if pts.len() >= 4 {
                let (a, b) = (pts[0], pts[pts.len().min(13) - 1]);
                Some((b.1 - a.1).length() as f64 / (b.0 - a.0))
            } else {
                None
            }
        }),
        "rule_count" => {
            let rule = m.get("rule").and_then(Value::as_str).unwrap_or("");
            Some(s.iter().filter(|x| x.t >= from && x.t <= to).flat_map(|x| x.events.iter()).filter(|e| matches!(e, Ev::Rule(n, ..) if n == rule)).count() as f64)
        }
        "event_count" => {
            let k = f(m.get("kind"), 0.0) as u32;
            Some(s.iter().filter(|x| x.t >= from && x.t <= to).flat_map(|x| x.events.iter()).filter(|e| matches!(e, Ev::Custom(c) if *c == k)).count() as f64)
        }
        "player_damage" => {
            let id = f(m.get("player"), 1.0) as u32;
            Some(s.iter().filter(|x| x.t >= from && x.t <= to).flat_map(|x| x.events.iter()).filter_map(|e| if let Ev::HitPlayer { target, damage, .. } = e { (*target == id).then_some(*damage as f64) } else { None }).sum())
        }
        "enemy_health" => at.and_then(|t| mine.iter().min_by(|a, b| (a.0 - t).abs().total_cmp(&(b.0 - t).abs()))).map(|x| x.1.hp as f64),
        "state_at" => at.and_then(|t| mine.iter().min_by(|a, b| (a.0 - t).abs().total_cmp(&(b.0 - t).abs()))).map(|x| x.1.state as u8 as f64),
        "phase" => at.and_then(|t| s.iter().min_by(|a, b| (a.t - t).abs().total_cmp(&(b.t - t).abs()))).map(|x| x.boss_phase as f64),
        "alive_at" => at.and_then(|t| s.iter().min_by(|a, b| (a.t - t).abs().total_cmp(&(b.t - t).abs()))).map(|x| x.enemies.iter().filter(|e| e.state != State::Dead).count() as f64),
        "ai_cost_mean_us" | "ai_cost_p99_us" | "ai_cost_max_us" => {
            let mut c: Vec<u64> = s.iter().filter(|x| x.t >= from && x.t <= to).map(|x| x.cost_ns).collect();
            if c.is_empty() {
                None
            } else {
                c.sort();
                Some(match what {
                    "ai_cost_mean_us" => c.iter().sum::<u64>() as f64 / c.len() as f64 / 1000.0,
                    "ai_cost_p99_us" => c[((c.len() as f64 * 0.99) as usize).min(c.len() - 1)] as f64 / 1000.0,
                    _ => *c.last().unwrap() as f64 / 1000.0,
                })
            }
        }
        "bot_shots" => s.iter().filter(|x| x.t <= to).last().map(|x| x.bot_shots as f64),
        "system_cost_us" => {
            // one system's mean time a step (native, release), e.g. "core.character"
            let sys = m.get("system").and_then(Value::as_str).unwrap_or("");
            let c: Vec<u64> = s.iter().filter(|x| x.t >= from && x.t <= to).map(|x| x.systems.iter().filter(|(k, _)| *k == sys).map(|(_, v)| *v).sum()).collect();
            (!c.is_empty()).then(|| c.iter().sum::<u64>() as f64 / c.len() as f64 / 1000.0)
        }
        "kills_by" => {
            // enemy-down rule events whose killer (d) is one of `by` (player ids)
            let by: Vec<f32> = m.get("by").and_then(Value::as_array).map(|a| a.iter().filter_map(|x| x.as_f64()).map(|x| x as f32).collect()).unwrap_or_default();
            Some(s.iter().filter(|x| x.t >= from && x.t <= to).flat_map(|x| x.events.iter()).filter(|e| matches!(e, Ev::Rule(n, _, d) if n == "enemy-down" && by.contains(d))).count() as f64)
        }
        "detours" => mine.last().map(|x| x.1.detours as f64),
        "reemerged" => mine.last().map(|x| x.1.reemerged as f64),
        "first_spawn" => s.iter().filter(|x| x.t >= from && x.t <= to).find(|x| !x.enemies.is_empty()).map(|x| x.t - from),
        "spawn_distance_min" | "spawn_distance_max" => {
            // each enemy's distance to its target the first step it is seen
            let mut seen: HashMap<u32, f32> = HashMap::new();
            for x in s.iter().filter(|x| x.t >= from && x.t <= to) {
                for e in &x.enemies {
                    if e.dist.is_finite() {
                        seen.entry(e.net).or_insert(e.dist);
                    }
                }
            }
            let v = seen.values().copied();
            if seen.is_empty() { None } else if what.ends_with("min") { Some(v.fold(f32::MAX, f32::min) as f64) } else { Some(v.fold(0.0f32, f32::max) as f64) }
        }
        "spawned" => {
            let mut seen: Vec<u32> = s.iter().filter(|x| x.t >= from && x.t <= to).flat_map(|x| x.enemies.iter().map(|e| e.net)).collect();
            seen.sort();
            seen.dedup();
            Some(seen.len() as f64)
        }
        _ => None,
    };
    // time budgets are judged in a release build only (a dev build's numbers say nothing about the kit's)
    let timed = what.starts_with("ai_cost") || what == "system_cost_us";
    let target = if timed && cfg!(debug_assertions) { None } else { target };
    let ok = match (value, target) {
        (Some(v), Some((lo, hi))) => Some(v >= lo && v <= hi),
        (None, Some(_)) => Some(false),
        _ => None,
    };
    Measured { name, value, unit, target, ok }
}

pub fn summary_json(o: &Outcome) -> Value {
    serde_json::json!({
        "name": o.name,
        "steps": o.trace.samples.len(),
        "pass": o.measured.iter().all(|m| m.ok != Some(false)),
        "measured": o.measured.iter().map(|m| serde_json::json!({ "name": m.name, "value": m.value, "unit": m.unit, "target": m.target.map(|t| [t.0, t.1]), "ok": m.ok })).collect::<Vec<_>>(),
    })
}

/// The trace as CSV: one line per enemy per step.
pub fn csv(t: &Trace) -> String {
    let mut out = String::from("t,net,state,st,x,z,eye,offset,speed,dist,target,hp\n");
    for s in &t.samples {
        for e in &s.enemies {
            out.push_str(&format!("{:.5},{},{},{:.4},{:.3},{:.3},{:.4},{:.4},{:.3},{:.3},{},{:.3}\n", s.t, e.net, e.state.name(), e.st, e.pos.x, e.pos.z, e.eye, e.offset, e.speed, e.dist, e.target, e.hp));
        }
    }
    out
}

/// The command line: `<script.json> [--trace] [--json]`. → the exit code (0 every target met, 1 one missed, 2 usage).
pub fn run_main(args: &[String]) -> i32 {
    let (mut path, mut trace, mut json) = (None, false, false);
    for a in args {
        match a.as_str() {
            "--trace" => trace = true,
            "--json" => json = true,
            s if !s.starts_with("--") => path = Some(s.to_string()),
            s => {
                eprintln!("ai-fixture: unknown option {s}");
                return 2;
            }
        }
    }
    let Some(path) = path else {
        eprintln!("usage: ai-fixture <script.json> [--trace] [--json]");
        return 2;
    };
    let script: Value = match std::fs::read_to_string(&path).map_err(|e| e.to_string()).and_then(|t| serde_json::from_str(&t).map_err(|e| e.to_string())) {
        Ok(v) => v,
        Err(e) => {
            eprintln!("ai-fixture: {path}: {e}");
            return 2;
        }
    };
    let mut core = Core::new();
    core.add_plugin(&crate::AiPlugin);
    let o = match run(&mut core, &script) {
        Ok(o) => o,
        Err(e) => {
            eprintln!("ai-fixture: {e}");
            return 2;
        }
    };
    if trace {
        print!("{}", csv(&o.trace));
    }
    if json {
        println!("{}", serde_json::to_string_pretty(&summary_json(&o)).unwrap_or_default());
    } else {
        println!("fixture {}: {} steps at {} Hz, {} enemies", o.name, o.trace.samples.len(), forge_core::HZ, o.order.len());
        for m in &o.measured {
            let v = m.value.map(|v| format!("{v:.3}")).unwrap_or_else(|| "none".into());
            let t = m.target.map(|(a, b)| format!(" (target {a}–{b})")).unwrap_or_default();
            let ok = match m.ok {
                Some(true) => "  ok",
                Some(false) => "  MISSED",
                None => "",
            };
            println!("  {:<34} {} {}{}{}", m.name, v, m.unit, t, ok);
        }
    }
    if o.measured.iter().any(|m| m.ok == Some(false)) { 1 } else { 0 }
}
