//! The weapons table, typed (`spec.forge.weapons`; the kit's `tables/weapons.js`). A row is filled the way the kit
//! fills it (the field defaults, then its kind's values, then its preset's, then its own), so a native fixture that
//! writes `{"id": "sidearm", "preset": "pistol"}` plays the same weapon a game gets from `create`
//! (`tests::rust_fills_rows_like_the_kit` holds the two to fixtures/feel/data/weapons.json, written by
//! `node research/gf-forge/tools/tables.mjs --write`).
use forge_core::serde_json::{json, Map, Value};
#[cfg(test)]
use forge_core::serde_json;
use forge_core::tables::Row;
use forge_core::STEP;

use crate::recoil;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Kind {
    Hitscan,
    Projectile,
    Melee,
    Beam,
    Charge,
}

impl Kind {
    pub fn parse(s: &str) -> Kind {
        match s {
            "hitscan" => Kind::Hitscan,
            "melee" => Kind::Melee,
            "beam" => Kind::Beam,
            "charge" => Kind::Charge,
            _ => Kind::Projectile,
        }
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct Light {
    pub color: [f32; 3],
    pub radius: f32,
    pub intensity: f32,
    pub frames: u32,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Melee {
    pub reach: f32,
    /// Radians, the whole arc.
    pub arc: f32,
    pub windup: f32,
    pub contact: f32,
    pub recover: f32,
    pub whoosh: f32,
    pub targets: u32,
}

#[derive(Clone, Debug, PartialEq)]
pub struct WeaponDef {
    pub id: String,
    pub name: String,
    pub kind: Kind,
    pub slot: u32,
    pub start: bool,
    pub damage: f32,
    pub crit: f32,
    /// Seconds between shots (the cooldown carries its remainder, so the cadence keeps its average on whole steps).
    pub interval: f32,
    pub auto: bool,
    pub magazine: u32,
    pub reload: f32,
    pub raise: f32,
    pub pellets: u32,
    /// Radians, the cone's full width.
    pub spread: f32,
    pub range: f32,
    pub speed: f32,
    pub radius: f32,
    pub knockback: f32,
    /// Radians: the visible peak of the pitch kick, and the sideways kick.
    pub kick_pitch: f32,
    pub kick_yaw: f32,
    pub kick_half: f32,
    pub kick_back: f32,
    /// The spring's shape (from `kick_half` and `kick_back`) and the displacement that gives the visible peak.
    pub shape: recoil::Shape,
    pub kick_impulse: f32,
    pub view_kick: f32,
    pub muzzle: Light,
    pub sparks: u32,
    pub smoke: f32,
    pub impact: Light,
    pub tracer: [f32; 3],
    pub melee: Melee,
    pub sound_fire: String,
    pub sound_reload: String,
    pub sound_impact: String,
    pub sound_empty: String,
    pub sound_swing: String,
}

/// The kit's field defaults (`tables/weapons.js` fields), as JSON.
pub fn field_defaults() -> Value {
    json!({
        "name": "", "kind": "projectile", "preset": "", "slot": 1, "start": true, "damage": 20, "critMultiplier": 2,
        "fireInterval": 0.25, "auto": false, "magazine": 6, "reload": 0.94, "raise": 0.2, "pellets": 1, "spread": 0.5,
        "range": 100, "speed": 85, "radius": 0.05, "knockback": 2,
        "kick": { "pitch": 0.66, "yaw": 0.006, "half": 0.07, "back": 0.15, "view": 0.06 },
        "muzzle": { "color": "#ffb865", "radius": 3.4, "intensity": 0.95, "frames": 2, "sparks": 4, "smoke": 0.13 },
        "impact": { "color": "#ff9945", "radius": 2.5, "intensity": 1.17, "frames": 4 },
        "tracer": "#ff9a3c",
        "melee": { "reach": 2.2, "arc": 70, "windup": 0.045, "contact": 0.156, "recover": 0.25, "whoosh": 0.122, "targets": 3 },
        "sounds": { "fire": "shot", "reload": "reload", "impact": "impact", "empty": "", "swing": "swing" }
    })
}

/// Per kind (the kit's `kinds`).
pub fn kind_values(kind: &str) -> Value {
    match kind {
        "hitscan" => json!({ "damage": 12, "fireInterval": 0.1, "auto": true, "magazine": 30, "reload": 1.5, "speed": 1000, "kick": { "pitch": 0.3, "half": 0.045, "back": 0.08 }, "muzzle": { "intensity": 1.4, "frames": 3 } }),
        "melee" => json!({ "damage": 35, "fireInterval": 0.45, "magazine": 0, "reload": 0, "range": 2.2, "speed": 1, "kick": { "pitch": 0, "yaw": 0, "view": 0 }, "muzzle": { "intensity": 0, "sparks": 0, "smoke": 0 }, "sounds": { "fire": "swing" } }),
        "beam" => json!({ "damage": 60, "fireInterval": 0.05, "auto": true, "magazine": 0, "range": 20, "kick": { "pitch": 0.05 }, "muzzle": { "smoke": 0 } }),
        "charge" => json!({ "damage": 80, "fireInterval": 0.8, "magazine": 0, "speed": 60, "kick": { "pitch": 1.5 } }),
        _ => json!({}),
    }
}

/// The measured presets (the kit's `presets`).
pub fn preset_values(preset: &str) -> Option<Value> {
    Some(match preset {
        "pistol" => json!({ "kind": "projectile", "name": "Sidearm", "damage": 20, "fireInterval": 0.25, "magazine": 6, "reload": 0.94, "speed": 85, "kick": { "pitch": 0.66, "yaw": 0.006, "half": 0.07, "back": 0.15, "view": 0.06 }, "muzzle": { "intensity": 0.95, "frames": 2 },
            "sounds": { "fire": "weapon-pistol-shot", "reload": "weapon-pistol-reload", "impact": "impact-bone", "empty": "weapon-pistol-dry" } }),
        "shotgun" => json!({ "kind": "hitscan", "name": "Scattergun", "slot": 2, "damage": 9, "pellets": 8, "spread": 6, "auto": false, "fireInterval": 0.35, "magazine": 2, "reload": 1.22, "range": 40, "kick": { "pitch": 1.19, "yaw": 0.01, "half": 0.095, "back": 0.18, "view": 0.1 }, "muzzle": { "intensity": 1.8, "frames": 4, "sparks": 6 },
            "sounds": { "fire": "weapon-shotgun-shot", "reload": "weapon-shotgun-reload", "impact": "impact-bone", "empty": "weapon-shotgun-dry" } }),
        "repeater" => json!({ "kind": "hitscan", "name": "Repeater", "slot": 3, "damage": 10, "auto": true, "fireInterval": 0.108, "magazine": 40, "reload": 1.6, "spread": 1.2, "kick": { "pitch": 0.34, "yaw": 0.01, "half": 0.1, "back": 0.18, "view": 0.03 }, "muzzle": { "intensity": 1.2, "frames": 3, "smoke": 0 },
            "sounds": { "fire": "weapon-mg-shot", "reload": "weapon-mg-reload", "impact": "impact-bone", "empty": "weapon-mg-dry" } }),
        "blade" => json!({ "kind": "melee", "name": "Blade", "slot": 4, "damage": 40, "melee": { "reach": 2.2, "arc": 80, "windup": 0.045, "contact": 0.156, "recover": 0.25, "whoosh": 0.122 },
            "sounds": { "fire": "melee-swing", "swing": "melee-swing", "impact": "melee-hit" } }),
        _ => return None,
    })
}

/// `b` over `a`, deep for objects (the kit's deepMerge / fillWith).
pub fn merge(a: &Value, b: &Value) -> Value {
    match (a, b) {
        (Value::Object(x), Value::Object(y)) => {
            let mut out = x.clone();
            for (k, v) in y {
                let m = match out.get(k) {
                    Some(old @ Value::Object(_)) if v.is_object() => merge(old, v),
                    _ => v.clone(),
                };
                out.insert(k.clone(), m);
            }
            Value::Object(out)
        }
        (_, Value::Null) => a.clone(),
        _ => b.clone(),
    }
}

/// A row with every value: the kit's `rowBase('weapons', row)` then the row's own (`fillWith`).
pub fn fill(row: &Value) -> Value {
    let preset = row.get("preset").and_then(Value::as_str).and_then(preset_values);
    let kind = row.get("kind").and_then(Value::as_str).map(str::to_string).or_else(|| preset.as_ref().and_then(|p| p.get("kind")).and_then(Value::as_str).map(str::to_string)).unwrap_or_else(|| "projectile".into());
    let mut base = merge(&field_defaults(), &kind_values(&kind));
    if let Some(p) = &preset {
        base = merge(&base, p);
    }
    if let Value::Object(m) = &mut base {
        m.insert("kind".into(), Value::String(kind.clone()));
        if row.get("name").and_then(Value::as_str).is_none_or(str::is_empty) {
            let name = preset.as_ref().and_then(|p| p.get("name")).and_then(Value::as_str).map(str::to_string).or_else(|| row.get("id").and_then(Value::as_str).map(str::to_string)).unwrap_or_default();
            m.insert("name".into(), Value::String(name));
        }
    }
    merge(&base, row)
}

/// A JSON object as a table row.
pub fn row(v: Value) -> Row {
    match v {
        Value::Object(m) => Row(m),
        _ => Row(Map::new()),
    }
}

impl WeaponDef {
    /// A weapons row (filled here as the kit fills it, so a bare `{id, preset}` is the whole weapon).
    pub fn from_row(r: &Row) -> Self {
        let f = row(fill(&Value::Object(r.0.clone())));
        let n = |k: &str, lo: f32, hi: f32| f.num(k, 0.0).clamp(lo, hi);
        let s = |k: &str| f.str(k).unwrap_or("").to_string();
        let light = |p: &str| Light { color: f.color(&format!("{p}.color"), [1.0, 0.48, 0.13]), radius: n(&format!("{p}.radius"), 0.0, 30.0), intensity: n(&format!("{p}.intensity"), 0.0, 20.0), frames: f.int(&format!("{p}.frames"), 2).clamp(1, 30) as u32 };
        let kick_back = n("kick.back", 0.01, 2.0);
        let kick_half = n("kick.half", 0.005, 2.0).min(kick_back);
        let shape = recoil::fit(kick_half, kick_back);
        let kick_pitch = n("kick.pitch", 0.0, 20.0).to_radians();
        Self {
            id: s("id"),
            name: s("name"),
            kind: Kind::parse(f.str("kind").unwrap_or("projectile")),
            slot: f.int("slot", 1).clamp(1, 4) as u32,
            start: f.bool("start", true),
            damage: n("damage", 0.0, 10000.0),
            crit: n("critMultiplier", 1.0, 10.0),
            interval: n("fireInterval", 0.02, 10.0),
            auto: f.bool("auto", false),
            magazine: f.int("magazine", 0).clamp(0, 999) as u32,
            reload: n("reload", 0.0, 10.0),
            raise: n("raise", 0.0, 2.0),
            pellets: f.int("pellets", 1).clamp(1, 64) as u32,
            spread: n("spread", 0.0, 45.0).to_radians(),
            range: n("range", 1.0, 1000.0),
            speed: n("speed", 1.0, 1000.0),
            radius: n("radius", 0.0, 2.0),
            knockback: n("knockback", 0.0, 100.0),
            kick_pitch,
            kick_yaw: n("kick.yaw", 0.0, 5.0).to_radians(),
            kick_half,
            kick_back,
            shape,
            kick_impulse: if kick_pitch > 0.0 { kick_pitch / recoil::gain(shape).max(1e-4) } else { 0.0 },
            view_kick: n("kick.view", 0.0, 0.5),
            muzzle: light("muzzle"),
            sparks: f.int("muzzle.sparks", 0).clamp(0, 64) as u32,
            smoke: n("muzzle.smoke", 0.0, 2.0),
            impact: light("impact"),
            tracer: f.color("tracer", [1.0, 0.33, 0.05]),
            melee: Melee {
                reach: n("melee.reach", 0.2, 10.0),
                arc: n("melee.arc", 0.0, 360.0).to_radians(),
                windup: n("melee.windup", 0.0, 2.0),
                contact: n("melee.contact", 0.0, 2.0),
                recover: n("melee.recover", 0.0, 3.0),
                whoosh: n("melee.whoosh", 0.0, 2.0),
                targets: f.int("melee.targets", 3).clamp(1, 16) as u32,
            },
            sound_fire: s("sounds.fire"),
            sound_reload: s("sounds.reload"),
            sound_impact: s("sounds.impact"),
            sound_empty: s("sounds.empty"),
            sound_swing: s("sounds.swing"),
        }
    }

    /// The fire interval in whole steps (at least one).
    pub fn interval_steps(&self) -> f32 {
        (self.interval / STEP).max(1.0)
    }
}

/// For the parity test and tools: a JSON object `{presets: {name: filled row}, kinds: {kind: filled row}}`.
pub fn filled_examples() -> Value {
    let mut presets = Map::new();
    for p in ["pistol", "shotgun", "repeater", "blade"] {
        presets.insert(p.into(), fill(&json!({ "id": p, "preset": p })));
    }
    let mut kinds = Map::new();
    for k in ["hitscan", "projectile", "melee", "beam", "charge"] {
        kinds.insert(k.into(), fill(&json!({ "id": k, "kind": k })));
    }
    json!({ "presets": presets, "kinds": kinds })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn same(a: &Value, b: &Value, at: &str, out: &mut Vec<String>) {
        match (a, b) {
            (Value::Object(x), Value::Object(y)) => {
                for k in x.keys().chain(y.keys()) {
                    same(x.get(k).unwrap_or(&Value::Null), y.get(k).unwrap_or(&Value::Null), &format!("{at}.{k}"), out);
                }
            }
            (Value::Number(x), Value::Number(y)) => {
                if (x.as_f64().unwrap() - y.as_f64().unwrap()).abs() > 1e-9 {
                    out.push(format!("{at}: {x} vs {y}"));
                }
            }
            _ if a != b => out.push(format!("{at}: {a} vs {b}")),
            _ => {}
        }
    }

    /// Rust fills a row the way the kit does: every preset and kind, against what `tables.mjs --write` wrote from the
    /// kit's own fill().
    #[test]
    fn rust_fills_rows_like_the_kit() {
        let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../../fixtures/feel/data/weapons.json");
        let text = std::fs::read_to_string(path).expect("fixtures/feel/data/weapons.json (node research/gf-forge/tools/tables.mjs --write)");
        let kit: Value = serde_json::from_str(&text).unwrap();
        let mut diff = Vec::new();
        same(&filled_examples(), &kit, "weapons", &mut diff);
        assert!(diff.is_empty(), "the kit's weapons.js and weapon_defs.rs differ: {diff:?}");
    }

    #[test]
    fn presets_carry_the_measured_numbers() {
        let w = |p: &str| WeaponDef::from_row(&row(json!({ "id": p, "preset": p })));
        let (pistol, shotgun, rep, blade) = (w("pistol"), w("shotgun"), w("repeater"), w("blade"));
        assert_eq!((pistol.kind, pistol.magazine, shotgun.pellets, shotgun.magazine), (Kind::Projectile, 6, 8, 2));
        assert!((shotgun.kick_pitch.to_degrees() - 1.19).abs() < 1e-4 && (pistol.kick_pitch.to_degrees() - 0.66).abs() < 1e-4);
        assert!(rep.auto && (rep.interval_steps() - 12.96).abs() < 0.01);
        assert_eq!(blade.kind, Kind::Melee);
        assert!((blade.melee.contact - 0.156).abs() < 1e-6);
        assert!(pistol.shape.omega > shotgun.shape.omega || pistol.shape.snap > shotgun.shape.snap, "the pistol comes back sooner");
        let own = WeaponDef::from_row(&row(json!({ "id": "x", "preset": "pistol", "damage": 31, "kick": { "pitch": 2 } })));
        assert_eq!(own.damage, 31.0);
        assert!((own.kick_back - 0.15).abs() < 1e-6 && (own.kick_pitch.to_degrees() - 2.0).abs() < 1e-4, "a row's own value wins, the rest stays the preset's");
    }
}
