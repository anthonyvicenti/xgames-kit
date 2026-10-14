//! Elites (wave 7, track E; `spec.forge.elites`, the kit's `tables/elites.js`). The creator, 2026-10-12, after builds
//! and coins chose "Elite zombies": from the second lap on, some of the risen carry a modifier you can read at a glance
//! (burning, which sets you alight; armoured; splitting, two smaller ones on death; fast), and elites drop more coins.
//!
//! - **Who.** The director's ordinary arrivals (never a boss's summons), once the run is at lap `lap` or wave `wave`:
//!   `chance` of them that lap, `grow` more each lap after, at most `chance_most`, at most `per_wave` a wave, of the kinds
//!   `kinds` names (every kind but the boss when it names none; the boss only with `boss`). The host's seeded dice
//!   decide (`sim.rng`, only rolled once elites can rise, so a run before then plays as it did); `OP_ELITE` forces the
//!   next arrivals (QA, the probe).
//! - **What.** An elite is its row's `Def` changed (`Roster::variant`: one per row, lap and modifier, made once): health ×
//!   `health`; fast: speed × `fast.speed`, its tells, cooldowns and recoveries ÷ `fast.attack`; armoured: staggers,
//!   downs and flinches ÷ `armoured.knock`, and forge-core's `Marked` (taken `armoured.damage`; every elite's bounty `coins`). Its
//!   `Enemy::mark` (the modifier, and `CHILD` for a split one's young) is the AI view's ELITE field and the snapshot's
//!   `Marked` mark, so a joiner's copy draws it the same.
//! - **Burning.** A blow (or a caster's orb) that lands sets the player alight: `burning.dps` for `burning.seconds`, a
//!   bite every `burning.tick` (`Sim::damage` from the elite), a new blow starting the seconds again. Where a burning
//!   elite falls it leaves a patch of fire for `patch.seconds`: whoever stands in it burns (at `patch.dps`, a second
//!   after they step out). The host's alone (it simulates every player); a joiner sees and hears it through the host's
//!   events: the rule `burning` {entity: the player, a: seconds left, b: damage a second, c: who}, embers on the player
//!   and in the patch, the patch's light, the bite's sound and HIT, and the health the snapshot carries.
//! - **Splitting.** When it falls, `splitting.count` of `splitting.into` (its own kind when empty) crawl out round it,
//!   each with `splitting.health` × its most health and drawn at `splitting.scale` ×, marked `CHILD`; they never split.
//! - **Rule events:** `elite` {entity, a: modifier, b: row, c: 1 the first of that modifier this run, d: 1 a split
//!   one's young} for every elite and child raised; `burning`; `elite-split` {entity: the elite, a: children, b: row}.
use forge_core::components::*;
use forge_core::events::{self, Event};
use forge_core::glam::{Vec2, Vec3};
use forge_core::hecs::Entity;
use forge_core::net::NetState;
use forge_core::sim::Sim;
use forge_core::tables::{hex_linear, Row};

use crate::defs::{Arch, Def, Roster};
use crate::enemy::{self, Enemy, State};

/// A modifier (the AI view's ELITE field and the snapshot's mark: its low three bits).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Default)]
#[repr(u8)]
pub enum Mod {
    #[default]
    None = 0,
    Burning = 1,
    Armoured = 2,
    Splitting = 3,
    Fast = 4,
}

impl Mod {
    pub const ALL: [Mod; 4] = [Mod::Burning, Mod::Armoured, Mod::Splitting, Mod::Fast];
    pub fn from_u8(v: u8) -> Mod {
        match v & 7 {
            1 => Mod::Burning,
            2 => Mod::Armoured,
            3 => Mod::Splitting,
            4 => Mod::Fast,
            _ => Mod::None,
        }
    }
    pub fn name(self) -> &'static str {
        ["", "burning", "armoured", "splitting", "fast"][self as usize]
    }
}

/// The mark's bit for a split elite's young (drawn small, with the splitting rim at half).
pub const CHILD: u8 = 8;

/// What every modifier has (the kit's `look`): on, its share, its name and line, and how it reads at a glance.
#[derive(Clone, Debug, PartialEq)]
pub struct Look {
    pub on: bool,
    pub weight: f32,
    pub name: String,
    pub line: String,
    /// The rim's colour (linear) and strength.
    pub color: [f32; 3],
    pub glow: f32,
    /// The body's colour multiplier (linear; white: its own).
    pub tint: [f32; 3],
}

impl Look {
    fn new(color: &str, glow: f32, tint: &str, name: &str, line: &str) -> Look {
        Look { on: true, weight: 1.0, name: name.into(), line: line.into(), color: lin(color), glow, tint: lin(tint) }
    }
    /// The modifier's own object (`spec.forge.elites.<modifier>`) over `d`.
    fn from_row(r: &Row, d: &Look) -> Look {
        Look {
            on: r.bool("on", d.on),
            weight: r.num("weight", d.weight).max(0.0),
            name: r.str("name").map(str::to_string).unwrap_or_else(|| d.name.clone()),
            line: r.str("line").map(str::to_string).unwrap_or_else(|| d.line.clone()),
            color: r.color("color", d.color),
            glow: r.num("glow", d.glow).clamp(0.0, 8.0),
            tint: r.color("tint", d.tint),
        }
    }
}

fn lin(hex: &str) -> [f32; 3] {
    hex_linear(hex).unwrap_or([1.0; 3])
}

/// `spec.forge.elites`, typed (defaults equal the kit's: a test holds them to kit/tables/defaults.json).
#[derive(Clone, Debug, PartialEq)]
pub struct Elites {
    pub on: bool,
    pub lap: u32,
    /// From this wave as players count it (0: by lap alone).
    pub wave: u32,
    pub chance: f32,
    pub grow: f32,
    pub chance_most: f32,
    pub per_wave: u32,
    pub health: f32,
    pub coins: f32,
    pub boss: bool,
    /// Enemy ids that may rise as elites (empty: every kind but a boss).
    pub kinds: Vec<String>,
    /// Burning, armoured, splitting, fast (by `Mod as usize - 1`).
    pub looks: [Look; 4],
    pub burn_dps: f32,
    pub burn_seconds: f32,
    pub burn_tick: f32,
    pub patch_seconds: f32,
    pub patch_radius: f32,
    pub patch_dps: f32,
    pub snd_ignite: String,
    pub snd_burn: String,
    pub armour_damage: f32,
    pub armour_knock: f32,
    pub split_into: String,
    pub split_count: u32,
    pub split_health: f32,
    pub split_scale: f32,
    pub snd_split: String,
    pub fast_speed: f32,
    pub fast_attack: f32,
}

impl Default for Elites {
    fn default() -> Self {
        Elites {
            on: false,
            lap: 1,
            wave: 0,
            chance: 0.12,
            grow: 0.04,
            chance_most: 0.4,
            per_wave: 4,
            health: 1.5,
            coins: 3.0,
            boss: false,
            kinds: Vec::new(),
            looks: [
                Look::new("#ff6a1a", 2.6, "#ffffff", "Burning", "Its blows set you alight"),
                Look::new("#8fb4dc", 1.4, "#5a5e66", "Armoured", "Iron-hard: it takes half of every hit"),
                Look::new("#a4ff4f", 2.2, "#ffffff", "Splitting", "Fell it and two smaller ones crawl out"),
                Look::new("#c9a4ff", 2.2, "#ffffff", "Fast", "Quicker on its feet and in its blows"),
            ],
            burn_dps: 5.0,
            burn_seconds: 3.0,
            burn_tick: 0.5,
            patch_seconds: 3.0,
            patch_radius: 1.4,
            patch_dps: 6.0,
            snd_ignite: "elite-ignite".into(),
            snd_burn: "elite-burn".into(),
            armour_damage: 0.5,
            armour_knock: 0.35,
            split_into: String::new(),
            split_count: 2,
            split_health: 0.35,
            split_scale: 0.7,
            snd_split: "elite-split".into(),
            fast_speed: 1.45,
            fast_attack: 1.35,
        }
    }
}

impl Elites {
    pub fn from_row(r: &Row) -> Elites {
        let d = Elites::default();
        let names = ["burning", "armoured", "splitting", "fast"];
        let looks = std::array::from_fn(|i| Look::from_row(&r.row(names[i]).unwrap_or_default(), &d.looks[i]));
        let st = |k: &str, dv: &str| r.str(k).map(str::to_string).unwrap_or_else(|| dv.to_string());
        Elites {
            on: r.bool("on", d.on),
            lap: r.int("lap", d.lap as i64).clamp(0, 99) as u32,
            wave: r.int("wave", d.wave as i64).clamp(0, 9999) as u32,
            chance: r.num("chance", d.chance).clamp(0.0, 1.0),
            grow: r.num("grow", d.grow).clamp(0.0, 1.0),
            chance_most: r.num("chanceMost", d.chance_most).clamp(0.0, 1.0),
            per_wave: r.int("perWave", d.per_wave as i64).clamp(0, 200) as u32,
            health: r.num("health", d.health).clamp(1.0, 20.0),
            coins: r.num("coins", d.coins).clamp(1.0, 20.0),
            boss: r.bool("boss", d.boss),
            kinds: r.rows("kinds").iter().filter_map(|k| k.str("type").filter(|s| !s.is_empty()).map(str::to_string)).collect(),
            looks,
            burn_dps: r.num("burning.dps", d.burn_dps).clamp(0.0, 200.0),
            burn_seconds: r.num("burning.seconds", d.burn_seconds).clamp(0.5, 20.0),
            burn_tick: r.num("burning.tick", d.burn_tick).clamp(0.1, 2.0),
            patch_seconds: r.num("burning.patch.seconds", d.patch_seconds).clamp(0.0, 20.0),
            patch_radius: r.num("burning.patch.radius", d.patch_radius).clamp(0.3, 6.0),
            patch_dps: r.num("burning.patch.dps", d.patch_dps).clamp(0.0, 200.0),
            snd_ignite: st("burning.sounds.ignite", &d.snd_ignite),
            snd_burn: st("burning.sounds.burn", &d.snd_burn),
            armour_damage: r.num("armoured.damage", d.armour_damage).clamp(0.05, 1.0),
            armour_knock: r.num("armoured.knock", d.armour_knock).clamp(0.0, 1.0),
            split_into: st("splitting.into", &d.split_into),
            split_count: r.int("splitting.count", d.split_count as i64).clamp(1, 6) as u32,
            split_health: r.num("splitting.health", d.split_health).clamp(0.05, 1.0),
            split_scale: r.num("splitting.scale", d.split_scale).clamp(0.3, 1.0),
            snd_split: st("splitting.sounds.split", &d.snd_split),
            fast_speed: r.num("fast.speed", d.fast_speed).clamp(1.0, 3.0),
            fast_attack: r.num("fast.attack", d.fast_attack).clamp(1.0, 3.0),
        }
    }
    pub fn look(&self, m: Mod) -> Option<&Look> {
        if m == Mod::None { None } else { self.looks.get(m as usize - 1) }
    }
    /// Whether elites may rise at lap `lap`, wave `number` (as players count it).
    pub fn open(&self, lap: u32, number: u32) -> bool {
        self.on && (lap >= self.lap || (self.wave > 0 && number >= self.wave))
    }
    /// The chance an ordinary arrival is an elite at lap `lap`.
    pub fn chance_at(&self, lap: u32) -> f32 {
        (self.chance + self.grow * lap.saturating_sub(self.lap) as f32).min(self.chance_most).clamp(0.0, 1.0)
    }
    /// Whether enemies of `def` may rise as elites.
    pub fn allows(&self, def: &Def) -> bool {
        if def.arch == Arch::Boss && !self.boss {
            return false;
        }
        self.kinds.is_empty() || self.kinds.iter().any(|k| *k == def.id)
    }
    /// A modifier by the weights of those that are on (`u` in 0..1). None: none is on.
    pub fn pick(&self, u: f32) -> Option<Mod> {
        let total: f32 = Mod::ALL.iter().filter_map(|m| self.look(*m)).filter(|l| l.on).map(|l| l.weight).sum();
        if total <= 0.0 {
            return None;
        }
        let mut x = u.clamp(0.0, 0.9999) * total;
        for m in Mod::ALL {
            let l = &self.looks[m as usize - 1];
            if !l.on || l.weight <= 0.0 {
                continue;
            }
            if x < l.weight {
                return Some(m);
            }
            x -= l.weight;
        }
        Mod::ALL.iter().rev().copied().find(|m| self.looks[*m as usize - 1].on && self.looks[*m as usize - 1].weight > 0.0)
    }
    /// `def` as an elite with modifier `m` (or a split one's young when `child`): see the module's notes.
    pub fn apply(&self, def: &mut Def, m: Mod, child: bool) {
        if child {
            let s = self.split_scale;
            def.scale *= s;
            def.radius = (def.radius * s).max(0.1);
            def.height = (def.height * s).max(0.3);
            def.reach = (def.reach * s.sqrt()).max(0.4);
            def.ring *= s.sqrt();
            def.score = (def.score * 0.5).round();
            return;
        }
        if m == Mod::None {
            return;
        }
        def.health *= self.health;
        match m {
            Mod::Fast => {
                def.speed *= self.fast_speed;
                let a = self.fast_attack.max(1.0);
                def.windup /= a;
                def.cast_windup /= a;
                def.cooldown /= a;
                def.recover /= a;
            }
            Mod::Armoured => {
                let k = self.armour_knock;
                let inv = if k > 1e-3 { 1.0 / k } else { 1000.0 };
                def.stagger_at *= inv;
                def.knock_at *= inv;
                def.spring *= k;
                def.down *= k.max(0.2);
            }
            _ => {}
        }
    }
}

/// The host's elite state: forced modifiers (QA), the run's firsts, this wave's count, who burns, the fire on the ground,
/// and counts for QA (`forge.ai_elites()`).
#[derive(Default)]
pub struct EliteState {
    /// Modifiers the next director arrivals take, first first (OP_ELITE).
    pub force: Vec<Mod>,
    /// Elites raised this wave.
    pub this_wave: u32,
    /// The modifiers seen this run (bit per `Mod`).
    pub seen: u8,
    pub burns: Vec<Burn>,
    pub patches: Vec<Patch>,
    /// QA: raised by modifier (index `Mod as usize`), children raised, splits, burn bites and their damage, ignitions.
    pub raised: [u32; 5],
    pub children: u32,
    pub splits: u32,
    pub bites: u32,
    pub burned: f32,
    pub ignitions: u32,
}

/// A player burning (the host's).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Burn {
    pub player: Entity,
    pub id: u32,
    pub left: f32,
    pub dps: f32,
    /// Seconds to the next bite.
    pub next: f32,
    /// Who set them alight (a net id, the bites' attacker).
    pub by: u32,
}

/// Fire on the ground where a burning elite fell.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Patch {
    pub at: Vec3,
    pub left: f32,
    pub radius: f32,
    pub dps: f32,
    pub by: u32,
    /// Seconds to its next embers and light.
    pub fx: f32,
}

/// Whether this copy decides (solo or the host; never a joiner's or a viewer's copy).
fn decides(sim: &Sim) -> bool {
    !sim.res.get::<NetState>().is_some_and(|n| n.follows())
}

/// The director's arrival of `row` at lap `lap`, wave `number`: the modifier it rises with (`Mod::None`: ordinary).
/// Forced ones first; else the dice, once elites can rise.
pub fn roll(sim: &mut Sim, roster: &Roster, row: u16, lap: u32, number: u32) -> Mod {
    let e = &roster.elites;
    let def = roster.def(row);
    let st = sim.res.entry::<EliteState>();
    if !st.force.is_empty() {
        return st.force.remove(0);
    }
    if !e.open(lap, number) || !e.allows(&def) || st.this_wave >= e.per_wave {
        return Mod::None;
    }
    let chance = e.chance_at(lap);
    if sim.rng.f32() >= chance {
        return Mod::None;
    }
    let u = sim.rng.f32();
    e.pick(u).unwrap_or(Mod::None)
}

/// After an enemy of `row` rose as `m` (or as a split one's young): its mark, its share of hits and its bounty, the
/// counts, and the rule event.
pub fn raised(sim: &mut Sim, e: Entity, row: u16, m: Mod, child: bool) {
    if m == Mod::None && !child {
        return;
    }
    let mark = m as u8 | if child { CHILD } else { 0 };
    let (taken, coins) = sim.res.get::<Roster>().map(|r| (r.elites.armour_damage, r.elites.coins)).unwrap_or((0.5, 3.0));
    if let Ok(mut en) = sim.world.get::<&mut Enemy>(e) {
        en.mark = mark;
    }
    let elite = m != Mod::None && !child;
    let _ = sim.world.insert_one(e, Marked { mark, taken: if m == Mod::Armoured { taken } else { 1.0 }, bounty: if elite { coins } else { 1.0 } });
    let st = sim.res.entry::<EliteState>();
    let first = m != Mod::None && st.seen & (1 << m as u8) == 0;
    if m != Mod::None {
        st.seen |= 1 << m as u8;
        st.raised[m as usize] += 1;
        if !child {
            st.this_wave += 1;
        }
    }
    if child {
        st.children += 1;
    }
    let net = sim.net_of(e);
    sim.rule("elite", net, m as u8 as f32, row as f32, first as u8 as f32, child as u8 as f32);
}

/// A new wave: its count starts again.
pub fn wave_started(sim: &mut Sim) {
    sim.res.entry::<EliteState>().this_wave = 0;
}

/// A new run (the director stopped or started): the firsts, the fire and the burns go (what QA forced stays).
pub fn reset(sim: &mut Sim) {
    let st = sim.res.entry::<EliteState>();
    st.seen = 0;
    st.this_wave = 0;
    st.burns.clear();
    st.patches.clear();
}

/// A burning elite's blow landed on `target` (a player): set them alight, or start their seconds again.
#[inline(never)]
pub fn ignite(sim: &mut Sim, target: Entity, by: u32, dps: f32, seconds: f32) {
    let Ok(id) = sim.world.get::<&Player>(target).map(|p| p.id) else { return };
    if sim.world.get::<&Health>(target).is_ok_and(|h| h.dead) || dps <= 0.0 {
        return;
    }
    let (tick, snd) = sim.res.get::<Roster>().map(|r| (r.elites.burn_tick, r.elites.snd_ignite.clone())).unwrap_or((0.5, String::new()));
    let st = sim.res.entry::<EliteState>();
    let fresh = match st.burns.iter_mut().find(|b| b.player == target) {
        Some(b) => {
            let was = b.left;
            b.left = b.left.max(seconds);
            b.dps = b.dps.max(dps);
            b.by = by;
            was <= 0.0
        }
        None => {
            st.burns.push(Burn { player: target, id, left: seconds, dps, next: tick, by });
            true
        }
    };
    if fresh {
        st.ignitions += 1;
    }
    let pos = sim.world.get::<&Transform>(target).map(|t| t.pos).unwrap_or(Vec3::ZERO);
    if fresh && !snd.is_empty() {
        sim.sound(&snd, pos + Vec3::Y, -4.0, by);
    }
    sim.rule("burning", id, seconds, dps, by as f32, 0.0);
    embers(sim, pos + Vec3::Y * 1.0, 8, 0.9);
}

#[inline(never)]
fn embers(sim: &mut Sim, at: Vec3, count: u32, spread: f32) {
    let name = sim.names.id("embers");
    sim.emit(Event::Particles(events::Particles { name, count, pos: at, dir: Vec3::Y, speed: 1.2, spread }));
}

/// The Ai-stage system (after the enemies, the host's): the burns bite, the fire on the ground burns.
pub fn system(sim: &mut Sim) {
    let busy = sim.res.get::<EliteState>().is_some_and(|s| !s.burns.is_empty() || !s.patches.is_empty());
    if !busy || !decides(sim) {
        return;
    }
    let dt = sim.time.dt;
    let (tick, snd) = sim.res.get::<Roster>().map(|r| (r.elites.burn_tick, r.elites.snd_burn.clone())).unwrap_or((0.5, String::new()));
    let mut st = sim.res.take::<EliteState>();
    // ---- the fire on the ground: whoever stands in it burns (on for a second after they step out) ----
    let players: Vec<(Entity, Vec3, bool)> = sim.world.query::<(Entity, &Player, &Transform, Option<&Health>)>().iter().map(|(e, _, t, h)| (e, t.pos, h.is_none_or(|h| !h.dead))).collect();
    let mut light: Vec<(Vec3, f32)> = Vec::new();
    let mut lit: Vec<(Entity, u32, f32)> = Vec::new();
    for p in st.patches.iter_mut() {
        p.left -= dt;
        p.fx -= dt;
        if p.fx <= 0.0 && p.left > 0.0 {
            p.fx = 0.15;
            light.push((p.at, p.radius));
        }
        for (e, pos, alive) in &players {
            if *alive && Vec2::new(pos.x - p.at.x, pos.z - p.at.z).length() <= p.radius && (pos.y - p.at.y).abs() < 1.6 {
                lit.push((*e, p.by, p.dps));
            }
        }
    }
    st.patches.retain(|p| p.left > 0.0);
    // ---- the burns: a bite every tick ----
    let mut bites: Vec<(Entity, f32, u32)> = Vec::new();
    for b in st.burns.iter_mut() {
        b.left -= dt;
        b.next -= dt;
        if b.next <= 0.0 && b.left > -tick * 0.5 {
            bites.push((b.player, b.dps * tick, b.by));
            b.next += tick;
        }
    }
    st.burns.retain(|b| b.left > 0.0 && sim.world.get::<&Health>(b.player).is_ok_and(|h| !h.dead));
    sim.res.insert(st);
    for (e, by, dps) in lit {
        // in the fire: alight a second past this step
        ignite_quiet(sim, e, by, dps, 1.0);
    }
    for (at, r) in light {
        let (k, j) = (sim.rng.f32(), sim.rng.f32());
        embers(sim, at + Vec3::new((k - 0.5) * r, 0.15, (j - 0.5) * r), 4, 1.2);
        sim.emit(Event::Light(events::Light { source: 0, pos: at + Vec3::Y * 0.4, color: [1.0, 0.42, 0.1], radius: (r * 2.4).max(2.5), intensity: 1.6 + k * 0.6, frames: 10 }));
    }
    for (e, amount, by) in bites {
        let pos = sim.world.get::<&Transform>(e).map(|t| t.pos).unwrap_or(Vec3::ZERO);
        let dealt = sim.damage(e, amount, by, None, Vec3::ZERO);
        if dealt.damage > 0.0 {
            let st = sim.res.entry::<EliteState>();
            st.bites += 1;
            st.burned += dealt.damage;
            if !snd.is_empty() {
                sim.sound(&snd, pos + Vec3::Y, -10.0, by);
            }
            embers(sim, pos + Vec3::Y * 1.1, 5, 0.8);
        }
    }
}

/// Set alight with no sound or rule event of its own each step (a patch keeps whoever stands in it alight): the rule
/// event when it starts.
#[inline(never)]
fn ignite_quiet(sim: &mut Sim, target: Entity, by: u32, dps: f32, seconds: f32) {
    let burning = sim.res.get::<EliteState>().and_then(|s| s.burns.iter().find(|b| b.player == target).map(|b| b.left)).unwrap_or(0.0);
    if burning >= seconds * 0.5 {
        if let Some(b) = sim.res.get_mut::<EliteState>().and_then(|s| s.burns.iter_mut().find(|b| b.player == target)) {
            b.left = b.left.max(seconds);
            b.dps = b.dps.max(dps);
        }
        return;
    }
    ignite(sim, target, by, dps, seconds);
}

/// A burning elite fell at `at`: its fire on the ground.
pub fn fell_burning(sim: &mut Sim, at: Vec3, by: u32) {
    let Some((secs, radius, dps)) = sim.res.get::<Roster>().map(|r| (r.elites.patch_seconds, r.elites.patch_radius, r.elites.patch_dps)) else { return };
    if secs <= 0.0 || dps <= 0.0 {
        return;
    }
    let st = sim.res.entry::<EliteState>();
    // at most six at once: the oldest goes
    if st.patches.len() >= 6 {
        st.patches.remove(0);
    }
    st.patches.push(Patch { at: Vec3::new(at.x, at.y, at.z), left: secs, radius, dps, by, fx: 0.0 });
    embers(sim, at + Vec3::Y * 0.3, 14, 1.4);
}

/// A splitting elite fell at `at` (its row, its most health, its wave): its young crawl out round it.
pub fn split(sim: &mut Sim, net: u32, row: u16, at: Vec3, max_hp: f32, wave: Option<u16>, lap: u32) {
    let Some(roster) = sim.res.get::<Roster>() else { return };
    let e = &roster.elites;
    let into = roster.row_of(&e.split_into).filter(|_| !e.split_into.is_empty()).unwrap_or(row);
    let (count, share, snd) = (e.split_count, e.split_health, e.snd_split.clone());
    let ix = sim.res.get_mut::<Roster>().map(|r| r.variant(into, lap, Mod::None, true)).unwrap_or(into);
    let def = sim.res.get::<Roster>().map(|r| r.by_index(ix).into_owned()).unwrap_or_else(|| Def::base(Arch::Chaser));
    let hp = (max_hp * share).max(1.0);
    let yaw0 = sim.rng.range(0.0, std::f32::consts::TAU);
    for k in 0..count {
        let a = yaw0 + k as f32 * std::f32::consts::TAU / count as f32;
        let p = at + Vec3::new(a.cos() * 0.55, 0.0, a.sin() * 0.55);
        let yaw = enemy::targets(sim).into_iter().filter(|t| t.alive).min_by(|x, y| x.pos.distance_squared(p).total_cmp(&y.pos.distance_squared(p))).map(|t| enemy::yaw_of(enemy::h(t.pos) - enemy::h(p))).unwrap_or(a);
        let c = enemy::spawn(sim, &def, into, p, yaw, false, wave);
        if let Ok(mut en) = sim.world.get::<&mut Enemy>(c) {
            en.def = ix;
            en.state = State::Idle;
        }
        if let Ok(mut h) = sim.world.get::<&mut Health>(c) {
            h.max = hp;
            h.hp = hp;
            // the burst of the body they crawl out of is not theirs to take (its pieces fly about 0.4 s)
            h.invulnerable = 0.4;
        }
        if wave.is_some()
            && let Some(d) = sim.res.get_mut::<crate::director::Director>()
        {
            d.spawned += 1;
            d.total += 1;
        }
        raised(sim, c, into, Mod::None, true);
    }
    let st = sim.res.entry::<EliteState>();
    st.splits += 1;
    sim.sound(&snd, at + Vec3::Y, -2.0, net);
    let name = sim.names.id("blood");
    sim.emit(Event::Particles(events::Particles { name, count: 16, pos: at + Vec3::Y * 0.8, dir: Vec3::Y, speed: 2.0, spread: 1.4 }));
    sim.rule("elite-split", net, count as f32, into as f32, 0.0, 0.0);
}

/// QA (`forge.ai_elites()`; gf/forge/ai.js `elites.observe()` names them): raised burning, armoured, splitting, fast;
/// young raised, splits, burn bites, their damage, ignitions, elites this wave, the run's firsts (bits), players
/// burning, fire patches, forced still queued; then the newest patch's seconds left, radius and damage a second.
pub fn observe(sim: &Sim) -> Vec<f32> {
    let Some(st) = sim.res.get::<EliteState>() else { return Vec::new() };
    let p = st.patches.last();
    vec![
        st.raised[1] as f32, st.raised[2] as f32, st.raised[3] as f32, st.raised[4] as f32, st.children as f32, st.splits as f32, st.bites as f32, st.burned, st.ignitions as f32,
        st.this_wave as f32, st.seen as f32, st.burns.len() as f32, st.patches.len() as f32, st.force.len() as f32,
        p.map(|p| p.left).unwrap_or(0.0), p.map(|p| p.radius).unwrap_or(0.0), p.map(|p| p.dps).unwrap_or(0.0),
    ]
}
