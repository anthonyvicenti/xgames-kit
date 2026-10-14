//! The enemies: one state machine per archetype on a shared body of rules (research/rust-engine/feel-targets.md
//! moment 13 and target 9, the enemies table for the numbers).
//!
//! - **Arrival.** It rises from the ground: `depth` under, a `hold`, a rise with a small overshoot, settled by `arrive`
//!   (about 1 s), facing the nearest player; then full chase speed within 0.3 s.
//! - **Chase** on the target's flow field (nav.rs), straight with a clear grid line; slows into `reach` and stops there.
//! - **Attack tokens.** At most `attackers` enemies (the wave's) attack one player at once; the rest circle at `ring`
//!   (`Wait`) and take a token in the order they started waiting.
//! - **Tell → attack → recover.** The eyes ramp `windupGlow` over `windup`; the chaser lunges `lunge.distance` in
//!   `lunge.time` and dips, the hit lands and the eyes snap back on the same step, then it backs off `backoff` over
//!   `recover`; the next attack waits for `cooldown` from this one's hit.
//! - **Caster:** keeps between `keep` and `range` with a clear line (it strafes to find a lane when the line is
//!   blocked), a `ranged.windup` tell, then a projectile (projectile.rs).
//! - **Shield:** a shield region in front of it (a hurt region with `shield.block` as its damage multiplier); hits on
//!   it wear the shield down until it breaks (a stagger), a flurry of hits drops the guard (overwhelmed), and it turns
//!   slowly, so it can be flanked.
//! - **Brute:** a long tell, then a slam over an arc in front that can knock players down (fair play: at most one
//!   knockdown a player per `KNOCK_GAP` s, at most 0.8 s).
//! - **Boss:** phases by health (a roar between them, unhurt), slams, three-swing combos, summons from phase 2, a
//!   charge in the last; `BossBar` for the HUD.
//! - **Crowds:** separation between enemies; stuck recovery (a detour to the side, then rising again elsewhere).
//! - **Reactions:** a hit flashes the body and whitens the eyes for a moment, flinches the bone it lands on (a spring
//!   on the animator) and plays the hit clip for its side; a big hit staggers (cancelling a tell), a bigger one knocks
//!   it down (then it gets up). Others can knock an enemy down with OP_KNOCK or an EV_KNOCK_REQUEST event.
//! - **Animation:** when the host has animated the entity (`Sim::animate`), clips follow the state, by the names in
//!   the table's `clips`, with the root pinned (no clip lifts a body: the boss's `taunt` and `emerge_leap` hop high).
use forge_core::components::*;
use forge_core::events::{self, Event};
use forge_core::forge_anim::{self, humanoid, Layer, Play};
use forge_core::glam::{Quat, Vec2, Vec3};
use forge_core::hecs::Entity;
use forge_core::physics::{groups, Mover};
use forge_core::sim::{Animated, Rng, Sim};
use forge_core::snapshot::SnapByte;

use crate::defs::{Arch, Def, Roster};
use crate::nav::Nav;
use crate::{director::Director, EV_KNOCK, EV_KNOCK_REQUEST, EV_STATE, EV_TELL};

/// An enemy's state (the AI view's STATE field; the low five bits of its snapshot byte).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Default)]
#[repr(u8)]
pub enum State {
    #[default]
    Arrive = 0,
    Idle = 1,
    Chase = 2,
    Wait = 3,
    Tell = 4,
    Attack = 5,
    Recover = 6,
    Hold = 7,
    Stagger = 8,
    Down = 9,
    Rise = 10,
    Roar = 11,
    Dead = 12,
}

impl State {
    pub fn from_u8(v: u8) -> State {
        use State::*;
        [Arrive, Idle, Chase, Wait, Tell, Attack, Recover, Hold, Stagger, Down, Rise, Roar, Dead].get(v as usize).copied().unwrap_or(Idle)
    }
    pub fn name(self) -> &'static str {
        ["arrive", "idle", "chase", "wait", "tell", "attack", "recover", "hold", "stagger", "down", "rise", "roar", "dead"][self as usize]
    }
}

/// What an attack is (the AI view's tells; EV_TELL's kind).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Default)]
#[repr(u8)]
pub enum Move {
    #[default]
    Lunge = 1,
    Cast = 2,
    Slam = 3,
    Combo = 4,
    Charge = 5,
    Summon = 6,
}

/// The shield's state (shield archetype).
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct Guard {
    pub on: bool,
    pub broken: bool,
    pub hp: f32,
    /// Seconds its guard stays down (overwhelmed).
    pub down: f32,
    /// The shield's index among the hurtbox's regions (usize::MAX: not placed).
    pub region: usize,
    /// Hits in the overwhelm window: (when, attacker).
    pub recent: [(f32, u32); 8],
}

/// Stuck detection: what it meant to walk against what it walked, half a second at a time.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct Stuck {
    pub window: f32,
    pub expected: f32,
    pub moved: f32,
    pub strikes: u32,
    pub tries: u32,
    pub detour: f32,
    pub detour_dir: Vec2,
    pub best: f32,
    /// Detours taken since it spawned (QA).
    pub detours: u32,
    pub reemerged: u32,
}

/// forge-ai's own component on every enemy it simulates (replicas on a joiner have none).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Enemy {
    pub row: u16,
    pub arch: Arch,
    pub state: State,
    /// Seconds in this state.
    pub t: f32,
    pub age: f32,
    pub target: Option<Entity>,
    pub target_net: u32,
    /// Seconds since its last attack landed or was released (the cooldown).
    pub since_attack: f32,
    pub attack: Move,
    pub combo_left: u8,
    /// Seconds waiting for a token.
    pub waiting: f32,
    /// The eye glow now (its intensity: rest, ramping in a tell, 0 dead) and seconds of white on a hit.
    pub eye: f32,
    pub eye_white: f32,
    /// The body's white hit flash, 1 → 0.
    pub flash: f32,
    /// Where the body is drawn above its feet (metres; the rise, the lunge's dip) when no clip carries it.
    pub offset: f32,
    pub yaw: f32,
    /// The attack's direction (fixed when the lunge, slam or charge starts) and where it started.
    pub dir: Vec2,
    pub from: Vec3,
    pub hit_done: bool,
    /// Circling direction while waiting (±1) and when it flips.
    pub side: f32,
    pub side_t: f32,
    pub wave: Option<u16>,
    pub stuck: Stuck,
    pub los: bool,
    pub los_in: u8,
    pub guard: Guard,
    pub phase: u8,
    pub summon_cd: f32,
    pub hurt_snd: f32,
    pub upper_t: f32,
    pub dead_t: f32,
    pub killer: u32,
    /// The clip asked for last (an index into the def's clip names: no replay of the same).
    pub clip: u8,
    pub pinned: bool,
    /// Its speed now (m/s, horizontal): eases toward what it wants.
    pub speed: f32,
    /// Seconds a stagger, a knockdown or a get-up lasts this time.
    pub hold_for: f32,
    /// What it is now (wave 7): its row, or a variant of it (`Roster::variant`: a later lap, an elite, a split one's
    /// young); `Roster::of` reads it.
    pub def: u16,
    /// Its elite mark (elite.rs: the modifier, and `CHILD` for a split one's young; 0: an ordinary one).
    pub mark: u8,
}

impl Enemy {
    pub fn new(row: u16, def: &Def, state: State, yaw: f32, wave: Option<u16>, side: f32) -> Enemy {
        Enemy {
            row,
            arch: def.arch,
            state,
            t: 0.0,
            age: 0.0,
            target: None,
            target_net: 0,
            since_attack: def.cooldown,
            attack: Move::Lunge,
            combo_left: 0,
            waiting: 0.0,
            eye: def.eye_glow,
            eye_white: 0.0,
            flash: 0.0,
            offset: if state == State::Arrive { -def.depth } else { 0.0 },
            yaw,
            dir: Vec2::ZERO,
            from: Vec3::ZERO,
            hit_done: false,
            side,
            side_t: 2.0,
            wave,
            stuck: Stuck { best: f32::MAX, ..Stuck::default() },
            los: false,
            los_in: 0,
            guard: Guard { on: def.arch == Arch::Shield, broken: false, hp: def.shield_hp, down: 0.0, region: usize::MAX, recent: [(-99.0, 0); 8] },
            phase: 1,
            summon_cd: 6.0,
            hurt_snd: 0.0,
            upper_t: 0.0,
            dead_t: 0.0,
            killer: 0,
            clip: u8::MAX,
            pinned: false,
            speed: 0.0,
            hold_for: 0.0,
            def: row,
            mark: 0,
        }
    }
    /// Its elite modifier (wave 7).
    pub fn elite(&self) -> crate::elite::Mod {
        crate::elite::Mod::from_u8(self.mark)
    }
    /// The byte the snapshot carries (state, guard, boss phase), so a joiner shows the same eyes.
    pub fn snap_byte(&self) -> u8 {
        (self.state as u8 & 31) | ((self.guard.on && !self.guard.broken && self.guard.down <= 0.0) as u8) << 5 | (self.phase.min(3)) << 6
    }
    pub fn guarding(&self) -> bool {
        self.guard.on && !self.guard.broken && self.guard.down <= 0.0
    }
}

/// Attack tokens: at most `max` enemies attack one player at once. A request is granted at the next step, longest
/// waiting first.
#[derive(Default)]
pub struct Tokens {
    pub max: u32,
    pub held: Vec<(Entity, Entity)>,
    requests: Vec<(f32, Entity, Entity)>,
    /// The most enemies seen holding tokens on one player at once (QA, fixtures).
    pub peak: u32,
}

impl Tokens {
    pub fn has(&self, enemy: Entity) -> bool {
        self.held.iter().any(|h| h.0 == enemy)
    }
    pub fn count(&self, target: Entity) -> u32 {
        self.held.iter().filter(|h| h.1 == target).count() as u32
    }
    pub fn release(&mut self, enemy: Entity) {
        self.held.retain(|h| h.0 != enemy);
    }
    pub fn request(&mut self, waited: f32, enemy: Entity, target: Entity) {
        if !self.has(enemy) {
            self.requests.push((waited, enemy, target));
        }
    }
    fn grant(&mut self) {
        let mut req = std::mem::take(&mut self.requests);
        req.sort_by(|a, b| b.0.total_cmp(&a.0));
        for (_, e, t) in req {
            if !self.has(e) && self.count(t) < self.max.max(1) {
                self.held.push((e, t));
            }
        }
        let mut most = 0;
        for (_, t) in &self.held {
            most = most.max(self.count(*t));
        }
        self.peak = self.peak.max(most);
    }
}

/// Someone else moves a knocked player (forge-play sets it when forge-feel's controller is installed): the AI then
/// only says the knock (EV_KNOCK) and leaves the player's velocity alone.
#[derive(Clone, Copy, Debug, Default)]
pub struct KnockByEvent;

/// Fair play for knockdowns of players: when each player was last knocked down.
#[derive(Default)]
pub struct KnockLimits {
    pub last: Vec<(Entity, f64)>,
}
/// At most one knockdown a player in this many seconds.
pub const KNOCK_GAP: f64 = 3.0;

/// The boss, for the HUD's bar (`forge.ai_boss()`; the AI view's flags mark it too).
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct BossBar {
    pub net: u32,
    pub hp: f32,
    pub max: f32,
    pub phase: u8,
    pub phases: u8,
    pub state: u8,
    pub row: u16,
    pub invulnerable: bool,
}

/// Requests other code made of the AI (OP_KNOCK, EV_KNOCK_REQUEST): knock an enemy down.
#[derive(Default)]
pub struct Requests {
    pub knocks: Vec<(u32, Vec3, f32)>,
}

/// Seconds a body stays after death (flag DEAD) before it is despawned: track F's kill turns it into debris meanwhile.
pub const CORPSE: f32 = 0.15;
/// Seconds of a hit's white flash (feel target 7: 2-3 frames).
pub const FLASH: f32 = 0.045;
/// The shield's hurt region: a capsule in front of the body (entity space: forward is −Z).
pub const SHIELD_RADIUS: f32 = 0.42;

pub fn h(v: Vec3) -> Vec2 {
    Vec2::new(v.x, v.z)
}
/// The core's yaw for a direction on the ground (0 looks down −Z).
pub fn yaw_of(d: Vec2) -> f32 {
    (-d.x).atan2(-d.y)
}
pub fn fwd(yaw: f32) -> Vec2 {
    Vec2::new(-yaw.sin(), -yaw.cos())
}
fn turn_toward(yaw: f32, want: f32, max: f32) -> f32 {
    forge_core::wrap(yaw + forge_core::wrap(want - yaw).clamp(-max, max))
}

/// Spawn an enemy of `def` (table row `row`) with its feet at `at`: its body, health, hurtbox and state; rising from
/// the ground when `emerge` (and its type emerges).
pub fn spawn(sim: &mut Sim, def: &Def, row: u16, at: Vec3, yaw: f32, emerge: bool, wave: Option<u16>) -> Entity {
    let state = if emerge && def.emerge { State::Arrive } else { State::Idle };
    let side = if sim.rng.f32() < 0.5 { -1.0 } else { 1.0 };
    let e = sim.spawn_actor(kind::ENEMY, row, at, yaw);
    let en = Enemy::new(row, def, state, yaw, wave, side);
    // Reacts: this crate plays its enemies' hit reactions (the spring on the bone hit, the hit clip for its side), so
    // forge-feel's own flinch leaves them alone (one reaction a hit)
    let _ = sim.world.insert(e, (Health::new(def.health), Team::ENEMIES, Hurtbox::upright(def.radius, def.height, groups::ENEMY), en, SnapByte(en.snap_byte()), Reacts));
    if let Ok(mut t) = sim.world.get::<&mut Transform>(e) {
        t.scale = def.scale;
    }
    sim.add_character(e, def.radius, def.height, groups::ENEMY);
    // rapier's character controller is a crowd's biggest cost (measured natively in fixtures/ai/crowd30.json: 326 µs a
    // step for 32 characters with autostep, 197 without; ground snap and enemies blocking each other are kept: without
    // them crowds overlap and the token rotation stalls). An enemy climbs ledges only when its row says so (`climb`).
    // Wave 3 (track M): an enemy that does not climb is a member of the crowd (forge-core crowd.rs): on flat ground it
    // is stopped by other bodies as discs and by the world with one sweep, and the controller is kept for the air,
    // slopes and steps (`packed.json`: 212 µs a packed step in the controller, the number beside it now).
    if let Ok(mut m) = sim.world.get::<&mut Mover>(e) {
        m.step_height = def.climb;
        m.crowd = def.climb <= 0.0;
    }
    let net = sim.net_of(e);
    if state == State::Arrive {
        sim.sound(&def.snd_spawn, at, -3.0, net);
    }
    if def.arch == Arch::Boss {
        sim.rule("boss-arrive", net, def.health, def.phases as f32, row as f32, 0.0);
    }
    e
}

/// A target: a player (or bot) the enemies can go for.
#[derive(Clone, Copy, Debug)]
pub struct Target {
    pub e: Entity,
    pub net: u32,
    pub pos: Vec3,
    pub alive: bool,
}

pub fn targets(sim: &Sim) -> Vec<Target> {
    sim.world.query::<(Entity, &Player, &Transform, Option<&Health>)>().iter().map(|(e, p, t, hp)| Target { e, net: p.id, pos: t.pos, alive: hp.is_none_or(|h| !h.dead) }).collect()
}

/// One enemy's view of itself this step.
struct Me {
    e: Entity,
    net: u32,
    en: Enemy,
    pos: Vec3,
    hp: Health,
    grounded: bool,
    moved: Vec3,
    want: Vec2,
    /// A direction to face (else the way it walks).
    face: Option<Vec2>,
    anim: Option<Anim>,
    upper: Option<String>,
    push: Option<(Part, Vec3)>,
    /// Velocity as wanted, not eased (a lunge, a charge, the back-off after a lunge).
    direct: bool,
    events: Vec<Event>,
}

#[derive(Clone, Debug)]
struct Anim {
    clip: String,
    looping: bool,
    hold: bool,
    fade: f32,
    rate: f32,
}

/// What a step decided for the world beyond each enemy.
#[derive(Default)]
struct Fx {
    damage: Vec<(Entity, f32, u32, Vec3, Option<(Vec3, f32, f32)>)>,
    sounds: Vec<(String, Vec3, f32, u32)>,
    rules: Vec<(&'static str, u32, f32, f32, f32, f32)>,
    orbs: Vec<crate::projectile::OrbSpawn>,
    summons: Vec<(u16, u32, Vec3, Option<u16>)>,
    despawn: Vec<Entity>,
    release: Vec<Entity>,
    reemerge: Vec<(Entity, Vec3)>,
    shield_add: Vec<Entity>,
    shield_remove: Vec<Entity>,
    /// Stuck against something the grid did not see: (where, the way it meant to go).
    learn: Vec<(Vec3, Vec2)>,
    /// Wave 7: a splitting elite fell (its net id, row, where, its most health, its wave); a burning one fell (where, net).
    splits: Vec<(u32, u16, Vec3, f32, Option<u16>)>,
    fires: Vec<(Vec3, u32)>,
}

struct Ctx<'a> {
    roster: &'a Roster,
    nav: &'a Nav,
    tokens: &'a mut Tokens,
    targets: &'a [Target],
    rng: &'a mut Rng,
    crowd: &'a [(Entity, Vec2, f32, bool)],
    dt: f32,
    fx: &'a mut Fx,
    hits: &'a [events::Hit],
    knocks: &'a [(u32, Vec3, f32)],
    attacker_pos: &'a dyn Fn(u32) -> Option<Vec3>,
    boss: &'a mut Option<BossBar>,
}

/// The Ai-stage system: every enemy's step.
pub fn system(sim: &mut Sim) {
    let roster = sim.res.take::<Roster>();
    let mut nav = sim.res.take::<Nav>();
    let mut tokens = sim.res.take::<Tokens>();
    let mut fair = sim.res.take::<KnockLimits>();
    let requests = sim.res.take::<Requests>();
    let dt = sim.time.dt;
    let step = sim.time.step;
    let targets = targets(sim);
    tokens.max = sim.res.get::<Director>().map(|d| d.attackers()).unwrap_or(3);

    let mut list: Vec<Me> = sim
        .world
        .query::<(Entity, &NetId, &Enemy, &Transform, &Health, &Mover, Option<&Hurtbox>)>()
        .without::<&Replica>()
        .iter()
        .map(|(e, n, en, t, hp, m, hb)| {
            let mut en = *en;
            // the host's animate() swaps the hurtbox for the body's regions: the shield goes back on when it is gone
            if en.guard.region != usize::MAX && !hb.and_then(|hb| hb.regions.get(en.guard.region)).is_some_and(|r| r.bone == NO_BONE && r.radius == SHIELD_RADIUS) {
                en.guard.region = usize::MAX;
            }
            Me { e, net: n.0, en, pos: t.pos, hp: *hp, grounded: m.grounded, moved: m.moved, want: Vec2::ZERO, face: None, anim: None, upper: None, push: None, direct: false, events: Vec::new() }
        })
        .collect();
    if list.is_empty() {
        tokens.held.clear();
        put_back(sim, roster, nav, tokens, fair, requests);
        return;
    }
    nav.ensure(&sim.physics);
    for t in targets.iter().filter(|t| t.alive) {
        nav.track(t.e, h(t.pos), step);
    }
    let alive: Vec<Entity> = targets.iter().map(|t| t.e).collect();
    nav.retain(|e| alive.contains(&e));
    tokens.held.retain(|(en, t)| list.iter().any(|m| m.e == *en && m.en.state != State::Dead) && alive.contains(t));
    tokens.grant();

    // this step's hits on enemies (track F's weapons hit in the Feel stage, before this one) and knock requests
    let mut hits: Vec<events::Hit> = Vec::new();
    let mut knocks: Vec<(u32, Vec3, f32)> = requests.knocks.clone();
    for ev in sim.events.step_events() {
        match ev {
            Event::Hit(hit) if hit.target >= forge_core::sim::FIRST_NET_ID => hits.push(*hit),
            Event::Custom { kind, words } if *kind == EV_KNOCK_REQUEST => knocks.push((words[0], Vec3::new(f32::from_bits(words[1]), f32::from_bits(words[2]), f32::from_bits(words[3])), f32::from_bits(words[4]))),
            _ => {}
        }
    }
    let crowd: Vec<(Entity, Vec2, f32, bool)> = list.iter().map(|m| (m.e, h(m.pos), roster.of(&m.en).radius, !matches!(m.en.state, State::Dead | State::Arrive))).collect();
    let positions: Vec<(u32, Vec3)> = sim.world.query::<(&NetId, &Transform)>().iter().map(|(n, t)| (n.0, t.pos)).collect();
    let attacker_pos = |net: u32| positions.iter().find(|p| p.0 == net).map(|p| p.1);
    let mut fx = Fx::default();
    let mut boss: Option<BossBar> = None;
    {
        let mut ctx = Ctx { roster: &roster, nav: &nav, tokens: &mut tokens, targets: &targets, rng: &mut sim.rng, crowd: &crowd, dt, fx: &mut fx, hits: &hits, knocks: &knocks, attacker_pos: &attacker_pos, boss: &mut boss };
        for me in list.iter_mut() {
            think(&mut ctx, me);
        }
    }
    if let Some(b) = boss {
        sim.res.insert(b);
    } else if sim.res.get::<BossBar>().is_some_and(|b| b.net != 0) {
        sim.res.insert(BossBar::default());
    }

    // write back
    for me in &list {
        let def = roster.of(&me.en);
        if let Ok((en, tr, v, m, sb)) = sim.world.query_one_mut::<(&mut Enemy, &mut Transform, &mut Velocity, &mut Mover, &mut SnapByte)>(me.e) {
            *en = me.en;
            tr.rot = Quat::from_rotation_y(me.en.yaw);
            let k = 1.0 - (-dt * 20.0f32).exp();
            let hv = Vec2::new(v.linear.x, v.linear.z);
            let nv = if me.direct { me.want } else { hv + (me.want - hv) * k };
            v.linear.x = nv.x;
            v.linear.z = nv.y;
            v.linear.y = if m.grounded { 0.0 } else { (v.linear.y - 20.0 * dt).max(-30.0) };
            sb.0 = me.en.snap_byte();
        }
        if me.en.arch == Arch::Boss
            && let Ok(mut hp) = sim.world.get::<&mut Health>(me.e) {
                hp.invulnerable = if me.en.state == State::Roar { (def.roar - me.en.t).max(0.0) } else { 0.0 };
            }
        for ev in &me.events {
            sim.emit(*ev);
        }
        animate(sim, me, &def);
    }
    // the world beyond
    let burn = (roster.elites.burn_dps, roster.elites.burn_seconds);
    let mut ignites: Vec<(Entity, u32)> = Vec::new();
    for (target, amount, attacker, dir, knock) in std::mem::take(&mut fx.damage) {
        let dealt = sim.damage(target, amount, attacker, None, dir);
        if dealt.damage > 0.0
            && let Some((d, speed, secs)) = knock {
                knock_player(sim, &mut fair, target, d, speed, secs);
            }
        // wave 7: a burning elite's blow sets the player alight
        if dealt.damage > 0.0 && list.iter().any(|m| m.net == attacker && m.en.elite() == crate::elite::Mod::Burning) {
            ignites.push((target, attacker));
        }
    }
    for (name, pos, gain, src) in std::mem::take(&mut fx.sounds) {
        sim.sound(&name, pos, gain, src);
    }
    for (name, ent, a, b, c, d) in std::mem::take(&mut fx.rules) {
        sim.rule(name, ent, a, b, c, d);
    }
    for o in std::mem::take(&mut fx.orbs) {
        crate::projectile::spawn(sim, o);
    }
    for e in std::mem::take(&mut fx.release) {
        tokens.release(e);
    }
    for (e, near) in std::mem::take(&mut fx.reemerge) {
        reemerge(sim, &nav, e, near);
    }
    // stuck against the static world where the grid saw nothing (a low ledge, a thin rail): the grid learns it
    // (probed along it, a cell at a time either side, so one stuck teaches the obstacle's run, not one cell of it)
    for (pos, dir) in std::mem::take(&mut fx.learn) {
        let d = Vec3::new(dir.x, 0.0, dir.y);
        let side = Vec3::new(-dir.y, 0.0, dir.x);
        let cell = nav.grid.as_ref().map(|g| g.cell).unwrap_or(0.5);
        let mask = forge_core::physics::QueryMask::new(groups::WORLD);
        for k in -5i32..=5 {
            let from = pos + Vec3::Y * 0.3 + side * (k as f32 * cell);
            if let Some(hit) = sim.physics.cast_shape(forge_core::physics::Shape::Ball(0.22), from, Quat::IDENTITY, d, 1.2, mask) {
                nav.learn(h(hit.point) + dir * 0.1);
            }
        }
    }
    for e in std::mem::take(&mut fx.shield_add) {
        add_shield(sim, e);
    }
    for e in std::mem::take(&mut fx.shield_remove) {
        remove_shield(sim, e);
    }
    let summons = std::mem::take(&mut fx.summons);
    let splits = std::mem::take(&mut fx.splits);
    let fires = std::mem::take(&mut fx.fires);
    for e in std::mem::take(&mut fx.despawn) {
        tokens.release(e);
        sim.despawn(e);
    }
    put_back(sim, roster, nav, tokens, fair, Requests::default());
    for (row, count, center, wave) in summons {
        crate::director::raise_near(sim, row, count, center, wave);
    }
    // wave 7: burning blows set players alight; what a fallen elite leaves
    for (target, by) in ignites {
        crate::elite::ignite(sim, target, by, burn.0, burn.1);
    }
    let lap = sim.res.get::<Director>().map(|d| d.lap).unwrap_or(0);
    for (net, row, at, max, wave) in splits {
        crate::elite::split(sim, net, row, at, max, wave, lap);
    }
    for (at, net) in fires {
        crate::elite::fell_burning(sim, at, net);
    }
}

fn put_back(sim: &mut Sim, roster: Roster, nav: Nav, tokens: Tokens, fair: KnockLimits, requests: Requests) {
    sim.res.insert(roster);
    sim.res.insert(nav);
    sim.res.insert(tokens);
    sim.res.insert(fair);
    sim.res.insert(requests);
}

fn knock_player(sim: &mut Sim, fair: &mut KnockLimits, target: Entity, dir: Vec3, speed: f32, secs: f32) {
    let now = sim.time.now;
    if fair.last.iter().any(|(e, t)| *e == target && now - t < KNOCK_GAP) {
        return;
    }
    fair.last.retain(|(e, _)| *e != target);
    fair.last.push((target, now));
    let id = sim.world.get::<&Player>(target).map(|p| p.id).unwrap_or(0);
    let d = Vec3::new(dir.x, 0.0, dir.z).normalize_or_zero();
    // the push, the hop and the knockdown itself (no control, the camera) are the controller's: forge-feel honours
    // EV_KNOCK (forge-play `play.knocks` → `controller::knock`), and since wave 2 starts it on the player's own input
    // step, so a joiner's prediction plays the same knock (forge-feel shove.rs). Without forge-feel the core's own
    // walk takes the push here.
    if sim.res.get::<KnockByEvent>().is_none()
        && let Ok(mut v) = sim.world.get::<&mut Velocity>(target)
    {
        v.linear += d * speed;
        v.linear.y = v.linear.y.max(2.0);
    }
    let mut w = [0u32; 14];
    w[0] = id;
    w[1] = d.x.to_bits();
    w[2] = d.y.to_bits();
    w[3] = d.z.to_bits();
    w[4] = speed.to_bits();
    w[5] = secs.min(0.8).to_bits();
    sim.emit(Event::Custom { kind: EV_KNOCK, words: w });
}

fn tell_event(me: &Me, kind: Move, secs: f32) -> Event {
    let mut w = [0u32; 14];
    w[0] = me.net;
    w[1] = kind as u32;
    w[2] = secs.to_bits();
    w[3] = me.pos.x.to_bits();
    w[4] = me.pos.y.to_bits();
    w[5] = me.pos.z.to_bits();
    w[6] = me.en.target_net;
    Event::Custom { kind: EV_TELL, words: w }
}

fn state_event(net: u32, state: State, arch: Arch, prev: State) -> Event {
    let mut w = [0u32; 14];
    w[0] = net;
    w[1] = state as u32;
    w[2] = arch as u32;
    w[3] = prev as u32;
    Event::Custom { kind: EV_STATE, words: w }
}

fn go(me: &mut Me, s: State) {
    if me.en.state != s {
        let prev = me.en.state;
        me.en.state = s;
        me.en.t = 0.0;
        me.events.push(state_event(me.net, s, me.en.arch, prev));
    } else {
        me.en.t = 0.0;
    }
}

fn clip(me: &mut Me, name: &str, code: u8, looping: bool, hold: bool, fade: f32, rate: f32) {
    if me.en.clip == code && looping {
        if let Some(a) = me.anim.as_mut() {
            a.rate = rate;
        } else {
            me.anim = Some(Anim { clip: name.to_string(), looping, hold, fade, rate });
        }
        return;
    }
    me.en.clip = code;
    me.anim = Some(Anim { clip: name.to_string(), looping, hold, fade, rate });
}

/// The eye glow for the state (target 9: rest, +windupGlow through the tell, back on the hit, 0 dead).
fn eye_for(me: &Me, def: &Def) -> f32 {
    let g = def.eye_glow;
    match me.en.state {
        State::Dead => 0.0,
        State::Tell => {
            let len = tell_len(me, def).max(1e-3);
            g * (1.0 + def.eye_windup * (me.en.t / len).clamp(0.0, 1.0))
        }
        State::Attack if !me.en.hit_done => g * (1.0 + def.eye_windup),
        State::Roar => g * (1.0 + def.eye_windup * 2.0),
        State::Down => g * 0.7,
        _ => g,
    }
}

fn tell_len(me: &Me, def: &Def) -> f32 {
    match me.en.attack {
        Move::Cast => def.cast_windup,
        Move::Combo => {
            if me.en.combo_left >= 3 {
                0.35
            } else {
                0.28
            }
        }
        Move::Charge => 0.6,
        Move::Summon => 0.8,
        _ => def.windup,
    }
}

/// The arrival curve (moment 13): the head starts `depth` under, holds, rises 0.4 s with a small overshoot, settles.
pub fn rise(def: &Def, t: f32) -> f32 {
    let (d, hold, total) = (def.depth, def.hold, def.arrive.max(def.hold + 0.45));
    let over = (d * 0.16).min(0.1);
    if t < hold {
        -d
    } else if t < hold + 0.4 {
        let u = (t - hold) / 0.4;
        let e = 1.0 - (1.0 - u).powi(3);
        -d + (d + over) * e
    } else if t < total {
        let u = (t - hold - 0.4) / (total - hold - 0.4).max(1e-3);
        over * (1.0 - u)
    } else {
        0.0
    }
}

fn think(c: &mut Ctx, me: &mut Me) {
    let def = c.roster.of(&me.en);
    let def: &Def = &def;
    let dt = c.dt;
    me.en.t += dt;
    me.en.age += dt;
    me.en.since_attack += dt;
    me.en.flash = (me.en.flash - dt / FLASH).max(0.0);
    me.en.eye_white = (me.en.eye_white - dt).max(0.0);
    me.en.hurt_snd = (me.en.hurt_snd - dt).max(0.0);
    me.en.summon_cd = (me.en.summon_cd - dt).max(0.0);
    me.en.guard.down = (me.en.guard.down - dt).max(0.0);
    if me.en.upper_t > 0.0 {
        me.en.upper_t -= dt;
        if me.en.upper_t <= 0.0 {
            me.upper = Some(String::new());
        }
    }
    let prev_state = me.en.state;

    // ---- death ----
    if me.hp.dead && me.en.state != State::Dead {
        die(c, me, def);
    }
    if me.en.state == State::Dead {
        me.en.dead_t += dt;
        me.en.eye = 0.0;
        if me.en.dead_t >= CORPSE {
            c.fx.despawn.push(me.e);
        }
        return;
    }

    // ---- target: the nearest player alive (kept unless another is much nearer) ----
    let pos2 = h(me.pos);
    let near = c.targets.iter().filter(|t| t.alive).min_by(|a, b| h(a.pos).distance_squared(pos2).total_cmp(&h(b.pos).distance_squared(pos2))).copied();
    let cur = me.en.target.and_then(|e| c.targets.iter().find(|t| t.e == e && t.alive)).copied();
    let committed = matches!(me.en.state, State::Tell | State::Attack | State::Recover | State::Roar);
    let target = match (cur, near) {
        // an attack under way keeps its target
        (Some(cu), _) if committed => Some(cu),
        (Some(cu), Some(n)) if h(cu.pos).distance(pos2) <= h(n.pos).distance(pos2) * 1.5 + 0.5 => Some(cu),
        (_, n) => n,
    };
    if target.map(|t| t.e) != me.en.target {
        c.fx.release.push(me.e);
    }
    me.en.target = target.map(|t| t.e);
    me.en.target_net = target.map(|t| t.net).unwrap_or(0);
    let token = c.tokens.has(me.e);

    // ---- reactions: hits this step, knock requests ----
    let my_hits: Vec<events::Hit> = c.hits.iter().filter(|h| h.target == me.net).copied().collect();
    for hit in &my_hits {
        react(c, me, def, hit);
    }
    let reqs: Vec<(u32, Vec3, f32)> = c.knocks.iter().filter(|k| k.0 == me.net).copied().collect();
    for (_, _dir, secs) in reqs {
        if !matches!(me.en.state, State::Arrive | State::Down | State::Dead) {
            // wave 7: an armoured elite is heavier to knock about (a flying piece downs it for less, a light one not at all)
            let secs = if me.en.elite() == crate::elite::Mod::Armoured { secs * c.roster.elites.armour_knock } else { secs };
            if secs > 0.12 {
                knock_down(c, me, def, secs);
            }
        }
    }

    // ---- line of sight to the target on the grid (every few steps) ----
    if me.en.los_in == 0 {
        me.en.los = match (target, c.nav.grid.as_ref()) {
            (Some(t), Some(g)) => g.los(pos2, h(t.pos)),
            (Some(_), None) => true,
            _ => false,
        };
        me.en.los_in = 5;
    } else {
        me.en.los_in -= 1;
    }

    // ---- the boss's phases ----
    if me.en.arch == Arch::Boss {
        let share = me.hp.fraction();
        let phases = def.phases.max(1) as f32;
        let ph = (1.0 + ((1.0 - share) * phases).floor()).clamp(1.0, phases) as u8;
        if ph > me.en.phase && !matches!(me.en.state, State::Arrive | State::Roar) {
            me.en.phase = ph;
            c.fx.release.push(me.e);
            go(me, State::Roar);
            clip(me, &def.clips.roar, 20, false, true, 0.15, 1.0);
            c.fx.rules.push(("boss-phase", me.net, ph as f32, phases, share, 0.0));
            c.fx.sounds.push((def.snd_roar.clone(), me.pos, 2.0, me.net));
        }
        *c.boss = Some(BossBar { net: me.net, hp: me.hp.hp, max: me.hp.max, phase: me.en.phase, phases: def.phases as u8, state: me.en.state as u8, row: me.en.row, invulnerable: me.en.state == State::Roar });
    }

    // ---- the state machine ----
    let tpos = target.map(|t| t.pos).unwrap_or(me.pos);
    let to = h(tpos) - pos2;
    let dist = to.length();
    let dir_to = to.normalize_or_zero();
    match me.en.state {
        State::Arrive => {
            me.en.offset = rise(def, me.en.t);
            // asked for until the host has animated this body (`pinned`): a body whose file is still loading when it
            // spawns is animated a moment later, and an arrival asked for once would be lost: it stood out of its mound
            // in the bind pose, arms out, until it began to chase (seen in every first wave; the wave 3 merge)
            if me.en.t < 0.02 || !me.en.pinned {
                clip(me, &def.clips.arrive, 1, false, true, 0.0, 1.0);
            }
            if dist > 0.01 {
                me.face = Some(dir_to);
            }
            if me.en.t >= def.arrive.max(def.hold + 0.45) {
                me.en.offset = 0.0;
                me.en.speed = 0.0;
                go(me, if target.is_some() { State::Chase } else { State::Idle });
            }
        }
        State::Idle => {
            clip(me, &def.clips.idle, 2, true, false, 0.25, 1.0);
            if target.is_some() {
                go(me, State::Chase);
            }
        }
        State::Chase | State::Wait | State::Hold => {
            if target.is_none() {
                go(me, State::Idle);
            } else if me.en.arch == Arch::Boss {
                boss_choose(c, me, def, dist, dir_to);
            } else if me.en.arch == Arch::Caster {
                caster(c, me, def, dist, dir_to, token);
            } else {
                melee_approach(c, me, def, dist, dir_to, token);
            }
        }
        State::Tell => {
            me.face = Some(dir_to);
            me.want = Vec2::ZERO;
            if me.en.attack == Move::Combo && dist > def.reach * 0.8 {
                me.want = dir_to * def.speed * 0.6;
            }
            if me.en.t >= tell_len(me, def) {
                start_attack(c, me, def, dir_to);
            }
        }
        State::Attack => attack(c, me, def, target, dist, dir_to),
        State::Recover => {
            let len = recover_len(me, def);
            if me.en.attack == Move::Lunge {
                me.direct = true;
                if def.backoff > 0.0 && me.en.t < len {
                    me.want = -me.en.dir * (def.backoff / len.max(1e-3));
                }
            }
            me.en.offset = if me.en.attack == Move::Lunge { -def.lunge_dip * (1.0 - me.en.t / len.max(1e-3)).max(0.0) } else { 0.0 };
            if dist > 0.01 && me.en.arch != Arch::Shield {
                me.face = Some(dir_to);
            }
            if me.en.t >= len {
                me.en.offset = 0.0;
                if me.en.attack == Move::Combo && me.en.combo_left > 0 && dist <= def.reach + 1.2 {
                    go(me, State::Tell);
                    clip(me, &def.clips.combo[(3 - me.en.combo_left as usize).min(2)], 30 + me.en.combo_left, false, true, 0.08, 1.0);
                    let ev = tell_event(me, Move::Combo, tell_len(me, def));
                    me.events.push(ev);
                } else {
                    c.fx.release.push(me.e);
                    go(me, if me.en.arch == Arch::Caster { State::Hold } else { State::Chase });
                }
            }
        }
        State::Stagger => {
            me.want = Vec2::ZERO;
            if me.en.t >= me.en.hold_for {
                go(me, State::Chase);
            }
        }
        State::Down => {
            me.want = Vec2::ZERO;
            if me.en.t >= me.en.hold_for {
                go(me, State::Rise);
                clip(me, &def.clips.rise, 11, false, true, 0.1, 1.0);
            }
        }
        State::Rise => {
            me.want = Vec2::ZERO;
            if me.en.t >= def.getup {
                go(me, State::Chase);
            }
        }
        State::Roar => {
            me.want = Vec2::ZERO;
            if dist > 0.01 {
                me.face = Some(dir_to);
            }
            if me.en.t >= def.roar {
                if me.en.phase >= 2 {
                    summon(c, me, def);
                }
                go(me, State::Chase);
            }
        }
        State::Dead => {}
    }

    // ---- crowds: keep apart (not while committed to an attack) ----
    if matches!(me.en.state, State::Chase | State::Wait | State::Hold | State::Idle) {
        let mut push = Vec2::ZERO;
        let r = def.radius;
        for (e, p, rr, active) in c.crowd {
            if *e == me.e || !*active {
                continue;
            }
            let d = pos2 - *p;
            let l = d.length();
            let min = r + rr + 0.35;
            if l < min {
                let away = if l > 1e-4 { d / l } else { Vec2::new(me.en.side, 0.0) };
                push += away * (min - l) / min;
            }
        }
        me.want += push * 3.0;
        // stuck: meant to walk, did not (half a second at a time); a detour to the side, then rise again elsewhere
        stuck(c, me, def, dist);
        let cap = def.speed * 1.15;
        if me.want.length() > cap {
            me.want = me.want.normalize() * cap;
        }
    }

    // ---- facing ----
    let face = me.face.or_else(|| (me.want.length_squared() > 0.04).then(|| me.want.normalize()));
    if let Some(f) = face {
        let turn = if matches!(me.en.state, State::Arrive) { def.turn.max(6.0) } else { def.turn };
        me.en.yaw = turn_toward(me.en.yaw, yaw_of(f), turn * dt);
    }
    me.en.eye = eye_for(me, def);
    if me.en.state != prev_state && me.en.state == State::Chase {
        me.en.stuck.window = 0.0;
        me.en.stuck.expected = 0.0;
        me.en.stuck.moved = 0.0;
    }
    // the shield region follows the guard
    if me.en.arch == Arch::Shield {
        if me.en.guarding() && me.en.guard.region == usize::MAX {
            c.fx.shield_add.push(me.e);
        } else if !me.en.guarding() && me.en.guard.region != usize::MAX {
            c.fx.shield_remove.push(me.e);
        }
    }
}

fn recover_len(me: &Me, def: &Def) -> f32 {
    match me.en.attack {
        Move::Cast => 0.4,
        Move::Combo if me.en.combo_left > 0 => 0.12,
        Move::Summon => 0.6,
        _ => def.recover,
    }
}

/// A melee enemy closing in: chase, take a token, wait on the ring without one.
fn melee_approach(c: &mut Ctx, me: &mut Me, def: &Def, dist: f32, dir_to: Vec2, token: bool) {
    let target = me.en.target;
    let ready = me.en.since_attack >= (def.cooldown - def.windup).max(0.0);
    let in_reach = dist <= def.reach + 0.05;
    let crowded = target.is_some_and(|t| c.tokens.count(t) >= c.tokens.max.max(1)) && !token;
    if in_reach && ready && me.grounded {
        if token {
            me.en.attack = if me.en.arch == Arch::Brute { Move::Slam } else { Move::Lunge };
            go(me, State::Tell);
            clip(me, &def.clips.tell, 4, false, true, 0.08, 1.0);
            let ev = tell_event(me, me.en.attack, def.windup);
            me.events.push(ev);
            c.fx.sounds.push((def.snd_tell.clone(), me.pos, -8.0, me.net));
            me.face = Some(dir_to);
            return;
        }
        if let Some(t) = target {
            c.tokens.request(me.en.waiting, me.e, t);
        }
    }
    if me.en.state == State::Wait || (crowded && dist <= def.ring + 0.8) {
        // the ring: hold `ring` metres off and drift round, asking for a token
        if me.en.state != State::Wait {
            go(me, State::Wait);
        }
        me.en.waiting += c.dt;
        if let Some(t) = target {
            c.tokens.request(me.en.waiting, me.e, t);
        }
        me.en.side_t -= c.dt;
        if me.en.side_t <= 0.0 {
            me.en.side = if c.rng.f32() < 0.5 { -1.0 } else { 1.0 };
            me.en.side_t = c.rng.range(1.5, 3.5);
        }
        let radial = dir_to * ((dist - def.ring) * 2.0).clamp(-1.5, 1.5);
        let tangent = Vec2::new(-dir_to.y, dir_to.x) * me.en.side * 0.9;
        me.want = radial + tangent;
        me.face = Some(dir_to);
        clip(me, &def.clips.move_, 3, true, false, 0.2, 0.6);
        if token || dist > def.ring + 3.0 || !crowded {
            me.en.waiting = 0.0;
            go(me, State::Chase);
        }
        return;
    }
    // chase: on the field, straight with a clear line; ease in to the reach
    let steer = if me.en.los { dir_to } else { c.nav.steer(h(me.pos), h(me.pos) + dir_to * dist, target) };
    let slow = ((dist - def.reach) / 0.6).clamp(0.0, 1.0);
    let k = 1.0 - (-c.dt * 13.0f32).exp();
    let top = def.speed * if in_reach { 0.0 } else { slow.max(0.15) };
    me.en.speed += (top - me.en.speed) * k;
    me.want = steer * me.en.speed;
    if in_reach {
        me.face = Some(dir_to);
    }
    let rate = if def.speed > 0.0 { (me.en.speed / def.speed).clamp(0.3, 1.3) } else { 1.0 };
    if me.en.speed > 0.3 {
        clip(me, &def.clips.move_, 3, true, false, 0.2, rate);
    } else {
        clip(me, &def.clips.idle, 2, true, false, 0.2, 1.0);
    }
}

/// A caster: into range with a clear line, keep its distance, strafe for a lane, cast when ready.
fn caster(c: &mut Ctx, me: &mut Me, def: &Def, dist: f32, dir_to: Vec2, token: bool) {
    let target = me.en.target;
    let range = def.range.max(2.0);
    let lane = me.en.los;
    if dist > range || (!lane && me.en.state != State::Hold) {
        // walk in on the field until a lane opens within range
        if me.en.state != State::Chase {
            go(me, State::Chase);
        }
        let steer = c.nav.steer(h(me.pos), h(me.pos) + dir_to * dist, target);
        me.want = steer * def.speed;
        clip(me, &def.clips.move_, 3, true, false, 0.2, 1.0);
        return;
    }
    if me.en.state != State::Hold {
        go(me, State::Hold);
    }
    me.face = Some(dir_to);
    if !lane {
        // the line is blocked: strafe to the side that sees the target (the grid tells), else walk in
        let side = Vec2::new(-dir_to.y, dir_to.x);
        let t = h(me.pos) + dir_to * dist;
        let open = |s: f32| c.nav.grid.as_ref().is_none_or(|g| g.free_at(h(me.pos) + side * s * 2.0) && g.los(h(me.pos) + side * s * 2.0, t));
        if open(me.en.side) {
        } else if open(-me.en.side) {
            me.en.side = -me.en.side;
        } else {
            go(me, State::Chase);
            return;
        }
        me.want = side * me.en.side * def.speed;
        clip(me, &def.clips.move_, 3, true, false, 0.2, 1.0);
        return;
    }
    if dist < def.keep * 0.7 {
        me.want = -dir_to * def.speed;
        clip(me, &def.clips.move_, 3, true, false, 0.2, 1.0);
    } else {
        me.want = Vec2::ZERO;
        clip(me, &def.clips.idle, 2, true, false, 0.25, 1.0);
    }
    if me.en.since_attack >= def.cooldown && me.grounded {
        if token {
            me.en.attack = Move::Cast;
            go(me, State::Tell);
            clip(me, &def.clips.tell, 4, false, true, 0.08, 1.0);
            let ev = tell_event(me, Move::Cast, def.cast_windup);
            me.events.push(ev);
            c.fx.sounds.push((def.snd_cast.clone(), me.pos, -4.0, me.net));
        } else if let Some(t) = target {
            me.en.waiting += c.dt;
            c.tokens.request(me.en.waiting, me.e, t);
        }
    }
}

/// The boss picks an attack by phase and distance, else walks in.
fn boss_choose(c: &mut Ctx, me: &mut Me, def: &Def, dist: f32, dir_to: Vec2) {
    me.face = Some(dir_to);
    let ready = me.en.since_attack >= def.cooldown;
    if ready && me.grounded {
        let pick = if me.en.phase >= 3 && dist >= 4.0 && dist <= def.charge_distance + 2.0 && me.en.los && c.rng.f32() < 0.5 {
            Some(Move::Charge)
        } else if me.en.phase >= 2 && me.en.summon_cd <= 0.0 && def.summon_count > 0 {
            Some(Move::Summon)
        } else if dist <= def.reach + 0.4 {
            Some(if c.rng.f32() < 0.45 { Move::Slam } else { Move::Combo })
        } else {
            None
        };
        if let Some(m) = pick {
            me.en.attack = m;
            me.en.combo_left = if m == Move::Combo { 3 } else { 0 };
            go(me, State::Tell);
            let (name, code) = match m {
                Move::Combo => (def.clips.combo[0].clone(), 33),
                Move::Summon => (def.clips.roar.clone(), 20),
                _ => (def.clips.tell.clone(), 4),
            };
            clip(me, &name, code, false, true, 0.1, 1.0);
            let ev = tell_event(me, m, tell_len(me, def));
            me.events.push(ev);
            c.fx.sounds.push((def.snd_attack.clone(), me.pos, -2.0, me.net));
            return;
        }
    }
    if me.en.state != State::Chase {
        go(me, State::Chase);
    }
    let steer = if me.en.los { dir_to } else { c.nav.steer(h(me.pos), h(me.pos) + dir_to * dist, me.en.target) };
    let top = if dist <= def.reach { 0.0 } else { def.speed };
    let k = 1.0 - (-c.dt * 6.0f32).exp();
    me.en.speed += (top - me.en.speed) * k;
    me.want = steer * me.en.speed;
    if me.en.speed > 0.3 {
        clip(me, &def.clips.move_, 3, true, false, 0.25, (me.en.speed / def.speed.max(0.1)).clamp(0.4, 1.2));
    } else {
        clip(me, &def.clips.idle, 2, true, false, 0.25, 1.0);
    }
}

fn start_attack(c: &mut Ctx, me: &mut Me, def: &Def, dir_to: Vec2) {
    me.en.dir = if dir_to != Vec2::ZERO { fwd(me.en.yaw).lerp(dir_to, 0.5).normalize_or(dir_to) } else { fwd(me.en.yaw) };
    me.en.from = me.pos;
    me.en.hit_done = false;
    go(me, State::Attack);
    let (name, code) = match me.en.attack {
        Move::Combo => (def.clips.combo[(3 - me.en.combo_left as usize).min(2)].clone(), 40 + me.en.combo_left),
        Move::Summon => (def.clips.roar.clone(), 21),
        _ => (def.clips.attack.clone(), 5),
    };
    clip(me, &name, code, false, true, 0.04, 1.0);
    if me.en.attack != Move::Summon {
        c.fx.sounds.push((def.snd_attack.clone(), me.pos, -2.0, me.net));
    }
}

fn attack(c: &mut Ctx, me: &mut Me, def: &Def, target: Option<Target>, dist: f32, dir_to: Vec2) {
    match me.en.attack {
        Move::Lunge => {
            // 0.5 m in 67 ms, a dip into it; the hit lands and the eyes snap back on the step it ends (target 9)
            me.direct = true;
            let lt = def.lunge_time.max(c.dt);
            me.want = me.en.dir * (def.lunge_distance / lt);
            me.en.offset = -def.lunge_dip * ((me.en.t + c.dt) / lt).min(1.0);
            if me.en.t >= lt - c.dt * 0.5 && !me.en.hit_done {
                me.en.hit_done = true;
                me.en.since_attack = 0.0;
                if let Some(t) = target {
                    let to = h(t.pos) - h(me.pos);
                    let ang = me.en.dir.angle_to(to.normalize_or(me.en.dir)).abs();
                    if to.length() <= def.reach + 0.45 && ang <= 75f32.to_radians() && (t.pos.y - me.pos.y).abs() < 1.6 {
                        c.fx.damage.push((t.e, def.damage, me.net, Vec3::new(me.en.dir.x, 0.0, me.en.dir.y), None));
                    }
                }
                go(me, State::Recover);
                clip(me, &def.clips.recover, 6, false, true, 0.05, 1.0);
            }
        }
        Move::Slam => {
            me.want = Vec2::ZERO;
            if !me.en.hit_done {
                me.en.hit_done = true;
                me.en.since_attack = 0.0;
                let center = h(me.pos) + me.en.dir * (def.reach * 0.5);
                aoe(c, me, def, center, def.slam_radius, def.slam_arc, def.damage, def.knock);
                c.fx.sounds.push((def.snd_slam.clone(), me.pos, 0.0, me.net));
            }
            if me.en.t >= 0.12 {
                go(me, State::Recover);
            }
        }
        Move::Combo => {
            me.want = me.en.dir * 1.2;
            if !me.en.hit_done && me.en.t >= 0.06 {
                me.en.hit_done = true;
                me.en.combo_left = me.en.combo_left.saturating_sub(1);
                if me.en.combo_left == 0 {
                    me.en.since_attack = 0.0;
                }
                if let Some(t) = target {
                    let to = h(t.pos) - h(me.pos);
                    if to.length() <= def.reach + 0.6 && me.en.dir.angle_to(to.normalize_or(me.en.dir)).abs() <= 65f32.to_radians() {
                        c.fx.damage.push((t.e, def.damage * 0.45, me.net, Vec3::new(me.en.dir.x, 0.0, me.en.dir.y), None));
                    }
                }
            }
            if me.en.t >= 0.16 {
                go(me, State::Recover);
            }
        }
        Move::Charge => {
            me.direct = true;
            let gone = h(me.pos).distance(h(me.en.from));
            me.want = me.en.dir * def.charge_speed;
            me.face = Some(me.en.dir);
            if !me.en.hit_done
                && let Some(t) = target
                && h(t.pos).distance(h(me.pos)) <= def.radius + 0.7 {
                    me.en.hit_done = true;
                    c.fx.damage.push((t.e, def.damage * 0.7, me.net, Vec3::new(me.en.dir.x, 0.0, me.en.dir.y), def.knock.then_some((Vec3::new(me.en.dir.x, 0.0, me.en.dir.y), def.knock_speed * 1.3, def.knock_time))));
                }
            // it stops at its distance, on a hit, or against a wall
            let blocked = me.en.t > 0.2 && h(me.moved).length() < def.charge_speed * c.dt * 0.25;
            if gone >= def.charge_distance || me.en.hit_done || blocked || me.en.t > 2.0 {
                me.en.since_attack = 0.0;
                go(me, State::Recover);
            }
        }
        Move::Cast => {
            me.want = Vec2::ZERO;
            if !me.en.hit_done {
                me.en.hit_done = true;
                me.en.since_attack = 0.0;
                let f = fwd(me.en.yaw);
                let from = me.pos + Vec3::new(f.x * 0.55, def.height * 0.75, f.y * 0.55);
                let aim = target.map(|t| t.pos + Vec3::Y * 1.2).unwrap_or(from + Vec3::new(f.x, 0.0, f.y));
                let d = (aim - from).normalize_or(Vec3::new(f.x, 0.0, f.y));
                c.fx.orbs.push(crate::projectile::OrbSpawn { owner: me.net, row: me.en.row, from, dir: d, speed: def.shot_speed, damage: def.damage, color: def.shot_color, light: def.shot_light, intensity: def.shot_intensity, mark: me.en.mark });
            }
            if me.en.t >= 0.1 {
                go(me, State::Recover);
                clip(me, &def.clips.idle, 2, true, false, 0.2, 1.0);
            }
        }
        Move::Summon => {
            me.want = Vec2::ZERO;
            if !me.en.hit_done {
                me.en.hit_done = true;
                me.en.since_attack = 0.0;
                summon(c, me, def);
            }
            if me.en.t >= 0.1 {
                go(me, State::Recover);
            }
        }
    }
    let _ = (dist, dir_to);
}

/// Damage every target within `radius` of `center` and within `arc` of the attack's direction.
#[allow(clippy::too_many_arguments)]
fn aoe(c: &mut Ctx, me: &Me, def: &Def, center: Vec2, radius: f32, arc: f32, damage: f32, knock: bool) {
    for t in c.targets.iter().filter(|t| t.alive) {
        let rel = h(t.pos) - h(me.pos);
        let near = h(t.pos).distance(center) <= radius || rel.length() <= def.radius + 0.6;
        let ang = me.en.dir.angle_to(rel.normalize_or(me.en.dir)).abs();
        if near && ang <= arc * 0.5 && (t.pos.y - me.pos.y).abs() < 2.0 {
            let d = rel.normalize_or(me.en.dir);
            let dir = Vec3::new(d.x, 0.0, d.y);
            c.fx.damage.push((t.e, damage, me.net, dir, knock.then_some((dir, def.knock_speed, def.knock_time))));
        }
    }
}

fn summon(c: &mut Ctx, me: &mut Me, def: &Def) {
    me.en.summon_cd = 14.0;
    let row = c.roster.row_of(&def.summon).or_else(|| c.roster.defs.iter().position(|d| d.arch != Arch::Boss).map(|i| i as u16));
    if let Some(row) = row
        && def.summon_count > 0 {
            c.fx.summons.push((row, def.summon_count, me.pos, me.en.wave));
            c.fx.rules.push(("boss-summon", me.net, def.summon_count as f32, row as f32, 0.0, 0.0));
        }
}

fn die(c: &mut Ctx, me: &mut Me, def: &Def) {
    go(me, State::Dead);
    me.en.dead_t = 0.0;
    me.en.eye = 0.0;
    me.en.offset = 0.0;
    me.en.killer = me.hp.last_hit_by;
    me.want = Vec2::ZERO;
    c.fx.release.push(me.e);
    clip(me, &def.clips.die, 12, false, true, 0.05, 1.0);
    c.fx.sounds.push((def.snd_die.clone(), me.pos, 0.0, me.net));
    c.fx.rules.push(("enemy-down", me.net, me.en.row as f32, def.score, def.coins, me.hp.last_hit_by as f32));
    // wave 7: a splitting elite's young crawl out, a burning one leaves fire (never a split one's young: they never split)
    if me.en.mark & crate::elite::CHILD == 0 {
        match me.en.elite() {
            crate::elite::Mod::Splitting => c.fx.splits.push((me.net, me.en.row, me.pos, me.hp.max, me.en.wave)),
            crate::elite::Mod::Burning => c.fx.fires.push((me.pos, me.net)),
            _ => {}
        }
    }
    if me.en.arch == Arch::Boss {
        c.fx.rules.push(("boss-down", me.net, me.en.row as f32, def.score, def.coins, me.hp.last_hit_by as f32));
    }
}

fn knock_down(c: &mut Ctx, me: &mut Me, def: &Def, secs: f32) {
    c.fx.release.push(me.e);
    me.en.hold_for = if secs > 0.0 { secs } else { def.down };
    go(me, State::Down);
    me.en.offset = 0.0;
    clip(me, &def.clips.fall, 10, false, true, 0.05, 1.0);
}

/// A hit on this enemy: flash, flinch, the hit clip for its side; the shield's block, break and overwhelm; a stagger
/// or a knockdown for a big one.
fn react(c: &mut Ctx, me: &mut Me, def: &Def, hit: &events::Hit) {
    me.en.flash = 1.0;
    me.en.eye_white = 0.05;
    let from = (c.attacker_pos)(hit.attacker).unwrap_or(hit.point + hit.normal);
    let away = (h(me.pos) - h(from)).normalize_or(-fwd(me.en.yaw));
    // which side it came from, in the enemy's frame
    let f = fwd(me.en.yaw);
    let toward = -away;
    let ahead = f.dot(toward);
    let right = Vec2::new(-f.y, f.x).dot(toward);
    let side = if ahead.abs() >= right.abs() { if ahead >= 0.0 { 0 } else { 1 } } else if right >= 0.0 { 3 } else { 2 };
    if def.spring > 0.0 {
        me.push = Some((Part::from_u8(hit.part), Vec3::new(away.x, 0.0, away.y)));
    }
    if !me.hp.dead && me.en.hurt_snd <= 0.0 {
        c.fx.sounds.push((def.snd_hurt.clone(), hit.point, -4.0, me.net));
        me.en.hurt_snd = 0.08;
    }
    if me.en.state == State::Arrive || me.hp.dead {
        return;
    }
    // the shield: a hit on its region is blocked (its damage multiplier let `block` of it through)
    if me.en.arch == Arch::Shield {
        let now = me.en.age;
        let slot = me.en.guard.recent.iter().enumerate().min_by(|a, b| a.1.0.total_cmp(&b.1.0)).map(|x| x.0).unwrap_or(0);
        me.en.guard.recent[slot] = (now, hit.attacker);
        let window: Vec<(f32, u32)> = me.en.guard.recent.iter().filter(|r| now - r.0 <= def.overwhelm_window).copied().collect();
        let mut who: Vec<u32> = window.iter().map(|r| r.1).collect();
        who.sort();
        who.dedup();
        let blocked = me.en.guarding() && hit.region as usize == me.en.guard.region;
        if blocked {
            me.en.guard.hp -= hit.damage / def.shield_block.max(0.01);
            me.upper = Some(def.clips.blocked.clone());
            me.en.upper_t = 0.3;
            c.fx.sounds.push((def.snd_block.clone(), hit.point, -2.0, me.net));
            me.events.push(state_event(me.net, State::Hold, me.en.arch, State::Hold));
            if me.en.guard.hp <= 0.0 {
                me.en.guard.broken = true;
                c.fx.release.push(me.e);
                me.en.hold_for = def.shield_stagger;
                go(me, State::Stagger);
                clip(me, &def.clips.hit[0], 8, false, true, 0.05, 1.0);
                c.fx.sounds.push((def.snd_shatter.clone(), hit.point, 0.0, me.net));
                c.fx.rules.push(("shield-break", me.net, me.en.row as f32, hit.attacker as f32, 0.0, 0.0));
                return;
            }
        }
        if me.en.guarding() && (window.len() as u32 >= def.overwhelm_hits || who.len() >= 2 && window.len() >= 3) {
            me.en.guard.down = def.overwhelm_time;
            me.en.guard.recent = [(-99.0, 0); 8];
            c.fx.release.push(me.e);
            me.en.hold_for = 0.45;
            go(me, State::Stagger);
            clip(me, &def.clips.hit[side], 8, false, true, 0.05, 1.0);
            c.fx.rules.push(("guard-down", me.net, me.en.row as f32, def.overwhelm_time, 0.0, 0.0));
            return;
        }
        if blocked {
            return;
        }
    }
    let share = hit.damage / me.hp.max.max(1.0);
    if share >= def.knock_at && me.en.state != State::Down {
        knock_down(c, me, def, def.down);
    } else if share >= def.stagger_at && !matches!(me.en.state, State::Down | State::Rise | State::Roar) {
        c.fx.release.push(me.e);
        me.en.hold_for = 0.35;
        go(me, State::Stagger);
        clip(me, &def.clips.hit[side], 8, false, true, 0.05, 1.0);
    } else {
        // a flinch on the upper body; the legs keep going
        me.upper = Some(def.clips.hit[side].clone());
        me.en.upper_t = 0.3;
    }
}

/// Stuck: what it meant to walk against what it walked, half a second at a time. Two bad windows → a detour to the
/// side (alternating); six detours without getting nearer → it sinks and rises again near its target.
fn stuck(c: &mut Ctx, me: &mut Me, def: &Def, dist: f32) {
    let s = &mut me.en.stuck;
    if s.detour > 0.0 {
        s.detour -= c.dt;
        me.want = s.detour_dir * def.speed;
        return;
    }
    s.window += c.dt;
    s.expected += me.want.length() * c.dt;
    s.moved += h(me.moved).length();
    if s.window < 0.5 {
        return;
    }
    let bad = s.expected > 0.35 && s.moved < 0.3 * s.expected;
    if dist + 0.5 < s.best {
        s.best = dist;
        s.tries = 0;
    }
    s.strikes = if bad { s.strikes + 1 } else { 0 };
    s.window = 0.0;
    s.expected = 0.0;
    s.moved = 0.0;
    if s.strikes >= 2 && me.want.length_squared() > 1e-4 {
        s.strikes = 0;
        s.tries += 1;
        s.detours += 1;
        // keep to one side for three tries, then the other; each a little longer
        let ang = if (s.tries - 1) / 3 % 2 == 0 { 1.3 } else { -1.3 } * me.en.side;
        let w = me.want.normalize();
        s.detour_dir = Vec2::new(w.x * ang.cos() - w.y * ang.sin(), w.x * ang.sin() + w.y * ang.cos());
        s.detour = 0.5 + 0.2 * ((s.tries - 1) % 3) as f32;
        c.fx.learn.push((me.pos, w));
        if s.tries >= 6 {
            s.tries = 0;
            s.best = f32::MAX;
            s.reemerged += 1;
            let near = me.en.target.and_then(|t| c.targets.iter().find(|x| x.e == t)).map(|t| t.pos).unwrap_or(me.pos);
            c.fx.reemerge.push((me.e, near));
        }
    }
}

/// An enemy that could not get anywhere sinks and rises again near `near` (a free cell 5-8 m off).
fn reemerge(sim: &mut Sim, nav: &Nav, e: Entity, near: Vec3) {
    let Some(at) = crate::director::free_spot(sim, nav, near, 5.0, 8.0, None) else { return };
    sim.teleport(e, at);
    let row = sim.world.get::<&Enemy>(e).map(|en| en.row).unwrap_or(0);
    let depth = sim.res.get::<Roster>().map(|r| r.def(row).depth).unwrap_or(0.5);
    if let Ok(mut en) = sim.world.get::<&mut Enemy>(e) {
        en.state = State::Arrive;
        en.t = 0.0;
        en.offset = -depth;
        en.clip = u8::MAX;
        en.stuck.detour = 0.0;
    }
}

fn add_shield(sim: &mut Sim, e: Entity) {
    let Ok(mut hb) = sim.world.get::<&mut Hurtbox>(e) else { return };
    let block = sim.res.get::<Roster>().zip(sim.world.get::<&Enemy>(e).ok().map(|en| en.row)).map(|(r, row)| r.def(row).shield_block).unwrap_or(0.15);
    let region = HurtRegion { part: Part::ForearmL, bone: NO_BONE, a: Vec3::new(0.0, 0.45, -0.5), b: Vec3::new(0.0, 1.45, -0.5), radius: SHIELD_RADIUS, damage: block, crit: false };
    hb.regions.push(region);
    hb.world.push((Vec3::ZERO, Vec3::ZERO));
    let i = hb.regions.len() - 1;
    drop(hb);
    if let Ok(mut en) = sim.world.get::<&mut Enemy>(e) {
        en.guard.region = i;
    }
}

fn remove_shield(sim: &mut Sim, e: Entity) {
    let idx = sim.world.get::<&Enemy>(e).map(|en| en.guard.region).unwrap_or(usize::MAX);
    if let Ok(mut hb) = sim.world.get::<&mut Hurtbox>(e)
        && idx < hb.regions.len() && hb.regions[idx].bone == NO_BONE && hb.regions[idx].radius == SHIELD_RADIUS {
            hb.regions.remove(idx);
            hb.world.remove(idx);
        }
    if let Ok(mut en) = sim.world.get::<&mut Enemy>(e) {
        en.guard.region = usize::MAX;
    }
}

/// The host animated this enemy (`Sim::animate`): play what the state asked for, root pinned; the flinch spring.
fn animate(sim: &mut Sim, me: &Me, def: &Def) {
    let lib = &sim.anim.library;
    let Ok(mut a) = sim.world.get::<&mut Animated>(me.e) else { return };
    a.animator.pin_xz = true;
    if let Some(an) = &me.anim {
        let fresh = !me.en.pinned;
        a.animator.play(lib, &an.clip, Play { fade: if fresh { 0.0 } else { an.fade }, looping: Some(an.looping), rate: an.rate, layer: Some(Layer::Base), restart: !an.looping, hold: an.hold, max_rise: Some(0.12) });
    }
    if let Some(u) = &me.upper {
        if u.is_empty() {
            a.animator.stop(Layer::Upper);
        } else {
            a.animator.play(lib, u, Play { fade: 0.06, looping: Some(false), layer: Some(Layer::Upper), restart: true, max_rise: Some(0.12), ..Play::default() });
        }
    }
    if let Some((part, dir)) = me.push
        && let Some(bone) = humanoid::part_bone(part.name()).or(Some("Spine")).and_then(|n| lib.bone(a.animator.body, n)) {
            // the body faces +Z and the entity −Z: turned by π
            let body_rot = Quat::from_rotation_y(me.en.yaw) * Quat::from_rotation_y(std::f32::consts::PI);
            let d = forge_anim::to_model(dir, body_rot);
            a.animator.push(lib, bone, d, def.spring, 18.0, 0.45);
        }
    drop(a);
    if !me.en.pinned
        && let Ok(mut en) = sim.world.get::<&mut Enemy>(me.e) {
            en.pinned = true;
        }
}
