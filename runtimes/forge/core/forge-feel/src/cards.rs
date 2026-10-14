//! Cards (wave 2, the game loop; `spec.forge.cards` and `spec.forge.deal`, the kit's `tables/cards.js`): what a run's
//! rewards do to one player, the seeded deal, and the reward between waves.
//!
//! - **A card** is an upgrade (one or two table values changed: `stat` + `add` then `mul`, and `stat2`), a weapon (the
//!   player gets that weapons row and draws it) or a heal (`add` hit points and `share` of full health, at once). A
//!   value's path is the table's own: `player.walk`, `player.evade.cooldown`, `player.stamina.evadeCost`,
//!   `player.health`, `weapons.sidearm.damage`, or `weapons.*.reload` for every weapon the table has.
//! - **Each player has a build** (`Build`: the cards held, in the order taken). Its values are the tables' rows with
//!   every upgrade applied in that order (cards stack), read back through the same `from_row` the tables load with, so
//!   units, ranges and derived numbers (the recoil spring, the evade's speed) follow. Every feel system reads the
//!   player's own `Config` (`of`): the controller, the weapons, the shots in flight, the view.
//! - **Snapshots carry the build** (forge-core `SnapBlob`, `blob` / `sync`): a joiner's copy holds the same cards for
//!   every player, its own included, so its prediction walks, evades and fires with the values the host simulates
//!   with (else every step of a faster walk would be corrected).
//! - **The deal** (`deal`) is a pure function of the run's seed, the player, which reward of the run it is and what the
//!   player holds: three cards drawn without putting back, each card's `weight` times its rarity's (`deal.common`,
//!   `rare`, `epic`). The same seed deals the same hand on every copy; players get different hands.
//! - **The reward** (`Reward`, the host's): `op::REWARD` opens it (every player is dealt three and is choosing), a
//!   player's `op::PICK` takes one of theirs or passes, and it closes when everyone has chosen or `deal.seconds` ran
//!   out (the undecided pass). Rule events for rules.js and the kit's screen (gf/forge/cards.js): `reward-open` {a:
//!   wave, b: seconds}, `card-picked` {entity: player, a: card row, b: which of the three, c: wave}, `card-passed`
//!   {entity}, `reward-done` {a: wave, b: picked, c: passed}, and `card` {entity, a: card row, b: held} whenever a
//!   player gains one (a pick, or `op::CARD`).
//! - **The inspector** (`preview`): exactly what a card would change for a player, before → after, computed by the
//!   code that applies it.
use std::collections::BTreeMap;
use std::sync::Arc;

use forge_core::cmd;
use forge_core::components::*;
use forge_core::hecs::Entity;
use forge_core::serde_json::{self, json, Map, Value};
use forge_core::sim::{Rng, Sim};
use forge_core::snapshot::SnapBlob;
use forge_core::tables::Row;
use forge_core::STEP;

use crate::config::Config;
use crate::controller::Pilot;
use crate::weapon_defs::{self, Kind};
use crate::weapons::Arms;

pub const NO_CARD: u8 = 255;
/// The most cards one player holds (the snapshot's blob carries them).
pub const MAX_CARDS: usize = 32;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CardKind {
    Upgrade,
    Weapon,
    Heal,
    /// Wave 7 (builds): changes how the player fights (`perks.rs`); it may carry a trade's upgrades too.
    Perk,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Effect {
    pub path: String,
    pub add: f32,
    pub mul: f32,
}

#[derive(Clone, Debug, PartialEq)]
pub struct CardDef {
    pub id: String,
    pub name: String,
    pub kind: CardKind,
    /// 0 common, 1 rare, 2 epic.
    pub rarity: u8,
    pub weight: f32,
    /// The most copies one player holds.
    pub stack: u32,
    /// A weapon card's weapons row.
    pub weapon: Option<usize>,
    pub effects: Vec<Effect>,
    /// A heal card: hit points, and a share of full health.
    pub heal: f32,
    pub heal_share: f32,
    /// The weapons rows its values name one by one ("weapons.scatter.pellets": that row). A card that only changes
    /// weapons its player does not hold is not dealt to them.
    pub needs: Vec<usize>,
    /// Wave 7 (builds). Its family's row in `spec.forge.families` (resolved at the tables' load: `Config::load`).
    pub family: Option<usize>,
    /// The deal's lean toward a family the player holds (`deal.familyBias`, copied in at the load so `deal` keeps its
    /// inputs; 1: none).
    pub bias: f32,
    /// A perk card's perk (`perks.rs`).
    pub perk: Option<crate::perks::PerkDef>,
}

impl CardDef {
    pub fn from_row(r: &Row, weapons: &[Row]) -> Self {
        let kind = match r.str("kind").unwrap_or("upgrade") {
            "weapon" => CardKind::Weapon,
            "heal" => CardKind::Heal,
            "perk" => CardKind::Perk,
            _ => CardKind::Upgrade,
        };
        let rarity = match r.str("rarity").unwrap_or("common") {
            "rare" => 1,
            "epic" => 2,
            _ => 0,
        };
        let mut effects = Vec::new();
        if kind == CardKind::Upgrade || kind == CardKind::Perk {
            for (s, a, m) in [("stat", "add", "mul"), ("stat2", "add2", "mul2")] {
                let path = r.str(s).unwrap_or("").trim().to_string();
                if !path.is_empty() {
                    effects.push(Effect { path, add: r.num(a, 0.0), mul: r.num(m, 1.0).max(0.0) });
                }
            }
        }
        let weapon = (kind == CardKind::Weapon).then(|| r.str("weapon").and_then(|id| weapons.iter().position(|w| w.id() == id))).flatten();
        let named = |path: &str| -> Option<Option<usize>> {
            let mut it = path.split('.');
            match (it.next(), it.next()) {
                (Some("weapons"), Some(id)) if id != "*" => Some(weapons.iter().position(|w| w.id() == id)),
                _ => None,
            }
        };
        // every value names one weapon: the card needs one of them in hand (a value of the player's, or of every
        // weapon, makes it a card for anyone)
        let each: Vec<Option<Option<usize>>> = effects.iter().map(|e| named(&e.path)).collect();
        let mut needs: Vec<usize> = if !each.is_empty() && each.iter().all(Option::is_some) { each.into_iter().flatten().flatten().collect() } else { Vec::new() };
        needs.sort_unstable();
        needs.dedup();
        Self {
            id: r.id().to_string(),
            name: r.str("name").unwrap_or(r.id()).to_string(),
            kind,
            rarity,
            weight: r.num("weight", 1.0).clamp(0.0, 100.0),
            stack: r.int("stack", 3).clamp(1, 9) as u32,
            weapon,
            effects,
            heal: if kind == CardKind::Heal { r.num("add", 0.0).max(0.0) } else { 0.0 },
            heal_share: if kind == CardKind::Heal { r.num("share", 0.0).clamp(0.0, 1.0) } else { 0.0 },
            needs,
            family: None,
            bias: 1.0,
            perk: if kind == CardKind::Perk { crate::perks::PerkDef::from_row(r, "") } else { None },
        }
    }
}

/// The deal's values (`spec.forge.deal`): the seconds a reward stays open and each rarity's weight.
#[derive(Clone, Debug, PartialEq)]
pub struct DealCfg {
    pub seconds: f32,
    pub rarity: [f32; 3],
    /// Seconds the reward stays up after the last choice (the chosen card's lift).
    pub linger: f32,
    /// Wave 7: a card of a family the player already holds is dealt this many times as often (`familyBias`).
    pub family_bias: f32,
}

impl DealCfg {
    pub fn from_row(r: &Row) -> Self {
        Self { seconds: r.num("seconds", 20.0).clamp(1.0, 600.0), rarity: [r.num("common", 60.0).max(0.0), r.num("rare", 30.0).max(0.0), r.num("epic", 10.0).max(0.0)], linger: r.num("linger", 0.6).clamp(0.0, 5.0), family_bias: r.num("familyBias", 2.0).clamp(0.0, 20.0) }
    }
}

impl Default for DealCfg {
    fn default() -> Self {
        Self::from_row(&Row::default())
    }
}

/// The rows a card's path points into, every value present: the player's row and each weapons row filled.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Base {
    pub player: Value,
    pub weapons: Vec<Value>,
}

/// Natively (fixtures, tests) a table may be partial: the kit's own defaults fill the player's row, as `create` does
/// for a game. In the browser the kit always sends filled tables, and nothing of the kit is compiled into the wasm.
#[cfg(not(target_arch = "wasm32"))]
fn kit_player_defaults() -> Value {
    serde_json::from_str::<Value>(include_str!("../../../kit/tables/defaults.json")).ok().and_then(|v| v.get("player").cloned()).unwrap_or(Value::Object(Map::new()))
}
#[cfg(target_arch = "wasm32")]
fn kit_player_defaults() -> Value {
    Value::Object(Map::new())
}

impl Base {
    pub fn load(sim: &Sim) -> Self {
        let player = weapon_defs::merge(&kit_player_defaults(), &Value::Object(sim.tables.player_row.0.clone()));
        let weapons = sim.tables.weapons.iter().map(|r| weapon_defs::fill(&Value::Object(r.0.clone()))).collect();
        Self { player, weapons }
    }
}

fn get<'a>(v: &'a Value, path: &str) -> Option<&'a Value> {
    let mut cur = v;
    for k in path.split('.') {
        cur = cur.as_object()?.get(k)?;
    }
    Some(cur)
}

fn get_mut<'a>(v: &'a mut Value, path: &str) -> Option<&'a mut Value> {
    let mut cur = v;
    for k in path.split('.') {
        cur = cur.as_object_mut()?.get_mut(k)?;
    }
    Some(cur)
}

/// The weapon fields that are whole numbers (kit/tables/weapons.js: its `int` fields; held to it by
/// research/gf-three/tests/s-forge.test.mjs). No player field is.
pub const WHOLE_WEAPON: [&str; 7] = ["slot", "magazine", "pellets", "muzzle.frames", "muzzle.sparks", "impact.frames", "melee.targets"];

/// `(old + add) × mul`, kept whole where the field is a whole number (a magazine, a pellet count). Not where the
/// table merely wrote a whole value: a critical multiplier of 2 with 0.75 added is 2.75, and damage 9 × 1.5 is 13.5
/// (until wave 4 both were rounded, and an evade cost of 1 × 0.6 stayed 1: half a card did nothing).
fn changed(old: &Value, e: &Effect, whole: bool) -> Option<Value> {
    let x = old.as_f64()?;
    let y = (x + e.add as f64) * e.mul as f64;
    if !y.is_finite() {
        return None;
    }
    Some(if whole { json!(y.round().max(0.0) as i64) } else { json!((y * 1e5).round() / 1e5) })
}

/// The rows an effect's path names: (the concrete path, the row it is in, the path inside that row).
fn places<'a>(base: &'a Base, path: &'a str) -> Vec<(String, Place, &'a str)> {
    let mut it = path.splitn(2, '.');
    let (table, rest) = (it.next().unwrap_or(""), it.next().unwrap_or(""));
    match table {
        "player" if !rest.is_empty() => vec![(path.to_string(), Place::Player, rest)],
        "weapons" => {
            let mut jt = rest.splitn(2, '.');
            let (id, field) = (jt.next().unwrap_or(""), jt.next().unwrap_or(""));
            if field.is_empty() {
                return Vec::new();
            }
            base.weapons.iter().enumerate().filter(|(_, w)| id == "*" || w.get("id").and_then(Value::as_str) == Some(id)).map(|(i, w)| (format!("weapons.{}.{}", w.get("id").and_then(Value::as_str).unwrap_or("?"), field), Place::Weapon(i), field)).collect()
        }
        _ => Vec::new(),
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Place {
    Player,
    Weapon(usize),
}

fn row_mut(base: &mut Base, p: Place) -> Option<&mut Value> {
    match p {
        Place::Player => Some(&mut base.player),
        Place::Weapon(i) => base.weapons.get_mut(i),
    }
}
fn row_of(base: &Base, p: Place) -> Option<&Value> {
    match p {
        Place::Player => Some(&base.player),
        Place::Weapon(i) => base.weapons.get(i),
    }
}

/// One upgrade applied to the rows. → the values it changed: (the concrete path, before, after).
pub fn apply_effect(base: &mut Base, e: &Effect) -> Vec<(String, f64, f64)> {
    let list: Vec<(String, Place, String)> = places(base, &e.path).into_iter().map(|(a, b, c)| (a, b, c.to_string())).collect();
    let mut out = Vec::new();
    for (full, place, field) in list {
        let Some(slot) = row_mut(base, place).and_then(|r| get_mut(r, &field)) else { continue };
        let whole = matches!(place, Place::Weapon(_)) && WHOLE_WEAPON.contains(&field.as_str());
        let Some(next) = changed(slot, e, whole) else { continue };
        let (a, b) = (slot.as_f64().unwrap_or(0.0), next.as_f64().unwrap_or(0.0));
        *slot = next;
        out.push((full, a, b));
    }
    out
}

/// The rows with every upgrade of `cards` applied, in the order held.
pub fn with_cards(base: &Base, defs: &[CardDef], cards: &[u8]) -> Base {
    with_cards_honed(base, defs, cards, &[])
}

/// The rows with every upgrade of `cards` applied, in the order held, each at its factor by its place in the hand
/// (wave 7, track P: a card honed at the pedlar's cart, `shop.rs`; missing: 1). At factor f a card's `add` is × f and
/// its multiplier is raised to the power f.
pub fn with_cards_honed(base: &Base, defs: &[CardDef], cards: &[u8], factors: &[f32]) -> Base {
    let mut b = base.clone();
    for (i, c) in cards.iter().enumerate() {
        if let Some(d) = defs.get(*c as usize) {
            let f = factors.get(i).copied().unwrap_or(1.0);
            for e in &d.effects {
                if (f - 1.0).abs() < 1e-6 {
                    apply_effect(&mut b, e);
                } else {
                    apply_effect(&mut b, &Effect { path: e.path.clone(), add: e.add * f, mul: e.mul.max(0.0).powf(f) });
                }
            }
        }
    }
    b
}

/// A value by its path in rows (`player.walk`, `weapons.sidearm.damage`).
pub fn value(base: &Base, path: &str) -> Option<f64> {
    let (_, place, field) = places(base, path).into_iter().next()?;
    get(row_of(base, place)?, field)?.as_f64()
}

/// A player's cards and the values they give (this crate's component on every player, on every copy).
#[derive(Clone, Debug, Default)]
pub struct Build {
    pub cards: Vec<u8>,
    pub cfg: Option<Arc<Config>>,
    /// The tables' load the values were made from.
    pub version: u32,
}

impl Build {
    pub fn count(&self, card: u8) -> u32 {
        self.cards.iter().filter(|c| **c == card).count() as u32
    }
}

/// The feel values one player plays with: the tables', changed by the cards they hold.
pub fn of(sim: &Sim, e: Entity) -> Arc<Config> {
    if let Ok(b) = sim.world.get::<&Build>(e)
        && let Some(c) = &b.cfg
    {
        return c.clone();
    }
    crate::cfg(sim)
}

/// Make a player's values again from the cards it holds (after a pick, a snapshot's cards, a tables load).
fn rebuild(global: &Config, cards: &[u8], factors: &[f32]) -> Option<Arc<Config>> {
    if cards.is_empty() {
        return None;
    }
    let rows = with_cards_honed(&global.base, &global.cards, cards, factors);
    let mut c = Config::from_rows(&rows, global);
    // wave 7: the perks, family counts and set bonuses these cards hold (the same on every copy that has the cards)
    c.perks = crate::perks::held(&global.cards, &global.families, cards);
    Some(Arc::new(c))
}

/// What changes on the body when a build's values do: the health it can hold (the points a card adds are given at
/// once), armour, the rounds a bigger magazine adds, stamina within its new most.
fn settle(sim: &mut Sim, e: Entity, old: &Config, new: &Config, authority: bool) {
    if let Ok(mut h) = sim.world.get::<&mut Health>(e) {
        let (was, now) = (old.player.health, new.player.health);
        if (was - now).abs() > 1e-4 {
            h.max = now;
            if authority {
                if !h.dead {
                    h.hp = (h.hp + (now - was).max(0.0)).min(now);
                }
            } else {
                h.hp = h.hp.min(now);
            }
        }
        if authority && !h.dead {
            h.armor = (h.armor + (new.player.armor - old.player.armor).max(0.0)).max(0.0);
        }
    }
    if let Ok(mut a) = sim.world.get::<&mut Arms>(e) {
        if a.ammo.len() < new.weapons.len() {
            a.ammo.resize(new.weapons.len(), 0);
        }
        for (i, w) in new.weapons.iter().enumerate() {
            let before = old.weapons.get(i).map(|x| x.magazine).unwrap_or(w.magazine);
            if w.magazine > before {
                a.ammo[i] += w.magazine - before;
            }
            a.ammo[i] = a.ammo[i].min(w.magazine);
        }
        if let Some(r) = a.current
            && let Some(w) = new.weapons.get(r)
        {
            a.shape = w.shape;
        }
    }
    if let Ok(mut p) = sim.world.get::<&mut Pilot>(e) {
        p.stamina = p.stamina.min(new.moves.stamina.max);
    }
}

/// Set a player's cards (whatever they held) and settle its body. `authority`: this copy decides health (the host,
/// or alone); a joiner takes the host's.
pub fn set_cards(sim: &mut Sim, e: Entity, cards: Vec<u8>, authority: bool) {
    let global = crate::cfg(sim);
    let old = of(sim, e);
    let cfg = rebuild(&global, &cards, &crate::shop::factors(sim, e));
    let new = cfg.clone().unwrap_or_else(|| global.clone());
    let _ = sim.world.insert_one(e, Build { cards, cfg, version: global.version });
    settle(sim, e, &old, &new, authority);
}

/// Give a player a card (the host's word, or alone): its upgrades join the build, a weapon is drawn, a heal lands.
/// → false when it cannot be held (no such card, the stack is full, the hand is full).
pub fn grant(sim: &mut Sim, e: Entity, card: u8) -> bool {
    let global = crate::cfg(sim);
    let Some(def) = global.cards.get(card as usize).cloned() else { return false };
    let mut cards = sim.world.get::<&Build>(e).map(|b| b.cards.clone()).unwrap_or_default();
    if cards.len() >= MAX_CARDS || cards.iter().filter(|c| **c == card).count() as u32 >= def.stack {
        return false;
    }
    cards.push(card);
    let held = cards.len();
    let had_bonuses = of(sim, e).perks.bonuses.clone();
    set_cards(sim, e, cards, true);
    let cfg = of(sim, e);
    match def.kind {
        CardKind::Weapon => {
            if let Some(row) = def.weapon {
                crate::weapons::ensure(sim);
                crate::weapons::give(sim, e, row, true, &cfg);
            }
        }
        CardKind::Heal => {
            if let Ok(mut h) = sim.world.get::<&mut Health>(e)
                && !h.dead
            {
                h.hp = (h.hp + def.heal + def.heal_share * h.max).min(h.max);
            }
        }
        CardKind::Upgrade | CardKind::Perk => {}
    }
    let id = sim.world.get::<&Player>(e).map(|p| p.id).unwrap_or(0);
    sim.rule("card", id, card as f32, held as f32, 0.0, 0.0);
    // wave 7: a family's set bonus unlocked by this card (once: the cards of a run only grow)
    for f in cfg.perks.bonuses.iter().copied().filter(|f| !had_bonuses.contains(f)) {
        crate::perks::unlocked(sim, e, id, f, cfg.perks.counts.get(f).copied().unwrap_or(0));
    }
    true
}

/// Three cards for `player` at the run's `index`-th reward: drawn without putting back, a card's `weight` times its
/// rarity's, never one the player cannot take or use (a full stack, a weapon already held, an upgrade for a weapon
/// they do not hold). `weapons_held`: the rows in their hands (`usable`). The same inputs, the same hand.
/// Wave 7: a card of a family the player already holds a card of is weighted by its `bias` (`deal.familyBias`), so a
/// build takes shape over a run; still a pure function of the seed and what is held.
pub fn deal(defs: &[CardDef], rarity: [f32; 3], seed: u64, player: u32, index: u32, held: &[u8], weapons_held: &[usize]) -> [u8; 3] {
    deal_salted(defs, rarity, seed, player, index, 0, held, weapons_held)
}

/// `deal` with a salt (wave 7, track P): the pedlar's paid three and a reroll are other hands from the same seed. Salt
/// 0 is `deal`'s own hand. The family lean (track B) applies to every salt.
pub fn deal_salted(defs: &[CardDef], rarity: [f32; 3], seed: u64, player: u32, index: u32, salt: u64, held: &[u8], weapons_held: &[usize]) -> [u8; 3] {
    // a full hand (MAX_CARDS) takes no more: nothing is dealt (the reward passes, a sealed letter is refused), where it
    // once dealt three that `grant` would refuse (the wave 7 merge: the cart fills a hand in a long run)
    if held.len() >= MAX_CARDS {
        return [NO_CARD; 3];
    }
    let started: Vec<usize> = held.iter().filter_map(|c| defs.get(*c as usize).and_then(|d| d.family)).collect();
    let lean = |d: &CardDef| if d.family.is_some_and(|f| started.contains(&f)) { d.bias } else { 1.0 };
    let mut pool: Vec<(u8, f32)> = defs
        .iter()
        .enumerate()
        .take(255)
        .filter(|(i, d)| {
            let n = held.iter().filter(|c| **c as usize == *i).count() as u32;
            let have = d.kind == CardKind::Weapon && d.weapon.is_none_or(|r| weapons_held.contains(&r));
            let lacks = !d.needs.is_empty() && !d.needs.iter().any(|r| weapons_held.contains(r));
            d.weight > 0.0 && n < d.stack && !have && !lacks
        })
        .map(|(i, d)| (i as u8, d.weight * rarity[d.rarity.min(2) as usize] * lean(d)))
        .filter(|(_, w)| *w > 0.0)
        .collect();
    let mut rng = Rng::new(seed ^ (player as u64).wrapping_mul(0xD6E8_FEB8_6659_FD93) ^ (index as u64).wrapping_mul(0xA24B_AED4_963E_E407) ^ 0x5EED_CA2D ^ salt.wrapping_mul(0x9E37_79B9_7F4A_7C15));
    for _ in 0..4 {
        rng.next_u64();
    }
    let mut out = [NO_CARD; 3];
    for slot in out.iter_mut() {
        let total: f32 = pool.iter().map(|p| p.1).sum();
        if pool.is_empty() || total <= 0.0 {
            break;
        }
        let mut x = rng.f32() * total;
        let mut k = pool.len() - 1;
        for (i, p) in pool.iter().enumerate() {
            if x < p.1 {
                k = i;
                break;
            }
            x -= p.1;
        }
        *slot = pool.remove(k).0;
    }
    out
}

/// The weapons rows a player can use: those in their hands, and the melee row the quick melee swings.
pub fn usable(cfg: &Config, arms: Option<&Arms>) -> Vec<usize> {
    let mut rows = arms.map(|a| a.held.clone()).unwrap_or_default();
    if let Some(q) = cfg.quick_melee
        && !rows.contains(&q)
    {
        rows.push(q);
    }
    rows
}

/// A player's choice in the reward.
pub mod choice {
    pub const NONE: u8 = 0;
    pub const CHOOSING: u8 = 1;
    pub const PICKED: u8 = 2;
    pub const PASSED: u8 = 3;
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Choice {
    pub offers: [u8; 3],
    pub state: u8,
    /// Which of the three was taken (255: none).
    pub picked: u8,
}

/// The reward between waves (the host's; a joiner's copy mirrors it from the snapshots' blobs).
#[derive(Clone, Debug, Default)]
pub struct Reward {
    pub open: bool,
    pub wave: u32,
    /// Which reward of the run this is (1, 2, …): a part of the deal's seed.
    pub index: u32,
    pub left: f32,
    pub total: f32,
    pub seed: u64,
    pub choices: BTreeMap<u32, Choice>,
    /// Everyone has chosen: the seconds the screen lingers.
    closing: bool,
}

impl Reward {
    pub fn all_chosen(&self) -> bool {
        self.choices.values().all(|c| c.state != choice::CHOOSING)
    }
}

fn authority(sim: &Sim) -> bool {
    !sim.res.get::<forge_core::net::NetState>().is_some_and(|n| n.follows())
}

/// Open the reward: every player is dealt three and is choosing. `seconds` 0: the table's.
pub fn open(sim: &mut Sim, wave: u32, seconds: f32, seed: u64) {
    let cfg = crate::cfg(sim);
    if cfg.cards.is_empty() {
        sim.rule("reward-done", 0, wave as f32, 0.0, 0.0, 0.0);
        return;
    }
    crate::weapons::ensure(sim);
    let mut r = sim.res.take::<Reward>();
    r.open = true;
    r.closing = false;
    r.wave = wave;
    r.index += 1;
    r.seed = seed;
    r.total = if seconds > 0.0 { seconds } else { cfg.deal.seconds };
    r.left = r.total;
    r.choices.clear();
    let players: Vec<(u32, Vec<u8>, Vec<usize>)> = sim.world.query::<(&Player, Option<&Build>, Option<&Arms>)>().iter().map(|(p, b, a)| (p.id, b.map(|b| b.cards.clone()).unwrap_or_default(), usable(&cfg, a))).collect();
    for (id, held, arms) in players {
        let offers = deal(&cfg.cards, cfg.deal.rarity, seed, id, r.index, &held, &arms);
        r.choices.insert(id, Choice { offers, state: if offers == [NO_CARD; 3] { choice::PASSED } else { choice::CHOOSING }, picked: NO_CARD });
    }
    let (w, t) = (r.wave, r.total);
    sim.res.insert(r);
    sim.rule("reward-open", 0, w as f32, t, 0.0, 0.0);
}

/// A player takes one of their three (`slot` 0..=2) or passes (anything else).
pub fn pick(sim: &mut Sim, player: u32, slot: u32) {
    let Some(&e) = sim.players.get(&player) else { return };
    let (card, wave) = {
        let Some(r) = sim.res.get::<Reward>() else { return };
        let Some(c) = r.choices.get(&player) else { return };
        if !r.open || c.state != choice::CHOOSING {
            return;
        }
        (c.offers.get(slot as usize).copied().filter(|c| *c != NO_CARD), r.wave)
    };
    let took = card.is_some_and(|c| grant(sim, e, c));
    if let Some(c) = sim.res.get_mut::<Reward>().and_then(|r| r.choices.get_mut(&player)) {
        c.state = if took { choice::PICKED } else { choice::PASSED };
        c.picked = if took { slot as u8 } else { NO_CARD };
    }
    if took {
        sim.rule("card-picked", player, card.unwrap_or(NO_CARD) as f32, slot as f32, wave as f32, 0.0);
    } else {
        sim.rule("card-passed", player, wave as f32, 0.0, 0.0, 0.0);
    }
}

/// `feel.reward` (Feel stage, the host's): the countdown, the undecided passing at its end, the close.
pub fn feel_reward(sim: &mut Sim) {
    if !sim.res.get::<Reward>().is_some_and(|r| r.open) || !authority(sim) {
        return;
    }
    let linger = crate::cfg(sim).deal.linger;
    let mut r = sim.res.take::<Reward>();
    // a player who left is not waited for
    r.choices.retain(|id, _| sim.players.contains_key(id));
    r.left -= STEP;
    if r.all_chosen() && !r.closing {
        r.closing = true;
        r.left = r.left.min(linger);
    }
    let mut passed: Vec<u32> = Vec::new();
    let mut done = None;
    if r.left <= 0.0 {
        for (id, c) in r.choices.iter_mut() {
            if c.state == choice::CHOOSING {
                c.state = choice::PASSED;
                passed.push(*id);
            }
        }
        r.open = false;
        r.left = 0.0;
        let picks = r.choices.values().filter(|c| c.state == choice::PICKED).count();
        done = Some((r.wave, picks, r.choices.len() - picks));
    }
    let wave = r.wave;
    sim.res.insert(r);
    for id in passed {
        sim.rule("card-passed", id, wave as f32, 1.0, 0.0, 0.0);
    }
    if let Some((wave, picks, passes)) = done {
        sim.rule("reward-done", 0, wave as f32, picks as f32, passes as f32, 0.0);
    }
}

// ---- the snapshot's bytes (forge-core SnapBlob) ----
//
//   [0] flags: 1 down (a friend can revive), 2 the reward is open, bits 2-3 the choice's state, bits 4-7 the rush's
//       share left in fifteenths (wave 7, perks.rs: a joiner predicts its own player faster while it lasts)
//   [1] the revive's progress (share × 255)   [2] who is reviving (a player id; 0: nobody)
//   [3] the reward's seconds left × 4         [4] the reward's wave
//   [5..8] the three cards dealt (255: none)  [8] which was taken (255: none)
//   [9] cards held, then that many card rows
//   then (wave 7, track P) the player's shop bytes, if any (`shop.rs`: the purse, the cart, honed cards)
// Nothing to say (no card, no reward, standing, no coins): no bytes at all.

pub mod blob {
    pub const DOWN: u8 = 1;
    pub const REWARD: u8 = 2;
    pub const HEAD: usize = 10;
}

/// What a blob says of one player.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Told {
    pub down: bool,
    pub revive: f32,
    pub reviver: u32,
    pub reward: bool,
    pub left: f32,
    pub wave: u32,
    pub choice: Option<Choice>,
    pub cards: Vec<u8>,
    /// Wave 7 (track B): the rush's share left, in fifteenths (0: none; `perks::rush_level`), in byte 0's bits 4-7.
    pub rush: u8,
    /// Wave 7 (track P): the player's shop bytes (`shop::encode`), after the cards.
    pub extra: Vec<u8>,
}

pub fn encode(t: &Told) -> Vec<u8> {
    if !t.down && !t.reward && t.choice.is_none() && t.cards.is_empty() && t.rush == 0 && t.extra.is_empty() {
        return Vec::new();
    }
    let c = t.choice.unwrap_or(Choice { offers: [NO_CARD; 3], state: choice::NONE, picked: NO_CARD });
    let mut b = vec![(t.down as u8) | ((t.reward as u8) << 1) | ((c.state & 3) << 2) | (t.rush.min(15) << 4),(t.revive.clamp(0.0, 1.0) * 255.0).round() as u8, t.reviver.min(255) as u8, (t.left * 4.0).round().clamp(0.0, 255.0) as u8, t.wave.min(255) as u8, c.offers[0], c.offers[1], c.offers[2], c.picked, t.cards.len().min(MAX_CARDS) as u8];
    b.extend(t.cards.iter().take(MAX_CARDS));
    b.extend(&t.extra);
    b
}

pub fn decode(b: &[u8]) -> Told {
    if b.len() < blob::HEAD {
        return Told::default();
    }
    let state = (b[0] >> 2) & 3;
    let n = (b[9] as usize).min(b.len() - blob::HEAD);
    Told {
        down: b[0] & blob::DOWN != 0,
        revive: b[1] as f32 / 255.0,
        reviver: b[2] as u32,
        reward: b[0] & blob::REWARD != 0,
        left: b[3] as f32 / 4.0,
        wave: b[4] as u32,
        choice: (state != choice::NONE).then_some(Choice { offers: [b[5], b[6], b[7]], state, picked: b[8] }),
        cards: b[blob::HEAD..blob::HEAD + n].to_vec(),
        rush: b[0] >> 4,
        extra: b[blob::HEAD + n..].to_vec(),
    }
}

/// `feel.told` (Events stage, last; the host's): each player's bytes for the next snapshot.
pub fn feel_told(sim: &mut Sim) {
    if !authority(sim) {
        return;
    }
    let reward = sim.res.get::<Reward>().cloned().unwrap_or_default();
    let mut extra = crate::shop::told_all(sim);
    let mut set: Vec<(Entity, Vec<u8>)> = Vec::new();
    for (e, p, build, pilot, old, perks) in sim.world.query::<(Entity, &Player, Option<&Build>, Option<&Pilot>, Option<&SnapBlob>, Option<&crate::perks::Perks>)>().iter() {
        let t = Told {
            rush: perks.map(crate::perks::rush_level).unwrap_or(0),
            down: pilot.is_some_and(|x| x.downed),
            revive: pilot.map(|x| x.revive).unwrap_or(0.0),
            reviver: pilot.map(|x| x.reviver).unwrap_or(0),
            reward: reward.open,
            left: reward.left,
            wave: reward.wave,
            choice: reward.open.then(|| reward.choices.get(&p.id).copied()).flatten(),
            cards: build.map(|b| b.cards.clone()).unwrap_or_default(),
            extra: extra.remove(&p.id).unwrap_or_default(),
        };
        let bytes = encode(&t);
        if old.is_none_or(|o| o.0 != bytes) {
            set.push((e, bytes));
        }
    }
    for (e, bytes) in set {
        let _ = sim.world.insert_one(e, SnapBlob(bytes));
    }
}

/// `feel.sync` (Input stage; a joiner's): what the host's snapshot says of each player becomes this copy's: the cards
/// (and so the values its own player predicts with, and the weapons a weapon card gave), who is down and the revive
/// under way, and the reward as the host holds it.
pub fn feel_sync(sim: &mut Sim) {
    if authority(sim) {
        return;
    }
    crate::controller::ensure_pilots(sim);
    let global = crate::cfg(sim);
    let list: Vec<(Entity, u32, bool, Told, bool)> = sim
        .world
        .query::<(Entity, &Player, &SnapBlob, Option<&Build>)>()
        .iter()
        .map(|(e, p, b, build)| {
            let t = decode(&b.0);
            let stale = build.map(|x| x.cards != t.cards || x.version != global.version).unwrap_or(!t.cards.is_empty());
            (e, p.id, p.owned, t, stale)
        })
        .collect();
    let mut reward = Reward::default();
    crate::shop::sync_begin(sim);
    let prev = sim.res.get::<Reward>().map(|r| r.index).unwrap_or(0);
    let was_open = sim.res.get::<Reward>().is_some_and(|r| r.open);
    for (e, id, owned, t, stale) in list {
        if stale {
            let had: Vec<u8> = sim.world.get::<&Build>(e).map(|b| b.cards.clone()).unwrap_or_default();
            set_cards(sim, e, t.cards.clone(), false);
            // its own player: the weapons its new weapon cards give (a replica's hand is the snapshot's)
            if owned {
                let cfg = of(sim, e);
                crate::weapons::ensure(sim);
                for c in t.cards.iter().filter(|c| !had.contains(c)) {
                    if let Some(row) = global.cards.get(*c as usize).filter(|d| d.kind == CardKind::Weapon).and_then(|d| d.weapon) {
                        crate::weapons::give(sim, e, row, true, &cfg);
                    }
                }
            }
        }
        // wave 7 (track P): the purse, the cart and the honed cards
        crate::shop::sync_one(sim, e, id, &t.extra);
        if let Ok(mut p) = sim.world.get::<&mut Pilot>(e) {
            p.downed = t.down;
            p.revive = t.revive;
            p.reviver = t.reviver;
        }
        // wave 7: the rush the host's copy has (its own player walks and fires with it)
        if t.rush > 0 || sim.world.get::<&crate::perks::Perks>(e).is_ok_and(|p| p.rush > 0.0) {
            crate::perks::take_rush(sim, e, t.rush);
        }
        if t.reward {
            reward.open = true;
            reward.left = t.left;
            reward.wave = t.wave;
        }
        if let Some(c) = t.choice {
            reward.choices.insert(id, c);
        }
    }
    reward.index = prev + (reward.open && !was_open) as u32;
    reward.total = global.deal.seconds;
    sim.res.insert(reward);
}

// ---- commands ----

/// op::REWARD: ints [1 open | 0 close, wave, seed low, seed high], floats [seconds (0: the table's)].
pub fn cmd_reward(sim: &mut Sim, r: &cmd::Record) {
    if !authority(sim) {
        return;
    }
    if r.u(0) == 0 {
        if let Some(x) = sim.res.get_mut::<Reward>()
            && x.open
        {
            x.left = 0.0;
        }
        return;
    }
    open(sim, r.u(1), r.f(4), r.u(2) as u64 | (r.u(3) as u64) << 32);
}

/// op::PICK: ints [player, which of the three (0..=2; anything else passes)].
pub fn cmd_pick(sim: &mut Sim, r: &cmd::Record) {
    if authority(sim) {
        pick(sim, r.u(0), r.u(1));
    }
}

/// op::CARD: ints [player, card row]: the player gains the card now (the rules' own rewards, a test's loadout).
pub fn cmd_card(sim: &mut Sim, r: &cmd::Record) {
    if !authority(sim) {
        return;
    }
    if let Some(&e) = sim.players.get(&r.u(0)) {
        grant(sim, e, r.u(1).min(255) as u8);
    }
}

/// After a tables load: every build's values again.
pub fn retable(sim: &mut Sim) {
    let list: Vec<(Entity, Vec<u8>)> = sim.world.query::<(Entity, &Build)>().iter().map(|(e, b)| (e, b.cards.clone())).collect();
    let auth = authority(sim);
    for (e, cards) in list {
        set_cards(sim, e, cards, auth);
    }
}

// ---- reading (the inspector, the observation) ----

/// What `card` would change for the player `e`, before → after (JSON): {card, id, kind, can, changes: [{path, before,
/// after, row (a weapons row, for a weapon's value), held (the player holds that weapon)}], weapon: {row, id} | null,
/// heal: {before, after, max} | null}.
pub fn preview(sim: &Sim, e: Entity, card: u8) -> Value {
    let global = crate::cfg(sim);
    let Some(def) = global.cards.get(card as usize) else { return Value::Null };
    let held: Vec<u8> = sim.world.get::<&Build>(e).map(|b| b.cards.clone()).unwrap_or_default();
    // the weapons the player can use: in hand, and the one the quick melee swings (a card for it shows its numbers)
    let arms: Vec<usize> = usable(&global, sim.world.get::<&Arms>(e).ok().as_deref());
    let mut rows = with_cards_honed(&global.base, &global.cards, &held, &crate::shop::factors(sim, e));
    let mut changes = Vec::new();
    for ef in &def.effects {
        for (path, before, after) in apply_effect(&mut rows, ef) {
            let row = path.strip_prefix("weapons.").and_then(|r| r.split('.').next()).and_then(|id| global.weapons.iter().position(|w| w.id == id));
            changes.push(json!({ "path": path, "before": before, "after": after, "row": row, "held": row.is_none_or(|r| arms.contains(&r)) }));
        }
    }
    let n = held.iter().filter(|c| **c == card).count() as u32;
    let has = def.kind == CardKind::Weapon && def.weapon.is_none_or(|r| arms.contains(&r));
    let hp = sim.world.get::<&Health>(e).map(|h| (h.hp, h.max)).unwrap_or((0.0, 0.0));
    // wave 7: a perk's numbers now and with the card (copies stack), and the card's family: held now and with it,
    // and the set bonus it would unlock
    let now = crate::perks::held(&global.cards, &global.families, &held);
    let mut more = held.clone();
    more.push(card);
    let then = crate::perks::held(&global.cards, &global.families, &more);
    let perk_of = |kind: usize| json!({ "kind": crate::perks::KINDS[kind], "before": now.get(kind).map(|p| p.json()), "after": then.get(kind).map(|p| p.json()) });
    let family = def.family.and_then(|f| global.families.get(f).map(|fam| (f, fam))).map(|(f, fam)| {
        let unlocks = then.bonuses.contains(&f) && !now.bonuses.contains(&f);
        json!({
            "row": f, "id": fam.id, "name": fam.name, "label": fam.label, "at": fam.at,
            "held": now.counts.get(f).copied().unwrap_or(0), "after": then.counts.get(f).copied().unwrap_or(0),
            "unlocked": now.bonuses.contains(&f), "unlocks": unlocks,
            "bonus": fam.bonus.as_ref().map(|b| perk_of(b.kind)),
        })
    });
    json!({
        "card": card, "id": def.id, "kind": match def.kind { CardKind::Upgrade => "upgrade", CardKind::Weapon => "weapon", CardKind::Heal => "heal", CardKind::Perk => "perk" },
        "can": n < def.stack && !has && held.len() < MAX_CARDS, "held": n, "stack": def.stack,
        "changes": changes,
        "weapon": def.weapon.map(|r| json!({ "row": r, "id": global.weapons.get(r).map(|w| w.id.clone()) })),
        "heal": (def.kind == CardKind::Heal).then(|| json!({ "before": hp.0, "after": (hp.0 + def.heal + def.heal_share * hp.1).min(hp.1), "max": hp.1 })),
        "perk": def.perk.as_ref().map(|p| perk_of(p.kind)),
        "family": family,
    })
}

/// The run as this copy holds it (JSON; the observation's `forge.run()`): the reward (open, wave, seconds left, each
/// player's three cards, state and pick) and every player's cards, being down and the revive under way.
pub fn run_json(sim: &Sim) -> String {
    let global = crate::cfg(sim);
    let r = sim.res.get::<Reward>().cloned().unwrap_or_default();
    let state = |s: u8| ["none", "choosing", "picked", "passed"][(s & 3) as usize];
    let card = |c: u8| if c == NO_CARD { Value::Null } else { json!(c) };
    let choices: Vec<Value> = r.choices.iter().map(|(id, c)| json!({ "player": id, "state": state(c.state), "offers": c.offers.iter().map(|x| card(*x)).collect::<Vec<_>>(), "picked": card(c.picked) })).collect();
    let mut players: Vec<(u32, Value)> = sim
        .world
        .query::<(Entity, &Player, Option<&Build>, Option<&Pilot>, Option<&Health>, Option<&Arms>)>()
        .iter()
        .map(|(e, p, b, pilot, hp, arms)| {
            (p.id, json!({
                "build": crate::perks::player_json(sim, e),
                "id": p.id, "local": p.local,
                "cards": b.map(|b| b.cards.clone()).unwrap_or_default(),
                "down": pilot.is_some_and(|x| x.downed), "alive": hp.is_none_or(|h| !h.dead),
                "revive": pilot.map(|x| (x.revive.clamp(0.0, 1.0) * 1000.0).round() / 1000.0).unwrap_or(0.0),
                "reviver": pilot.map(|x| x.reviver).unwrap_or(0),
                "weapons": arms.map(|a| a.held.clone()).unwrap_or_default(),
                "hp": hp.map(|h| h.hp).unwrap_or(0.0), "hpMax": hp.map(|h| h.max).unwrap_or(0.0),
            }))
        })
        .collect();
    players.sort_by_key(|p| p.0);
    let v = json!({
        "reward": { "open": r.open, "wave": r.wave, "index": r.index, "left": (r.left * 100.0).round() / 100.0, "seconds": if r.total > 0.0 { r.total } else { global.deal.seconds }, "choices": choices },
        "players": players.into_iter().map(|p| p.1).collect::<Vec<_>>(),
        "cards": global.cards.iter().map(|c| c.id.clone()).collect::<Vec<_>>(),
        "families": global.families.iter().map(|f| json!({ "id": f.id, "label": f.label, "at": f.at })).collect::<Vec<_>>(),
        "perks": crate::perks::stats_json(sim),
        "notes": global.notes.clone(),
    });
    serde_json::to_string(&v).unwrap_or_else(|_| "null".into())
}

/// A value a player plays with now (its build's), by its table path. None: no such value.
pub fn value_of(sim: &Sim, e: Entity, path: &str) -> Option<f64> {
    let global = crate::cfg(sim);
    let held: Vec<u8> = sim.world.get::<&Build>(e).map(|b| b.cards.clone()).unwrap_or_default();
    value(&with_cards_honed(&global.base, &global.cards, &held, &crate::shop::factors(sim, e)), path)
}

/// Card paths no row has (a typo, a weapon that is not in the table): said once at the tables' load.
pub fn notes(base: &Base, defs: &[CardDef]) -> Vec<String> {
    let mut out = Vec::new();
    for d in defs {
        for e in &d.effects {
            let mut b = base.clone();
            if apply_effect(&mut b, e).is_empty() {
                out.push(format!("cards.{}: \"{}\" is not a value a card can change", d.id, e.path));
            }
        }
        if d.kind == CardKind::Weapon && d.weapon.is_none() {
            out.push(format!("cards.{}: its weapon is not in the weapons table", d.id));
        }
    }
    out
}

/// The melee row the quick melee swings, among filled weapon rows.
pub fn quick_melee(weapons: &[crate::weapon_defs::WeaponDef]) -> Option<usize> {
    weapons.iter().position(|w| w.kind == Kind::Melee)
}

#[cfg(test)]
mod tests {
    use super::*;
    use forge_core::serde_json::json;
    use forge_core::Core;

    const TABLES: &str = r#"{
      "weapons": [ { "id": "sidearm", "preset": "pistol" }, { "id": "scatter", "preset": "shotgun", "start": false } ],
      "cards": [
        { "id": "fleet", "stat": "player.walk", "mul": 1.2 },
        { "id": "drum", "stat": "weapons.sidearm.magazine", "mul": 1.5, "rarity": "rare" },
        { "id": "quick", "stat": "weapons.*.reload", "mul": 0.5, "stack": 1 },
        { "id": "glass", "stat": "weapons.sidearm.damage", "add": 10, "stat2": "player.health", "add2": -30, "rarity": "epic" },
        { "id": "gun", "kind": "weapon", "weapon": "scatter", "rarity": "epic" },
        { "id": "draught", "kind": "heal", "share": 0.5 },
        { "id": "typo", "stat": "player.wings", "add": 1 }
      ]
    }"#;

    fn core() -> Core {
        let mut c = Core::new();
        c.add_plugin(&crate::FeelPlugin);
        c.load_tables(TABLES).unwrap();
        c
    }

    #[test]
    fn an_upgrade_changes_the_value_at_its_path_and_cards_stack_in_order() {
        let c = core();
        let cfg = crate::cfg(&c.sim);
        assert_eq!(cfg.cards.len(), 7);
        assert_eq!(value(&cfg.base, "player.walk"), Some(7.8), "the player's row is whole (the kit's defaults fill a native table)");
        assert_eq!(value(&cfg.base, "weapons.scatter.reload"), Some(1.22));
        let rows = with_cards(&cfg.base, &cfg.cards, &[0, 0, 1, 2, 3]);
        assert!((value(&rows, "player.walk").unwrap() - 11.232).abs() < 1e-4);
        assert_eq!(value(&rows, "weapons.sidearm.magazine"), Some(9.0), "a whole value stays whole (6 × 1.5)");
        assert_eq!((value(&rows, "weapons.sidearm.reload"), value(&rows, "weapons.scatter.reload")), (Some(0.47), Some(0.61)), "* is every weapon");
        assert_eq!((value(&rows, "weapons.sidearm.damage"), value(&rows, "player.health")), (Some(30.0), Some(70.0)), "a trade changes both");
        // read as the tables are: units, ranges and what follows from them
        let own = Config::from_rows(&rows, &cfg);
        assert!((own.player.walk - 11.232).abs() < 1e-4 && own.player.health == 70.0);
        assert_eq!((own.weapons[0].magazine, own.weapons[0].damage), (9, 30.0));
        assert!((own.weapons[1].reload - 0.61).abs() < 1e-6);
        assert_eq!(cfg.notes.len(), 1, "a path no row has is said: {:?}", cfg.notes);
        assert!(cfg.notes[0].contains("typo") && cfg.notes[0].contains("player.wings"));
    }

    #[test]
    fn the_deal_is_seeded_weighted_and_never_offers_what_cannot_be_taken() {
        let c = core();
        let cfg = crate::cfg(&c.sim);
        let w = cfg.deal.rarity;
        let a = deal(&cfg.cards, w, 42, 1, 1, &[], &[0]);
        assert_eq!(a, deal(&cfg.cards, w, 42, 1, 1, &[], &[0]), "the same seed, player and reward: the same three");
        assert!(a.iter().all(|c| *c != NO_CARD) && a[0] != a[1] && a[1] != a[2] && a[0] != a[2], "three different cards: {a:?}");
        let (mut differs_by_player, mut differs_by_index, mut counts) = (0, 0, [0u32; 7]);
        for seed in 0..400u64 {
            let h = deal(&cfg.cards, w, seed, 1, 1, &[], &[0]);
            differs_by_player += (h != deal(&cfg.cards, w, seed, 2, 1, &[], &[0])) as u32;
            differs_by_index += (h != deal(&cfg.cards, w, seed, 1, 2, &[], &[0])) as u32;
            for c in h {
                counts[c as usize] += 1;
            }
        }
        assert!(differs_by_player > 300 && differs_by_index > 300, "players and rewards get their own hands ({differs_by_player}, {differs_by_index} of 400)");
        // common 60, rare 30, epic 10: a common card is dealt more often than a rare one, a rare one than an epic
        assert!(counts[0] > counts[1] && counts[1] > counts[3] && counts[1] > counts[4], "by rarity weight: {counts:?}");
        // a weapon already held, a full stack: never dealt
        for seed in 0..200u64 {
            let h = deal(&cfg.cards, w, seed, 1, 1, &[2], &[0, 1]);
            assert!(!h.contains(&4), "the scattergun's card to a player holding it (seed {seed}: {h:?})");
            assert!(!h.contains(&2), "a card at its stack (seed {seed}: {h:?})");
        }
        let few = deal(&cfg.cards[..2], w, 1, 1, 1, &[], &[]);
        assert_eq!(few[2], NO_CARD, "two cards in the table: two dealt");
        // an upgrade for one weapon alone goes only to a player who holds it
        let defs: Vec<CardDef> = [r#"{ "id": "sawn", "stat": "weapons.scatter.pellets", "add": 4, "stat2": "weapons.scatter.spread", "mul": 1.5 }"#, r#"{ "id": "any", "stat": "weapons.*.damage", "mul": 1.1 }"#]
            .iter()
            .map(|j| CardDef::from_row(&crate::weapon_defs::row(serde_json::from_str(j).unwrap()), &c.sim.tables.weapons))
            .collect();
        assert_eq!((defs[0].needs.clone(), defs[1].needs.clone()), (vec![1], vec![]));
        assert!((0..50u64).all(|s| !deal(&defs, w, s, 1, 1, &[], &[0]).contains(&0)), "not to a player without the scattergun");
        assert!((0..50u64).all(|s| deal(&defs, w, s, 1, 1, &[], &[0, 1]).contains(&0)), "to one who holds it");
    }

    #[test]
    fn a_players_bytes_round_trip_and_nothing_to_say_is_no_bytes() {
        assert!(encode(&Told::default()).is_empty());
        let t = Told { down: true, revive: 0.5, reviver: 3, reward: true, left: 12.25, wave: 3, choice: Some(Choice { offers: [4, 0, NO_CARD], state: choice::PICKED, picked: 1 }), cards: vec![0, 0, 5], rush: 11, extra: Vec::new() };
        let b = encode(&t);
        assert_eq!(b.len(), blob::HEAD + 3);
        let d = decode(&b);
        assert!((d.revive - 0.5).abs() < 0.004);
        assert_eq!(Told { revive: 0.5, ..d }, t);
        assert_eq!(decode(&[1, 2, 3]), Told::default(), "bytes cut short say nothing");
        // wave 7: a rush alone is something to say (a joiner predicts its own player with it)
        let r = encode(&Told { rush: 15, ..Told::default() });
        assert_eq!((r.len(), decode(&r).rush, decode(&r).down), (blob::HEAD, 15, false));
        assert!(b.len() <= forge_core::snapshot::BLOB_MAX && blob::HEAD + MAX_CARDS <= forge_core::snapshot::BLOB_MAX);
    }

    #[test]
    fn a_card_given_settles_the_body_and_the_inspector_says_what_it_will_do() {
        let mut c = core();
        let e = c.sim.spawn_player(1, forge_core::glam::Vec3::ZERO, 0.0, true, true);
        c.tick(1.0 / 60.0, 0);
        // the inspector first, then the card: the same numbers
        let p = preview(&c.sim, e, 3);
        assert_eq!(p["changes"], json!([{ "path": "weapons.sidearm.damage", "before": 20.0, "after": 30.0, "row": 0, "held": true }, { "path": "player.health", "before": 100.0, "after": 70.0, "row": null, "held": true }]));
        assert!(grant(&mut c.sim, e, 3));
        assert_eq!((value_of(&c.sim, e, "weapons.sidearm.damage"), value_of(&c.sim, e, "player.health")), (Some(30.0), Some(70.0)));
        assert_eq!(of(&c.sim, e).weapons[0].damage, 30.0);
        let h = *c.sim.world.get::<&Health>(e).unwrap();
        assert_eq!((h.max, h.hp), (70.0, 70.0), "less full health holds the health to it");
        // a heal: half of the full 70, held to it; a weapon card: in hand; a stack of one: only once
        c.sim.world.get::<&mut Health>(e).unwrap().hp = 10.0;
        assert_eq!(preview(&c.sim, e, 5)["heal"], json!({ "before": 10.0, "after": 45.0, "max": 70.0 }));
        assert!(grant(&mut c.sim, e, 5));
        assert_eq!(c.sim.world.get::<&Health>(e).unwrap().hp, 45.0);
        assert!(grant(&mut c.sim, e, 4));
        let arms = { let a = c.sim.world.get::<&Arms>(e).unwrap(); (a.held.clone(), a.current) };
        assert_eq!(arms, (vec![0, 1], Some(1)), "the weapon card's weapon is held and drawn");
        assert_eq!(preview(&c.sim, e, 4)["can"], json!(false), "a weapon already held");
        assert!(grant(&mut c.sim, e, 2) && !grant(&mut c.sim, e, 2), "a stack of one is held once");
        // a tables load keeps the build (Studio changes a value mid-round)
        c.load_tables(TABLES).unwrap();
        assert_eq!(c.sim.world.get::<&Build>(e).unwrap().cards, vec![3, 5, 4, 2]);
        assert_eq!(of(&c.sim, e).weapons[0].damage, 30.0);
        // a reset starts the run over
        let mut w = forge_core::cmd::Writer::default();
        w.op(crate::op::RESET, &[1]);
        c.cmds[..w.words.len()].copy_from_slice(&w.words);
        c.tick(0.0, w.words.len());
        assert!(c.sim.world.get::<&Build>(e).unwrap().cards.is_empty());
        assert_eq!((of(&c.sim, e).weapons[0].damage, c.sim.world.get::<&Health>(e).unwrap().max), (20.0, 100.0));
    }
}
