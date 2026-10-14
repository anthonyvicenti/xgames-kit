//! forge-feel's exports (track F) for the JS host's feel side (gf/forge/feel.js: the crosshair, ammunition, damage
//! numbers, the combo, the red edge and low-health stages, the death recap) and for verify (check 16 reads the stats).
//! Commands go in through the usual buffer (`host.cmd.raw(op, ints, floats)` with `forge_feel::op`); events come out
//! through the usual ring (`forge_feel::ev` kinds 32..=37 decode as `custom-<kind>`).
//! Wave 2 (the game loop): `feel_run()` (the reward, and every player's cards, down and revive, as this copy holds
//! them), `feel_card_preview(player, card)` (what the card would change for that player, before → after: the reward
//! screen's inspector) and `feel_value(player, path)` (a table value as that player's cards leave it).
use wasm_bindgen::prelude::*;

use crate::Forge;

#[wasm_bindgen]
impl Forge {
    /// The local player's feel view: `forge_feel::view::field::COUNT` floats (names: `feel_view_names`).
    pub fn feel_view(&self) -> Vec<f32> {
        let s = self.s.borrow();
        s.core.sim.res.get::<forge_feel::view::FeelView>().map(|v| v.v.to_vec()).unwrap_or_else(|| forge_feel::view::FeelView::default().v.to_vec())
    }
    /// The feel view's field names, in order, comma separated.
    pub fn feel_view_names(&self) -> String {
        forge_feel::view::NAMES.join(",")
    }
    /// Shots, the hits and kills on the enemies' side (with the hits each kill took), debris (JSON).
    pub fn feel_stats(&self) -> String {
        forge_feel::view::stats_json(&self.s.borrow().core.sim)
    }
    /// A player's last seconds (JSON): `dead`, the final blow, the hits of `feel.death.recap` seconds, the best combo.
    pub fn feel_recap(&self, player: u32) -> String {
        forge_feel::hurt::recap_json(&self.s.borrow().core.sim, player)
    }
    /// The run as this copy holds it (JSON, forge-feel `cards::run_json`): {reward: {open, wave, index, left, seconds,
    /// choices: [{player, state, offers: [card row | null × 3], picked}]}, players: [{id, local, cards: [rows], down,
    /// alive, revive (0..1), reviver, weapons: [rows], hp, hpMax}], cards: [ids], notes}.
    pub fn feel_run(&self) -> String {
        forge_feel::cards::run_json(&self.s.borrow().core.sim)
    }
    /// What card row `card` would change for `player` (JSON, forge-feel `cards::preview`; "null": no such player or
    /// card): the inspector's before → after, from the code that applies the card.
    pub fn feel_card_preview(&self, player: u32, card: u32) -> String {
        let s = self.s.borrow();
        match s.core.player(player) {
            Some(e) => forge_feel::cards::preview(&s.core.sim, e, card.min(255) as u8).to_string(),
            None => "null".into(),
        }
    }
    /// Every player's run state, 6 floats each, by id: id, down (0/1: at zero health with a friend standing), the share
    /// of a revive done on them, who is reviving them (a player id, 0 nobody), cards held, alive (0/1). Cheap enough
    /// for every frame (the nameplates' down marker and revive ring).
    pub fn feel_players(&self) -> Vec<f32> {
        use forge_core::components::{Health, Player};
        let s = self.s.borrow();
        let w = &s.core.sim.world;
        let mut rows: Vec<[f32; 6]> = w
            .query::<(&Player, Option<&forge_feel::controller::Pilot>, Option<&forge_feel::cards::Build>, Option<&Health>)>()
            .iter()
            .map(|(p, pilot, b, h)| [p.id as f32, pilot.is_some_and(|x| x.downed) as u8 as f32, pilot.map(|x| x.revive.clamp(0.0, 1.0)).unwrap_or(0.0), pilot.map(|x| x.reviver).unwrap_or(0) as f32, b.map(|b| b.cards.len()).unwrap_or(0) as f32, h.is_none_or(|h| !h.dead) as u8 as f32])
            .collect();
        rows.sort_by(|a, b| a[0].total_cmp(&b[0]));
        rows.into_iter().flatten().collect()
    }
    /// A table value as `player`'s cards leave it ("player.walk", "weapons.sidearm.reload"); NaN: no such value.
    pub fn feel_value(&self, player: u32, path: &str) -> f64 {
        let s = self.s.borrow();
        s.core.player(player).and_then(|e| forge_feel::cards::value_of(&s.core.sim, e, path)).unwrap_or(f64::NAN)
    }
    /// Wave 7 (track P): the pedlar's cart for `player`, every frame (forge-feel `shop::state`, read by
    /// gf/forge/shop.js): open, seconds left, in the cart, purse, with the reward, the visit, the lap, the wave, the
    /// cart's seconds, the paid three (−1 none), the item count and this visit's purchases of each, the cards held and
    /// the hone level of each.
    pub fn feel_shop_state(&self, player: u32) -> Vec<f32> {
        forge_feel::shop::state(&self.s.borrow().core.sim, player)
    }
    /// What `player` pays for item `row` now (the lap's and this visit's growth in; NaN: no such item).
    pub fn feel_shop_price(&self, player: u32, row: u32) -> f64 {
        forge_feel::shop::price_for(&self.s.borrow().core.sim, player, row as usize).map(|p| p as f64).unwrap_or(f64::NAN)
    }
    /// The value at `path` for `player` were the card at `pos` in their hand honed one step more (the hone's
    /// inspector: `feel_value` is the before; NaN: no such card or value).
    pub fn feel_hone_value(&self, player: u32, pos: u32, path: &str) -> f64 {
        let s = self.s.borrow();
        s.core.player(player).and_then(|e| forge_feel::shop::value_honed(&s.core.sim, e, pos as usize, path)).unwrap_or(f64::NAN)
    }
    /// The feel's numbers JS needs (JSON): command ops, custom event kinds, viewmodel cues, entity kinds, piece types.
    pub fn feel_protocol(&self) -> String {
        use forge_feel::{cue, ev, kinds, op, piece};
        format!(
            "{{\"op\":{{\"loadout\":{},\"give\":{},\"equip\":{},\"dummy\":{},\"pickup\":{},\"settings\":{},\"refill\":{},\"reset\":{},\"clear\":{},\"reward\":{},\"pick\":{},\"card\":{},\"revive\":{},\"shop\":{},\"buy\":{}}},\"ev\":{{\"flash\":{},\"tracer\":{},\"sever\":{},\"knock\":{},\"label\":{},\"weapon\":{}}},\"cue\":{{\"fire\":{},\"reload\":{},\"reloaded\":{},\"switch\":{},\"swing\":{},\"contact\":{},\"empty\":{}}},\"kind\":{{\"coin\":{},\"target\":{}}},\"piece\":{{\"skull\":{},\"ribcage\":{},\"bone\":{},\"shortBone\":{},\"chip\":{}}}}}",
            op::LOADOUT, op::GIVE, op::EQUIP, op::DUMMY, op::PICKUP, op::SETTINGS, op::REFILL, op::RESET, op::CLEAR, op::REWARD, op::PICK, op::CARD, op::REVIVE, op::SHOP, op::BUY,
            ev::FLASH, ev::TRACER, ev::SEVER, ev::KNOCK, ev::LABEL, ev::WEAPON,
            cue::FIRE, cue::RELOAD, cue::RELOADED, cue::SWITCH, cue::SWING, cue::CONTACT, cue::EMPTY,
            kinds::COIN, kinds::TARGET,
            piece::SKULL, piece::RIBCAGE, piece::BONE, piece::SHORT_BONE, piece::CHIP
        )
    }
}
