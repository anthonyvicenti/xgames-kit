//! gf-forge's renderer (research/rust-engine/PLAN.md §2 and §4 track R): a wgpu forward renderer.
//!
//! What it draws each frame (core/ARCHITECTURE.md "Rendering"):
//! - **Static models** (`Instance`, placed by the host) and **actors**: skinned bodies posed by forge-anim (the core's
//!   animated entities, or the host's puppets), GPU-skinned from one bone-palette texture and instanced where bodies
//!   share a mesh; rigid models **attached** to their bones (held weapons); and the **first-person layer** (arms and
//!   the weapon in camera space with their own field of view, drawn after the world on a cleared depth so they never
//!   cut into walls).
//! - **Lights:** the moon (a directional light with one shadow map, sized by the look) and up to 32 point lights a frame:
//!   the host's (torches, braziers: flicker is the look's) and short **flashes** from LIGHT events (muzzle, impact).
//! - **The look stack**, every value a `look.*` slot (`look::Look`): a sky with the moon, exponential fog, an HDR
//!   target, particles, bloom (extract and two blurs at a quarter size), the tone curve and gamma, and the retro pass
//!   (render scale and a detail cap, square texels, grain, dither, colour steps, optional vertex snap), then FXAA.
//! - **Particles** (`particles`): billboards from PARTICLES events, the host, and emitters over fires.
//! - **Hit flash and emissive** per actor (`Actor::flash`, `Actor::glow`: the `glow_eyes` material's colour).
//! - **For verify:** the slot-ID pass (`request_sight`) covers static models, actors, attachments and the first-person
//!   layer; `Scene::report` gives every drawn item's slot and screen area (coverage); `request_capture` reads back an
//!   actor's skinned vertices as the GPU skins them (check 19).
//!
//! Everything drawn is kept on the CPU (`Scene`), so a new device after a loss gets it all again (`attach`). Only
//! what also exists under WebGL2 (PLAN §9, decision 3): no compute, no storage buffers (the bone palette is a float
//! texture), uniform bindings ≤ 16 KiB, content textures ≤ 2048 px, 13 vertex attributes, 7 inter-stage variables.
pub mod actors;
pub mod glb;
mod gpu;
pub mod look;
pub mod particles;

use glam::{Mat4, Quat, Vec3, Vec4};
use std::sync::atomic::{AtomicU8, AtomicU32, Ordering};
use std::sync::{Arc, Mutex};

pub use look::Look;
pub use particles::{Kind, Particles, KINDS};

/// Point lights the host may set (torches, braziers).
pub const MAX_LIGHTS: usize = 32;
/// Point lights one frame shades (flashes first, then the nearest; the look's `lights.max` may say fewer).
pub const MAX_SHADER_LIGHTS: usize = 32;
pub const MAX_TEXTURE: u32 = 2048;
/// Fire lights that may cast a shadow at once (`look.fire.shadows`): six faces each in one depth atlas.
pub const MAX_FIRE_SHADOWS: usize = 4;
/// Tracers alive at once (the oldest go first).
pub const MAX_TRACERS: usize = 96;
pub const SIGHT_W: u32 = 192;
pub const SIGHT_H: u32 = 108;
/// An instance with no slot (coverage reports it as untagged).
pub const NO_SLOT: u32 = u32::MAX;
/// The fx atlas: FX_GRID × FX_GRID cells of FX_CELL px, one per particle kind.
pub const FX_CELL: u32 = 128;
pub const FX_GRID: u32 = 4;
/// Layers: the world, then the first-person layer on a cleared depth.
pub const LAYER_WORLD: u8 = 0;
pub const LAYER_FP: u8 = 1;

pub const SIGHT_IDLE: u8 = 0;
pub const SIGHT_PENDING: u8 = 1;
pub const SIGHT_READY: u8 = 2;
pub const SIGHT_FAILED: u8 = 3;

#[derive(Clone, Copy, Debug, Default)]
pub struct PointLight {
    pub pos: [f32; 3],
    pub range: f32,
    pub color: [f32; 3],
    pub intensity: f32,
}

/// A short-lived light (a LIGHT event): full intensity, falling to nothing over its life.
#[derive(Clone, Copy, Debug)]
pub struct Flash {
    pub pos: Vec3,
    pub color: [f32; 3],
    pub radius: f32,
    pub intensity: f32,
    pub life: f32,
    pub age: f32,
}

impl Flash {
    pub fn now(&self) -> f32 {
        self.intensity * (1.0 - self.age / self.life.max(1e-4)).clamp(0.0, 1.0)
    }
}

#[derive(Clone, Copy, Debug)]
pub struct Camera {
    pub eye: Vec3,
    pub yaw: f32,
    pub pitch: f32,
    pub fov_deg: f32,
    pub near: f32,
    pub far: f32,
    pub roll: f32,
}

impl Default for Camera {
    fn default() -> Self {
        Self { eye: Vec3::new(0.0, 1.6, 0.0), yaw: 0.0, pitch: 0.0, fov_deg: 72.0, near: 0.05, far: 200.0, roll: 0.0 }
    }
}

impl Camera {
    /// Where it looks (yaw 0 looks down −Z; +yaw turns left; +pitch looks up), as forge-core's player.
    pub fn dir(&self) -> Vec3 {
        let (sy, cy) = self.yaw.sin_cos();
        let (sp, cp) = self.pitch.sin_cos();
        Vec3::new(-sy * cp, sp, -cy * cp)
    }
    pub fn view(&self) -> Mat4 {
        let v = glam::camera::rh::view::look_to_mat4(self.eye, self.dir(), Vec3::Y);
        if self.roll != 0.0 { Mat4::from_rotation_z(-self.roll) * v } else { v }
    }
    pub fn proj(&self, aspect: f32) -> Mat4 {
        proj(self.fov_deg, aspect, self.near, self.far)
    }
    pub fn view_proj(&self, aspect: f32) -> Mat4 {
        self.proj(aspect) * self.view()
    }
}

/// A perspective projection, depth 0..1 (WebGPU's clip space).
pub fn proj(fov_deg: f32, aspect: f32, near: f32, far: f32) -> Mat4 {
    glam::camera::rh::proj::directx::perspective(fov_deg.clamp(10.0, 150.0).to_radians(), aspect.max(0.01), near.max(0.001), far.max(near + 0.1))
}

/// A texture on the CPU with its whole mip chain (box filtered), ≤ MAX_TEXTURE on each side.
#[derive(Clone, Debug)]
pub struct TexData {
    pub w: u32,
    pub h: u32,
    pub levels: Vec<Vec<u8>>,
}

impl TexData {
    pub fn from_rgba(w: u32, h: u32, rgba: &[u8]) -> Result<Self, String> {
        if w == 0 || h == 0 || rgba.len() != (w * h * 4) as usize {
            return Err(format!("a {w}x{h} texture needs {} bytes of RGBA, got {}", w as u64 * h as u64 * 4, rgba.len()));
        }
        let (mut w, mut h, mut cur) = (w, h, rgba.to_vec());
        // larger than the WebGL2 bound: halved until it fits (the host normally scales it on decode)
        while w > MAX_TEXTURE || h > MAX_TEXTURE {
            let (nw, nh, next) = half(w, h, &cur);
            w = nw;
            h = nh;
            cur = next;
        }
        let (bw, bh) = (w, h);
        let mut levels = vec![cur];
        while w > 1 || h > 1 {
            let (nw, nh, next) = half(w, h, levels.last().unwrap());
            w = nw;
            h = nh;
            levels.push(next);
        }
        Ok(Self { w: bw, h: bh, levels })
    }
    pub fn white() -> Self {
        Self { w: 1, h: 1, levels: vec![vec![255, 255, 255, 255]] }
    }
    /// Sample level 0 at (u, v) with a bilinear filter (clamped): for building the fx atlas.
    fn sample(&self, u: f32, v: f32) -> [f32; 4] {
        let (w, h) = (self.w as f32, self.h as f32);
        let x = (u * w - 0.5).clamp(0.0, w - 1.0);
        let y = (v * h - 0.5).clamp(0.0, h - 1.0);
        let (x0, y0) = (x.floor() as u32, y.floor() as u32);
        let (x1, y1) = ((x0 + 1).min(self.w - 1), (y0 + 1).min(self.h - 1));
        let (fx, fy) = (x - x0 as f32, y - y0 as f32);
        let px = &self.levels[0];
        let at = |x: u32, y: u32, c: usize| px[((y * self.w + x) * 4) as usize + c] as f32;
        let mut out = [0f32; 4];
        for (c, o) in out.iter_mut().enumerate() {
            let a = at(x0, y0, c) * (1.0 - fx) + at(x1, y0, c) * fx;
            let b = at(x0, y1, c) * (1.0 - fx) + at(x1, y1, c) * fx;
            *o = a * (1.0 - fy) + b * fy;
        }
        out
    }
}

fn half(w: u32, h: u32, px: &[u8]) -> (u32, u32, Vec<u8>) {
    let (nw, nh) = ((w / 2).max(1), (h / 2).max(1));
    let mut out = vec![0u8; (nw * nh * 4) as usize];
    for y in 0..nh {
        for x in 0..nw {
            for c in 0..4 {
                let mut s = 0u32;
                for (dx, dy) in [(0, 0), (1, 0), (0, 1), (1, 1)] {
                    let sx = (x * 2 + dx).min(w - 1);
                    let sy = (y * 2 + dy).min(h - 1);
                    s += px[((sy * w + sx) * 4 + c) as usize] as u32;
                }
                out[((y * nw + x) * 4 + c) as usize] = ((s + 2) / 4) as u8;
            }
        }
    }
    (nw, nh, out)
}

#[derive(Clone, Debug)]
pub struct ModelPrim {
    pub mesh: usize,
    pub local: Mat4,
    pub base: [f32; 4],
    pub image: Option<usize>,
    /// Emissive colour × strength, linear (HDR).
    pub emissive: [f32; 3],
    /// Its material takes an actor's glow (`glow_eyes`).
    pub glow: bool,
    /// Its material takes an actor's cloth colour (`tint_*`, or one the file's `gfTint` names: the player colour).
    pub cloth: bool,
    /// Its emissive is × its picture (an emissive map: the Meshy art's glow_tip, glow_coals, glow_flame).
    pub emissive_map: bool,
    /// Its emissive map when that is another picture than its base colour's (an index into the model's images).
    pub emissive_image: Option<usize>,
    /// Under a `gfHidden` node (its name): drawn only by an item that shows it (a gun's `flash_muzzle` on a shot).
    pub hidden: Option<String>,
    pub double_sided: bool,
    pub mask: bool,
    /// The node the mesh hangs on.
    pub node: usize,
    /// Skinned (bones index the body's palette range once bound).
    pub skinned: bool,
    /// The file skin it is skinned by.
    pub skin_index: Option<usize>,
    /// Once bound: where its skin's bones start in the model's bone list (`Model::bones`); its JOINTS_0 count from
    /// there.
    pub bone_offset: u32,
}

#[derive(Clone, Debug)]
pub struct Model {
    pub prims: Vec<ModelPrim>,
    /// The model's own images, still encoded, for the host to decode.
    pub images: Vec<glb::ImageRef>,
    /// The texture each image became once the host decoded it.
    pub image_tex: Vec<Option<usize>>,
    /// A texture slot drawn in place of every base-colour image (a game's texture slot over a model's own).
    pub tex_override: Option<usize>,
    pub min: Vec3,
    pub max: Vec3,
    pub triangles: u32,
    pub nodes: Vec<glb::NodeData>,
    pub skins: Vec<Vec<usize>>,
    pub skin_ibms: Vec<Vec<Mat4>>,
    /// Bound to a body's skeleton (`Scene::bind_body`).
    pub bound: bool,
    /// Once bound, the palette an actor of this model needs, in order: (the body's joint, the matrix after its world
    /// matrix) — every file skin's joints with that skin's own inverse bind matrices, then one entry per rigid piece
    /// on a joint (the inverse of that joint's place in the file). An actor's palette entry i = world[joint] × matrix.
    pub bones: Vec<(usize, Mat4)>,
    /// How far its cloth materials go toward the player colour (the file's `gfTintMix`; 0.85 without one).
    pub tint_mix: f32,
    /// How its pictures lie on it, when the world says so (`Surface`: a tiling ground or wall); None: its own UVs.
    pub surface: Option<Surface>,
}

/// How a model's picture lies on it (track L1, wave 2: what the world's ground and walls give, kit/render.js
/// `surface`). The picture itself is the model's texture override (`Model::tex_override`) or its own.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Surface {
    /// Metres one repeat of the picture covers (0: unknown; the mesh's own UV density is measured instead).
    pub tile: f32,
    /// The picture is laid in world space (x/z on what faces up or down, the height on walls), every `tile` metres,
    /// so neighbours line up whatever their own UVs; false: the mesh's UVs, one unit of them `tile` metres wide.
    pub world: bool,
    /// Texels a metre for the retro look on this surface (0: the look's `retro.density`).
    pub density: f32,
    /// Its emissive picture (a texture id) and colour × strength, linear (None: the file's own).
    pub emissive_tex: Option<usize>,
    pub emissive: [f32; 3],
}

impl Model {
    /// A node's transform in the model, with `over` replacing some nodes' locals (None hides them).
    fn node_world(&self, mut n: usize, over: &[(usize, Option<Mat4>)]) -> Option<Mat4> {
        let mut m = Mat4::IDENTITY;
        for _ in 0..=self.nodes.len() {
            let Some(node) = self.nodes.get(n) else { break };
            let local = match over.iter().find(|(k, _)| *k == n) {
                Some((_, Some(x))) => *x,
                Some((_, None)) => return None,
                None => node.local,
            };
            m = local * m;
            match node.parent {
                Some(p) => n = p,
                None => break,
            }
        }
        Some(m)
    }
    pub fn node_named(&self, name: &str) -> Option<usize> {
        self.nodes.iter().position(|n| n.name == name)
    }
    /// A node's transform in the model (its file pose).
    pub fn node_pose(&self, name: &str) -> Option<Mat4> {
        self.node_named(name).and_then(|n| self.node_world(n, &[]))
    }
}

#[derive(Clone, Copy, Debug)]
pub struct Instance {
    pub model: usize,
    pub slot: u32,
    pub transform: Mat4,
    pub visible: bool,
    pub tint: [f32; 4],
    pub unlit: bool,
    /// The backdrop layer (trees and ruins beyond the walls: kit/render.js `backdrop`): it casts no shadow, takes the
    /// moon and the ambient light only (no fire reaches it), its fog is thickened by `look.backdrop.fog`, and it is
    /// not drawn past `look.backdrop.distance`.
    pub backdrop: bool,
}

/// A skinned body drawn this frame (rebuilt every frame by the host glue: the core's animated entities and the
/// host's puppets). `bones` is where its skin matrices start in `Scene::palette`.
#[derive(Clone, Copy, Debug)]
pub struct Actor {
    /// The net id (core actors) or the puppet id + 1_000_000 (for the report and the capture).
    pub id: u32,
    pub model: usize,
    pub slot: u32,
    pub transform: Mat4,
    pub bones: u32,
    pub tint: [f32; 4],
    /// The hit flash: rgb and how far toward it (0..1).
    pub flash: [f32; 4],
    /// The `glow_eyes` material's colour × intensity (None: the file's own).
    pub glow: Option<[f32; 3]>,
    /// The `tint_*` materials' colour (the player colour).
    pub cloth: Option<[f32; 3]>,
    pub visible: bool,
    pub shadow: bool,
    /// Wave 7: a rim of light over the whole body (rgb linear, strength; 0: none): an elite's modifier read at a glance.
    pub rim: [f32; 4],
}

/// A rigid model drawn at a transform this frame (a held weapon on a hand bone).
#[derive(Clone, Copy, Debug)]
pub struct Attached {
    pub id: u32,
    pub model: usize,
    pub slot: u32,
    pub transform: Mat4,
    pub tint: [f32; 4],
    pub flash: [f32; 4],
    pub visible: bool,
}

/// A streak of light along a line (a hitscan round, a pellet, a beam, a round in flight): drawn as one camera-facing
/// strip, added to the scene (it blooms).
#[derive(Clone, Copy, Debug)]
pub struct Tracer {
    pub from: Vec3,
    pub to: Vec3,
    pub color: [f32; 3],
    /// Metres across (the look's `tracer.width` at least; never under about a pixel and a half on screen).
    pub width: f32,
    /// Seconds it lives at least (a short line shows whole for this long).
    pub life: f32,
    pub age: f32,
    /// m/s its head crosses the line at (0: the whole line at once: a beam).
    pub speed: f32,
}

impl Tracer {
    /// The lit stretch now: (tail, head, brightness 0..1), or None once it is over. A streak's tail runs from `from` to
    /// `to` at `speed` with `length` metres lit ahead of it (so the first frame already shows it at the muzzle); a
    /// line too short to be seen for `life` seconds at that speed is crossed more slowly. A beam (speed 0) is its
    /// whole line, fading over `life`.
    pub fn segment(&self, length: f32) -> Option<(Vec3, Vec3, f32)> {
        let d = self.to - self.from;
        let dist = d.length();
        if dist < 1e-3 || self.age < 0.0 {
            return None;
        }
        if self.speed <= 0.0 {
            if self.age >= self.life {
                return None;
            }
            return Some((self.from, self.to, 1.0 - self.age / self.life.max(1e-4)));
        }
        let dir = d / dist;
        let speed = self.speed.min(dist / (0.6 * self.life).max(1e-3));
        let tail = speed * self.age;
        if tail >= dist {
            return None;
        }
        let head = (tail + length).min(dist);
        Some((self.from + dir * tail, self.from + dir * head, 1.0))
    }
    /// Whether it is over (for dropping it).
    pub fn over(&self) -> bool {
        self.segment(1.0).is_none() && self.age >= 0.0
    }
}

/// The weapon in the first-person hand.
#[derive(Clone, Copy, Debug)]
pub struct FpWeapon {
    pub model: usize,
    pub slot: u32,
    /// Where the grip sits in camera space (the catalog's `hold.arm_r`).
    pub hold: Vec3,
    /// The left hand goes on the weapon's `socket_grip_l`; else the left arm is hidden.
    pub two_handed: bool,
}

/// The first-person layer: arms and the weapon in camera space (the eye at the origin looking down −Z), drawn after
/// the world on a cleared depth with their own field of view.
#[derive(Clone, Copy, Debug)]
pub struct FpLayer {
    pub visible: bool,
    /// Vertical field of view (degrees; 0: the look's `fp.fov`).
    pub fov: f32,
    pub arms: Option<(usize, u32)>,
    pub weapon: Option<FpWeapon>,
    /// The whole rig's offset in camera space (kick, sway, bob, reload poses: track F).
    pub pose: Mat4,
    pub sleeve: Option<[f32; 3]>,
    pub flash: [f32; 4],
    /// Seconds the weapon's hidden muzzle flash (its `flash_muzzle` node) still shows: a shot sets it (2–4 frames).
    pub muzzle_left: f32,
    /// The weapon swung over the gun (the quick melee) or in hand mid-swing: drawn at `swing_pose` (camera space, in
    /// place of its hold); None: no swing.
    pub swing: Option<(FpWeapon, Mat4)>,
}

impl Default for FpLayer {
    fn default() -> Self {
        Self { visible: true, fov: 0.0, arms: None, weapon: None, pose: Mat4::IDENTITY, sleeve: None, flash: [0.0; 4], muzzle_left: 0.0, swing: None }
    }
}

/// The first-person rig this frame, in camera space: each piece's transform (and nodes hidden or moved), and the
/// weapon's sockets.
#[derive(Clone, Debug, Default)]
pub struct FpRig {
    pub arms: Option<(Mat4, Vec<(usize, Option<Mat4>)>)>,
    pub weapon: Option<Mat4>,
    pub muzzle: Option<Vec3>,
    pub tip: Option<Vec3>,
    pub grip: Option<Vec3>,
}

/// Everything drawn, on the CPU: what a new device is given after a loss.
#[derive(Default)]
pub struct Scene {
    pub meshes: Vec<glb::MeshData>,
    pub textures: Vec<TexData>,
    pub models: Vec<Model>,
    pub instances: Vec<Instance>,
    pub look: Look,
    pub lights: Vec<PointLight>,
    /// Lights that move with something this frame (a caster's orb), rebuilt every frame by the host glue: lit like the
    /// host's lights, but no fire's embers or smoke rise from them.
    pub moving_lights: Vec<PointLight>,
    pub camera: Camera,
    pub time: f32,
    pub flashes: Vec<Flash>,
    pub actors: Vec<Actor>,
    pub attached: Vec<Attached>,
    /// Where the loose pieces start in `attached` this frame (the host glue pushes what hangs on sockets first, then
    /// the core's rigid entities: a kill's debris, coins, pickups, orbs). From there on the look's `pieces.*` say how
    /// far a piece is drawn and how far it casts a shadow. None: no loose pieces.
    pub pieces_from: Option<usize>,
    /// The skin matrices of every actor this frame (world × inverse bind, in the body's model space).
    pub palette: Vec<Mat4>,
    pub fp: FpLayer,
    pub particles: Particles,
    /// Per particle kind, its picture (an `fx.*` slot), packed into the fx atlas.
    pub fx: Vec<Option<TexData>>,
    pub fx_version: u32,
    /// Streaks alive now (`add_tracer`; they age in `advance_tracers`).
    pub tracers: Vec<Tracer>,
    /// This frame's streaks behind rounds in flight (tail, head, colour, width), rebuilt every frame by the host glue.
    pub streaks: Vec<(Vec3, Vec3, [f32; 3], f32)>,
    /// The canvas's width over its height at the last frame drawn (0 before the first).
    pub aspect: f32,
}

/// One drawn thing this frame (a static instance, an actor, an attachment, a first-person piece).
#[derive(Clone, Debug)]
pub(crate) struct Item {
    pub model: usize,
    pub slot: u32,
    pub xform: Mat4,
    pub tint: [f32; 4],
    pub flash: [f32; 4],
    pub glow: Option<[f32; 3]>,
    pub cloth: Option<[f32; 3]>,
    pub bones: Option<u32>,
    pub layer: u8,
    pub unlit: bool,
    pub shadow: bool,
    pub nodes: Vec<(usize, Option<Mat4>)>,
    /// Draw what hangs under its `gfHidden` nodes too (the first-person weapon while its muzzle flash shows).
    pub show_hidden: bool,
    /// Its row's name in the report: 0 instance, 1 actor, 2 attachment, 3 first person; and its index or id.
    pub what: (u8, u32),
    /// The backdrop layer (`Instance::backdrop`).
    pub backdrop: bool,
    /// A small loose piece (`Attached::piece`).
    pub piece: bool,
    /// Wave 7: the rim of light over it (`Actor::rim`; zero for everything else).
    pub rim: [f32; 4],
}

/// One primitive of one item, ready for the GPU.
#[repr(C)]
#[derive(Clone, Copy, Debug, bytemuck::Pod, bytemuck::Zeroable)]
pub(crate) struct InstData {
    pub m: [[f32; 4]; 4],
    pub tint: [f32; 4],
    pub flash: [f32; 4],
    pub emissive: [f32; 4],
    pub extra: [u32; 4],
    /// The surface: x the retro texel grid (texels across one unit of its UVs; 0: the picture's own), y the tile in
    /// metres when the picture is laid in world space (0: the mesh's UVs), zw unused.
    pub surf: [f32; 4],
}

/// Wave 7: an item's rim packed into its instance's `extra.w` (the capture's first pixel there only for verify's capture
/// records, which never shade): r g b as bytes of the colour over its largest part, the top byte the strength (that
/// largest part × the strength, 32 a unit: up to about 8). 0: none. mesh.wgsl `rim_of` unpacks it.
pub(crate) fn pack_rim(rim: [f32; 4]) -> u32 {
    let peak = rim[0].max(rim[1]).max(rim[2]);
    let k = peak * rim[3];
    if !(peak > 1e-4) || !(k > 1e-3) {
        return 0;
    }
    let b = |x: f32| ((x / peak).clamp(0.0, 1.0) * 255.0).round() as u32;
    let s = ((k * 32.0).round() as u32).clamp(1, 255);
    b(rim[0]) | b(rim[1]) << 8 | b(rim[2]) << 16 | s << 24
}

pub(crate) const VARIANT_SKINNED: u8 = 1;
pub(crate) const VARIANT_TWO_SIDED: u8 = 2;
pub(crate) const FLAG_UNLIT: u32 = 1;
pub(crate) const FLAG_MASK: u32 = 4;
/// The backdrop layer: the moon and the ambient light only, thicker fog.
pub(crate) const FLAG_BACKDROP: u32 = 8;
/// Its emissive is × the picture bound as the emissive map (another picture than the base colour's).
pub(crate) const FLAG_EMISSIVE_TEX: u32 = 16;

#[derive(Clone, Copy, Debug)]
pub(crate) struct Rec {
    pub layer: u8,
    pub variant: u8,
    pub mesh: usize,
    pub tex: Option<usize>,
    /// The emissive picture when it is its own texture.
    pub etex: Option<usize>,
    pub slot: u32,
    pub shadow: bool,
    pub inst: InstData,
}

/// A run of records drawn with one call (the same layer, pipeline, mesh and texture).
#[derive(Clone, Copy, Debug)]
pub(crate) struct Run {
    pub layer: u8,
    pub variant: u8,
    pub mesh: usize,
    pub tex: Option<usize>,
    pub etex: Option<usize>,
    pub start: u32,
    pub count: u32,
    pub shadow: bool,
}

/// What a frame leaves out of its lists (`Scene::records_for`): the camera's frustum, the moon's shadow box and the
/// look's distances.
pub(crate) struct Cull {
    /// The world camera's projection × view (the frustum the main pass keeps).
    pub view_proj: Mat4,
    /// The moon's shadow projection × view and whether shadows are on (what the shadow pass keeps).
    pub shadow_vp: Option<Mat4>,
    pub eye: Vec3,
    /// The fires that cast a shadow this frame: where each is and how far it reaches (what their faces keep).
    pub fires: Vec<(Vec3, f32)>,
}

/// A frame's records: what the world and first-person passes draw, and what the moon's shadow pass draws.
#[derive(Default)]
pub(crate) struct Frame {
    pub main: Vec<Rec>,
    pub shadow: Vec<Rec>,
    /// What stands within reach of a fire that casts a shadow (drawn into its cube faces).
    pub fire: Vec<Rec>,
    /// Items left out of the main pass (off screen, or past their layer's distance).
    pub culled: u32,
}

/// What the device a renderer is attached to can draw into (wave 3, track W: the WebGL2 build meets devices that lack
/// what WebGPU guarantees). `Renderer::attach` asks the adapter; the host reports it (`render_caps`, kit/render.js
/// `caps()`), and kit/look.js `BACKEND_TIERS` says in words what each missing thing costs the picture.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Caps {
    /// Rgba16Float is a render target that blends: the HDR scene, bloom and the meter's float texel. Without it (WebGL2
    /// with neither EXT_color_buffer_float nor EXT_color_buffer_half_float) the scene is 8 bits a channel, exposed and
    /// toned as it is drawn, with no bloom (common.wgsl "the 8-bit scene").
    pub hdr: bool,
    /// Rgba32Float is a render target: verify's vertex capture (check 19). Without it `request_capture` says so.
    pub float_capture: bool,
}

impl Default for Caps {
    fn default() -> Self {
        Self { hdr: true, float_capture: true }
    }
}

/// What a frame drew (`Renderer::stats`).
#[derive(Clone, Copy, Debug, Default)]
pub struct Stats {
    pub draws: u32,
    pub passes: u32,
    pub instances: u32,
    pub actors: u32,
    pub particles: u32,
    pub lights: u32,
    pub flashes: u32,
    pub shadow: u32,
    pub bloom: bool,
    pub width: u32,
    pub height: u32,
    pub palette: u32,
    /// Wave 2: streaks drawn, items left out of the main pass, instances in the moon's shadow pass, fire shadow
    /// faces drawn this frame and fires casting.
    pub tracers: u32,
    pub culled: u32,
    pub casters: u32,
    pub fire_faces: u32,
    pub fire_casters: u32,
}

impl Scene {
    pub fn add_model(&mut self, data: glb::ModelData) -> usize {
        let mut prims = Vec::new();
        let mut triangles = 0u32;
        for p in data.prims {
            // what a hidden node hides is not counted (a gun's muzzle flash is not part of the gun's shape)
            if p.hidden.is_none() {
                triangles += (p.mesh.indices.len() / 3) as u32;
            }
            let skinned = p.mesh.skin.is_some();
            self.meshes.push(p.mesh);
            prims.push(ModelPrim {
                mesh: self.meshes.len() - 1,
                local: p.local,
                base: p.base,
                image: p.image,
                emissive: p.emissive,
                glow: p.material == "glow_eyes",
                cloth: p.material.starts_with("tint_") || data.tint.contains(&p.material),
                emissive_map: p.emissive_map,
                emissive_image: p.emissive_image,
                hidden: p.hidden.and_then(|n| data.nodes.get(n)).map(|n| n.name.clone()),
                double_sided: p.double_sided,
                mask: p.alpha_cutoff.is_some(),
                node: p.node,
                skinned,
                skin_index: p.skin,
                bone_offset: 0,
            });
        }
        let n = data.images.len();
        self.models.push(Model { prims, images: data.images, image_tex: vec![None; n], tex_override: None, min: data.min, max: data.max, triangles, nodes: data.nodes, skins: data.skins, skin_ibms: data.skin_ibms, bound: false, bones: Vec::new(), tint_mix: data.tint_mix.unwrap_or(0.85), surface: None });
        self.models.len() - 1
    }
    pub fn add_texture(&mut self, t: TexData) -> usize {
        self.textures.push(t);
        self.textures.len() - 1
    }

    /// Bind a model to a body's skeleton, given the body joint each node of the file is (None: not a joint). The
    /// model's bone list (`Model::bones`) is every file skin's joints with that skin's own inverse bind matrices, so a
    /// body whose skins differ there (KayKit: one skin per piece) draws whole; each skinned primitive points at its
    /// skin's run of it. A rigid mesh hanging under a joint (a helmet on the Head) becomes skinned to that joint alone,
    /// through the inverse of the joint's place in the file. Call before it is first drawn.
    pub fn bind_body(&mut self, model: usize, joint_of_node: &dyn Fn(usize) -> Option<usize>) -> Result<(), String> {
        let m = self.models.get(model).ok_or("no such model")?.clone();
        if m.bound {
            return Ok(());
        }
        let mut bones: Vec<(usize, Mat4)> = Vec::new();
        let mut skin_at = Vec::new();
        for (s, joints) in m.skins.iter().enumerate() {
            skin_at.push(bones.len() as u32);
            for (k, node) in joints.iter().enumerate() {
                let ibm = m.skin_ibms.get(s).and_then(|v| v.get(k)).copied().unwrap_or(Mat4::IDENTITY);
                bones.push((joint_of_node(*node).unwrap_or(0), ibm));
            }
        }
        for (k, p) in m.prims.iter().enumerate() {
            if self.meshes[p.mesh].skin.is_some() {
                let si = p.skin_index.unwrap_or(0);
                self.models[model].prims[k].bone_offset = skin_at.get(si).copied().ok_or_else(|| format!("the body has no skin {si}"))?;
                continue;
            }
            // a rigid piece: the nearest joint above its node carries it
            let mut n = Some(p.node);
            let mut found = None;
            while let Some(x) = n {
                if let Some(j) = joint_of_node(x) {
                    found = Some((x, j));
                    break;
                }
                n = m.nodes.get(x).and_then(|d| d.parent);
            }
            if let Some((jn, j)) = found {
                let mesh = &mut self.meshes[p.mesh];
                glb::bake(mesh, p.local);
                let count = mesh.vertices.len();
                mesh.skin = Some(vec![glb::SkinVertex { joints: [0, 0, 0, 0], weights: [1.0, 0.0, 0.0, 0.0] }; count]);
                let joint_file = m.node_world(jn, &[]).unwrap_or(Mat4::IDENTITY);
                let mm = &mut self.models[model];
                mm.prims[k].local = Mat4::IDENTITY;
                mm.prims[k].skinned = true;
                mm.prims[k].bone_offset = bones.len() as u32;
                bones.push((j, joint_file.inverse()));
            }
        }
        let mm = &mut self.models[model];
        mm.bones = bones;
        mm.bound = true;
        Ok(())
    }

    /// An actor's palette from its body's bone world matrices this frame (model space): appended to `palette`.
    /// → where it starts (the actor's `bones`).
    pub fn push_palette(palette: &mut Vec<Mat4>, model: &Model, world: &[Mat4]) -> u32 {
        let base = palette.len() as u32;
        for (j, m) in &model.bones {
            palette.push(world.get(*j).copied().unwrap_or(Mat4::IDENTITY) * *m);
        }
        base
    }

    /// The fx atlas: every kind's picture scaled into its cell (FX_CELL px; FX_GRID × FX_GRID cells). None: no
    /// pictures (every kind is a shader shape). → the atlas and each kind's cell (−1: none).
    pub fn fx_atlas(&self) -> (Option<TexData>, Vec<i32>) {
        let mut cells = vec![-1i32; KINDS.len()];
        if self.fx.iter().all(|f| f.is_none()) {
            return (None, cells);
        }
        let side = FX_CELL * FX_GRID;
        let mut px = vec![0u8; (side * side * 4) as usize];
        for (k, f) in self.fx.iter().enumerate().take((FX_GRID * FX_GRID) as usize) {
            let Some(t) = f else { continue };
            cells[k] = k as i32;
            let (cx, cy) = (k as u32 % FX_GRID, k as u32 / FX_GRID);
            for y in 0..FX_CELL {
                for x in 0..FX_CELL {
                    let s = t.sample((x as f32 + 0.5) / FX_CELL as f32, (y as f32 + 0.5) / FX_CELL as f32);
                    let at = (((cy * FX_CELL + y) * side + cx * FX_CELL + x) * 4) as usize;
                    for c in 0..4 {
                        px[at + c] = s[c].round().clamp(0.0, 255.0) as u8;
                    }
                }
            }
        }
        (TexData::from_rgba(side, side, &px).ok(), cells)
    }

    /// The first-person rig in camera space: the arms moved so their grip sits at the weapon's hold, the left arm on
    /// a long gun's second grip (or hidden), the weapon in the right hand, all under `fp.pose`; and the weapon's
    /// sockets.
    pub fn fp_rig(&self) -> FpRig {
        let fp = &self.fp;
        let mut rig = FpRig::default();
        if !fp.visible {
            return rig;
        }
        let pose = fp.pose;
        // the right hand's grip, in camera space: the arms' own socket_grip moved to the weapon's hold
        let arms = fp.arms.and_then(|(m, _)| self.models.get(m));
        let grip_rest = arms.and_then(|a| a.node_pose("socket_grip"));
        let (grip, arm_r_shift) = match (fp.weapon, grip_rest) {
            (Some(w), Some(g)) => {
                let shift = w.hold - g.w_axis.truncate();
                (Mat4::from_translation(shift) * g, shift)
            }
            (Some(w), None) => (Mat4::from_translation(w.hold) * Mat4::from_rotation_y(std::f32::consts::PI), w.hold),
            (None, Some(g)) => (g, Vec3::ZERO),
            (None, None) => (Mat4::from_translation(Vec3::new(0.13, -0.17, -0.34)) * Mat4::from_rotation_y(std::f32::consts::PI), Vec3::ZERO),
        };
        let mut weapon_m = None;
        if let Some(w) = fp.weapon
            && let Some(model) = self.models.get(w.model)
        {
            // the weapon's grip socket on the hand's grip (its origin is the grip unless a socket says otherwise)
            let own = model.node_pose("socket_grip").unwrap_or(Mat4::IDENTITY);
            let wm = pose * grip * own.inverse();
            rig.muzzle = model.node_pose("socket_muzzle").map(|s| (wm * s).w_axis.truncate());
            rig.tip = model.node_pose("socket_tip").map(|s| (wm * s).w_axis.truncate());
            rig.grip = Some((pose * grip).w_axis.truncate());
            weapon_m = Some(wm);
        }
        rig.weapon = weapon_m;
        if let Some(a) = arms {
            let mut over: Vec<(usize, Option<Mat4>)> = Vec::new();
            if let Some(r) = a.node_named("arm_r") {
                over.push((r, Some(Mat4::from_translation(arm_r_shift) * a.nodes[r].local)));
            }
            if let Some(l) = a.node_named("arm_l") {
                let two = fp.weapon.is_some_and(|w| w.two_handed);
                let target = fp.weapon.and_then(|w| self.models.get(w.model)).and_then(|m| m.node_pose("socket_grip_l"));
                let rest = a.node_pose("socket_grip_l");
                match (two, target, rest, weapon_m) {
                    (true, Some(t), Some(r), Some(wm)) => {
                        // the left arm moved so its grip lands on the weapon's second grip (camera space, before pose)
                        let want = (pose.inverse() * wm * t).w_axis.truncate();
                        over.push((l, Some(Mat4::from_translation(want - r.w_axis.truncate()) * a.nodes[l].local)));
                    }
                    (true, _, _, _) => {}
                    _ => over.push((l, None)),
                }
            }
            rig.arms = Some((pose, over));
        }
        rig
    }

    /// Every item drawn this frame: static instances (in their order: the host's instance ids), actors, attachments,
    /// then the first-person pieces (in camera space × the inverse view: world space for lighting).
    pub(crate) fn items(&self) -> Vec<Item> {
        let mut out = Vec::with_capacity(self.instances.len() + self.actors.len() + self.attached.len() + 2);
        for (i, inst) in self.instances.iter().enumerate() {
            if !inst.visible || inst.model >= self.models.len() {
                continue;
            }
            out.push(Item { model: inst.model, slot: inst.slot, xform: inst.transform, tint: inst.tint, flash: [0.0; 4], glow: None, cloth: None, bones: None, layer: LAYER_WORLD, unlit: inst.unlit, shadow: !inst.unlit && !inst.backdrop, nodes: Vec::new(), show_hidden: false, what: (0, i as u32), backdrop: inst.backdrop, piece: false, rim: [0.0; 4] });
        }
        for a in self.actors.iter().filter(|a| a.visible && a.model < self.models.len()) {
            let bones = if self.models[a.model].bound { Some(a.bones) } else { None };
            out.push(Item { model: a.model, slot: a.slot, xform: a.transform, tint: a.tint, flash: a.flash, glow: a.glow, cloth: a.cloth, bones, layer: LAYER_WORLD, unlit: false, shadow: a.shadow, nodes: Vec::new(), show_hidden: false, what: (1, a.id), backdrop: false, piece: false, rim: a.rim });
        }
        for (k, a) in self.attached.iter().enumerate().filter(|(_, a)| a.visible && a.model < self.models.len()) {
            let piece = self.pieces_from.is_some_and(|from| k >= from);
            out.push(Item { model: a.model, slot: a.slot, xform: a.transform, tint: a.tint, flash: a.flash, glow: None, cloth: None, bones: None, layer: LAYER_WORLD, unlit: false, shadow: true, nodes: Vec::new(), show_hidden: false, what: (2, a.id), backdrop: false, piece, rim: [0.0; 4] });
        }
        let rig = self.fp_rig();
        let to_world = self.camera.view().inverse();
        if let (Some((pose, nodes)), Some((m, slot))) = (rig.arms, self.fp.arms)
            && m < self.models.len()
        {
            out.push(Item { model: m, slot, xform: to_world * pose, tint: [1.0; 4], flash: self.fp.flash, glow: None, cloth: self.fp.sleeve, bones: None, layer: LAYER_FP, unlit: false, shadow: false, nodes, show_hidden: false, what: (3, 0), backdrop: false, piece: false, rim: [0.0; 4] });
        }
        if let (Some(wm), Some(w)) = (rig.weapon, self.fp.weapon)
            && w.model < self.models.len()
        {
            out.push(Item { model: w.model, slot: w.slot, xform: to_world * wm, tint: [1.0; 4], flash: self.fp.flash, glow: None, cloth: None, bones: None, layer: LAYER_FP, unlit: false, shadow: false, nodes: Vec::new(), show_hidden: self.fp.muzzle_left > 0.0, what: (3, 1), backdrop: false, piece: false, rim: [0.0; 4] });
        }
        // the weapon swung (the quick melee over the gun, a melee weapon's swing): at its swing pose, under the rig's
        if let Some((w, pose)) = self.fp.swing
            && self.fp.visible
            && w.model < self.models.len()
        {
            let own = self.models[w.model].node_pose("socket_grip").unwrap_or(Mat4::IDENTITY);
            out.push(Item { model: w.model, slot: w.slot, xform: to_world * self.fp.pose * pose * own.inverse(), tint: [1.0; 4], flash: self.fp.flash, glow: None, cloth: None, bones: None, layer: LAYER_FP, unlit: false, shadow: false, nodes: Vec::new(), show_hidden: false, what: (3, 2), backdrop: false, piece: false, rim: [0.0; 4] });
        }
        out
    }

    /// One item's primitives as GPU records, pushed to `out`.
    fn push_records(&self, it: &Item, out: &mut Vec<Rec>) {
        let m = &self.models[it.model];
        let look = &self.look;
        for p in &m.prims {
            if p.hidden.is_some() && !it.show_hidden {
                continue;
            }
            let local = if p.skinned && it.bones.is_some() {
                Mat4::IDENTITY
            } else if it.nodes.is_empty() {
                p.local
            } else {
                match m.node_world(p.node, &it.nodes) {
                    Some(x) => x,
                    None => continue,
                }
            };
            let tex = m.tex_override.or_else(|| p.image.and_then(|i| m.image_tex.get(i).copied().flatten()));
            let mut base = [p.base[0] * it.tint[0], p.base[1] * it.tint[1], p.base[2] * it.tint[2], p.base[3] * it.tint[3]];
            if p.cloth
                && let Some(c) = it.cloth
            {
                for k in 0..3 {
                    base[k] = base[k] * (1.0 - m.tint_mix) + c[k] * m.tint_mix;
                }
            }
            let mut e = match (p.glow, it.glow) {
                (true, Some(g)) => g,
                _ => p.emissive,
            };
            // the emissive picture: the surface's own (the world's ground and walls), else the file's second picture;
            // the file's base picture stands in when the file says its emissive map is that one
            let mut etex = p.emissive_image.and_then(|i| m.image_tex.get(i).copied().flatten());
            if let Some(sf) = m.surface
                && let Some(t) = sf.emissive_tex
            {
                etex = Some(t);
                e = sf.emissive;
            }
            let skinned = p.skinned && it.bones.is_some();
            let variant = (if skinned { VARIANT_SKINNED } else { 0 }) | (if p.double_sided { VARIANT_TWO_SIDED } else { 0 });
            let flags = (if it.unlit { FLAG_UNLIT } else { 0 }) | (if p.mask { FLAG_MASK } else { 0 }) | (if it.backdrop { FLAG_BACKDROP } else { 0 }) | (if etex.is_some() { FLAG_EMISSIVE_TEX } else { 0 });
            let slot1 = if it.slot == NO_SLOT { 0 } else { it.slot + 1 };
            let world = it.xform * local;
            // the surface: a tiling picture laid in world space says its tile; the retro texel grid is texels across
            // one unit of the surface's UVs at the look's density (texels a metre). A tiling surface says how many
            // metres a unit is; any other mesh was measured when it loaded (`MeshData::uv_per_m`) and is scaled by
            // where it stands. 0: the picture's own texels.
            let mut surf = [0f32; 4];
            let (tile, world_space, own) = match m.surface {
                Some(sf) => (sf.tile.max(0.0), sf.world && sf.tile > 0.0, sf.density),
                None => (0.0, false, 0.0),
            };
            if world_space {
                surf[1] = tile;
            }
            // a tiling surface takes the world's density (one the world named, or a mesh whose own UVs repeat its
            // picture); anything unwrapped onto its own picture the models' (finer: a prop or a body must stay
            // readable), and what is in the first-person hand the hand's (finer again: it fills the screen)
            let density = if own > 0.0 {
                own
            } else if tile > 0.0 || (m.surface.is_none() && self.meshes[p.mesh].uv_tiles && it.layer == LAYER_WORLD) {
                look.retro_density
            } else if it.layer == LAYER_FP {
                look.retro_hand
            } else {
                look.retro_models
            };
            // (the grid is the picture's resolution as the look wants it, with the retro option on or off: on, its texels
            // are square; off, the same texels filtered smooth, as a low-resolution picture is)
            if density > 0.0 {
                if tile > 0.0 {
                    surf[0] = density * tile;
                } else {
                    let per_m = self.meshes[p.mesh].uv_per_m;
                    let scale = glam::Mat3::from_mat4(world).determinant().abs().cbrt();
                    if per_m > 1e-6 && scale > 1e-6 {
                        surf[0] = density * scale / per_m;
                    }
                }
            }
            out.push(Rec {
                layer: it.layer,
                variant,
                mesh: p.mesh,
                tex,
                etex,
                slot: it.slot,
                shadow: it.shadow,
                // emissive.w 1: × the picture (an emissive map); an actor's own glow replaces the file's flat colour
                inst: InstData { m: world.to_cols_array_2d(), tint: base, flash: it.flash, emissive: [e[0], e[1], e[2], if p.emissive_map || etex.is_some() { 1.0 } else { 0.0 }], extra: [slot1, flags, it.bones.unwrap_or(0) + p.bone_offset, pack_rim(it.rim)], surf },
            });
        }
    }

    /// Each item's primitives as GPU records: every one, in the items' order (the slot-ID pass, the tests).
    pub(crate) fn records(&self, items: &[Item]) -> Vec<Rec> {
        let mut recs = Vec::new();
        for it in items {
            self.push_records(it, &mut recs);
        }
        recs
    }

    /// An item's bounding sphere in the world (its model's box at its place).
    fn sphere_of(&self, it: &Item) -> (Vec3, f32) {
        let m = &self.models[it.model];
        let c = it.xform.transform_point3((m.min + m.max) * 0.5);
        let scale = it.xform.x_axis.truncate().length().max(it.xform.y_axis.truncate().length()).max(it.xform.z_axis.truncate().length());
        (c, (m.max - m.min).length() * 0.5 * scale)
    }

    /// A frame's records with what cannot be seen left out. The main list drops static instances and rigid pieces
    /// outside the camera's frustum, backdrop instances past `look.backdrop.distance` and loose pieces past
    /// `look.pieces.distance`; the shadow list keeps only casters whose sphere reaches the moon's shadow box, and no
    /// loose piece past `look.pieces.shadow`. Bodies and the first-person layer are never culled (a pose leaves its
    /// bind box).
    pub(crate) fn records_for(&self, items: &[Item], cull: &Cull) -> Frame {
        let look = &self.look;
        let planes = frustum_planes(&cull.view_proj);
        let mut f = Frame::default();
        for it in items {
            let rigid = it.bones.is_none() && it.layer == LAYER_WORLD;
            let (c, r) = if rigid { self.sphere_of(it) } else { (Vec3::ZERO, 0.0) };
            let d = if rigid { c.distance(cull.eye) } else { 0.0 };
            let mut seen = true;
            if rigid {
                if it.backdrop && look.backdrop_distance > 0.0 && d - r > look.backdrop_distance {
                    seen = false;
                }
                if it.piece && look.pieces_distance > 0.0 && d - r > look.pieces_distance {
                    seen = false;
                }
                if seen && planes.iter().any(|p| p.truncate().dot(c) + p.w < -r) {
                    seen = false;
                }
            }
            if seen {
                self.push_records(it, &mut f.main);
            } else {
                f.culled += 1;
            }
            if it.shadow
                && it.layer == LAYER_WORLD
                && let Some(svp) = cull.shadow_vp
            {
                let mut casts = true;
                if rigid {
                    if it.piece && look.pieces_shadow > 0.0 && d - r > look.pieces_shadow {
                        casts = false;
                    }
                    // the shadow box is orthographic: a sphere reaches it when its centre is within its radius of a side
                    let q = svp * c.extend(1.0);
                    let rx = r * svp.x_axis.truncate().length().max(svp.y_axis.truncate().length());
                    if q.x.abs() > 1.0 + rx || q.y.abs() > 1.0 + rx {
                        casts = false;
                    }
                }
                if casts {
                    self.push_records(it, &mut f.shadow);
                }
            }
            // a fire's shadow: whatever casts and stands within its reach (a body by where it stands)
            if it.shadow && it.layer == LAYER_WORLD && !cull.fires.is_empty() {
                let (c, r) = if rigid { (c, r) } else { (it.xform.w_axis.truncate() + Vec3::Y, 1.5) };
                let near_piece = !it.piece || look.pieces_shadow <= 0.0 || c.distance(cull.eye) - r <= look.pieces_shadow;
                // (not what holds the fire: a small thing the light sits inside, its brazier or torch, would shut it in)
                let casts = |p: &Vec3, reach: f32| p.distance(c) - r < reach && !(rigid && r < 2.5 && p.distance(c) < r);
                if near_piece && cull.fires.iter().any(|(p, reach)| casts(p, *reach)) {
                    self.push_records(it, &mut f.fire);
                }
            }
        }
        f
    }

    /// The fire lights that cast a shadow this frame (`look.fire.shadows` of the host's lights, the nearest the eye
    /// first): where each is and how far it reaches. A fire that cast last frame (`held`: where those are) counts as
    /// 2 m nearer, so two fires about as far from the eye do not take turns (each turn draws five faces again).
    pub fn fire_casters(&self, held: &[Vec3]) -> Vec<(Vec3, f32)> {
        let n = (self.look.fire_shadows as usize).min(MAX_FIRE_SHADOWS);
        if n == 0 || self.look.fire_shadow_strength <= 0.0 {
            return Vec::new();
        }
        let eye = self.camera.eye;
        let mut ls: Vec<(Vec3, f32)> = self.lights.iter().filter(|l| l.intensity > 0.0 && l.range > 0.0).map(|l| (Vec3::from(l.pos), l.range)).collect();
        let far = |p: Vec3| p.distance(eye) - if held.iter().any(|h| h.distance(p) < 0.05) { 2.0 } else { 0.0 };
        ls.sort_by(|a, b| far(a.0).partial_cmp(&far(b.0)).unwrap_or(std::cmp::Ordering::Equal));
        ls.truncate(n);
        ls
    }

    /// A streak for `seconds` at least (forge-feel's TRACER event; kit/render.js `tracer`). A beam is its whole line,
    /// fading; anything else a streak crossing the line at the look's `tracer.speed`.
    pub fn add_tracer(&mut self, from: Vec3, to: Vec3, color: [f32; 3], width: f32, seconds: f32, beam: bool) {
        if self.tracers.len() >= MAX_TRACERS {
            self.tracers.remove(0);
        }
        let speed = if beam { 0.0 } else { self.look.tracer_speed };
        self.tracers.push(Tracer { from, to, color, width, life: seconds.max(1.0 / 120.0), age: 0.0, speed });
    }

    /// Age the streaks by `dt` and drop those that are over.
    pub fn advance_tracers(&mut self, dt: f32) {
        let len = self.look.tracer_length;
        for t in self.tracers.iter_mut() {
            t.age += dt;
        }
        self.tracers.retain(|t| t.segment(len).is_some());
    }

    /// The streaks as particle instances (`particles::SHAPE_BEAM`: the head and half its width; the tail from the
    /// head; colour × the look's glow; added): appended to `out`. → how many.
    pub(crate) fn write_tracers(&self, out: &mut Vec<f32>) -> u32 {
        let look = &self.look;
        let mut n = 0;
        let put = |tail: Vec3, head: Vec3, c: [f32; 3], width: f32, k: f32, out: &mut Vec<f32>| {
            let g = look.tracer_glow * k;
            let w = width.max(look.tracer_width) * 0.5;
            let v = tail - head;
            out.extend_from_slice(&[head.x, head.y, head.z, w, v.x, v.y, v.z, 0.0, c[0] * g, c[1] * g, c[2] * g, 1.0, -1.0, 1.0, 0.0, particles::SHAPE_BEAM as f32]);
        };
        for t in &self.tracers {
            if let Some((tail, head, k)) = t.segment(look.tracer_length) {
                put(tail, head, t.color, t.width, k, out);
                n += 1;
            }
        }
        for (tail, head, c, w) in &self.streaks {
            put(*tail, *head, *c, *w, 1.0, out);
            n += 1;
        }
        n
    }

    /// The lights a frame shades: live flashes first (brightest first), then the host's lights nearest the eye.
    pub fn frame_lights(&self) -> Vec<[f32; 8]> {
        let cap = (self.look.max_lights as usize).min(MAX_SHADER_LIGHTS);
        let mut out: Vec<[f32; 8]> = Vec::with_capacity(cap);
        let mut fl: Vec<&Flash> = self.flashes.iter().filter(|f| f.age < f.life && f.now() > 0.0).collect();
        fl.sort_by(|a, b| b.now().partial_cmp(&a.now()).unwrap_or(std::cmp::Ordering::Equal));
        for f in fl.into_iter().take(cap) {
            out.push([f.pos.x, f.pos.y, f.pos.z, f.radius, f.color[0], f.color[1], f.color[2], f.now()]);
        }
        let eye = self.camera.eye;
        let mut ls: Vec<&PointLight> = self.lights.iter().chain(self.moving_lights.iter()).filter(|l| l.intensity > 0.0 && l.range > 0.0).collect();
        ls.sort_by(|a, b| {
            let da = Vec3::from(a.pos).distance(eye) - a.range;
            let db = Vec3::from(b.pos).distance(eye) - b.range;
            da.partial_cmp(&db).unwrap_or(std::cmp::Ordering::Equal)
        });
        for l in ls {
            if out.len() >= cap {
                break;
            }
            out.push([l.pos[0], l.pos[1], l.pos[2], l.range, l.color[0], l.color[1], l.color[2], l.intensity]);
        }
        out
    }

    /// The first-person projection × view (its own field of view).
    pub fn fp_view_proj(&self, aspect: f32) -> Mat4 {
        let fov = if self.fp.fov > 1.0 { self.fp.fov } else { self.look.fp_fov };
        proj(fov, aspect, 0.01, 20.0) * self.camera.view()
    }

    /// A first-person camera-space point → the world point that shows at the same place on screen through the world
    /// camera (for effects drawn in the world at the muzzle: the flash, the smoke, the tracer's start).
    pub fn fp_to_world(&self, cam: Vec3, aspect: f32) -> Vec3 {
        let fov = if self.fp.fov > 1.0 { self.fp.fov } else { self.look.fp_fov };
        let fp_p = proj(fov, aspect, 0.01, 20.0);
        let w_p = self.camera.proj(aspect);
        let c = fp_p * Vec4::new(cam.x, cam.y, cam.z, 1.0);
        let ndc = c.truncate() / c.w.max(1e-6);
        // the same depth along the view axis, through the world camera's lens
        let z = cam.z.min(-0.02);
        let sx = ndc.x / w_p.x_axis.x * -z;
        let sy = ndc.y / w_p.y_axis.y * -z;
        self.camera.view().inverse().transform_point3(Vec3::new(sx, sy, z))
    }

    /// Per drawn item, 12 floats: slot (−1 none), visible, screen area (px), on screen (0/1), triangles, distance (m),
    /// world box min x y z and max x y z. Static instances first, in their order (the host's instance ids), then
    /// actors, attachments and the first-person pieces. For coverage and slots() (CONTRACT §8 forge).
    pub fn report(&self, width: f32, height: f32) -> Vec<f32> {
        let aspect = width / height.max(1.0);
        let vp = self.camera.view_proj(aspect);
        let fp_vp = self.fp_view_proj(aspect);
        let mut out = Vec::with_capacity((self.instances.len() + self.actors.len() + 4) * 12);
        // every static instance keeps its row (hidden ones as not visible), so row i is instance i
        let items = self.items();
        let row = |model: usize, slot: u32, xform: Mat4, visible: bool, layer: u8, out: &mut Vec<f32>| {
            let Some(m) = self.models.get(model) else {
                out.extend_from_slice(&[-1.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0]);
                return;
            };
            let vp = if layer == LAYER_FP { fp_vp } else { vp };
            let (mut wmin, mut wmax) = (Vec3::splat(f32::MAX), Vec3::splat(f32::MIN));
            let (mut x0, mut y0, mut x1, mut y1) = (f32::MAX, f32::MAX, f32::MIN, f32::MIN);
            let mut front = 0;
            for c in glb::corners(m.min, m.max) {
                let w = xform.transform_point3(c);
                wmin = wmin.min(w);
                wmax = wmax.max(w);
                let p = vp * Vec4::new(w.x, w.y, w.z, 1.0);
                if p.w > 1e-4 {
                    front += 1;
                    let (nx, ny) = (p.x / p.w, p.y / p.w);
                    x0 = x0.min(nx);
                    y0 = y0.min(ny);
                    x1 = x1.max(nx);
                    y1 = y1.max(ny);
                }
            }
            let inside = (self.camera.eye.cmpge(wmin) & self.camera.eye.cmple(wmax)).all();
            let (on, area) = if inside {
                (true, width * height)
            } else if front == 0 || x1 < -1.0 || x0 > 1.0 || y1 < -1.0 || y0 > 1.0 {
                (false, 0.0)
            } else {
                // a box partly behind the camera reaches the screen's edge on its far side
                if front < 8 {
                    x0 = x0.min(-1.0);
                    x1 = x1.max(1.0);
                    y0 = y0.min(-1.0);
                    y1 = y1.max(1.0);
                }
                let w = (x1.min(1.0) - x0.max(-1.0)) * 0.5 * width;
                let h = (y1.min(1.0) - y0.max(-1.0)) * 0.5 * height;
                (true, (w * h).max(0.0))
            };
            let centre = (wmin + wmax) * 0.5;
            out.extend_from_slice(&[
                if slot == NO_SLOT { -1.0 } else { slot as f32 },
                if visible { 1.0 } else { 0.0 },
                if visible { area } else { 0.0 },
                if visible && on { 1.0 } else { 0.0 },
                m.triangles as f32,
                centre.distance(self.camera.eye),
                wmin.x,
                wmin.y,
                wmin.z,
                wmax.x,
                wmax.y,
                wmax.z,
            ]);
        };
        for inst in &self.instances {
            row(inst.model, inst.slot, inst.transform, inst.visible, LAYER_WORLD, &mut out);
        }
        for it in items.iter().filter(|it| it.what.0 != 0) {
            row(it.model, it.slot, it.xform, true, it.layer, &mut out);
        }
        out
    }
}

/// The six planes of a projection × view (depth 0..1), pointing inward: a point p is inside when
/// plane.xyz · p + plane.w >= 0 for each. Normalised, so a sphere is outside when one gives less than −radius.
pub(crate) fn frustum_planes(vp: &Mat4) -> [Vec4; 6] {
    let (r0, r1, r2, r3) = (vp.row(0), vp.row(1), vp.row(2), vp.row(3));
    let mut p = [r3 + r0, r3 - r0, r3 + r1, r3 - r1, r2, r3 - r2];
    for x in p.iter_mut() {
        let l = x.truncate().length();
        if l > 1e-12 {
            *x /= l;
        }
    }
    p
}

pub struct Renderer {
    pub scene: Scene,
    /// Bodies, puppets, attachments and each actor's flash and glow (the host glue fills the scene from them).
    pub glue: actors::Glue,
    gpu: Option<gpu::Gpu>,
    generation: u32,
    lost_gen: Arc<AtomicU32>,
    sight_state: Arc<AtomicU8>,
    capture_state: Arc<AtomicU8>,
    errors: Arc<Mutex<Vec<String>>>,
    pub frames: u64,
    pub draws: u32,
    pub stats: Stats,
    pub last_error: Option<String>,
    pub format: String,
    /// What the attached device can draw into (the adapter's answer, less what `force_ldr` takes away).
    pub caps: Caps,
    /// QA: draw the 8-bit scene even where the device has float targets (the host's ?gf-forge-scene=8bit), so the path
    /// a few WebGL2 devices take can be seen and measured on any machine. Read at `attach`.
    pub force_ldr: bool,
    /// The vertex count of the pending capture.
    capture_count: u32,
}

impl Default for Renderer {
    fn default() -> Self {
        Self::new()
    }
}

impl Renderer {
    pub fn new() -> Self {
        Self {
            scene: Scene::default(),
            glue: actors::Glue::default(),
            gpu: None,
            generation: 0,
            lost_gen: Arc::new(AtomicU32::new(0)),
            sight_state: Arc::new(AtomicU8::new(SIGHT_IDLE)),
            capture_state: Arc::new(AtomicU8::new(SIGHT_IDLE)),
            errors: Arc::new(Mutex::new(Vec::new())),
            frames: 0,
            draws: 0,
            stats: Stats::default(),
            last_error: None,
            format: String::new(),
            caps: Caps::default(),
            force_ldr: false,
            capture_count: 0,
        }
    }

    /// The device and surface to draw with (first time, and again after a loss): every mesh and texture is uploaded.
    pub fn attach(&mut self, adapter: &wgpu::Adapter, device: wgpu::Device, queue: wgpu::Queue, surface: wgpu::Surface<'static>, width: u32, height: u32) {
        self.generation += 1;
        let generation = self.generation;
        let lost = self.lost_gen.clone();
        device.set_device_lost_callback(move |_reason, _msg| {
            lost.store(generation, Ordering::SeqCst);
        });
        // a GPU error is reported (the host logs it: verify fails on it), never a panic that takes the wasm down
        let errors = self.errors.clone();
        device.on_uncaptured_error(Arc::new(move |e: wgpu::Error| {
            if let Ok(mut v) = errors.lock()
                && v.len() < 32
            {
                v.push(e.to_string());
            }
        }));
        self.sight_state.store(SIGHT_IDLE, Ordering::SeqCst);
        self.capture_state.store(SIGHT_IDLE, Ordering::SeqCst);
        let caps = surface.get_capabilities(adapter);
        let format = caps.formats.iter().copied().find(|f| !f.is_srgb()).or_else(|| caps.formats.first().copied()).unwrap_or(wgpu::TextureFormat::Bgra8Unorm);
        self.format = format!("{format:?}");
        // what this device can draw into: WebGPU guarantees both; WebGL2 has them by extension
        let can = |f: wgpu::TextureFormat, blend: bool| {
            let x = adapter.get_texture_format_features(f);
            x.allowed_usages.contains(wgpu::TextureUsages::RENDER_ATTACHMENT | wgpu::TextureUsages::TEXTURE_BINDING) && (!blend || x.flags.contains(wgpu::TextureFormatFeatureFlags::BLENDABLE))
        };
        self.caps = Caps { hdr: !self.force_ldr && can(wgpu::TextureFormat::Rgba16Float, true), float_capture: can(wgpu::TextureFormat::Rgba32Float, false) };
        let gpu = gpu::Gpu::new(device, queue, surface, format, width, height, &self.scene, self.caps);
        self.gpu = Some(gpu);
    }

    /// The host saw the device go (the WebGL2 build: the canvas's `webglcontextlost`; wgpu's GL backend does not
    /// report it). Nothing is drawn until `detach` and a new `attach`.
    pub fn mark_lost(&self) {
        if self.gpu.is_some() {
            self.lost_gen.store(self.generation, Ordering::SeqCst);
        }
    }

    /// The device was lost (a driver reset, a tab in the background too long, or `debug_lose_device`).
    pub fn is_lost(&self) -> bool {
        self.gpu.is_some() && self.lost_gen.load(Ordering::SeqCst) == self.generation
    }

    /// Let go of a lost device (the next `attach` builds everything again).
    pub fn detach(&mut self) -> Option<wgpu::Surface<'static>> {
        self.generation += 1;
        self.gpu.take().map(|g| g.surface)
    }

    pub fn has_gpu(&self) -> bool {
        self.gpu.is_some()
    }

    /// QA: lose the device on purpose (verify and the device-loss test). Marked lost at once, so no frame is drawn
    /// with the destroyed device before the browser's own loss notice arrives.
    pub fn debug_lose_device(&self) {
        if let Some(g) = &self.gpu {
            self.lost_gen.store(self.generation, Ordering::SeqCst);
            g.device.destroy();
        }
    }

    /// GPU errors since the last call (validation, out of memory), for the host to report.
    pub fn take_errors(&self) -> Vec<String> {
        self.errors.lock().map(|mut v| std::mem::take(&mut *v)).unwrap_or_default()
    }

    pub fn size(&self) -> (u32, u32) {
        self.gpu.as_ref().map(|g| (g.config.width, g.config.height)).unwrap_or((1, 1))
    }

    pub fn max_dimension(&self) -> u32 {
        self.gpu.as_ref().map(|g| g.max_dim).unwrap_or(MAX_TEXTURE)
    }

    /// The canvas's drawing buffer size.
    pub fn resize(&mut self, width: u32, height: u32) {
        if let Some(g) = &mut self.gpu {
            g.resize(width, height);
        }
    }

    pub fn render(&mut self) -> Result<(), String> {
        if self.is_lost() {
            return Err("the device was lost".into());
        }
        let Some(g) = &mut self.gpu else { return Ok(()) };
        self.scene.aspect = g.config.width as f32 / g.config.height.max(1) as f32;
        match g.frame(&self.scene)? {
            Some(stats) => {
                self.stats = stats;
                self.draws = stats.draws;
                self.frames += 1;
            }
            None => {}
        }
        Ok(())
    }

    /// Render the slot-ID passes from the current camera and start reading them back: pass A with everything drawn,
    /// pass B with only `slots` (what the view would show with nothing in front). `sight_state()` says when
    /// `take_sight()` has them.
    pub fn request_sight(&mut self, slots: &[u32]) -> Result<(), String> {
        let Some(g) = &mut self.gpu else { return Err("no device".into()) };
        if self.sight_state.load(Ordering::SeqCst) == SIGHT_PENDING {
            return Err("a sight read is already pending".into());
        }
        g.sight(&self.scene, slots)?;
        let state = self.sight_state.clone();
        state.store(SIGHT_PENDING, Ordering::SeqCst);
        g.sight.staging.slice(..).map_async(wgpu::MapMode::Read, move |r| {
            state.store(if r.is_ok() { SIGHT_READY } else { SIGHT_FAILED }, Ordering::SeqCst);
        });
        let _ = g.device.poll(wgpu::PollType::Poll);
        Ok(())
    }

    pub fn sight_state(&self) -> u8 {
        if let Some(g) = &self.gpu {
            let _ = g.device.poll(wgpu::PollType::Poll);
        }
        self.sight_state.load(Ordering::SeqCst)
    }

    /// The two ID images (A then B, SIGHT_W × SIGHT_H each, top row first): slot id + 1 per pixel, 0 for nothing.
    pub fn take_sight(&mut self) -> Option<Vec<u32>> {
        let g = self.gpu.as_ref()?;
        match self.sight_state.load(Ordering::SeqCst) {
            SIGHT_READY => {}
            SIGHT_FAILED => {
                self.sight_state.store(SIGHT_IDLE, Ordering::SeqCst);
                return None;
            }
            _ => return None,
        }
        let out = {
            let Ok(data) = g.sight.staging.slice(..).get_mapped_range() else {
                g.sight.staging.unmap();
                self.sight_state.store(SIGHT_IDLE, Ordering::SeqCst);
                return None;
            };
            bytemuck::cast_slice::<u8, u32>(&data).to_vec()
        };
        g.sight.staging.unmap();
        self.sight_state.store(SIGHT_IDLE, Ordering::SeqCst);
        Some(out)
    }

    /// Draw one actor's skinned vertices (as this frame poses it) into a float image, one pixel each, and start reading
    /// it back: what the GPU's skinning made of them, for verify check 19 to compare with the model judge's poses.
    /// → the vertex count.
    pub fn request_capture(&mut self, actor_id: u32) -> Result<u32, String> {
        let Some(g) = &mut self.gpu else { return Err("no device".into()) };
        if self.capture_state.load(Ordering::SeqCst) == SIGHT_PENDING {
            return Err("a capture is already pending".into());
        }
        let n = g.capture(&self.scene, actor_id)?;
        self.capture_count = n;
        let state = self.capture_state.clone();
        state.store(SIGHT_PENDING, Ordering::SeqCst);
        let Some(buf) = g.capture_buf.as_ref() else { return Err("no capture buffer".into()) };
        buf.slice(..).map_async(wgpu::MapMode::Read, move |r| {
            state.store(if r.is_ok() { SIGHT_READY } else { SIGHT_FAILED }, Ordering::SeqCst);
        });
        let _ = g.device.poll(wgpu::PollType::Poll);
        Ok(n)
    }

    pub fn capture_state(&self) -> u8 {
        if let Some(g) = &self.gpu {
            let _ = g.device.poll(wgpu::PollType::Poll);
        }
        self.capture_state.load(Ordering::SeqCst)
    }

    /// The captured vertices: x y z per vertex, in the order of the actor's model's skinned primitives.
    pub fn take_capture(&mut self) -> Option<Vec<f32>> {
        let g = self.gpu.as_ref()?;
        if self.capture_state.load(Ordering::SeqCst) != SIGHT_READY {
            if self.capture_state.load(Ordering::SeqCst) == SIGHT_FAILED {
                self.capture_state.store(SIGHT_IDLE, Ordering::SeqCst);
            }
            return None;
        }
        let buf = g.capture_buf.as_ref()?;
        let out = {
            let data = buf.slice(..).get_mapped_range().ok()?;
            let f = bytemuck::cast_slice::<u8, f32>(&data);
            let mut v = Vec::with_capacity(self.capture_count as usize * 3);
            let row = gpu::capture_row_floats();
            for i in 0..self.capture_count as usize {
                let (x, y) = (i % gpu::CAPTURE_W as usize, i / gpu::CAPTURE_W as usize);
                let at = y * row + x * 4;
                v.extend_from_slice(&f[at..at + 3]);
            }
            v
        };
        buf.unmap();
        self.capture_state.store(SIGHT_IDLE, Ordering::SeqCst);
        Some(out)
    }
}

/// An actor's skinned vertices posed on the CPU with the same matrices the GPU uses (`palette`, the actor's place):
/// what `request_capture` must agree with. x y z per vertex, the same order.
pub fn cpu_skin(scene: &Scene, actor: &Actor) -> Vec<f32> {
    let mut out = Vec::new();
    let Some(m) = scene.models.get(actor.model) else { return out };
    for p in m.prims.iter().filter(|p| p.skinned) {
        let mesh = &scene.meshes[p.mesh];
        let Some(skin) = mesh.skin.as_ref() else { continue };
        for (v, s) in mesh.vertices.iter().zip(skin.iter()) {
            let mut sm = Mat4::ZERO;
            for k in 0..4 {
                let b = scene.palette.get((actor.bones + p.bone_offset) as usize + s.joints[k] as usize).copied().unwrap_or(Mat4::IDENTITY);
                sm += b * s.weights[k];
            }
            let w = actor.transform * sm * Vec4::new(v.pos[0], v.pos[1], v.pos[2], 1.0);
            out.extend_from_slice(&[w.x, w.y, w.z]);
        }
    }
    out
}

/// A body turned to face the way an entity faces: forge-core's entities face −Z, a gf-humanoid-1 body faces +Z.
pub fn body_transform(pos: Vec3, rot: Quat, scale: f32) -> Mat4 {
    Mat4::from_scale_rotation_translation(Vec3::splat(scale), rot * Quat::from_rotation_y(std::f32::consts::PI), pos)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cube() -> glb::ModelData {
        glb::ModelData {
            prims: vec![glb::PrimData {
                mesh: glb::MeshData { vertices: vec![], indices: vec![0, 1, 2], min: Vec3::splat(-0.5), max: Vec3::splat(0.5), skin: None, uv_per_m: 0.5, uv_tiles: false },
                local: Mat4::IDENTITY,
                base: [1.0; 4],
                image: None,
                emissive: [0.0; 3],
                emissive_map: false,
                emissive_map_other: false,
                emissive_image: None,
                hidden: None,
                material: String::new(),
                double_sided: false,
                alpha_cutoff: None,
                node: 0,
                skin: None,
            }],
            images: vec![],
            min: Vec3::splat(-0.5),
            max: Vec3::splat(0.5),
            nodes: vec![glb::NodeData { name: "cube".into(), parent: None, local: Mat4::IDENTITY, hidden: false }],
            skins: vec![],
            skin_ibms: vec![],
            tint: vec![],
            tint_mix: None,
        }
    }

    #[test]
    fn a_texture_gets_its_mip_chain_and_fits_webgl2() {
        let t = TexData::from_rgba(4, 2, &[200u8; 32]).unwrap();
        assert_eq!(t.levels.len(), 3);
        assert_eq!(t.levels[2].len(), 4);
        let big = TexData::from_rgba(4096, 2, &vec![10u8; 4096 * 2 * 4]).unwrap();
        assert!(big.w <= MAX_TEXTURE && big.h >= 1);
        assert!(TexData::from_rgba(3, 3, &[0u8; 5]).is_err());
    }

    #[test]
    fn uniforms_fit_their_bindings() {
        assert!(gpu::GLOBALS_SIZE <= 16 * 1024, "{}", gpu::GLOBALS_SIZE);
        assert_eq!(gpu::GLOBALS_SIZE % 16, 0);
        assert_eq!(std::mem::size_of::<InstData>(), 144);
        assert!(std::mem::size_of::<InstData>() <= 255, "WebGL2's vertex stride");
        assert!(gpu::POST_SIZE <= 256);
    }

    #[test]
    fn the_report_sees_what_is_in_front() {
        let mut s = Scene::default();
        let m = s.add_model(cube());
        s.camera = Camera { eye: Vec3::new(0.0, 0.0, 3.0), ..Camera::default() };
        s.instances.push(Instance { model: m, slot: 4, transform: Mat4::IDENTITY, visible: true, tint: [1.0; 4], unlit: false, backdrop: false });
        s.instances.push(Instance { model: m, slot: 5, transform: Mat4::from_translation(Vec3::new(0.0, 0.0, 10.0)), visible: true, tint: [1.0; 4], unlit: false, backdrop: false });
        let r = s.report(1280.0, 720.0);
        assert_eq!(r[0], 4.0);
        assert_eq!(r[3], 1.0, "the cube in front is on screen");
        assert!(r[2] > 10_000.0);
        assert_eq!(r[12 + 3], 0.0, "the cube behind is not");
    }

    /// Wave 7: an actor's rim (an elite's modifier) rides in its records' `extra.w` (mesh.wgsl `rim_of`); nothing else
    /// carries one.
    #[test]
    fn an_actors_rim_rides_in_its_records_and_nothing_elses() {
        let mut s = Scene::default();
        let m = s.add_model(cube());
        s.instances.push(Instance { model: m, slot: 1, transform: Mat4::IDENTITY, visible: true, tint: [1.0; 4], unlit: false, backdrop: false });
        s.actors.push(Actor { id: 7, model: m, slot: 2, transform: Mat4::IDENTITY, bones: 0, tint: [1.0; 4], flash: [0.0; 4], glow: None, cloth: None, visible: true, shadow: true, rim: [1.0, 0.5, 0.0, 2.0] });
        let recs = s.records(&s.items());
        assert_eq!(recs[0].inst.extra[3], 0, "an instance: none");
        let w = recs[1].inst.extra[3];
        assert_eq!((w & 255, (w >> 8) & 255, (w >> 16) & 255, w >> 24), (255, 128, 0, 64), "the colour over its largest part, the strength at 32 a unit");
        assert_eq!(pack_rim([0.0; 4]), 0);
        assert_eq!(pack_rim([0.2, 0.2, 0.2, 100.0]) >> 24, 255, "held to the byte");
    }

    #[test]
    fn actors_and_the_first_person_layer_are_reported_and_recorded() {
        let mut s = Scene::default();
        let m = s.add_model(cube());
        s.camera = Camera { eye: Vec3::new(0.0, 1.6, 4.0), ..Camera::default() };
        s.instances.push(Instance { model: m, slot: 1, transform: Mat4::IDENTITY, visible: false, tint: [1.0; 4], unlit: false, backdrop: false });
        s.actors.push(Actor { id: 300, model: m, slot: 2, transform: Mat4::from_translation(Vec3::new(0.0, 1.0, 0.0)), bones: 0, tint: [1.0; 4], flash: [1.0, 1.0, 1.0, 0.8], glow: None, cloth: None, visible: true, shadow: true, rim: [0.0; 4] });
        s.fp.arms = Some((m, 3));
        let r = s.report(1280.0, 720.0);
        assert_eq!(r.len(), 3 * 12, "a hidden instance keeps its row; the actor and the arms follow");
        assert_eq!(r[1], 0.0);
        assert_eq!(r[12], 2.0);
        assert_eq!(r[12 + 3], 1.0, "the actor is on screen");
        assert_eq!(r[24], 3.0);
        assert_eq!(r[24 + 3], 1.0, "the arms are on screen (camera space)");
        let items = s.items();
        let recs = s.records(&items);
        assert_eq!(recs.len(), 2);
        assert_eq!(recs[0].inst.flash[3], 0.8);
        assert_eq!(recs[0].inst.extra[0], 3, "slot + 1");
        assert_eq!(recs[1].layer, LAYER_FP);
    }

    #[test]
    fn a_bound_body_skins_on_the_gpu_formula() {
        let mut s = Scene::default();
        let data = glb::parse(&glb::tests::skinned_glb()).unwrap();
        let m = s.add_model(data);
        // body joints: the file's Hips (node 0) is joint 0, Head (node 2) joint 1
        s.bind_body(m, &|n| match n {
            0 => Some(0),
            2 => Some(1),
            _ => None,
        })
        .unwrap();
        assert!(s.models[m].prims.iter().all(|p| p.skinned), "the helmet rides the Head bone");
        // pose: the Head bone (bind at 1 m) moved up 0.5 m; the palette comes from the bones' world matrices
        let world = [Mat4::IDENTITY, Mat4::from_translation(Vec3::new(0.0, 1.5, 0.0))];
        assert_eq!(Scene::push_palette(&mut s.palette, &s.models[m].clone(), &world), 0);
        assert_eq!(s.palette.len(), 3, "the skin's two joints, then the helmet's joint");
        let a = Actor { id: 1, model: m, slot: 0, transform: Mat4::IDENTITY, bones: 0, tint: [1.0; 4], flash: [0.0; 4], glow: Some([0.0, 2.0, 0.0]), cloth: None, visible: true, shadow: true, rim: [0.0; 4] };
        let v = cpu_skin(&s, &a);
        // file order: the helmet (under Hips → Head) first, then the body
        // the helmet (rigid on the Head, baked 1.2 m up) moved 0.5 with it
        assert!((v[1] - 1.7).abs() < 1e-5 && (v[4] - 2.7).abs() < 1e-5, "{v:?}");
        // the body's tip vertex (joint 1) moved 0.5 up; the half-weighted one 0.25; the root one not at all
        assert!(v[9].abs() < 1e-5 && v[10].abs() < 1e-5, "the skinned node's own placement is not applied: {v:?}");
        assert!((v[13] - 1.5).abs() < 1e-5, "{v:?}");
        assert!((v[16] - 0.25).abs() < 1e-5, "{v:?}");
        s.actors.push(a);
        let recs = s.records(&s.items());
        assert!(recs.iter().all(|r| r.variant & VARIANT_SKINNED != 0));
        assert!(recs.iter().any(|r| r.inst.emissive[1] == 2.0), "glow_eyes takes the actor's glow");
        assert!(recs.iter().any(|r| r.inst.emissive == [0.0; 4]), "the iron helmet glows not");
    }

    /// The art library after tracks C2 and C3 (the wave 1b integration): a hidden node is drawn only when shown, an
    /// emissive map multiplies the picture, and the `gfTint` material takes the player colour by the file's mix.
    #[test]
    fn hidden_nodes_emissive_maps_and_the_player_tint_are_drawn_as_the_art_says() {
        let mut s = Scene::default();
        let m = s.add_model(glb::parse(&glb::tests::art_glb()).unwrap());
        assert_eq!(s.models[m].triangles, 2, "the hidden flash is not part of the model's shape");
        assert!((s.models[m].tint_mix - 0.9).abs() < 1e-6);
        s.instances.push(Instance { model: m, slot: 4, transform: Mat4::IDENTITY, visible: true, tint: [1.0; 4], unlit: false, backdrop: false });
        let mut items = s.items();
        let recs = s.records(&items);
        assert_eq!(recs.len(), 2, "coals and cloak; the flash stays hidden");
        assert!(recs.iter().any(|r| r.inst.emissive == [2.0, 2.0, 2.0, 1.0]), "the coals' emissive is × their picture");
        // shown (a shot): three primitives
        items[0].show_hidden = true;
        assert_eq!(s.records(&items).len(), 3);
        // the cloak in a player's colour, 0.9 of the way
        items[0].show_hidden = false;
        items[0].cloth = Some([1.0, 0.0, 0.0]);
        let recs = s.records(&items);
        let cloak = recs.iter().find(|r| r.inst.emissive == [0.0; 4]).unwrap();
        assert!((cloak.inst.tint[0] - (0.1 * 0.1 + 0.9)).abs() < 1e-5 && (cloak.inst.tint[2] - 0.05).abs() < 1e-5, "{:?}", cloak.inst.tint);
    }

    #[test]
    fn flashes_light_first_and_fade() {
        let mut s = Scene::default();
        s.look.max_lights = 2;
        s.lights = vec![PointLight { pos: [50.0, 0.0, 0.0], range: 5.0, color: [1.0; 3], intensity: 8.0 }, PointLight { pos: [2.0, 0.0, 0.0], range: 5.0, color: [1.0; 3], intensity: 8.0 }];
        s.flashes.push(Flash { pos: Vec3::ZERO, color: [1.0, 0.48, 0.13], radius: 3.4, intensity: 1.8, life: 4.0 / 60.0, age: 1.0 / 60.0 });
        let l = s.frame_lights();
        assert_eq!(l.len(), 2);
        assert!((l[0][7] - 1.35).abs() < 1e-4, "a flash first, a quarter gone");
        assert_eq!(l[1][0], 2.0, "then the nearest torch");
    }

    #[test]
    fn the_first_person_muzzle_lands_where_it_shows() {
        let mut s = Scene::default();
        s.camera = Camera { eye: Vec3::new(1.0, 1.7, 2.0), yaw: 0.3, fov_deg: 68.0, ..Camera::default() };
        s.look.fp_fov = 54.0;
        let cam = Vec3::new(0.1, -0.12, -0.6);
        let w = s.fp_to_world(cam, 16.0 / 9.0);
        // project both and compare on screen
        let a = s.fp_view_proj(16.0 / 9.0) * (s.camera.view().inverse() * cam.extend(1.0));
        let b = s.camera.view_proj(16.0 / 9.0) * w.extend(1.0);
        assert!(((a.x / a.w) - (b.x / b.w)).abs() < 1e-4 && ((a.y / a.w) - (b.y / b.w)).abs() < 1e-4);
    }

    /// Wave 2: the retro texel grid. A tiling surface's grid is the look's texels a metre × its tile; a mesh with its
    /// own UVs is measured (UV units a metre) and scaled by where it stands; the first-person layer takes the hand's
    /// density; the option only says whether those texels are square or filtered smooth.
    #[test]
    fn the_texel_grid_follows_the_looks_density() {
        let mut s = Scene::default();
        let m = s.add_model(cube());
        s.look.retro_texels = true;
        s.look.retro_density = 16.0;
        s.look.retro_models = 48.0;
        s.look.retro_hand = 160.0;
        s.instances.push(Instance { model: m, slot: 0, transform: Mat4::from_scale(Vec3::splat(2.0)), visible: true, tint: [1.0; 4], unlit: false, backdrop: false });
        let recs = s.records(&s.items());
        // 0.5 UV units a metre, twice the size: a UV unit is 4 m, at 48 texels a metre
        assert!((recs[0].inst.surf[0] - 192.0).abs() < 1e-3, "{:?}", recs[0].inst.surf);
        assert_eq!(recs[0].inst.surf[1], 0.0, "its own UVs");
        // the world lays a picture on it every 3 m
        s.models[m].surface = Some(Surface { tile: 3.0, world: true, density: 0.0, emissive_tex: None, emissive: [0.0; 3] });
        let recs = s.records(&s.items());
        assert_eq!(recs[0].inst.surf[0], 48.0, "16 texels a metre × 3 m");
        assert_eq!(recs[0].inst.surf[1], 3.0, "laid in world space");
        // its own density, and an emissive picture of its own
        s.textures.push(TexData::white());
        s.models[m].surface = Some(Surface { tile: 2.0, world: false, density: 8.0, emissive_tex: Some(0), emissive: [3.0, 1.0, 0.5] });
        let recs = s.records(&s.items());
        assert_eq!((recs[0].inst.surf[0], recs[0].inst.surf[1]), (16.0, 0.0));
        assert_eq!(recs[0].etex, Some(0));
        assert_eq!(recs[0].inst.emissive, [3.0, 1.0, 0.5, 1.0]);
        assert_ne!(recs[0].inst.extra[1] & FLAG_EMISSIVE_TEX, 0);
        // in the hand
        s.models[m].surface = None;
        s.fp.arms = Some((m, 1));
        let recs = s.records(&s.items());
        assert!((recs[1].inst.surf[0] - 320.0).abs() < 1e-3, "160 texels a metre over 2 m a UV unit: {:?}", recs[1].inst.surf);
        // a mesh whose own UVs repeat its picture is a tiling surface without being told: the world's density
        s.fp.arms = None;
        let mesh = s.models[m].prims[0].mesh;
        s.meshes[mesh].uv_tiles = true;
        assert!((s.records(&s.items())[0].inst.surf[0] - 64.0).abs() < 1e-3, "16 texels a metre over 4 m a UV unit");
        s.meshes[mesh].uv_tiles = false;
        s.fp.arms = Some((m, 1));
        // the option off: the same grid (the shader filters it smooth); no density: the pictures' own texels
        s.look.retro_texels = false;
        assert!((s.records(&s.items())[1].inst.surf[0] - 320.0).abs() < 1e-3);
        s.look.retro_models = 0.0;
        s.look.retro_hand = 0.0;
        assert!(s.records(&s.items()).iter().all(|r| r.inst.surf[0] == 0.0));
    }

    #[test]
    fn a_mesh_measures_how_much_picture_a_metre_spans() {
        // a 2 m × 2 m square whose UVs cover the whole picture: half a UV unit a metre
        let v = |x: f32, z: f32, u: f32, w: f32| glb::Vertex { pos: [x, 0.0, z], normal: [0.0, 1.0, 0.0], uv: [u, w] };
        let quad = [v(0.0, 0.0, 0.0, 0.0), v(2.0, 0.0, 1.0, 0.0), v(2.0, 2.0, 1.0, 1.0), v(0.0, 2.0, 0.0, 1.0)];
        assert!((glb::uv_density(&quad, &[0, 1, 2, 0, 2, 3]) - 0.5).abs() < 1e-6);
        // every face on one point of the picture (a palette swatch): nothing to measure
        let flat = [v(0.0, 0.0, 0.3, 0.3), v(2.0, 0.0, 0.3, 0.3), v(2.0, 2.0, 0.3, 0.3)];
        assert_eq!(glb::uv_density(&flat, &[0, 1, 2]), 0.0);
        // UVs within one picture: a model's own unwrap; past a unit and a half: a tiling surface
        assert!(!glb::uv_repeats(&quad));
        let tiled = [v(0.0, 0.0, 0.0, 0.0), v(6.0, 0.0, 2.0, 0.0), v(6.0, 6.0, 2.0, 2.0)];
        assert!(glb::uv_repeats(&tiled));
    }

    /// Wave 2: what a frame leaves out. Behind the camera: not in the main list. Far from the moon's shadow box: not
    /// in the shadow list. The backdrop layer casts no shadow and stops at its distance; a loose piece stops casting
    /// at `pieces.shadow` and is not drawn past `pieces.distance`.
    #[test]
    fn a_frame_leaves_out_what_cannot_be_seen() {
        let mut s = Scene::default();
        let m = s.add_model(cube());
        s.camera = Camera { eye: Vec3::new(0.0, 1.0, 0.0), ..Camera::default() };
        let put = |s: &mut Scene, z: f32, backdrop: bool| s.instances.push(Instance { model: m, slot: 0, transform: Mat4::from_translation(Vec3::new(0.0, 0.5, z)), visible: true, tint: [1.0; 4], unlit: false, backdrop });
        put(&mut s, -5.0, false);   // ahead
        put(&mut s, 5.0, false);    // behind
        put(&mut s, -30.0, true);   // the backdrop, ahead
        put(&mut s, -90.0, true);   // the backdrop, past its distance
        s.look.backdrop_distance = 60.0;
        s.look.pieces_distance = 40.0;
        s.look.pieces_shadow = 10.0;
        let piece = |z: f32| Attached { id: 9, model: m, slot: 0, transform: Mat4::from_translation(Vec3::new(0.0, 0.1, z)), tint: [1.0; 4], flash: [0.0; 4], visible: true };
        s.attached.push(piece(-3.0));    // held: before `pieces_from`
        s.pieces_from = Some(1);
        s.attached.push(piece(-4.0));    // a piece near
        s.attached.push(piece(-20.0));   // a piece past its shadow's reach
        s.attached.push(piece(-60.0));   // a piece past its distance
        let vp = s.camera.view_proj(16.0 / 9.0);
        // the moon straight overhead, a 20 m box round the eye
        let sv = glam::camera::rh::proj::directx::orthographic(-10.0, 10.0, -10.0, 10.0, -50.0, 50.0) * glam::camera::rh::view::look_to_mat4(Vec3::ZERO, Vec3::NEG_Y, Vec3::Z);
        // one fire casting, 3 m of reach, 4 m ahead
        let f = s.records_for(&s.items(), &Cull { view_proj: vp, shadow_vp: Some(sv), eye: s.camera.eye, fires: vec![(Vec3::new(0.0, 1.0, -4.0), 3.0)] });
        let z = |r: &Rec| r.inst.m[3][2];
        let mut main: Vec<f32> = f.main.iter().map(z).collect();
        main.sort_by(f32::total_cmp);
        assert_eq!(main, vec![-30.0, -20.0, -5.0, -4.0, -3.0], "ahead and within its distance");
        assert_eq!(f.culled, 3);
        let mut shadow: Vec<f32> = f.shadow.iter().map(z).collect();
        shadow.sort_by(f32::total_cmp);
        assert_eq!(shadow, vec![-5.0, -4.0, -3.0, 5.0], "what stands in the moon's box casts, behind the eye too; the backdrop and far pieces do not");
        assert!(f.main.iter().any(|r| r.inst.extra[1] & FLAG_BACKDROP != 0));
        let mut fire: Vec<f32> = f.fire.iter().map(z).collect();
        fire.sort_by(f32::total_cmp);
        assert_eq!(fire, vec![-5.0, -4.0, -3.0], "what stands within the fire's reach is drawn into its faces");
        // the nearest fires cast, as many as the look says
        s.lights = vec![PointLight { pos: [0.0, 1.0, -30.0], range: 11.0, color: [1.0; 3], intensity: 8.0 }, PointLight { pos: [0.0, 1.0, -4.0], range: 11.0, color: [1.0; 3], intensity: 8.0 }, PointLight { pos: [3.0, 1.0, 0.0], range: 11.0, color: [1.0; 3], intensity: 0.0 }];
        assert!(s.fire_casters(&[]).is_empty(), "none while the look asks for none");
        s.look.fire_shadows = 1;
        assert_eq!(s.fire_casters(&[]), vec![(Vec3::new(0.0, 1.0, -4.0), 11.0)], "the nearest lit fire");
        // a fire that cast last frame keeps casting while another is less than 2 m nearer
        s.lights.push(PointLight { pos: [0.0, 1.0, 5.0], range: 11.0, color: [1.0; 3], intensity: 8.0 });
        assert_eq!(s.fire_casters(&[Vec3::new(0.0, 1.0, 5.0)])[0].0.z, 5.0);
        assert_eq!(s.fire_casters(&[])[0].0.z, -4.0);
        s.look.fire_shadows = 4;
        assert_eq!(s.fire_casters(&[]).len(), 3, "a fire that is out casts nothing");
        // every record without the cull, for the slot-ID pass
        assert_eq!(s.records(&s.items()).len(), 8);
    }

    /// Wave 2: a tracer is a short streak that leaves its muzzle on its first frame, crosses its line and is gone;
    /// a line too short to be seen at that speed is crossed more slowly; a beam is its whole line, fading.
    #[test]
    fn a_tracer_crosses_its_line_and_goes() {
        let mut s = Scene::default();
        s.look.tracer_speed = 220.0;
        s.look.tracer_length = 3.0;
        s.look.tracer_glow = 6.0;
        s.add_tracer(Vec3::ZERO, Vec3::new(0.0, 0.0, -10.0), [1.0, 0.5, 0.1], 0.02, 0.05, false);
        let (tail, head, k) = s.tracers[0].segment(3.0).unwrap();
        assert_eq!((tail.z, head.z, k), (0.0, -3.0, 1.0), "at the muzzle on its first frame");
        s.advance_tracers(1.0 / 60.0);
        let (tail, head, _) = s.tracers[0].segment(3.0).unwrap();
        assert!((tail.z + 220.0 / 60.0).abs() < 1e-3 && (head.z + 220.0 / 60.0 + 3.0).abs() < 1e-3);
        s.advance_tracers(1.0 / 60.0);
        assert_eq!(s.tracers.len(), 1, "10 m takes three frames");
        s.advance_tracers(1.0 / 60.0);
        assert!(s.tracers.is_empty());
        // point blank (1.2 m): still two frames
        s.add_tracer(Vec3::ZERO, Vec3::new(1.2, 0.0, 0.0), [1.0; 3], 0.02, 0.05, false);
        s.advance_tracers(1.0 / 60.0);
        assert_eq!(s.tracers.len(), 1);
        s.advance_tracers(2.0 / 60.0);
        assert!(s.tracers.is_empty());
        // a beam: the whole line for its seconds
        s.add_tracer(Vec3::ZERO, Vec3::new(0.0, 0.0, -8.0), [0.2, 1.0, 0.4], 0.05, 0.2, true);
        s.advance_tracers(0.1);
        let (tail, head, k) = s.tracers[0].segment(3.0).unwrap();
        assert_eq!((tail.z, head.z), (0.0, -8.0));
        assert!((k - 0.5).abs() < 1e-3);
        // as particle instances: the head, half the width, the tail from the head, the beam shape
        let mut out = Vec::new();
        s.streaks.push((Vec3::new(1.0, 1.0, 1.0), Vec3::new(1.0, 1.0, -1.0), [1.0, 0.3, 0.05], 0.03));
        assert_eq!(s.write_tracers(&mut out), 2);
        assert_eq!(out.len(), 2 * particles::PARTICLE_FLOATS);
        assert_eq!(out[15], particles::SHAPE_BEAM as f32);
        assert_eq!((out[16], out[18], out[19], out[22]), (1.0, -1.0, 0.015, 2.0), "the streak behind a round: its head, half its width, its tail 2 m back");
        for _ in 0..MAX_TRACERS + 8 {
            s.add_tracer(Vec3::ZERO, Vec3::X, [1.0; 3], 0.02, 0.05, false);
        }
        assert_eq!(s.tracers.len(), MAX_TRACERS);
    }

    #[test]
    fn the_frustum_keeps_what_is_ahead() {
        let cam = Camera { eye: Vec3::ZERO, ..Camera::default() };
        let planes = frustum_planes(&cam.view_proj(16.0 / 9.0));
        let inside = |p: Vec3, r: f32| planes.iter().all(|pl| pl.truncate().dot(p) + pl.w >= -r);
        assert!(inside(Vec3::new(0.0, 0.0, -10.0), 0.0));
        assert!(!inside(Vec3::new(0.0, 0.0, 10.0), 1.0), "behind");
        assert!(!inside(Vec3::new(40.0, 0.0, -10.0), 1.0), "off to the side");
        assert!(inside(Vec3::new(40.0, 0.0, -10.0), 40.0), "unless it is that large");
        assert!(!inside(Vec3::new(0.0, 0.0, -300.0), 1.0), "past the far plane");
    }
}
