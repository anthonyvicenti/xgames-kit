//! The wave 1b integration's per-frame glue between the tracks (research/gf-forge/INTEGRATION.md): what forge-feel
//! (F), forge-ai (A) and forge-core's co-op (S) hold that the renderer (R) draws, where no track's own interface
//! reached the other's. `render::before_frame` calls in here; nothing in this file simulates.
//!
//! | What | From | To |
//! |---|---|---|
//! | the enemies' eyes | A's AI view (`forge_ai::view`: colour × intensity per enemy, every step: rest, the tell's ramp, white on a hit, 0 dead) | R's per-actor glow (`ActorFx::glow`: A filled a view, R waited for `R_GLOW` events) |
//! | a caster's orb | A's AI view (its light) and its entity | a moving light, and the orb's model (`CLASS_ORB`) |
//! | a hit's flash | F's `ev::FLASH` (its colour and seconds from the feel table) | R's per-actor flash (R flashes on HIT by itself; F's values win) |
//! | the weapon in hand | F's feel view (the row, kick, sway, bob, reload, raise, swing) | R's first-person layer (`Scene::fp`: F drew a stand-in, R waited for `R_VIEWMODEL` events) |
//! | the muzzle flash and smoke | F's LIGHT (source: the local player) and the PARTICLES at its place | the first-person weapon's `socket_muzzle`: the gun's hidden `flash_muzzle` node for 3 frames, the sparks and smoke born there |
//! | debris, coins, pickups | F's entities (kind DEBRIS by piece type, COIN, PICKUP by weapon row) | rigid models at their places (`Glue::entity_models`: nobody drew them) |
//! | friends' bodies | S's `Wear` (tint, hidden) | R's cloth colour; a hidden body is not drawn |
//! | a shot's streak | F's `ev::TRACER` (from, to, colour, seconds, width, source: a hitscan round, each pellet, a beam) | R's tracers (`Scene::add_tracer`), the local player's from the first-person weapon's muzzle (wave 2, track L1) |
//! | a round in flight | F's `Shot` entities (a pistol's round, a charged one: each copy's own) | a streak behind each, in its weapon row's tracer colour |
//!
//! Wave 2 (track L1) also keeps its own exports here (`#[wasm_bindgen] impl Forge` below, wrapped by kit/render.js):
//! a model's surface (a tiling picture, its texel density, an emissive map), the backdrop layer, a tracer from JS,
//! the renderer's later stats, and a QA call that lays loose pieces at rest.
use forge_core::components::*;
use forge_core::events::Event;
use forge_core::glam::{EulerRot, Mat4, Quat, Vec3};
use forge_core::sim::Animated;
use forge_core::views;
use forge_core::Core;
use forge_feel::view::field as fv;
use forge_render::actors::{Glue, ANY_TYPE, CLASS_ORB};
use forge_render::particles::kind_of;
use forge_render::{Attached, PointLight, Scene, Surface};
use wasm_bindgen::prelude::*;

use crate::Forge;

/// Seconds a gun's hidden `flash_muzzle` node shows after a shot (3 frames at 60: the art's "2–4 frames a shot").
pub const MUZZLE_SHOWN: f32 = 0.05;
/// A tracer that lasts longer than this is a beam held on its line (forge-feel gives a hitscan round 0.05 s and a
/// beam one and a half fire intervals): drawn whole and fading, not as a streak crossing it.
const BEAM_SECONDS: f32 = 0.06;
/// Where forge-feel's shots leave from (its `weapons::muzzle`): how near a PARTICLES event must be to the local
/// player's muzzle LIGHT of the same tick to be that shot's sparks.
const SAME_PLACE: f32 = 0.02;

/// Before the actors are built: the AI view's eyes onto each enemy's glow (the colour × the intensity A computed this
/// step; a replica's from the host's state byte).
pub(crate) fn before_actors(core: &Core, glue: &mut Glue) {
    use forge_ai::view::{field, AiView, CAPACITY};
    let Some(v) = core.sim.res.get::<AiView>() else { return };
    if v.rows.len() < forge_ai::view::FIELDS * CAPACITY {
        return;
    }
    let at = |f: usize, i: usize| v.rows[f * CAPACITY + i];
    for i in 0..v.count.min(CAPACITY) {
        if at(field::KIND, i) as u8 != kind::ENEMY {
            continue;
        }
        let k = at(field::EYE_I, i).max(0.0);
        let c = [at(field::EYE_R, i) * k, at(field::EYE_G, i) * k, at(field::EYE_B, i) * k];
        let fx = glue.fx.entry(at(field::NET, i) as u32).or_default();
        fx.glow = Some((c, c, 0.0, 0.0));
        // wave 7: an elite's modifier, read at a glance: its rim of light and its body's tint (a split one's young:
        // the splitting rim at half, its own colours); fading out with the body as it dies
        let mark = at(field::ELITE, i) as u8;
        if mark != 0
            && let Some(r) = core.sim.res.get::<forge_ai::Roster>()
        {
            let child = mark & forge_ai::elite::CHILD != 0;
            let m = if child { forge_ai::elite::Mod::Splitting } else { forge_ai::elite::Mod::from_u8(mark) };
            if let Some(l) = r.elites.look(m) {
                let alive = if at(field::STATE, i) as u8 == forge_ai::State::Dead as u8 { 0.0 } else { 1.0 };
                fx.rim = Some([l.color[0], l.color[1], l.color[2], l.glow * alive * if child { 0.5 } else { 1.0 }]);
                if !child && l.tint != [1.0, 1.0, 1.0] {
                    fx.tint = Some([l.tint[0], l.tint[1], l.tint[2], 1.0]);
                }
            }
        }
    }
}

/// Wave 7: what an elite gives off beyond its rim, each frame: a burning one embers rising off it and a small light of
/// its colour (so it reads at night across the street), a fast one a pale wisp trailing it. Each copy draws its own
/// from the AI view (a joiner's from the host's snapshot mark).
pub(crate) fn elite_fx(core: &Core, scene: &mut Scene, dt: f32) {
    use forge_ai::elite::Mod;
    use forge_ai::view::{field, AiView, CAPACITY};
    let Some(v) = core.sim.res.get::<AiView>() else { return };
    if v.rows.len() < forge_ai::view::FIELDS * CAPACITY {
        return;
    }
    let Some(r) = core.sim.res.get::<forge_ai::Roster>() else { return };
    let alpha = core.views.camera[views::camera::ALPHA];
    let at = |f: usize, i: usize| v.rows[f * CAPACITY + i];
    let (budget, eye) = (scene.look.particle_budget as usize, scene.camera.eye);
    for i in 0..v.count.min(CAPACITY) {
        let mark = at(field::ELITE, i) as u8;
        if mark == 0 || mark & forge_ai::elite::CHILD != 0 || at(field::KIND, i) as u8 != kind::ENEMY || at(field::STATE, i) as u8 == forge_ai::State::Dead as u8 {
            continue;
        }
        let net = at(field::NET, i) as u32;
        let Some(e) = core.sim.entity_of(net) else { continue };
        let Ok(t) = core.sim.world.get::<&Transform>(e) else { continue };
        let (pos, _) = t.interpolated(alpha);
        let s = t.scale.max(0.3);
        let key = 40_000 + net as u64;
        match Mod::from_u8(mark) {
            Mod::Burning => {
                if dt > 0.0 {
                    scene.particles.emit(&scene.look.kinds, key, forge_render::particles::EMBERS, 14.0, dt, pos + Vec3::Y * (1.0 * s), Vec3::new(0.22 * s, 0.5 * s, 0.22 * s), budget, eye);
                }
                if let Some(l) = r.elites.look(Mod::Burning) {
                    let flick = 0.85 + 0.15 * (scene.time * 13.0 + net as f32).sin();
                    scene.moving_lights.push(PointLight { pos: (pos + Vec3::Y * (1.2 * s)).to_array(), range: 2.6, color: l.color, intensity: 0.8 * flick });
                }
            }
            Mod::Fast if dt > 0.0 => {
                scene.particles.emit(&scene.look.kinds, key, forge_render::particles::SMOKE, 9.0, dt, pos + Vec3::Y * (1.1 * s), Vec3::new(0.2, 0.45, 0.2), budget, eye);
            }
            _ => {}
        }
    }
}

/// The cloth colour and whether to draw a body, from what it wears (S's `Wear`): None: not drawn on this copy.
pub(crate) fn worn(wear: Option<&Wear>) -> Option<Option<[f32; 3]>> {
    match wear {
        Some(w) if w.hidden => None,
        Some(w) => Some(Some(w.tint)),
        None => Some(None),
    }
}

/// One event of the last tick, for what R's own handling does not cover. `lights`: the local player's muzzle lights of
/// this tick so far (their places).
///
/// Wave 4, a viewer's copy (`watching`): its local player is the replica it watches (forge-core net.rs), and that
/// player's shot is the host's event, not this copy's own: the light and the sparks whose source is that player are
/// the first-person weapon's all the same (a moment late, so the eye may have moved a step further from them), and a
/// hit it lands draws the streak its own copy drew (forge-feel's TRACER is each copy's own and never in a snapshot).
#[allow(clippy::too_many_arguments)]
pub(crate) fn on_event(core: &Core, scene: &mut Scene, glue: &mut Glue, e: &Event, remote: bool, aspect: f32, local: u32, lights: &mut Vec<Vec3>, watching: bool) -> bool {
    let mine = !remote || watching;
    let reach = if watching { 2.0 } else { 1.0 };
    match e {
        // forge-feel's hit flash: its own colour and time, over the renderer's HIT flash
        Event::Custom { kind, words } if *kind == forge_feel::ev::FLASH => {
            let f = |i: usize| f32::from_bits(words[i]);
            if f(1) > 0.0 {
                glue.fx.entry(words[0]).or_default().start_flash([f(2), f(3), f(4)], 1.0, f(1));
                // (counted once a hit: the renderer's own HIT flash counts it when the look has one)
                if scene.look.hit_amount <= 0.0 {
                    glue.seen[1] += 1;
                }
            }
            true
        }
        // the local player's shot: its muzzle light marks the tick's muzzle; the gun's flash shows
        // (a swing's own light is its contact's, not a muzzle's: a blade and the quick melee flash nothing)
        Event::Light(l) if mine && local != 0 && l.source == local && near_eye(scene, l.pos, 1.6 * reach) && !swinging(core) => {
            lights.push(l.pos);
            if scene.fp.visible && scene.fp.weapon.is_some() {
                scene.fp.muzzle_left = MUZZLE_SHOWN;
                glue.seen[0] += 1;
                glue.smoke_until = scene.time + 0.45;
                // a weapon with no flash of its own gets the flash picture at its muzzle
                let has_flash = scene.fp.weapon.and_then(|w| scene.models.get(w.model)).is_some_and(|m| m.prims.iter().any(|p| p.hidden.is_some()));
                if !has_flash
                    && let (Some(c), Some(k)) = (scene.fp_rig().muzzle, kind_of("muzzle"))
                {
                    let at = scene.fp_to_world(c, aspect);
                    let (kinds, budget, eye) = (scene.look.kinds.clone(), scene.look.particle_budget as usize, scene.camera.eye);
                    scene.particles.burst(&kinds, k, 1, at, scene.camera.dir(), 0.0, 0.0, budget, eye);
                }
            }
            false
        }
        // the sparks at that muzzle, and the barrel smoke a moment later: born at the first-person weapon's muzzle,
        // where it shows on screen (forge-feel places them about 1 m in front of the eyes, where a body's would be)
        Event::Particles(p) if mine && scene.fp.visible => {
            let name = core.sim.names.get(p.name);
            let muzzle = lights.iter().any(|l| l.distance(p.pos) < SAME_PLACE);
            let smoke = name == "smoke" && scene.time <= glue.smoke_until && near_eye(scene, p.pos, 2.5 * reach);
            if !(muzzle || smoke) {
                return false;
            }
            let (Some(c), Some(k)) = (scene.fp_rig().muzzle, kind_of(name)) else { return false };
            let at = scene.fp_to_world(c, aspect);
            let dir = if p.dir.length_squared() > 1e-8 { p.dir } else { scene.camera.dir() };
            let (kinds, budget, eye) = (scene.look.kinds.clone(), scene.look.particle_budget as usize, scene.camera.eye);
            scene.particles.burst(&kinds, k, p.count, at, dir, p.speed, p.spread, budget, eye);
            true
        }
        // forge-feel's streak (a hitscan round, each pellet of a scattergun, a beam): the local player's leaves the
        // first-person weapon's muzzle where it shows on screen, anyone else's the place the event says
        Event::Custom { kind, words } if *kind == forge_feel::ev::TRACER => {
            let f = |i: usize| f32::from_bits(words[i]);
            let (mut from, to) = (Vec3::new(f(0), f(1), f(2)), Vec3::new(f(3), f(4), f(5)));
            if !(from.is_finite() && to.is_finite()) {
                return true;
            }
            if !remote
                && local != 0
                && words[11] == local
                && scene.fp.visible
                && let Some(c) = scene.fp_rig().muzzle
            {
                from = scene.fp_to_world(c, aspect);
            }
            scene.add_tracer(from, to, [f(6).max(0.0), f(7).max(0.0), f(8).max(0.0)], f(10).max(0.0), f(9).max(0.0), f(9) > BEAM_SECONDS);
            glue.tracers_seen += 1;
            true
        }
        // a viewer: the watched player's hit, with the streak its own copy drew from the muzzle to it (a round, each
        // target of a scattergun's pellets; not a swing's contact). A shot that hits nothing leaves no streak here.
        Event::Hit(h) if watching && remote && local != 0 && h.attacker == local && scene.fp.visible && !swinging(core) => {
            let row = core.sim.res.get::<forge_feel::view::FeelView>().map(|v| v.v[fv::WEAPON]).filter(|r| *r >= 0.0).map(|r| r as usize);
            let cfg = forge_feel::cfg(&core.sim);
            if let (Some(c), Some(d)) = (scene.fp_rig().muzzle, row.and_then(|r| cfg.weapons.get(r)))
                && d.kind != forge_feel::weapon_defs::Kind::Melee
                && h.point.is_finite()
            {
                let from = scene.fp_to_world(c, aspect);
                scene.add_tracer(from, h.point, d.tracer, 0.02, 0.05, false);
                glue.tracers_seen += 1;
            }
            false
        }
        // gone: nothing hangs on it, nothing remembers its look
        Event::Despawn(d) => {
            glue.attach.retain(|a| a.owner != d.id);
            glue.fx.remove(&d.id);
            glue.rounds.remove(&d.id);
            false
        }
        _ => false,
    }
}

/// Whether the local player is in a swing (the blade in hand, or the quick melee).
fn swinging(core: &Core) -> bool {
    core.sim.res.get::<forge_feel::view::FeelView>().is_some_and(|v| v.v[fv::SWING] >= 0.0)
}

fn near_eye(scene: &Scene, p: Vec3, within: f32) -> bool {
    p.distance(scene.camera.eye) <= within
}

/// The local player's core id (0: none), from the feel view.
pub(crate) fn local_player(core: &Core) -> u32 {
    core.sim.res.get::<forge_feel::view::FeelView>().map(|v| v.v[fv::PLAYER] as u32).unwrap_or(0)
}

/// After the actors and attachments are built: rigid entities (debris, coins, pickups, orbs), the orbs' lights, and
/// the first-person layer from the feel view.
pub(crate) fn after_actors(core: &Core, scene: &mut Scene, glue: &mut Glue, dt: f32, core_camera: bool) {
    let alpha = core.views.camera[views::camera::ALPHA];
    let time = scene.time;
    // ---- rigid entities by class ----
    scene.moving_lights.clear();
    // from here on `attached` holds loose pieces (the look's `pieces.*`: how far one is drawn and casts a shadow)
    scene.pieces_from = Some(scene.attached.len());
    if !glue.entity_models.is_empty() {
        for (net, k, t, local) in core.sim.world.query::<(&NetId, &Kind, &Transform, Option<&Local>)>().without::<&Animated>().without::<&Player>().iter() {
            let class = if k.kind == kind::PROJECTILE && local.is_none() { CLASS_ORB } else { k.kind };
            let Some(m) = glue.entity_models.get(&(class, k.type_)).or_else(|| glue.entity_models.get(&(class, ANY_TYPE))) else { continue };
            let (pos, rot) = t.interpolated(alpha);
            let seed = net.0 as f32 * 1.7;
            let place = if m.spin != 0.0 || m.bob != 0.0 {
                Mat4::from_rotation_translation(Quat::from_rotation_y(time * m.spin + seed), pos + Vec3::Y * (m.bob * (time * 2.4 + seed).sin()))
            } else {
                Mat4::from_rotation_translation(rot, pos)
            };
            scene.attached.push(Attached { id: net.0, model: m.model, slot: m.slot, transform: place * Mat4::from_scale(Vec3::splat(t.scale)) * m.fit, tint: [1.0; 4], flash: [0.0; 4], visible: true });
        }
    }
    // ---- a caster's orb lights the scene as it flies (A's AI view: its colour, intensity and radius) ----
    if let Some(v) = core.sim.res.get::<forge_ai::view::AiView>() {
        use forge_ai::view::{field, CAPACITY};
        if v.rows.len() >= forge_ai::view::FIELDS * CAPACITY {
            let at = |f: usize, i: usize| v.rows[f * CAPACITY + i];
            for i in 0..v.count.min(CAPACITY) {
                if at(field::KIND, i) as u8 != kind::PROJECTILE || at(field::LIGHT, i) <= 0.0 {
                    continue;
                }
                let Some(e) = core.sim.entity_of(at(field::NET, i) as u32) else { continue };
                let Ok(t) = core.sim.world.get::<&Transform>(e) else { continue };
                let (pos, _) = t.interpolated(alpha);
                scene.moving_lights.push(PointLight { pos: pos.to_array(), range: at(field::LIGHT, i), color: [at(field::EYE_R, i), at(field::EYE_G, i), at(field::EYE_B, i)], intensity: at(field::EYE_I, i) });
            }
        }
    }
    // ---- wave 7: what elites give off (embers and a light off a burning one, a wisp behind a fast one) ----
    elite_fx(core, scene, dt);
    // ---- rounds in flight (forge-feel's `Shot`: a pistol's round, a charged one): a streak behind each ----
    rounds_in_flight(core, scene, glue, alpha);
    scene.advance_tracers(dt);
    // ---- the first-person layer from the feel view ----
    scene.fp.muzzle_left = (scene.fp.muzzle_left - dt).max(0.0);
    if glue.fp_manual || !core_camera {
        return;
    }
    let Some(v) = core.sim.res.get::<forge_feel::view::FeelView>().map(|v| v.v) else { return };
    if v[fv::PLAYER] <= 0.0 {
        return;
    }
    let row = v[fv::WEAPON];
    let weapon = if row >= 0.0 { glue.fp_weapons.get(row as usize).copied().flatten() } else { None };
    scene.fp.weapon = weapon;
    scene.fp.visible = v[fv::DEAD] < 0.5 && weapon.is_some();
    scene.fp.swing = None;
    if !scene.fp.visible {
        return;
    }
    let fov = if scene.fp.fov > 1.0 { scene.fp.fov } else { scene.look.fp_fov };
    let depth = weapon.map(|w| w.hold.z.abs()).unwrap_or(0.34).max(0.15);
    // the viewmodel's snap is a share of the screen height (feel target 8: about 10% for the scattergun, back in 0.1 s)
    let screen = 2.0 * depth * (fov.to_radians() * 0.5).tan();
    let kick = v[fv::VIEW_KICK];
    let reload = if v[fv::RELOADING] > 0.5 { (std::f32::consts::PI * v[fv::RELOAD]).sin() } else { 0.0 };
    let raise = v[fv::RAISE];
    let down = v[fv::DOWN];
    let swing_t = v[fv::SWING];
    let quick = v[fv::SWING_QUICK] > 0.5;
    let swinging = swing_t >= 0.0;
    if swinging && !glue.swinging {
        glue.seen[2] += 1;
    }
    glue.swinging = swinging;
    // lowered while a quick melee swings over it, while it is raised after a switch, through a reload, when knocked down
    let low = (if swinging && quick { 0.07 } else { 0.0 }) + raise * 0.22 + reload * 0.09 + down * 0.25;
    let mut at = Vec3::new(v[fv::SWAY_X] * 0.35 + v[fv::BOB_X], kick * screen - v[fv::SWAY_Y] * 0.35 + v[fv::BOB_Y] - low, kick * 0.12);
    let (mut pitch, mut yaw, mut roll) = (kick * 1.1 - reload * 0.8 - raise * 0.5, v[fv::SWAY_X] * 0.8, reload * 0.55);
    if swinging && !quick {
        // the weapon in hand is the one swung (moment 11's shape: raised through the windup, down and across at the
        // contact about 0.16 s in, then back)
        let (a, b, c) = swing_curve(swing_t);
        at += Vec3::new(-0.16 * b, 0.10 * a - 0.20 * b, -0.10 * b) * (1.0 - c);
        pitch += (0.55 * a - 1.25 * b) * (1.0 - c);
        yaw += 0.5 * b * (1.0 - c);
        roll += 0.6 * b * (1.0 - c);
    }
    scene.fp.pose = Mat4::from_translation(at) * Mat4::from_euler(EulerRot::YXZ, yaw, pitch, roll);
    if swinging && quick {
        // the quick melee: its weapon comes in from the lower right over the gun, is held raised, and swings down across
        let row = v[fv::SWING_ROW];
        let w = if row >= 0.0 { glue.fp_weapons.get(row as usize).copied().flatten() } else { glue.fp_blade };
        if let Some(w) = w {
            let (a, b, c) = swing_curve(swing_t);
            let p = Vec3::new(0.30 - 0.36 * b, -0.42 + 0.30 * a - 0.12 * b - 0.3 * c, -0.42);
            let m = Mat4::from_translation(p) * Mat4::from_euler(EulerRot::YXZ, std::f32::consts::PI + 0.45 - 0.8 * b, -(0.8 - 1.7 * b), -0.35 + 0.7 * b);
            scene.fp.swing = Some((w, m));
        }
    }
}

/// Every round in flight on this copy as a streak: from where it is back toward where it left (the first-person
/// weapon's muzzle as it shows on screen for the local player's own, else a little behind where it was first seen),
/// at most the look's `tracer.length` long, in its weapon row's tracer colour.
fn rounds_in_flight(core: &Core, scene: &mut Scene, glue: &mut Glue, alpha: f32) {
    use forge_feel::weapons::Shot;
    scene.streaks.clear();
    let local = local_player(core);
    let cfg = forge_feel::cfg(&core.sim);
    let (w, h) = (scene.look.tracer_length, scene.look.tracer_width);
    let mut live: Vec<u32> = Vec::new();
    for (net, t, v, shot) in core.sim.world.query::<(&NetId, &Transform, &Velocity, &Shot)>().iter() {
        let (pos, _) = t.interpolated(alpha);
        let dir = v.linear.normalize_or_zero();
        if dir == Vec3::ZERO {
            continue;
        }
        live.push(net.0);
        if !glue.rounds.contains_key(&net.0) {
            glue.tracers_seen += 1;
        }
        let origin = *glue.rounds.entry(net.0).or_insert_with(|| {
            if local != 0 && shot.owner == local && scene.fp.visible && near_eye(scene, pos, 4.0) {
                if let Some(c) = scene.fp_rig().muzzle {
                    return scene.fp_to_world(c, if scene.aspect > 0.0 { scene.aspect } else { 16.0 / 9.0 });
                }
            }
            pos - dir * 0.6
        });
        let back = origin - pos;
        let len = back.length();
        if len < 0.05 {
            continue;
        }
        let color = cfg.weapons.get(shot.row).map(|d| d.tracer).unwrap_or([1.0, 0.33, 0.05]);
        scene.streaks.push((pos + back / len * len.min(w), pos, color, h.max(0.02)));
    }
    glue.rounds.retain(|id, _| live.contains(id));
}

/// A swing's three parts by its seconds: in (0..1 by 45 ms), across (0..1 from 0.1 s over 80 ms), away (from 0.18 s).
fn swing_curve(t: f32) -> (f32, f32, f32) {
    ((t / 0.045).clamp(0.0, 1.0), ((t - 0.1) / 0.08).clamp(0.0, 1.0), ((t - 0.18) / 0.25).clamp(0.0, 1.0))
}

// ---- wave 2 (track L1): the renderer's exports beside render.rs's ----

#[wasm_bindgen]
impl Forge {
    /// How a model's picture lies on it (kit/render.js `surface`): `tile` metres to one repeat (0: unknown, the
    /// mesh's own UVs are measured), laid in world space or by the mesh's UVs, `density` texels a metre for the retro
    /// look (0: the look's), and an emissive picture (`emissive_tex` < 0: none) with its linear colour × strength.
    /// The picture itself is the model's own or `set_model_texture`'s. `tile` < 0 takes the surface off.
    #[allow(clippy::too_many_arguments)]
    pub fn model_surface(&self, model: u32, tile: f32, world: bool, density: f32, emissive_tex: i32, er: f32, eg: f32, eb: f32) -> bool {
        let mut s = self.s.borrow_mut();
        let n = s.gfx.scene.textures.len();
        let Some(m) = s.gfx.scene.models.get_mut(model as usize) else { return false };
        if !(tile.is_finite() && density.is_finite()) || tile < 0.0 {
            m.surface = None;
            return true;
        }
        let emissive_tex = if emissive_tex >= 0 && (emissive_tex as usize) < n { Some(emissive_tex as usize) } else { None };
        m.surface = Some(Surface { tile, world, density: density.max(0.0), emissive_tex, emissive: [er.max(0.0), eg.max(0.0), eb.max(0.0)] });
        true
    }

    /// Put a static instance in the backdrop layer or take it out (kit/render.js `backdrop`): no shadow, the moon and
    /// the ambient light only, thicker fog, not drawn past the look's `backdrop.distance`.
    pub fn instance_backdrop(&self, i: u32, on: bool) -> bool {
        match self.s.borrow_mut().gfx.scene.instances.get_mut(i as usize) {
            Some(x) => {
                x.backdrop = on;
                true
            }
            None => false,
        }
    }

    /// A streak from JS (kit/render.js `tracer`): from and to (x y z each), a linear colour, its width (m), the
    /// seconds it shows at least, and whether it is a beam (the whole line, fading).
    pub fn fx_tracer(&self, from: &[f32], to: &[f32], color: &[f32], width: f32, seconds: f32, beam: bool) {
        let v = |a: &[f32]| Vec3::new(a.first().copied().unwrap_or(0.0), a.get(1).copied().unwrap_or(0.0), a.get(2).copied().unwrap_or(0.0));
        let c = v(color);
        let mut s = self.s.borrow_mut();
        s.gfx.scene.add_tracer(v(from), v(to), [c.x.max(0.0), c.y.max(0.0), c.z.max(0.0)], width.max(0.0), seconds.max(0.0), beam);
        s.gfx.glue.tracers_seen += 1;
    }

    /// The last frame, after `render_stats`: streaks drawn, items left out of the main pass (off screen or past their
    /// layer's distance), instances in the moon's shadow pass, fire shadow faces drawn, fires casting, loose pieces
    /// (rigid entities) given to the renderer, backdrop instances; then counted since the page loaded: tracers begun.
    pub fn render_stats_more(&self) -> Vec<f32> {
        let s = self.s.borrow();
        let x = s.gfx.stats;
        let sc = &s.gfx.scene;
        let pieces = sc.pieces_from.map(|from| sc.attached.len().saturating_sub(from)).unwrap_or(0);
        vec![x.tracers as f32, x.culled as f32, x.casters as f32, x.fire_faces as f32, x.fire_casters as f32, pieces as f32, sc.instances.iter().filter(|i| i.backdrop && i.visible).count() as f32, s.gfx.glue.tracers_seen as f32]
    }

    /// QA (the lookdev's and the budget's "pieces at rest"): lay `count` loose debris pieces at rest on the ground in
    /// a disc of `radius` metres round (x, z), as a kill leaves them once they stop (each copy's own, no physics
    /// body: only what the renderer is given). 0 takes them away again. → how many lie there.
    pub fn debug_pieces(&self, count: u32, x: f32, z: f32, radius: f32) -> u32 {
        let mut s = self.s.borrow_mut();
        let st = &mut *s;
        for net in st.gfx.glue.debug_pieces.drain(..) {
            if let Some(e) = st.core.sim.entity_of(net) {
                st.core.sim.despawn_now(e);
            }
        }
        // a kill's mix (forge-feel kills.rs): a skull and a ribcage among long bones, short bones and chips
        let mut seed = 0x9E37_79B9u32;
        let mut rnd = move || {
            seed ^= seed << 13;
            seed ^= seed >> 17;
            seed ^= seed << 5;
            (seed >> 8) as f32 / (1u32 << 24) as f32
        };
        for k in 0..count.min(4000) {
            let type_ = match k % 48 {
                0 => forge_feel::piece::SKULL,
                1 => forge_feel::piece::RIBCAGE,
                n if n % 3 == 0 => forge_feel::piece::BONE,
                n if n % 3 == 1 => forge_feel::piece::SHORT_BONE,
                _ => forge_feel::piece::CHIP,
            };
            let (a, r) = (rnd() * std::f32::consts::TAU, radius.max(0.1) * rnd().sqrt());
            let pos = Vec3::new(x + a.cos() * r, 0.04, z + a.sin() * r);
            let e = st.core.sim.spawn_local(kind::DEBRIS, type_, pos, rnd() * std::f32::consts::TAU);
            if let Ok(mut t) = st.core.sim.world.get::<&mut Transform>(e) {
                t.rot = Quat::from_euler(EulerRot::YXZ, rnd() * std::f32::consts::TAU, (rnd() - 0.5) * 0.6, (rnd() - 0.5) * 0.6);
                t.prev_rot = t.rot;
            }
            let net = st.core.sim.net_of(e);
            if net != 0 {
                st.gfx.glue.debug_pieces.push(net);
            }
        }
        st.gfx.glue.debug_pieces.len() as u32
    }
}
