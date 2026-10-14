//! forge-feel, track F (research/rust-engine/PLAN.md §4): how the first-person game feels, data-driven from the tables
//! (`spec.forge.player`, `weapons`, `feel`) and measured against research/rust-engine/feel-targets.md by the native
//! fixtures in research/gf-forge/fixtures/feel/ (`node research/gf-forge/tools/fixtures.mjs feel`).
//!
//! - `controller`: the first-person controller, in place of the core's `core.move` (the first step's burst, the stop,
//!   the jump, the evade with its FOV punch and dip, stamina shared by jump and evade, head bob, landing dip) and the
//!   camera rig it writes every step (`feel.camera`: bob, dips, hurt jitter, recoil, FOV punch).
//! - `weapons`: the weapons table in hand: hitscan with pellets and spread, projectiles, beams and charged shots, held
//!   fire on whole steps, magazines, reloads and the empty auto-reload, switching, the recoil spring (`recoil`), the
//!   viewmodel's kick and sway, muzzle lights, sparks, smoke and sounds on the shot's own step; the quick melee and melee
//!   weapons (a swing over the gun with its hit window and arc); weapon pickups.
//! - `hits`: every hit's fan-out: the white body flash, damage numbers with a crit style, the combo and its draining
//!   timer, a flinch on the hit bone, the push; no hit-stop (the reference has none).
//! - `kills`: a kill bursts the body into physics bone pieces with dust, sparks and a coin that flies to its killer,
//!   with a 3-5 layer sound on the same step; flying pieces knock down and sever neighbours; a debris budget.
//! - `hurt`: the player taking damage (the red edge tint, the jitter, the thud, the low-health stages) and dying (a rule
//!   event to rules.js with the final blow; the last 8 s of hits for the results).
//! - `aim`: touch-friendly aim help (a setting per player).
//! - `dummy`: target dummies (static hurtbox bodies) for the feel room and fixtures.
//! - `view`: the feel view the JS host reads every frame (`gf/forge/feel.js` and the renderer's viewmodel).
//! - `fixture`: the feel fixture runner (per-frame camera samples, every event, feel measures).
//! - `perks` (wave 7, builds): perk cards (blast, burst, shockwave, thorns, aura, fury, lifesteal, ambush, rush),
//!   card families and their set bonuses, run on the host for the player who holds them.
//!
//! Plugs in through forge-core's ways in only (research/gf-forge/core/ARCHITECTURE.md): `core.move` replaced, systems
//! in the Feel, Physics, Post and Events stages, its own components and resources, command ops 64..=95, event kinds
//! 32..=39, entity kinds 16..=17, and a tables hook.
#![allow(clippy::type_complexity, clippy::too_many_arguments)]
pub mod aim;
pub mod cards;
pub mod config;
pub mod controller;
pub mod dummy;
pub mod fixture;
pub mod hits;
pub mod hurt;
pub mod kills;
pub mod perks;
pub mod recoil;
pub mod revive;
pub mod shop;
pub mod shove;
pub mod view;
pub mod watch;
pub mod weapon_defs;
pub mod weapons;

use std::sync::Arc;

use forge_core::schedule::Stage;
use forge_core::sim::Sim;
use forge_core::{Core, Plugin};

pub use config::Config;

/// F's command ops (`forge_core::cmd::FEEL_OPS`, 64..=95). Ints first, then floats (host.js `cmd.raw(op, ints, floats)`).
pub mod op {
    /// A player's weapons: id, then the weapon rows they hold (the first is drawn). An empty list empties their hands.
    pub const LOADOUT: u32 = 65;
    /// Give a weapon: id, row, draw it now (0/1).
    pub const GIVE: u32 = 66;
    /// Draw a weapon the player holds: id, row.
    pub const EQUIP: u32 = 67;
    /// A target dummy: (floats) x, y, z, yaw, hit points, seconds before it stands again (0: never).
    pub const DUMMY: u32 = 68;
    /// A weapon pickup: row; (floats) x, y, z, seconds before it is back (0: once).
    pub const PICKUP: u32 = 69;
    /// A player's settings: id, aim help (0 off, 1 touch, 2 mouse: the table says which are helped, 3 forced on).
    pub const SETTINGS: u32 = 70;
    /// Refill a player's ammunition: id (every weapon they hold).
    pub const REFILL: u32 = 71;
    /// A player starts over (a respawn, a new round): id. Clears the tint, stages, combo and recap; full ammunition.
    pub const RESET: u32 = 72;
    /// Remove every debris piece, coin and shot in flight.
    pub const CLEAR: u32 = 73;
    /// Wave 2. The reward: ints [1 open | 0 close, wave, seed low, seed high], floats [seconds (0: `deal.seconds`)].
    /// Every player is dealt three cards and chooses; it closes when all have, or the seconds ran out.
    pub const REWARD: u32 = 74;
    /// A player's choice: ints [player, which of their three (0..=2); anything else passes]. The host's core applies it.
    pub const PICK: u32 = 75;
    /// A card now: ints [player, card row] (the rules' own rewards, a test's loadout).
    pub const CARD: u32 = 76;
    /// A downed player back up: ints [player], floats [share of full health (0: `player.revive.health`)].
    pub const REVIVE: u32 = 77;
    /// Wave 3 (the governor, gf/forge/governor.js): how much of a kill's pieces this copy keeps when frames are
    /// short: floats [the share of `feel.kill.rest` that stays lying, the share of `feel.kill.budget` that flies]
    /// (each 0..=1; 1: the tables' own). This copy's own, like the pieces: never in a snapshot.
    pub const QUALITY: u32 = 78;
    /// Wave 7, track P (the pedlar's cart, `shop.rs`): ints [1 open | 0 close, wave, seed low, seed high, 1 with the
    /// reward], floats [seconds (0: `shop.seconds`)]. Every player is in the cart until they leave or the time is up.
    pub const SHOP: u32 = 88;
    /// A player at the cart: ints [player, item row, arg]. An item row buys it (arg: a hone's card by its place in the
    /// hand; a revive's friend): the host's core checks it (the cart, the stock, the coins, a target) and says `bought`
    /// or `buy-refused`. A card item's arg is the place (0..=2) of the card on show. `shop::LEAVE` (255) leaves the
    /// cart (Done). One op for both keeps the wasm smaller.
    pub const BUY: u32 = 89;
}

/// F's own event kinds (`forge_core::events` custom range 32..=39), 14 payload words each (floats as bits).
pub mod ev {
    /// A hit body flashes: target (net id), seconds, r, g, b (linear). The renderer draws the whole body flat in that
    /// colour for that long (feel target 7: white for 2-3 frames).
    pub const FLASH: u32 = 32;
    /// A streak: from x y z, to x y z, r g b (linear), seconds, width (m), source (net id). Pellets, hitscan rounds,
    /// beams.
    pub const TRACER: u32 = 33;
    /// A part comes off: target (net id), part (`Part`), pieces shed, x y z. The renderer hides that part's bones (the
    /// core collapses them in the bone palette too); forge-ai stops the attack it was making.
    pub const SEVER: u32 = 34;
    /// Knocked down: target (net id), seconds, dir x y z, by (net id). forge-ai stops its attack and lays it down for
    /// that long (its `fall` clip, then `rise`).
    pub const KNOCK: u32 = 35;
    /// A word floating in the world: name (a `Names` id), x y z, player (0: everyone), value.
    pub const LABEL: u32 = 36;
    /// A viewmodel cue on its exact step: player, what (`WEAPON_*`), weapon row, a, b.
    pub const WEAPON: u32 = 37;
}

/// `ev::WEAPON`'s `what`.
pub mod cue {
    pub const FIRE: u32 = 1;
    pub const RELOAD: u32 = 2;
    pub const RELOADED: u32 = 3;
    pub const SWITCH: u32 = 4;
    pub const SWING: u32 = 5;
    pub const CONTACT: u32 = 6;
    pub const EMPTY: u32 = 7;
}

/// F's entity kinds (16..=31 by agreement; ARCHITECTURE.md "Reserved numbers").
pub mod kinds {
    /// A coin flying to a player (type 0).
    pub const COIN: u8 = 16;
    /// A target dummy (type 0): a static body with hit regions, on the enemies' side.
    pub const TARGET: u8 = 17;
}

/// Debris piece types (`components::kind::DEBRIS`, `type_`): the renderer draws each with its model slot.
pub mod piece {
    pub const SKULL: u16 = 0;
    pub const RIBCAGE: u16 = 1;
    pub const BONE: u16 = 2;
    pub const SHORT_BONE: u16 = 3;
    pub const CHIP: u16 = 4;
}

/// The config as the systems share it (rebuilt at every tables load; cheap to clone).
#[derive(Clone, Default)]
pub struct Cfg(pub Arc<Config>);

pub fn cfg(sim: &Sim) -> Arc<Config> {
    sim.res.get::<Cfg>().map(|c| c.0.clone()).unwrap_or_else(|| Arc::new(Config::load(sim)))
}

/// A custom event's 14 words from up to 14 values: integers as they are, floats as their bits.
pub enum W {
    U(u32),
    F(f32),
}

pub fn custom(sim: &mut Sim, kind: u32, words: &[W]) {
    let mut w = [0u32; 14];
    for (i, x) in words.iter().take(14).enumerate() {
        w[i] = match x {
            W::U(u) => *u,
            W::F(f) => f.to_bits(),
        };
    }
    sim.emit(forge_core::events::Event::Custom { kind, words: w });
}

pub struct FeelPlugin;

impl Plugin for FeelPlugin {
    fn name(&self) -> &'static str {
        "feel"
    }
    fn install(&self, core: &mut Core) {
        let s = &mut core.schedule;
        // the weapon in hand is this crate's (`weapons::Arms::current` → `Wear::held` every step): the core's own
        // slot-key picker would disagree with a loadout, a pickup or a reload-cancelling switch
        s.set_enabled("core.held", false);
        // Feel: the controller in place of the core's walk, then aim help, then the weapons and what is in flight
        s.replace("core.move", controller::feel_move);
        s.add_after("core.move", "feel.aim", aim::feel_aim);
        s.add_after("feel.aim", "feel.weapons", weapons::feel_weapons);
        // wave 4 (watch then play): what each player's weapon is doing, in the byte a snapshot carries for a player,
        // and on a viewer's copy the watched player's weapon following it (watch.rs)
        s.add_after("feel.weapons", "feel.acts", watch::feel_acts);
        s.add_after("feel.acts", "feel.watch", watch::feel_watch);
        s.add_after("feel.watch", "feel.shots", weapons::feel_shots);
        s.add_after("feel.shots", "feel.pickups", weapons::feel_pickups);
        // wave 2: a joiner takes each player's cards, down state and reward from the host's snapshot before anything
        // moves; a shove starts on its player's own step, before the controller; then who is down and the revives, and
        // the reward's countdown
        s.add(Stage::Input, "feel.sync", cards::feel_sync);
        s.add_before("core.move", "feel.shoves", shove::feel_shoves);
        s.add_after("feel.pickups", "feel.revive", revive::feel_revive);
        s.add_after("feel.revive", "feel.reward", cards::feel_reward);
        // wave 7 (track P): the pedlar's cart counts down and closes (a joiner takes each purse and the cart in
        // feel.sync, with the cards)
        s.add_after("feel.reward", "feel.shop", shop::feel_shop);
        // Physics: hits push bodies before the character controller resolves them; kills burst into debris (and dummies
        // stand again) just before the rapier step, which takes the new bodies into its islands
        s.add_before("core.character", "feel.push", hits::feel_push);
        s.add_before("core.physics", "feel.kills", kills::feel_kills);
        s.add_before("core.physics", "feel.dummies", dummy::feel_dummies);
        // wave 7 (builds): the perks react to the step's evades, kills and hurts (the weapons' in Feel, forge-ai's in
        // Ai), and the aura burns; their own kills are broken into debris by feel.kills on the same step
        s.add_before("feel.kills", "feel.perks", perks::feel_perks);
        // Post: severed parts stay off the bone palette (after the animation writes it)
        s.add_after("core.anim", "feel.severed", kills::feel_severed);
        // Events: every hit's and kill's fan-out, the player's hurt, then the camera rig and the view last
        s.add(Stage::Events, "feel.debris", kills::feel_debris);
        s.add(Stage::Events, "feel.hits", hits::feel_hits);
        s.add(Stage::Events, "feel.hurt", hurt::feel_hurt);
        s.add(Stage::Events, "feel.late", kills::feel_late);
        s.add(Stage::Events, "feel.coins", kills::feel_coins);
        s.add(Stage::Events, "feel.camera", controller::feel_camera);
        s.add(Stage::Events, "feel.view", view::feel_view);
        // last: each player's bytes for the next snapshot (cards, the reward, down and revive)
        s.add(Stage::Events, "feel.told", cards::feel_told);
        core.on_command(op::LOADOUT, "feel.loadout", weapons::cmd_loadout);
        core.on_command(op::GIVE, "feel.give", weapons::cmd_give);
        core.on_command(op::EQUIP, "feel.equip", weapons::cmd_equip);
        core.on_command(op::DUMMY, "feel.dummy", dummy::cmd_dummy);
        core.on_command(op::PICKUP, "feel.pickup", weapons::cmd_pickup);
        core.on_command(op::SETTINGS, "feel.settings", aim::cmd_settings);
        core.on_command(op::REFILL, "feel.refill", weapons::cmd_refill);
        core.on_command(op::RESET, "feel.reset", hurt::cmd_reset);
        core.on_command(op::CLEAR, "feel.clear", kills::cmd_clear);
        core.on_command(op::REWARD, "feel.reward", cards::cmd_reward);
        core.on_command(op::PICK, "feel.pick", cards::cmd_pick);
        core.on_command(op::CARD, "feel.card", cards::cmd_card);
        core.on_command(op::REVIVE, "feel.revive", revive::cmd_revive);
        core.on_command(op::QUALITY, "feel.quality", kills::cmd_quality);
        core.on_command(op::SHOP, "feel.shop", shop::cmd_shop);
        core.on_command(op::BUY, "feel.buy", shop::cmd_buy);
        core.on_tables("feel.config", |sim| {
            let c = Config::load(sim);
            sim.res.insert(Cfg(Arc::new(c)));
            shop::retable(sim);
            weapons::rearm(sim);
            cards::retable(sim);
        });
        // before any tables load, the defaults
        let c = Config::load(&core.sim);
        core.sim.res.insert(Cfg(Arc::new(c)));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_plugin_replaces_the_walk_and_orders_its_systems() {
        let mut c = Core::new();
        assert!(c.add_plugin(&FeelPlugin));
        let sys = c.systems();
        let at = |n: &str| sys.iter().position(|s| s.ends_with(n)).unwrap_or_else(|| panic!("{n} in {sys:?}"));
        assert!(at("core.move") < at("feel.weapons") && at("feel.weapons") < at("core.character"));
        assert!(at("core.anim") < at("feel.severed") && at("feel.severed") < at("feel.hits"));
        assert!(at("core.character") < at("feel.kills") && at("feel.kills") < at("core.physics"));
        assert!(at("feel.hits") < at("feel.camera") && at("feel.camera") < at("feel.view"));
        assert_eq!(c.stage_of("feel.push"), Some(Stage::Physics));
    }
}
