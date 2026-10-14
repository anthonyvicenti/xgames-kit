//! The feel fixture runner: scripted input through the real core with forge-feel installed, headless, sampling what a
//! player would see every frame (the camera view: eyes, pitch, FOV; the feel view) and every event every step, then
//! measuring against research/rust-engine/feel-targets.md (`node research/gf-forge/tools/fixtures.mjs feel`).
//!
//!   cargo run -p forge-feel --example feel-fixture -- research/gf-forge/fixtures/feel/<name>.json [--trace] [--json]
//!
//! A script is the core's (forge_core::fixture: `tables`, `boxes`, `spawn`, `yaw`, `frame`, `script` segments with
//! `for`, `move`, `hold`, `press`, `look`, `mark`, `frame`) plus:
//! - `dummies`: [{at: [x, y, z], yaw, hp, every}] target dummies (op::DUMMY) before the script;
//! - `assist`: aim help for the player (op::SETTINGS: 0 off, 1 touch, 2 mouse, 3 on);
//! - in a segment: `face` [x, y, z] (the look turns to that point on its first frame), `hurt` {amount, by, player}
//!   (the player, or friend `player`, takes that damage on its first frame), `give` [rows] (op::LOADOUT), `reset`
//!   (op::RESET), `assist` (op::SETTINGS);
//! - wave 2: `friends`: [{id, at: [x, y, z]}] other players this copy simulates (2..), standing where they are put; in
//!   a segment: `card` (a card's id or row: op::CARD), `reward` {wave, seconds, seed} (op::REWARD opens it), `pick`
//!   (which of the three, or "pass": op::PICK; `pick_as` another player's), `revive` (a player id: op::REVIVE), `friend`
//!   {id, hold: [buttons], move: [x, z]} (that friend's input while the segment lasts).
//!
//! Measures: every kind the core's runner knows (`speed`, `time_to_speed`, `time_to_below`, `apex`, `apex_time`,
//! `air_time`, `distance`, `sim_time`, `events`, `interval`), plus:
//! - on frames (what the camera shows, the state at the end of each frame): `frame_speed` {from, frame}: the eyes'
//!   horizontal speed over frame k after the mark; `eye_apex` {from, window}; `peak` / `peak_frame` / `frame_value` /
//!   `at` / `time_to` over a series: the camera's `kick` (recoil pitch, degrees), `fov` (the punch, degrees), `eye_y`,
//!   `head` (bob and dips, m), `shake` (m), or any feel view field by name (`tint`, `stage`, `ammo`, `combo`, …);
//!   `share: true` divides by the series' peak after `from`; `time_to` takes `below` (a share of the peak) or `under`
//!   (a value);
//! - on events (steps): `count`, `delay` (from the mark to the first), `field` (a field of the first: `intensity`,
//!   `frames`, `radius`, `value`, `crit`, `count`, `multiplier`, `seconds`, `damage`, a custom event's `w0`..`w13`), `rate`
//!   (a second), `interval_steps` / `interval_spread` (steps between them: mean, and largest minus smallest), `same_step`
//!   (the first of each of `kinds` on one step), `layers` (sound events on the step of the first kill);
//! - `steps_per_frame` {stat: min | max}: no hit-stop means every 60 Hz frame runs exactly two steps; `frame_cost`
//!   {stat: max}: the slowest frame's wall time, ms (the debris budget: under 2 ms); `kill_hits` {index}: the hits the
//!   n-th kill took;
//! - wave 2: `value` {path, player}: a table value as that player's cards leave it at the end (`player.walk`,
//!   `weapons.sidearm.reload`); `preview` {card, index, of: "before" | "after"}: what the inspector says a card would
//!   change, read as the run ends; `offers` {seed, player, index, slot}: the card row dealt (`cards::deal`), and
//!   `health` {player}: a player's hit points at the end.
use std::collections::HashMap;

use forge_core::cmd::{self, Writer};
use forge_core::components::*;
use forge_core::events::{self, Event};
use forge_core::fixture::{self as cf, Measured, Sample, Trace};
use forge_core::glam::{Vec2, Vec3};
use forge_core::physics::Mover;
use forge_core::schedule::Stage;
use forge_core::serde_json::{self, json, Value};
use forge_core::{views, Core, STEP};

use crate::view::{FeelView, NAMES};

/// One event as the fixture keeps it: its kind, its name (sounds, particles, rules, labels), `what` (motion, UI, weapon
/// cues) and its payload as floats.
#[derive(Clone, Debug)]
pub struct Ev {
    pub kind: u32,
    pub name: String,
    pub what: u32,
    pub f: [f32; 14],
    pub u: [u32; 14],
}

#[derive(Clone, Debug)]
pub struct StepSample {
    pub t: f64,
    pub step: u64,
    pub pos: Vec3,
    pub vel: Vec3,
    pub speed: f32,
    pub grounded: bool,
    pub events: Vec<Ev>,
}

/// The end of a frame: what the camera view holds then.
#[derive(Clone, Debug)]
pub struct FrameSample {
    pub t: f64,
    /// The camera as drawn (forge-core's views: interpolated, so at 60 Hz the step before the last).
    pub eye: Vec3,
    /// The local player's feet at the end of the frame's last step (the simulation itself).
    pub feet: Vec3,
    /// The camera's yaw (radians) and the recoil's yaw on it (degrees).
    pub yaw: f32,
    pub kick_yaw: f32,
    pub fov: f32,
    pub kick: f32,
    pub head: f32,
    pub shake: f32,
    pub view: [f32; crate::view::field::COUNT],
    pub steps: u32,
    pub ms: f64,
}

#[derive(Default)]
struct Steps(Vec<StepSample>);

pub struct Outcome {
    pub name: String,
    pub steps: Vec<StepSample>,
    pub frames: Vec<FrameSample>,
    pub marks: HashMap<String, f64>,
    pub measured: Vec<Measured>,
    pub stats: Value,
    /// What the run's end holds for the measures that read the core itself (`value`, `preview`, `offers`, `health`):
    /// by the measure's name.
    pub read: HashMap<String, f64>,
}

fn sample(sim: &mut forge_core::sim::Sim) {
    // this step's events, and before them what a command emitted since the step before (a card given, a reward opened)
    let early: Vec<Event> = sim.events.early_events().map(|(e, _)| *e).collect();
    let evs: Vec<Ev> = early
        .iter()
        .chain(sim.events.step_events())
        .map(|e| {
            let w = e.encode(0);
            let mut u = [0u32; 14];
            u.copy_from_slice(&w[1..15]);
            let f = u.map(f32::from_bits);
            let (name, what) = match e {
                Event::Sound(s) => (sim.names.get(s.name).to_string(), 0),
                Event::Particles(p) => (sim.names.get(p.name).to_string(), 0),
                Event::Rule(r) => (sim.names.get(r.name).to_string(), 0),
                Event::Motion(m) => (String::new(), m.what),
                Event::Ui(x) => (String::new(), x.what),
                Event::Custom { kind, words } if *kind == crate::ev::LABEL => (sim.names.get(words[0]).to_string(), 0),
                Event::Custom { kind, words } if *kind == crate::ev::WEAPON => (String::new(), words[1]),
                _ => (String::new(), 0),
            };
            Ev { kind: e.kind(), name, what, f, u }
        })
        .collect();
    let row = sim.world.query::<(&Player, &Transform, &Velocity, &Mover)>().iter().find(|(p, ..)| p.local).map(|(_, tr, v, m)| (tr.pos, v.linear, Vec2::new(m.moved.x, m.moved.z).length() / STEP, m.grounded));
    let (pos, vel, speed, grounded) = row.unwrap_or((Vec3::ZERO, Vec3::ZERO, 0.0, false));
    let s = StepSample { t: sim.time.now, step: sim.time.step, pos, vel, speed, grounded, events: evs };
    sim.res.entry::<Steps>().0.push(s);
}

fn f64of(v: Option<&Value>, d: f64) -> f64 {
    v.and_then(Value::as_f64).filter(|x| x.is_finite()).unwrap_or(d)
}
fn vec3(v: Option<&Value>) -> Option<Vec3> {
    let a = v?.as_array()?;
    Some(Vec3::new(a.first()?.as_f64()? as f32, a.get(1)?.as_f64()? as f32, a.get(2)?.as_f64()? as f32))
}
fn buttons(v: Option<&Value>) -> u32 {
    let b = |n: &str| match n {
        "jump" => cmd::BTN_JUMP,
        "fire" => cmd::BTN_FIRE,
        "alt" => cmd::BTN_ALT,
        "melee" => cmd::BTN_MELEE,
        "evade" => cmd::BTN_EVADE,
        "reload" => cmd::BTN_RELOAD,
        "interact" => cmd::BTN_INTERACT,
        "next" => cmd::BTN_NEXT,
        "prev" => cmd::BTN_PREV,
        s if s.starts_with("slot") => s[4..].parse::<u32>().ok().filter(|n| (1..=4).contains(n)).map(|n| cmd::BTN_SLOT1 << (n - 1)).unwrap_or(0),
        _ => 0,
    };
    v.and_then(Value::as_array).map(|a| a.iter().filter_map(Value::as_str).map(b).fold(0, |x, y| x | y)).unwrap_or(0)
}

/// Run a script on a core with the feel plugin installed.
pub fn run(core: &mut Core, script: &Value, tables: Option<&str>) -> Result<Outcome, String> {
    let name = script.get("name").and_then(Value::as_str).unwrap_or("fixture").to_string();
    if let Some(t) = tables {
        core.load_tables(t)?;
    }
    if let Some(t) = script.get("tables").filter(|t| t.is_object()) {
        let mut base = core.sim.tables.raw.0.clone();
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
    core.schedule.add(Stage::Events, "fixture.feel", sample);
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
    let at = vec3(script.get("spawn")).unwrap_or(Vec3::new(0.0, 0.05, 0.0));
    w.spawn(1, at.x, at.y, at.z, f64of(script.get("yaw"), 0.0) as f32, true);
    for f in script.get("friends").and_then(Value::as_array).cloned().unwrap_or_default() {
        let p = vec3(f.get("at")).unwrap_or(Vec3::new(1.5, 0.05, 0.0));
        w.spawn(f.get("id").and_then(Value::as_u64).unwrap_or(2) as u32, p.x, p.y, p.z, f64of(f.get("yaw"), 0.0) as f32, false);
    }
    for d in script.get("dummies").and_then(Value::as_array).cloned().unwrap_or_default() {
        let p = vec3(d.get("at")).unwrap_or(Vec3::new(0.0, 0.0, -6.0));
        w.opf(crate::op::DUMMY, &[], &[p.x, p.y, p.z, f64of(d.get("yaw"), 0.0) as f32, f64of(d.get("hp"), 60.0) as f32, f64of(d.get("every"), 0.0) as f32]);
    }
    if let Some(a) = script.get("assist").and_then(Value::as_u64) {
        w.op(crate::op::SETTINGS, &[1, a as u32]);
    }
    core.cmds[..w.words.len()].copy_from_slice(&w.words);
    core.tick(0.0, w.words.len());
    // one quiet step so the dummies' hit regions are placed before anything aims at them
    core.tick(STEP, 0);
    let frame = f64of(script.get("frame"), 1.0 / 60.0).max(1e-4);
    let mut marks = HashMap::new();
    let mut frames: Vec<FrameSample> = Vec::new();
    for seg in script.get("script").and_then(Value::as_array).cloned().unwrap_or_default() {
        if let Some(m) = seg.get("mark").and_then(Value::as_str) {
            marks.insert(m.to_string(), core.sim.time.now);
        }
        let dur = f64of(seg.get("for"), 0.0);
        let fr = f64of(seg.get("frame"), frame).max(1e-4);
        let mv = seg.get("move").and_then(Value::as_array).map(|a| (f64of(a.first(), 0.0) as f32, f64of(a.get(1), 0.0) as f32)).unwrap_or((0.0, 0.0));
        let hold = buttons(seg.get("hold"));
        let press = buttons(seg.get("press"));
        let look = seg.get("look").and_then(Value::as_array).map(|a| (f64of(a.first(), 0.0) as f32, f64of(a.get(1), 0.0) as f32)).unwrap_or((0.0, 0.0));
        let n = ((dur / fr).round() as usize).max(if dur > 0.0 { 1 } else { 0 });
        for i in 0..n {
            let first = i == 0;
            w.clear();
            if first {
                if let Some(p) = vec3(seg.get("face"))
                    && let Some(e) = core.player(1) {
                        let feet = core.sim.world.get::<&Transform>(e).map(|t| t.pos).unwrap_or(Vec3::ZERO);
                        let eye = feet + Vec3::Y * core.sim.tables.player.eye;
                        let d = (p - eye).normalize_or(Vec3::NEG_Z);
                        w.opf(cmd::LOOK, &[1], &[(-d.x).atan2(-d.z), d.y.clamp(-1.0, 1.0).asin()]);
                    }
                if let Some(c) = seg.get("card") {
                    let row = match c.as_str() {
                        Some(id) => core.sim.tables.cards.iter().position(|r| r.id() == id).map(|i| i as u32),
                        None => c.as_u64().map(|x| x as u32),
                    };
                    if let Some(row) = row {
                        w.op(crate::op::CARD, &[seg.get("card_for").and_then(Value::as_u64).unwrap_or(1) as u32, row]);
                    }
                }
                if let Some(r) = seg.get("reward") {
                    let seed = r.get("seed").and_then(Value::as_u64).unwrap_or(1);
                    w.opf(crate::op::REWARD, &[1, r.get("wave").and_then(Value::as_u64).unwrap_or(1) as u32, seed as u32, (seed >> 32) as u32], &[f64of(r.get("seconds"), 0.0) as f32]);
                }
                if let Some(p) = seg.get("pick") {
                    w.op(crate::op::PICK, &[seg.get("pick_as").and_then(Value::as_u64).unwrap_or(1) as u32, p.as_u64().map(|x| x as u32).unwrap_or(255)]);
                }
                if let Some(id) = seg.get("revive").and_then(Value::as_u64) {
                    w.opf(crate::op::REVIVE, &[id as u32], &[0.0]);
                }
                if let Some(h) = seg.get("hurt") {
                    let amount = f64of(h.get("amount"), 10.0) as f32;
                    let by = h.get("by").and_then(Value::as_u64).unwrap_or(0) as u32;
                    let mut p: Vec<u32> = vec![h.get("player").and_then(Value::as_u64).unwrap_or(1) as u32, amount.to_bits(), by];
                    p.extend([0.0f32, 0.0, -1.0].map(f32::to_bits));
                    w.op(cmd::DAMAGE, &p);
                }
                if let Some(rows) = seg.get("give").and_then(Value::as_array) {
                    let mut p = vec![1u32];
                    p.extend(rows.iter().filter_map(Value::as_u64).map(|x| x as u32));
                    w.op(crate::op::LOADOUT, &p);
                }
                if seg.get("reset").and_then(Value::as_bool) == Some(true) {
                    w.op(crate::op::RESET, &[1]);
                }
                if let Some(a) = seg.get("assist").and_then(Value::as_u64) {
                    w.op(crate::op::SETTINGS, &[1, a as u32]);
                }
                // the governor's shares of the pieces' caps: "quality": [rest, flying]
                if let Some(q) = seg.get("quality").and_then(Value::as_array) {
                    w.opf(crate::op::QUALITY, &[], &[f64of(q.first(), 1.0) as f32, f64of(q.get(1), 1.0) as f32]);
                }
            }
            let (dx, dy) = if first { look } else { (0.0, 0.0) };
            w.input(1, mv.0, mv.1, dx, dy, hold | if first { press } else { 0 }, true, if first { press | hold } else { 0 });
            // a friend's input while the segment lasts (idle otherwise: the last INPUT's buttons would stay held)
            for f in script.get("friends").and_then(Value::as_array).cloned().unwrap_or_default() {
                let id = f.get("id").and_then(Value::as_u64).unwrap_or(2) as u32;
                let mine = seg.get("friend").filter(|x| x.get("id").and_then(Value::as_u64).unwrap_or(2) as u32 == id);
                let fh = buttons(mine.and_then(|x| x.get("hold")));
                let fm = mine.and_then(|x| x.get("move")).and_then(Value::as_array).map(|a| (f64of(a.first(), 0.0) as f32, f64of(a.get(1), 0.0) as f32)).unwrap_or((0.0, 0.0));
                w.input(id, fm.0, fm.1, 0.0, 0.0, fh, true, if first { fh } else { 0 });
            }
            core.cmds[..w.words.len()].copy_from_slice(&w.words);
            let t0 = std::time::Instant::now();
            let steps = core.tick(fr as f32, w.words.len());
            let ms = t0.elapsed().as_secs_f64() * 1000.0;
            let c = &core.views.camera;
            let view = core.sim.res.get::<FeelView>().map(|v| v.v).unwrap_or(FeelView::default().v);
            let rig = core.sim.camera;
            let feet = core.player(1).and_then(|e| core.sim.world.get::<&Transform>(e).ok().map(|t| t.pos)).unwrap_or(Vec3::ZERO);
            frames.push(FrameSample { t: core.sim.time.now, feet, eye: Vec3::new(c[views::camera::X], c[views::camera::Y], c[views::camera::Z]), yaw: c[views::camera::YAW], kick_yaw: rig.yaw.to_degrees(), fov: rig.fov_add, kick: rig.pitch.to_degrees(), head: rig.offset.y, shake: Vec2::new(rig.offset.x, rig.offset.z).length(), view, steps, ms });
        }
    }
    let steps = core.sim.res.remove::<Steps>().unwrap_or_default().0;
    let walk = core.sim.tables.player.walk as f64;
    let core_trace = Trace { samples: steps.iter().map(|s| Sample { step: s.step, t: s.t, pos: s.pos, vel: s.vel, speed: s.speed, grounded: s.grounded, events: s.events.iter().map(|e| (e.kind, if e.kind == events::MOTION { e.what } else { 0 })).collect() }).collect() };
    let stats: Value = serde_json::from_str(&crate::view::stats_json(&core.sim)).unwrap_or(Value::Null);
    // what the measures read from the core as the run ends
    let mut read = HashMap::new();
    for m in script.get("measure").and_then(Value::as_array).cloned().unwrap_or_default() {
        let key = m.get("name").and_then(Value::as_str).unwrap_or("?").to_string();
        let who = m.get("player").and_then(Value::as_u64).unwrap_or(1) as u32;
        let Some(e) = core.player(who) else { continue };
        let v = match m.get("what").and_then(Value::as_str).unwrap_or("") {
            "value" => m.get("path").and_then(Value::as_str).and_then(|p| crate::cards::value_of(&core.sim, e, p)),
            "health" => core.sim.world.get::<&Health>(e).ok().map(|h| h.hp as f64),
            "preview" => {
                let card = match m.get("card") {
                    Some(Value::String(id)) => core.sim.tables.cards.iter().position(|r| r.id() == id),
                    Some(c) => c.as_u64().map(|x| x as usize),
                    None => None,
                };
                card.and_then(|c| {
                    let p = crate::cards::preview(&core.sim, e, c as u8);
                    let i = m.get("index").and_then(Value::as_u64).unwrap_or(0) as usize;
                    p.get("changes")?.as_array()?.get(i)?.get(m.get("of").and_then(Value::as_str).unwrap_or("after"))?.as_f64()
                })
            }
            "offers" => {
                let cfg = crate::cfg(&core.sim);
                let seed = m.get("seed").and_then(Value::as_u64).unwrap_or(1);
                let held: Vec<u8> = core.sim.world.get::<&crate::cards::Build>(e).map(|b| b.cards.clone()).unwrap_or_default();
                let arms: Vec<usize> = crate::cards::usable(&cfg, core.sim.world.get::<&crate::weapons::Arms>(e).ok().as_deref());
                let o = crate::cards::deal(&cfg.cards, cfg.deal.rarity, seed, who, m.get("index").and_then(Value::as_u64).unwrap_or(1) as u32, &held, &arms);
                o.get(m.get("slot").and_then(Value::as_u64).unwrap_or(0) as usize).map(|c| *c as f64)
            }
            _ => None,
        };
        if let Some(v) = v {
            read.insert(key, v);
        }
    }
    let mut out = Outcome { name, steps, frames, marks, measured: Vec::new(), stats, read };
    out.measured = script.get("measure").and_then(Value::as_array).map(|list| list.iter().map(|m| measure(m, &out, &core_trace, walk)).collect()).unwrap_or_default();
    Ok(out)
}

fn time_of(spec: Option<&Value>, marks: &HashMap<String, f64>) -> Option<f64> {
    let s = spec?.as_str()?;
    let (m, off) = match s.find(['+', '-']) {
        Some(i) => (&s[..i], s[i..].parse::<f64>().ok()?),
        None => (s, 0.0),
    };
    Some(marks.get(m)? + off)
}

fn kind_code(name: &str) -> Option<u32> {
    Some(match name {
        "hit" => events::HIT,
        "kill" => events::KILL,
        "spawn" => events::SPAWN,
        "despawn" => events::DESPAWN,
        "sound" => events::SOUND,
        "light" => events::LIGHT,
        "particles" => events::PARTICLES,
        "camera" => events::CAMERA,
        "ui" => events::UI,
        "rule" => events::RULE,
        "motion" => events::MOTION,
        "flash" => crate::ev::FLASH,
        "tracer" => crate::ev::TRACER,
        "sever" => crate::ev::SEVER,
        "knock" => crate::ev::KNOCK,
        "label" => crate::ev::LABEL,
        "weapon" => crate::ev::WEAPON,
        _ => return None,
    })
}

/// The payload field of an event by name.
fn field(e: &Ev, f: &str) -> Option<f64> {
    let x = |i: usize| e.f[i] as f64;
    let u = |i: usize| e.u[i] as f64;
    Some(match (e.kind, f) {
        (events::LIGHT, "intensity") => x(8),
        (events::LIGHT, "radius") => x(7),
        (events::LIGHT, "frames") => u(9),
        (events::LIGHT, "r") => x(4),
        (events::LIGHT, "g") => x(5),
        (events::LIGHT, "b") => x(6),
        (events::UI, "value") => x(5),
        (events::UI, "crit") => u(6),
        (events::UI, "count") => u(7),
        (events::UI, "multiplier") => x(8),
        (events::UI, "seconds") => x(9),
        (events::HIT, "damage") | (events::KILL, "damage") => x(9),
        (events::HIT, "crit") => u(10),
        (events::HIT, "part") | (events::KILL, "part") => u(2),
        (events::RULE, "a") => x(2),
        (events::RULE, "b") => x(3),
        (events::RULE, "c") => x(4),
        (events::RULE, "d") => x(5),
        (events::PARTICLES, "count") => u(1),
        (_, w) if w.starts_with('w') => {
            let i: usize = w[1..].parse().ok()?;
            if i >= 14 {
                return None;
            }
            if f.ends_with('f') { x(i) } else { u(i) }
        }
        (_, w) if w.starts_with('f') => {
            let i: usize = w[1..].parse().ok()?;
            if i >= 14 {
                return None;
            }
            x(i)
        }
        _ => return None,
    })
}

fn series(fr: &FrameSample, name: &str) -> Option<f64> {
    Some(match name {
        "kick" => fr.kick as f64,
        "kick_yaw" => fr.kick_yaw as f64,
        "yaw" => fr.yaw.to_degrees() as f64,
        "fov" => fr.fov as f64,
        "eye_y" => fr.eye.y as f64,
        "head" => fr.head as f64,
        "shake" => fr.shake as f64,
        n => fr.view[NAMES.iter().position(|x| *x == n)?] as f64,
    })
}

/// One measurement.
pub fn measure(m: &Value, o: &Outcome, core_trace: &Trace, walk: f64) -> Measured {
    let name = m.get("name").and_then(Value::as_str).unwrap_or("?").to_string();
    let unit = m.get("unit").and_then(Value::as_str).unwrap_or("").to_string();
    let target = m.get("target").and_then(Value::as_array).and_then(|a| Some((a.first()?.as_f64()?, a.get(1)?.as_f64()?)));
    let what = m.get("what").and_then(Value::as_str).unwrap_or("");
    let from = time_of(m.get("from"), &o.marks);
    let to = time_of(m.get("to"), &o.marks);
    let window = f64of(m.get("window"), 2.0);
    let ser = m.get("series").and_then(Value::as_str).unwrap_or("");
    let fl: Vec<&FrameSample> = match from {
        Some(t0) => o.frames.iter().filter(|f| f.t > t0 + 1e-9 && f.t <= to.unwrap_or(t0 + window) + 1e-9).collect(),
        None => o.frames.iter().collect(),
    };
    let base_frame = from.and_then(|t0| o.frames.iter().rev().find(|f| f.t <= t0 + 1e-9));
    let peak = || fl.iter().filter_map(|f| series(f, ser)).fold(f64::MIN, f64::max);
    let share = m.get("share").and_then(Value::as_bool) == Some(true);
    let norm = |v: f64| if share { let p = peak(); if p.abs() > 1e-12 { v / p } else { 0.0 } } else { v };
    let want_kind = m.get("kind").and_then(Value::as_str).and_then(kind_code);
    let want_name = m.get("name_is").or_else(|| m.get("sound")).and_then(Value::as_str);
    let want_what = m.get("is").and_then(Value::as_u64).map(|x| x as u32);
    // SPAWN and DESPAWN by entity kind (`of`: 4 debris, 16 a coin, 3 a projectile)
    let want_of = m.get("of").and_then(Value::as_u64).map(|x| x as u32);
    let names: Option<Vec<String>> = m.get("names").and_then(Value::as_array).map(|a| a.iter().filter_map(Value::as_str).map(str::to_string).collect());
    let matches = |e: &Ev, k: u32| e.kind == k && want_name.is_none_or(|n| e.name == n) && want_what.is_none_or(|w| e.what == w) && want_of.is_none_or(|o| e.u[1] == o) && names.as_ref().is_none_or(|ns| ns.contains(&e.name));
    let evs = |k: u32| -> Vec<(f64, u64, Ev)> {
        let (a, b) = (from.unwrap_or(f64::MIN), to.unwrap_or(f64::MAX));
        o.steps.iter().filter(|s| s.t > a + 1e-9 && s.t <= b + 1e-9).flat_map(|s| s.events.iter().filter(|e| matches(e, k)).map(move |e| (s.t, s.step, e.clone()))).collect()
    };
    let value: Option<f64> = match what {
        "frame_speed" => {
            // over frame k after the mark: the simulated body's travel, or with `drawn` the drawn camera's
            let k = m.get("frame").and_then(Value::as_u64).unwrap_or(1) as usize;
            let drawn = m.get("drawn").and_then(Value::as_bool) == Some(true);
            let (a, b) = (if k == 1 { base_frame } else { fl.get(k - 2).copied() }, fl.get(k - 1).copied());
            match (a, b) {
                (Some(a), Some(b)) if b.t > a.t => {
                    let d = if drawn { b.eye - a.eye } else { b.feet - a.feet };
                    Some(Vec2::new(d.x, d.z).length() as f64 / (b.t - a.t))
                }
                _ => None,
            }
        }
        "mean_speed" => {
            // the simulated body's horizontal travel from `from` to `to`, over the time
            let p = |t: f64| o.frames.iter().min_by(|x, y| (x.t - t).abs().total_cmp(&(y.t - t).abs())).map(|f| (f.t, f.feet));
            match (from.and_then(p), to.and_then(p)) {
                (Some((ta, a)), Some((tb, b))) if tb > ta => Some(Vec2::new(b.x - a.x, b.z - a.z).length() as f64 / (tb - ta)),
                _ => None,
            }
        }
        "eye_apex" => base_frame.map(|b| fl.iter().map(|f| f.eye.y).fold(f32::MIN, f32::max) as f64 - b.eye.y as f64),
        "peak" => Some(peak()).filter(|p| *p > f64::MIN),
        "trough" => Some(fl.iter().filter_map(|f| series(f, ser)).fold(f64::MAX, f64::min)).filter(|p| *p < f64::MAX),
        "period" => {
            // the mean seconds between the series' local highs
            let v: Vec<(f64, f64)> = fl.iter().filter_map(|f| series(f, ser).map(|x| (f.t, x))).collect();
            let highs: Vec<f64> = v.windows(3).filter(|w| w[1].1 > w[0].1 && w[1].1 >= w[2].1 && w[1].1 > 0.0).map(|w| w[1].0).collect();
            (highs.len() >= 2).then(|| (highs[highs.len() - 1] - highs[0]) / (highs.len() - 1) as f64)
        }
        "peak_frame" => {
            let p = peak();
            fl.iter().position(|f| series(f, ser) == Some(p)).map(|i| (i + 1) as f64)
        }
        "frame_value" => {
            let k = m.get("frame").and_then(Value::as_u64).unwrap_or(1) as usize;
            fl.get(k.max(1) - 1).and_then(|f| series(f, ser)).map(norm)
        }
        "at" => {
            let at = time_of(m.get("at"), &o.marks);
            at.and_then(|t| o.frames.iter().min_by(|a, b| (a.t - t).abs().total_cmp(&(b.t - t).abs()))).and_then(|f| series(f, ser)).map(norm)
        }
        "time_to" if m.get("over").is_some() => from.and_then(|t0| {
            let over = f64of(m.get("over"), 0.0);
            fl.iter().find(|f| series(f, ser).is_some_and(|v| v >= over - 1e-9)).map(|f| f.t - t0)
        }),
        "time_to" => from.and_then(|t0| {
            let p = peak();
            let at_peak = fl.iter().position(|f| series(f, ser) == Some(p)).unwrap_or(0);
            let lim = match (m.get("below").and_then(Value::as_f64), m.get("under").and_then(Value::as_f64)) {
                (Some(s), _) => s * p,
                (_, Some(u)) => u,
                _ => 0.0,
            };
            fl.iter().skip(at_peak).find(|f| series(f, ser).is_some_and(|v| v <= lim + 1e-12)).map(|f| f.t - t0)
        }),
        "count" => want_kind.map(|k| evs(k).len() as f64),
        "delay" => want_kind.and_then(|k| evs(k).first().map(|e| e.0 - from.unwrap_or(0.0))),
        "field" => want_kind.and_then(|k| {
            let f = m.get("field").and_then(Value::as_str).unwrap_or("");
            let n = m.get("index").and_then(Value::as_u64).unwrap_or(0) as usize;
            evs(k).get(n).and_then(|e| field(&e.2, f))
        }),
        "rate" => match (want_kind, from, to) {
            (Some(k), Some(a), Some(b)) if b > a => Some(evs(k).len() as f64 / (b - a)),
            _ => None,
        },
        "interval_steps" | "interval_spread" => want_kind.and_then(|k| {
            let e = evs(k);
            let gaps: Vec<u64> = e.windows(2).map(|w| w[1].1 - w[0].1).collect();
            if gaps.is_empty() {
                return None;
            }
            Some(if what == "interval_steps" { gaps.iter().sum::<u64>() as f64 / gaps.len() as f64 } else { (*gaps.iter().max().unwrap() - *gaps.iter().min().unwrap()) as f64 })
        }),
        "same_step" => {
            let kinds: Vec<(u32, Option<String>)> = m.get("kinds").and_then(Value::as_array).map(|a| a.iter().filter_map(|x| { let x = x.as_array()?; Some((kind_code(x.first()?.as_str()?)?, x.get(1).and_then(Value::as_str).map(str::to_string))) }).collect()).unwrap_or_default();
            let (a, b) = (from.unwrap_or(f64::MIN), to.unwrap_or(f64::MAX));
            let firsts: Vec<Option<u64>> = kinds.iter().map(|(k, n)| o.steps.iter().filter(|s| s.t > a + 1e-9 && s.t <= b + 1e-9).find(|s| s.events.iter().any(|e| e.kind == *k && n.as_ref().is_none_or(|n| &e.name == n))).map(|s| s.step)).collect();
            if firsts.iter().any(Option::is_none) || firsts.is_empty() { Some(0.0) } else { Some((firsts.iter().all(|x| *x == firsts[0])) as u8 as f64) }
        }
        "layers" => {
            // sound events (with `names`: only those) on the step of the first kill after `from`
            let (a, b) = (from.unwrap_or(f64::MIN), to.unwrap_or(f64::MAX));
            o.steps.iter().filter(|s| s.t > a + 1e-9 && s.t <= b + 1e-9).find(|s| s.events.iter().any(|e| e.kind == events::KILL)).map(|s| s.events.iter().filter(|e| e.kind == events::SOUND && names.as_ref().is_none_or(|ns| ns.contains(&e.name))).count() as f64)
        }
        "kill_count" => {
            // spawns of `of` (or any event matching) on the step of the first kill after `from`
            let (a, b) = (from.unwrap_or(f64::MIN), to.unwrap_or(f64::MAX));
            want_kind.and_then(|k| o.steps.iter().filter(|s| s.t > a + 1e-9 && s.t <= b + 1e-9).find(|s| s.events.iter().any(|e| e.kind == events::KILL)).map(|s| s.events.iter().filter(|e| matches(e, k)).count() as f64))
        }
        "steps_per_frame" => {
            let stat = m.get("stat").and_then(Value::as_str).unwrap_or("min");
            let it = fl.iter().map(|f| f.steps as f64);
            if fl.is_empty() { None } else if stat == "max" { Some(it.fold(f64::MIN, f64::max)) } else { Some(it.fold(f64::MAX, f64::min)) }
        }
        "frame_cost" => (!fl.is_empty()).then(|| fl.iter().map(|f| f.ms).fold(0.0, f64::max)),
        "value" | "health" | "preview" | "offers" => o.read.get(&name).copied(),
        "kill_hits" => {
            let n = m.get("index").and_then(Value::as_u64).unwrap_or(0) as usize;
            o.stats.get("kills").and_then(Value::as_array).and_then(|k| k.get(n)).and_then(|k| k.get("hits")).and_then(Value::as_f64)
        }
        _ => return cf::measure(m, core_trace, &o.marks, walk),
    };
    let ok = match (value, target) {
        (Some(v), Some((lo, hi))) => Some(v >= lo - 1e-9 && v <= hi + 1e-9),
        (None, Some(_)) => Some(false),
        _ => None,
    };
    Measured { name, value, unit, target, ok }
}

/// The frames as CSV.
pub fn csv(o: &Outcome) -> String {
    let mut out = String::from("t,eye_x,eye_y,eye_z,fov,kick,head,shake,steps,ms,ammo,reloading,tint,stage,combo,view_kick\n");
    for f in &o.frames {
        let v = &f.view;
        use crate::view::field as F;
        out.push_str(&format!("{:.5},{:.4},{:.4},{:.4},{:.3},{:.4},{:.4},{:.4},{},{:.3},{},{},{:.3},{},{},{:.4}\n", f.t, f.eye.x, f.eye.y, f.eye.z, f.fov, f.kick, f.head, f.shake, f.steps, f.ms, v[F::AMMO], v[F::RELOADING], v[F::TINT], v[F::STAGE], v[F::COMBO], v[F::VIEW_KICK]));
    }
    out
}

pub fn summary_json(o: &Outcome) -> Value {
    json!({
        "name": o.name,
        "steps": o.steps.len(),
        "frames": o.frames.len(),
        "pass": o.measured.iter().all(|m| m.ok != Some(false)),
        "measured": o.measured.iter().map(|m| json!({ "name": m.name, "value": m.value, "unit": m.unit, "target": m.target.map(|t| [t.0, t.1]), "ok": m.ok })).collect::<Vec<_>>(),
    })
}

/// The command line: `<script.json> [--trace] [--json] [--tables <config/game.json>]`. → the exit code.
pub fn run_main(args: &[String]) -> i32 {
    let mut path = None;
    let (mut trace, mut json_out, mut tables) = (false, false, None);
    let mut it = args.iter();
    while let Some(a) = it.next() {
        match a.as_str() {
            "--trace" => trace = true,
            "--json" => json_out = true,
            "--tables" => tables = it.next().cloned(),
            s if !s.starts_with("--") => path = Some(s.to_string()),
            s => {
                eprintln!("feel-fixture: unknown option {s}");
                return 2;
            }
        }
    }
    let Some(path) = path else {
        eprintln!("usage: feel-fixture <script.json> [--trace] [--json] [--tables <config/game.json>]");
        return 2;
    };
    let read = |p: &str| std::fs::read_to_string(p).map_err(|e| format!("{p}: {e}"));
    let script: Value = match read(&path).and_then(|t| serde_json::from_str(&t).map_err(|e| format!("{path}: {e}"))) {
        Ok(v) => v,
        Err(e) => {
            eprintln!("feel-fixture: {e}");
            return 2;
        }
    };
    let tables_json = match tables.as_deref().map(read) {
        Some(Ok(t)) => {
            let v: Value = serde_json::from_str(&t).unwrap_or(Value::Null);
            Some(v.get("forge").cloned().unwrap_or(v).to_string())
        }
        Some(Err(e)) => {
            eprintln!("feel-fixture: {e}");
            return 2;
        }
        None => None,
    };
    let mut core = Core::new();
    core.add_plugin(&crate::FeelPlugin);
    let o = match run(&mut core, &script, tables_json.as_deref()) {
        Ok(o) => o,
        Err(e) => {
            eprintln!("feel-fixture: {e}");
            return 2;
        }
    };
    if trace {
        print!("{}", csv(&o));
    }
    if json_out {
        println!("{}", serde_json::to_string_pretty(&summary_json(&o)).unwrap_or_default());
    } else {
        println!("fixture {}: {} steps, {} frames, 120 Hz, forge-feel", o.name, o.steps.len(), o.frames.len());
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

#[cfg(test)]
mod tests {
    use super::*;

    /// forge-feel meets the measured feel targets (research/rust-engine/feel-targets.md) in every fixture of
    /// research/gf-forge/fixtures/feel (as `node research/gf-forge/tools/fixtures.mjs feel` runs them).
    #[test]
    fn the_feel_fixtures_meet_their_targets() {
        let dir = concat!(env!("CARGO_MANIFEST_DIR"), "/../../fixtures/feel");
        let mut names: Vec<_> = std::fs::read_dir(dir).expect("research/gf-forge/fixtures/feel").filter_map(|e| e.ok()).map(|e| e.path()).filter(|p| p.extension().is_some_and(|x| x == "json")).collect();
        names.sort();
        assert!(names.len() >= 15, "{names:?}");
        let mut missed = Vec::new();
        for p in names {
            let script: Value = serde_json::from_str(&std::fs::read_to_string(&p).unwrap()).unwrap();
            let mut core = Core::new();
            core.add_plugin(&crate::FeelPlugin);
            let o = run(&mut core, &script, None).unwrap();
            assert!(!o.measured.is_empty(), "{p:?} measures nothing");
            for m in o.measured.iter().filter(|m| m.ok == Some(false)) {
                missed.push(format!("{}: {} = {:?} {}, target {:?}", o.name, m.name, m.value, m.unit, m.target));
            }
        }
        assert!(missed.is_empty(), "{missed:#?}");
    }

    /// The death recap names the final blow and the hits before it (the shared results read it).
    #[test]
    fn a_death_leaves_its_recap() {
        let script = json!({ "script": [ { "for": 0.2 }, { "hurt": { "amount": 70 }, "for": 0.5 }, { "hurt": { "amount": 60 }, "for": 0.2 } ] });
        let mut core = Core::new();
        core.add_plugin(&crate::FeelPlugin);
        run(&mut core, &script, None).unwrap();
        let r: Value = serde_json::from_str(&crate::hurt::recap_json(&core.sim, 1)).unwrap();
        assert_eq!(r["dead"], true, "{r}");
        assert_eq!(r["hits"].as_array().unwrap().len(), 2, "{r}");
        assert!((r["final"]["hpBefore"].as_f64().unwrap() - 50.0).abs() < 1e-3, "{r}");
        assert!((r["hits"][0]["armor"].as_f64().unwrap() - 20.0).abs() < 1e-3, "the armour took the first 20: {r}");
        assert!(r["hits"][0]["ago"].as_f64().unwrap() > 0.4, "{r}");
    }
}
