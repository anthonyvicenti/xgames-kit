//! The data tables (PLAN §3.3, CONTRACT §8 forge "spec.forge"; ARCHITECTURE.md "Tables"): player movement, weapons,
//! enemies, waves and cards, every value a slot value. The schema and the defaults live in the kit
//! (`research/gf-forge/kit/tables/`): `create` validates `spec.forge` against it and writes the filled tables into
//! `config/game.json → forge`; the JS host sends that JSON here (`Core::load_tables`) once at boot and again whenever
//! Studio changes a value.
//!
//! The core types only what the core itself reads (`PlayerTable`: the walk, the jump, the character controller;
//! `PhysicsTable`). Every other value stays a `Row` (a JSON object with typed getters): forge-feel reads `weapons` and
//! the player's evade and stamina, forge-ai reads `enemies` and `waves`, each parsing rows into its own types in an
//! `on_tables` hook, so a new field never needs an edit here. Rust's defaults equal the kit's (`kit/tables/defaults.json`,
//! checked by a test), so a native fixture without tables plays like a game without a `forge` block.
use serde_json::{Map, Value};

use crate::names::Names;

/// A table row: a JSON object with typed getters. `path` may go into nested objects with dots ("muzzle.color").
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Row(pub Map<String, Value>);

impl Row {
    pub fn get(&self, path: &str) -> Option<&Value> {
        let mut it = path.split('.');
        let mut v = self.0.get(it.next()?)?;
        for k in it {
            v = v.as_object()?.get(k)?;
        }
        Some(v)
    }
    /// A number (finite), or `default`.
    pub fn num(&self, path: &str, default: f32) -> f32 {
        self.get(path).and_then(Value::as_f64).map(|x| x as f32).filter(|x| x.is_finite()).unwrap_or(default)
    }
    pub fn int(&self, path: &str, default: i64) -> i64 {
        self.get(path).and_then(|v| v.as_i64().or_else(|| v.as_f64().map(|f| f as i64))).unwrap_or(default)
    }
    pub fn bool(&self, path: &str, default: bool) -> bool {
        self.get(path).and_then(Value::as_bool).unwrap_or(default)
    }
    pub fn str(&self, path: &str) -> Option<&str> {
        self.get(path).and_then(Value::as_str)
    }
    /// A "#rrggbb" colour as linear RGB, or `default`.
    pub fn color(&self, path: &str, default: [f32; 3]) -> [f32; 3] {
        self.str(path).and_then(hex_linear).unwrap_or(default)
    }
    /// A nested object as a row.
    pub fn row(&self, path: &str) -> Option<Row> {
        self.get(path).and_then(Value::as_object).map(|m| Row(m.clone()))
    }
    /// A list of rows (objects only; anything else in the list is skipped).
    pub fn rows(&self, path: &str) -> Vec<Row> {
        self.get(path).and_then(Value::as_array).map(|a| a.iter().filter_map(|v| v.as_object().map(|m| Row(m.clone()))).collect()).unwrap_or_default()
    }
    pub fn id(&self) -> &str {
        self.str("id").unwrap_or("")
    }
}

/// "#rrggbb" (sRGB) → linear RGB.
pub fn hex_linear(s: &str) -> Option<[f32; 3]> {
    let h = s.strip_prefix('#').unwrap_or(s);
    if h.len() != 6 {
        return None;
    }
    let n = u32::from_str_radix(h, 16).ok()?;
    let lin = |c: u32| {
        let s = c as f32 / 255.0;
        if s <= 0.04045 { s / 12.92 } else { ((s + 0.055) / 1.055).powf(2.4) }
    };
    Some([lin((n >> 16) & 255), lin((n >> 8) & 255), lin(n & 255)])
}

/// The player's movement, as the core reads it (`spec.forge.player`; the kit's `tables/player.js` documents every
/// field). Defaults are the measured feel targets (research/rust-engine/feel-targets.md, moments 5 and 6).
#[derive(Clone, Debug, PartialEq)]
pub struct PlayerTable {
    /// Top speed on foot, m/s, the same in every direction (no sprint key).
    pub walk: f32,
    /// Seconds from standing to 90% of `walk`.
    pub accel_time: f32,
    /// Seconds from `walk` to under 10% once the stick is let go.
    pub stop_time: f32,
    /// The share of the ground's acceleration the player has in the air (0..1).
    pub air_control: f32,
    /// Upward speed a jump starts with, m/s.
    pub jump: f32,
    /// m/s² pulling the player down.
    pub gravity: f32,
    pub max_fall: f32,
    /// Seconds after walking off an edge a jump still works.
    pub coyote: f32,
    /// Seconds a jump pressed just before landing waits for the ground.
    pub jump_buffer: f32,
    pub radius: f32,
    pub height: f32,
    /// Eye height above the feet, m.
    pub eye: f32,
    /// The highest step walked up without jumping, m.
    pub step_height: f32,
    /// The steepest slope walked up, degrees.
    pub slope_max: f32,
    /// How far down the ground holds the player when it falls away (stairs down, slopes), m.
    pub snap: f32,
    /// Metres walked between two footsteps.
    pub step_every: f32,
    pub health: f32,
    pub armor: f32,
    /// Vertical field of view, degrees.
    pub fov: f32,
    /// Sound names (assets.json sounds) for a footstep, a jump and a landing.
    pub sound_step: String,
    pub sound_jump: String,
    pub sound_land: String,
}

impl Default for PlayerTable {
    fn default() -> Self {
        Self {
            walk: 7.8,
            accel_time: 0.1,
            stop_time: 0.09,
            air_control: 0.3,
            jump: 7.0,
            gravity: 21.6,
            max_fall: 40.0,
            coyote: 0.1,
            jump_buffer: 0.12,
            radius: 0.3,
            height: 1.8,
            eye: 1.74,
            step_height: 0.35,
            slope_max: 46.0,
            snap: 0.25,
            step_every: 2.2,
            health: 100.0,
            armor: 20.0,
            fov: 68.0,
            sound_step: "step".into(),
            sound_jump: "jump".into(),
            sound_land: "land".into(),
        }
    }
}

impl PlayerTable {
    pub fn from_row(r: &Row) -> Self {
        let d = Self::default();
        let pos = |k: &str, v: f32, lo: f32, hi: f32| r.num(k, v).clamp(lo, hi);
        let height = pos("height", d.height, 0.5, 4.0);
        let radius = pos("radius", d.radius, 0.05, height * 0.5 - 0.01);
        Self {
            walk: pos("walk", d.walk, 0.0, 60.0),
            accel_time: pos("accelTime", d.accel_time, 0.0, 5.0),
            stop_time: pos("stopTime", d.stop_time, 0.0, 5.0),
            air_control: pos("airControl", d.air_control, 0.0, 1.0),
            jump: pos("jump", d.jump, 0.0, 40.0),
            gravity: pos("gravity", d.gravity, 0.0, 200.0),
            max_fall: pos("maxFall", d.max_fall, 1.0, 200.0),
            coyote: pos("coyote", d.coyote, 0.0, 1.0),
            jump_buffer: pos("jumpBuffer", d.jump_buffer, 0.0, 1.0),
            radius,
            height,
            eye: pos("eye", d.eye, 0.1, height),
            step_height: pos("stepHeight", d.step_height, 0.0, height * 0.5),
            slope_max: pos("slopeMax", d.slope_max, 0.0, 89.0),
            snap: pos("snap", d.snap, 0.0, 2.0),
            step_every: pos("stepEvery", d.step_every, 0.1, 20.0),
            health: pos("health", d.health, 1.0, 100000.0),
            armor: pos("armor", d.armor, 0.0, 100000.0),
            fov: pos("fov", d.fov, 20.0, 140.0),
            sound_step: r.str("sounds.step").unwrap_or(&d.sound_step).to_string(),
            sound_jump: r.str("sounds.jump").unwrap_or(&d.sound_jump).to_string(),
            sound_land: r.str("sounds.land").unwrap_or(&d.sound_land).to_string(),
        }
    }
    /// The capsule's half-height between its two half-spheres.
    pub fn half_height(&self) -> f32 {
        (self.height * 0.5 - self.radius).max(0.01)
    }
}

/// The physics world's own values (`spec.forge.physics`).
#[derive(Clone, Debug, PartialEq)]
pub struct PhysicsTable {
    /// m/s² on dynamic bodies (debris, ragdoll pieces). The player's own gravity is `player.gravity`.
    pub gravity: f32,
    /// Seconds a piece of debris lives.
    pub debris_life: f32,
}

impl Default for PhysicsTable {
    fn default() -> Self {
        Self { gravity: 18.0, debris_life: 4.0 }
    }
}

impl PhysicsTable {
    pub fn from_row(r: &Row) -> Self {
        let d = Self::default();
        Self { gravity: r.num("gravity", d.gravity).clamp(0.0, 200.0), debris_life: r.num("debrisLife", d.debris_life).clamp(0.0, 120.0) }
    }
}

/// Every table, as loaded.
#[derive(Clone, Debug, Default)]
pub struct Tables {
    pub player: PlayerTable,
    pub physics: PhysicsTable,
    /// `player` as given (forge-feel reads its evade, stamina, bob and hurt values from here).
    pub player_row: Row,
    pub weapons: Vec<Row>,
    pub enemies: Vec<Row>,
    pub waves: Vec<Row>,
    pub cards: Vec<Row>,
    /// The whole `forge` object as given (a plugin's own table lives under its own key).
    pub raw: Row,
    /// Counts loads (0: the defaults, never loaded).
    pub version: u32,
}

impl Tables {
    /// Load `config/game.json → forge` (a JSON object). Missing tables keep the defaults; every `sound`/`sounds.*`
    /// string is given a name id here, so events can carry it. → Err with the reason when it is not a JSON object.
    pub fn load(&mut self, json: &str, names: &mut Names) -> Result<(), String> {
        let v: Value = serde_json::from_str(json).map_err(|e| format!("the tables are not JSON: {e}"))?;
        let Value::Object(map) = v else { return Err("the tables must be a JSON object (config/game.json → forge)".into()) };
        let raw = Row(map);
        let player_row = raw.row("player").unwrap_or_default();
        self.player = PlayerTable::from_row(&player_row);
        self.physics = PhysicsTable::from_row(&raw.row("physics").unwrap_or_default());
        self.player_row = player_row;
        self.weapons = raw.rows("weapons");
        self.enemies = raw.rows("enemies");
        self.waves = raw.rows("waves");
        self.cards = raw.rows("cards");
        self.raw = raw;
        self.version += 1;
        intern_sounds(&self.raw.0, names);
        for s in [&self.player.sound_step, &self.player.sound_jump, &self.player.sound_land] {
            names.id(s);
        }
        Ok(())
    }
    /// The row of `table` whose `id` is `id`, and its index.
    pub fn find<'a>(rows: &'a [Row], id: &str) -> Option<(usize, &'a Row)> {
        rows.iter().enumerate().find(|(_, r)| r.id() == id)
    }
}

/// Give every sound name in the tables an id up front (any string under a key named `sound` or inside `sounds`), so
/// the JS host knows them all before the first event.
fn intern_sounds(map: &Map<String, Value>, names: &mut Names) {
    for (k, v) in map {
        match v {
            Value::String(s) if k == "sound" => {
                names.id(s);
            }
            Value::Object(m) if k == "sounds" => {
                for s in m.values().filter_map(Value::as_str) {
                    names.id(s);
                }
            }
            Value::Object(m) => intern_sounds(m, names),
            Value::Array(a) => {
                for x in a {
                    if let Value::Object(m) = x {
                        intern_sounds(m, names);
                    }
                }
            }
            _ => {}
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn loads_rows_and_keeps_defaults_for_what_is_missing() {
        let mut t = Tables::default();
        let mut n = Names::default();
        t.load(r##"{"player":{"walk":9,"sounds":{"step":"forge-step"}},"weapons":[{"id":"sidearm","kind":"projectile","damage":20,"muzzle":{"color":"#ff7a21"},"sounds":{"fire":"shot"}}],"enemies":[{"id":"chaser"},3]}"##, &mut n).unwrap();
        assert_eq!(t.player.walk, 9.0);
        assert_eq!(t.player.jump, 7.0);
        assert_eq!(t.player.sound_step, "forge-step");
        assert_eq!(t.weapons.len(), 1);
        assert_eq!(t.enemies.len(), 1, "a non-object row is skipped");
        let w = &t.weapons[0];
        assert_eq!(w.num("damage", 0.0), 20.0);
        assert_eq!(w.num("nope", 3.0), 3.0);
        let c = w.color("muzzle.color", [0.0; 3]);
        assert!((c[0] - 1.0).abs() < 1e-6 && c[1] > 0.1 && c[1] < 0.25, "{c:?}");
        assert_eq!(Tables::find(&t.weapons, "sidearm").unwrap().0, 0);
        assert!(n.find("shot").is_some() && n.find("forge-step").is_some() && n.find("jump").is_some(), "every sound name has an id");
        assert_eq!(t.version, 1);
        assert!(t.load("[1]", &mut n).is_err());
        assert!(t.load("{nope", &mut n).is_err());
    }

    #[test]
    fn out_of_range_values_are_held_to_what_the_core_can_do() {
        let mut t = Tables::default();
        t.load(r#"{"player":{"walk":-3,"radius":5,"height":1.8,"eye":9}}"#, &mut Names::default()).unwrap();
        assert_eq!(t.player.walk, 0.0);
        assert!(t.player.radius < 0.9);
        assert_eq!(t.player.eye, 1.8);
    }

    /// The Rust defaults equal the kit's (research/gf-forge/kit/tables/defaults.json, written by
    /// `node research/gf-forge/tools/tables.mjs --write`), so a native fixture plays like a game.
    #[test]
    fn rust_defaults_equal_the_kits() {
        let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../../kit/tables/defaults.json");
        let text = std::fs::read_to_string(path).expect("kit/tables/defaults.json (node research/gf-forge/tools/tables.mjs --write)");
        let mut t = Tables::default();
        t.load(&text, &mut Names::default()).unwrap();
        assert_eq!(t.player, PlayerTable::default(), "kit/tables/player.js defaults and PlayerTable::default differ");
        assert_eq!(t.physics, PhysicsTable::default(), "kit/tables/physics defaults and PhysicsTable::default differ");
    }
}
