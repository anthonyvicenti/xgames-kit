//! The native fixture runner (ARCHITECTURE.md "Fixtures"): scripted input through the real core, headless, with a
//! trace of every fixed step and measurements against targets, so feel numbers (research/rust-engine/feel-targets.md)
//! are checked in milliseconds without a browser.
//!
//!   cargo run -p forge-core --example fixture -- research/gf-forge/fixtures/core/walk.json [--trace] [--json] [--tables <game.json>]
//!
//! A script (JSON):
//! ```json
//! { "name": "walk", "about": "…", "tables": { "player": { … } }, "spawn": [0, 0.05, 0], "yaw": 0, "frame": 0.016667,
//!   "boxes": [[-100, -1, -100, 100, 0, 100]],
//!   "script": [ { "for": 0.5 }, { "mark": "go", "for": 1.5, "move": [0, 1] }, { "mark": "jump", "press": ["jump"], "for": 1.2 } ],
//!   "measure": [ { "name": "walk speed", "what": "speed", "at": "go+1.2", "target": [7.8, 8.0], "unit": "m/s" } ] }
//! ```
//! - `tables`: over the defaults (Rust's equal the kit's); `--tables` reads a game's `config/game.json → forge` first.
//! - `boxes`: static boxes `[minx, miny, minz, maxx, maxy, maxz]` (default: a 200 m floor at y 0).
//! - each script segment runs `for` seconds of frames of `frame` seconds (a segment may set its own `frame`: a stall);
//!   `move` [x, z] holds the stick; `hold` holds buttons; `press` presses them on the segment's first frame; `look`
//!   [dx, dy] radians on its first frame; `mark` names the segment's start.
//! - `measure`, each `what` (the times are from the mark; "go+1.2" is 1.2 s after "go"):
//!   `speed` (horizontal, from the travel in one step, at `at`) · `time_to_speed` (until speed ≥ `share` × `of`, `of`
//!   a number or "walk") · `time_to_below` (until speed < `share` × the speed at the mark) · `apex` (the most height
//!   gained within `window` s) · `apex_time` · `air_time` (from leaving the ground to landing) · `distance` (horizontal,
//!   `from` → `to`) · `sim_time` (simulated seconds `from` → `to`) · `events` (how many of `kind`, a `MOTION_*` name
//!   like "step" or an event kind like "sound", `from` → `to`) · `interval` (the mean seconds between them).
//!
//! Plugins (forge-feel, forge-ai) run the same scripts with their systems installed: `run_main(args, install)` from
//! their own `examples/fixture.rs`, and add measures by reading `Trace` themselves.
use std::collections::HashMap;

use glam::{Vec2, Vec3};
use serde_json::Value;

use crate::cmd::{self, Writer};
use crate::components::*;
use crate::events::{self, Event};
use crate::physics::Mover;
use crate::schedule::Stage;
use crate::{Core, STEP};

/// One fixed step of the local player, as the fixture saw it after the step.
#[derive(Clone, Debug, Default)]
pub struct Sample {
    pub step: u64,
    pub t: f64,
    pub pos: Vec3,
    pub vel: Vec3,
    /// Horizontal speed from the step's actual travel (what a camera shows), m/s.
    pub speed: f32,
    pub grounded: bool,
    /// The events of the step: (kind, MOTION_* for motion events, else 0).
    pub events: Vec<(u32, u32)>,
}

/// Every step's sample (a resource the fixture's `fixture.sample` system fills).
#[derive(Default, Debug)]
pub struct Trace {
    pub samples: Vec<Sample>,
}

/// A measurement and how it compared.
#[derive(Clone, Debug)]
pub struct Measured {
    pub name: String,
    pub value: Option<f64>,
    pub unit: String,
    pub target: Option<(f64, f64)>,
    pub ok: Option<bool>,
}

pub struct Outcome {
    pub name: String,
    pub trace: Trace,
    pub marks: HashMap<String, f64>,
    pub measured: Vec<Measured>,
}

fn button(name: &str) -> u32 {
    match name {
        "jump" => cmd::BTN_JUMP,
        "sprint" => cmd::BTN_SPRINT,
        "fire" => cmd::BTN_FIRE,
        "alt" => cmd::BTN_ALT,
        "melee" => cmd::BTN_MELEE,
        "evade" => cmd::BTN_EVADE,
        "reload" => cmd::BTN_RELOAD,
        "interact" => cmd::BTN_INTERACT,
        "next" => cmd::BTN_NEXT,
        "prev" => cmd::BTN_PREV,
        "crouch" => cmd::BTN_CROUCH,
        s if s.starts_with("slot") => s[4..].parse::<u32>().ok().filter(|n| (1..=4).contains(n)).map(|n| cmd::BTN_SLOT1 << (n - 1)).unwrap_or(0),
        _ => 0,
    }
}

fn buttons(v: Option<&Value>) -> u32 {
    v.and_then(Value::as_array).map(|a| a.iter().filter_map(Value::as_str).map(button).fold(0, |x, b| x | b)).unwrap_or(0)
}

fn f(v: Option<&Value>, d: f64) -> f64 {
    v.and_then(Value::as_f64).filter(|x| x.is_finite()).unwrap_or(d)
}

fn pair(v: Option<&Value>) -> Option<(f64, f64)> {
    let a = v?.as_array()?;
    Some((a.first()?.as_f64()?, a.get(1)?.as_f64()?))
}

/// Sample the local player after every step (installed by `run`).
fn sample(sim: &mut crate::sim::Sim) {
    let step = sim.time.step;
    let t = sim.time.now;
    let evs: Vec<(u32, u32)> = sim.events.step_events().map(|e| (e.kind(), if let Event::Motion(m) = e { m.what } else { 0 })).collect();
    let row = sim.world.query::<(&Player, &Transform, &Velocity, &Mover)>().iter().find(|(p, ..)| p.local).map(|(_, tr, v, m)| Sample { step, t, pos: tr.pos, vel: v.linear, speed: Vec2::new(m.moved.x, m.moved.z).length() / STEP, grounded: m.grounded, events: evs.clone() });
    if let Some(s) = row {
        sim.res.entry::<Trace>().samples.push(s);
    }
}

/// Run a script on `core` (plugins already installed): the world, the player, the frames, then the measures.
pub fn run(core: &mut Core, script: &Value, tables: Option<&str>) -> Result<Outcome, String> {
    let name = script.get("name").and_then(Value::as_str).unwrap_or("fixture").to_string();
    if let Some(t) = tables {
        core.load_tables(t)?;
    }
    if let Some(t) = script.get("tables").filter(|t| t.is_object()) {
        // over what is loaded: a shallow merge per table
        let mut base: serde_json::Map<String, Value> = core.sim.tables.raw.0.clone();
        for (k, v) in t.as_object().unwrap() {
            match (base.get_mut(k), v) {
                (Some(Value::Object(b)), Value::Object(o)) => {
                    for (kk, vv) in o {
                        b.insert(kk.clone(), vv.clone());
                    }
                }
                _ => {
                    base.insert(k.clone(), v.clone());
                }
            }
        }
        core.load_tables(&Value::Object(base).to_string())?;
    }
    core.schedule.add(Stage::Events, "fixture.sample", sample);
    let mut w = Writer::default();
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
    let sp: Vec<f32> = script.get("spawn").and_then(Value::as_array).map(|a| a.iter().filter_map(|x| x.as_f64()).map(|x| x as f32).collect()).unwrap_or_default();
    let at = Vec3::new(*sp.first().unwrap_or(&0.0), *sp.get(1).unwrap_or(&0.05), *sp.get(2).unwrap_or(&0.0));
    w.spawn(1, at.x, at.y, at.z, f(script.get("yaw"), 0.0) as f32, true);
    core.cmds[..w.words.len()].copy_from_slice(&w.words);
    core.tick(0.0, w.words.len());
    let frame = f(script.get("frame"), 1.0 / 60.0).max(1e-4);
    let mut marks = HashMap::new();
    let mut clock = 0.0f64;
    for seg in script.get("script").and_then(Value::as_array).cloned().unwrap_or_default() {
        if let Some(m) = seg.get("mark").and_then(Value::as_str) {
            marks.insert(m.to_string(), core.sim.time.now);
        }
        let dur = f(seg.get("for"), 0.0);
        let fr = f(seg.get("frame"), frame).max(1e-4);
        let mv = seg.get("move").and_then(Value::as_array).map(|a| (f(a.first(), 0.0) as f32, f(a.get(1), 0.0) as f32)).unwrap_or((0.0, 0.0));
        let hold = buttons(seg.get("hold"));
        let press = buttons(seg.get("press"));
        let look = seg.get("look").and_then(Value::as_array).map(|a| (f(a.first(), 0.0) as f32, f(a.get(1), 0.0) as f32)).unwrap_or((0.0, 0.0));
        let frames = ((dur / fr).round() as usize).max(if dur > 0.0 { 1 } else { 0 });
        for i in 0..frames {
            let first = i == 0;
            w.clear();
            let (dx, dy) = if first { look } else { (0.0, 0.0) };
            w.input(1, mv.0, mv.1, dx, dy, hold | if first { press } else { 0 }, true, if first { press | hold } else { 0 });
            core.cmds[..w.words.len()].copy_from_slice(&w.words);
            core.tick(fr as f32, w.words.len());
            clock += fr;
        }
    }
    let _ = clock;
    let trace = core.sim.res.remove::<Trace>().unwrap_or_default();
    let walk = core.sim.tables.player.walk as f64;
    let measured = script.get("measure").and_then(Value::as_array).map(|list| list.iter().map(|m| measure(m, &trace, &marks, walk)).collect()).unwrap_or_default();
    Ok(Outcome { name, trace, marks, measured })
}

fn time_of(spec: Option<&Value>, marks: &HashMap<String, f64>) -> Option<f64> {
    let s = spec?.as_str()?;
    let (m, off) = match s.find(['+', '-']) {
        Some(i) => (&s[..i], s[i..].parse::<f64>().ok()?),
        None => (s, 0.0),
    };
    Some(marks.get(m)? + off)
}

fn kind_of(name: &str) -> (u32, u32) {
    match name {
        "step" => (events::MOTION, events::MOTION_STEP),
        "jump" => (events::MOTION, events::MOTION_JUMP),
        "land" => (events::MOTION, events::MOTION_LAND),
        "fell" => (events::MOTION, events::MOTION_FELL),
        "bump" => (events::MOTION, events::MOTION_BUMP),
        "evade" => (events::MOTION, events::MOTION_EVADE),
        "hit" => (events::HIT, 0),
        "kill" => (events::KILL, 0),
        "spawn" => (events::SPAWN, 0),
        "despawn" => (events::DESPAWN, 0),
        "sound" => (events::SOUND, 0),
        "light" => (events::LIGHT, 0),
        "particles" => (events::PARTICLES, 0),
        "camera" => (events::CAMERA, 0),
        "ui" => (events::UI, 0),
        "rule" => (events::RULE, 0),
        _ => (0, 0),
    }
}

/// One measurement over the trace.
pub fn measure(m: &Value, trace: &Trace, marks: &HashMap<String, f64>, walk: f64) -> Measured {
    let name = m.get("name").and_then(Value::as_str).unwrap_or("?").to_string();
    let unit = m.get("unit").and_then(Value::as_str).unwrap_or("").to_string();
    let target = pair(m.get("target"));
    let what = m.get("what").and_then(Value::as_str).unwrap_or("");
    let s = &trace.samples;
    let from = time_of(m.get("from"), marks);
    let to = time_of(m.get("to"), marks);
    let after = |t0: f64| s.iter().filter(move |x| x.t > t0 + 1e-9);
    let window = f(m.get("window"), 2.0);
    let value: Option<f64> = match what {
        "speed" => {
            let at = time_of(m.get("at"), marks);
            at.and_then(|t| s.iter().min_by(|a, b| (a.t - t).abs().total_cmp(&(b.t - t).abs()))).map(|x| x.speed as f64)
        }
        "time_to_speed" => {
            let of = match m.get("of") {
                Some(Value::Number(n)) => n.as_f64().unwrap_or(walk),
                _ => walk,
            };
            let share = f(m.get("share"), 0.9);
            from.and_then(|t0| after(t0).find(|x| x.speed as f64 >= share * of).map(|x| x.t - t0))
        }
        "time_to_below" => {
            let share = f(m.get("share"), 0.1);
            from.and_then(|t0| {
                let start = s.iter().rev().find(|x| x.t <= t0 + 1e-9)?.speed as f64;
                after(t0).find(|x| (x.speed as f64) < share * start).map(|x| x.t - t0)
            })
        }
        "apex" | "apex_time" => from.and_then(|t0| {
            let y0 = s.iter().rev().find(|x| x.t <= t0 + 1e-9)?.pos.y as f64;
            let top = after(t0).take_while(|x| x.t <= t0 + window).max_by(|a, b| a.pos.y.total_cmp(&b.pos.y))?;
            Some(if what == "apex" { top.pos.y as f64 - y0 } else { top.t - t0 })
        }),
        "air_time" => from.and_then(|t0| {
            let left = after(t0).find(|x| !x.grounded)?;
            let landed = after(left.t).find(|x| x.grounded)?;
            // the step it left the ground started one step earlier
            Some(landed.t - (left.t - STEP as f64))
        }),
        "distance" => match (from, to) {
            (Some(a), Some(b)) => {
                let p = |t: f64| s.iter().min_by(|x, y| (x.t - t).abs().total_cmp(&(y.t - t).abs())).map(|x| x.pos);
                match (p(a), p(b)) {
                    (Some(pa), Some(pb)) => Some(Vec2::new(pb.x - pa.x, pb.z - pa.z).length() as f64),
                    _ => None,
                }
            }
            _ => None,
        },
        "sim_time" => match (from, to) {
            (Some(a), Some(b)) => Some(b - a),
            _ => None,
        },
        "events" | "interval" => {
            let (k, sub) = kind_of(m.get("kind").and_then(Value::as_str).unwrap_or(""));
            let (a, b) = (from.unwrap_or(f64::MIN), to.unwrap_or(f64::MAX));
            let times: Vec<f64> = s.iter().filter(|x| x.t > a && x.t <= b).flat_map(|x| x.events.iter().filter(|e| e.0 == k && (sub == 0 || e.1 == sub)).map(move |_| x.t)).collect();
            if what == "events" {
                Some(times.len() as f64)
            } else if times.len() >= 2 {
                Some((times[times.len() - 1] - times[0]) / (times.len() - 1) as f64)
            } else {
                None
            }
        }
        _ => None,
    };
    let ok = match (value, target) {
        (Some(v), Some((lo, hi))) => Some(v >= lo - 1e-9 && v <= hi + 1e-9),
        (None, Some(_)) => Some(false),
        _ => None,
    };
    Measured { name, value, unit, target, ok }
}

/// The trace as CSV (one line a step).
pub fn csv(t: &Trace) -> String {
    let mut out = String::from("step,t,x,y,z,vx,vy,vz,speed,grounded,events\n");
    for s in &t.samples {
        let ev: Vec<String> = s.events.iter().map(|(k, w)| if *w > 0 { format!("{k}.{w}") } else { k.to_string() }).collect();
        out.push_str(&format!("{},{:.5},{:.4},{:.4},{:.4},{:.3},{:.3},{:.3},{:.3},{},{}\n", s.step, s.t, s.pos.x, s.pos.y, s.pos.z, s.vel.x, s.vel.y, s.vel.z, s.speed, s.grounded as u8, ev.join(" ")));
    }
    out
}

/// The summary as JSON.
pub fn summary_json(o: &Outcome) -> Value {
    serde_json::json!({
        "name": o.name,
        "steps": o.trace.samples.len(),
        "pass": o.measured.iter().all(|m| m.ok != Some(false)),
        "measured": o.measured.iter().map(|m| serde_json::json!({ "name": m.name, "value": m.value, "unit": m.unit, "target": m.target.map(|t| [t.0, t.1]), "ok": m.ok })).collect::<Vec<_>>(),
    })
}

/// The command line: `<script.json> [--trace] [--json] [--tables <config/game.json>]`; `install` adds plugins.
/// → the process exit code (0 every target met, 1 one missed, 2 bad usage).
pub fn run_main(args: &[String], install: impl Fn(&mut Core)) -> i32 {
    let mut script_path = None;
    let (mut trace, mut json, mut tables) = (false, false, None);
    let mut it = args.iter();
    while let Some(a) = it.next() {
        match a.as_str() {
            "--trace" => trace = true,
            "--json" => json = true,
            "--tables" => tables = it.next().cloned(),
            s if !s.starts_with("--") => script_path = Some(s.to_string()),
            s => {
                eprintln!("fixture: unknown option {s}");
                return 2;
            }
        }
    }
    let Some(path) = script_path else {
        eprintln!("usage: fixture <script.json> [--trace] [--json] [--tables <config/game.json>]");
        return 2;
    };
    let read = |p: &str| std::fs::read_to_string(p).map_err(|e| format!("{p}: {e}"));
    let script: Value = match read(&path).and_then(|t| serde_json::from_str(&t).map_err(|e| format!("{path}: {e}"))) {
        Ok(v) => v,
        Err(e) => {
            eprintln!("fixture: {e}");
            return 2;
        }
    };
    let tables_json = match tables.as_deref().map(read) {
        Some(Ok(t)) => {
            // a game's config/game.json (its `forge`), or a tables file itself
            let v: Value = serde_json::from_str(&t).unwrap_or(Value::Null);
            Some(v.get("forge").cloned().unwrap_or(v).to_string())
        }
        Some(Err(e)) => {
            eprintln!("fixture: {e}");
            return 2;
        }
        None => None,
    };
    let mut core = Core::new();
    install(&mut core);
    let o = match run(&mut core, &script, tables_json.as_deref()) {
        Ok(o) => o,
        Err(e) => {
            eprintln!("fixture: {e}");
            return 2;
        }
    };
    if trace {
        print!("{}", csv(&o.trace));
    }
    if json {
        println!("{}", serde_json::to_string_pretty(&summary_json(&o)).unwrap_or_default());
    } else {
        println!("fixture {}: {} steps at {} Hz", o.name, o.trace.samples.len(), crate::HZ);
        for m in &o.measured {
            let v = m.value.map(|v| format!("{v:.3}")).unwrap_or_else(|| "none".into());
            let t = m.target.map(|(a, b)| format!(" (target {a}–{b})")).unwrap_or_default();
            let ok = match m.ok {
                Some(true) => "  ok",
                Some(false) => "  MISSED",
                None => "",
            };
            println!("  {:<28} {} {}{}{}", m.name, v, m.unit, t, ok);
        }
    }
    if o.measured.iter().any(|m| m.ok == Some(false)) { 1 } else { 0 }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The core's own walk meets the measured feel targets (moments 5 and 6), through the fixture runner.
    #[test]
    fn the_core_fixtures_meet_their_targets() {
        let dir = concat!(env!("CARGO_MANIFEST_DIR"), "/../../fixtures/core");
        let mut names: Vec<_> = std::fs::read_dir(dir).expect("research/gf-forge/fixtures/core").filter_map(|e| e.ok()).map(|e| e.path()).filter(|p| p.extension().is_some_and(|x| x == "json")).collect();
        names.sort();
        assert!(names.len() >= 4, "{names:?}");
        for p in names {
            let script: Value = serde_json::from_str(&std::fs::read_to_string(&p).unwrap()).unwrap();
            let mut core = Core::new();
            let o = run(&mut core, &script, None).unwrap();
            assert!(!o.measured.is_empty(), "{p:?} measures nothing");
            for m in &o.measured {
                assert_ne!(m.ok, Some(false), "{}: {} = {:?} {}, target {:?}", o.name, m.name, m.value, m.unit, m.target);
            }
        }
    }
}
