//! The feel view (`feel.view`, last every step): the local player's feel state as `field::COUNT` floats, for the JS
//! host's DOM side (gf/forge/feel.js: the crosshair, ammunition, the red edge, the low-health stages, the combo) and the
//! renderer's viewmodel (track R: the weapon in hand, its kick, sway, bob, reload and swing). forge-web exports it as
//! `feel_view()`; the field numbers are fixed (new ones are added at the end).
use forge_core::components::*;
use forge_core::glam::Vec2;
use forge_core::physics::Mover;
use forge_core::sim::Sim;
use forge_core::STEP;

use crate::controller::Pilot;
use crate::weapons::Arms;

pub mod field {
    /// The weapon drawn: its row (−1: none), its key, rounds in it, its magazine.
    pub const WEAPON: usize = 0;
    pub const SLOT: usize = 1;
    pub const AMMO: usize = 2;
    pub const MAGAZINE: usize = 3;
    /// How far a reload is (0..1; 0 when none) and whether one runs.
    pub const RELOAD: usize = 4;
    pub const RELOADING: usize = 5;
    /// The share of the raise left after a switch (1 → 0).
    pub const RAISE: usize = 6;
    /// A swing: seconds since it started (−1: none), its weapon row (−1: the built-in blade), quick (0/1).
    pub const SWING: usize = 7;
    pub const SWING_ROW: usize = 8;
    pub const SWING_QUICK: usize = 9;
    /// The viewmodel: its snap (a share of the screen height), its sway (radians it lags the look, x and y), its bob (m).
    pub const VIEW_KICK: usize = 10;
    pub const SWAY_X: usize = 11;
    pub const SWAY_Y: usize = 12;
    pub const BOB_X: usize = 13;
    pub const BOB_Y: usize = 14;
    /// The recoil's pitch on the camera, degrees.
    pub const RECOIL: usize = 15;
    /// The red edge tint (0..1), the low-health stage (0-3), health and armour.
    pub const TINT: usize = 16;
    pub const STAGE: usize = 17;
    pub const HEALTH: usize = 18;
    pub const ARMOR: usize = 19;
    /// Stamina (a share), the evade's cooldown left (a share), evading (0/1), the FOV punch (degrees).
    pub const STAMINA: usize = 20;
    pub const EVADE_COOL: usize = 21;
    pub const EVADING: usize = 22;
    pub const FOV: usize = 23;
    /// The combo: kills in it, its multiplier, its timer (a share left).
    pub const COMBO: usize = 24;
    pub const COMBO_MULT: usize = 25;
    pub const COMBO_LEFT: usize = 26;
    pub const DEAD: usize = 27;
    pub const ASSIST: usize = 28;
    /// A charge weapon's charge (a share), the crosshair's spread (degrees, the cone's full width).
    pub const CHARGE: usize = 29;
    pub const SPREAD: usize = 30;
    /// The hurt jitter (m) and the head's offset (m: bob, dips, lift).
    pub const SHAKE: usize = 31;
    pub const HEAD: usize = 32;
    /// The rows held, a bit each (rows 0..23).
    pub const HELD: usize = 33;
    /// Shots fired, the hits and kills the local player made, their best combo.
    pub const SHOTS: usize = 34;
    pub const HITS: usize = 35;
    pub const KILLS: usize = 36;
    pub const BEST_COMBO: usize = 37;
    /// Debris pieces alive.
    pub const DEBRIS: usize = 38;
    /// The local player's id (0: none).
    pub const PLAYER: usize = 39;
    /// Knocked down: the share of the knock left (1 → 0; 0: up). No control while it is over 0.
    pub const DOWN: usize = 40;
    /// Wave 2. Pieces lying at rest (no physics). Down with a friend standing (0/1), the share of the revive done on
    /// this player and who is doing it (a player id); the friend this player is reviving (an id; 0: nobody) and how far.
    pub const RESTING: usize = 41;
    pub const DOWNED: usize = 42;
    pub const REVIVE: usize = 43;
    pub const REVIVER: usize = 44;
    pub const REVIVING: usize = 45;
    pub const REVIVING_SHARE: usize = 46;
    /// Cards held; the reward open (0/1), its seconds left, this player's choice (0 none, 1 choosing, 2 picked, 3 passed).
    pub const CARDS: usize = 47;
    pub const REWARD: usize = 48;
    pub const REWARD_LEFT: usize = 49;
    pub const CHOICE: usize = 50;
    pub const COUNT: usize = 51;
}

#[derive(Clone, Debug)]
pub struct FeelView {
    pub v: [f32; field::COUNT],
}

impl Default for FeelView {
    fn default() -> Self {
        let mut v = [0.0; field::COUNT];
        v[field::WEAPON] = -1.0;
        v[field::SWING] = -1.0;
        Self { v }
    }
}

pub fn feel_view(sim: &mut Sim) {
    // the local player's own values (their cards)
    let cfg = match crate::controller::local(sim) {
        Some(e) => crate::cards::of(sim, e),
        None => crate::cfg(sim),
    };
    let mut v = FeelView::default().v;
    // the local player's hits and kills, counted in place (the log holds the last 256 of each)
    let local = sim.world.query::<&Player>().iter().find(|p| p.local).map(|p| p.id).unwrap_or(0);
    let (hits, kills) = sim.res.get::<crate::hits::Stats>().map(|s| (s.hits.iter().filter(|h| h.by == local).count(), s.kills.iter().filter(|k| k.by == local).count())).unwrap_or((0, 0));
    let debris = crate::kills::alive(sim);
    let walk = cfg.player.walk.max(0.1);
    let resting = crate::kills::resting(sim);
    // who the local player is reviving (the downed friend whose helper they are)
    let helping: Option<(u32, f32)> = sim.world.query::<(&Player, &Pilot)>().iter().find(|(_, x)| x.downed && x.reviver == local && local != 0).map(|(p, x)| (p.id, x.revive));
    let reward = sim.res.get::<crate::cards::Reward>().map(|r| (r.open, r.left, r.choices.get(&local).map(|c| c.state).unwrap_or(0))).unwrap_or((false, 0.0, 0));
    for (p, look, pilot, arms, hp, mv, build, tr, replica) in sim.world.query_mut::<(&Player, &Look, &mut Pilot, Option<&Arms>, Option<&Health>, Option<&Mover>, Option<&crate::cards::Build>, &Transform, Option<&Replica>)>() {
        if !p.local {
            continue;
        }
        v[field::DOWNED] = pilot.downed as u8 as f32;
        v[field::REVIVE] = pilot.revive.clamp(0.0, 1.0);
        v[field::REVIVER] = pilot.reviver as f32;
        v[field::CARDS] = build.map(|b| b.cards.len()).unwrap_or(0) as f32;
        // wave 4: a viewer's local player is the replica it watches (forge-core net.rs). Its look arrives ten times a
        // second: the sway follows the look as the camera draws it, between the samples, or the weapon would twitch
        // at each one
        let look = match replica {
            Some(r) => Look { yaw: forge_core::snapshot::yaw_of_rot(tr.rot), pitch: r.pitch_at(1.0) },
            None => *look,
        };
        // the sway: the viewmodel lags the look a little, and springs back
        let (dy, dp) = match pilot.last_look {
            Some((y, pt)) => (forge_core::wrap(look.yaw - y), look.pitch - pt),
            None => (0.0, 0.0),
        };
        pilot.last_look = Some((look.yaw, look.pitch));
        let target = Vec2::new((dy * 3.0).clamp(-0.09, 0.09), (-dp * 3.0).clamp(-0.07, 0.07));
        let w = 30.0f32;
        let acc = (target - pilot.sway) * w * w - pilot.sway_v * 2.0 * w * 0.8;
        pilot.sway_v += acc * STEP;
        pilot.sway += pilot.sway_v * STEP;
        v[field::PLAYER] = p.id as f32;
        v[field::SWAY_X] = pilot.sway.x;
        v[field::SWAY_Y] = pilot.sway.y;
        let speed = match replica {
            Some(r) => Vec2::new(r.vel.x, r.vel.z).length(),
            None => mv.map(|m| Vec2::new(m.moved.x, m.moved.z).length() / STEP).unwrap_or(0.0),
        };
        let k = (speed / walk).min(1.2) * if mv.is_some_and(|m| m.grounded) { 1.0 } else { 0.0 };
        v[field::BOB_X] = 0.008 * k * (pilot.bob_phase * 0.5).sin();
        v[field::BOB_Y] = 0.005 * k * pilot.bob_phase.sin().abs();
        v[field::TINT] = pilot.tint;
        v[field::STAGE] = pilot.stage as f32;
        v[field::STAMINA] = if cfg.moves.stamina.max > 0.0 { pilot.stamina / cfg.moves.stamina.max } else { 1.0 };
        v[field::EVADE_COOL] = if cfg.moves.evade.cooldown > 0.0 { pilot.evade_cool / cfg.moves.evade.cooldown } else { 0.0 };
        v[field::EVADING] = pilot.evading(cfg.moves.evade.time) as u8 as f32;
        v[field::FOV] = pilot.fov;
        v[field::COMBO] = pilot.combo as f32;
        v[field::COMBO_MULT] = pilot.combo_mult;
        v[field::COMBO_LEFT] = if cfg.feel.combo_window > 0.0 { pilot.combo_left / cfg.feel.combo_window } else { 0.0 };
        v[field::BEST_COMBO] = pilot.best_combo as f32;
        v[field::DEAD] = pilot.dead as u8 as f32;
        v[field::DOWN] = if pilot.down > 0.0 && pilot.down_total > 0.0 { pilot.down / pilot.down_total } else { 0.0 };
        v[field::ASSIST] = pilot.assist as u8 as f32;
        v[field::SHAKE] = pilot.shake.length();
        v[field::HEAD] = pilot.head.y;
        if let Some(h) = hp {
            v[field::HEALTH] = h.fraction();
            v[field::ARMOR] = h.armor;
        }
        if let Some(a) = arms {
            v[field::RECOIL] = a.recoil.x.to_degrees();
            v[field::VIEW_KICK] = a.view_kick;
            let mut held = 0u32;
            for &r in a.held.iter().filter(|&&r| r < 24) {
                held |= 1 << r;
            }
            v[field::HELD] = held as f32;
            v[field::SHOTS] = a.shots as f32;
            if let Some(r) = a.current.filter(|r| *r < cfg.weapons.len()) {
                let d = &cfg.weapons[r];
                v[field::WEAPON] = r as f32;
                v[field::SLOT] = d.slot as f32;
                // (the rounds in a watched replica's weapon are the host's alone: none known, and the HUD shows the
                // weapon's name without a count)
                if replica.is_none() {
                    v[field::AMMO] = a.ammo_of(r) as f32;
                    v[field::MAGAZINE] = d.magazine as f32;
                }
                v[field::SPREAD] = d.spread.to_degrees();
                if d.kind == crate::weapon_defs::Kind::Charge && a.charge >= 0.0 {
                    v[field::CHARGE] = (a.charge / d.interval.max(1e-3)).min(1.0);
                }
            }
            if a.reload_left > 0.0 {
                v[field::RELOADING] = 1.0;
                v[field::RELOAD] = 1.0 - a.reload_left / a.reload_total.max(1e-3);
            }
            if a.raise_total > 0.0 {
                v[field::RAISE] = a.raise_left / a.raise_total;
            }
            if let Some(s) = a.swing {
                v[field::SWING] = s.t;
                v[field::SWING_ROW] = s.row.map(|r| r as f32).unwrap_or(-1.0);
                v[field::SWING_QUICK] = s.quick as u8 as f32;
            }
        }
        v[field::HITS] = hits as f32;
        v[field::KILLS] = kills as f32;
    }
    v[field::DEBRIS] = debris as f32;
    v[field::RESTING] = resting as f32;
    if let Some((id, share)) = helping {
        v[field::REVIVING] = id as f32;
        v[field::REVIVING_SHARE] = share.clamp(0.0, 1.0);
    }
    v[field::REWARD] = reward.0 as u8 as f32;
    v[field::REWARD_LEFT] = reward.1;
    v[field::CHOICE] = reward.2 as f32;
    sim.res.insert(FeelView { v });
}

/// The view's field names, in order (for JS and the fixtures).
pub const NAMES: [&str; field::COUNT] = [
    "weapon", "slot", "ammo", "magazine", "reload", "reloading", "raise", "swing", "swingRow", "swingQuick", "viewKick", "swayX", "swayY", "bobX", "bobY", "recoil", "tint", "stage", "health", "armor", "stamina", "evadeCool", "evading", "fov", "combo", "comboMult", "comboLeft", "dead", "assist", "charge", "spread", "shake", "head", "held", "shots", "hits", "kills", "bestCombo", "debris", "player", "down", "resting", "downed", "revive", "reviver", "reviving", "revivingShare", "cards", "reward", "rewardLeft", "choice",
];

/// The stats verify and the fixtures read, as JSON: {shots, hits: [{t, by, target, damage, crit, part}], kills: [{t,
/// by, target, kind, type, hits}], debris, culled}.
pub fn stats_json(sim: &Sim) -> String {
    use forge_core::serde_json::json;
    let s = sim.res.get::<crate::hits::Stats>().cloned().unwrap_or_default();
    let q = sim.res.get::<crate::kills::DebrisQueue>();
    let shots: u32 = sim.world.query::<&Arms>().iter().map(|a| a.shots).sum();
    let r3 = |x: f64| (x * 1000.0).round() / 1000.0;
    let v = json!({
        "shots": shots,
        "hits": s.hits.iter().map(|h| json!({ "t": r3(h.t), "by": h.by, "target": h.target, "damage": (h.damage * 100.0).round() / 100.0, "crit": h.crit, "part": Part::from_u8(h.part).name() })).collect::<Vec<_>>(),
        "kills": s.kills.iter().map(|k| json!({ "t": r3(k.t), "by": k.by, "target": k.target, "kind": k.kind, "type": k.type_, "hits": k.hits })).collect::<Vec<_>>(),
        "debris": crate::kills::alive(sim),
        "fading": crate::kills::fading(sim),
        "culled": q.map(|q| q.culled).unwrap_or(0),
        "resting": crate::kills::resting(sim),
        "rested": sim.res.get::<crate::kills::RestQueue>().map(|q| q.rested).unwrap_or(0),
        "faded": sim.res.get::<crate::kills::RestQueue>().map(|q| q.faded).unwrap_or(0),
    });
    forge_core::serde_json::to_string(&v).unwrap_or_default()
}
