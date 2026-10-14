//! The feel values, typed from the tables at every load (`FeelPlugin`'s `feel.config` hook): the player row's evade,
//! stamina, head and hurt values and its first step (`spec.forge.player`, the kit's `tables/player.js`), and the feel
//! table (`spec.forge.feel`, the kit's `tables/feel.js`: combo, hits, kills and debris, aim assist, low health, death).
//! Defaults are the measured feel targets (research/rust-engine/feel-targets.md) and equal the kit's: a fixture without
//! tables plays like a game without a `forge` block (`tests::defaults_equal_the_kits`).
use forge_core::tables::Row;


/// The player's movement on top of forge-core's `PlayerTable` (walk, jump, gravity, body).
#[derive(Clone, Debug, PartialEq)]
pub struct Moves {
    /// The first step (feel target 2: 5.3 m/s at 27 ms): the share of the walk reached in a straight burst, and how long
    /// the burst takes; the rest closes exponentially, 90% at the table's `accelTime`.
    pub burst_share: f32,
    pub burst_time: f32,
    pub evade: Evade,
    pub stamina: Stamina,
    pub head: Head,
    pub hurt: Hurt,
    pub revive: Revive,
    pub sound_evade: String,
    pub sound_hurt: String,
    pub sound_switch: String,
    pub sound_death: String,
    pub sound_down: String,
    pub sound_revive: String,
}

/// Being down with friends alive (`player.revive`; wave 2): a friend within `range` holding interact for `time`
/// brings the player back at `health` of their full health; while down the look turns at `look` of its speed.
#[derive(Clone, Debug, PartialEq)]
pub struct Revive {
    pub time: f32,
    pub range: f32,
    pub health: f32,
    pub look: f32,
    /// Seconds nothing hurts a player just revived.
    pub grace: f32,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Evade {
    pub distance: f32,
    /// Seconds the dash is powered (its speed held); friction stops it after.
    pub time: f32,
    /// The most speed it may reach (the speed is solved from `distance`, then capped here).
    pub peak: f32,
    /// Seconds to near the top speed (an exponential rise).
    pub rise: f32,
    pub cooldown: f32,
    pub fov_punch: f32,
    pub fov_time: f32,
    pub dip: f32,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Stamina {
    pub max: f32,
    pub regen: f32,
    pub jump_cost: f32,
    pub evade_cost: f32,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Head {
    pub bob: f32,
    pub bob_rate: f32,
    pub land_dip: f32,
    pub land_time: f32,
    /// The eyes ride this much higher in the air (the measured eye apex is 1.18 m over a 1.13 m body arc) [E].
    pub jump_lift: f32,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Hurt {
    pub tint: f32,
    pub fade: f32,
    pub shake: f32,
    pub shake_rate: f32,
    /// Seconds a hit's shake lasts.
    pub shake_time: f32,
}

impl Moves {
    pub fn from_row(r: &Row) -> Self {
        let n = |k: &str, d: f32, lo: f32, hi: f32| r.num(k, d).clamp(lo, hi);
        let s = |k: &str, d: &str| r.str(k).unwrap_or(d).to_string();
        Self {
            burst_share: n("burst.share", 0.66, 0.0, 1.0),
            burst_time: n("burst.time", 0.025, 0.001, 1.0),
            evade: Evade {
                distance: n("evade.distance", 3.0, 0.0, 20.0),
                time: n("evade.time", 0.17, 0.02, 1.0),
                peak: n("evade.peak", 18.0, 0.0, 60.0),
                rise: n("evade.rise", 0.035, 0.002, 0.5),
                cooldown: n("evade.cooldown", 1.4, 0.0, 10.0),
                fov_punch: n("evade.fovPunch", 2.6, 0.0, 20.0),
                fov_time: n("evade.fovTime", 0.165, 0.0, 2.0),
                dip: n("evade.dip", 0.09, 0.0, 0.5),
            },
            stamina: Stamina { max: n("stamina.max", 2.0, 0.0, 10.0), regen: n("stamina.regen", 0.7, 0.0, 10.0), jump_cost: n("stamina.jumpCost", 0.0, 0.0, 10.0), evade_cost: n("stamina.evadeCost", 1.0, 0.0, 10.0) },
            head: Head { bob: n("bob.amount", 0.01, 0.0, 0.1), bob_rate: n("bob.rate", 4.2, 0.0, 10.0), land_dip: n("bob.landDip", 0.014, 0.0, 0.2), land_time: n("bob.landTime", 0.15, 0.0, 1.0), jump_lift: n("bob.jumpLift", 0.045, 0.0, 0.3) },
            hurt: Hurt { tint: n("hurt.tint", 0.6, 0.0, 1.0), fade: n("hurt.fade", 1.5, 0.0, 10.0), shake: n("hurt.shake", 0.016, 0.0, 0.2), shake_rate: n("hurt.shakeRate", 12.0, 0.0, 60.0), shake_time: n("hurt.shakeTime", 0.25, 0.0, 2.0) },
            revive: Revive { time: n("revive.time", 2.0, 0.1, 30.0), range: n("revive.range", 2.0, 0.5, 20.0), health: n("revive.health", 0.4, 0.01, 1.0), look: n("revive.look", 0.35, 0.0, 1.0), grace: n("revive.grace", 1.5, 0.0, 10.0) },
            sound_evade: s("sounds.evade", "evade"),
            sound_hurt: s("sounds.hurt", "hurt"),
            sound_switch: s("sounds.switch", "weapon-switch"),
            sound_death: s("sounds.death", "player-death"),
            sound_down: s("sounds.down", "player-down"),
            sound_revive: s("sounds.revive", "player-revive"),
        }
    }
}

impl Default for Moves {
    fn default() -> Self {
        Self::from_row(&Row::default())
    }
}

/// The feel table (`spec.forge.feel`).
#[derive(Clone, Debug, PartialEq)]
pub struct Feel {
    pub combo_window: f32,
    pub combo_step: f32,
    pub combo_max: f32,
    /// Damage multipliers by region: body (torso, pelvis, none), arms, legs. A critical region (a head) takes the
    /// weapon's critical multiplier instead.
    pub regions: [f32; 3],
    pub flash: f32,
    pub flash_color: [f32; 3],
    pub numbers: bool,
    pub kill: Kill,
    pub aim: Aim,
    pub low: [f32; 3],
    pub sound_low: String,
    pub recap: f32,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Kill {
    /// Pieces a kill breaks into when its enemy row says nothing (feel target 8: 40-55).
    pub pieces: u32,
    /// The most debris pieces flying at once (bodies the physics steps; phones hold 60 fps): the oldest go first.
    pub budget: u32,
    /// The most pieces resting on the ground (wave 2: asleep, no physics; the oldest fade out over `rest_fade` s).
    pub rest: u32,
    pub rest_fade: f32,
    /// The burst's outward speed, m/s.
    pub burst: f32,
    /// A piece this fast or faster knocks down the enemy it hits, and severs the part it hits.
    pub knock_speed: f32,
    pub knock_time: f32,
    pub knock_damage: f32,
    /// Pieces a severed enemy sheds (feel target 8: about 30).
    pub shed: u32,
    pub coins: bool,
    pub coin_value: f32,
    pub sounds: Vec<String>,
    pub sound_coin: String,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Aim {
    /// On for touch players / for mouse players (the host says which a player is).
    pub touch: bool,
    pub mouse: bool,
    /// Degrees from the aim a target is helped within.
    pub cone: f32,
    /// The share of the gap the look closes a second while a target is in the cone.
    pub pull: f32,
    pub range: f32,
}

impl Feel {
    pub fn from_row(r: &Row) -> Self {
        let n = |k: &str, d: f32, lo: f32, hi: f32| r.num(k, d).clamp(lo, hi);
        let s = |k: &str, d: &str| r.str(k).unwrap_or(d).to_string();
        // a kill's layered break (feel target 8: 3-5 buffers on one frame); the enemy row's own `sounds.die` is another
        let mut sounds: Vec<String> = [("kill.sounds.crack", "bone-break"), ("kill.sounds.shatter", "bone-shatter"), ("kill.sounds.knock", "impact-bone")].iter().map(|(k, d)| s(k, d)).collect();
        sounds.retain(|x| !x.is_empty());
        Self {
            combo_window: n("combo.window", 2.5, 0.1, 30.0),
            combo_step: n("combo.step", 0.1, 0.0, 5.0),
            combo_max: n("combo.max", 5.0, 1.0, 100.0),
            regions: [n("regions.body", 1.0, 0.0, 10.0), n("regions.arms", 0.8, 0.0, 10.0), n("regions.legs", 0.8, 0.0, 10.0)],
            flash: n("hits.flash", 0.042, 0.0, 1.0),
            flash_color: r.color("hits.flashColor", [1.0, 1.0, 1.0]),
            numbers: r.bool("hits.numbers", true),
            kill: Kill {
                pieces: r.int("kill.pieces", 48).clamp(0, 200) as u32,
                budget: r.int("kill.budget", 160).clamp(0, 2000) as u32,
                rest: r.int("kill.rest", 400).clamp(0, 1500) as u32,
                rest_fade: n("kill.restFade", 0.6, 0.0, 10.0),
                burst: n("kill.burst", 4.5, 0.0, 60.0),
                knock_speed: n("kill.knockSpeed", 4.0, 0.0, 100.0),
                knock_time: n("kill.knockTime", 1.2, 0.0, 10.0),
                knock_damage: n("kill.knockDamage", 10.0, 0.0, 10000.0),
                shed: r.int("kill.shed", 30).clamp(0, 200) as u32,
                coins: r.bool("kill.coins", true),
                coin_value: n("kill.coinValue", 1.0, 0.0, 10000.0),
                sounds,
                sound_coin: s("kill.sounds.coin", "pickup-coin"),
            },
            aim: Aim { touch: r.bool("aimAssist.touch", true), mouse: r.bool("aimAssist.mouse", false), cone: n("aimAssist.cone", 6.0, 0.0, 45.0), pull: n("aimAssist.pull", 3.0, 0.0, 30.0), range: n("aimAssist.range", 30.0, 1.0, 500.0) },
            low: [n("lowHealth.stage1", 0.15, 0.0, 1.0), n("lowHealth.stage2", 0.10, 0.0, 1.0), n("lowHealth.stage3", 0.05, 0.0, 1.0)],
            sound_low: s("lowHealth.sound", "player-lowhealth"),
            recap: n("death.recap", 8.0, 0.0, 60.0),
        }
    }
    /// The damage multiplier of a hit on `part` (`crit`: the weapon's critical multiplier).
    pub fn region(&self, part: forge_core::components::Part, crit: bool, crit_mult: f32) -> f32 {
        use forge_core::components::Part::*;
        if crit {
            return crit_mult;
        }
        match part {
            UpperArmL | ForearmL | UpperArmR | ForearmR => self.regions[1],
            ThighL | ShinL | ThighR | ShinR => self.regions[2],
            _ => self.regions[0],
        }
    }
    /// The low-health stage for a health share (0 none, 1 at 15%, 2 at 10%, 3 at 5%).
    pub fn stage(&self, share: f32) -> u8 {
        if share <= 0.0 {
            return 0;
        }
        (if share <= self.low[2] { 3 } else if share <= self.low[1] { 2 } else if share <= self.low[0] { 1 } else { 0 }) as u8
    }
}

impl Default for Feel {
    fn default() -> Self {
        Self::from_row(&Row::default())
    }
}

/// Everything the feel systems read: the tables' (rebuilt at every tables load), or one player's own, the tables'
/// with the cards that player holds (`cards::Build`, `cards::of`).
#[derive(Clone, Debug, Default)]
pub struct Config {
    /// The player's walk, jump and body (forge-core's `PlayerTable`; a player's own after their cards).
    pub player: forge_core::tables::PlayerTable,
    pub moves: Moves,
    pub feel: Feel,
    pub weapons: Vec<crate::weapon_defs::WeaponDef>,
    /// The first melee weapon's row (the quick melee swings it), or None: the built-in blade.
    pub quick_melee: Option<usize>,
    pub blade: Option<crate::weapon_defs::WeaponDef>,
    pub evade_peak: f32,
    pub version: u32,
    /// The cards table and the deal's values (wave 2).
    pub cards: std::sync::Arc<Vec<crate::cards::CardDef>>,
    pub deal: crate::cards::DealCfg,
    /// The rows a card's value path points into, every value present.
    pub base: std::sync::Arc<crate::cards::Base>,
    /// What the tables name that nothing here can do (a card's path no row has).
    pub notes: Vec<String>,
    /// Wave 7 (builds): the families table (`spec.forge.families`), whether any card or set bonus is a perk (else the
    /// perks' step does nothing), and the perks, family counts and set bonuses this player's cards hold (`perks::held`;
    /// the tables' own config holds none).
    pub families: std::sync::Arc<Vec<crate::perks::FamilyDef>>,
    pub any_perks: bool,
    pub perks: crate::perks::Held,
}

impl Config {
    pub fn load(sim: &forge_core::sim::Sim) -> Self {
        let moves = Moves::from_row(&sim.tables.player_row);
        let feel = Feel::from_row(&sim.tables.raw.row("feel").unwrap_or_default());
        let weapons: Vec<_> = sim.tables.weapons.iter().map(crate::weapon_defs::WeaponDef::from_row).collect();
        let quick_melee = weapons.iter().position(|w| w.kind == crate::weapon_defs::Kind::Melee);
        let blade = Some(crate::weapon_defs::WeaponDef::from_row(&crate::weapon_defs::row(serde_json::json!({ "id": "blade", "preset": "blade" }))));
        let p = &sim.tables.player;
        let stop_k = std::f32::consts::LN_10 / p.stop_time.max(1e-3);
        let evade_peak = evade_speed(&moves.evade, stop_k);
        let base = crate::cards::Base::load(sim);
        let deal = crate::cards::DealCfg::from_row(&sim.tables.raw.row("deal").unwrap_or_default());
        let families: Vec<_> = sim.tables.raw.rows("families").iter().map(crate::perks::FamilyDef::from_row).collect();
        let mut cards: Vec<_> = sim.tables.cards.iter().map(|r| crate::cards::CardDef::from_row(r, &sim.tables.weapons)).collect();
        // a card's family by its id, and the deal's lean toward families held
        for (c, r) in cards.iter_mut().zip(sim.tables.cards.iter()) {
            c.family = r.str("family").and_then(|id| families.iter().position(|f| f.id == id));
            c.bias = deal.family_bias;
        }
        let any_perks = cards.iter().any(|c| c.perk.is_some()) || families.iter().any(|f| f.bonus.is_some());
        let notes = crate::cards::notes(&base, &cards);
        Self { player: p.clone(), moves, feel, weapons, quick_melee, blade, evade_peak, version: sim.tables.version, cards: std::sync::Arc::new(cards), deal, base: std::sync::Arc::new(base), notes, families: std::sync::Arc::new(families), any_perks, perks: Default::default() }
    }

    /// One player's values: `rows` (the tables' rows with their cards applied) read as the tables are, the rest the
    /// tables' own.
    pub fn from_rows(rows: &crate::cards::Base, global: &Config) -> Self {
        use crate::weapon_defs::row;
        let player_row = row(rows.player.clone());
        let player = forge_core::tables::PlayerTable::from_row(&player_row);
        let moves = Moves::from_row(&player_row);
        let weapons: Vec<_> = rows.weapons.iter().map(|w| crate::weapon_defs::WeaponDef::from_row(&row(w.clone()))).collect();
        let evade_peak = evade_speed(&moves.evade, std::f32::consts::LN_10 / player.stop_time.max(1e-3));
        Self { player, moves, weapons, evade_peak, feel: global.feel.clone(), quick_melee: global.quick_melee, blade: global.blade.clone(), version: global.version, cards: global.cards.clone(), deal: global.deal.clone(), base: global.base.clone(), notes: Vec::new(), families: global.families.clone(), any_perks: global.any_perks, perks: Default::default() }
    }
}

use forge_core::serde_json;

/// The dash's top speed that carries the evade its `distance`, counted step by step as the controller moves it: driven
/// for `time` (whole steps) with an exponential rise (`rise`), then stopped by the ground's friction (rate `stop_k`);
/// capped at `peak`.
pub fn evade_speed(e: &Evade, stop_k: f32) -> f32 {
    let dt = forge_core::STEP;
    let n = (e.time / dt).round().max(1.0) as u32;
    let rise = |k: u32| 1.0 - (-(k as f32) * dt / e.rise.max(1e-3)).exp();
    let driven: f32 = (1..=n).map(|k| rise(k) * dt).sum();
    let q = (-stop_k.max(1e-3) * dt).exp();
    let slide = rise(n) * dt * q / (1.0 - q);
    let unit = driven + slide;
    if unit <= 0.0 {
        return 0.0;
    }
    (e.distance / unit).min(e.peak)
}


#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_evade_solves_its_top_speed_from_its_distance() {
        let e = Moves::default().evade;
        let p = evade_speed(&e, std::f32::consts::LN_10 / 0.09);
        assert!((17.3..=17.8).contains(&p), "{p}");
        let far = Evade { distance: 6.0, peak: 60.0, ..e };
        assert!(evade_speed(&far, 25.6) > 30.0);
    }

    #[test]
    fn stages_follow_the_health_share() {
        let f = Feel::default();
        assert_eq!([f.stage(0.5), f.stage(0.15), f.stage(0.1), f.stage(0.04), f.stage(0.0)], [0, 1, 2, 3, 0]);
    }
}
