//! Coins worth spending (wave 7, track P; `spec.forge.shop`, the kit's `tables/shop.js` and `gf/forge/shop.js`). The
//! creator, 2026-10-12: "Also coins still cant be used for much"; asked what coins should buy, they chose the pedlar's
//! cart between waves and paying to revive a friend.
//!
//! - **The purse** (`Shop::purses`, by player id, so no player's components change as coins come; the host's): the coins a player picked up (`kills::feel_coins`' `coin`
//!   event, rounded, at most `PURSE_MAX`), less what they spent. It goes to a joiner in the player's snapshot bytes, so
//!   every copy's HUD shows each player's own purse. `op::RESET` empties it (a new run).
//! - **The cart** (`Shop`, a resource; the host's): `op::SHOP` opens it after a cleared wave (gf/forge/ai.js, when the
//!   wave director says the cart opens: `spec.forge.shop.every` / `from`). Every player standing in the game is a
//!   visitor until they leave (`op::BUY` with `LEAVE`); it closes when every visitor has left or its seconds ran out
//!   (`shop.seconds`; on a wave with a reward the kit opens the reward with the same seconds, one screen, one timer).
//! - **An item** (`ItemDef`) has a kind, a price, a growth a lap (`perLap`, ×) and a growth for each one bought in the
//!   same visit (`perBuy`, ×), and a stock a visit (per player; 0: no limit). Its price for a player is
//!   `round(price × perLap^lap × perBuy^bought)`, the lap being the wave director's (endless, wave 6; forge-play writes
//!   into `Shop::lap` every step, `set_lap`). A visit runs from one cart opening to the next: what a player bought during a fight
//!   (a revive) counts in the visit before.
//!   - `card` (v8, the creator: "one selection system", "cart only, no free cards"): the cart opens with three cards
//!     dealt for each player (the reward's deal with its own salt, the family lean included) and shows them; `op::BUY`
//!     with the card row and `arg` 0..=2 buys the one in that place, priced by its rarity (`price` × 1, `rare` or
//!     `epic`), and the place stays empty until a fresh deal. Nothing is paid before a card is chosen.
//!   - `reroll`: the three on show dealt again (another salt), or on a wave with a reward the reward's three.
//!   - `heal`: `share` of full health back at once.
//!   - `hone`: one upgrade card the player holds is made one step stronger: its `add` × (1 + `by`) and its multiplier
//!     to the power (1 + `by`) (×1.2 honed once by 0.5: ×1.31; ×0.6: ×0.46). A card is honed one rarity a step, up
//!     to epic: a common twice, a rare once, an epic not. The levels are per card held (its place in the hand), go to a
//!     joiner with the cards, and every value a card changes is read through them (`cards::with_cards_honed`).
//!   - `revive`: a downed friend back up at once, from anywhere (`revive::raise`), during the fight too. A revive by
//!     holding interact beside them stays free.
//! - **Each purchase is a player's command** the host checks (`op::BUY` [player, item, arg]): the item, the cart open
//!   and the player in it (a revive needs neither), the stock, the coins, and a target the kind can use. A refusal is
//!   the rule event `buy-refused` {entity, a: item, b: why (`why::*`)}; nothing is spent.
//! - **Rule events**: `shop-open` {a: wave, b: seconds, c: lap, d: 1 with a reward}, `bought` {entity: player, a: item
//!   row, b: price, c: arg}, `shop-card` {entity, a: card row, b: which of the three}, `shop-refund` {entity, a: item,
//!   b: coins}, `shop-left` {entity}, `shop-done` {a: wave, b: purchases, c: coins spent}.
use std::sync::Arc;

use forge_core::cmd;
use forge_core::components::*;
use forge_core::hecs::Entity;
use forge_core::serde_json::Value;
use forge_core::sim::Sim;
use forge_core::tables::Row;
use forge_core::STEP;

use crate::cards::{self, CardKind, NO_CARD};
use crate::controller::Pilot;

/// The most items a cart has (the snapshot's bytes count each one's purchases in four bits).
pub const MAX_ITEMS: usize = 8;
/// The most coins a purse holds (two bytes in the snapshot).
pub const PURSE_MAX: u32 = 65_535;
/// The most a card is honed (three bits in the snapshot).
pub const HONE_MAX: u8 = 7;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ItemKind {
    Card,
    Reroll,
    Heal,
    Hone,
    Revive,
}

impl ItemKind {
    pub fn name(self) -> &'static str {
        match self {
            ItemKind::Card => "card",
            ItemKind::Reroll => "reroll",
            ItemKind::Heal => "heal",
            ItemKind::Hone => "hone",
            ItemKind::Revive => "revive",
        }
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct ItemDef {
    pub id: String,
    pub kind: ItemKind,
    pub price: f32,
    /// × a lap of the wave director's.
    pub per_lap: f32,
    /// × for each one this player bought in the same visit.
    pub per_buy: f32,
    /// How many one player may buy a visit (0: no limit).
    pub stock: u32,
    /// A heal: the share of full health.
    pub share: f32,
    /// A hone: how much stronger a step makes a card's change.
    pub by: f32,
    /// A card: its price × this for a rare card, and for an epic one.
    pub rare: f32,
    pub epic: f32,
}

impl ItemDef {
    pub fn from_row(r: &Row) -> Option<Self> {
        let kind = match r.str("kind")? {
            "card" => ItemKind::Card,
            "reroll" => ItemKind::Reroll,
            "heal" => ItemKind::Heal,
            "hone" => ItemKind::Hone,
            "revive" => ItemKind::Revive,
            _ => return None,
        };
        Some(Self {
            id: r.id().to_string(),
            kind,
            price: r.num("price", 10.0).clamp(0.0, PURSE_MAX as f32),
            per_lap: r.num("perLap", 1.3).clamp(1.0, 10.0),
            per_buy: r.num("perBuy", 1.5).clamp(1.0, 10.0),
            stock: r.int("stock", 1).clamp(0, 15) as u32,
            share: r.num("share", 0.4).clamp(0.0, 1.0),
            by: r.num("by", 0.5).clamp(0.05, 4.0),
            rare: r.num("rare", 1.5).clamp(0.1, 20.0),
            epic: r.num("epic", 2.2).clamp(0.1, 20.0),
        })
    }
}

/// `spec.forge.shop`: whether there is a cart, how long it stays, after which waves it opens and what it sells.
#[derive(Clone, Debug, PartialEq)]
pub struct ShopCfg {
    pub on: bool,
    pub seconds: f32,
    /// The cart opens after every `every`-th cleared wave (by the number players see), from wave `from` on.
    pub every: u32,
    pub from: u32,
    pub items: Vec<ItemDef>,
}

impl Default for ShopCfg {
    fn default() -> Self {
        // the items are the kit's (kit/tables/shop.js `ITEMS`, filled into every game's tables): none here, to keep
        // the data in the tables and out of the wasm
        Self { on: false, seconds: 20.0, every: 1, from: 1, items: Vec::new() }
    }
}

impl ShopCfg {
    pub fn from_row(r: &Row) -> Self {
        let d = Self::default();
        let items = match r.get("items") {
            Some(Value::Array(_)) => r.rows("items").iter().filter_map(ItemDef::from_row).take(MAX_ITEMS).collect(),
            _ => d.items,
        };
        Self { on: r.bool("on", false), seconds: r.num("seconds", d.seconds).clamp(3.0, 180.0), every: r.int("every", 1).clamp(1, 64) as u32, from: r.int("from", 1).clamp(1, 1000) as u32, items }
    }
    pub fn load(sim: &Sim) -> Self {
        sim.tables.raw.row("shop").map(|r| Self::from_row(&r)).unwrap_or_default()
    }
    /// Does the cart open after wave `number` (1-based, as players count)?
    pub fn opens_after(&self, number: u32) -> bool {
        self.on && !self.items.is_empty() && number >= self.from && (number - self.from) % self.every.max(1) == 0
    }
    /// How much stronger a hone step makes a card (the first hone item's `by`).
    pub fn hone_by(&self) -> f32 {
        self.items.iter().find(|i| i.kind == ItemKind::Hone).map(|i| i.by).unwrap_or(0.5)
    }
    pub fn revive_row(&self) -> Option<usize> {
        self.items.iter().position(|i| i.kind == ItemKind::Revive)
    }
}

pub fn cfg(sim: &Sim) -> Arc<ShopCfg> {
    sim.res.get::<Shop>().and_then(|s| s.cfg.clone()).unwrap_or_else(|| Arc::new(ShopCfg::load(sim)))
}

/// After a tables load.
pub fn retable(sim: &mut Sim) {
    let c = ShopCfg::load(sim);
    sim.res.entry::<Shop>().cfg = Some(Arc::new(c));
}

/// A small map by player id (a game has at most a few players): a list, not a BTreeMap, which costs the wasm several
/// kilobytes for each kind of value it holds.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Ids<T>(pub Vec<(u32, T)>);

impl<T> Default for Ids<T> {
    fn default() -> Self {
        Ids(Vec::new())
    }
}

impl<T> Ids<T> {
    pub fn get(&self, id: &u32) -> Option<&T> {
        self.0.iter().find(|x| x.0 == *id).map(|x| &x.1)
    }
    pub fn get_mut(&mut self, id: &u32) -> Option<&mut T> {
        self.0.iter_mut().find(|x| x.0 == *id).map(|x| &mut x.1)
    }
    pub fn insert(&mut self, id: u32, v: T) {
        match self.0.iter().position(|x| x.0 == id) {
            Some(i) => self.0[i].1 = v,
            None => self.0.push((id, v)),
        }
    }
    pub fn remove(&mut self, id: &u32) -> Option<T> {
        let i = self.0.iter().position(|x| x.0 == *id)?;
        Some(self.0.remove(i).1)
    }
    pub fn clear(&mut self) {
        self.0.clear();
    }
    pub fn retain(&mut self, mut f: impl FnMut(&u32, &mut T) -> bool) {
        self.0.retain_mut(|x| f(&x.0, &mut x.1));
    }
    pub fn values(&self) -> impl Iterator<Item = &T> {
        self.0.iter().map(|x| &x.1)
    }
    pub fn iter(&self) -> impl Iterator<Item = (&u32, &T)> {
        self.0.iter().map(|x| (&x.0, &x.1))
    }
    pub fn iter_mut(&mut self) -> impl Iterator<Item = (&u32, &mut T)> {
        self.0.iter_mut().map(|x| (&x.0, &mut x.1))
    }
}

impl<T: Default> Ids<T> {
    /// The value for `id`, made when there is none.
    pub fn at(&mut self, id: u32) -> &mut T {
        let i = match self.0.iter().position(|x| x.0 == id) {
            Some(i) => i,
            None => {
                self.0.push((id, T::default()));
                self.0.len() - 1
            }
        };
        &mut self.0[i].1
    }
}

impl<T> std::ops::Index<&u32> for Ids<T> {
    type Output = T;
    fn index(&self, id: &u32) -> &T {
        self.get(id).expect("no such player")
    }
}

fn id_of(sim: &Sim, e: Entity) -> u32 {
    sim.world.get::<&Player>(e).map(|p| p.id).unwrap_or(0)
}

/// The hone levels of `player`'s hand (empty: none honed).
pub fn levels(sim: &Sim, player: u32) -> Vec<u8> {
    sim.res.get::<Shop>().and_then(|s| s.honed.get(&player).cloned()).unwrap_or_default()
}

pub fn set_levels(sim: &mut Sim, player: u32, l: Vec<u8>) {
    let h = &mut sim.res.entry::<Shop>().honed;
    if l.iter().all(|x| *x == 0) {
        h.remove(&player);
    } else {
        h.insert(player, l);
    }
}

/// A player's coins now (0: none, or no such player).
pub fn coins(sim: &Sim, player: u32) -> u32 {
    sim.res.get::<Shop>().and_then(|s| s.purses.get(&player).copied()).unwrap_or(0)
}

/// forge-play: the wave director's lap, which the prices read (the host's; a joiner's comes with the snapshot).
pub fn set_lap(sim: &mut Sim, lap: u32) {
    if authority(sim) && sim.res.get::<Shop>().is_none_or(|s| s.lap != lap) {
        sim.res.entry::<Shop>().lap = lap;
    }
}

/// Why a purchase was refused (`buy-refused`'s b).
pub mod why {
    /// No such item, or no such player.
    pub const ITEM: u32 = 1;
    /// The cart is closed, or the player has left it.
    pub const CLOSED: u32 = 2;
    /// This visit's stock is bought.
    pub const STOCK: u32 = 3;
    /// Not enough coins.
    pub const COINS: u32 = 4;
    /// Nothing the item can be used on (no card in that place, nothing to deal again, full health, no card to hone,
    /// no friend down, a hand that takes no more).
    pub const TARGET: u32 = 5;
}

/// One player's part in the cart.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Visitor {
    pub in_cart: bool,
    /// Bought this visit, by item row.
    pub bought: [u8; MAX_ITEMS],
    /// The three cards on show for this player (NO_CARD: an empty place).
    pub offers: [u8; 3],
}

impl Default for Visitor {
    fn default() -> Self {
        Self { in_cart: false, bought: [0; MAX_ITEMS], offers: [NO_CARD; 3] }
    }
}

/// The cart (the host's; a joiner's copy mirrors it from the snapshots' bytes).
#[derive(Clone, Debug, Default)]
pub struct Shop {
    pub open: bool,
    pub wave: u32,
    /// Which cart of the run this is (1, 2, …): a part of the seed of the cards on show.
    pub visit: u32,
    /// The director's lap the prices read.
    pub lap: u32,
    pub left: f32,
    pub total: f32,
    pub seed: u64,
    /// Opened with the reward (one screen, one timer).
    pub with_reward: bool,
    pub visitors: Ids<Visitor>,
    /// This visit's purchases and coins spent (for `shop-done`).
    pub sales: u32,
    pub spent: u32,
    /// Each player's coins and hone levels, by player id. Kept here, not as components: a component added at the
    /// first coin moved that player to another archetype, which changed the order every query meets the players in,
    /// and with it the fight (forge-play's four-player wave test saw it). One resource for all of it keeps the wasm
    /// small (each resource type and each BTreeMap of a new value type costs it a few kilobytes).
    pub purses: Ids<u32>,
    pub honed: Ids<Vec<u8>>,
    /// The table (`spec.forge.shop`), made again at every tables load.
    pub cfg: Option<Arc<ShopCfg>>,
}

fn authority(sim: &Sim) -> bool {
    !sim.res.get::<forge_core::net::NetState>().is_some_and(|n| n.follows())
}

/// An item's price for a player who bought `bought` of it this visit, on lap `lap`.
pub fn price(item: &ItemDef, lap: u32, bought: u32) -> u32 {
    price_x(item, lap, bought, 1.0)
}

/// `price` × `x` (a card's rarity, `rarity_x`) before rounding.
pub fn price_x(item: &ItemDef, lap: u32, bought: u32, x: f32) -> u32 {
    let p = item.price as f64 * x as f64 * (item.per_lap as f64).powi(lap.min(200) as i32) * (item.per_buy as f64).powi(bought.min(200) as i32);
    if p.is_finite() { (p.round().max(0.0) as u64).min(PURSE_MAX as u64) as u32 } else { PURSE_MAX }
}

/// What `player` pays for item `row` now (None: no such item).
pub fn price_for(sim: &Sim, player: u32, row: usize) -> Option<u32> {
    let c = cfg(sim);
    let item = c.items.get(row)?;
    let s = sim.res.get::<Shop>();
    let lap = s.map(|s| s.lap).unwrap_or(0);
    let bought = s.and_then(|s| s.visitors.get(&player)).map(|v| v.bought[row.min(MAX_ITEMS - 1)] as u32).unwrap_or(0);
    Some(price(item, lap, bought))
}

/// What a card of `rarity` (0 common, 1 rare, 2 epic) costs at a card item, × its price.
pub fn rarity_x(item: &ItemDef, rarity: u8) -> f32 {
    [1.0, item.rare, item.epic][rarity.min(2) as usize]
}

/// What `player` pays now for the card on show in `slot` (None: no card there, or the cart sells none).
pub fn card_price(sim: &Sim, player: u32, slot: usize) -> Option<u32> {
    let c = cfg(sim);
    let row = c.items.iter().position(|i| i.kind == ItemKind::Card)?;
    let s = sim.res.get::<Shop>()?;
    let v = s.visitors.get(&player)?;
    let card = *v.offers.get(slot).filter(|x| **x != NO_CARD)?;
    let rarity = crate::cfg(sim).cards.get(card as usize)?.rarity;
    Some(price_x(&c.items[row], s.lap, v.bought[row] as u32, rarity_x(&c.items[row], rarity)))
}

pub fn purse_of(sim: &Sim, player: u32) -> Option<u32> {
    sim.players.contains_key(&player).then(|| coins(sim, player))
}

/// The host: coins picked up (`kills::feel_coins`) go into the player's purse.
pub fn earn(sim: &mut Sim, player: u32, value: f32) {
    if !authority(sim) || !(value > 0.0) {
        return;
    }
    if !sim.players.contains_key(&player) {
        return;
    }
    let now = coins(sim, player);
    set_purse(sim, player, now.saturating_add(value.round() as u32));
}

pub fn set_purse(sim: &mut Sim, player: u32, n: u32) {
    let p = &mut sim.res.entry::<Shop>().purses;
    if n == 0 {
        p.remove(&player);
    } else {
        p.insert(player, n.min(PURSE_MAX));
    }
}

/// A new run for one player (`op::RESET`): no coins, no honed cards, no part in a cart left open.
pub fn reset_player(sim: &mut Sim, _e: Entity, id: u32) {
    if let Some(s) = sim.res.get_mut::<Shop>() {
        s.purses.remove(&id);
        s.honed.remove(&id);
        s.visitors.remove(&id);
    }
}

/// The factor each card in a player's hand is played at (1: not honed), by its place.
pub fn factors(sim: &Sim, e: Entity) -> Vec<f32> {
    let l = levels(sim, id_of(sim, e));
    if l.iter().all(|x| *x == 0) {
        return Vec::new();
    }
    let by = cfg(sim).hone_by();
    l.iter().map(|x| 1.0 + by * *x as f32).collect()
}

/// Can the card at `pos` in `e`'s hand be honed a step? → its row, rarity now (with its hones) and level.
pub fn honeable(sim: &Sim, e: Entity, pos: usize) -> Option<(u8, u8, u8)> {
    let global = crate::cfg(sim);
    let row = *sim.world.get::<&cards::Build>(e).ok()?.cards.get(pos)?;
    let def = global.cards.get(row as usize)?;
    let level = levels(sim, id_of(sim, e)).get(pos).copied().unwrap_or(0);
    (def.kind == CardKind::Upgrade && !def.effects.is_empty() && def.rarity + level < 2 && level < HONE_MAX).then_some((row, def.rarity + level, level))
}

fn hone(sim: &mut Sim, e: Entity, pos: usize) {
    let cards_held = sim.world.get::<&cards::Build>(e).map(|b| b.cards.clone()).unwrap_or_default();
    let id = id_of(sim, e);
    let mut l = levels(sim, id);
    if l.len() < cards_held.len() {
        l.resize(cards_held.len(), 0);
    }
    l[pos] = (l[pos] + 1).min(HONE_MAX);
    set_levels(sim, id, l);
    cards::set_cards(sim, e, cards_held, true);
}

/// The value at `path` for `e` if the card at `pos` in the hand were honed one step more (the kit's inspector asks
/// for each value the card changes, before → after: `cards::value_of` is the before). None: no such card or value.
pub fn value_honed(sim: &Sim, e: Entity, pos: usize, path: &str) -> Option<f64> {
    let global = crate::cfg(sim);
    let held = sim.world.get::<&cards::Build>(e).ok()?.cards.clone();
    if pos >= held.len() {
        return None;
    }
    let mut f = factors(sim, e);
    f.resize(held.len(), 1.0);
    f[pos] += cfg(sim).hone_by();
    cards::value(&cards::with_cards_honed(&global.base, &global.cards, &held, &f), path)
}

/// Open the cart: every player is a visitor. `seconds` 0: the table's.
pub fn open(sim: &mut Sim, wave: u32, seconds: f32, seed: u64, with_reward: bool) {
    let c = cfg(sim);
    if !c.on || c.items.is_empty() {
        sim.rule("shop-done", 0, wave as f32, 0.0, 0.0, 0.0);
        return;
    }
    let ids: Vec<u32> = sim.world.query::<&Player>().iter().map(|p| p.id).collect();
    let s = sim.res.entry::<Shop>();
    s.open = true;
    s.wave = wave;
    s.visit += 1;
    let lap = s.lap;
    s.seed = seed;
    s.with_reward = with_reward;
    s.total = if seconds > 0.0 { seconds } else { c.seconds };
    s.left = s.total;
    s.sales = 0;
    s.spent = 0;
    s.visitors = Ids(ids.iter().map(|id| (*id, Visitor { in_cart: true, ..Visitor::default() })).collect());
    let t = s.total;
    // a cart that sells cards shows three for each player at once (v8: the one selection system)
    if c.items.iter().any(|i| i.kind == ItemKind::Card) {
        for id in ids {
            redeal(sim, id, SALT_CARD);
        }
    }
    sim.rule("shop-open", 0, wave as f32, t, lap as f32, with_reward as u8 as f32);
}

/// Deal `player` three cards on show (the visit's seed and `salt`). → false when nothing could be dealt (nothing changes).
fn redeal(sim: &mut Sim, player: u32, salt: u64) -> bool {
    let Some(&e) = sim.players.get(&player) else { return false };
    let (seed, visit) = sim.res.get::<Shop>().map(|s| (s.seed, s.visit)).unwrap_or_default();
    let offers = deal_for(sim, e, player, seed, visit, salt);
    let dealt = offers != [NO_CARD; 3];
    if let Some(v) = sim.res.get_mut::<Shop>().and_then(|s| s.visitors.get_mut(&player)).filter(|_| dealt) {
        v.offers = offers;
    }
    dealt
}

fn refuse(sim: &mut Sim, player: u32, item: u32, w: u32) -> Result<u32, u32> {
    sim.rule("buy-refused", player, item as f32, w as f32, 0.0, 0.0);
    Err(w)
}

/// A player buys item `row` (`arg`: a card by its place among the three on show, a hone's card by its place in the
/// hand, a revive's friend). → the price paid, or why not (`why::*`).
pub fn buy(sim: &mut Sim, player: u32, row: u32, arg: u32) -> Result<u32, u32> {
    let c = cfg(sim);
    let Some(item) = c.items.get(row as usize).cloned() else { return refuse(sim, player, row, why::ITEM) };
    let Some(&e) = sim.players.get(&player) else { return refuse(sim, player, row, why::ITEM) };
    crate::controller::ensure_pilots(sim);
    let (open, lap, visitor) = sim.res.get::<Shop>().map(|s| (s.open, s.lap, s.visitors.get(&player).copied())).unwrap_or((false, 0, None));
    // everything but a revive is bought at the cart, by a player in it
    if item.kind != ItemKind::Revive && !(open && visitor.is_some_and(|v| v.in_cart)) {
        return refuse(sim, player, row, why::CLOSED);
    }
    let bought = visitor.map(|v| v.bought[row as usize] as u32).unwrap_or(0);
    if item.stock > 0 && bought >= item.stock {
        return refuse(sim, player, row, why::STOCK);
    }
    let global = crate::cfg(sim);
    // a card: the one on show in place `arg`, priced by its rarity
    let card = visitor.and_then(|v| v.offers.get(arg as usize).copied()).filter(|c| *c != NO_CARD);
    let x = match (item.kind, card) {
        (ItemKind::Card, None) => return refuse(sim, player, row, why::TARGET),
        (ItemKind::Card, Some(k)) => rarity_x(&item, global.cards.get(k as usize).map_or(0, |d| d.rarity)),
        _ => 1.0,
    };
    let cost = price_x(&item, lap, bought, x);
    let purse = coins(sim, player);
    if purse < cost {
        return refuse(sim, player, row, why::COINS);
    }
    let alive = sim.world.get::<&Health>(e).is_ok_and(|h| !h.dead);
    // what the item does, once it is known it can (nothing is spent on a refusal)
    match item.kind {
        ItemKind::Card => {
            let k = card.unwrap_or(NO_CARD);
            if !cards::grant(sim, e, k) {
                return refuse(sim, player, row, why::TARGET);
            }
            if let Some(v) = sim.res.get_mut::<Shop>().and_then(|s| s.visitors.get_mut(&player)) {
                v.offers[arg as usize] = NO_CARD;
            }
            sim.rule("shop-card", player, k as f32, arg as f32, 0.0, 0.0);
        }
        ItemKind::Reroll => {
            let r = sim.res.get::<cards::Reward>().filter(|r| r.open).and_then(|r| r.choices.get(&player).filter(|ch| ch.state == cards::choice::CHOOSING).map(|_| (r.seed, r.index)));
            let salt = SALT_REROLL + bought as u64 + 1;
            if let Some((seed, index)) = r {
                // the reward's three, on a wave with a reward
                let offers = deal_for(sim, e, player, seed, index, salt);
                if offers == [NO_CARD; 3] {
                    return refuse(sim, player, row, why::TARGET);
                }
                if let Some(ch) = sim.res.get_mut::<cards::Reward>().and_then(|r| r.choices.get_mut(&player)) {
                    ch.offers = offers;
                }
            } else if !(c.items.iter().any(|i| i.kind == ItemKind::Card) && redeal(sim, player, salt)) {
                return refuse(sim, player, row, why::TARGET);
            }
        }
        ItemKind::Heal => {
            let full = sim.world.get::<&Health>(e).map(|h| h.dead || h.hp >= h.max - 1e-3).unwrap_or(true);
            if full {
                return refuse(sim, player, row, why::TARGET);
            }
            if let Ok(mut h) = sim.world.get::<&mut Health>(e) {
                h.hp = (h.hp + item.share * h.max).min(h.max);
            }
        }
        ItemKind::Hone => {
            if honeable(sim, e, arg as usize).is_none() {
                return refuse(sim, player, row, why::TARGET);
            }
            hone(sim, e, arg as usize);
        }
        ItemKind::Revive => {
            let target = sim.players.get(&arg).copied();
            let down = target.is_some_and(|t| arg != player && sim.world.get::<&Pilot>(t).is_ok_and(|p| p.downed));
            let (Some(t), true, true) = (target, down, alive) else { return refuse(sim, player, row, why::TARGET) };
            let rv = global.moves.revive.clone();
            crate::revive::raise(sim, t, rv.health, rv.grace, player);
        }
    }
    let purse = coins(sim, player);
    set_purse(sim, player, purse - cost);
    let s = sim.res.entry::<Shop>();
    let v = s.visitors.at(player);
    v.bought[row as usize] = v.bought[row as usize].saturating_add(1).min(15);
    s.sales += 1;
    s.spent += cost;
    sim.rule("bought", player, row as f32, cost as f32, arg as f32, 0.0);
    Ok(cost)
}

/// Three cards for `e` from the reward's deal with a salt (`cards::deal_salted`).
fn deal_for(sim: &Sim, e: Entity, player: u32, seed: u64, index: u32, salt: u64) -> [u8; 3] {
    let global = crate::cfg(sim);
    let held = sim.world.get::<&cards::Build>(e).map(|b| b.cards.clone()).unwrap_or_default();
    let arms = cards::usable(&global, sim.world.get::<&crate::weapons::Arms>(e).ok().as_deref());
    cards::deal_salted(&global.cards, global.deal.rarity, seed, player, index, salt, &held, &arms)
}

/// The cart's salts: the three on show are not the reward's three, and a fresh deal is not the three before.
pub const SALT_CARD: u64 = 0xCA2D_0000;
pub const SALT_REROLL: u64 = 0x7E20_0000;

/// A player leaves the cart (Done): the cards on show go back to the pedlar.
pub fn leave(sim: &mut Sim, player: u32) {
    let Some(x) = sim.res.get_mut::<Shop>().filter(|s| s.open).and_then(|s| s.visitors.get_mut(&player)).filter(|v| v.in_cart) else { return };
    x.in_cart = false;
    x.offers = [NO_CARD; 3];
    sim.rule("shop-left", player, 0.0, 0.0, 0.0, 0.0);
}

/// `feel.shop` (Feel stage, after the reward; the host's): the lap the prices read, the countdown, the close when
/// every visitor has left or the time is up.
pub fn feel_shop(sim: &mut Sim) {
    if !authority(sim) || !sim.res.get::<Shop>().is_some_and(|s| s.open) {
        return;
    }
    let s = sim.res.entry::<Shop>();
    // a player who left the game is not waited for
    s.visitors.retain(|id, _| sim.players.contains_key(id));
    s.left -= STEP;
    if s.left > 0.0 && s.visitors.values().any(|v| v.in_cart) {
        return;
    }
    for (_, v) in s.visitors.iter_mut() {
        v.in_cart = false;
        v.offers = [NO_CARD; 3];
    }
    s.open = false;
    s.left = 0.0;
    let (wave, sales, spent) = (s.wave, s.sales, s.spent);
    sim.rule("shop-done", 0, wave as f32, sales as f32, spent as f32, 0.0);
}

// ---- the snapshot's bytes: a player's part, after the cards' (`cards::Told::extra`) ----
//
//   [0] flags: 1 the cart is open, 2 this player is in it, 8 with the reward
//   [1..3] the purse (u16, little end)   [3] the cart's seconds left × 2 (to 127.5 s)   [4] the lap   [5] the wave
//   [6] the visit   [7..11] bought this visit, four bits an item   [11..14] the three cards on show (255: none)
//   [14] how many hone levels follow, then the level of each card in the hand from the first (trailing 0s left off)
// Nothing to say (no coins, no cart, nothing bought or honed): no bytes.

pub mod bytes {
    pub const OPEN: u8 = 1;
    pub const IN: u8 = 2;
    pub const REWARD: u8 = 8;
    pub const HEAD: usize = 15;
}

/// The host: each player's shop bytes for the next snapshot (`cards::feel_told` puts them after the cards). Nothing to
/// say (no coins, no cart, nothing bought or honed): no bytes. Written and read in place (no struct between) to keep
/// the wasm small.
pub fn told_all(sim: &Sim) -> Ids<Vec<u8>> {
    let mut out = Ids::default();
    let Some(s) = sim.res.get::<Shop>() else { return out };
    for p in sim.world.query::<&Player>().iter() {
        let v = s.visitors.get(&p.id).copied().unwrap_or_default();
        let purse = s.purses.get(&p.id).copied().unwrap_or(0).min(PURSE_MAX);
        let mut honed = s.honed.get(&p.id).cloned().unwrap_or_default();
        honed.truncate(32);
        while honed.last() == Some(&0) {
            honed.pop();
        }
        if !s.open && purse == 0 && honed.is_empty() && v.bought.iter().all(|b| *b == 0) {
            continue;
        }
        let flags = (s.open as u8 * bytes::OPEN) | ((s.open && v.in_cart) as u8 * bytes::IN) | ((s.open && s.with_reward) as u8 * bytes::REWARD);
        let nib = |i: usize| v.bought[2 * i].min(15) | (v.bought[2 * i + 1].min(15) << 4);
        let mut b = vec![flags, purse as u8, (purse >> 8) as u8, (s.left * 2.0).round().clamp(0.0, 255.0) as u8, s.lap.min(255) as u8, s.wave.min(255) as u8, s.visit.min(255) as u8, nib(0), nib(1), nib(2), nib(3), v.offers[0], v.offers[1], v.offers[2], honed.len() as u8];
        b.extend(honed.iter().map(|l| (*l).min(HONE_MAX)));
        out.insert(p.id, b);
    }
    out
}

/// A joiner, before `sync_one` for each player (`cards::feel_sync`): the cart is as the snapshot says.
pub fn sync_begin(sim: &mut Sim) {
    let s = sim.res.entry::<Shop>();
    s.open = false;
    s.with_reward = false;
    s.visitors.clear();
}

/// A joiner (`cards::feel_sync`, for each player): the player's purse and honed cards, and the cart as the host holds
/// it, from the shop bytes after the cards (`cards::Told::extra`).
pub fn sync_one(sim: &mut Sim, e: Entity, id: u32, b: &[u8]) {
    let ok = b.len() >= bytes::HEAD;
    let at = |i: usize| if ok { b[i] } else { 0 };
    let purse = at(1) as u32 | ((at(2) as u32) << 8);
    if coins(sim, id) != purse {
        set_purse(sim, id, purse);
    }
    // a hone the host made: the values this copy plays the player with, made again
    let n = if ok { (b[14] as usize).min(b.len() - bytes::HEAD) } else { 0 };
    let now: Vec<u8> = if ok { b[bytes::HEAD..bytes::HEAD + n].to_vec() } else { Vec::new() };
    let mut had = levels(sim, id);
    while had.last() == Some(&0) {
        had.pop();
    }
    if had != now {
        set_levels(sim, id, now);
        let held = sim.world.get::<&cards::Build>(e).map(|b| b.cards.clone()).unwrap_or_default();
        cards::set_cards(sim, e, held, false);
    }
    let shop = sim.res.entry::<Shop>();
    if ok {
        shop.lap = b[4] as u32;
    }
    if at(0) & bytes::OPEN != 0 {
        if shop.visit != b[6] as u32 {
            shop.total = 0.0;
        }
        shop.open = true;
        shop.left = b[3] as f32 / 2.0;
        shop.wave = b[5] as u32;
        shop.visit = b[6] as u32;
        shop.with_reward = b[0] & bytes::REWARD != 0;
        shop.total = shop.total.max(shop.left);
    }
    let mut bought = [0u8; MAX_ITEMS];
    for i in 0..4 {
        bought[2 * i] = at(7 + i) & 15;
        bought[2 * i + 1] = at(7 + i) >> 4;
    }
    let offers = if ok { [b[11], b[12], b[13]] } else { [NO_CARD; 3] };
    shop.visitors.insert(id, Visitor { in_cart: at(0) & bytes::IN != 0, bought, offers });
}

// ---- commands ----

/// op::SHOP: ints [1 open | 0 close, wave, seed low, seed high, 1 with the reward], floats [seconds (0: the table's)].
pub fn cmd_shop(sim: &mut Sim, r: &cmd::Record) {
    if !authority(sim) {
        return;
    }
    if r.u(0) == 0 {
        if let Some(s) = sim.res.get_mut::<Shop>()
            && s.open
        {
            s.left = 0.0;
        }
        return;
    }
    open(sim, r.u(1), r.f(5), r.u(2) as u64 | (r.u(3) as u64) << 32, r.u(4) != 0);
}

/// op::BUY: ints [player, item row | `LEAVE`, arg].
pub fn cmd_buy(sim: &mut Sim, r: &cmd::Record) {
    if !authority(sim) {
        return;
    }
    match r.u(1) {
        LEAVE => leave(sim, r.u(0)),
        row => {
            let _ = buy(sim, r.u(0), row, r.u(2));
        }
    }
}

/// op::BUY's item for leaving the cart (Done).
pub const LEAVE: u32 = 255;

// ---- reading (the kit's cart, the observation) ----

/// The cart for `player`, every frame (the kit's gf/forge/shop.js; forge-web `feel_shop_state`): open, seconds left, in
/// the cart, purse, with the reward, the visit, the lap, the wave, the cart's seconds, the three cards on show (−1
/// none), then the item count and this visit's purchases of each, then the cards held and the hone level of each, then
/// the price of each of the three on show (−1 none).
pub fn state(sim: &Sim, player: u32) -> Vec<f32> {
    let n = cfg(sim).items.len();
    let mut out = Vec::with_capacity(16 + n);
    let held = sim.players.get(&player).and_then(|e| sim.world.get::<&cards::Build>(*e).ok().map(|b| b.cards.len())).unwrap_or(0);
    let l = levels(sim, player);
    let s = sim.res.get::<Shop>();
    let v = s.and_then(|s| s.visitors.get(&player)).copied().unwrap_or_default();
    let open = s.is_some_and(|s| s.open);
    let o = |x: u8| if x == NO_CARD { -1.0 } else { x as f32 };
    let (left, visit, lap, wave, total, rw) = s.map(|s| (s.left, s.visit, s.lap, s.wave, s.total, s.with_reward)).unwrap_or_default();
    out.extend([open as u8 as f32, left, (open && v.in_cart) as u8 as f32, coins(sim, player) as f32, (open && rw) as u8 as f32, visit as f32, lap as f32, wave as f32, total, o(v.offers[0]), o(v.offers[1]), o(v.offers[2]), n as f32]);
    out.extend(v.bought.iter().take(n).map(|b| *b as f32));
    out.push(held as f32);
    out.extend((0..held).map(|i| l.get(i).copied().unwrap_or(0) as f32));
    out.extend((0..3).map(|i| card_price(sim, player, i).map_or(-1.0, |p| p as f32)));
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use forge_core::serde_json;
    use forge_core::glam::Vec3;
    use forge_core::Core;

    const TABLES: &str = r#"{
      "weapons": [ { "id": "sidearm", "preset": "pistol" }, { "id": "scatter", "preset": "shotgun", "start": false } ],
      "cards": [
        { "id": "fleet", "stat": "player.walk", "mul": 1.2 },
        { "id": "drum", "stat": "weapons.sidearm.magazine", "mul": 1.5, "rarity": "rare" },
        { "id": "heavy", "stat": "weapons.sidearm.damage", "add": 10 },
        { "id": "glass", "stat": "weapons.sidearm.damage", "add": 10, "stat2": "player.health", "add2": -30, "rarity": "epic" },
        { "id": "gun", "kind": "weapon", "weapon": "scatter", "rarity": "epic" },
        { "id": "quick", "stat": "weapons.*.reload", "mul": 0.6 }
      ],
      "shop": { "on": true, "seconds": 10, "items": [
        { "id": "letter", "kind": "card", "price": 10, "perLap": 1.5, "perBuy": 2, "stock": 2, "rare": 2, "epic": 3 },
        { "id": "deal", "kind": "reroll", "price": 4, "stock": 3 },
        { "id": "broth", "kind": "heal", "price": 5, "share": 0.5, "stock": 1 },
        { "id": "stone", "kind": "hone", "price": 8, "by": 0.5, "stock": 2 },
        { "id": "salts", "kind": "revive", "price": 6, "perLap": 1.5, "perBuy": 1.5, "stock": 0 }
      ] }
    }"#;

    fn core() -> Core {
        let mut c = Core::new();
        c.add_plugin(&crate::FeelPlugin);
        c.load_tables(TABLES).unwrap();
        c
    }

    fn op(c: &mut Core, op: u32, ints: &[u32], floats: &[f32]) {
        let mut w = forge_core::cmd::Writer::default();
        w.opf(op, ints, floats);
        c.cmds[..w.words.len()].copy_from_slice(&w.words);
        c.tick(0.0, w.words.len());
    }

    fn rules(c: &Core) -> Vec<(String, u32, f32, f32)> {
        c.events_out
            .chunks(forge_core::events::WORDS)
            .filter_map(|w| forge_core::events::Event::decode(w.try_into().unwrap()))
            .filter_map(|(e, _)| if let forge_core::events::Event::Rule(r) = e { Some((c.sim.names.get(r.name).to_string(), r.entity, r.a, r.b)) } else { None })
            .collect()
    }

    fn purse(c: &Core, id: u32) -> u32 {
        purse_of(&c.sim, id).unwrap()
    }

    #[test]
    fn the_table_reads_and_the_kits_defaults_are_the_rusts() {
        let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../../kit/tables/defaults.json");
        let v: Value = serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
        let row = Row(v.get("shop").and_then(Value::as_object).expect("defaults.json has the shop table (node research/gf-forge/tools/tables.mjs --write)").clone());
        let kit = ShopCfg::from_row(&row);
        assert_eq!(ShopCfg { items: Vec::new(), ..kit.clone() }, ShopCfg::default(), "kit/tables/shop.js and ShopCfg::default agree");
        // the kit's own cart (kit/tables/shop.js ITEMS), read as the core reads a game's
        let got: Vec<(&str, ItemKind, f32, f32, f32, u32)> = kit.items.iter().map(|i| (i.id.as_str(), i.kind, i.price, i.per_lap, i.per_buy, i.stock)).collect();
        assert_eq!(got, [("card", ItemKind::Card, 8.0, 1.3, 1.4, 0), ("reroll", ItemKind::Reroll, 5.0, 1.25, 1.5, 3), ("heal", ItemKind::Heal, 6.0, 1.3, 1.5, 2), ("hone", ItemKind::Hone, 15.0, 1.3, 1.6, 1), ("revive", ItemKind::Revive, 10.0, 1.3, 1.5, 0)]);
        assert_eq!((kit.items[0].rare, kit.items[0].epic), (1.5, 2.2), "a card's price by its rarity");
        let c = core();
        let s = cfg(&c.sim);
        assert!(s.on && s.seconds == 10.0 && s.items.len() == 5);
        assert_eq!(s.items.iter().map(|i| i.kind).collect::<Vec<_>>(), [ItemKind::Card, ItemKind::Reroll, ItemKind::Heal, ItemKind::Hone, ItemKind::Revive]);
        assert!(s.opens_after(1) && s.opens_after(5));
        let every = ShopCfg { every: 2, from: 2, ..(*s).clone() };
        assert_eq!((1..=6).map(|n| every.opens_after(n)).collect::<Vec<_>>(), [false, true, false, true, false, true]);
        assert!(!ShopCfg::default().opens_after(1), "off unless a game asks");
    }

    #[test]
    fn prices_grow_with_the_lap_and_with_each_bought_in_a_visit() {
        let item = ItemDef { id: "x".into(), kind: ItemKind::Card, price: 10.0, per_lap: 1.5, per_buy: 2.0, stock: 0, share: 0.0, by: 0.5, rare: 1.5, epic: 2.2 };
        assert_eq!([price(&item, 0, 0), price(&item, 1, 0), price(&item, 2, 0)], [10, 15, 23], "× 1.5 a lap (22.5 rounds to 23)");
        assert_eq!([price(&item, 0, 1), price(&item, 0, 2), price(&item, 1, 1)], [20, 40, 30], "× 2 for each bought this visit");
        assert_eq!(price(&ItemDef { price: 60000.0, ..item.clone() }, 9, 9), PURSE_MAX, "never more than a purse holds");
    }

    #[test]
    fn coins_picked_up_fill_the_purse_and_a_reset_empties_it() {
        let mut c = core();
        let e = c.sim.spawn_player(1, Vec3::ZERO, 0.0, true, true);
        c.tick(1.0 / 60.0, 0);
        assert_eq!(purse(&c, 1), 0);
        // a coin flies to the player and is picked up (kills::feel_coins): its value goes into the purse
        let coin = c.sim.spawn_local(crate::kinds::COIN, 0, Vec3::new(0.0, 1.2, 0.3), 0.0);
        c.sim.world.insert_one(coin, crate::kills::Coin { to: 1, value: 3.0, t: 0.3, cosmetic: false }).unwrap();
        for _ in 0..30 {
            c.tick(1.0 / 60.0, 0);
        }
        assert_eq!(purse(&c, 1), 3, "a coin of 3");
        earn(&mut c.sim, 1, 2.4);
        assert_eq!(purse(&c, 1), 5, "rounded");
        // a new run: no coins
        op(&mut c, crate::op::RESET, &[1], &[]);
        assert_eq!(purse(&c, 1), 0);
        let _ = e;
    }

    #[test]
    fn each_item_kind_does_what_it_says_and_costs_its_price() {
        let mut c = core();
        let (e1, e2) = (c.sim.spawn_player(1, Vec3::ZERO, 0.0, true, true), c.sim.spawn_player(2, Vec3::X * 3.0, 0.0, false, true));
        c.tick(1.0 / 60.0, 0);
        earn(&mut c.sim, 1, 200.0);
        // closed: nothing but a revive is sold
        assert_eq!(buy(&mut c.sim, 1, 2, 0), Err(why::CLOSED));
        op(&mut c, crate::op::REWARD, &[1, 2, 77, 0], &[10.0]);
        op(&mut c, crate::op::SHOP, &[1, 2, 77, 0, 1], &[10.0]);
        let ev = rules(&c);
        assert!(ev.iter().any(|r| r.0 == "shop-open" && r.2 == 2.0 && r.3 == 10.0), "{ev:?}");
        // what the kit's cart reads every frame: the three cards on show and, last, each one's price
        let f = state(&c.sim, 1);
        assert_eq!((f[0], f[2], f[3], f[4], f[7], f[8], f[12], &f[13..18], f[18]), (1.0, 1.0, 200.0, 1.0, 2.0, 10.0, 5.0, &[0.0f32; 5][..], 0.0));
        let shown = c.sim.res.get::<Shop>().unwrap().visitors[&1].offers;
        assert_eq!(&f[9..12], &shown.map(|x| x as f32)[..]);
        // card: three on show as the cart opens, not the reward's three; one bought by its place, priced by its rarity
        // (×1 common, ×2 rare, ×3 epic in this table); its place stays empty
        let reward3 = c.sim.res.get::<cards::Reward>().unwrap().choices[&1].offers;
        assert!(shown.iter().all(|x| *x != NO_CARD) && shown != reward3, "the cart's own three: {shown:?} vs the reward's {reward3:?}");
        let rar = shown.map(|k| crate::cfg(&c.sim).cards[k as usize].rarity as usize);
        let x = |i: usize| [1.0f32, 2.0, 3.0][rar[i]];
        let p1 = round_f(10.0 * x(1));
        assert_eq!(&f[f.len() - 3..], &[round_f(10.0 * x(0)) as f32, p1 as f32, round_f(10.0 * x(2)) as f32][..], "the state says each one's price");
        assert_eq!(buy(&mut c.sim, 1, 0, 1), Ok(p1));
        assert_eq!(c.sim.world.get::<&cards::Build>(e1).unwrap().cards, vec![shown[1]]);
        assert_eq!(c.sim.res.get::<Shop>().unwrap().visitors[&1].offers, [shown[0], NO_CARD, shown[2]], "the place stays empty");
        assert_eq!(buy(&mut c.sim, 1, 0, 1), Err(why::TARGET), "nothing there now");
        assert_eq!(buy(&mut c.sim, 1, 0, 7), Err(why::TARGET), "no such place");
        assert_eq!(purse(&c, 1), 200 - p1);
        // the second costs twice (perBuy 2); a stock of two
        let p0 = round_f(10.0 * 2.0 * x(0));
        assert_eq!(card_price(&c.sim, 1, 0), Some(p0));
        assert_eq!(buy(&mut c.sim, 1, 0, 0), Ok(p0));
        assert_eq!(buy(&mut c.sim, 1, 0, 2), Err(why::STOCK));
        assert_eq!(purse(&c, 1), 200 - p1 - p0);

        // reroll: the reward's three dealt again
        assert_eq!(buy(&mut c.sim, 1, 1, 0), Ok(4));
        let again = c.sim.res.get::<cards::Reward>().unwrap().choices[&1].offers;
        assert_ne!(again, reward3, "rerolled");
        assert_eq!(c.sim.res.get::<cards::Reward>().unwrap().choices[&2].offers, c.sim.res.get::<cards::Reward>().unwrap().choices[&2].offers);
        // the reward chosen: a fresh deal deals the cart's three on show again (the second costs 4 × 1.5)
        op(&mut c, crate::op::PICK, &[1, 0], &[]);
        let before = c.sim.res.get::<Shop>().unwrap().visitors[&1].offers;
        assert_eq!(buy(&mut c.sim, 1, 1, 0), Ok(6));
        let fresh = c.sim.res.get::<Shop>().unwrap().visitors[&1].offers;
        assert!(fresh != before && fresh.iter().all(|k| *k != NO_CARD), "three again: {before:?} → {fresh:?}");

        // heal: not at full health; half of it back
        assert_eq!(buy(&mut c.sim, 1, 2, 0), Err(why::TARGET), "full health");
        let max = c.sim.world.get::<&Health>(e1).unwrap().max;
        c.sim.world.get::<&mut Health>(e1).unwrap().hp = 10.0;
        assert_eq!(buy(&mut c.sim, 1, 2, 0), Ok(5));
        assert!((c.sim.world.get::<&Health>(e1).unwrap().hp - (10.0 + 0.5 * max)).abs() < 1e-3);
        c.sim.world.get::<&mut Health>(e1).unwrap().hp = 10.0;
        assert_eq!(buy(&mut c.sim, 1, 2, 0), Err(why::STOCK), "a stock of one");

        // hone: a common upgrade a step stronger (its add × 1.5), up to epic; an epic or a weapon card not at all
        op(&mut c, crate::op::CARD, &[1, 2], &[]); // heavy: sidearm damage +10 (common)
        op(&mut c, crate::op::CARD, &[1, 3], &[]); // glass: epic
        let held = c.sim.world.get::<&cards::Build>(e1).unwrap().cards.clone();
        let heavy = held.iter().position(|x| *x == 2).unwrap();
        let glass = held.iter().position(|x| *x == 3).unwrap();
        let before = cards::value_of(&c.sim, e1, "weapons.sidearm.damage").unwrap();
        assert_eq!(value_honed(&c.sim, e1, heavy, "weapons.sidearm.damage"), Some(before + 5.0), "+10 honed by 0.5: +15");
        assert_eq!(value_honed(&c.sim, e1, heavy, "player.walk"), cards::value_of(&c.sim, e1, "player.walk"), "a value the card does not change");
        assert_eq!(buy(&mut c.sim, 1, 3, glass as u32), Err(why::TARGET), "an epic is as high as a card goes");
        assert_eq!(buy(&mut c.sim, 1, 3, 99), Err(why::TARGET), "no card there");
        assert_eq!(buy(&mut c.sim, 1, 3, heavy as u32), Ok(8));
        assert_eq!(cards::value_of(&c.sim, e1, "weapons.sidearm.damage"), Some(before + 5.0), "the inspector's after is what the player now has");
        assert_eq!(crate::cards::of(&c.sim, e1).weapons[0].damage as f64, before + 5.0);
        assert_eq!(honeable(&c.sim, e1, heavy).map(|h| (h.1, h.2)), Some((1, 1)), "now rare, honed once");
        assert_eq!(buy(&mut c.sim, 1, 3, heavy as u32), Ok(12), "the second costs more (8 × 1.5)");
        assert_eq!(cards::value_of(&c.sim, e1, "weapons.sidearm.damage"), Some(before + 10.0), "+10 × 2");
        assert!(honeable(&c.sim, e1, heavy).is_none(), "epic now: no more");
        // a multiplier is raised to the power: reload × 0.6 honed once is × 0.6^1.5
        let mut d = core();
        let f = d.sim.spawn_player(1, Vec3::ZERO, 0.0, true, true);
        d.tick(1.0 / 60.0, 0);
        op(&mut d, crate::op::CARD, &[1, 5], &[]);
        let r0 = cards::value_of(&d.sim, f, "weapons.sidearm.reload").unwrap();
        set_levels(&mut d.sim, 1, vec![1]);
        cards::set_cards(&mut d.sim, f, vec![5], true);
        let base = cards::value(&crate::cfg(&d.sim).base, "weapons.sidearm.reload").unwrap();
        assert!((r0 - base * 0.6).abs() < 1e-4 && (cards::value_of(&d.sim, f, "weapons.sidearm.reload").unwrap() - base * 0.6f64.powf(1.5)).abs() < 1e-3);

        // revive: a downed friend back up at once, from anywhere, during the fight too
        assert_eq!(buy(&mut c.sim, 1, 4, 2), Err(why::TARGET), "nobody is down");
        c.sim.damage(e2, 1000.0, 0, None, Vec3::Z);
        c.tick(1.0 / 60.0, 0);
        assert!(c.sim.world.get::<&Pilot>(e2).unwrap().downed);
        assert_eq!(buy(&mut c.sim, 1, 4, 1), Err(why::TARGET), "not oneself");
        let paid = purse(&c, 1);
        op(&mut c, crate::op::BUY, &[1, 4, 2], &[]);
        assert!(!c.sim.world.get::<&Health>(e2).unwrap().dead && !c.sim.world.get::<&Pilot>(e2).unwrap().downed, "back up");
        assert_eq!(purse(&c, 1), paid - 6);
        let ev = rules(&c);
        assert!(ev.iter().any(|r| r.0 == "player-revived" && r.1 == 2 && r.2 == 1.0), "the payer is the helper: {ev:?}");
        assert!(ev.iter().any(|r| r.0 == "bought" && r.1 == 1 && r.2 == 4.0 && r.3 == 6.0));
    }

    #[test]
    fn refusals_spend_nothing_and_say_why() {
        let mut c = core();
        let e = c.sim.spawn_player(1, Vec3::ZERO, 0.0, true, true);
        c.tick(1.0 / 60.0, 0);
        op(&mut c, crate::op::SHOP, &[1, 1, 5, 0, 0], &[0.0]);
        earn(&mut c.sim, 1, 9.0);
        c.sim.world.get::<&mut Health>(e).unwrap().hp = 20.0;
        assert_eq!(buy(&mut c.sim, 1, 0, 0), Err(why::COINS), "10 for the card, 9 in the purse");
        assert_eq!(buy(&mut c.sim, 1, 9, 0), Err(why::ITEM));
        assert_eq!(buy(&mut c.sim, 7, 0, 0), Err(why::ITEM), "no such player");
        assert_eq!(buy(&mut c.sim, 1, 0, 5), Err(why::TARGET), "no card in that place");
        assert_eq!(purse(&c, 1), 9);
        op(&mut c, crate::op::BUY, &[1, 0, 0], &[]);
        let ev = rules(&c);
        assert!(ev.iter().any(|r| r.0 == "buy-refused" && r.1 == 1 && r.2 == 0.0 && r.3 == why::COINS as f32), "{ev:?}");
        // left the cart: nothing more
        op(&mut c, crate::op::BUY, &[1, LEAVE, 0], &[]);
        assert_eq!(buy(&mut c.sim, 1, 2, 0), Err(why::CLOSED));
        assert_eq!(purse(&c, 1), 9);
    }

    #[test]
    fn the_cart_closes_when_everyone_left_or_the_time_is_up_with_one_and_with_two() {
        // alone: Done closes it on the next step; a card bought stays bought, the two left go back to the pedlar
        let mut c = core();
        let e = c.sim.spawn_player(1, Vec3::ZERO, 0.0, true, true);
        c.tick(1.0 / 60.0, 0);
        earn(&mut c.sim, 1, 50.0);
        op(&mut c, crate::op::SHOP, &[1, 1, 5, 0, 0], &[0.0]);
        assert!(c.sim.res.get::<Shop>().unwrap().open && c.sim.res.get::<Shop>().unwrap().total == 10.0, "the table's seconds");
        let paid = buy(&mut c.sim, 1, 0, 0).unwrap();
        op(&mut c, crate::op::BUY, &[1, LEAVE, 0], &[]);
        let ev = rules(&c);
        assert!(ev.iter().any(|r| r.0 == "shop-left"), "{ev:?}");
        assert_eq!(c.sim.res.get::<Shop>().unwrap().visitors[&1].offers, [NO_CARD; 3], "the rest go back");
        c.tick(1.0 / 60.0, 0);
        let ev = rules(&c);
        assert!(ev.iter().any(|r| r.0 == "shop-done"), "{ev:?}");
        assert!(!c.sim.res.get::<Shop>().unwrap().open);
        assert_eq!((purse(&c, 1), c.sim.world.get::<&cards::Build>(e).unwrap().cards.len()), (50 - paid, 1));
        // two minutes (the creator, v8): a cart may stay open up to 180 s from the table, and 120 s from the kit
        assert_eq!(ShopCfg::from_row(&Row(serde_json::from_str(r#"{ "on": true, "seconds": 120 }"#).unwrap())).seconds, 120.0);
        assert_eq!(ShopCfg::from_row(&Row(serde_json::from_str(r#"{ "on": true, "seconds": 900 }"#).unwrap())).seconds, 180.0);

        // two: one leaves, the cart waits for the other until its time is up
        let mut c = core();
        c.sim.spawn_player(1, Vec3::ZERO, 0.0, true, true);
        c.sim.spawn_player(2, Vec3::X, 0.0, false, true);
        c.tick(1.0 / 60.0, 0);
        op(&mut c, crate::op::SHOP, &[1, 3, 5, 0, 0], &[4.0]);
        op(&mut c, crate::op::BUY, &[1, LEAVE, 0], &[]);
        let (mut done_at, mut t) = (None, 0.0);
        for _ in 0..(60 * 6) {
            c.tick(1.0 / 60.0, 0);
            t += 1.0 / 60.0;
            if done_at.is_none() && rules(&c).iter().any(|r| r.0 == "shop-done") {
                done_at = Some(t);
            }
        }
        let t = done_at.expect("closed");
        assert!((3.9..=4.1).contains(&t), "the friend who stayed keeps it open until its 4 s ({t})");
        // two: both leave, it closes at once
        op(&mut c, crate::op::SHOP, &[1, 4, 5, 0, 0], &[30.0]);
        assert_eq!(c.sim.res.get::<Shop>().unwrap().visit, 2);
        op(&mut c, crate::op::BUY, &[2, LEAVE, 0], &[]);
        assert!(c.sim.res.get::<Shop>().unwrap().open);
        op(&mut c, crate::op::BUY, &[1, LEAVE, 0], &[]);
        c.tick(1.0 / 60.0, 0);
        assert!(!c.sim.res.get::<Shop>().unwrap().open, "everyone left");
        // the host closes it (a round's end)
        op(&mut c, crate::op::SHOP, &[1, 5, 5, 0, 0], &[30.0]);
        op(&mut c, crate::op::SHOP, &[0, 0, 0, 0, 0], &[0.0]);
        c.tick(1.0 / 60.0, 0);
        assert!(!c.sim.res.get::<Shop>().unwrap().open);
        // the table off: a cart opened says it is done at once
        let mut d = Core::new();
        d.add_plugin(&crate::FeelPlugin);
        d.load_tables(r#"{ "weapons": [ { "id": "sidearm", "preset": "pistol" } ] }"#).unwrap();
        op(&mut d, crate::op::SHOP, &[1, 1, 5, 0, 0], &[0.0]);
        assert!(rules(&d).iter().any(|r| r.0 == "shop-done") && !d.sim.res.get::<Shop>().is_some_and(|s| s.open));
    }

    #[test]
    fn prices_read_the_lap() {
        let mut c = core();
        c.sim.spawn_player(1, Vec3::ZERO, 0.0, true, true);
        c.tick(1.0 / 60.0, 0);
        set_lap(&mut c.sim, 2);
        op(&mut c, crate::op::SHOP, &[1, 1, 5, 0, 0], &[0.0]);
        assert_eq!(price_for(&c.sim, 1, 0), Some(23), "10 × 1.5²");
        assert_eq!(price_for(&c.sim, 1, 1), Some(round_f(4.0 * 1.3f32 * 1.3)), "the table's default perLap");
        // between carts the revive's price follows the lap as it moves
        op(&mut c, crate::op::BUY, &[1, LEAVE, 0], &[]);
        c.tick(1.0 / 60.0, 0);
        set_lap(&mut c.sim, 3);
        c.tick(1.0 / 60.0, 0);
        assert_eq!(price_for(&c.sim, 1, 4), Some(round_f(6.0 * 1.5f32.powi(3))));
    }

    fn round_f(x: f32) -> u32 {
        x.round() as u32
    }

    #[test]
    fn a_players_shop_bytes_reach_a_second_copy() {
        assert!(told_all(&Sim::default()).0.is_empty(), "no cart: no bytes");
        let (mut a, mut b) = (core(), core());
        let ea = a.sim.spawn_player(1, Vec3::ZERO, 0.0, true, true);
        let eb = b.sim.spawn_player(1, Vec3::ZERO, 0.0, true, true);
        a.tick(1.0 / 60.0, 0);
        b.tick(1.0 / 60.0, 0);
        assert!(told_all(&a.sim).0.is_empty(), "nothing to say: no bytes");
        op(&mut a, crate::op::CARD, &[1, 2], &[]);
        op(&mut b, crate::op::CARD, &[1, 2], &[]);
        earn(&mut a.sim, 1, 1234.0);
        set_lap(&mut a.sim, 3);
        // a two-minute cart (v8): the seconds left ride in one byte, by halves, up to 127.5
        op(&mut a, crate::op::SHOP, &[1, 9, 5, 0, 1], &[120.0]);
        assert_eq!(buy(&mut a.sim, 1, 3, 0), Ok(round_f(8.0 * 1.3f32.powi(3))));
        let want = card_price(&a.sim, 1, 1).unwrap();
        assert!(want >= round_f(10.0 * 1.5f32.powi(3)), "a card at lap 3: 10 × 1.5³ × its rarity ({want})");
        assert_eq!(buy(&mut a.sim, 1, 0, 1), Ok(want));
        let bytes = told_all(&a.sim).get(&1).cloned().unwrap();
        assert_eq!(bytes.len(), bytes::HEAD + 1, "two cards held, the first honed once");
        sync_one(&mut b.sim, eb, 1, &bytes);
        let (sa, sb) = (a.sim.res.get::<Shop>().unwrap(), b.sim.res.get::<Shop>().unwrap());
        assert_eq!((sb.open, sb.with_reward, sb.wave, sb.visit, sb.lap, sb.left), (true, true, 9, 1, 3, 120.0));
        assert_eq!((sb.visitors[&1].bought, sb.visitors[&1].offers, sb.visitors[&1].in_cart), (sa.visitors[&1].bought, sa.visitors[&1].offers, true));
        assert_eq!(sb.visitors[&1].offers[1], NO_CARD, "the place bought from is empty on the second copy too");
        assert_eq!([0, 1, 2].map(|i| card_price(&b.sim, 1, i)), [0, 1, 2].map(|i| card_price(&a.sim, 1, i)), "and its prices are the host's");
        assert_eq!((coins(&b.sim, 1), levels(&b.sim, 1)), (coins(&a.sim, 1), vec![1]));
        assert_eq!(cards::value_of(&b.sim, eb, "weapons.sidearm.damage"), cards::value_of(&a.sim, ea, "weapons.sidearm.damage"), "the second copy plays the honed card");
        // a full hand with every card honed still fits a player's bytes
        assert!(crate::cards::blob::HEAD + crate::cards::MAX_CARDS + bytes::HEAD + crate::cards::MAX_CARDS <= forge_core::snapshot::BLOB_MAX);
    }
}
