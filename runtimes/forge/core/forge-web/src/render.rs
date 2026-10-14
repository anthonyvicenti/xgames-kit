//! Track R's exports (research/gf-forge/core/ARCHITECTURE.md "Rendering"): what `gf/forge/render.js` calls, and the
//! glue that turns the core's state into the renderer's scene every frame (`before_frame`, called from `render`).
//!
//! Every frame, before drawing:
//! - **Events** of the last tick (once per tick): LIGHT → a flash light (its frames at 60 a second), PARTICLES → a burst
//!   (the name is a kind or an alias), HIT → the target's white body flash (the look's `hit.*`), KILL → its eyes go out,
//!   and track R's own events (kinds 56..=63, `R_*` below) that tracks F and A emit from Rust.
//! - **Actors:** every animated core entity whose body has a model (`add_body`) is drawn GPU-skinned from the core's
//!   bone palette, at its interpolated place (turned to face where the entity faces), with its flash, glow, tint and
//!   cloth colour; the local player's own body is not drawn while the camera is its eyes. Then the puppets (posed by
//!   the renderer) and every rigid model on a socket (`attach`).
//! - **Emitters:** embers and smoke over every fire light the host sets, ash around the eye; particles and flashes age.
//! - **First person:** the viewmodel from the last R_VIEWMODEL event or the host's `fp_*` calls.
use forge_core::components::{NetId, Player, Transform, Wear};
use forge_core::events::{self, Event};
use forge_core::forge_anim::{Layer, Play};
use forge_core::glam::{Mat4, Vec3};
use forge_core::sim::Animated;
use forge_core::views;
use forge_render::actors::{Attach, BodyBind, Glue, Puppet, PUPPET_BASE};
use forge_render::particles::{self, kind_of};
use forge_render::{glb, Actor, Attached, Flash, FpWeapon, Look, Scene, TexData};
use wasm_bindgen::prelude::*;

use crate::{Forge, State, err, mat};

/// Track R's event kinds (forge-core events: R owns 56..=63). Words after the kind; floats as their bits.
/// R_FLASH: target net id, r, g, b, amount (0..1), seconds — a body's flash (a HIT flashes by itself; this is for
/// anything else).
pub const R_FLASH: u32 = 56;
/// R_GLOW: target net id, r, g, b, intensity, ramp seconds — the `glow_eyes` colour × intensity, reached over the ramp
/// (the attack tell: +12-15% over 0.3 s). An intensity below 0 returns to the material's own.
pub const R_GLOW: u32 = 57;
/// R_VIEWMODEL: weapon index (u32::MAX: keep), flags (1: hidden), x, y, z (m, camera space), pitch, yaw, roll
/// (degrees), fov (degrees, 0: keep) — the first-person rig's offset this step (kick, sway, bob, reload poses).
pub const R_VIEWMODEL: u32 = 58;
/// R_TINT: target net id, r, g, b, a — a body's colour multiplier (a < 0: none).
pub const R_TINT: u32 = 59;
/// R_CLOTH: target net id, r, g, b — a body's `tint_*` materials (the player colour; r < 0: none).
pub const R_CLOTH: u32 = 60;

fn f(w: u32) -> f32 {
    let v = f32::from_bits(w);
    if v.is_finite() { v } else { 0.0 }
}

/// The look's track R extension (the floats after wave 0's 22), from `set_look`.
pub(crate) fn look_ext(look: &mut Look, v: &[f32]) {
    look.set_ext(v.get(22..).unwrap_or(&[]));
}

/// The frame's glue, before the renderer draws (see the module's doc).
pub(crate) fn before_frame(st: &mut State) {
    let time = st.gfx.scene.time;
    let (cw, ch) = st.gfx.size();
    let aspect = cw as f32 / ch.max(1) as f32;
    let glue = &mut st.gfx.glue;
    let dt = match glue.last_time {
        Some(t) => (time - t).clamp(0.0, 0.1),
        None => 0.0,
    };
    glue.last_time = Some(time);
    let core = &mut st.core;
    let scene = &mut st.gfx.scene;
    // the camera's roll (the feel's), with the eyes
    if st.core_camera && core.views.camera[views::camera::PLAYER] > 0.0 {
        scene.camera.roll = core.views.camera[views::camera::ROLL];
    }
    // ---- the last tick's events, once ----
    if core.ticks != glue.last_tick {
        glue.last_tick = core.ticks;
        let n = core.events_out.len() / events::WORDS;
        // the wave 1b integration's part first (glue.rs: forge-feel's flash, the local shot at the first-person muzzle);
        // what it took is not drawn again here
        let local = crate::glue::local_player(core);
        // a viewer's copy (wave 4): its local player is the replica it watches, whose shots are the host's events
        let watching = core.net().is_some_and(|n| n.is_viewer());
        let mut muzzle_lights = Vec::new();
        for k in 0..n {
            let mut w = [0u32; events::WORDS];
            w.copy_from_slice(&core.events_out[k * events::WORDS..(k + 1) * events::WORDS]);
            let Some((e, flags)) = Event::decode(&w) else { continue };
            if crate::glue::on_event(core, scene, glue, &e, flags & events::FLAG_REMOTE != 0, aspect, local, &mut muzzle_lights, watching) {
                continue;
            }
            on_event(scene, glue, &core.sim.names, &e, aspect);
        }
    }
    // the enemies' eyes (forge-ai's view) onto their glow, before the actors take it
    crate::glue::before_actors(core, glue);
    // ---- actors: the core's animated entities ----
    scene.actors.clear();
    scene.attached.clear();
    scene.palette.clear();
    // the palette: every actor's bones (world, from forge-anim) times its model's per-skin matrices (Scene::push_palette)
    let alpha = core.views.camera[views::camera::ALPHA];
    let hide_local = st.core_camera;
    let mut sockets_needed: Vec<(usize, usize)> = Vec::new();
    glue.undrawn = 0;
    for (net, t, a, p, wear) in core.sim.world.query::<(&NetId, &Transform, &Animated, Option<&Player>, Option<&Wear>)>().iter() {
        if hide_local && p.is_some_and(|p| p.local) {
            continue;
        }
        // what a player's body wears (forge-core `Wear`): hidden on this copy (its own first-person player), else its
        // cloth in the player's colour
        let Some(worn) = crate::glue::worn(wear) else { continue };
        let Some(bind) = glue.bodies.get(&a.animator.body) else {
            glue.undrawn += 1;
            continue;
        };
        if bind.sockets_from.is_none() {
            sockets_needed.push((a.animator.body, a.animator.set));
        }
        let (pos, rot) = t.interpolated(alpha);
        let fx = glue.fx.get(&net.0).copied().unwrap_or_default();
        scene.actors.push(Actor {
            id: net.0,
            model: bind.model,
            slot: bind.slot,
            transform: forge_render::body_transform(pos, rot, t.scale),
            bones: Scene::push_palette(&mut scene.palette, &scene.models[bind.model], core.sim.anim.poses.world.get(a.base as usize..(a.base + a.count) as usize).unwrap_or(&[])),
            tint: fx.tint.unwrap_or([1.0; 4]),
            flash: fx.flash_now(),
            glow: fx.glow_now(),
            cloth: fx.cloth.or(worn),
            visible: true,
            shadow: true,
            rim: fx.rim.unwrap_or([0.0; 4]),
        });
    }
    for (body, set) in sockets_needed {
        let model = glue.bodies.get(&body).map(|b| b.model);
        let m = model.and_then(|m| scene.models.get(m)).cloned();
        glue.ensure_sockets(&mut core.sim.anim.library, body, set, m.as_ref());
    }
    // ---- puppets: posed by the renderer ----
    glue.pose_puppets(&core.sim.anim.library, dt);
    for (i, p) in glue.puppets.iter().enumerate() {
        let Some(p) = p else { continue };
        let Some(bind) = glue.bodies.get(&p.body) else { continue };
        let id = PUPPET_BASE + i as u32;
        let fx = glue.fx.get(&id).copied().unwrap_or_default();
        let n = core.sim.anim.library.bodies.get(p.body).map(|b| b.joints.len()).unwrap_or(0);
        let bones = Scene::push_palette(&mut scene.palette, &scene.models[bind.model], glue.poses.world.get(p.base as usize..p.base as usize + n).unwrap_or(&[]));
        scene.actors.push(Actor { id, model: bind.model, slot: bind.slot, transform: p.transform, bones, tint: fx.tint.unwrap_or([1.0; 4]), flash: fx.flash_now(), glow: fx.glow_now(), cloth: fx.cloth, visible: p.visible, shadow: true, rim: fx.rim.unwrap_or([0.0; 4]) });
    }
    // ---- rigid models on sockets ----
    for (k, at) in glue.attach.iter().enumerate() {
        let Some(actor) = scene.actors.iter().find(|a| a.id == at.owner) else { continue };
        // the owner's body and its bones' world matrices this frame
        let (body, world): (usize, &[Mat4]) = if at.owner >= PUPPET_BASE {
            let Some(Some(p)) = glue.puppets.get((at.owner - PUPPET_BASE) as usize) else { continue };
            (p.body, glue.poses.world.get(p.base as usize..).unwrap_or(&[]))
        } else {
            let Some(e) = core.sim.entity_of(at.owner) else { continue };
            let Ok(a) = core.sim.world.get::<&Animated>(e) else { continue };
            (a.animator.body, core.sim.anim.poses.world.get(a.base as usize..).unwrap_or(&[]))
        };
        let Some(bind) = glue.bodies.get(&body) else { continue };
        let place = match bind.sockets.get(&at.socket) {
            Some((j, s)) => world.get(*j).map(|w| *w * *s),
            None => core.sim.anim.library.bone(body, &at.socket).and_then(|j| world.get(j).copied()),
        };
        let Some(place) = place else { continue };
        let fx = glue.fx.get(&at.owner).copied().unwrap_or_default();
        let (owner_m, owner_visible) = (actor.transform, actor.visible);
        scene.attached.push(Attached { id: k as u32, model: at.model, slot: at.slot, transform: owner_m * place * at.grip, tint: fx.tint.unwrap_or([1.0; 4]), flash: fx.flash_now(), visible: owner_visible });
    }
    // ---- rigid entities (debris, coins, pickups, orbs), the orbs' lights, the first-person layer from the feel ----
    crate::glue::after_actors(core, scene, glue, dt, st.core_camera);
    // ---- effects over time ----
    for fx in glue.fx.values_mut() {
        fx.advance(dt);
    }
    let live: std::collections::HashSet<u32> = scene.actors.iter().map(|a| a.id).collect();
    glue.fx.retain(|id, fx| live.contains(id) || fx.tint.is_some() || fx.cloth.is_some());
    for fl in scene.flashes.iter_mut() {
        fl.age += dt;
    }
    scene.flashes.retain(|fl| fl.age < fl.life);
    let look = scene.look.clone();
    let budget = look.particle_budget as usize;
    let eye = scene.camera.eye;
    if dt > 0.0 {
        for (i, l) in scene.lights.iter().enumerate() {
            let p = Vec3::from(l.pos);
            scene.particles.emit(&look.kinds, 1000 + i as u64, particles::EMBERS, look.fire_embers, dt, p, Vec3::new(0.12, 0.05, 0.12), budget, eye);
            scene.particles.emit(&look.kinds, 2000 + i as u64, particles::SMOKE, look.fire_smoke, dt, p + Vec3::Y * 0.35, Vec3::new(0.08, 0.05, 0.08), budget, eye);
        }
        if look.weather_ash > 0.0 {
            scene.particles.emit(&look.kinds, 9, particles::ASH, look.weather_ash, dt, eye + Vec3::new(0.0, 4.0, 0.0), Vec3::new(13.0, 4.0, 13.0), budget, eye);
        }
    }
    scene.particles.update(&look.kinds, dt);
}

fn on_event(scene: &mut Scene, glue: &mut Glue, names: &forge_core::names::Names, e: &Event, aspect: f32) {
    let eye = scene.camera.eye;
    match e {
        Event::Light(l) => {
            scene.flashes.push(Flash { pos: l.pos, color: l.color, radius: l.radius.max(0.1), intensity: l.intensity, life: (l.frames.max(1) as f32) / 60.0, age: 0.0 });
            if scene.flashes.len() > 64 {
                scene.flashes.remove(0);
            }
        }
        Event::Particles(p) => {
            // "<kind>@muzzle" / "<kind>@tip": at the first-person weapon's socket, where it shows on screen (the
            // event's own place is ignored; a zero direction becomes the view's)
            let name = names.get(p.name);
            let (kind_name, at) = match name.rsplit_once('@') {
                Some((k, s)) => (k, Some(s)),
                None => (name, None),
            };
            match kind_of(kind_name) {
                Some(k) => {
                    let (mut pos, mut dir) = (p.pos, p.dir);
                    if let Some(s) = at {
                        let rig = scene.fp_rig();
                        let socket = match s {
                            "muzzle" => rig.muzzle,
                            "tip" => rig.tip,
                            _ => rig.grip,
                        };
                        match socket {
                            Some(c) => pos = scene.fp_to_world(c, aspect),
                            None => {
                                glue.unknown_particles += 1;
                                return;
                            }
                        }
                        if dir.length_squared() < 1e-8 {
                            dir = scene.camera.dir();
                        }
                    }
                    let look = &scene.look;
                    scene.particles.burst(&look.kinds, k, p.count, pos, dir, p.speed, p.spread, look.particle_budget as usize, eye);
                }
                None => glue.unknown_particles += 1,
            }
        }
        Event::Hit(h) => {
            if scene.look.hit_amount > 0.0 {
                let (c, a, t) = (scene.look.hit_color, scene.look.hit_amount, scene.look.hit_time);
                glue.fx.entry(h.target).or_default().start_flash(c, a, t);
                glue.seen[1] += 1;
            }
        }
        Event::Kill(k) => {
            glue.fx.entry(k.target).or_default().glow = Some(([0.0; 3], [0.0; 3], 0.0, 0.0));
        }
        Event::Custom { kind, words } => {
            let w = words;
            match *kind {
                R_FLASH => glue.fx.entry(w[0]).or_default().start_flash([f(w[1]), f(w[2]), f(w[3])], f(w[4]), f(w[5])),
                R_GLOW => {
                    let model = scene.actors.iter().find(|a| a.id == w[0]).map(|a| a.model);
                    let own = model.map(|m| Glue::own_glow(scene, m)).unwrap_or([0.0; 3]);
                    let fx = glue.fx.entry(w[0]).or_default();
                    if f(w[4]) < 0.0 {
                        fx.glow = None;
                    } else {
                        let i = f(w[4]);
                        fx.ramp_glow([f(w[1]) * i, f(w[2]) * i, f(w[3]) * i], f(w[5]), own);
                    }
                }
                R_VIEWMODEL => {
                    if w[0] != u32::MAX
                        && let Some(Some(wp)) = glue.fp_weapons.get(w[0] as usize)
                    {
                        scene.fp.weapon = Some(*wp);
                    }
                    scene.fp.visible = w[1] & 1 == 0;
                    let (pi, ya, ro) = (f(w[5]).to_radians(), f(w[6]).to_radians(), f(w[7]).to_radians());
                    scene.fp.pose = Mat4::from_translation(Vec3::new(f(w[2]), f(w[3]), f(w[4]))) * Mat4::from_euler(forge_core::glam::EulerRot::YXZ, ya, pi, ro);
                    if f(w[8]) > 1.0 {
                        scene.fp.fov = f(w[8]);
                    }
                }
                R_TINT => glue.fx.entry(w[0]).or_default().tint = if f(w[4]) < 0.0 { None } else { Some([f(w[1]), f(w[2]), f(w[3]), f(w[4])]) },
                R_CLOTH => glue.fx.entry(w[0]).or_default().cloth = if f(w[1]) < 0.0 { None } else { Some([f(w[1]), f(w[2]), f(w[3])]) },
                _ => {}
            }
        }
        _ => {}
    }
}

fn v3(v: &[f32]) -> Vec3 {
    Vec3::new(v.first().copied().unwrap_or(0.0), v.get(1).copied().unwrap_or(0.0), v.get(2).copied().unwrap_or(0.0))
}

#[wasm_bindgen]
impl Forge {
    // ---- bodies: a skinned GLB both animated (forge-anim) and drawn (GPU skinning) ----

    /// A body: a skinned GLB's bytes (meshopt decoded) and the slot it is drawn as. It is added to the core's animation
    /// library and drawn wherever the core (or a puppet) animates it. → [body id, model id]: the model's pictures wait
    /// for the host (model_image_count / set_model_image), as any model's.
    pub fn add_body(&self, bytes: &[u8], slot: u32) -> Result<Vec<u32>, JsValue> {
        let mut s = self.s.borrow_mut();
        let body = s.core.sim.anim.library.add_body(bytes).map_err(err)?;
        let model = bind_model(&mut s, body, bytes, slot)?;
        Ok(vec![body as u32, model as u32])
    }
    /// Draw a body already in the animation library (`add_anim_body`) with this GLB's model. → the model id.
    pub fn bind_body_model(&self, body: u32, bytes: &[u8], slot: u32) -> Result<u32, JsValue> {
        let mut s = self.s.borrow_mut();
        if body as usize >= s.core.sim.anim.library.bodies.len() {
            return Err(err("no such body"));
        }
        bind_model(&mut s, body as usize, bytes, slot).map(|m| m as u32)
    }

    /// The renderer draws every animated entity's body skinned itself (CONTRACT §8 forge "Live co-op": `players.js`
    /// then draws no stand-in, and plays the clips).
    pub fn draws_bodies(&self) -> bool {
        true
    }

    // ---- rigid entities: the model a debris piece, a coin, a pickup or an orb is drawn as (the wave 1b integration) ----

    /// Draw every core entity of `class` (an entity kind, or 100: a caster's orb) and `type_` (65535: every type) as
    /// `model` in `slot`, fitted by `fit` (16 floats, applied before the entity's own place), turning `spin` rad/s and
    /// bobbing `bob` m on the spot (0: the entity's own rotation).
    pub fn entity_model(&self, class: u32, type_: u32, model: u32, slot: u32, fit: &[f32], spin: f32, bob: f32) -> Result<(), JsValue> {
        let fit = mat(fit)?;
        let mut s = self.s.borrow_mut();
        if model as usize >= s.gfx.scene.models.len() {
            return Err(err("no such model"));
        }
        s.gfx.glue.entity_models.insert((class.min(255) as u8, type_.min(65535) as u16), forge_render::actors::EntityModel { model: model as usize, slot, fit, spin, bob });
        Ok(())
    }
    pub fn entity_models_clear(&self) {
        self.s.borrow_mut().gfx.glue.entity_models.clear();
    }

    // ---- puppets: bodies the renderer poses (lookdev, previews, verify's poses) ----

    /// A puppet: `body` playing from `clips`, placed by `m` (16 floats, column-major; a gf-humanoid-1 body faces +Z).
    /// → its actor id (PUPPET_BASE + index).
    pub fn puppet(&self, body: u32, clips: u32, m: &[f32]) -> Result<u32, JsValue> {
        let mut s = self.s.borrow_mut();
        let transform = mat(m)?;
        let animator = s.core.sim.anim.library.animator(body as usize, clips as usize).map_err(err)?;
        let st = &mut *s;
        if !st.gfx.glue.bodies.contains_key(&(body as usize)) {
            return Err(err("the body has no model to draw (add_body)"));
        }
        let model = st.gfx.glue.bodies.get(&(body as usize)).map(|b| b.model);
        let mm = model.and_then(|m| st.gfx.scene.models.get(m)).cloned();
        st.gfx.glue.ensure_sockets(&mut st.core.sim.anim.library, body as usize, clips as usize, mm.as_ref());
        let p = Puppet { body: body as usize, animator, transform, visible: true, frozen: false, base: 0 };
        let glue = &mut st.gfx.glue;
        let i = match glue.puppets.iter().position(|x| x.is_none()) {
            Some(i) => {
                glue.puppets[i] = Some(p);
                i
            }
            None => {
                glue.puppets.push(Some(p));
                glue.puppets.len() - 1
            }
        };
        Ok(PUPPET_BASE + i as u32)
    }
    /// Play a clip on a puppet from time `t` (s) at `rate` (0: hold that frame); `looping` −1 the clip's own.
    pub fn puppet_play(&self, id: u32, clip: &str, t: f32, rate: f32, looping: i32, fade: f32) -> bool {
        let mut s = self.s.borrow_mut();
        let st = &mut *s;
        let lib = &st.core.sim.anim.library;
        let Some(Some(p)) = st.gfx.glue.puppets.get_mut(id.wrapping_sub(PUPPET_BASE) as usize) else { return false };
        let looping = if looping < 0 { None } else { Some(looping != 0) };
        if !p.animator.play(lib, clip, Play { fade: fade.max(0.0), layer: Some(Layer::Base), looping, rate: if rate == 0.0 { 1.0 } else { rate }, restart: true, hold: false, ..Play::default() }) {
            return false;
        }
        if let Some(b) = p.animator.base.as_mut() {
            b.time = t.max(0.0);
        }
        p.frozen = rate == 0.0;
        true
    }
    /// A clip's [duration, impact] in seconds (impact 0: none; empty: no such clip), for posing at "end" or "impact".
    pub fn clip_times(&self, clips: u32, name: &str) -> Vec<f32> {
        let s = self.s.borrow();
        let Some(set) = s.core.sim.anim.library.sets.get(clips as usize) else { return vec![] };
        set.clip(name).map(|i| vec![set.clips[i].duration, set.clips[i].impact]).unwrap_or_default()
    }
    /// Stop a puppet's clip: it stands at the standard rest.
    pub fn puppet_rest(&self, id: u32) {
        let mut s = self.s.borrow_mut();
        if let Some(Some(p)) = s.gfx.glue.puppets.get_mut(id.wrapping_sub(PUPPET_BASE) as usize) {
            p.animator.stop(Layer::Base);
            p.animator.stop(Layer::Upper);
        }
    }
    pub fn puppet_move(&self, id: u32, m: &[f32]) -> Result<(), JsValue> {
        let t = mat(m)?;
        if let Some(Some(p)) = self.s.borrow_mut().gfx.glue.puppets.get_mut(id.wrapping_sub(PUPPET_BASE) as usize) {
            p.transform = t;
        }
        Ok(())
    }
    pub fn puppet_visible(&self, id: u32, on: bool) {
        if let Some(Some(p)) = self.s.borrow_mut().gfx.glue.puppets.get_mut(id.wrapping_sub(PUPPET_BASE) as usize) {
            p.visible = on;
        }
    }
    pub fn puppet_remove(&self, id: u32) {
        let mut s = self.s.borrow_mut();
        let glue = &mut s.gfx.glue;
        if let Some(x) = glue.puppets.get_mut(id.wrapping_sub(PUPPET_BASE) as usize) {
            *x = None;
        }
        glue.attach.retain(|a| a.owner != id);
    }

    // ---- rigid models on a body: held weapons, helmets ----

    /// Hang `model` on an actor (a net id or a puppet id) at `socket` (hand_r, hand_l, head, back, or a bone's name),
    /// placed by `grip` (16 floats: the catalog's grip). → its index.
    pub fn attach(&self, owner: u32, model: u32, slot: u32, socket: &str, grip: &[f32]) -> Result<u32, JsValue> {
        let g = mat(grip)?;
        let mut s = self.s.borrow_mut();
        if model as usize >= s.gfx.scene.models.len() {
            return Err(err("no such model"));
        }
        s.gfx.glue.attach.push(Attach { owner, model: model as usize, slot, socket: socket.to_string(), grip: g });
        Ok(s.gfx.glue.attach.len() as u32 - 1)
    }
    /// Take everything off an actor.
    pub fn detach_all(&self, owner: u32) {
        self.s.borrow_mut().gfx.glue.attach.retain(|a| a.owner != owner);
    }

    // ---- an actor's look: flash, glow, tint, cloth (also R_FLASH, R_GLOW, R_TINT, R_CLOTH from Rust) ----

    pub fn actor_flash(&self, id: u32, r: f32, g: f32, b: f32, amount: f32, seconds: f32) {
        self.s.borrow_mut().gfx.glue.fx.entry(id).or_default().start_flash([r, g, b], amount, seconds);
    }
    /// The `glow_eyes` colour × intensity, reached over `ramp` seconds (intensity < 0: the material's own again).
    pub fn actor_glow(&self, id: u32, r: f32, g: f32, b: f32, intensity: f32, ramp: f32) {
        let mut s = self.s.borrow_mut();
        let st = &mut *s;
        let model = st.gfx.scene.actors.iter().find(|a| a.id == id).map(|a| a.model);
        let own = model.map(|m| Glue::own_glow(&st.gfx.scene, m)).unwrap_or([0.0; 3]);
        let fx = st.gfx.glue.fx.entry(id).or_default();
        if intensity < 0.0 {
            fx.glow = None;
        } else {
            fx.ramp_glow([r * intensity, g * intensity, b * intensity], ramp, own);
        }
    }
    pub fn actor_tint(&self, id: u32, r: f32, g: f32, b: f32, a: f32) {
        self.s.borrow_mut().gfx.glue.fx.entry(id).or_default().tint = if a < 0.0 { None } else { Some([r, g, b, a]) };
    }
    pub fn actor_cloth(&self, id: u32, r: f32, g: f32, b: f32) {
        self.s.borrow_mut().gfx.glue.fx.entry(id).or_default().cloth = if r < 0.0 { None } else { Some([r, g, b]) };
    }
    /// How an actor was drawn last frame (the observation interface: hits read, the eyes' tell): [flash r, g, b, amount,
    /// glow r, g, b (−1: the material's own), tint r, g, b, a]; empty when it was not drawn.
    pub fn actor_look(&self, id: u32) -> Vec<f32> {
        let s = self.s.borrow();
        let Some(a) = s.gfx.scene.actors.iter().find(|a| a.id == id) else { return vec![] };
        let g = a.glow.unwrap_or([-1.0; 3]);
        vec![a.flash[0], a.flash[1], a.flash[2], a.flash[3], g[0], g[1], g[2], a.tint[0], a.tint[1], a.tint[2], a.tint[3]]
    }
    /// The actors drawn last frame: their ids.
    pub fn actor_ids(&self) -> Vec<u32> {
        self.s.borrow().gfx.scene.actors.iter().map(|a| a.id).collect()
    }
    /// An actor's bones (model space, 16 floats each, column-major) as last posed: for verify's pose comparison.
    pub fn actor_bones(&self, id: u32) -> Vec<f32> {
        let s = self.s.borrow();
        let floats = |w: Option<&[Mat4]>| w.map(|w| w.iter().flat_map(|m| m.to_cols_array()).collect()).unwrap_or_default();
        if id >= PUPPET_BASE {
            let Some(Some(p)) = s.gfx.glue.puppets.get((id - PUPPET_BASE) as usize) else { return vec![] };
            let (a, n) = (p.base as usize, p.animator.bone_count(&s.core.sim.anim.library));
            return floats(s.gfx.glue.poses.world.get(a..a + n));
        }
        let Some(e) = s.core.sim.entity_of(id) else { return vec![] };
        let Ok(a) = s.core.sim.world.get::<&Animated>(e) else { return vec![] };
        floats(s.core.sim.anim.poses.world.get(a.base as usize..(a.base + a.count) as usize))
    }

    // ---- the first-person layer ----

    /// The arms (fp/arms.glb: camera space, nodes arm_r and arm_l with socket_grip and socket_grip_l).
    pub fn fp_arms(&self, model: u32, slot: u32) {
        self.s.borrow_mut().gfx.scene.fp.arms = Some((model as usize, slot));
    }
    /// Register the weapon of table row `index`: its model, slot, hold (the catalog's `hold.arm_r`, camera space) and
    /// whether the left hand holds it too. R_VIEWMODEL events pick it by index; `fp_use` from the host.
    pub fn fp_weapon(&self, index: u32, model: u32, slot: u32, hx: f32, hy: f32, hz: f32, two_handed: bool) {
        let mut s = self.s.borrow_mut();
        let w = FpWeapon { model: model as usize, slot, hold: Vec3::new(hx, hy, hz), two_handed };
        let list = &mut s.gfx.glue.fp_weapons;
        if list.len() <= index as usize {
            list.resize(index as usize + 1, None);
        }
        list[index as usize] = Some(w);
        if s.gfx.scene.fp.weapon.is_none() {
            s.gfx.scene.fp.weapon = Some(w);
        }
    }
    /// The weapon in hand (a registered index; u32::MAX: none).
    pub fn fp_use(&self, index: u32) {
        let mut s = self.s.borrow_mut();
        let w = s.gfx.glue.fp_weapons.get(index as usize).copied().flatten();
        s.gfx.scene.fp.weapon = w;
    }
    /// The rig's camera-space offset this frame (16 floats): kick, sway, bob, reload poses.
    pub fn fp_pose(&self, m: &[f32]) -> Result<(), JsValue> {
        let t = mat(m)?;
        self.s.borrow_mut().gfx.scene.fp.pose = t;
        Ok(())
    }
    pub fn fp_visible(&self, on: bool) {
        self.s.borrow_mut().gfx.scene.fp.visible = on;
    }
    /// The layer's own vertical field of view (0: the look's `fp.fov`).
    pub fn fp_fov(&self, deg: f32) {
        self.s.borrow_mut().gfx.scene.fp.fov = deg;
    }
    /// The layer follows the core's feel view by itself (the weapon in hand, its kick, sway, bob, reload, raise and
    /// swing: glue.rs); false: the host poses it with `fp_pose`, `fp_use` and `fp_visible` (the lookdev).
    pub fn fp_auto(&self, on: bool) {
        self.s.borrow_mut().gfx.glue.fp_manual = !on;
    }
    /// The weapon a quick melee swings when the tables have no melee weapon (the built-in blade).
    pub fn fp_blade(&self, model: u32, slot: u32) {
        self.s.borrow_mut().gfx.glue.fp_blade = Some(FpWeapon { model: model as usize, slot, hold: Vec3::ZERO, two_handed: false });
    }
    /// The sleeves' colour (the arms' `tint_sleeve`; r < 0: their own).
    pub fn fp_sleeve(&self, r: f32, g: f32, b: f32) {
        self.s.borrow_mut().gfx.scene.fp.sleeve = if r < 0.0 { None } else { Some([r, g, b]) };
    }
    /// The weapon's sockets this frame: [flags (1 muzzle, 2 tip, 4 grip), muzzle camera xyz, muzzle world xyz, tip camera
    /// xyz, tip world xyz, grip camera xyz]. "World" is where the point shows on screen through the world camera: start
    /// effects there (the flash, smoke, a tracer).
    pub fn fp_sockets(&self) -> Vec<f32> {
        let s = self.s.borrow();
        let sc = &s.gfx.scene;
        let (w, h) = s.gfx.size();
        let aspect = w as f32 / h.max(1) as f32;
        let rig = sc.fp_rig();
        let mut flags = 0u32;
        let mut out = vec![0f32; 16];
        if let Some(m) = rig.muzzle {
            flags |= 1;
            out[1..4].copy_from_slice(&m.to_array());
            out[4..7].copy_from_slice(&sc.fp_to_world(m, aspect).to_array());
        }
        if let Some(t) = rig.tip {
            flags |= 2;
            out[7..10].copy_from_slice(&t.to_array());
            out[10..13].copy_from_slice(&sc.fp_to_world(t, aspect).to_array());
        }
        if let Some(g) = rig.grip {
            flags |= 4;
            out[13..16].copy_from_slice(&g.to_array());
        }
        out[0] = flags as f32;
        out
    }

    // ---- effects from the host ----

    /// A particle burst by kind name (smoke, sparks, embers, dust, bone, blood, muzzle, impact, orb, ash, or an alias);
    /// count, speed and spread 0 take the kind's own. → false for an unknown kind.
    pub fn fx_burst(&self, name: &str, count: u32, at: &[f32], dir: &[f32], speed: f32, spread: f32) -> bool {
        let mut s = self.s.borrow_mut();
        let Some(k) = kind_of(name) else { return false };
        let sc = &mut s.gfx.scene;
        let (kinds, budget, eye) = (sc.look.kinds.clone(), sc.look.particle_budget as usize, sc.camera.eye);
        sc.particles.burst(&kinds, k, count, v3(at), v3(dir), speed, spread, budget, eye);
        true
    }
    /// A flash of light: place, linear colour, radius (m), intensity, frames (at 60 a second).
    pub fn fx_flash(&self, at: &[f32], color: &[f32], radius: f32, intensity: f32, frames: u32) {
        let c = v3(color);
        self.s.borrow_mut().gfx.scene.flashes.push(Flash { pos: v3(at), color: [c.x, c.y, c.z], radius: radius.max(0.1), intensity, life: frames.max(1) as f32 / 60.0, age: 0.0 });
    }
    /// A particle kind's picture (an `fx.*` slot, decoded by the host: RGBA, straight alpha). → false for an unknown kind.
    pub fn fx_texture(&self, kind: &str, w: u32, h: u32, rgba: &[u8]) -> Result<bool, JsValue> {
        let Some(k) = kind_of(kind) else { return Ok(false) };
        let t = TexData::from_rgba(w, h, rgba).map_err(err)?;
        let mut s = self.s.borrow_mut();
        let sc = &mut s.gfx.scene;
        if sc.fx.len() < particles::KINDS.len() {
            sc.fx.resize(particles::KINDS.len(), None);
        }
        sc.fx[k] = Some(t);
        sc.fx_version = sc.fx_version.wrapping_add(1);
        Ok(true)
    }
    pub fn fx_clear(&self) {
        let mut s = self.s.borrow_mut();
        s.gfx.scene.particles.clear();
        s.gfx.scene.flashes.clear();
    }

    /// A named node's place in a model (16 floats, column-major; empty when it has none): `socket_flame` on a torch,
    /// `socket_emerge` on a mound, a weapon's `socket_muzzle`.
    pub fn model_node(&self, model: u32, name: &str) -> Vec<f32> {
        let s = self.s.borrow();
        s.gfx.scene.models.get(model as usize).and_then(|m| m.node_pose(name)).map(|m| m.to_cols_array().to_vec()).unwrap_or_default()
    }

    // ---- what was drawn ----

    /// The last frame: draws, passes, instances, actors, particles, lights, flashes, shadow map size, bloom (0/1),
    /// scene width, height, palette bones, unknown particle names, undrawn animated bodies; then (the wave 1b
    /// integration) rigid models drawn at entities and on sockets, moving lights (orbs), the first-person layer shown
    /// (0/1), its weapon's muzzle flash shown (0/1), a swing drawn (0/1), actors flashing; then counted since the page
    /// loaded: muzzle flashes shown, hit flashes started, first-person swings begun.
    pub fn render_stats(&self) -> Vec<f32> {
        let s = self.s.borrow();
        let x = s.gfx.stats;
        let sc = &s.gfx.scene;
        let flashing = sc.actors.iter().filter(|a| a.flash[3] > 0.0).count() + sc.attached.iter().filter(|a| a.flash[3] > 0.0).count();
        vec![
            x.draws as f32, x.passes as f32, x.instances as f32, x.actors as f32, x.particles as f32, x.lights as f32, x.flashes as f32, x.shadow as f32, x.bloom as u8 as f32, x.width as f32, x.height as f32, x.palette as f32, s.gfx.glue.unknown_particles as f32, s.gfx.glue.undrawn as f32,
            sc.attached.len() as f32, sc.moving_lights.len() as f32, (sc.fp.visible && sc.fp.weapon.is_some()) as u8 as f32, (sc.fp.muzzle_left > 0.0) as u8 as f32, sc.fp.swing.is_some() as u8 as f32, flashing as f32,
            s.gfx.glue.seen[0] as f32, s.gfx.glue.seen[1] as f32, s.gfx.glue.seen[2] as f32,
        ]
    }

    // ---- verify: an actor's skinned vertices as the GPU skins them, and as the CPU does with the same matrices ----

    /// Draw an actor's skinned vertices into a float image and start reading it back. → the vertex count.
    pub fn capture_request(&self, actor: u32) -> Result<u32, JsValue> {
        self.s.borrow_mut().gfx.request_capture(actor).map_err(err)
    }
    /// 0 idle, 1 reading, 2 ready, 3 failed.
    pub fn capture_state(&self) -> u8 {
        self.s.borrow().gfx.capture_state()
    }
    /// x y z per vertex (the order of the model's skinned primitives).
    pub fn capture_take(&self) -> Option<Vec<f32>> {
        self.s.borrow_mut().gfx.take_capture()
    }
    /// The same vertices skinned on the CPU with the palette the GPU was given.
    pub fn capture_cpu(&self, actor: u32) -> Vec<f32> {
        let s = self.s.borrow();
        let sc = &s.gfx.scene;
        sc.actors.iter().find(|a| a.id == actor).map(|a| forge_render::cpu_skin(sc, a)).unwrap_or_default()
    }
}

/// Parse `bytes` as a drawable model, bind it to `body`'s skeleton and remember it as that body's model.
fn bind_model(s: &mut State, body: usize, bytes: &[u8], slot: u32) -> Result<usize, JsValue> {
    let data = glb::parse(bytes).map_err(err)?;
    let b = &s.core.sim.anim.library.bodies[body];
    let node_joint: std::collections::HashMap<usize, usize> = b.joints.iter().enumerate().map(|(j, x)| (x.node, j)).collect();
    let model = s.gfx.scene.add_model(data);
    s.gfx.scene.bind_body(model, &|n| node_joint.get(&n).copied()).map_err(err)?;
    s.gfx.glue.bodies.insert(body, BodyBind { model, slot, sockets: Default::default(), sockets_from: None });
    Ok(model)
}
