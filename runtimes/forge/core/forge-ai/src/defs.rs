//! The enemy types and waves as forge-ai reads them: table rows (`spec.forge.enemies`, `spec.forge.waves`) → typed
//! definitions. A row starts from its archetype's values and then takes its own, as the kit's `fill` does
//! (research/gf-forge/kit/tables/enemies.js); the defaults here equal the kit's, and a test holds them to
//! research/gf-forge/fixtures/ai/tables/archetypes.json (`node research/gf-forge/tools/ai-tables.mjs --write` writes it from
//! the kit). Units: metres, seconds, radians (the table's degrees are turned into radians here), linear RGB.
use forge_core::tables::{hex_linear, Row, Tables};

/// An enemy's behaviour.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
#[repr(u8)]
pub enum Arch {
    /// Rises, closes in, a 0.3 s eye-glow tell, a 0.5 m lunge (feel target 9).
    Chaser = 0,
    /// A faster chaser.
    Runner = 1,
    /// Seeks a clear lane, a readable cast tell, a projectile.
    Caster = 2,
    /// Blocks from the front: flank it, break the shield or overwhelm it.
    Shield = 3,
    /// Slow, a long tell, a slam that can knock a player down.
    Brute = 4,
    /// Phases, telegraphed slams and combos, summons, a charge; health for the HUD's bar.
    Boss = 5,
}

impl Arch {
    pub const ALL: [Arch; 6] = [Arch::Chaser, Arch::Runner, Arch::Caster, Arch::Shield, Arch::Brute, Arch::Boss];
    pub fn parse(s: &str) -> Arch {
        match s {
            "runner" => Arch::Runner,
            "caster" => Arch::Caster,
            "shield" => Arch::Shield,
            "brute" => Arch::Brute,
            "boss" => Arch::Boss,
            _ => Arch::Chaser,
        }
    }
    pub fn name(self) -> &'static str {
        ["chaser", "runner", "caster", "shield", "brute", "boss"][self as usize]
    }
    /// Attacks in melee (everything but the caster, which throws).
    pub fn melee(self) -> bool {
        self != Arch::Caster
    }
}

/// The clip names an enemy plays (the gf-humanoid-1 forge clip file's names: research/gf-forge/library/clips).
#[derive(Clone, Debug, PartialEq)]
pub struct Clips {
    pub arrive: String,
    pub idle: String,
    pub move_: String,
    pub tell: String,
    pub attack: String,
    pub recover: String,
    /// From the front, behind, the left, the right.
    pub hit: [String; 4],
    pub fall: String,
    pub rise: String,
    pub die: String,
    pub roar: String,
    pub combo: [String; 3],
    pub guard: String,
    pub blocked: String,
}

/// One enemy type, typed.
#[derive(Clone, Debug, PartialEq)]
pub struct Def {
    pub id: String,
    pub arch: Arch,
    pub body: String,
    pub health: f32,
    pub speed: f32,
    pub damage: f32,
    pub reach: f32,
    pub windup: f32,
    pub lunge_distance: f32,
    pub lunge_time: f32,
    pub lunge_dip: f32,
    pub recover: f32,
    pub backoff: f32,
    pub cooldown: f32,
    pub radius: f32,
    pub height: f32,
    pub scale: f32,
    /// rad/s.
    pub turn: f32,
    pub ring: f32,
    /// The highest ledge it walks up (0: none; the controller's autostep costs a crowd 40% more).
    pub climb: f32,
    pub eye_color: [f32; 3],
    pub eye_glow: f32,
    pub eye_windup: f32,
    pub emerge: bool,
    pub depth: f32,
    pub hold: f32,
    pub arrive: f32,
    pub range: f32,
    pub keep: f32,
    pub shot_speed: f32,
    pub cast_windup: f32,
    pub shot_color: [f32; 3],
    pub shot_light: f32,
    pub shot_intensity: f32,
    /// rad.
    pub shield_arc: f32,
    pub shield_block: f32,
    pub shield_hp: f32,
    pub shield_stagger: f32,
    pub overwhelm_hits: u32,
    pub overwhelm_window: f32,
    pub overwhelm_time: f32,
    pub slam_radius: f32,
    /// rad.
    pub slam_arc: f32,
    pub knock: bool,
    pub knock_time: f32,
    pub knock_speed: f32,
    pub phases: u32,
    pub roar: f32,
    pub summon: String,
    pub summon_count: u32,
    pub charge_speed: f32,
    pub charge_distance: f32,
    pub spring: f32,
    pub stagger_at: f32,
    pub knock_at: f32,
    pub down: f32,
    pub getup: f32,
    pub score: f32,
    pub coins: f32,
    pub snd_attack: String,
    pub snd_hurt: String,
    pub snd_die: String,
    pub snd_spawn: String,
    pub snd_tell: String,
    pub snd_cast: String,
    pub snd_impact: String,
    pub snd_slam: String,
    pub snd_roar: String,
    pub snd_block: String,
    pub snd_shatter: String,
    pub clips: Clips,
}

fn lin(hex: &str) -> [f32; 3] {
    hex_linear(hex).unwrap_or([1.0, 1.0, 1.0])
}

impl Def {
    /// The field defaults with `arch`'s values on top (kit/tables/enemies.js `archetypes`).
    pub fn base(arch: Arch) -> Def {
        let s = |x: &str| x.to_string();
        let mut d = Def {
            id: String::new(),
            arch,
            body: s("skeleton-grim-chaser"),
            health: 30.0,
            speed: 3.3,
            damage: 13.0,
            reach: 0.9,
            windup: 0.3,
            lunge_distance: 0.5,
            lunge_time: 0.067,
            lunge_dip: 0.12,
            recover: 0.25,
            backoff: 0.2,
            cooldown: 1.1,
            radius: 0.35,
            height: 1.8,
            scale: 1.0,
            turn: 540f32.to_radians(),
            ring: 2.4,
            climb: 0.0,
            eye_color: lin("#ffaf48"),
            eye_glow: 2.4,
            eye_windup: 0.13,
            emerge: true,
            depth: 0.5,
            hold: 0.2,
            arrive: 1.0,
            range: 12.0,
            keep: 6.0,
            shot_speed: 12.0,
            cast_windup: 0.34,
            shot_color: lin("#fe6c19"),
            shot_light: 4.6,
            shot_intensity: 6.0,
            shield_arc: 140f32.to_radians(),
            shield_block: 0.15,
            shield_hp: 60.0,
            shield_stagger: 0.8,
            overwhelm_hits: 4,
            overwhelm_window: 1.2,
            overwhelm_time: 1.5,
            slam_radius: 2.2,
            slam_arc: 140f32.to_radians(),
            knock: true,
            knock_time: 0.6,
            knock_speed: 6.0,
            phases: 3,
            roar: 1.6,
            summon: String::new(),
            summon_count: 3,
            charge_speed: 12.0,
            charge_distance: 8.0,
            spring: 5.0,
            stagger_at: 0.35,
            knock_at: 0.6,
            down: 1.0,
            getup: 1.0,
            score: 10.0,
            coins: 1.0,
            snd_attack: s("enemy-attack"),
            snd_hurt: s("impact-bone"),
            snd_die: s("bone-break"),
            snd_spawn: s("enemy-emerge"),
            snd_tell: s("enemy-windup"),
            snd_cast: s("enemy-cast"),
            snd_impact: s("enemy-orb-impact"),
            snd_slam: s("boss-slam"),
            snd_roar: s("boss-roar"),
            snd_block: s("shield-block"),
            snd_shatter: s("shield-break"),
            clips: Clips {
                arrive: s("emerge"),
                idle: s("idle_combat"),
                move_: s("run"),
                tell: s("windup"),
                attack: s("lunge"),
                recover: s("recover"),
                hit: [s("hit_front"), s("hit_back"), s("hit_left"), s("hit_right")],
                fall: s("knockdown"),
                rise: s("getup"),
                die: s("death"),
                roar: s("taunt"),
                combo: [s("slash_1"), s("slash_2"), s("slash_3")],
                guard: s("block"),
                blocked: s("block_hit"),
            },
        };
        match arch {
            // a body is built 1.75 m tall and the player's eyes are at 1.74 m: at 1.1 a chaser's head is level with
            // them, so a round fired with no up or down aim lands (measured on Bone Vigil, 2026-10-11: 20 of 68 at
            // 1.0, 30 of 59 at 1.08, 35 of 57 at 1.12). A runner stays 0.92 of a chaser (moment 13).
            Arch::Chaser => {
                d.range = 0.0;
                d.scale = 1.1;
            }
            Arch::Runner => {
                d.speed = 4.2;
                d.scale = 1.01;
                d.eye_color = lin("#ff4224");
                d.range = 0.0;
            }
            Arch::Caster => {
                d.body = s("skeleton-grim-caster");
                d.scale = 1.1;
                d.speed = 2.4;
                d.health = 25.0;
                d.reach = 1.0;
                d.cooldown = 2.2;
                d.eye_color = lin("#4bffc0");
                d.range = 12.0;
                d.keep = 6.0;
                d.shot_speed = 24.0;
                d.cast_windup = 0.34;
                d.shot_color = lin("#3ffa8b");
                d.shot_light = 4.6;
                d.shot_intensity = 6.0;
                d.clips.move_ = s("walk");
                d.clips.tell = s("cast_windup");
                d.clips.attack = s("cast");
            }
            Arch::Shield => {
                d.body = s("skeleton-grim-soldier");
                d.scale = 1.1;
                d.speed = 2.8;
                d.health = 60.0;
                d.damage = 15.0;
                d.turn = 140f32.to_radians();
                d.eye_color = lin("#ff4224");
                d.range = 0.0;
                d.clips.move_ = s("walk");
            }
            Arch::Brute => {
                d.body = s("skeleton-grim-brute");
                d.speed = 2.6;
                d.health = 120.0;
                d.damage = 25.0;
                d.reach = 1.5;
                d.radius = 0.5;
                d.height = 2.2;
                d.windup = 0.8;
                d.recover = 0.9;
                d.backoff = 0.0;
                d.cooldown = 2.4;
                d.turn = 200f32.to_radians();
                d.ring = 3.2;
                d.eye_color = lin("#ff8930");
                d.range = 0.0;
                d.stagger_at = 0.5;
                d.knock_at = 2.0;
                d.score = 40.0;
                d.coins = 4.0;
                d.clips.move_ = s("walk");
                d.clips.attack = s("heavy");
                d.clips.hit = [s("hit_heavy"), s("hit_heavy"), s("hit_heavy"), s("hit_heavy")];
            }
            Arch::Boss => {
                d.body = s("skeleton-grim-lord");
                d.speed = 2.4;
                d.health = 1500.0;
                d.damage = 30.0;
                d.reach = 2.4;
                d.radius = 0.6;
                d.height = 2.6;
                d.windup = 0.9;
                d.recover = 1.0;
                d.backoff = 0.0;
                d.cooldown = 1.6;
                d.turn = 220f32.to_radians();
                d.ring = 4.0;
                d.eye_color = lin("#ff7027");
                d.eye_glow = 3.0;
                d.arrive = 1.8;
                d.range = 0.0;
                d.slam_radius = 3.0;
                d.slam_arc = 160f32.to_radians();
                d.knock_time = 0.7;
                d.stagger_at = 2.0;
                d.knock_at = 2.0;
                d.score = 500.0;
                d.coins = 25.0;
                d.clips.arrive = s("emerge_leap");
                d.clips.move_ = s("walk");
                d.clips.attack = s("heavy");
                d.clips.hit = [s("hit_heavy"), s("hit_heavy"), s("hit_heavy"), s("hit_heavy")];
            }
        }
        d
    }

    /// A table row: its archetype's values, then its own.
    pub fn from_row(r: &Row) -> Def {
        let arch = Arch::parse(r.str("archetype").unwrap_or("chaser"));
        let b = Def::base(arch);
        let n = |k: &str, d: f32| r.num(k, d);
        let deg = |k: &str, d: f32| r.num(k, d.to_degrees()).to_radians();
        let st = |k: &str, d: &str| r.str(k).filter(|s| !s.is_empty()).unwrap_or(d).to_string();
        let c = &b.clips;
        Def {
            id: r.id().to_string(),
            arch,
            body: st("body", &b.body),
            health: n("health", b.health).max(1.0),
            speed: n("speed", b.speed).max(0.0),
            damage: n("damage", b.damage).max(0.0),
            reach: n("reach", b.reach).max(0.1),
            windup: n("windup", b.windup).max(0.0),
            lunge_distance: n("lunge.distance", b.lunge_distance).max(0.0),
            lunge_time: n("lunge.time", b.lunge_time).max(0.008),
            lunge_dip: n("lunge.dip", b.lunge_dip).max(0.0),
            recover: n("recover", b.recover).max(0.0),
            backoff: n("backoff", b.backoff).max(0.0),
            cooldown: n("cooldown", b.cooldown).max(0.0),
            radius: n("radius", b.radius).clamp(0.1, 3.0),
            height: n("height", b.height).clamp(0.3, 6.0),
            scale: n("scale", b.scale).clamp(0.2, 5.0),
            turn: deg("turn", b.turn).max(0.1),
            ring: n("ring", b.ring).max(0.5),
            climb: n("climb", b.climb).clamp(0.0, 1.0),
            eye_color: r.color("eye.color", b.eye_color),
            eye_glow: n("eye.glow", b.eye_glow).max(0.0),
            eye_windup: n("eye.windupGlow", b.eye_windup).max(0.0),
            emerge: r.bool("arrival.emerge", b.emerge),
            depth: n("arrival.depth", b.depth).max(0.0),
            hold: n("arrival.hold", b.hold).max(0.0),
            arrive: n("arrival.time", b.arrive).max(0.0),
            range: n("ranged.range", b.range).max(0.0),
            keep: n("ranged.keep", b.keep).max(0.0),
            shot_speed: n("ranged.speed", b.shot_speed).max(0.5),
            cast_windup: n("ranged.windup", b.cast_windup).max(0.0),
            shot_color: r.color("ranged.color", b.shot_color),
            shot_light: n("ranged.light", b.shot_light).max(0.0),
            shot_intensity: n("ranged.intensity", b.shot_intensity).max(0.0),
            shield_arc: deg("shield.arc", b.shield_arc),
            shield_block: n("shield.block", b.shield_block).clamp(0.0, 1.0),
            shield_hp: n("shield.hp", b.shield_hp).max(1.0),
            shield_stagger: n("shield.stagger", b.shield_stagger).max(0.0),
            overwhelm_hits: r.int("shield.overwhelmHits", b.overwhelm_hits as i64).max(1) as u32,
            overwhelm_window: n("shield.overwhelmWindow", b.overwhelm_window).max(0.1),
            overwhelm_time: n("shield.overwhelmTime", b.overwhelm_time).max(0.0),
            slam_radius: n("slam.radius", b.slam_radius).max(0.3),
            slam_arc: deg("slam.arc", b.slam_arc),
            knock: r.bool("slam.knock", b.knock),
            knock_time: n("slam.knockTime", b.knock_time).clamp(0.0, 0.8),
            knock_speed: n("slam.knockSpeed", b.knock_speed).clamp(0.0, 20.0),
            phases: r.int("boss.phases", b.phases as i64).clamp(1, 3) as u32,
            roar: n("boss.roar", b.roar).max(0.0),
            summon: st("boss.summon", &b.summon),
            summon_count: r.int("boss.summonCount", b.summon_count as i64).clamp(0, 12) as u32,
            charge_speed: n("boss.chargeSpeed", b.charge_speed).max(0.0),
            charge_distance: n("boss.chargeDistance", b.charge_distance).max(0.0),
            spring: n("react.spring", b.spring).max(0.0),
            stagger_at: n("react.stagger", b.stagger_at).max(0.0),
            knock_at: n("react.knock", b.knock_at).max(0.0),
            down: n("react.down", b.down).max(0.0),
            getup: n("react.getup", b.getup).max(0.0),
            score: n("score", b.score).max(0.0),
            coins: n("coins", b.coins).max(0.0),
            snd_attack: st("sounds.attack", &b.snd_attack),
            snd_hurt: st("sounds.hurt", &b.snd_hurt),
            snd_die: st("sounds.die", &b.snd_die),
            snd_spawn: st("sounds.spawn", &b.snd_spawn),
            snd_tell: st("sounds.tell", &b.snd_tell),
            snd_cast: st("sounds.cast", &b.snd_cast),
            snd_impact: st("sounds.impact", &b.snd_impact),
            snd_slam: st("sounds.slam", &b.snd_slam),
            snd_roar: st("sounds.roar", &b.snd_roar),
            snd_block: st("sounds.block", &b.snd_block),
            snd_shatter: st("sounds.shatter", &b.snd_shatter),
            clips: Clips {
                arrive: st("clips.arrive", &c.arrive),
                idle: st("clips.idle", &c.idle),
                move_: st("clips.move", &c.move_),
                tell: st("clips.tell", &c.tell),
                attack: st("clips.attack", &c.attack),
                recover: st("clips.recover", &c.recover),
                hit: [st("clips.hitFront", &c.hit[0]), st("clips.hitBack", &c.hit[1]), st("clips.hitLeft", &c.hit[2]), st("clips.hitRight", &c.hit[3])],
                fall: st("clips.fall", &c.fall),
                rise: st("clips.rise", &c.rise),
                die: st("clips.die", &c.die),
                roar: st("clips.roar", &c.roar),
                combo: [st("clips.combo1", &c.combo[0]), st("clips.combo2", &c.combo[1]), st("clips.combo3", &c.combo[2])],
                guard: st("clips.guard", &c.guard),
                blocked: st("clips.blocked", &c.blocked),
            },
        }
    }
}

/// When a wave hands over to the next.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Next {
    /// When every enemy of it is down.
    Cleared,
    /// After `time` seconds, whatever is left.
    Timer,
}

/// One wave, typed; its groups name enemy rows (an unknown type is dropped, and said so in `Roster::notes`).
#[derive(Clone, Debug, PartialEq)]
pub struct WaveDef {
    pub id: String,
    /// (enemy row, count).
    pub groups: Vec<(u16, u32)>,
    pub delay: f32,
    pub spawn_every: f32,
    pub max_alive: u32,
    pub attackers: u32,
    pub dmin: f32,
    pub dmax: f32,
    pub boss: bool,
    pub next: Next,
    pub time: f32,
    pub reward: bool,
    /// The share of the wave added for each player after the first (wave 2: its enemies, `max_alive`, a boss's health).
    pub friends: f32,
}

impl WaveDef {
    pub fn from_row(r: &Row, enemies: &[Row], notes: &mut Vec<String>) -> WaveDef {
        let mut groups = Vec::new();
        for g in r.rows("enemies") {
            let ty = g.str("type").unwrap_or("");
            match Tables::find(enemies, ty) {
                Some((i, _)) => groups.push((i as u16, g.int("count", 6).clamp(1, 500) as u32)),
                None => notes.push(format!("wave {}: no enemy type \"{ty}\"", r.id())),
            }
        }
        let dmin = r.num("distance.min", 7.0).max(0.0);
        WaveDef {
            id: r.id().to_string(),
            groups,
            delay: r.num("delay", 0.7).max(0.0),
            spawn_every: r.num("spawnEvery", 0.6).max(0.0),
            max_alive: r.int("maxAlive", 8).clamp(1, 200) as u32,
            attackers: r.int("attackers", 3).clamp(1, 50) as u32,
            dmin,
            dmax: r.num("distance.max", 10.0).max(dmin),
            boss: r.bool("boss", false),
            next: if r.str("next") == Some("timer") { Next::Timer } else { Next::Cleared },
            time: r.num("time", 0.0).max(0.0),
            reward: r.bool("reward", false),
            friends: r.num("friends", 0.0).clamp(0.0, 3.0),
        }
    }
    pub fn count(&self) -> u32 {
        self.groups.iter().map(|g| g.1).sum()
    }
}

/// `spec.forge.endless` (wave 6; the kit's `tables/endless.js`): with `on`, the waves never run out. After the last
/// wave the director starts again at wave `from` (1-based), one lap more, and each lap the waves are bigger and their
/// enemies tougher: a share added a lap (`1 + grow × lap`), the most alive at once capped at `alive_most` (the crowd's
/// frame budget) and the speed at `speed_most` times its own. The first time through is the waves as written.
#[derive(Clone, Debug)]
pub struct Endless {
    pub on: bool,
    /// The wave the laps start again at (an index into the waves).
    pub from: usize,
    pub enemies: f32,
    pub alive: f32,
    pub alive_most: u32,
    pub health: f32,
    pub damage: f32,
    pub speed: f32,
    pub speed_most: f32,
}

impl Default for Endless {
    fn default() -> Self {
        Endless { on: false, from: 0, enemies: 0.25, alive: 0.15, alive_most: 16, health: 0.2, damage: 0.1, speed: 0.04, speed_most: 1.3 }
    }
}

impl Endless {
    pub fn from_row(r: &Row) -> Endless {
        let d = Endless::default();
        Endless {
            on: r.bool("on", false),
            from: (r.int("from", 1).max(1) - 1) as usize,
            enemies: r.num("grow.enemies", d.enemies).max(0.0),
            alive: r.num("grow.alive", d.alive).max(0.0),
            alive_most: r.int("aliveMost", d.alive_most as i64).clamp(1, 200) as u32,
            health: r.num("grow.health", d.health).max(0.0),
            damage: r.num("grow.damage", d.damage).max(0.0),
            speed: r.num("grow.speed", d.speed).max(0.0),
            speed_most: r.num("speedMost", d.speed_most).max(1.0),
        }
    }
    /// `1 + grow × lap` (1 when endless is off or on the first time through).
    pub fn mul(&self, grow: f32, lap: u32) -> f32 {
        if self.on { 1.0 + grow * lap as f32 } else { 1.0 }
    }
}

/// Every enemy type and wave, typed at each tables load (`on_tables`).
#[derive(Clone, Debug, Default)]
pub struct Roster {
    pub defs: Vec<Def>,
    pub waves: Vec<WaveDef>,
    pub notes: Vec<String>,
    pub endless: Endless,
    /// `spec.forge.elites` (wave 7).
    pub elites: crate::elite::Elites,
    /// Rows as a later lap, an elite or a split one's young makes them (`variant`): an enemy's `Enemy::def` past
    /// `defs` names one of these. Made once each (row, lap, modifier, young); a tables load starts them again.
    pub variants: Vec<Def>,
    pub variant_keys: Vec<(u16, u32, u8)>,
    /// Wave 7 (track P): after which waves the pedlar's cart opens (`spec.forge.shop`: on, every, from; forge-feel's
    /// shop.rs runs the cart). The director waits for it as it waits for a reward.
    pub cart: Cart,
}

/// When the pedlar's cart opens (`spec.forge.shop`'s on, every and from; the items are forge-feel's).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Cart {
    pub on: bool,
    pub every: u32,
    pub from: u32,
}

impl Cart {
    pub fn from_row(r: &Row) -> Cart {
        let items = r.get("items").and_then(|v| v.as_array()).map(|a| !a.is_empty()).unwrap_or(true);
        Cart { on: r.bool("on", false) && items, every: r.int("every", 1).clamp(1, 64) as u32, from: r.int("from", 1).clamp(1, 1000) as u32 }
    }
    /// Does the cart open after wave `number` (1-based, as players count)? (forge-feel `ShopCfg::opens_after`)
    pub fn after(&self, number: u32) -> bool {
        self.on && number >= self.from && (number - self.from) % self.every.max(1) == 0
    }
}

impl Roster {
    pub fn load(t: &Tables) -> Roster {
        let defs = t.enemies.iter().map(Def::from_row).collect();
        let mut notes = Vec::new();
        let waves: Vec<WaveDef> = t.waves.iter().map(|w| WaveDef::from_row(w, &t.enemies, &mut notes)).collect();
        let mut endless = t.raw.row("endless").map(|r| Endless::from_row(&r)).unwrap_or_default();
        if endless.on && endless.from >= waves.len().max(1) {
            notes.push(format!("endless.from: wave {} is past the last wave ({}); the laps start again at the first", endless.from + 1, waves.len()));
            endless.from = 0;
        }
        let elites = t.raw.row("elites").map(|r| crate::elite::Elites::from_row(&r)).unwrap_or_default();
        let cart = t.raw.row("shop").map(|r| Cart::from_row(&r)).unwrap_or_default();
        Roster { defs, waves, notes, endless, elites, variants: Vec::new(), variant_keys: Vec::new(), cart }
    }
    /// Row `row` as it rises at lap `lap` with modifier `m` (or as a split one's young): endless's growth for the lap,
    /// then the elite's changes (elite.rs). → its index for `Enemy::def` (the row itself when nothing changes it).
    /// The endless growth reaches what an enemy does each step this way (wave 6 scaled only the health it rose with:
    /// its damage and speed were read from the row every step).
    pub fn variant(&mut self, row: u16, lap: u32, m: crate::elite::Mod, child: bool) -> u16 {
        let grows = self.endless.on && lap > 0;
        if !grows && m == crate::elite::Mod::None && !child {
            return row;
        }
        let key = (row, if grows { lap } else { 0 }, m as u8 | if child { crate::elite::CHILD } else { 0 });
        if let Some(i) = self.variant_keys.iter().position(|k| *k == key) {
            return (self.defs.len() + i) as u16;
        }
        let mut d = self.def(row).into_owned();
        if grows {
            let e = &self.endless;
            d.health *= e.mul(e.health, lap);
            d.damage *= e.mul(e.damage, lap);
            d.speed *= e.mul(e.speed, lap).min(e.speed_most);
        }
        self.elites.apply(&mut d, m, child);
        self.variants.push(d);
        self.variant_keys.push(key);
        (self.defs.len() + self.variants.len() - 1) as u16
    }
    /// The type an enemy's `def` index names: a row, or a variant (the row's own when that variant is gone).
    pub fn by_index(&self, ix: u16) -> std::borrow::Cow<'_, Def> {
        let i = ix as usize;
        if i < self.defs.len() {
            return std::borrow::Cow::Borrowed(&self.defs[i]);
        }
        match (self.variants.get(i - self.defs.len()), self.variant_keys.get(i - self.defs.len())) {
            (Some(d), _) => std::borrow::Cow::Borrowed(d),
            _ => std::borrow::Cow::Owned(Def::base(Arch::Chaser)),
        }
    }
    /// What an enemy is now: its variant, else its row.
    pub fn of(&self, en: &crate::enemy::Enemy) -> std::borrow::Cow<'_, Def> {
        let i = en.def as usize;
        if i >= self.defs.len() && i - self.defs.len() < self.variants.len() {
            return std::borrow::Cow::Borrowed(&self.variants[i - self.defs.len()]);
        }
        self.def(en.row)
    }
    /// The type of row `row`, or the chaser's defaults when the tables have no such row.
    pub fn def(&self, row: u16) -> std::borrow::Cow<'_, Def> {
        match self.defs.get(row as usize) {
            Some(d) => std::borrow::Cow::Borrowed(d),
            None => std::borrow::Cow::Owned(Def::base(Arch::Chaser)),
        }
    }
    pub fn row_of(&self, id: &str) -> Option<u16> {
        self.defs.iter().position(|d| d.id == id).map(|i| i as u16)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use forge_core::serde_json::{self, Value};

    /// The Rust defaults equal the kit's: research/gf-forge/fixtures/ai/tables/archetypes.json is every archetype's row as the
    /// kit fills it (`node research/gf-forge/tools/ai-tables.mjs --write`).
    #[test]
    fn archetype_defaults_equal_the_kits() {
        let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../../fixtures/ai/tables/archetypes.json");
        let text = std::fs::read_to_string(path).expect("research/gf-forge/fixtures/ai/tables/archetypes.json (node research/gf-forge/tools/ai-tables.mjs --write)");
        let v: Value = serde_json::from_str(&text).unwrap();
        let rows = v.get("archetypes").and_then(Value::as_object).expect("archetypes");
        for a in Arch::ALL {
            let row = rows.get(a.name()).and_then(Value::as_object).unwrap_or_else(|| panic!("no {}", a.name()));
            let mut d = Def::from_row(&Row(row.clone()));
            let mut b = Def::base(a);
            d.id.clear();
            b.id.clear();
            // degrees → radians round trips in f32: compare those within a hair, the rest exactly
            for (x, y) in [(&mut d.turn, b.turn), (&mut d.shield_arc, b.shield_arc), (&mut d.slam_arc, b.slam_arc)] {
                assert!((*x - y).abs() < 1e-5, "{}: {x} vs {y}", a.name());
                *x = y;
            }
            assert_eq!(d, b, "{}: the kit's archetype (left) and Def::base (right) differ", a.name());
        }
    }

    #[test]
    fn a_row_takes_its_archetype_then_its_own_and_waves_name_rows() {
        let mut t = Tables::default();
        t.load(r##"{"enemies":[{"id":"grunt"},{"id":"fast","archetype":"runner","speed":5,"eye":{"color":"#00ff00"}},{"id":"big","archetype":"brute","turn":90}],
            "waves":[{"id":"w1","enemies":[{"type":"grunt","count":3},{"type":"nope","count":2},{"type":"big","count":1}],"reward":true,"next":"timer","time":20}]}"##, &mut forge_core::names::Names::default()).unwrap();
        let r = Roster::load(&t);
        assert_eq!(r.defs[0].arch, Arch::Chaser);
        assert_eq!((r.defs[1].arch, r.defs[1].speed, r.defs[1].scale), (Arch::Runner, 5.0, 1.01));
        assert_eq!(r.defs[1].eye_color, [0.0, 1.0, 0.0]);
        assert!((r.defs[2].turn - std::f32::consts::FRAC_PI_2).abs() < 1e-5 && r.defs[2].windup == 0.8);
        let w = &r.waves[0];
        assert_eq!(w.groups, vec![(0, 3), (2, 1)]);
        assert!(w.reward && w.next == Next::Timer && w.time == 20.0);
        assert_eq!(r.notes.len(), 1, "{:?}", r.notes);
        assert_eq!(r.def(9).arch, Arch::Chaser);
    }
}
