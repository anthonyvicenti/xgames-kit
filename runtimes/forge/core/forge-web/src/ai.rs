//! forge-ai's exports (track A): what `gf/forge/ai.js` and the renderer read of the enemies, the director, the boss,
//! the bots and the navigation grid. Commands go the usual way (the packed command buffer, ops 96..=127:
//! forge-ai's lib.rs lists them), so nothing here writes.
//!
//! - `ai_view_ptr()` / `ai_fields()` / `ai_capacity()` / `ai_count()`: the AI view (forge_ai::view): field `f` of row
//!   `i` at `f × capacity + i`, re-read every tick (memory growth detaches old typed arrays). Eye glow colour and
//!   intensity, the hit flash, the state, flags, an orb's light per enemy and projectile, sorted by net id.
//! - `ai_director()`: phase, wave, waves, spawned, total, killed, alive, seconds, kills, waves started, attackers, mounds.
//! - `ai_boss()`: net id, hp, max, phase, phases, state, row, invulnerable (all 0: no boss).
//! - `ai_elites()` (wave 7): the elites raised, burns and fire on the ground (floats; forge_ai::elite::observe).
//! - `ai_bots()`: 8 floats a bot (id, mode, target net id, firing, fire presses, melee presses, evades, enabled).
//! - `ai_nav()` / `ai_nav_grid()`: the walkable grid (min x, min z, cell, w, h, free share, builds, field builds,
//!   cells learned; then one byte a cell, 1 blocked).
//! - `ai_archetypes()`: every enemy row as forge-ai typed it (JSON), for the host's bodies, clips and QA.
//! - `ai_profile(true)` (QA only): time forge-ai's systems and the core's a crowd costs with performance.now;
//!   `ai_profile_take()`: µs per step per system since the last take (JSON).
use forge_core::serde_json::{self, json};
use wasm_bindgen::prelude::*;

use super::Forge;

/// performance.now() in milliseconds (the page's clock; the profiler's).
fn perf_now() -> f64 {
    thread_local! {
        static NOW: Option<(JsValue, js_sys::Function)> = {
            let g = js_sys::global();
            js_sys::Reflect::get(&g, &JsValue::from_str("performance")).ok().and_then(|p| js_sys::Reflect::get(&p, &JsValue::from_str("now")).ok().and_then(|f| f.dyn_into::<js_sys::Function>().ok()).map(|f| (p, f)))
        };
    }
    NOW.with(|n| n.as_ref().and_then(|(p, f)| f.call0(p).ok()).and_then(|v| v.as_f64()).unwrap_or(0.0))
}

#[wasm_bindgen]
impl Forge {
    pub fn ai_view_ptr(&self) -> u32 {
        self.s.borrow().core.sim.res.get::<forge_ai::view::AiView>().map(|v| v.rows.as_ptr() as u32).unwrap_or(0)
    }
    pub fn ai_view_len(&self) -> u32 {
        self.s.borrow().core.sim.res.get::<forge_ai::view::AiView>().map(|v| v.rows.len() as u32).unwrap_or(0)
    }
    pub fn ai_count(&self) -> u32 {
        self.s.borrow().core.sim.res.get::<forge_ai::view::AiView>().map(|v| v.count as u32).unwrap_or(0)
    }
    pub fn ai_fields(&self) -> u32 {
        forge_ai::view::FIELDS as u32
    }
    pub fn ai_capacity(&self) -> u32 {
        forge_ai::view::CAPACITY as u32
    }
    pub fn ai_director(&self) -> Vec<f32> {
        self.s.borrow().core.sim.res.get::<forge_ai::view::AiView>().map(|v| v.director.to_vec()).unwrap_or_else(|| vec![0.0; forge_ai::view::DIRECTOR_FIELDS])
    }
    pub fn ai_boss(&self) -> Vec<f32> {
        self.s.borrow().core.sim.res.get::<forge_ai::view::AiView>().map(|v| v.boss.to_vec()).unwrap_or_else(|| vec![0.0; 8])
    }
    /// Wave 7: the elites as this copy knows them (forge_ai::elite::observe: raised by modifier, the young, splits,
    /// burn bites and their damage, ignitions, this wave's count, who burns and the fire on the ground; the host's: a
    /// joiner's is empty).
    pub fn ai_elites(&self) -> Vec<f32> {
        forge_ai::elite::observe(&self.s.borrow().core.sim)
    }
    pub fn ai_bots(&self) -> Vec<f32> {
        forge_ai::bots::observe(&self.s.borrow().core.sim)
    }
    pub fn ai_nav(&self) -> Vec<f32> {
        let s = self.s.borrow();
        let Some(n) = s.core.sim.res.get::<forge_ai::nav::Nav>() else { return vec![] };
        match n.grid.as_ref() {
            Some(g) => vec![g.min.x, g.min.y, g.cell, g.w as f32, g.h as f32, g.free_share(), n.builds as f32, n.field_builds as f32, n.learned as f32],
            None => vec![],
        }
    }
    pub fn ai_nav_grid(&self) -> Vec<u8> {
        let s = self.s.borrow();
        s.core.sim.res.get::<forge_ai::nav::Nav>().and_then(|n| n.grid.as_ref()).map(|g| g.blocked.iter().map(|b| *b as u8).collect()).unwrap_or_default()
    }
    pub fn ai_archetypes(&self) -> String {
        let s = self.s.borrow();
        let Some(r) = s.core.sim.res.get::<forge_ai::Roster>() else { return "[]".into() };
        let rows: Vec<_> = r
            .defs
            .iter()
            .enumerate()
            .map(|(i, d)| {
                json!({ "row": i, "id": d.id, "arch": d.arch.name(), "body": d.body, "height": d.height, "radius": d.radius, "scale": d.scale,
                    "eye": { "color": d.eye_color, "glow": d.eye_glow }, "shot": { "color": d.shot_color, "light": d.shot_light, "intensity": d.shot_intensity },
                    "health": d.health, "speed": d.speed, "phases": d.phases })
            })
            .collect();
        serde_json::to_string(&json!({ "enemies": rows, "waves": r.waves.len(), "notes": r.notes })).unwrap_or_default()
    }
    /// QA: time forge-ai's systems and the core's a crowd costs (animation, hurtboxes, the character controller,
    /// the rapier step) with performance.now. Off unless called; it stays on for the page.
    pub fn ai_profile(&self, on: bool) {
        if on {
            forge_ai::profile::install(&mut self.s.borrow_mut().core, perf_now);
        }
    }
    /// µs per step per system since the last take (JSON: steps, usPerStep, aiUsPerStep, wrappedUsPerStep).
    pub fn ai_profile_take(&self) -> String {
        forge_ai::profile::take(&mut self.s.borrow_mut().core.sim)
    }
}
