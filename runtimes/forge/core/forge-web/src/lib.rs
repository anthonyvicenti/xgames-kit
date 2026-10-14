//! gf-forge's wasm host exports (research/rust-engine/PLAN.md §2; core/ARCHITECTURE.md "The web boundary"): what
//! `gf/forge/host.js` calls.
//!
//! - The boundary: `cmd_ptr()` is where the host writes a tick's packed commands (forge-core `cmd`), `tick(dt, words)`
//!   runs it, and `views_ptr()` (players), `entities_ptr()`, `camera_ptr()`, `events_ptr()` (16 u32 words an event)
//!   and `bones_ptr()` / `skins_ptr()` (the bone palette) are where it reads the state back, as typed arrays over the
//!   wasm memory it re-creates every tick (memory growth detaches them). `load_tables(json)` loads `spec.forge`;
//!   `name(i)` turns an event's name number into its string.
//! - The plugins: forge-feel's and forge-ai's are installed at `create` (`plugins()` lists them, `systems()` the
//!   schedule).
//! - Animation: `add_anim_body` / `add_anim_clips` (GLB bytes), `animate(net id, body, clips)`, `anim_play`.
//! - The scene: models from a slot's GLB bytes, their images decoded by the host, texture slots, instances (each with
//!   its slot), the look and the lights.
//! - The observation interface's readbacks: the per-instance report (coverage, slots) and the slot-ID images (sight).
//! - Device loss: `lost()`, then `recover()` builds everything again on a new device.
use std::cell::RefCell;
use std::rc::Rc;

// track R's exports and the per-frame glue (bodies, puppets, the first-person layer, effects, verify's capture)
mod render;
// forge-feel's exports (track F): the feel view, stats, recap and protocol
mod feel;

use forge_core::forge_anim::Layer as forge_anim_layer;
use forge_core::{views, Core};
use forge_render::{glb, Instance, PointLight, Renderer, TexData, NO_SLOT};
use wasm_bindgen::prelude::*;

// forge-ai's exports (track A): the AI view, the director, the boss, the bots, the grid
mod ai;
// the wave 1b integration: what F, A and S hold that R draws, joined every frame (called from render.rs)
mod glue;

struct State {
    core: Core,
    gfx: Renderer,
    instance: wgpu::Instance,
    canvas: web_sys::HtmlCanvasElement,
    core_camera: bool,
    recoveries: u32,
    adapter: String,
}

#[wasm_bindgen]
pub struct Forge {
    s: Rc<RefCell<State>>,
}

fn err<E: std::fmt::Display>(e: E) -> JsValue {
    JsValue::from_str(&e.to_string())
}

async fn open_gpu(instance: &wgpu::Instance, canvas: &web_sys::HtmlCanvasElement, surface: Option<wgpu::Surface<'static>>) -> Result<(wgpu::Adapter, wgpu::Device, wgpu::Queue, wgpu::Surface<'static>), JsValue> {
    // The GL backend's adapter is the canvas's own WebGL2 context, so there the surface comes first. The WebGPU build
    // asks for its adapter and device first and touches the canvas last: a browser whose WebGPU does not start leaves
    // the canvas free for the WebGL2 build (a canvas gives one kind of context, ever; host.js falls back).
    let mut surface = surface;
    if cfg!(feature = "webgl2") && surface.is_none() {
        surface = Some(instance.create_surface(wgpu::SurfaceTarget::Canvas(canvas.clone())).map_err(err)?);
    }
    let adapter = instance
        .request_adapter(&wgpu::RequestAdapterOptions { power_preference: wgpu::PowerPreference::HighPerformance, force_fallback_adapter: false, compatible_surface: surface.as_ref(), apply_limit_buckets: false })
        .await
        .map_err(|e| err(format!("no {BACKEND} adapter: {e}")))?;
    // WebGL2's limits (PLAN §9, decision 3), with the screen's own size allowed for the canvas and its targets
    let limits = wgpu::Limits::downlevel_webgl2_defaults().using_resolution(adapter.limits());
    let (device, queue) = adapter
        .request_device(&wgpu::DeviceDescriptor { label: Some("gf-forge"), required_features: wgpu::Features::empty(), required_limits: limits, ..Default::default() })
        .await
        .map_err(|e| err(format!("the {BACKEND} device was refused: {e}")))?;
    let surface = match surface {
        Some(s) => s,
        None => instance.create_surface(wgpu::SurfaceTarget::Canvas(canvas.clone())).map_err(err)?,
    };
    Ok((adapter, device, queue, surface))
}

/// Which of the two builds this wasm is (wave 3, track W; forge-web's Cargo features, one a build): wgpu's WebGPU
/// backend, or its GL backend on a WebGL2 context. `gf/forge/host.js` loads one per device.
#[cfg(not(feature = "webgl2"))]
pub const BACKEND: &str = "webgpu";
#[cfg(feature = "webgl2")]
pub const BACKEND: &str = "webgl2";

fn backends() -> wgpu::Backends {
    if cfg!(feature = "webgl2") { wgpu::Backends::GL } else { wgpu::Backends::BROWSER_WEBGPU }
}

fn new_instance() -> wgpu::Instance {
    wgpu::Instance::new(wgpu::InstanceDescriptor { backends: backends(), ..wgpu::InstanceDescriptor::new_without_display_handle() })
}

/// The build this wasm is: "webgpu" or "webgl2" (before `create`: the loader checks it loaded the one it chose).
#[wasm_bindgen]
pub fn backend() -> String {
    BACKEND.to_string()
}

/// Start the engine on a canvas (its width and height are the drawing buffer's). Rejects when the browser has no
/// WebGPU adapter: the host then shows the kit's "open in your browser" screen (CONTRACT §8 forge).
#[wasm_bindgen]
pub async fn create(canvas: web_sys::HtmlCanvasElement, scene_8bit: Option<bool>) -> Result<Forge, JsValue> {
    std::panic::set_hook(Box::new(|info| web_sys::console::error_1(&JsValue::from_str(&format!("gf-forge panicked: {info}")))));
    let instance = new_instance();
    let (adapter, device, queue, surface) = open_gpu(&instance, &canvas, None).await?;
    let info = adapter.get_info();
    let mut gfx = Renderer::new();
    // QA (host.js ?gf-forge-scene=8bit): the 8-bit scene of a device without float render targets, on any device
    gfx.force_ldr = scene_8bit.unwrap_or(false);
    gfx.attach(&adapter, device, queue, surface, canvas.width().max(1), canvas.height().max(1));
    let adapter = format!("{} ({:?}, {})", info.name, info.backend, info.driver);
    Ok(Forge { s: Rc::new(RefCell::new(State { core: new_core(), gfx, instance, canvas, core_camera: true, recoveries: 0, adapter })) })
}

/// The core with every plugin the web build carries: forge-feel, forge-ai and what joins them (forge-play: the same
/// call the native tests of the tracks together make).
fn new_core() -> Core {
    let mut core = Core::new();
    forge_play::install(&mut core);
    core
}

#[wasm_bindgen]
impl Forge {
    // ---- the boundary ----

    /// Where the host writes a tick's commands (u32 words in the wasm memory).
    pub fn cmd_ptr(&self) -> u32 {
        self.s.borrow_mut().core.cmds.as_mut_ptr() as u32
    }
    pub fn cmd_capacity(&self) -> u32 {
        forge_core::CMD_CAPACITY as u32
    }
    /// One frame of simulation: `words` words of commands, then the fixed steps `dt` owes. → steps run.
    pub fn tick(&self, dt: f32, words: u32) -> u32 {
        self.s.borrow_mut().core.tick(dt, words as usize)
    }
    /// The players view: `view_fields()` arrays of `max_players()` floats (forge-core `views::player`).
    pub fn views_ptr(&self) -> u32 {
        self.s.borrow().core.views.players.as_ptr() as u32
    }
    pub fn views_len(&self) -> u32 {
        self.s.borrow().core.views.players.len() as u32
    }
    pub fn view_fields(&self) -> u32 {
        views::player::FIELDS as u32
    }
    pub fn max_players(&self) -> u32 {
        views::MAX_PLAYERS as u32
    }
    pub fn player_count(&self) -> u32 {
        self.s.borrow().core.views.player_count as u32
    }
    /// The entities view: `entity_fields()` arrays of `max_entities()` floats (forge-core `views::entity`).
    pub fn entities_ptr(&self) -> u32 {
        self.s.borrow().core.views.entities.as_ptr() as u32
    }
    pub fn entity_fields(&self) -> u32 {
        views::entity::FIELDS as u32
    }
    pub fn max_entities(&self) -> u32 {
        views::MAX_ENTITIES as u32
    }
    pub fn entity_count(&self) -> u32 {
        self.s.borrow().core.views.entity_count as u32
    }
    /// The camera view: `camera_fields()` floats (forge-core `views::camera`).
    pub fn camera_ptr(&self) -> u32 {
        self.s.borrow().core.views.camera.as_ptr() as u32
    }
    pub fn camera_fields(&self) -> u32 {
        views::camera::FIELDS as u32
    }
    /// The last tick's events: `events_count()` × 16 u32 words (forge-core `events`).
    pub fn events_ptr(&self) -> u32 {
        self.s.borrow().core.events_out.as_ptr() as u32
    }
    pub fn events_count(&self) -> u32 {
        (self.s.borrow().core.events_out.len() / forge_core::events::WORDS) as u32
    }
    pub fn events_dropped(&self) -> u32 {
        self.s.borrow().core.sim.events.dropped
    }
    /// The bone palette: 16 floats a bone (world, model space), `bones_len()` floats; `skins_ptr()` the same bones'
    /// skin matrices (world × inverse bind). An entity's bones are BONE_BASE..+BONE_COUNT in the entities view.
    pub fn bones_ptr(&self) -> u32 {
        self.s.borrow().core.sim.anim.poses.world_floats().as_ptr() as u32
    }
    pub fn skins_ptr(&self) -> u32 {
        self.s.borrow().core.sim.anim.poses.skin_floats().as_ptr() as u32
    }
    pub fn bones_len(&self) -> u32 {
        self.s.borrow().core.sim.anim.poses.world_floats().len() as u32
    }
    /// How many names exist (an event's name number < this); `name(i)` is one.
    pub fn names_count(&self) -> u32 {
        self.s.borrow().core.sim.names.len() as u32
    }
    pub fn name(&self, i: u32) -> String {
        self.s.borrow().core.sim.names.get(i).to_string()
    }
    /// Load the data tables (`config/game.json → forge`, JSON).
    pub fn load_tables(&self, json: &str) -> Result<(), JsValue> {
        self.s.borrow_mut().core.load_tables(json).map_err(err)
    }
    pub fn tables_version(&self) -> u32 {
        self.s.borrow().core.sim.tables.version
    }
    pub fn ticks(&self) -> f64 {
        self.s.borrow().core.ticks as f64
    }
    /// Fixed steps run since the start, and in the last tick.
    pub fn steps(&self) -> f64 {
        self.s.borrow().core.sim.time.step as f64
    }
    pub fn steps_last(&self) -> u32 {
        self.s.borrow().core.steps_last
    }
    pub fn step_hz(&self) -> u32 {
        forge_core::HZ
    }
    /// Seconds of simulation dropped by the 100 ms catch-up cap since the start.
    pub fn dropped_seconds(&self) -> f64 {
        self.s.borrow().core.dropped
    }
    pub fn plugins(&self) -> String {
        self.s.borrow().core.plugins().join(",")
    }
    /// The schedule, one "stage name" a line.
    pub fn systems(&self) -> String {
        self.s.borrow().core.systems().join("\n")
    }
    /// Snapshot v1 (forge-core `snapshot`): at most 2600 bytes.
    pub fn snapshot(&self) -> Vec<u8> {
        self.s.borrow_mut().core.snapshot()
    }
    /// Apply a host's snapshot. → players × 65536 + actors read.
    pub fn apply(&self, bytes: &[u8]) -> Result<u32, JsValue> {
        self.s.borrow_mut().core.apply(bytes).map(|(p, a)| (p as u32) << 16 | a.min(65535) as u32).map_err(err)
    }
    /// Snapshot v2's size, the last one sent (bytes).
    pub fn snapshot_bytes(&self) -> u32 {
        self.s.borrow().core.snapshots.last_bytes as u32
    }

    // ---- live co-op (forge-core net.rs; CONTRACT §8 forge "Live co-op") ----

    /// This copy's part: 0 alone, 1 the host, 2 a joiner (whose own player is `local`; `epoch`: this page load), 3 a
    /// viewer (wave 4, watch then play: no player of its own, every player the host's replica).
    pub fn net_role(&self, role: u32, local: u32, epoch: u32) {
        self.s.borrow_mut().core.net_role(forge_core::net::Role::from_u32(role), local, epoch);
    }
    /// A viewer: look through player `player`'s eyes (0: nobody; the page's own camera then). Nothing on another role.
    pub fn net_watch(&self, player: u32) {
        self.s.borrow_mut().core.net_watch(player);
    }
    /// A joiner: its own player's inputs since the last call, one batch for the host (empty: none yet).
    pub fn net_take_inputs(&self) -> Vec<u8> {
        self.s.borrow_mut().core.net_take_inputs()
    }
    /// The host: a joiner's batch for its player `player`. → the inputs queued.
    pub fn net_push_inputs(&self, player: u32, bytes: &[u8]) -> Result<u32, JsValue> {
        self.s.borrow_mut().core.net_push_inputs(player, bytes).map(|n| n as u32).map_err(err)
    }
    /// The co-op counts (JSON): role, reconciliations, the input queues, the snapshots.
    pub fn net_stats(&self) -> String {
        self.s.borrow().core.net_stats_json()
    }
    /// What player `net` wears (components::Wear): its colour (linear RGB), its body's slot index, hidden on this copy.
    /// → false when it is not here.
    pub fn set_wear(&self, net: u32, r: f32, g: f32, b: f32, body: u32, hidden: bool) -> bool {
        let mut s = self.s.borrow_mut();
        let sim = &mut s.core.sim;
        let Some(e) = sim.entity_of(net) else { return false };
        let held = sim.world.get::<&forge_core::components::Wear>(e).map(|w| w.held).unwrap_or(forge_core::components::HELD_NONE);
        sim.world.insert_one(e, forge_core::components::Wear { tint: [r, g, b], body, held, hidden }).is_ok()
    }
    /// What entity `net` wears: [r, g, b, body slot, held row (255 none), hidden], or empty when it has no Wear.
    pub fn wear(&self, net: u32) -> Vec<f32> {
        let s = self.s.borrow();
        let sim = &s.core.sim;
        let Some(e) = sim.entity_of(net) else { return Vec::new() };
        match sim.world.get::<&forge_core::components::Wear>(e) {
            Ok(w) => vec![w.tint[0], w.tint[1], w.tint[2], if w.body == forge_core::components::NO_SLOT { -1.0 } else { w.body as f32 }, w.held as f32, w.hidden as u8 as f32],
            Err(_) => Vec::new(),
        }
    }
    /// Nothing of the world (static colliders) between two points: a friend in view is not behind a wall.
    #[allow(clippy::too_many_arguments)]
    pub fn clear_line(&self, x0: f32, y0: f32, z0: f32, x1: f32, y1: f32, z1: f32) -> bool {
        let s = self.s.borrow();
        let (a, b) = (forge_core::glam::Vec3::new(x0, y0, z0), forge_core::glam::Vec3::new(x1, y1, z1));
        let d = b - a;
        let len = d.length();
        if len < 1e-4 {
            return true;
        }
        let mask = forge_core::physics::QueryMask::new(forge_core::physics::groups::WORLD);
        s.core.sim.physics.cast_ray(a, d, len, mask).is_none_or(|h| h.dist >= len - 0.3)
    }

    /// A static triangle mesh collider (x y z per vertex, three indices per triangle).
    pub fn add_static_mesh(&self, vertices: &[f32], indices: &[u32]) -> Result<(), JsValue> {
        let v = vertices.chunks_exact(3).map(|c| forge_core::glam::Vec3::new(c[0], c[1], c[2])).collect();
        let t = indices.chunks_exact(3).map(|c| [c[0], c[1], c[2]]).collect();
        self.s.borrow_mut().core.sim.physics.add_mesh(v, t).map(|_| ()).map_err(err)
    }

    // ---- animation (forge-anim) ----

    /// A body (a skinned GLB's bytes, meshopt decoded) for animation. → its id.
    pub fn add_anim_body(&self, bytes: &[u8]) -> Result<u32, JsValue> {
        self.s.borrow_mut().core.sim.anim.library.add_body(bytes).map(|i| i as u32).map_err(err)
    }
    /// A clip set (a GLB's animations: the gf-humanoid-1 clip file, or a model's own). → its id.
    pub fn add_anim_clips(&self, bytes: &[u8]) -> Result<u32, JsValue> {
        self.s.borrow_mut().core.sim.anim.library.add_clips(bytes).map(|i| i as u32).map_err(err)
    }
    pub fn anim_bone_count(&self, body: u32) -> u32 {
        self.s.borrow().core.sim.anim.library.bodies.get(body as usize).map(|b| b.joints.len() as u32).unwrap_or(0)
    }
    pub fn anim_bone_name(&self, body: u32, j: u32) -> String {
        self.s.borrow().core.sim.anim.library.bodies.get(body as usize).and_then(|b| b.joints.get(j as usize)).map(|j| j.name.clone()).unwrap_or_default()
    }
    /// Animate the entity with this net id: `body` playing `clips`; `hurt` true gives it the body's ragdoll-part
    /// hurtbox on its bones. → false when it does not exist.
    pub fn animate(&self, net: u32, body: u32, clips: u32, hurt: bool) -> Result<bool, JsValue> {
        let mut s = self.s.borrow_mut();
        let sim = &mut s.core.sim;
        let Some(e) = sim.entity_of(net) else { return Ok(false) };
        let group = if sim.world.get::<&forge_core::components::Player>(e).is_ok() { forge_core::physics::groups::PLAYER } else { forge_core::physics::groups::ENEMY };
        sim.animate(e, body as usize, clips as usize, hurt.then_some(group)).map_err(err)?;
        Ok(true)
    }
    /// Play a clip on an animated entity (`fade` seconds; `layer` 0 the clip's own, 1 base, 2 upper). → false when it
    /// has no animator or the clip set no such clip.
    pub fn anim_play(&self, net: u32, clip: &str, fade: f32, layer: u32, looping: i32) -> bool {
        let mut s = self.s.borrow_mut();
        let sim = &mut s.core.sim;
        let Some(e) = sim.entity_of(net) else { return false };
        let lib = &sim.anim.library;
        let Ok(mut a) = sim.world.get::<&mut forge_core::sim::Animated>(e) else { return false };
        let layer = match layer {
            1 => Some(forge_anim_layer::Base),
            2 => Some(forge_anim_layer::Upper),
            _ => None,
        };
        let looping = if looping < 0 { None } else { Some(looping != 0) };
        a.animator.play(lib, clip, forge_core::forge_anim::Play { fade: fade.max(0.0), layer, looping, ..Default::default() })
    }

    // ---- the scene ----

    /// A model from a slot file's GLB bytes. → its id. Its images wait for `set_model_image`.
    pub fn add_model(&self, bytes: &[u8]) -> Result<u32, JsValue> {
        let data = glb::parse(bytes).map_err(err)?;
        Ok(self.s.borrow_mut().gfx.scene.add_model(data) as u32)
    }
    pub fn model_image_count(&self, model: u32) -> u32 {
        self.s.borrow().gfx.scene.models.get(model as usize).map(|m| m.images.len() as u32).unwrap_or(0)
    }
    pub fn model_image_mime(&self, model: u32, i: u32) -> String {
        self.s.borrow().gfx.scene.models.get(model as usize).and_then(|m| m.images.get(i as usize)).map(|r| r.mime.clone()).unwrap_or_default()
    }
    pub fn model_image_bytes(&self, model: u32, i: u32) -> Vec<u8> {
        self.s.borrow().gfx.scene.models.get(model as usize).and_then(|m| m.images.get(i as usize)).map(|r| r.bytes.clone()).unwrap_or_default()
    }
    /// One of a model's images, decoded by the host (RGBA, top row first).
    pub fn set_model_image(&self, model: u32, i: u32, w: u32, h: u32, rgba: &[u8]) -> Result<(), JsValue> {
        let t = TexData::from_rgba(w, h, rgba).map_err(err)?;
        let mut s = self.s.borrow_mut();
        let scene = &mut s.gfx.scene;
        if model as usize >= scene.models.len() {
            return Err(err("no such model"));
        }
        let id = scene.add_texture(t);
        let m = &mut scene.models[model as usize];
        if let Some(slot) = m.image_tex.get_mut(i as usize) {
            *slot = Some(id);
            m.images[i as usize].bytes = Vec::new();
        }
        Ok(())
    }
    /// Point one of a model's images at a texture already uploaded (the same picture in several models: one copy).
    pub fn link_model_image(&self, model: u32, i: u32, tex: u32) -> Result<(), JsValue> {
        let mut s = self.s.borrow_mut();
        let scene = &mut s.gfx.scene;
        if tex as usize >= scene.textures.len() {
            return Err(err("no such texture"));
        }
        let m = scene.models.get_mut(model as usize).ok_or_else(|| err("no such model"))?;
        if let Some(slot) = m.image_tex.get_mut(i as usize) {
            *slot = Some(tex as usize);
            m.images[i as usize].bytes = Vec::new();
        }
        Ok(())
    }
    /// The texture one of a model's images became (−1 while it waits for the host).
    pub fn model_image_texture(&self, model: u32, i: u32) -> i32 {
        self.s.borrow().gfx.scene.models.get(model as usize).and_then(|m| m.image_tex.get(i as usize).copied().flatten()).map(|t| t as i32).unwrap_or(-1)
    }
    /// A texture (a texture slot's image, decoded by the host). → its id.
    pub fn add_texture(&self, w: u32, h: u32, rgba: &[u8]) -> Result<u32, JsValue> {
        let t = TexData::from_rgba(w, h, rgba).map_err(err)?;
        Ok(self.s.borrow_mut().gfx.scene.add_texture(t) as u32)
    }
    /// Draw `tex` in place of every base-colour image of `model` (−1: its own again).
    pub fn set_model_texture(&self, model: u32, tex: i32) {
        let mut s = self.s.borrow_mut();
        let n = s.gfx.scene.textures.len();
        if let Some(m) = s.gfx.scene.models.get_mut(model as usize) {
            m.tex_override = if tex >= 0 && (tex as usize) < n { Some(tex as usize) } else { None };
        }
    }
    pub fn model_triangles(&self, model: u32) -> u32 {
        self.s.borrow().gfx.scene.models.get(model as usize).map(|m| m.triangles).unwrap_or(0)
    }
    /// The model's box in its own frame: min x y z, max x y z.
    pub fn model_bounds(&self, model: u32) -> Vec<f32> {
        self.s.borrow().gfx.scene.models.get(model as usize).map(|m| vec![m.min.x, m.min.y, m.min.z, m.max.x, m.max.y, m.max.z]).unwrap_or_default()
    }
    /// Place a model: `slot` is the index of its slot id in the host's slot table (verify's coverage counts an instance
    /// without one, `u32::MAX`, as untagged); `m` its 16-float column-major transform. → the instance id.
    pub fn add_instance(&self, model: u32, slot: u32, m: &[f32]) -> Result<u32, JsValue> {
        let mut s = self.s.borrow_mut();
        if model as usize >= s.gfx.scene.models.len() {
            return Err(err("no such model"));
        }
        let transform = mat(m)?;
        s.gfx.scene.instances.push(Instance { model: model as usize, slot, transform, visible: true, tint: [1.0; 4], unlit: false, backdrop: false });
        Ok(s.gfx.scene.instances.len() as u32 - 1)
    }
    pub fn set_instance_transform(&self, i: u32, m: &[f32]) -> Result<(), JsValue> {
        let t = mat(m)?;
        if let Some(x) = self.s.borrow_mut().gfx.scene.instances.get_mut(i as usize) {
            x.transform = t;
        }
        Ok(())
    }
    pub fn set_instance_visible(&self, i: u32, visible: bool) {
        if let Some(x) = self.s.borrow_mut().gfx.scene.instances.get_mut(i as usize) {
            x.visible = visible;
        }
    }
    pub fn set_instance_unlit(&self, i: u32, unlit: bool) {
        if let Some(x) = self.s.borrow_mut().gfx.scene.instances.get_mut(i as usize) {
            x.unlit = unlit;
        }
    }
    pub fn set_instance_tint(&self, i: u32, r: f32, g: f32, b: f32, a: f32) {
        if let Some(x) = self.s.borrow_mut().gfx.scene.instances.get_mut(i as usize) {
            x.tint = [r, g, b, a];
        }
    }
    pub fn instance_count(&self) -> u32 {
        self.s.borrow().gfx.scene.instances.len() as u32
    }
    pub fn clear_instances(&self) {
        self.s.borrow_mut().gfx.scene.instances.clear();
    }
    pub fn no_slot(&self) -> u32 {
        NO_SLOT
    }
    /// Every look value, packed (colours linear): sky rgb, fog rgb, fog near, fog far, ambient rgb, ambient intensity,
    /// sun direction xyz, sun rgb, sun intensity, exposure, render scale, pixelated (0/1).
    pub fn set_look(&self, v: &[f32]) -> Result<(), JsValue> {
        if v.len() < 22 {
            return Err(err("set_look needs 22 values"));
        }
        let mut s = self.s.borrow_mut();
        let l = &mut s.gfx.scene.look;
        l.sky = [v[0], v[1], v[2]];
        l.fog = [v[3], v[4], v[5]];
        l.fog_near = v[6];
        l.fog_far = v[7];
        l.ambient = [v[8], v[9], v[10]];
        l.ambient_intensity = v[11];
        l.sun_dir = [v[12], v[13], v[14]];
        l.sun_color = [v[15], v[16], v[17]];
        l.sun_intensity = v[18];
        l.exposure = v[19];
        l.render_scale = v[20].clamp(0.1, 1.0);
        l.pixelated = v[21] > 0.5;
        render::look_ext(l, v);
        Ok(())
    }
    /// The point lights (at most 8), eight floats each: x, y, z, range, r, g, b (linear), intensity.
    pub fn set_lights(&self, v: &[f32]) {
        let lights = v.chunks_exact(8).take(forge_render::MAX_LIGHTS).map(|c| PointLight { pos: [c[0], c[1], c[2]], range: c[3], color: [c[4], c[5], c[6]], intensity: c[7] }).collect();
        self.s.borrow_mut().gfx.scene.lights = lights;
    }
    pub fn set_lens(&self, fov_deg: f32, near: f32, far: f32) {
        let mut s = self.s.borrow_mut();
        let c = &mut s.gfx.scene.camera;
        c.fov_deg = fov_deg;
        c.near = near;
        c.far = far;
    }
    /// Look from the local player's eyes (true: the core's camera every frame), or from `set_camera_pose`.
    pub fn use_core_camera(&self, on: bool) {
        self.s.borrow_mut().core_camera = on;
    }
    pub fn set_camera_pose(&self, x: f32, y: f32, z: f32, yaw: f32, pitch: f32) {
        let mut s = self.s.borrow_mut();
        let c = &mut s.gfx.scene.camera;
        c.eye = forge_core::glam::Vec3::new(x, y, z);
        c.yaw = yaw;
        c.pitch = pitch;
    }
    /// The camera drawn last: eye x y z, yaw, pitch, fov (degrees).
    pub fn camera(&self) -> Vec<f32> {
        let s = self.s.borrow();
        let c = &s.gfx.scene.camera;
        vec![c.eye.x, c.eye.y, c.eye.z, c.yaw, c.pitch, c.fov_deg]
    }

    // ---- the frame ----

    /// The canvas's drawing buffer, in pixels.
    pub fn resize(&self, width: u32, height: u32) {
        self.s.borrow_mut().gfx.resize(width, height);
    }
    pub fn max_dimension(&self) -> u32 {
        self.s.borrow().gfx.max_dimension()
    }
    pub fn render(&self, time: f32) -> Result<(), JsValue> {
        let mut s = self.s.borrow_mut();
        let st = &mut *s;
        // the local player's eyes, with the feel's kick and punch on top (forge-core views::camera)
        let c = &st.core.views.camera;
        if st.core_camera && c[views::camera::PLAYER] > 0.0 {
            let cam = &mut st.gfx.scene.camera;
            cam.eye = forge_core::glam::Vec3::new(c[views::camera::X], c[views::camera::Y], c[views::camera::Z]);
            cam.yaw = c[views::camera::YAW];
            cam.pitch = c[views::camera::PITCH];
            if c[views::camera::FOV] > 1.0 {
                cam.fov_deg = c[views::camera::FOV];
            }
        }
        st.gfx.scene.time = time;
        render::before_frame(st);
        let r = st.gfx.render();
        for e in st.gfx.take_errors() {
            web_sys::console::error_1(&JsValue::from_str(&format!("gf-forge GPU error: {e}")));
        }
        r.map_err(err)
    }
    pub fn frames(&self) -> f64 {
        self.s.borrow().gfx.frames as f64
    }
    pub fn draws(&self) -> u32 {
        self.s.borrow().gfx.draws
    }

    // ---- the observation interface's readbacks ----

    /// Per instance, 12 floats: slot (−1 none), visible, screen area (px), on screen, triangles, distance, world box
    /// min xyz, max xyz. The camera and size are the last frame's.
    pub fn report(&self) -> Vec<f32> {
        let s = self.s.borrow();
        let (w, h) = s.gfx.size();
        s.gfx.scene.report(w as f32, h as f32)
    }
    /// Draw the slot-ID passes from the current camera (all, and only `slots`) and start reading them back.
    pub fn request_sight(&self, slots: &[u32]) -> Result<(), JsValue> {
        self.s.borrow_mut().gfx.request_sight(slots).map_err(err)
    }
    /// 0 idle, 1 reading, 2 ready, 3 failed.
    pub fn sight_state(&self) -> u8 {
        self.s.borrow().gfx.sight_state()
    }
    /// The two ID images (all, then only the asked slots), `sight_size()` each, top row first: slot index + 1.
    pub fn take_sight(&self) -> Option<Vec<u32>> {
        self.s.borrow_mut().gfx.take_sight()
    }
    pub fn sight_size(&self) -> Vec<u32> {
        vec![forge_render::SIGHT_W, forge_render::SIGHT_H]
    }

    // ---- device loss ----

    pub fn lost(&self) -> bool {
        self.s.borrow().gfx.is_lost()
    }
    pub fn recoveries(&self) -> u32 {
        self.s.borrow().recoveries
    }
    /// QA: destroy the device, as a driver reset would.
    pub fn debug_lose_device(&self) {
        self.s.borrow().gfx.debug_lose_device();
    }
    /// The host saw the device go: the WebGL2 build's canvas fired `webglcontextlost` (wgpu's GL backend does not say
    /// so itself). `lost()` is true from here until `recover()`.
    pub fn mark_lost(&self) {
        self.s.borrow().gfx.mark_lost();
    }
    /// After a loss: a new adapter and device, the canvas configured again, every mesh and texture uploaded again.
    /// (The WebGL2 build: only once the canvas has fired `webglcontextrestored`; host.js waits for it.)
    pub fn recover(&self) -> js_sys::Promise {
        let s = self.s.clone();
        wasm_bindgen_futures::future_to_promise(async move {
            let (instance, canvas, surface) = {
                let mut st = s.borrow_mut();
                let surface = st.gfx.detach();
                if cfg!(feature = "webgl2") {
                    // a WebGL2 context that was lost and restored has forgotten its extensions (the float targets
                    // among them): a new instance on the same canvas asks for them again
                    drop(surface);
                    st.instance = new_instance();
                    (st.instance.clone(), st.canvas.clone(), None)
                } else {
                    (st.instance.clone(), st.canvas.clone(), surface)
                }
            };
            let (adapter, device, queue, surface) = open_gpu(&instance, &canvas, surface).await?;
            let mut st = s.borrow_mut();
            st.gfx.attach(&adapter, device, queue, surface, canvas.width().max(1), canvas.height().max(1));
            st.recoveries += 1;
            Ok(JsValue::from(st.recoveries))
        })
    }
    /// What the device this build draws on can do (forge-render `Caps`): the HDR scene (0: the 8-bit one), verify's
    /// float vertex capture, and the largest texture side.
    pub fn render_caps(&self) -> Vec<f32> {
        let s = self.s.borrow();
        vec![s.gfx.caps.hdr as u8 as f32, s.gfx.caps.float_capture as u8 as f32, s.gfx.max_dimension() as f32]
    }
    /// The adapter, the canvas format and the limits asked for.
    pub fn info(&self) -> String {
        let s = self.s.borrow();
        format!("{} · canvas {} · max texture {}", s.adapter, s.gfx.format, s.gfx.max_dimension())
    }
}

fn mat(m: &[f32]) -> Result<forge_core::glam::Mat4, JsValue> {
    if m.len() < 16 || m.iter().take(16).any(|x| !x.is_finite()) {
        return Err(err("a transform is 16 finite floats"));
    }
    Ok(forge_core::glam::Mat4::from_cols_slice(&m[..16]))
}
