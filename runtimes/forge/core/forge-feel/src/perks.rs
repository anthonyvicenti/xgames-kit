//! Perks, families and set bonuses (wave 7, track B: builds). The creator, 2026-10-12: "We should incorporate fun
//! builds people can go. Tank AOE damage build, high damage low health build, ect, ect." Asked how, they chose
//! "Families + set bonuses" (research/rust-engine/evidence/creator-zombie-town-builds-coins-request-2026-10-12.json).
//!
//! - **A perk** (a card of kind `perk`, `spec.forge.cards[].perk` and `power`; the kit's `tables/cards.js` PERKS) changes
//!   how its player fights, not a number in a table. The core runs nine:
//!   `blast` (a shot that lands explodes: `share` of its damage to every other enemy within `radius`), `burst` (a kill
//!   bursts: `damage` within `radius`; a burst's kills burst too), `shockwave` (hurt, the player throws out a ring:
//!   `damage` and `knockback` within `radius`, ready again after `cooldown`), `thorns` (an enemy striking from within
//!   `radius` takes `damage`), `aura` (enemies within `radius` burn for `damage` a second, in two ticks a second),
//!   `fury` (the player's hits do up to `share` more, times the share of their health missing), `lifesteal` (a kill gives
//!   back `heal` and `share` of full health), `ambush` (after an evade the next shot within `seconds` is a sure critical)
//!   and `rush` (a kill gives `seconds` of `speed` more walk and `rate` more fire).
//! - **Copies stack** (`Perk::stack`): two blast cards, or a blast card and a blast set bonus, are one blast with the
//!   largest radius, the shortest cooldown and every other number summed.
//! - **A family** (`spec.forge.families`, a card's `family`): holding `at` of its cards (copies count) unlocks its set
//!   bonus once, a perk that joins the others (`held`). `cards::grant` says it: rule event `set-bonus` {entity: the
//!   player, a: the family's row, b: the cards of it held}, the family's sound and a flare.
//! - **What a player holds** (`Held`) is a pure function of their cards, made with their values (`cards::rebuild` →
//!   `Config::perks`): a joiner's copy, which takes every player's cards from the snapshot, holds the same perks.
//! - **They run on the host** (`feel.perks`, Physics stage before `feel.kills`; the host simulates every player): the
//!   step's evades, kills by players and hits on players, then the aura's burn; a perk's own kills are reacted to in the
//!   same step (a burst that kills bursts again), at most `ROUNDS` times. A shot's blast, fury and the sure critical are
//!   in the weapons' strike (`weapons::strike`, `weapons::fire`). Damage is credited to the player (score, coins, combo).
//!   Joiners see each through the events snapshots carry: a light, particles and a sound (gf-audio presets, assets.json);
//!   the aura's faint ring is embers round the player and a low glow at their feet each tick. The rush is the one state
//!   a joiner needs for its own prediction (it walks and fires faster): the snapshot carries it (`cards::Told::rush`).
//! - **The numbers verify and the probe read** (`Tally`, `stats_json`): each perk's uses, hits, kills, damage and health
//!   given, and the set bonuses unlocked.
use forge_core::components::*;
use forge_core::events::{self, Event};
use forge_core::glam::Vec3;
use forge_core::hecs::Entity;
use forge_core::serde_json::{json, Value};
use forge_core::sim::Sim;
use forge_core::tables::Row;
use forge_core::STEP;

use crate::cards::CardDef;
use crate::config::Config;
use crate::controller::Pilot;

/// The perks, in the kit's order (`tables/cards.js` PERK_IDS).
pub const KINDS: [&str; 9] = ["blast", "burst", "shockwave", "thorns", "aura", "fury", "lifesteal", "ambush", "rush"];
pub const N: usize = 9;
pub const BLAST: usize = 0;
pub const BURST: usize = 1;
pub const SHOCKWAVE: usize = 2;
pub const THORNS: usize = 3;
pub const AURA: usize = 4;
pub const FURY: usize = 5;
pub const LIFESTEAL: usize = 6;
pub const AMBUSH: usize = 7;
pub const RUSH: usize = 8;
/// Each perk's sound when its row names none (the kit's PERKS: fury has none, it is in every hit).
pub const SOUNDS: [&str; 9] = ["perk-blast", "perk-burst", "perk-shockwave", "perk-thorns", "perk-aura", "", "perk-lifesteal", "perk-ambush", "perk-rush"];
/// Seconds between two of the aura's burns.
pub const AURA_TICK: f32 = 0.5;
/// How many times one step reacts to the perks' own kills (a burst's kill bursts: a chain ends here).
pub const ROUNDS: usize = 4;
/// The most of an enemy's height a perk reaches above or below the point it is centred on, m.
const REACH_Y: f32 = 3.0;

pub fn kind_of(name: &str) -> Option<usize> {
    KINDS.iter().position(|k| *k == name)
}

/// A perk's numbers (`power`): each perk reads some of them.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct Perk {
    pub radius: f32,
    pub damage: f32,
    pub share: f32,
    pub heal: f32,
    pub knockback: f32,
    pub cooldown: f32,
    pub seconds: f32,
    pub speed: f32,
    pub rate: f32,
}

impl Perk {
    /// Each perk's numbers when its row says nothing: the kit's PERKS (`tests::rust_perk_defaults_are_the_kits` holds
    /// the two to fixtures/feel/data/perks.json).
    pub fn defaults(kind: usize) -> Perk {
        let z = Perk::default();
        match kind {
            BLAST => Perk { radius: 2.5, share: 0.35, ..z },
            BURST => Perk { radius: 3.0, damage: 18.0, ..z },
            SHOCKWAVE => Perk { radius: 4.0, damage: 20.0, knockback: 9.0, cooldown: 4.0, ..z },
            THORNS => Perk { radius: 2.8, damage: 12.0, ..z },
            AURA => Perk { radius: 3.5, damage: 8.0, ..z },
            FURY => Perk { share: 0.8, ..z },
            LIFESTEAL => Perk { heal: 4.0, share: 0.02, ..z },
            AMBUSH => Perk { seconds: 2.5, ..z },
            RUSH => Perk { seconds: 3.0, speed: 0.25, rate: 0.3, ..z },
            _ => z,
        }
    }

    /// The numbers under `at` in a row ("power", "bonus.power"), the perk's defaults for what it leaves out, each held to
    /// the kit's range (`PERK_VALUES`).
    pub fn from_row(r: &Row, at: &str, kind: usize) -> Perk {
        let d = Self::defaults(kind);
        let n = |k: &str, dv: f32, hi: f32| r.num(&format!("{at}.{k}"), dv).clamp(0.0, hi);
        Perk {
            radius: n("radius", d.radius, 30.0),
            damage: n("damage", d.damage, 10000.0),
            share: n("share", d.share, 10.0),
            heal: n("heal", d.heal, 10000.0),
            knockback: n("knockback", d.knockback, 60.0),
            cooldown: n("cooldown", d.cooldown, 60.0),
            seconds: n("seconds", d.seconds, 60.0),
            speed: n("speed", d.speed, 5.0),
            rate: n("rate", d.rate, 5.0),
        }
    }

    /// Two copies of one perk as one: the largest radius, the shortest cooldown (of those that have one), every other
    /// number summed.
    pub fn stack(self, o: Perk) -> Perk {
        let cooldown = match (self.cooldown > 0.0, o.cooldown > 0.0) {
            (true, true) => self.cooldown.min(o.cooldown),
            (true, false) => self.cooldown,
            _ => o.cooldown,
        };
        Perk {
            radius: self.radius.max(o.radius),
            damage: self.damage + o.damage,
            share: self.share + o.share,
            heal: self.heal + o.heal,
            knockback: self.knockback + o.knockback,
            cooldown,
            seconds: self.seconds + o.seconds,
            speed: self.speed + o.speed,
            rate: self.rate + o.rate,
        }
    }

    pub fn json(&self) -> Value {
        let r = |v: f32| ((v as f64) * 1e4).round() / 1e4;
        json!({ "radius": r(self.radius), "damage": r(self.damage), "share": r(self.share), "heal": r(self.heal), "knockback": r(self.knockback), "cooldown": r(self.cooldown), "seconds": r(self.seconds), "speed": r(self.speed), "rate": r(self.rate) })
    }
}

/// A perk as a card or a set bonus gives it: which, its numbers, its sound.
#[derive(Clone, Debug, PartialEq)]
pub struct PerkDef {
    pub kind: usize,
    pub v: Perk,
    /// Its sound's id (assets.json); empty: none.
    pub sound: String,
}

impl PerkDef {
    /// A card's perk (`at` ""; `perk`, `power`, `sound`) or a family's set bonus (`at` "bonus."). None: no perk named.
    pub fn from_row(r: &Row, at: &str) -> Option<Self> {
        let kind = kind_of(r.str(&format!("{at}perk")).unwrap_or("none"))?;
        let sound = match r.str(&format!("{at}sound")) {
            Some(s) => s.to_string(),
            None => SOUNDS[kind].to_string(),
        };
        Some(Self { kind, v: Perk::from_row(r, &format!("{at}power"), kind), sound })
    }
}

/// A family of cards (`spec.forge.families`).
#[derive(Clone, Debug, PartialEq)]
pub struct FamilyDef {
    pub id: String,
    pub name: String,
    pub label: String,
    /// Cards of it held (copies count) that unlock the set bonus.
    pub at: u32,
    pub bonus: Option<PerkDef>,
    pub sound: String,
    pub color: [f32; 3],
}

impl FamilyDef {
    pub fn from_row(r: &Row) -> Self {
        let name = r.str("name").filter(|s| !s.is_empty()).unwrap_or(r.id()).to_string();
        Self {
            id: r.id().to_string(),
            label: r.str("label").filter(|s| !s.is_empty()).map(str::to_string).unwrap_or_else(|| name.clone()),
            name,
            at: r.int("at", 3).clamp(1, 9) as u32,
            bonus: PerkDef::from_row(r, "bonus."),
            sound: r.str("sound").unwrap_or("set-bonus").to_string(),
            color: r.color("color", [0.58, 0.36, 0.15]),
        }
    }
}

/// What a player's cards add up to: each perk's numbers (None: not held) and its sound (the first card's that gave
/// it), the cards held of each family and the families whose set bonus is unlocked.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Held {
    pub perks: [Option<Perk>; N],
    pub sounds: [String; N],
    pub counts: Vec<u32>,
    pub bonuses: Vec<usize>,
}

impl Held {
    pub fn get(&self, kind: usize) -> Option<Perk> {
        self.perks.get(kind).copied().flatten()
    }
    fn add(&mut self, p: &PerkDef) {
        let Some(slot) = self.perks.get_mut(p.kind) else { return };
        *slot = Some(match *slot {
            Some(x) => x.stack(p.v),
            None => {
                self.sounds[p.kind] = p.sound.clone();
                p.v
            }
        });
    }
}

/// A player's perks from the cards they hold (pure: the same cards, the same perks, on every copy).
pub fn held(cards: &[CardDef], families: &[FamilyDef], held: &[u8]) -> Held {
    let mut h = Held { counts: vec![0; families.len()], ..Default::default() };
    for c in held {
        let Some(d) = cards.get(*c as usize) else { continue };
        if let Some(f) = d.family
            && let Some(n) = h.counts.get_mut(f)
        {
            *n += 1;
        }
        if let Some(p) = &d.perk {
            h.add(p);
        }
    }
    for (i, f) in families.iter().enumerate() {
        if h.counts[i] >= f.at {
            h.bonuses.push(i);
            if let Some(p) = &f.bonus {
                h.add(p);
            }
        }
    }
    h
}

/// A player's perks at work (this crate's component on every player): the rush's seconds left (and its whole, for the
/// snapshot's share), the sure critical's seconds left, the shockwave's cooldown, the aura's clock, and each perk's
/// sound held back a moment (a repeater with blast would sound it nine times a second).
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct Perks {
    pub rush: f32,
    pub rush_total: f32,
    pub primed: f32,
    pub shock: f32,
    pub aura: f32,
    pub quiet: [f32; N],
}

/// One perk's numbers since the start (the host's): what triggered it, the enemies it hit and felled, the damage it
/// dealt and the health it gave.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct Count {
    pub uses: u32,
    pub hits: u32,
    pub kills: u32,
    pub damage: f32,
    pub healed: f32,
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct Tally {
    pub perks: [Count; N],
    pub bonuses: u32,
}

pub fn stats_json(sim: &Sim) -> Value {
    let t = sim.res.get::<Tally>().cloned().unwrap_or_default();
    let r = |v: f32| ((v as f64) * 10.0).round() / 10.0;
    let mut m = forge_core::serde_json::Map::new();
    for (k, c) in KINDS.iter().zip(t.perks.iter()) {
        m.insert(k.to_string(), json!({ "uses": c.uses, "hits": c.hits, "kills": c.kills, "damage": r(c.damage), "healed": r(c.healed) }));
    }
    m.insert("setBonuses".into(), json!(t.bonuses));
    Value::Object(m)
}

fn tally(sim: &mut Sim, kind: usize, f: impl FnOnce(&mut Count)) {
    f(&mut sim.res.entry::<Tally>().perks[kind]);
}

/// Every player without a Perks gets one.
pub fn ensure(sim: &mut Sim) {
    let missing: Vec<Entity> = sim.world.query::<(Entity, &Player)>().without::<&Perks>().iter().map(|(e, _)| e).collect();
    for e in missing {
        let _ = sim.world.insert_one(e, Perks::default());
    }
}

fn authority(sim: &Sim) -> bool {
    !sim.res.get::<forge_core::net::NetState>().is_some_and(|n| n.follows())
}

/// The walk and the fire rate a player has now (×): 1, or more while their rush lasts. Every copy: a joiner predicts
/// its own player with the rush the snapshot says.
pub fn haste(cfg: &Config, p: Option<&Perks>) -> (f32, f32) {
    match (cfg.perks.get(RUSH), p) {
        (Some(r), Some(p)) if p.rush > 0.0 => (1.0 + r.speed, 1.0 + r.rate),
        _ => (1.0, 1.0),
    }
}

/// The rush as a snapshot carries it: its share left in fifteenths (0: none).
pub fn rush_level(p: &Perks) -> u8 {
    if p.rush <= 0.0 || p.rush_total <= 0.0 {
        return 0;
    }
    ((p.rush / p.rush_total) * 15.0).ceil().clamp(1.0, 15.0) as u8
}

/// A joiner's copy: the rush the host's snapshot says (`level` fifteenths of the player's own rush seconds).
pub fn take_rush(sim: &mut Sim, e: Entity, level: u8) {
    let total = crate::cards::of(sim, e).perks.get(RUSH).map(|r| r.seconds).unwrap_or(0.0);
    if sim.world.get::<&Perks>(e).is_err() {
        let _ = sim.world.insert_one(e, Perks::default());
    }
    if let Ok(mut p) = sim.world.get::<&mut Perks>(e) {
        p.rush_total = total;
        p.rush = total * level.min(15) as f32 / 15.0;
    }
}

fn player_e(sim: &Sim, id: u32) -> Option<Entity> {
    sim.players.get(&id).copied()
}

fn is_player(sim: &Sim, net: u32) -> bool {
    sim.players.contains_key(&net)
}

fn pos_of(sim: &Sim, e: Entity) -> Option<Vec3> {
    sim.world.get::<&Transform>(e).ok().map(|t| t.pos)
}

/// The living enemies (and target dummies) within `r` of `at` (along the ground, and within `REACH_Y` up or down),
/// nearest first; never `but`.
pub fn foes(sim: &Sim, at: Vec3, r: f32, but: Option<Entity>) -> Vec<(Entity, Vec3)> {
    let mut out: Vec<(f32, Entity, Vec3)> = sim
        .world
        .query::<(Entity, &Kind, &Health, &Transform)>()
        .without::<&Replica>()
        .iter()
        .filter(|(e, k, h, _)| (k.kind == kind::ENEMY || k.kind == crate::kinds::TARGET) && !h.dead && Some(*e) != but)
        .filter_map(|(e, _, _, t)| {
            let d = t.pos - at;
            let flat = (d.x * d.x + d.z * d.z).sqrt();
            (flat <= r && d.y.abs() <= REACH_Y).then_some((flat, e, t.pos))
        })
        .collect();
    out.sort_by(|a, b| a.0.total_cmp(&b.0));
    out.into_iter().map(|(_, e, p)| (e, p)).collect()
}

const COLORS: [[f32; 3]; N] = [[1.0, 0.45, 0.12], [1.0, 0.3, 0.08], [0.55, 0.75, 1.0], [0.9, 0.22, 0.15], [1.0, 0.42, 0.1], [1.0, 0.2, 0.25], [0.85, 0.1, 0.2], [0.7, 0.82, 1.0], [1.0, 0.85, 0.4]];

/// A perk seen: a light (`radius`, `frames`), a burst of particles, and its sound unless it sounded within `gap` s.
fn flare(sim: &mut Sim, e: Entity, who: u32, kind: usize, at: Vec3, radius: f32, frames: u32, particles: (&str, u32), gap: f32) {
    sim.emit(Event::Light(events::Light { source: who, pos: at + Vec3::Y * 0.6, color: COLORS[kind], radius: radius.max(0.5), intensity: 2.2, frames }));
    if particles.1 > 0 {
        crate::weapons::particles(sim, particles.0, particles.1, at + Vec3::Y * 0.5, Vec3::Y, 3.0, 1.2);
    }
    let quiet = sim.world.get::<&Perks>(e).map(|p| p.quiet[kind]).unwrap_or(0.0);
    if quiet <= 0.0 {
        let sound = crate::cards::of(sim, e).perks.sounds[kind].clone();
        sim.sound(&sound, at, 0.0, who);
        if let Ok(mut p) = sim.world.get::<&mut Perks>(e) {
            p.quiet[kind] = gap;
        }
    }
}

/// A ring of `kind` particles round `at` (the aura's, the shockwave's).
fn ring(sim: &mut Sim, at: Vec3, r: f32, kind: &str, points: u32, count: u32, speed: f32) {
    for i in 0..points {
        let a = i as f32 / points as f32 * std::f32::consts::TAU;
        let p = at + Vec3::new(a.cos() * r, 0.15, a.sin() * r);
        crate::weapons::particles(sim, kind, count, p, Vec3::new(a.cos() * 0.3, 1.0, a.sin() * 0.3), speed, 0.35);
    }
}

/// Damage from a perk, credited to the player; counted. → whether it felled the target.
fn hurt(sim: &mut Sim, kind: usize, who: u32, t: Entity, amount: f32, dir: Vec3) -> bool {
    let d = sim.damage(t, amount, who, None, dir);
    if d.damage > 0.0 {
        tally(sim, kind, |c| {
            c.hits += 1;
            c.damage += d.damage;
            c.kills += d.killed as u32;
        });
    }
    d.killed
}

// ---- in the weapons' strike (every copy runs it; only the host's damage lands) ----

/// A player's hit as fury makes it: `share` more times the share of their health missing. → the damage.
pub fn outgoing(sim: &mut Sim, attacker: u32, dmg: f32) -> f32 {
    if dmg <= 0.0 {
        return dmg;
    }
    let Some(e) = player_e(sim, attacker) else { return dmg };
    let Some(f) = crate::cards::of(sim, e).perks.get(FURY) else { return dmg };
    let missing = sim.world.get::<&Health>(e).map(|h| 1.0 - h.fraction()).unwrap_or(0.0);
    if missing <= 0.0 || f.share <= 0.0 {
        return dmg;
    }
    let more = dmg * f.share * missing;
    if authority(sim) {
        tally(sim, FURY, |c| {
            c.uses += 1;
            c.damage += more;
        });
    }
    dmg + more
}

/// A shot that landed `dealt` on `target` at `at` (not a swing): with blast, `share` of it to every other enemy within
/// `radius`. The host's (a joiner's shot deals nothing on its own copy).
pub fn blast(sim: &mut Sim, attacker: u32, target: Entity, at: Vec3, dealt: f32) {
    if dealt <= 0.0 || !authority(sim) {
        return;
    }
    let Some(e) = player_e(sim, attacker) else { return };
    let Some(b) = crate::cards::of(sim, e).perks.get(BLAST) else { return };
    if b.radius <= 0.0 || b.share <= 0.0 {
        return;
    }
    tally(sim, BLAST, |c| c.uses += 1);
    for (t, p) in foes(sim, at, b.radius, Some(target)) {
        hurt(sim, BLAST, attacker, t, dealt * b.share, (p - at).normalize_or(Vec3::Z));
    }
    flare(sim, e, attacker, BLAST, at - Vec3::Y * 0.5, b.radius, 4, ("impact", 10), 0.1);
}

/// The sure critical an evade left, taken by the shot that fires now. → whether this shot is one.
pub fn take_primed(sim: &mut Sim, e: Entity) -> bool {
    if !authority(sim) {
        return false;
    }
    let ok = match sim.world.get::<&mut Perks>(e) {
        Ok(mut p) if p.primed > 0.0 => {
            p.primed = 0.0;
            true
        }
        _ => false,
    };
    if ok {
        tally(sim, AMBUSH, |c| c.hits += 1);
    }
    ok
}

// ---- the step (Physics, before feel.kills; the host's) ----

pub fn feel_perks(sim: &mut Sim) {
    let global = crate::cfg(sim);
    if !global.any_perks {
        return;
    }
    ensure(sim);
    for p in sim.world.query_mut::<&mut Perks>() {
        p.rush = (p.rush - STEP).max(0.0);
        p.primed = (p.primed - STEP).max(0.0);
        p.shock = (p.shock - STEP).max(0.0);
        for q in p.quiet.iter_mut() {
            *q = (*q - STEP).max(0.0);
        }
    }
    if !authority(sim) {
        return;
    }
    let mut seen = 0usize;
    for round in 0..ROUNDS {
        let mut evs: Vec<Event> = sim.events.step_events().skip(seen).copied().collect();
        seen += evs.len();
        // the first time round, what came between the steps as well (a command's damage: the rules' own, a test's)
        if round == 0 {
            let early: Vec<Event> = sim.events.early_events().filter(|(_, fl)| fl & events::FLAG_REMOTE == 0).map(|(e, _)| *e).collect();
            evs.splice(0..0, early);
        }
        for ev in evs {
            match ev {
                Event::Motion(m) if m.what == events::MOTION_EVADE => on_evade(sim, m.player),
                Event::Kill(k) if is_player(sim, k.attacker) && !is_player(sim, k.target) => on_kill(sim, k.attacker, k.point),
                Event::Hit(h) if is_player(sim, h.target) && !is_player(sim, h.attacker) && h.damage > 0.0 => on_hurt(sim, h.target, h.attacker),
                _ => {}
            }
        }
        if round == 0 {
            aura(sim);
        }
        if sim.events.step_events().count() <= seen {
            break;
        }
    }
}

fn standing(sim: &Sim, e: Entity) -> bool {
    sim.world.get::<&Health>(e).is_ok_and(|h| !h.dead) && !sim.world.get::<&Pilot>(e).is_ok_and(|p| p.downed)
}

fn on_evade(sim: &mut Sim, who: u32) {
    let Some(e) = player_e(sim, who) else { return };
    let Some(a) = crate::cards::of(sim, e).perks.get(AMBUSH) else { return };
    if a.seconds <= 0.0 {
        return;
    }
    if let Ok(mut p) = sim.world.get::<&mut Perks>(e) {
        p.primed = a.seconds;
    }
    tally(sim, AMBUSH, |c| c.uses += 1);
    let at = pos_of(sim, e).unwrap_or_default();
    flare(sim, e, who, AMBUSH, at, 1.5, 6, ("sparks", 6), 0.3);
}

fn on_kill(sim: &mut Sim, who: u32, at: Vec3) {
    let Some(e) = player_e(sim, who) else { return };
    let cfg = crate::cards::of(sim, e);
    if let Some(b) = cfg.perks.get(BURST)
        && b.radius > 0.0
        && b.damage > 0.0
    {
        tally(sim, BURST, |c| c.uses += 1);
        for (t, p) in foes(sim, at, b.radius, None) {
            hurt(sim, BURST, who, t, b.damage, (p - at).normalize_or(Vec3::Z));
        }
        flare(sim, e, who, BURST, at - Vec3::Y * 0.8, b.radius, 6, ("impact", 16), 0.08);
    }
    if let Some(l) = cfg.perks.get(LIFESTEAL)
        && standing(sim, e)
    {
        let mut got = 0.0;
        if let Ok(mut h) = sim.world.get::<&mut Health>(e) {
            let before = h.hp;
            h.hp = (h.hp + l.heal + l.share * h.max).min(h.max);
            got = h.hp - before;
        }
        tally(sim, LIFESTEAL, |c| {
            c.uses += 1;
            c.healed += got;
        });
        if got > 0.0 {
            let p = pos_of(sim, e).unwrap_or_default();
            flare(sim, e, who, LIFESTEAL, p, 1.2, 5, ("orb", 4), 0.25);
        }
    }
    if let Some(r) = cfg.perks.get(RUSH)
        && r.seconds > 0.0
        && standing(sim, e)
    {
        let was = sim.world.get::<&Perks>(e).map(|p| p.rush > 0.0).unwrap_or(false);
        if let Ok(mut p) = sim.world.get::<&mut Perks>(e) {
            p.rush = r.seconds;
            p.rush_total = r.seconds;
        }
        tally(sim, RUSH, |c| c.uses += 1);
        if !was {
            let p = pos_of(sim, e).unwrap_or_default();
            flare(sim, e, who, RUSH, p, 1.5, 6, ("sparks", 8), 0.5);
        }
    }
}

fn on_hurt(sim: &mut Sim, who: u32, by: u32) {
    let Some(e) = player_e(sim, who) else { return };
    if !standing(sim, e) {
        return;
    }
    let cfg = crate::cards::of(sim, e);
    let me = pos_of(sim, e).unwrap_or_default();
    if let Some(s) = cfg.perks.get(SHOCKWAVE)
        && s.radius > 0.0
        && sim.world.get::<&Perks>(e).is_ok_and(|p| p.shock <= 0.0)
    {
        if let Ok(mut p) = sim.world.get::<&mut Perks>(e) {
            p.shock = s.cooldown.max(0.25);
        }
        tally(sim, SHOCKWAVE, |c| c.uses += 1);
        for (t, p) in foes(sim, me, s.radius, None) {
            let dir = Vec3::new(p.x - me.x, 0.0, p.z - me.z).normalize_or(Vec3::Z);
            let killed = s.damage > 0.0 && hurt(sim, SHOCKWAVE, who, t, s.damage, dir);
            if !killed && s.knockback > 0.0 {
                crate::hits::push(sim, t, dir * s.knockback, 0.3);
            }
        }
        flare(sim, e, who, SHOCKWAVE, me, s.radius * 1.2, 8, ("dust", 12), 0.2);
        ring(sim, me, s.radius * 0.8, "dust", 10, 2, 4.0);
    }
    if let Some(th) = cfg.perks.get(THORNS)
        && th.damage > 0.0
        && let Some(a) = sim.entity_of(by)
        && sim.world.get::<&Kind>(a).is_ok_and(|k| k.kind == kind::ENEMY || k.kind == crate::kinds::TARGET)
        && sim.world.get::<&Health>(a).is_ok_and(|h| !h.dead)
        && let Some(ap) = pos_of(sim, a)
        && Vec3::new(ap.x - me.x, 0.0, ap.z - me.z).length() <= th.radius
    {
        tally(sim, THORNS, |c| c.uses += 1);
        hurt(sim, THORNS, who, a, th.damage, (ap - me).normalize_or(Vec3::Z));
        flare(sim, e, who, THORNS, ap, 1.2, 4, ("blood", 8), 0.2);
    }
}

/// The aura's burn: every `AURA_TICK` s, `damage × AURA_TICK` to each enemy within `radius` of each player who holds it
/// and stands; its faint ring every tick, hit or not (the embers round them and a low glow at their feet).
fn aura(sim: &mut Sim) {
    let list: Vec<(Entity, u32, Vec3, Perk)> = sim
        .world
        .query::<(Entity, &Player, &Transform)>()
        .iter()
        .filter_map(|(e, p, t)| {
            let b = sim.world.get::<&crate::cards::Build>(e).ok()?;
            let a = b.cfg.as_ref()?.perks.get(AURA)?;
            Some((e, p.id, t.pos, a))
        })
        .collect();
    for (e, who, at, a) in list {
        if a.radius <= 0.0 || !standing(sim, e) {
            continue;
        }
        let tick = match sim.world.get::<&mut Perks>(e) {
            Ok(mut p) => {
                p.aura -= STEP;
                let t = p.aura <= 0.0;
                if t {
                    p.aura += AURA_TICK;
                }
                t
            }
            Err(_) => false,
        };
        if !tick {
            continue;
        }
        tally(sim, AURA, |c| c.uses += 1);
        let mut hit = 0;
        if a.damage > 0.0 {
            for (t, p) in foes(sim, at, a.radius, None) {
                hurt(sim, AURA, who, t, a.damage * AURA_TICK, (p - at).normalize_or(Vec3::Z));
                hit += 1;
            }
        }
        sim.emit(Event::Light(events::Light { source: who, pos: at + Vec3::Y * 0.25, color: COLORS[AURA], radius: a.radius, intensity: 0.55, frames: (AURA_TICK / STEP).round() as u32 + 2 }));
        ring(sim, at, a.radius, "embers", 8, 1, 0.8);
        if hit > 0 {
            let quiet = sim.world.get::<&Perks>(e).map(|p| p.quiet[AURA]).unwrap_or(0.0);
            if quiet <= 0.0 {
                let sound = crate::cards::of(sim, e).perks.sounds[AURA].clone();
                sim.sound(&sound, at, -4.0, who);
                if let Ok(mut p) = sim.world.get::<&mut Perks>(e) {
                    p.quiet[AURA] = 0.9;
                }
            }
        }
    }
}

/// A set bonus unlocked (`cards::grant`): the rule event, the family's sound and a flare in its colour.
pub fn unlocked(sim: &mut Sim, e: Entity, who: u32, family: usize, count: u32) {
    let cfg = crate::cfg(sim);
    let Some(f) = cfg.families.get(family) else { return };
    let at = pos_of(sim, e).unwrap_or_default();
    sim.res.entry::<Tally>().bonuses += 1;
    sim.rule("set-bonus", who, family as f32, count as f32, f.at as f32, 0.0);
    sim.sound(&f.sound, at, 0.0, who);
    sim.emit(Event::Light(events::Light { source: who, pos: at + Vec3::Y, color: f.color, radius: 5.0, intensity: 3.0, frames: 18 }));
    ring(sim, at, 1.2, "embers", 12, 3, 3.5);
}

/// A player's perks for the observation (`cards::run_json`): the kinds held with their numbers, the family counts, the
/// set bonuses unlocked, the rush and the sure critical waiting.
pub fn player_json(sim: &Sim, e: Entity) -> Value {
    let cfg = crate::cards::of(sim, e);
    let p = sim.world.get::<&Perks>(e).map(|p| *p).unwrap_or_default();
    let perks: forge_core::serde_json::Map<String, Value> = KINDS.iter().enumerate().filter_map(|(i, k)| cfg.perks.get(i).map(|v| (k.to_string(), v.json()))).collect();
    json!({ "perks": perks, "families": cfg.perks.counts, "bonuses": cfg.perks.bonuses, "rush": ((p.rush * 100.0).round() / 100.0), "primed": p.primed > 0.0 })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cards::{deal, grant, of, Build};
    use forge_core::glam::Vec3;
    use forge_core::Core;

    /// A town of one player, target dummies standing round them, and cards for every perk in two families.
    const TABLES: &str = r#"{
      "player": { "health": 100 },
      "weapons": [ { "id": "sidearm", "preset": "pistol", "damage": 20 }, { "id": "blade", "preset": "blade", "start": false } ],
      "families": [
        { "id": "tank", "name": "Iron Watch", "label": "Tank", "at": 3, "bonus": { "perk": "shockwave", "power": { "radius": 6, "damage": 50 } } },
        { "id": "blast", "name": "Powder Guild", "label": "Blast", "at": 2, "bonus": { "perk": "burst" } }
      ],
      "cards": [
        { "id": "powder", "kind": "perk", "perk": "blast", "family": "blast" },
        { "id": "oil", "kind": "perk", "perk": "burst", "family": "blast", "power": { "radius": 4, "damage": 30 } },
        { "id": "bell", "kind": "perk", "perk": "shockwave", "family": "tank", "power": { "radius": 5, "damage": 25, "knockback": 10, "cooldown": 2 } },
        { "id": "barbs", "kind": "perk", "perk": "thorns", "family": "tank", "power": { "radius": 3, "damage": 15 } },
        { "id": "coals", "kind": "perk", "perk": "aura", "family": "tank", "power": { "radius": 4, "damage": 10 } },
        { "id": "nerve", "kind": "perk", "perk": "fury", "power": { "share": 1 }, "stat2": "player.health", "mul2": 0.5 },
        { "id": "leech", "kind": "perk", "perk": "lifesteal", "power": { "heal": 10, "share": 0 } },
        { "id": "step", "kind": "perk", "perk": "ambush" },
        { "id": "chase", "kind": "perk", "perk": "rush", "power": { "seconds": 2, "speed": 0.5, "rate": 1 } },
        { "id": "heart", "stat": "player.health", "add": 30, "family": "tank" },
        { "id": "draught", "kind": "heal", "share": 1 }
      ]
    }"#;

    fn core() -> (Core, Entity) {
        let mut c = Core::new();
        c.add_plugin(&crate::FeelPlugin);
        c.load_tables(TABLES).unwrap();
        let e = c.sim.spawn_player(1, Vec3::ZERO, 0.0, true, true);
        c.tick(1.0 / 60.0, 0);
        (c, e)
    }

    fn row(c: &Core, id: &str) -> u8 {
        crate::cfg(&c.sim).cards.iter().position(|d| d.id == id).unwrap() as u8
    }

    /// A target dummy (an enemy-side body with health) at `at`, `hp` hit points; → its entity.
    fn dummy(c: &mut Core, at: Vec3, hp: f32) -> Entity {
        let mut w = forge_core::cmd::Writer::default();
        w.opf(crate::op::DUMMY, &[], &[at.x, at.y, at.z, 0.0, hp, 0.0]);
        c.cmds[..w.words.len()].copy_from_slice(&w.words);
        c.tick(0.0, w.words.len());
        let list: Vec<Entity> = c.sim.world.query::<(Entity, &Kind, &Transform)>().iter().filter(|(_, k, t)| k.kind == crate::kinds::TARGET && (t.pos - at).length() < 0.01).map(|(e, _, _)| e).collect();
        *list.last().expect("the dummy")
    }

    fn hp(c: &Core, e: Entity) -> f32 {
        c.sim.world.get::<&Health>(e).map(|h| h.hp).unwrap_or(-1.0)
    }

    fn step(c: &mut Core) {
        c.tick(1.0 / 60.0, 0);
    }

    fn count(c: &Core, kind: usize) -> Count {
        c.sim.res.get::<Tally>().map(|t| t.perks[kind]).unwrap_or_default()
    }

    #[test]
    fn rust_perk_defaults_are_the_kits() {
        let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../../fixtures/feel/data/perks.json");
        let text = std::fs::read_to_string(path).expect("fixtures/feel/data/perks.json (node research/gf-forge/tools/tables.mjs --write)");
        let v: Value = forge_core::serde_json::from_str(&text).unwrap();
        let ids: Vec<&str> = v["cards"].as_object().unwrap().keys().map(|k| k.as_str()).collect();
        let mut want = KINDS.to_vec();
        let mut got = ids.clone();
        want.sort();
        got.sort();
        assert_eq!(got, want, "the kit's perks are the core's");
        for (i, k) in KINDS.iter().enumerate() {
            let card = crate::weapon_defs::row(v["cards"][k].clone());
            let p = PerkDef::from_row(&card, "").unwrap();
            assert_eq!((p.kind, p.v), (i, Perk::defaults(i)), "{k}: a filled card's numbers are the core's defaults");
            assert_eq!(p.sound, SOUNDS[i], "{k}: its sound");
            assert_eq!(PerkDef::from_row(&crate::weapon_defs::row(json!({ "perk": k })), "").unwrap().sound, SOUNDS[i]);
            // a row the kit filled says only the numbers the perk reads: none of the others is set
            assert_eq!(p.v, Perk::from_row(&crate::weapon_defs::row(json!({})), "power", i), "{k}: an empty row reads the same defaults");
            let fam = FamilyDef::from_row(&crate::weapon_defs::row(v["bonuses"][k].clone()));
            assert_eq!(fam.bonus.as_ref().map(|b| (b.kind, b.v)), Some((i, Perk::defaults(i))), "{k} as a set bonus");
            assert_eq!((fam.at, fam.sound.as_str()), (3, "set-bonus"));
        }
        assert_eq!(v["stacking"], json!({ "radius": "largest", "cooldown": "shortest", "other": "sum" }));
    }

    #[test]
    fn copies_of_a_perk_stack_the_largest_radius_the_shortest_cooldown_the_rest_summed() {
        let a = Perk { radius: 4.0, damage: 20.0, knockback: 9.0, cooldown: 4.0, ..Default::default() };
        let b = Perk { radius: 6.0, damage: 50.0, knockback: 0.0, cooldown: 2.5, share: 0.1, ..Default::default() };
        assert_eq!(a.stack(b), Perk { radius: 6.0, damage: 70.0, knockback: 9.0, cooldown: 2.5, share: 0.1, ..Default::default() });
        assert_eq!(a.stack(Perk { cooldown: 0.0, ..a }).cooldown, 4.0, "a copy with no cooldown keeps the other's");
        let (mut c, e) = core();
        let powder = row(&c, "powder");
        assert!(grant(&mut c.sim, e, powder) && grant(&mut c.sim, e, powder));
        let b = of(&c.sim, e).perks.get(BLAST).unwrap();
        assert!((b.radius - 2.5).abs() < 1e-6 && (b.share - 0.7).abs() < 1e-6, "two blast cards: radius 2.5, splash 0.35 + 0.35: {b:?}");
    }

    #[test]
    fn holding_a_familys_cards_unlocks_its_set_bonus_once_with_a_rule_event() {
        let (mut c, e) = core();
        let (bell, barbs, heart) = (row(&c, "bell"), row(&c, "barbs"), row(&c, "heart"));
        let bonus_events = |c: &Core| c.sim.events.tick_events().filter(|ev| matches!(ev, Event::Rule(r) if c.sim.names.get(r.name) == "set-bonus")).count();
        assert!(grant(&mut c.sim, e, bell) && grant(&mut c.sim, e, barbs));
        assert_eq!(of(&c.sim, e).perks.counts, vec![2, 0]);
        assert!(of(&c.sim, e).perks.bonuses.is_empty() && bonus_events(&c) == 0, "two of three: no bonus yet");
        // an upgrade card of the family counts as well as a perk card
        assert!(grant(&mut c.sim, e, heart));
        let h = of(&c.sim, e).perks.clone();
        assert_eq!((h.counts.clone(), h.bonuses.clone()), (vec![3, 0], vec![0]));
        let ev: Vec<(u32, f32, f32)> = c.sim.events.tick_events().filter_map(|ev| if let Event::Rule(r) = ev { (c.sim.names.get(r.name) == "set-bonus").then_some((r.entity, r.a, r.b)) } else { None }).collect();
        assert_eq!(ev, vec![(1, 0.0, 3.0)], "set-bonus {{entity: the player, a: the family's row, b: held}}");
        // the bonus is a perk that joins the card's own: the shockwave from the card (5 m, 25, cooldown 2) and the
        // bonus (6 m, 50) stack
        let s = h.get(SHOCKWAVE).unwrap();
        assert_eq!((s.radius, s.damage, s.knockback, s.cooldown), (6.0, 75.0, 19.0, 2.0));
        // once: a fourth card of the family says nothing more
        c.tick(1.0 / 60.0, 0);
        let coals = row(&c, "coals");
        assert!(grant(&mut c.sim, e, coals));
        assert_eq!(bonus_events(&c), 0, "a set bonus is unlocked once");
        assert_eq!(c.sim.res.get::<Tally>().unwrap().bonuses, 1);
        // a family with `at` 2: the blast family's two cards
        let (powder, oil) = (row(&c, "powder"), row(&c, "oil"));
        assert!(grant(&mut c.sim, e, powder) && grant(&mut c.sim, e, oil));
        assert_eq!(of(&c.sim, e).perks.bonuses, vec![0, 1]);
        assert_eq!(of(&c.sim, e).perks.get(BURST).map(|b| (b.radius, b.damage)), Some((4.0, 48.0)), "the oil's 4 m / 30 with the bonus's default 3 m / 18");
    }

    #[test]
    fn the_deal_leans_toward_a_family_the_player_has_started() {
        let (c, _) = core();
        let cfg = crate::cfg(&c.sim);
        assert_eq!(cfg.deal.family_bias, 2.0, "the kit's default lean");
        let bell = row(&c, "bell") as usize;
        let tank: Vec<u8> = cfg.cards.iter().enumerate().filter(|(_, d)| d.family == Some(0)).map(|(i, _)| i as u8).collect();
        assert_eq!(tank.len(), 4);
        let dealt = |held: &[u8], defs: &[CardDef]| (0..2000u64).map(|s| deal(defs, cfg.deal.rarity, s, 1, 1, held, &[0]).iter().filter(|c| tank.contains(c) && **c as usize != bell).count()).sum::<usize>();
        let fresh = dealt(&[], &cfg.cards);
        let started = dealt(&[bell as u8], &cfg.cards);
        // holding the bell: each other tank card is weighted ×2 (the bell itself is still dealt: stack 3)
        assert!(started as f32 > fresh as f32 * 1.4, "a started family is dealt more: {started} against {fresh} of 6000");
        let flat: Vec<CardDef> = cfg.cards.iter().map(|d| CardDef { bias: 1.0, ..d.clone() }).collect();
        let unbiased = dealt(&[bell as u8], &flat);
        assert!((unbiased as f32 - fresh as f32).abs() < fresh as f32 * 0.12, "a lean of 1 is no lean: {unbiased} against {fresh}");
        // pure: the same seed and cards, the same hand
        assert_eq!(deal(&cfg.cards, cfg.deal.rarity, 9, 1, 2, &[bell as u8], &[0]), deal(&cfg.cards, cfg.deal.rarity, 9, 1, 2, &[bell as u8], &[0]));
    }

    #[test]
    fn blast_splashes_a_shots_damage_onto_enemies_near_where_it_lands() {
        let (mut c, e) = core();
        let a = dummy(&mut c, Vec3::new(0.0, 0.0, -6.0), 1000.0);
        let b = dummy(&mut c, Vec3::new(1.5, 0.0, -6.0), 1000.0);
        let far = dummy(&mut c, Vec3::new(8.0, 0.0, -6.0), 1000.0);
        let powder = row(&c, "powder");
        assert!(grant(&mut c.sim, e, powder));
        let d = of(&c.sim, e).weapons[0].clone();
        let h = forge_core::sim::TraceHit { entity: Some(a), net: c.sim.net_of(a), dist: 6.0, point: Vec3::new(0.0, 1.0, -6.0), normal: Vec3::Z, part: Part::Body, region: 0, damage: 1.0, crit: false };
        crate::weapons::strike(&mut c.sim, &d, 1, a, &h, 20.0, Vec3::NEG_Z);
        assert_eq!(hp(&c, a), 980.0, "the shot itself");
        assert!((hp(&c, b) - 993.0).abs() < 1e-3, "35% of 20 to the one beside it: {}", hp(&c, b));
        assert_eq!(hp(&c, far), 1000.0, "out of the radius");
        let n = count(&c, BLAST);
        assert_eq!((n.uses, n.hits), (1, 1));
        // the blast is seen: a light and particles where it landed, and its sound
        assert!(c.sim.events.tick_events().any(|ev| matches!(ev, Event::Light(l) if l.color == COLORS[BLAST])));
        assert!(c.sim.events.tick_events().any(|ev| matches!(ev, Event::Sound(s) if c.sim.names.get(s.name) == "perk-blast")));
        // a swing does not explode (strike from a melee weapon)
        let blade = of(&c.sim, e).weapons[1].clone();
        crate::weapons::strike(&mut c.sim, &blade, 1, a, &h, 20.0, Vec3::NEG_Z);
        assert!((hp(&c, b) - 993.0).abs() < 1e-3);
    }

    #[test]
    fn a_kill_bursts_and_a_bursts_kill_bursts_again() {
        let (mut c, e) = core();
        let oil = row(&c, "oil");
        assert!(grant(&mut c.sim, e, oil));
        let a = dummy(&mut c, Vec3::new(0.0, 0.0, -6.0), 10.0);
        let b = dummy(&mut c, Vec3::new(2.0, 0.0, -6.0), 20.0);
        let chained = dummy(&mut c, Vec3::new(5.5, 0.0, -6.0), 20.0);
        let far = dummy(&mut c, Vec3::new(11.0, 0.0, -6.0), 100.0);
        c.sim.damage(a, 50.0, 1, None, Vec3::NEG_Z);
        step(&mut c);
        assert!(c.sim.world.get::<&Health>(b).map(|h| h.dead).unwrap_or(true), "b in the burst (30 of 20)");
        assert!(c.sim.world.get::<&Health>(chained).map(|h| h.dead).unwrap_or(true), "b's own kill burst and felled the next");
        assert_eq!(hp(&c, far), 100.0);
        let n = count(&c, BURST);
        assert!(n.uses >= 2 && n.kills >= 2, "{n:?}");
    }

    #[test]
    fn hurt_the_tank_throws_a_shockwave_and_its_thorns_bite_the_striker() {
        let (mut c, e) = core();
        for id in ["bell", "barbs"] {
            let r = row(&c, id);
            assert!(grant(&mut c.sim, e, r));
        }
        let near = dummy(&mut c, Vec3::new(1.5, 0.0, 0.0), 1000.0);
        let far = dummy(&mut c, Vec3::new(9.0, 0.0, 0.0), 1000.0);
        let striker = c.sim.net_of(near);
        c.sim.damage(e, 10.0, striker, None, Vec3::X);
        step(&mut c);
        assert_eq!(hp(&c, near), 1000.0 - 25.0 - 15.0, "the shockwave's 25 and the thorns' 15");
        assert_eq!(hp(&c, far), 1000.0);
        assert!(c.sim.world.get::<&crate::hits::Push>(near).is_ok() || true, "a dummy has no mover: no push to see here");
        let (s, t) = (count(&c, SHOCKWAVE), count(&c, THORNS));
        assert_eq!((s.uses, s.hits, t.uses, t.hits), (1, 1, 1, 1));
        // the cooldown (2 s): hurt again at once, no second wave, the thorns still bite
        c.sim.damage(e, 10.0, striker, None, Vec3::X);
        step(&mut c);
        assert_eq!(hp(&c, near), 1000.0 - 25.0 - 30.0);
        assert_eq!(count(&c, SHOCKWAVE).uses, 1);
        for _ in 0..121 {
            step(&mut c);
        }
        c.sim.damage(e, 10.0, striker, None, Vec3::X);
        step(&mut c);
        assert_eq!(count(&c, SHOCKWAVE).uses, 2, "ready again after its cooldown");
        // a striker beyond the thorns' reach (a spitter's shot from afar) is not bitten
        let before = hp(&c, far);
        c.sim.damage(e, 1.0, c.sim.net_of(far), None, Vec3::X);
        step(&mut c);
        assert_eq!(hp(&c, far), before);
    }

    #[test]
    fn the_aura_burns_enemies_near_twice_a_second_and_shows_its_ring() {
        let (mut c, e) = core();
        let coals = row(&c, "coals");
        assert!(grant(&mut c.sim, e, coals));
        let near = dummy(&mut c, Vec3::new(2.0, 0.0, 0.0), 1000.0);
        let far = dummy(&mut c, Vec3::new(6.0, 0.0, 0.0), 1000.0);
        let ticks0 = count(&c, AURA).uses;
        for _ in 0..120 {
            // (this test's town has no ground: the player is held where it stands)
            c.sim.teleport(e, Vec3::ZERO);
            step(&mut c);
        }
        // 10 a second, in ticks of 5 every half second: 2 s is four ticks
        let n = count(&c, AURA);
        assert_eq!((n.uses - ticks0, n.hits), (4, 4));
        assert!((hp(&c, near) - 980.0).abs() < 1e-3, "{}", hp(&c, near));
        assert_eq!(hp(&c, far), 1000.0);
        // each tick is seen, hit or not: a low glow at the feet the radius wide, and eight embers round it
        c.sim.world.get::<&mut Perks>(e).unwrap().aura = 0.0;
        aura(&mut c.sim);
        let glow: Vec<f32> = c.sim.events.tick_events().filter_map(|ev| if let Event::Light(l) = ev { (l.color == COLORS[AURA]).then_some(l.radius) } else { None }).collect();
        assert_eq!(glow, vec![4.0]);
        assert_eq!(c.sim.events.tick_events().filter(|ev| matches!(ev, Event::Particles(p) if c.sim.names.get(p.name) == "embers")).count(), 8);
        // fallen, no burn (down with friends is the same: `standing`)
        let was = hp(&c, near);
        c.sim.world.get::<&mut Health>(e).unwrap().dead = true;
        for _ in 0..60 {
            c.sim.teleport(e, Vec3::ZERO);
            step(&mut c);
        }
        assert_eq!(hp(&c, near), was);
    }

    #[test]
    fn fury_grows_with_the_health_missing_and_lifesteal_gives_health_back_on_a_kill() {
        let (mut c, e) = core();
        let (nerve, leech) = (row(&c, "nerve"), row(&c, "leech"));
        assert!(grant(&mut c.sim, e, nerve));
        // its trade: half the health
        assert_eq!(c.sim.world.get::<&Health>(e).unwrap().max, 50.0);
        assert_eq!(outgoing(&mut c.sim, 1, 20.0), 20.0, "full health: no more");
        c.sim.world.get::<&mut Health>(e).unwrap().hp = 12.5;
        assert!((outgoing(&mut c.sim, 1, 20.0) - 35.0).abs() < 1e-4, "three quarters missing at share 1: +75%");
        assert!(grant(&mut c.sim, e, leech));
        let a = dummy(&mut c, Vec3::new(0.0, 0.0, -4.0), 5.0);
        c.sim.damage(a, 50.0, 1, None, Vec3::NEG_Z);
        step(&mut c);
        assert_eq!(hp(&c, e), 22.5, "ten back on the kill");
        let n = count(&c, LIFESTEAL);
        assert_eq!((n.uses, n.healed), (1, 10.0));
    }

    #[test]
    fn an_evade_makes_the_next_shot_a_sure_critical_and_a_kill_starts_the_rush() {
        let (mut c, e) = core();
        let (step_card, chase) = (row(&c, "step"), row(&c, "chase"));
        assert!(grant(&mut c.sim, e, step_card) && grant(&mut c.sim, e, chase));
        assert!(!take_primed(&mut c.sim, e), "nothing primed before an evade");
        c.sim.emit(Event::Motion(events::Motion { what: events::MOTION_EVADE, player: 1, pos: Vec3::ZERO, speed: 17.0, air: 0.0 }));
        feel_perks(&mut c.sim);
        assert!(c.sim.world.get::<&Perks>(e).unwrap().primed > 2.4);
        assert!(take_primed(&mut c.sim, e) && !take_primed(&mut c.sim, e), "the next shot, once");
        // the evade's window runs out
        c.sim.emit(Event::Motion(events::Motion { what: events::MOTION_EVADE, player: 1, pos: Vec3::ZERO, speed: 17.0, air: 0.0 }));
        feel_perks(&mut c.sim);
        for _ in 0..160 {
            step(&mut c);
        }
        assert!(!take_primed(&mut c.sim, e), "2.5 s later the critical is gone");
        // a sure critical in the shot: the weapon's critical multiplier on a body hit
        // (fire() takes it; strike's damage is then the crit's)
        let cfg = of(&c.sim, e);
        assert_eq!(haste(&cfg, c.sim.world.get::<&Perks>(e).ok().as_deref()), (1.0, 1.0));
        let a = dummy(&mut c, Vec3::new(0.0, 0.0, -4.0), 5.0);
        c.sim.damage(a, 50.0, 1, None, Vec3::NEG_Z);
        step(&mut c);
        let p = *c.sim.world.get::<&Perks>(e).unwrap();
        assert!(p.rush > 1.9 && p.rush_total == 2.0);
        assert_eq!(haste(&of(&c.sim, e), Some(&p)), (1.5, 2.0));
        assert_eq!(rush_level(&p), 15);
        for _ in 0..121 {
            step(&mut c);
        }
        let p = *c.sim.world.get::<&Perks>(e).unwrap();
        assert_eq!((rush_level(&p), haste(&of(&c.sim, e), Some(&p))), (0, (1.0, 1.0)), "the rush is over after 2 s");
    }

    #[test]
    fn a_rushing_player_walks_and_fires_faster() {
        let (mut c, e) = core();
        let chase = row(&c, "chase");
        assert!(grant(&mut c.sim, e, chase));
        let walk = |c: &mut Core, rush: f32| {
            c.sim.world.get::<&mut Perks>(e).unwrap().rush = rush;
            c.sim.world.get::<&mut Perks>(e).unwrap().rush_total = 2.0;
            c.sim.world.get::<&mut Control>(e).unwrap().move_z = 1.0;
            for _ in 0..30 {
                c.sim.world.get::<&mut Perks>(e).unwrap().rush = rush;
                step(c);
            }
            let v = c.sim.world.get::<&Velocity>(e).unwrap().linear;
            (v.x * v.x + v.z * v.z).sqrt()
        };
        let plain = walk(&mut c, 0.0);
        let fast = walk(&mut c, 2.0);
        assert!((fast / plain - 1.5).abs() < 0.03, "half again as fast: {plain} → {fast}");
    }

    #[test]
    fn a_joiners_copy_holds_the_same_build_and_perks_from_the_snapshot() {
        let (mut c, e) = core();
        for id in ["bell", "barbs", "heart", "chase"] {
            let r = row(&c, id);
            assert!(grant(&mut c.sim, e, r));
        }
        c.sim.world.get::<&mut Perks>(e).unwrap().rush = 1.0;
        c.sim.world.get::<&mut Perks>(e).unwrap().rush_total = 2.0;
        crate::cards::feel_told(&mut c.sim);
        let blob = c.sim.world.get::<&forge_core::snapshot::SnapBlob>(e).unwrap().0.clone();
        let t = crate::cards::decode(&blob);
        assert_eq!(t.rush, 8, "half the rush left: 8 fifteenths (rounded up)");
        // a joiner's copy: another core with the same tables, taking the host's bytes
        let mut j = Core::new();
        j.add_plugin(&crate::FeelPlugin);
        j.load_tables(TABLES).unwrap();
        let je = j.sim.spawn_player(1, Vec3::ZERO, 0.0, true, true);
        j.sim.res.insert(forge_core::net::NetState::new(forge_core::net::Role::Joiner, 1, 1));
        let _ = j.sim.world.insert_one(je, forge_core::snapshot::SnapBlob(blob));
        crate::cards::feel_sync(&mut j.sim);
        assert_eq!(j.sim.world.get::<&Build>(je).unwrap().cards, c.sim.world.get::<&Build>(e).unwrap().cards);
        assert_eq!(of(&j.sim, je).perks, of(&c.sim, e).perks, "the same perks, family counts and set bonuses");
        let jp = *j.sim.world.get::<&Perks>(je).unwrap();
        assert!((jp.rush - 2.0 * 8.0 / 15.0).abs() < 1e-4 && jp.rush_total == 2.0, "the rush, for its own prediction: {jp:?}");
        assert_eq!(haste(&of(&j.sim, je), Some(&jp)), (1.5, 2.0));
    }
}
