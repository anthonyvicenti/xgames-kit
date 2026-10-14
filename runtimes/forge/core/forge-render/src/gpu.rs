//! The GPU side of a scene: pipelines, targets, buffers and one frame's passes. Built again from `Scene` on a new
//! device (device loss). Passes per frame:
//!
//! 1. the moon's shadow map (one depth pass, the look's size; skipped at 0)
//! 2. the world into an HDR target (Rgba16Float) with depth: static runs, skinned runs, the sky at the far plane, then
//!    the world's particles (one instanced draw)
//! 3. the first-person layer on a cleared depth (its own field of view), then particles drawn on top (the local muzzle)
//! 4. bloom: extract at a quarter size, blur across, blur down (skipped when the look's bloom is 0)
//! 5. the composite into the canvas (tone, sRGB, grain, dither, colour steps), or into an 8-bit target and then FXAA
use glam::{Mat4, Vec3};

use crate::*;

pub(crate) const HDR: wgpu::TextureFormat = wgpu::TextureFormat::Rgba16Float;
/// The scene's target on a device that cannot draw into a float one (`Caps::hdr` false: common.wgsl "the 8-bit scene"):
/// 8 bits a channel, sRGB encoded so the dark end keeps its steps; the scene shaders write it exposed and toned.
const SCENE_8BIT: wgpu::TextureFormat = wgpu::TextureFormat::Rgba8UnormSrgb;
/// The meter's texel beside the 8-bit scene: plain bytes (post.wgsl fs_meter keeps its factor in two of them).
const METER_8BIT: wgpu::TextureFormat = wgpu::TextureFormat::Rgba8Unorm;
const DEPTH: wgpu::TextureFormat = wgpu::TextureFormat::Depth32Float;
const ID_FORMAT: wgpu::TextureFormat = wgpu::TextureFormat::R32Uint;
const LDR: wgpu::TextureFormat = wgpu::TextureFormat::Rgba8Unorm;
const CAPTURE_FORMAT: wgpu::TextureFormat = wgpu::TextureFormat::Rgba32Float;
/// The bone palette texture's width in texels (4 a bone: 256 bones a row).
pub(crate) const BONES_WIDTH: u32 = 1024;
/// The vertex capture image's width (one vertex a pixel).
pub(crate) const CAPTURE_W: u32 = 256;
const POST_STRIDE: u64 = 256;
const INST_SIZE: u64 = std::mem::size_of::<InstData>() as u64;
const PART_SIZE: u64 = (particles::PARTICLE_FLOATS * 4) as u64;
pub(crate) const GLOBALS_SIZE: u64 = std::mem::size_of::<GlobalsU>() as u64;
pub(crate) const POST_SIZE: u64 = std::mem::size_of::<PostU>() as u64;

const G_WORLD: usize = 0;
const G_FP: usize = 1;
const G_SHADOW: usize = 2;
const G_AUX: usize = 3;
/// The globals of the fire shadow faces drawn in one frame: G_FIRE..G_FIRE + FIRE_FACES_A_FRAME.
const G_FIRE: usize = 4;
const FIRE_FACES_A_FRAME: usize = 8;
/// The faces of a fire's shadow cube that are drawn, as (forward, up): +X, −X, −Y, +Z, −Z. Nothing above a fire takes
/// its shadow, so +Y is left out. mesh.wgsl `fire_shadow` picks the same faces in the same order.
const FIRE_FACES: [(Vec3, Vec3); 5] = [(Vec3::X, Vec3::Y), (Vec3::NEG_X, Vec3::Y), (Vec3::NEG_Y, Vec3::Z), (Vec3::Z, Vec3::Y), (Vec3::NEG_Z, Vec3::Y)];
/// The faces' near plane: what is nearer the flame than this (the bowl it burns in) is not in them.
const FIRE_NEAR: f32 = 0.5;

/// A fire shadow face's projection × view: a quarter-turn lens at the light, out to its reach.
pub(crate) fn fire_face(pos: Vec3, reach: f32, face: usize) -> Mat4 {
    let (f, u) = FIRE_FACES[face % FIRE_FACES.len()];
    glam::camera::rh::proj::directx::perspective(std::f32::consts::FRAC_PI_2, 1.0, FIRE_NEAR, reach.max(FIRE_NEAR * 2.0)) * glam::camera::rh::view::look_to_mat4(pos, f, u)
}
const P_EXTRACT: u64 = 0;
const P_BLUR_H: u64 = 1;
const P_BLUR_V: u64 = 2;
const P_COMPOSITE: u64 = 3;
const P_FXAA: u64 = 4;
const P_METER: u64 = 5;
const POST_ENTRIES: u64 = 6;
/// Frames the meter goes all the way in after a start or a cut (each step lands within a few percent of the key).
const METER_SETTLE: u32 = 6;
/// The eye adapts to a darker picture this many times more slowly than to a brighter one (`look.tone.adapt`).
const METER_DARK: f32 = 4.0;

pub(crate) fn capture_row_floats() -> usize {
    (CAPTURE_W * 4) as usize
}

#[repr(C)]
#[derive(Clone, Copy, bytemuck::Pod, bytemuck::Zeroable)]
pub(crate) struct GlobalsU {
    view_proj: [[f32; 4]; 4],
    view: [[f32; 4]; 4],
    inv_view_proj: [[f32; 4]; 4],
    shadow_vp: [[f32; 4]; 4],
    eye: [f32; 4],
    sun_dir: [f32; 4],
    sun_color: [f32; 4],
    ambient: [f32; 4],
    fog: [f32; 4],
    fog_lin: [f32; 4],
    sky_zenith: [f32; 4],
    sky_horizon: [f32; 4],
    moon: [f32; 4],
    moon2: [f32; 4],
    shadow: [f32; 4],
    shadow_uv: [f32; 4],
    screen: [f32; 4],
    /// Per fire shadow slot: which of `lights` casts it (−1: none).
    fire_slots: [f32; 4],
    /// The fire shadows: the faces' near plane (m), how dark (0: off), 1 / a face's side, unused.
    fire_cfg: [f32; 4],
    /// The 8-bit scene: the look's exposure (0: the HDR scene), the tone curve, how far the eye adapts, unused.
    ldr: [f32; 4],
    lights: [[f32; 8]; MAX_SHADER_LIGHTS],
}

#[repr(C)]
#[derive(Clone, Copy, bytemuck::Pod, bytemuck::Zeroable)]
pub(crate) struct PostU {
    bloom: [f32; 4],
    tone: [f32; 4],
    retro: [f32; 4],
    texel: [f32; 4],
    out: [f32; 4],
    /// The eye's adaptation: how far (0 off), the key (a mean display luma, 0..1), the least and the most it may
    /// multiply the exposure by.
    auto: [f32; 4],
    /// The meter: how much of the way it goes this frame (0..1), a jitter seed, unused.
    meter: [f32; 4],
}

/// A shader module's WGSL: the shared header, then its own file (build.rs joins the same files in the same order).
#[cfg(any(test, not(feature = "naga-ir")))]
fn shader_src(name: &str) -> String {
    let common = include_str!("shaders/common.wgsl");
    match name {
        "mesh" => format!("{common}\n{}", include_str!("shaders/mesh.wgsl")),
        "sky" => format!("{common}\n{}", include_str!("shaders/sky.wgsl")),
        "particles" => format!("{common}\n{}", include_str!("shaders/particles.wgsl")),
        _ => include_str!("shaders/post.wgsl").to_string(),
    }
}

/// A shader module as this build hands it to wgpu. The WebGPU build: the WGSL text (the browser compiles it).
#[cfg(not(feature = "naga-ir"))]
fn shader_source(name: &str) -> wgpu::ShaderSource<'static> {
    wgpu::ShaderSource::Wgsl(shader_src(name).into())
}

/// The WebGL2 build (wave 3, track W): naga's IR, parsed from the same WGSL at build time (build.rs), so the wasm
/// carries no WGSL parser. wgpu validates it and writes the GLSL as it does for any module.
#[cfg(feature = "naga-ir")]
fn shader_source(name: &str) -> wgpu::ShaderSource<'static> {
    let bytes: &[u8] = match name {
        "mesh" => include_bytes!(concat!(env!("OUT_DIR"), "/mesh.naga")),
        "sky" => include_bytes!(concat!(env!("OUT_DIR"), "/sky.naga")),
        "particles" => include_bytes!(concat!(env!("OUT_DIR"), "/particles.naga")),
        _ => include_bytes!(concat!(env!("OUT_DIR"), "/post.naga")),
    };
    let module: naga::Module = bincode::deserialize(bytes).expect("the shader IR build.rs wrote");
    wgpu::ShaderSource::Naga(std::borrow::Cow::Owned(module))
}

struct GpuMesh {
    vbuf: wgpu::Buffer,
    skin: Option<wgpu::Buffer>,
    ibuf: wgpu::Buffer,
    count: u32,
    vcount: u32,
}

pub(crate) struct GpuTex {
    _tex: wgpu::Texture,
    view: wgpu::TextureView,
}

/// A material group's key: the base picture and the emissive picture (usize::MAX: none, the white texel).
type MatKey = (usize, usize);
fn mat_key(tex: Option<usize>, etex: Option<usize>) -> MatKey {
    (tex.unwrap_or(usize::MAX), etex.unwrap_or(usize::MAX))
}

struct Targets {
    w: u32,
    h: u32,
    out_w: u32,
    out_h: u32,
    aa: bool,
    scene: wgpu::TextureView,
    depth: wgpu::TextureView,
    bloom_a: wgpu::TextureView,
    bloom_b: wgpu::TextureView,
    ldr: Option<wgpu::TextureView>,
    bg_extract: wgpu::BindGroup,
    bg_blur_h: wgpu::BindGroup,
    bg_blur_v: wgpu::BindGroup,
    /// The composite reading each of the two meter texels (the one this frame's meter pass wrote).
    bg_composite: [wgpu::BindGroup; 2],
    /// The meter pass reading the scene and the other meter texel (last frame's).
    bg_meter: [wgpu::BindGroup; 2],
    bg_fxaa: Option<wgpu::BindGroup>,
}

struct ShadowMap {
    size: u32,
    view: wgpu::TextureView,
}

/// The fires' shadows: one depth texture of square faces in layers, five a slot (FIRE_FACES), and the fire each slot
/// holds. A few faces are drawn again every frame, in turn.
struct FireShadows {
    size: u32,
    layers: Vec<wgpu::TextureView>,
    all: wgpu::TextureView,
    slots: [Option<(Vec3, f32)>; MAX_FIRE_SHADOWS],
    cursor: usize,
}

pub(crate) struct Sight {
    a: wgpu::Texture,
    b: wgpu::Texture,
    a_view: wgpu::TextureView,
    b_view: wgpu::TextureView,
    depth: wgpu::TextureView,
    pub staging: wgpu::Buffer,
}

pub(crate) struct Gpu {
    pub device: wgpu::Device,
    pub queue: wgpu::Queue,
    pub surface: wgpu::Surface<'static>,
    pub config: wgpu::SurfaceConfiguration,
    pub max_dim: u32,
    /// What this device can draw into (`Renderer::attach` asks the adapter): without `hdr`, the 8-bit scene.
    pub caps: Caps,
    scene_format: wgpu::TextureFormat,
    surface_srgb: bool,
    frame_bgl: wgpu::BindGroupLayout,
    mat_bgl: wgpu::BindGroupLayout,
    light_bgl: wgpu::BindGroupLayout,
    part_bgl: wgpu::BindGroupLayout,
    post_bgl: wgpu::BindGroupLayout,
    main: [wgpu::RenderPipeline; 4],
    depth: [wgpu::RenderPipeline; 2],
    ids: [wgpu::RenderPipeline; 2],
    /// Verify's vertex capture draws into an Rgba32Float image: None on a device that cannot (`Caps::float_capture`).
    capture: Option<wgpu::RenderPipeline>,
    sky: wgpu::RenderPipeline,
    parts: wgpu::RenderPipeline,
    parts_top: wgpu::RenderPipeline,
    extract: wgpu::RenderPipeline,
    blur: wgpu::RenderPipeline,
    meter: wgpu::RenderPipeline,
    /// The eye's adaptation: two 1 × 1 float texels written in turn (this frame's from last frame's), and which is next.
    meter_views: [wgpu::TextureView; 2],
    meter_next: usize,
    meter_time: Option<f32>,
    /// Frames the meter still goes all the way in (the first frames, and after a cut: the eye somewhere else).
    meter_settle: u32,
    meter_eye: Option<(Vec3, Vec3)>,
    composite_surface: wgpu::RenderPipeline,
    composite_ldr: wgpu::RenderPipeline,
    fxaa: wgpu::RenderPipeline,
    globals: Vec<wgpu::Buffer>,
    /// The frame groups, one a globals buffer, twice: each set reads one of the two meter texels (the 8-bit scene
    /// reads the one last frame's meter pass wrote: `fbg`).
    frame_bg: [Vec<wgpu::BindGroup>; 2],
    bones_tex: wgpu::Texture,
    bones_rows: u32,
    inst_buf: wgpu::Buffer,
    inst_cap: u64,
    aux_buf: wgpu::Buffer,
    aux_cap: u64,
    part_buf: wgpu::Buffer,
    part_cap: u64,
    post_buf: wgpu::Buffer,
    samp_linear: wgpu::Sampler,
    samp_clamp: wgpu::Sampler,
    samp_clamp_point: wgpu::Sampler,
    samp_cmp: wgpu::Sampler,
    white: GpuTex,
    meshes: Vec<GpuMesh>,
    textures: Vec<GpuTex>,
    /// Material bind groups by (base picture, emissive picture), made the first time a run needs one.
    mat_groups: std::collections::HashMap<MatKey, wgpu::BindGroup>,
    fx_bg: wgpu::BindGroup,
    _fx_tex: wgpu::Texture,
    fx_version: u32,
    fx_cells: Vec<i32>,
    shadow: ShadowMap,
    fire: FireShadows,
    /// The lighting group: the moon's map, the comparison sampler, the fires' faces.
    light_bg: wgpu::BindGroup,
    targets: Option<Targets>,
    pub sight: Sight,
    capture_tex: Option<(wgpu::Texture, wgpu::TextureView, u32)>,
    pub capture_buf: Option<wgpu::Buffer>,
}

fn sampler(device: &wgpu::Device, label: &str, repeat: bool, mag_linear: bool, compare: Option<wgpu::CompareFunction>) -> wgpu::Sampler {
    let mode = if repeat { wgpu::AddressMode::Repeat } else { wgpu::AddressMode::ClampToEdge };
    device.create_sampler(&wgpu::SamplerDescriptor {
        label: Some(label),
        address_mode_u: mode,
        address_mode_v: mode,
        address_mode_w: mode,
        mag_filter: if mag_linear { wgpu::FilterMode::Linear } else { wgpu::FilterMode::Nearest },
        min_filter: if mag_linear || repeat { wgpu::FilterMode::Linear } else { wgpu::FilterMode::Nearest },
        mipmap_filter: if repeat { wgpu::MipmapFilterMode::Linear } else { wgpu::MipmapFilterMode::Nearest },
        compare,
        ..Default::default()
    })
}

fn bgl_entry(binding: u32, vis: wgpu::ShaderStages, ty: wgpu::BindingType) -> wgpu::BindGroupLayoutEntry {
    wgpu::BindGroupLayoutEntry { binding, visibility: vis, ty, count: None }
}

fn tex_ty(sample_type: wgpu::TextureSampleType) -> wgpu::BindingType {
    wgpu::BindingType::Texture { sample_type, view_dimension: wgpu::TextureViewDimension::D2, multisampled: false }
}

fn tex2d(device: &wgpu::Device, label: &str, w: u32, h: u32, format: wgpu::TextureFormat, usage: wgpu::TextureUsages) -> wgpu::Texture {
    device.create_texture(&wgpu::TextureDescriptor { label: Some(label), size: wgpu::Extent3d { width: w.max(1), height: h.max(1), depth_or_array_layers: 1 }, mip_level_count: 1, sample_count: 1, dimension: wgpu::TextureDimension::D2, format, usage, view_formats: &[] })
}

fn buffer(device: &wgpu::Device, label: &str, size: u64, usage: wgpu::BufferUsages) -> wgpu::Buffer {
    device.create_buffer(&wgpu::BufferDescriptor { label: Some(label), size: size.max(16).next_multiple_of(4), usage: usage | wgpu::BufferUsages::COPY_DST, mapped_at_creation: false })
}

fn buffer_init(device: &wgpu::Device, queue: &wgpu::Queue, label: &str, data: &[u8], usage: wgpu::BufferUsages) -> wgpu::Buffer {
    let size = (data.len() as u64).max(4).next_multiple_of(4);
    let buf = device.create_buffer(&wgpu::BufferDescriptor { label: Some(label), size, usage: usage | wgpu::BufferUsages::COPY_DST, mapped_at_creation: false });
    if !data.is_empty() {
        if data.len() % 4 == 0 {
            queue.write_buffer(&buf, 0, data);
        } else {
            let mut padded = data.to_vec();
            padded.resize(size as usize, 0);
            queue.write_buffer(&buf, 0, &padded);
        }
    }
    buf
}

fn upload_tex(device: &wgpu::Device, queue: &wgpu::Queue, t: &TexData) -> GpuTex {
    let size = wgpu::Extent3d { width: t.w, height: t.h, depth_or_array_layers: 1 };
    let tex = device.create_texture(&wgpu::TextureDescriptor { label: Some("forge texture"), size, mip_level_count: t.levels.len() as u32, sample_count: 1, dimension: wgpu::TextureDimension::D2, format: wgpu::TextureFormat::Rgba8UnormSrgb, usage: wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_DST, view_formats: &[] });
    let (mut w, mut h) = (t.w, t.h);
    for (level, px) in t.levels.iter().enumerate() {
        queue.write_texture(
            wgpu::TexelCopyTextureInfo { texture: &tex, mip_level: level as u32, origin: wgpu::Origin3d::ZERO, aspect: wgpu::TextureAspect::All },
            px,
            wgpu::TexelCopyBufferLayout { offset: 0, bytes_per_row: Some(4 * w), rows_per_image: Some(h) },
            wgpu::Extent3d { width: w, height: h, depth_or_array_layers: 1 },
        );
        w = (w / 2).max(1);
        h = (h / 2).max(1);
    }
    let view = tex.create_view(&Default::default());
    GpuTex { _tex: tex, view }
}

/// The fx atlas texture (linear, not sRGB: the pictures are straight-alpha colours the particle tints) and its group.
fn fx_bind(device: &wgpu::Device, queue: &wgpu::Queue, layout: &wgpu::BindGroupLayout, samp: &wgpu::Sampler, t: &TexData) -> (wgpu::Texture, wgpu::BindGroup) {
    let tex = device.create_texture(&wgpu::TextureDescriptor { label: Some("forge fx atlas"), size: wgpu::Extent3d { width: t.w, height: t.h, depth_or_array_layers: 1 }, mip_level_count: 1, sample_count: 1, dimension: wgpu::TextureDimension::D2, format: wgpu::TextureFormat::Rgba8UnormSrgb, usage: wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_DST, view_formats: &[] });
    queue.write_texture(
        wgpu::TexelCopyTextureInfo { texture: &tex, mip_level: 0, origin: wgpu::Origin3d::ZERO, aspect: wgpu::TextureAspect::All },
        &t.levels[0],
        wgpu::TexelCopyBufferLayout { offset: 0, bytes_per_row: Some(4 * t.w), rows_per_image: Some(t.h) },
        wgpu::Extent3d { width: t.w, height: t.h, depth_or_array_layers: 1 },
    );
    let view = tex.create_view(&Default::default());
    let bg = device.create_bind_group(&wgpu::BindGroupDescriptor { label: Some("forge fx"), layout, entries: &[wgpu::BindGroupEntry { binding: 0, resource: wgpu::BindingResource::TextureView(&view) }, wgpu::BindGroupEntry { binding: 1, resource: wgpu::BindingResource::Sampler(samp) }] });
    (tex, bg)
}

fn sight_targets(device: &wgpu::Device) -> Sight {
    let id_tex = |label| tex2d(device, label, SIGHT_W, SIGHT_H, ID_FORMAT, wgpu::TextureUsages::RENDER_ATTACHMENT | wgpu::TextureUsages::COPY_SRC);
    let a = id_tex("forge ids all");
    let b = id_tex("forge ids only");
    let depth = tex2d(device, "forge ids depth", SIGHT_W, SIGHT_H, DEPTH, wgpu::TextureUsages::RENDER_ATTACHMENT);
    let staging = device.create_buffer(&wgpu::BufferDescriptor { label: Some("forge ids readback"), size: (SIGHT_W * 4 * SIGHT_H * 2) as u64, usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ, mapped_at_creation: false });
    Sight { a_view: a.create_view(&Default::default()), b_view: b.create_view(&Default::default()), a, b, depth: depth.create_view(&Default::default()), staging }
}

/// The records sorted into runs (one draw each): layer, pipeline, mesh, pictures.
fn runs_of(recs: &mut [Rec]) -> Vec<Run> {
    recs.sort_by_key(|r| (r.layer, r.variant, r.mesh, r.tex.map(|t| t as i64).unwrap_or(-1), r.etex.map(|t| t as i64).unwrap_or(-1)));
    let mut runs: Vec<Run> = Vec::new();
    for (i, r) in recs.iter().enumerate() {
        match runs.last_mut() {
            Some(x) if x.layer == r.layer && x.variant == r.variant && x.mesh == r.mesh && x.tex == r.tex && x.etex == r.etex => {
                x.count += 1;
                x.shadow |= r.shadow;
            }
            _ => runs.push(Run { layer: r.layer, variant: r.variant, mesh: r.mesh, tex: r.tex, etex: r.etex, start: i as u32, count: 1, shadow: r.shadow }),
        }
    }
    runs
}

impl Gpu {
    pub fn new(device: wgpu::Device, queue: wgpu::Queue, surface: wgpu::Surface<'static>, format: wgpu::TextureFormat, width: u32, height: u32, scene: &Scene, caps: Caps) -> Self {
        let max_dim = device.limits().max_texture_dimension_2d;
        // the scene's and the meter's formats: float where the device can draw into one, else the 8-bit scene
        let (scene_format, meter_format) = if caps.hdr { (HDR, HDR) } else { (SCENE_8BIT, METER_8BIT) };
        let config = wgpu::SurfaceConfiguration {
            usage: wgpu::TextureUsages::RENDER_ATTACHMENT,
            format,
            color_space: wgpu::SurfaceColorSpace::Auto,
            width: width.clamp(1, max_dim),
            height: height.clamp(1, max_dim),
            present_mode: wgpu::PresentMode::Fifo,
            desired_maximum_frame_latency: 2,
            alpha_mode: wgpu::CompositeAlphaMode::Auto,
            view_formats: vec![],
        };
        surface.configure(&device, &config);
        let module = |label: &str| device.create_shader_module(wgpu::ShaderModuleDescriptor { label: Some(label), source: shader_source(label) });
        let mesh_sh = module("mesh");
        let sky_sh = module("sky");
        let part_sh = module("particles");
        let post_sh = module("post");
        let vf = wgpu::ShaderStages::VERTEX | wgpu::ShaderStages::FRAGMENT;
        let fs = wgpu::ShaderStages::FRAGMENT;
        let frame_bgl = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("forge frame"),
            entries: &[
                bgl_entry(0, vf, wgpu::BindingType::Buffer { ty: wgpu::BufferBindingType::Uniform, has_dynamic_offset: false, min_binding_size: wgpu::BufferSize::new(GLOBALS_SIZE) }),
                bgl_entry(1, vf, tex_ty(wgpu::TextureSampleType::Float { filterable: false })),
                // the meter's texel, read by the 8-bit scene's vertex stages (common.wgsl ldr_exposure)
                bgl_entry(2, wgpu::ShaderStages::VERTEX, tex_ty(wgpu::TextureSampleType::Float { filterable: false })),
            ],
        });
        let mat_bgl = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("forge material"),
            entries: &[bgl_entry(0, fs, tex_ty(wgpu::TextureSampleType::Float { filterable: true })), bgl_entry(1, fs, wgpu::BindingType::Sampler(wgpu::SamplerBindingType::Filtering)), bgl_entry(2, fs, tex_ty(wgpu::TextureSampleType::Float { filterable: true }))],
        });
        let light_bgl = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("forge lighting"),
            entries: &[
                bgl_entry(0, fs, tex_ty(wgpu::TextureSampleType::Depth)),
                bgl_entry(1, fs, wgpu::BindingType::Sampler(wgpu::SamplerBindingType::Comparison)),
                bgl_entry(2, fs, wgpu::BindingType::Texture { sample_type: wgpu::TextureSampleType::Depth, view_dimension: wgpu::TextureViewDimension::D2Array, multisampled: false }),
            ],
        });
        let part_bgl = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor { label: Some("forge fx"), entries: &[bgl_entry(0, fs, tex_ty(wgpu::TextureSampleType::Float { filterable: true })), bgl_entry(1, fs, wgpu::BindingType::Sampler(wgpu::SamplerBindingType::Filtering))] });
        let post_bgl = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("forge post"),
            entries: &[
                bgl_entry(0, fs, wgpu::BindingType::Buffer { ty: wgpu::BufferBindingType::Uniform, has_dynamic_offset: true, min_binding_size: wgpu::BufferSize::new(POST_SIZE) }),
                bgl_entry(1, fs, tex_ty(wgpu::TextureSampleType::Float { filterable: true })),
                bgl_entry(2, fs, tex_ty(wgpu::TextureSampleType::Float { filterable: true })),
                bgl_entry(3, fs, wgpu::BindingType::Sampler(wgpu::SamplerBindingType::Filtering)),
                bgl_entry(4, fs, wgpu::BindingType::Sampler(wgpu::SamplerBindingType::Filtering)),
                bgl_entry(5, fs, tex_ty(wgpu::TextureSampleType::Float { filterable: true })),
            ],
        });
        let layout = |label: &str, groups: &[&wgpu::BindGroupLayout]| {
            let g: Vec<Option<&wgpu::BindGroupLayout>> = groups.iter().map(|x| Some(*x)).collect();
            device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor { label: Some(label), bind_group_layouts: &g, immediate_size: 0 })
        };
        let main_layout = layout("forge main", &[&frame_bgl, &mat_bgl, &light_bgl]);
        let frame_layout = layout("forge frame only", &[&frame_bgl]);
        let part_layout = layout("forge particles", &[&frame_bgl, &part_bgl]);
        let post_layout = layout("forge post", &[&post_bgl]);
        let vertex = wgpu::VertexBufferLayout { array_stride: std::mem::size_of::<glb::Vertex>() as u64, step_mode: wgpu::VertexStepMode::Vertex, attributes: &wgpu::vertex_attr_array![0 => Float32x3, 1 => Float32x3, 2 => Float32x2] };
        let skin = wgpu::VertexBufferLayout { array_stride: std::mem::size_of::<glb::SkinVertex>() as u64, step_mode: wgpu::VertexStepMode::Vertex, attributes: &wgpu::vertex_attr_array![11 => Uint16x4, 12 => Float32x4] };
        let inst = wgpu::VertexBufferLayout {
            array_stride: INST_SIZE,
            step_mode: wgpu::VertexStepMode::Instance,
            attributes: &wgpu::vertex_attr_array![3 => Float32x4, 4 => Float32x4, 5 => Float32x4, 6 => Float32x4, 7 => Float32x4, 8 => Float32x4, 9 => Float32x4, 10 => Uint32x4, 13 => Float32x4],
        };
        let part = wgpu::VertexBufferLayout { array_stride: PART_SIZE, step_mode: wgpu::VertexStepMode::Instance, attributes: &wgpu::vertex_attr_array![0 => Float32x4, 1 => Float32x4, 2 => Float32x4, 3 => Float32x4] };
        let static_bufs = [Some(vertex.clone()), Some(inst.clone())];
        let skinned_bufs = [Some(vertex.clone()), Some(skin.clone()), Some(inst.clone())];
        let ds = |write: bool, cmp: wgpu::CompareFunction, bias: wgpu::DepthBiasState| wgpu::DepthStencilState { format: DEPTH, depth_write_enabled: Some(write), depth_compare: Some(cmp), stencil: Default::default(), bias };
        let hdr_target = [Some(wgpu::ColorTargetState { format: scene_format, blend: None, write_mask: wgpu::ColorWrites::ALL })];
        let premul = wgpu::BlendState {
            color: wgpu::BlendComponent { src_factor: wgpu::BlendFactor::One, dst_factor: wgpu::BlendFactor::OneMinusSrcAlpha, operation: wgpu::BlendOperation::Add },
            alpha: wgpu::BlendComponent { src_factor: wgpu::BlendFactor::One, dst_factor: wgpu::BlendFactor::OneMinusSrcAlpha, operation: wgpu::BlendOperation::Add },
        };
        let part_target = [Some(wgpu::ColorTargetState { format: scene_format, blend: Some(premul), write_mask: wgpu::ColorWrites::ALL })];
        let pipe = |label: &str, layout: &wgpu::PipelineLayout, module: &wgpu::ShaderModule, vs: &str, bufs: &[Option<wgpu::VertexBufferLayout>], prim: wgpu::PrimitiveState, depth: Option<wgpu::DepthStencilState>, fs: Option<&str>, targets: &[Option<wgpu::ColorTargetState>]| {
            device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
                label: Some(label),
                layout: Some(layout),
                vertex: wgpu::VertexState { module, entry_point: Some(vs), compilation_options: Default::default(), buffers: bufs },
                primitive: prim,
                depth_stencil: depth,
                multisample: Default::default(),
                fragment: fs.map(|f| wgpu::FragmentState { module, entry_point: Some(f), compilation_options: Default::default(), targets }),
                multiview_mask: None,
                cache: None,
            })
        };
        let cull = |c: bool| wgpu::PrimitiveState { cull_mode: if c { Some(wgpu::Face::Back) } else { None }, ..Default::default() };
        let no_bias = wgpu::DepthBiasState::default();
        let main = [
            pipe("forge static", &main_layout, &mesh_sh, "vs_static", &static_bufs, cull(true), Some(ds(true, wgpu::CompareFunction::Less, no_bias)), Some("fs_main"), &hdr_target),
            pipe("forge skinned", &main_layout, &mesh_sh, "vs_skinned", &skinned_bufs, cull(true), Some(ds(true, wgpu::CompareFunction::Less, no_bias)), Some("fs_main"), &hdr_target),
            pipe("forge static two-sided", &main_layout, &mesh_sh, "vs_static", &static_bufs, cull(false), Some(ds(true, wgpu::CompareFunction::Less, no_bias)), Some("fs_main"), &hdr_target),
            pipe("forge skinned two-sided", &main_layout, &mesh_sh, "vs_skinned", &skinned_bufs, cull(false), Some(ds(true, wgpu::CompareFunction::Less, no_bias)), Some("fs_main"), &hdr_target),
        ];
        let caster_bias = wgpu::DepthBiasState { constant: 2, slope_scale: 2.0, clamp: 0.0 };
        let depth = [
            pipe("forge shadow static", &frame_layout, &mesh_sh, "vs_static_depth", &static_bufs, cull(false), Some(ds(true, wgpu::CompareFunction::Less, caster_bias)), None, &[]),
            pipe("forge shadow skinned", &frame_layout, &mesh_sh, "vs_skinned_depth", &skinned_bufs, cull(false), Some(ds(true, wgpu::CompareFunction::Less, caster_bias)), None, &[]),
        ];
        let id_target = [Some(wgpu::ColorTargetState { format: ID_FORMAT, blend: None, write_mask: wgpu::ColorWrites::ALL })];
        let ids = [
            pipe("forge ids static", &frame_layout, &mesh_sh, "vs_static_id", &static_bufs, cull(false), Some(ds(true, wgpu::CompareFunction::Less, no_bias)), Some("fs_id"), &id_target),
            pipe("forge ids skinned", &frame_layout, &mesh_sh, "vs_skinned_id", &skinned_bufs, cull(false), Some(ds(true, wgpu::CompareFunction::Less, no_bias)), Some("fs_id"), &id_target),
        ];
        let cap_target = [Some(wgpu::ColorTargetState { format: CAPTURE_FORMAT, blend: None, write_mask: wgpu::ColorWrites::ALL })];
        let capture = caps.float_capture.then(|| pipe("forge capture", &frame_layout, &mesh_sh, "vs_capture", &skinned_bufs, wgpu::PrimitiveState { topology: wgpu::PrimitiveTopology::PointList, ..Default::default() }, None, Some("fs_capture"), &cap_target));
        let sky = pipe("forge sky", &frame_layout, &sky_sh, "vs_sky", &[], wgpu::PrimitiveState::default(), Some(ds(false, wgpu::CompareFunction::LessEqual, no_bias)), Some("fs_sky"), &hdr_target);
        let part_bufs = [Some(part)];
        let parts = pipe("forge particles", &part_layout, &part_sh, "vs_particle", &part_bufs, wgpu::PrimitiveState::default(), Some(ds(false, wgpu::CompareFunction::LessEqual, no_bias)), Some("fs_particle"), &part_target);
        let parts_top = pipe("forge particles on top", &part_layout, &part_sh, "vs_particle", &part_bufs, wgpu::PrimitiveState::default(), Some(ds(false, wgpu::CompareFunction::Always, no_bias)), Some("fs_particle"), &part_target);
        let full = |label: &str, fs: &str, format: wgpu::TextureFormat| pipe(label, &post_layout, &post_sh, "vs_full", &[], wgpu::PrimitiveState::default(), None, Some(fs), &[Some(wgpu::ColorTargetState { format, blend: None, write_mask: wgpu::ColorWrites::ALL })]);
        let extract = full("forge bloom extract", "fs_extract", scene_format);
        let blur = full("forge bloom blur", "fs_blur", scene_format);
        let meter = full("forge meter", "fs_meter", meter_format);
        let meter_views = [0, 1].map(|_| tex2d(&device, "forge meter", 1, 1, meter_format, wgpu::TextureUsages::RENDER_ATTACHMENT | wgpu::TextureUsages::TEXTURE_BINDING).create_view(&Default::default()));
        let composite_surface = full("forge composite", "fs_composite", format);
        let composite_ldr = full("forge composite (aa)", "fs_composite", LDR);
        let fxaa = full("forge fxaa", "fs_fxaa", format);
        let globals: Vec<wgpu::Buffer> = (0..G_FIRE + FIRE_FACES_A_FRAME).map(|_| buffer(&device, "forge globals", GLOBALS_SIZE, wgpu::BufferUsages::UNIFORM)).collect();
        let bones_rows = 1;
        let bones_tex = tex2d(&device, "forge bones", BONES_WIDTH, bones_rows, wgpu::TextureFormat::Rgba32Float, wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_DST);
        let samp_linear = sampler(&device, "forge linear", true, true, None);
        let samp_clamp = sampler(&device, "forge clamp", false, true, None);
        let samp_clamp_point = sampler(&device, "forge clamp point", false, false, None);
        let samp_cmp = device.create_sampler(&wgpu::SamplerDescriptor { label: Some("forge shadow"), mag_filter: wgpu::FilterMode::Linear, min_filter: wgpu::FilterMode::Linear, compare: Some(wgpu::CompareFunction::LessEqual), ..Default::default() });
        let white = upload_tex(&device, &queue, &TexData::white());
        let (fx_tex, fx_bg) = fx_bind(&device, &queue, &part_bgl, &samp_clamp, &TexData::white());
        let shadow = Self::make_shadow(&device, 1);
        let fire = Self::make_fire(&device, 1);
        let light_bg = Self::make_light_group(&device, &light_bgl, &samp_cmp, &shadow, &fire);
        let sight = sight_targets(&device);
        let post_buf = buffer(&device, "forge post", POST_STRIDE * POST_ENTRIES, wgpu::BufferUsages::UNIFORM);
        let mut g = Self {
            frame_bg: [Vec::new(), Vec::new()],
            caps,
            scene_format,
            inst_buf: buffer(&device, "forge instances", INST_SIZE * 256, wgpu::BufferUsages::VERTEX),
            inst_cap: 256,
            aux_buf: buffer(&device, "forge instances (aux)", INST_SIZE * 64, wgpu::BufferUsages::VERTEX),
            aux_cap: 64,
            part_buf: buffer(&device, "forge particles", PART_SIZE * 512, wgpu::BufferUsages::VERTEX),
            part_cap: 512,
            surface_srgb: format.is_srgb(),
            device,
            queue,
            surface,
            config,
            max_dim,
            frame_bgl,
            mat_bgl,
            light_bgl,
            part_bgl,
            post_bgl,
            main,
            depth,
            ids,
            capture,
            sky,
            parts,
            parts_top,
            extract,
            blur,
            meter,
            meter_views,
            meter_next: 0,
            meter_time: None,
            meter_settle: METER_SETTLE,
            meter_eye: None,
            composite_surface,
            composite_ldr,
            fxaa,
            globals,
            bones_tex,
            bones_rows,
            post_buf,
            samp_linear,
            samp_clamp,
            samp_clamp_point,
            samp_cmp,
            white,
            meshes: Vec::new(),
            textures: Vec::new(),
            mat_groups: std::collections::HashMap::new(),
            fx_bg,
            _fx_tex: fx_tex,
            fx_version: u32::MAX,
            fx_cells: vec![-1; KINDS.len()],
            shadow,
            fire,
            light_bg,
            targets: None,
            sight,
            capture_tex: None,
            capture_buf: None,
        };
        g.rebuild_frame_groups();
        g.sync(scene);
        g
    }

    fn make_shadow(device: &wgpu::Device, size: u32) -> ShadowMap {
        let tex = tex2d(device, "forge shadow map", size, size, DEPTH, wgpu::TextureUsages::RENDER_ATTACHMENT | wgpu::TextureUsages::TEXTURE_BINDING);
        ShadowMap { size, view: tex.create_view(&Default::default()) }
    }

    /// The fires' shadow faces: `size` px a side, five layers a slot (1 px when no fire casts: the group still needs it).
    fn make_fire(device: &wgpu::Device, size: u32) -> FireShadows {
        let n = (MAX_FIRE_SHADOWS * FIRE_FACES.len()) as u32;
        let tex = device.create_texture(&wgpu::TextureDescriptor {
            label: Some("forge fire shadows"),
            size: wgpu::Extent3d { width: size.max(1), height: size.max(1), depth_or_array_layers: n },
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format: DEPTH,
            usage: wgpu::TextureUsages::RENDER_ATTACHMENT | wgpu::TextureUsages::TEXTURE_BINDING,
            view_formats: &[],
        });
        let layers = (0..n).map(|i| tex.create_view(&wgpu::TextureViewDescriptor { label: Some("forge fire shadow face"), dimension: Some(wgpu::TextureViewDimension::D2), base_array_layer: i, array_layer_count: Some(1), ..Default::default() })).collect();
        let all = tex.create_view(&wgpu::TextureViewDescriptor { label: Some("forge fire shadows"), dimension: Some(wgpu::TextureViewDimension::D2Array), ..Default::default() });
        FireShadows { size, layers, all, slots: [None; MAX_FIRE_SHADOWS], cursor: 0 }
    }

    fn make_light_group(device: &wgpu::Device, layout: &wgpu::BindGroupLayout, samp: &wgpu::Sampler, shadow: &ShadowMap, fire: &FireShadows) -> wgpu::BindGroup {
        device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("forge lighting"),
            layout,
            entries: &[
                wgpu::BindGroupEntry { binding: 0, resource: wgpu::BindingResource::TextureView(&shadow.view) },
                wgpu::BindGroupEntry { binding: 1, resource: wgpu::BindingResource::Sampler(samp) },
                wgpu::BindGroupEntry { binding: 2, resource: wgpu::BindingResource::TextureView(&fire.all) },
            ],
        })
    }

    fn rebuild_frame_groups(&mut self) {
        let view = self.bones_tex.create_view(&Default::default());
        self.frame_bg = [0, 1].map(|m| {
            self.globals
                .iter()
                .map(|b| {
                    self.device.create_bind_group(&wgpu::BindGroupDescriptor {
                        label: Some("forge frame"),
                        layout: &self.frame_bgl,
                        entries: &[
                            wgpu::BindGroupEntry { binding: 0, resource: b.as_entire_binding() },
                            wgpu::BindGroupEntry { binding: 1, resource: wgpu::BindingResource::TextureView(&view) },
                            wgpu::BindGroupEntry { binding: 2, resource: wgpu::BindingResource::TextureView(&self.meter_views[m]) },
                        ],
                    })
                })
                .collect()
        });
    }

    /// The frame group over globals buffer `i`, reading the meter texel the last frame wrote (this frame's meter pass
    /// writes the other one, after the scene).
    fn fbg(&self, i: usize) -> &wgpu::BindGroup {
        &self.frame_bg[1 - self.meter_next][i]
    }

    pub fn resize(&mut self, width: u32, height: u32) {
        let w = width.clamp(1, self.max_dim);
        let h = height.clamp(1, self.max_dim);
        if w != self.config.width || h != self.config.height {
            self.config.width = w;
            self.config.height = h;
            self.surface.configure(&self.device, &self.config);
        }
    }

    /// Upload what the scene gained since the last frame (meshes and textures are only ever added) and the fx atlas.
    fn sync(&mut self, scene: &Scene) {
        while self.meshes.len() < scene.meshes.len() {
            let m = &scene.meshes[self.meshes.len()];
            let vbuf = buffer_init(&self.device, &self.queue, "forge vertices", bytemuck::cast_slice(&m.vertices), wgpu::BufferUsages::VERTEX);
            let skin = m.skin.as_ref().map(|s| buffer_init(&self.device, &self.queue, "forge skin", bytemuck::cast_slice(s), wgpu::BufferUsages::VERTEX));
            let ibuf = buffer_init(&self.device, &self.queue, "forge indices", bytemuck::cast_slice(&m.indices), wgpu::BufferUsages::INDEX);
            self.meshes.push(GpuMesh { vbuf, skin, ibuf, count: m.indices.len() as u32, vcount: m.vertices.len() as u32 });
        }
        // a body bound after its upload (bind_body bakes rigid pieces and adds their skin): upload the skin now
        for (i, m) in scene.meshes.iter().enumerate() {
            if m.skin.is_some() && self.meshes[i].skin.is_none() {
                self.meshes[i].vbuf = buffer_init(&self.device, &self.queue, "forge vertices", bytemuck::cast_slice(&m.vertices), wgpu::BufferUsages::VERTEX);
                self.meshes[i].skin = m.skin.as_ref().map(|s| buffer_init(&self.device, &self.queue, "forge skin", bytemuck::cast_slice(s), wgpu::BufferUsages::VERTEX));
            }
        }
        while self.textures.len() < scene.textures.len() {
            let t = upload_tex(&self.device, &self.queue, &scene.textures[self.textures.len()]);
            self.textures.push(t);
        }
        if self.fx_version != scene.fx_version {
            self.fx_version = scene.fx_version;
            let (atlas, cells) = scene.fx_atlas();
            self.fx_cells = cells;
            if let Some(a) = atlas {
                let (t, bg) = fx_bind(&self.device, &self.queue, &self.part_bgl, &self.samp_clamp, &a);
                self._fx_tex = t;
                self.fx_bg = bg;
            }
        }
    }

    /// The material groups these runs draw with (made once per pair of pictures).
    fn ensure_materials(&mut self, runs: &[Run]) {
        for r in runs {
            let key = mat_key(r.tex.filter(|t| *t < self.textures.len()), r.etex.filter(|t| *t < self.textures.len()));
            if self.mat_groups.contains_key(&key) {
                continue;
            }
            let pick = |k: usize| if k == usize::MAX { &self.white.view } else { &self.textures[k].view };
            let bg = self.device.create_bind_group(&wgpu::BindGroupDescriptor {
                label: Some("forge material"),
                layout: &self.mat_bgl,
                entries: &[
                    wgpu::BindGroupEntry { binding: 0, resource: wgpu::BindingResource::TextureView(pick(key.0)) },
                    wgpu::BindGroupEntry { binding: 1, resource: wgpu::BindingResource::Sampler(&self.samp_linear) },
                    wgpu::BindGroupEntry { binding: 2, resource: wgpu::BindingResource::TextureView(pick(key.1)) },
                ],
            });
            self.mat_groups.insert(key, bg);
        }
    }

    fn ensure_targets(&mut self, w: u32, h: u32, aa: bool) {
        let (ow, oh) = (self.config.width, self.config.height);
        if let Some(t) = &self.targets
            && t.w == w
            && t.h == h
            && t.out_w == ow
            && t.out_h == oh
            && t.aa == aa
        {
            return;
        }
        let rt = wgpu::TextureUsages::RENDER_ATTACHMENT | wgpu::TextureUsages::TEXTURE_BINDING;
        let scene = tex2d(&self.device, "forge scene", w, h, self.scene_format, rt).create_view(&Default::default());
        let depth = tex2d(&self.device, "forge depth", w, h, DEPTH, wgpu::TextureUsages::RENDER_ATTACHMENT).create_view(&Default::default());
        let (bw, bh) = ((w / 4).max(1), (h / 4).max(1));
        let bloom_a = tex2d(&self.device, "forge bloom a", bw, bh, self.scene_format, rt).create_view(&Default::default());
        let bloom_b = tex2d(&self.device, "forge bloom b", bw, bh, self.scene_format, rt).create_view(&Default::default());
        let ldr = if aa { Some(tex2d(&self.device, "forge ldr", ow, oh, LDR, rt).create_view(&Default::default())) } else { None };
        // (a pass never reads the texel it writes: the meter pass and the passes that do not meter read the white one
        // or the other of the pair)
        let bg = |a: &wgpu::TextureView, b: &wgpu::TextureView, m: &wgpu::TextureView| {
            self.device.create_bind_group(&wgpu::BindGroupDescriptor {
                label: Some("forge post"),
                layout: &self.post_bgl,
                entries: &[
                    wgpu::BindGroupEntry { binding: 0, resource: wgpu::BindingResource::Buffer(wgpu::BufferBinding { buffer: &self.post_buf, offset: 0, size: wgpu::BufferSize::new(POST_SIZE) }) },
                    wgpu::BindGroupEntry { binding: 1, resource: wgpu::BindingResource::TextureView(a) },
                    wgpu::BindGroupEntry { binding: 2, resource: wgpu::BindingResource::TextureView(b) },
                    wgpu::BindGroupEntry { binding: 3, resource: wgpu::BindingResource::Sampler(&self.samp_clamp) },
                    wgpu::BindGroupEntry { binding: 4, resource: wgpu::BindingResource::Sampler(&self.samp_clamp_point) },
                    wgpu::BindGroupEntry { binding: 5, resource: wgpu::BindingResource::TextureView(m) },
                ],
            })
        };
        let none = &self.white.view;
        let bg_extract = bg(&scene, &bloom_b, none);
        let bg_blur_h = bg(&bloom_a, &scene, none);
        let bg_blur_v = bg(&bloom_b, &scene, none);
        let bg_composite = [bg(&scene, &bloom_a, &self.meter_views[0]), bg(&scene, &bloom_a, &self.meter_views[1])];
        // the meter pass writing texel k reads the other one
        let bg_meter = [bg(&scene, &bloom_b, &self.meter_views[1]), bg(&scene, &bloom_b, &self.meter_views[0])];
        let bg_fxaa = ldr.as_ref().map(|l| bg(l, &bloom_a, none));
        self.targets = Some(Targets { w, h, out_w: ow, out_h: oh, aa, scene, depth, bloom_a, bloom_b, ldr, bg_extract, bg_blur_h, bg_blur_v, bg_composite, bg_meter, bg_fxaa });
    }

    fn ensure_shadow(&mut self, size: u32) {
        let size = if size == 0 { 1 } else { size.clamp(256, self.max_dim.min(4096)) };
        if self.shadow.size != size {
            self.shadow = Self::make_shadow(&self.device, size);
            self.light_bg = Self::make_light_group(&self.device, &self.light_bgl, &self.samp_cmp, &self.shadow, &self.fire);
        }
    }

    /// The fires' faces at the look's size (1 px while no fire casts).
    fn ensure_fire(&mut self, size: u32) {
        if self.fire.size != size {
            self.fire = Self::make_fire(&self.device, size);
            self.light_bg = Self::make_light_group(&self.device, &self.light_bgl, &self.samp_cmp, &self.shadow, &self.fire);
        }
    }

    /// Give this frame's casting fires their slots (a fire keeps its slot while it casts) and choose the faces drawn
    /// this frame: every face of a slot a fire has just taken (its layers hold another fire's depths), then
    /// `look.fire.shadowFaces` more in turn. → per slot the fire's place and reach, and the (slot, face) list.
    fn plan_fire(&mut self, scene: &Scene, casters: &[(Vec3, f32)]) -> Vec<(usize, usize)> {
        let same = |a: &(Vec3, f32), b: &(Vec3, f32)| a.0.distance(b.0) < 0.05 && (a.1 - b.1).abs() < 0.05;
        for s in self.fire.slots.iter_mut() {
            if s.is_some_and(|x| !casters.iter().any(|c| same(c, &x))) {
                *s = None;
            }
        }
        let mut faces: Vec<(usize, usize)> = Vec::new();
        for c in casters {
            if self.fire.slots.iter().flatten().any(|x| same(c, x)) {
                continue;
            }
            if let Some(k) = self.fire.slots.iter().position(|s| s.is_none()) {
                self.fire.slots[k] = Some(*c);
                faces.extend((0..FIRE_FACES.len()).map(|f| (k, f)));
            }
        }
        let live: Vec<usize> = (0..MAX_FIRE_SHADOWS).filter(|k| self.fire.slots[*k].is_some()).collect();
        let total = live.len() * FIRE_FACES.len();
        let want = (scene.look.fire_shadow_faces as usize).min(total);
        for _ in 0..want {
            if faces.len() >= FIRE_FACES_A_FRAME {
                break;
            }
            let at = self.fire.cursor % total.max(1);
            self.fire.cursor = (at + 1) % total.max(1);
            let pair = (live[at / FIRE_FACES.len()], at % FIRE_FACES.len());
            if !faces.contains(&pair) {
                faces.push(pair);
            }
        }
        faces.truncate(FIRE_FACES_A_FRAME);
        faces
    }

    /// The bone palette into its texture (grown as needed: 256 bones a row).
    fn upload_palette(&mut self, palette: &[Mat4]) {
        let need = (palette.len() as u32).div_ceil(BONES_WIDTH / 4).max(1);
        if need > self.bones_rows {
            let rows = need.next_power_of_two().min(self.max_dim.max(2048));
            self.bones_tex = tex2d(&self.device, "forge bones", BONES_WIDTH, rows, wgpu::TextureFormat::Rgba32Float, wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_DST);
            self.bones_rows = rows;
            self.rebuild_frame_groups();
        }
        if palette.is_empty() {
            return;
        }
        let rows = (palette.len() as u32).div_ceil(BONES_WIDTH / 4).min(self.bones_rows);
        let mut data = vec![0f32; (rows * BONES_WIDTH * 4) as usize];
        for (i, m) in palette.iter().enumerate().take(data.len() / 16) {
            data[i * 16..i * 16 + 16].copy_from_slice(&m.to_cols_array());
        }
        self.queue.write_texture(
            wgpu::TexelCopyTextureInfo { texture: &self.bones_tex, mip_level: 0, origin: wgpu::Origin3d::ZERO, aspect: wgpu::TextureAspect::All },
            bytemuck::cast_slice(&data),
            wgpu::TexelCopyBufferLayout { offset: 0, bytes_per_row: Some(BONES_WIDTH * 16), rows_per_image: Some(rows) },
            wgpu::Extent3d { width: BONES_WIDTH, height: rows, depth_or_array_layers: 1 },
        );
    }

    /// The records' instances into the instance buffer (or the aux one), one list after another.
    fn write_instances(&mut self, lists: &[&[Rec]], aux: bool) {
        let total: usize = lists.iter().map(|l| l.len()).sum();
        let need = total.max(1) as u64;
        let (buf, cap) = if aux { (&mut self.aux_buf, &mut self.aux_cap) } else { (&mut self.inst_buf, &mut self.inst_cap) };
        if need > *cap {
            *cap = need.next_power_of_two();
            *buf = buffer(&self.device, "forge instances", INST_SIZE * *cap, wgpu::BufferUsages::VERTEX);
        }
        if total > 0 {
            let mut data: Vec<InstData> = Vec::with_capacity(total);
            for l in lists {
                data.extend(l.iter().map(|r| r.inst));
            }
            self.queue.write_buffer(buf, 0, bytemuck::cast_slice(&data));
        }
    }

    /// The globals for the world camera, the first-person camera and the moon's shadow map. → the light count, the
    /// view, the world camera's and the moon's projection × view, and the world's globals (a fire face's start).
    fn write_globals(&mut self, scene: &Scene, rw: u32, rh: u32) -> (u32, Mat4, Mat4, Mat4, GlobalsU) {
        let l = &scene.look;
        let cam = &scene.camera;
        let aspect = self.config.width as f32 / self.config.height.max(1) as f32;
        let view = cam.view();
        let vp = cam.view_proj(aspect);
        let lights = scene.frame_lights();
        // which of the frame's lights each fire shadow slot belongs to (−1: none, or its fire is not shaded this frame)
        let mut fire_slots = [-1.0f32; 4];
        let mut casting = false;
        for (k, s) in self.fire.slots.iter().enumerate() {
            if let Some((p, _)) = s
                && let Some(i) = lights.iter().position(|x| Vec3::new(x[0], x[1], x[2]).distance(*p) < 0.05)
            {
                fire_slots[k] = i as f32;
                casting = true;
            }
        }
        let mut la = [[0f32; 8]; MAX_SHADER_LIGHTS];
        for (i, x) in lights.iter().enumerate().take(MAX_SHADER_LIGHTS) {
            la[i] = *x;
        }
        let sun = Vec3::from(l.sun_dir).normalize_or(Vec3::Y);
        let (shadow_vp, texel_m, reach) = shadow_matrix(scene, sun);
        let shadows = l.shadow_size > 0 && l.sun_intensity > 0.0 && l.shadow_strength > 0.0;
        let base = GlobalsU {
            view_proj: vp.to_cols_array_2d(),
            view: view.to_cols_array_2d(),
            inv_view_proj: vp.inverse().to_cols_array_2d(),
            shadow_vp: shadow_vp.to_cols_array_2d(),
            eye: [cam.eye.x, cam.eye.y, cam.eye.z, scene.time],
            sun_dir: [sun.x, sun.y, sun.z, if shadows { 1.0 } else { 0.0 }],
            sun_color: [l.sun_color[0], l.sun_color[1], l.sun_color[2], l.sun_intensity],
            ambient: [l.ambient[0], l.ambient[1], l.ambient[2], l.ambient_intensity],
            fog: [l.fog[0], l.fog[1], l.fog[2], l.fog_density],
            fog_lin: [l.fog_near, l.fog_far, l.emissive, lights.len() as f32],
            sky_zenith: [l.sky_zenith[0], l.sky_zenith[1], l.sky_zenith[2], l.stars],
            sky_horizon: [l.sky_horizon[0], l.sky_horizon[1], l.sky_horizon[2], l.sky_haze],
            moon: [l.moon_disc[0], l.moon_disc[1], l.moon_disc[2], l.moon_brightness],
            moon2: [l.moon_size.to_radians(), l.moon_glow, l.retro_crisp, 0.0],
            shadow: [texel_m, l.shadow_strength, l.shadow_bias, l.shadow_softness],
            shadow_uv: [1.0 / self.shadow.size.max(1) as f32, reach, l.light_falloff, l.backdrop_fog.max(0.0)],
            screen: [rw as f32, rh as f32, l.vertex_snap, if l.retro_texels { 1.0 } else { 0.0 }],
            fire_slots,
            fire_cfg: [FIRE_NEAR, if casting { l.fire_shadow_strength } else { 0.0 }, 1.0 / self.fire.size.max(1) as f32, 0.0],
            ldr: if self.caps.hdr { [0.0; 4] } else { [l.exposure.max(1e-4), l.tone_curve as f32, l.tone_auto.clamp(0.0, 1.0), 0.0] },
            lights: la,
        };
        let mut fp = base;
        fp.view_proj = scene.fp_view_proj(aspect).to_cols_array_2d();
        fp.screen[2] = 0.0;
        let mut sh = base;
        sh.view_proj = shadow_vp.to_cols_array_2d();
        sh.screen[2] = 0.0;
        self.queue.write_buffer(&self.globals[G_WORLD], 0, bytemuck::bytes_of(&base));
        self.queue.write_buffer(&self.globals[G_FP], 0, bytemuck::bytes_of(&fp));
        self.queue.write_buffer(&self.globals[G_SHADOW], 0, bytemuck::bytes_of(&sh));
        (lights.len() as u32, view, vp, shadow_vp, base)
    }

    fn write_post(&mut self, scene: &Scene, w: u32, h: u32) {
        let l = &scene.look;
        // how far the meter goes this frame: all the way on its first frames and after a cut (the eye in another place
        // or turned more than 60 degrees in one frame), else toward the picture over `tone.adapt` when the picture
        // got brighter, and four times as slowly when it got darker (a glance at the sky does not pump the exposure)
        let dt = self.meter_time.map(|t| (scene.time - t).clamp(0.0, 0.25));
        self.meter_time = Some(scene.time);
        let now = (scene.camera.eye, scene.camera.dir());
        if self.meter_eye.is_some_and(|(e, d)| e.distance(now.0) > 3.0 || d.dot(now.1) < 0.5) {
            self.meter_settle = METER_SETTLE;
        }
        self.meter_eye = Some(now);
        let toward = |seconds: f32| match dt {
            Some(dt) if seconds > 1e-3 && self.meter_settle == 0 => 1.0 - (-dt / seconds).exp(),
            _ => 1.0,
        };
        let (rate, rate_dark) = (toward(l.tone_adapt), toward(l.tone_adapt * METER_DARK));
        self.meter_settle = self.meter_settle.saturating_sub(1);
        let (bw, bh) = ((w / 4).max(1) as f32, (h / 4).max(1) as f32);
        let encode = if self.surface_srgb { 0.0 } else { 1.0 };
        let base = PostU {
            bloom: [l.bloom_threshold, l.bloom_knee, l.bloom_intensity, l.bloom_radius],
            tone: [l.exposure, l.tone_curve as f32, l.contrast, l.saturation],
            retro: [l.grain, l.dither, l.color_steps, scene.time],
            texel: [1.0 / w as f32, 1.0 / h as f32, 0.0, 0.0],
            out: [encode, l.gamma, l.vignette, if l.pixelated { 1.0 } else { 0.0 }],
            auto: [l.tone_auto, l.tone_key / 255.0, l.tone_auto_min, l.tone_auto_max],
            meter: [rate, scene.time.fract() * 61.0, rate_dark, 0.0],
        };
        let mut entries = [base; POST_ENTRIES as usize];
        if !self.caps.hdr {
            // the 8-bit scene arrives exposed and toned (common.wgsl scene_out): the composite adds no bloom, no
            // exposure, no curve and no adaptation of its own; the meter reads the picture as it is
            for e in entries.iter_mut() {
                e.bloom[2] = 0.0;
                e.tone[0] = 1.0;
                e.tone[1] = 0.0;
                e.auto[0] = 0.0;
            }
            entries[P_METER as usize].meter[3] = 1.0;
        }
        entries[P_EXTRACT as usize].texel = [1.0 / w as f32, 1.0 / h as f32, 0.0, 0.0];
        entries[P_BLUR_H as usize].texel = [1.0 / bw, 1.0 / bh, 1.0, 0.0];
        entries[P_BLUR_V as usize].texel = [1.0 / bw, 1.0 / bh, 0.0, 1.0];
        // into the AA target the composite always encodes (an 8-bit unorm target); FXAA then writes the canvas
        if l.aa {
            entries[P_COMPOSITE as usize].out[0] = 1.0;
        }
        entries[P_FXAA as usize].texel = [1.0 / self.config.width as f32, 1.0 / self.config.height as f32, 0.0, 0.0];
        let mut bytes = vec![0u8; (POST_STRIDE * POST_ENTRIES) as usize];
        for (i, e) in entries.iter().enumerate() {
            let at = i * POST_STRIDE as usize;
            bytes[at..at + POST_SIZE as usize].copy_from_slice(bytemuck::bytes_of(e));
        }
        self.queue.write_buffer(&self.post_buf, 0, &bytes);
    }

    fn draw_runs(&self, pass: &mut wgpu::RenderPass, runs: &[Run], layer: u8, mode: Mode, buf: &wgpu::Buffer) -> u32 {
        let mut draws = 0;
        let mut bound: Option<usize> = None;
        for r in runs.iter().filter(|r| r.layer == layer) {
            if mode == Mode::Shadow && !r.shadow {
                continue;
            }
            let Some(mesh) = self.meshes.get(r.mesh) else { continue };
            let skinned = r.variant & VARIANT_SKINNED != 0;
            if skinned && mesh.skin.is_none() {
                continue;
            }
            let pipe = match mode {
                Mode::Main => r.variant as usize & 3,
                Mode::Shadow => 4 + skinned as usize,
                Mode::Ids => 6 + skinned as usize,
            };
            if bound != Some(pipe) {
                pass.set_pipeline(match pipe {
                    0..=3 => &self.main[pipe],
                    4 | 5 => &self.depth[pipe - 4],
                    _ => &self.ids[pipe - 6],
                });
                bound = Some(pipe);
            }
            if mode == Mode::Main {
                let key = mat_key(r.tex.filter(|t| *t < self.textures.len()), r.etex.filter(|t| *t < self.textures.len()));
                let Some(bg) = self.mat_groups.get(&key) else { continue };
                pass.set_bind_group(1, bg, &[]);
            }
            pass.set_vertex_buffer(0, mesh.vbuf.slice(..));
            let at = r.start as u64 * INST_SIZE;
            if skinned {
                pass.set_vertex_buffer(1, mesh.skin.as_ref().unwrap().slice(..));
                pass.set_vertex_buffer(2, buf.slice(at..));
            } else {
                pass.set_vertex_buffer(1, buf.slice(at..));
            }
            pass.set_index_buffer(mesh.ibuf.slice(..), wgpu::IndexFormat::Uint32);
            pass.draw_indexed(0..mesh.count, 0, 0..r.count);
            draws += 1;
        }
        draws
    }

    /// One frame. → None when the canvas gave no frame this time (minimised, being resized).
    pub fn frame(&mut self, scene: &Scene) -> Result<Option<Stats>, String> {
        self.sync(scene);
        let frame = match self.surface.get_current_texture() {
            wgpu::CurrentSurfaceTexture::Success(t) | wgpu::CurrentSurfaceTexture::Suboptimal(t) => t,
            wgpu::CurrentSurfaceTexture::Outdated | wgpu::CurrentSurfaceTexture::Lost => {
                self.surface.configure(&self.device, &self.config);
                return Ok(None);
            }
            wgpu::CurrentSurfaceTexture::Timeout | wgpu::CurrentSurfaceTexture::Occluded => return Ok(None),
            other => return Err(format!("the canvas gave no frame ({other:?})")),
        };
        let l = &scene.look;
        // the scene's size: the render scale, then the detail cap on its width
        let s = l.render_scale.clamp(0.1, 1.0);
        let (cw, ch) = (self.config.width as f32, self.config.height as f32);
        let mut w = (cw * s).round().max(1.0);
        let mut h = (ch * s).round().max(1.0);
        if l.detail > 0.0 && w > l.detail {
            h = (h * l.detail / w).round().max(1.0);
            w = l.detail;
        }
        let (w, h) = (w as u32, h as u32);
        self.ensure_targets(w, h, l.aa);
        self.ensure_shadow(l.shadow_size);
        // the fires that cast a shadow this frame, their slots, and the faces drawn again
        let held: Vec<Vec3> = self.fire.slots.iter().flatten().map(|s| s.0).collect();
        let casters = scene.fire_casters(&held);
        self.ensure_fire(if casters.is_empty() { 1 } else { l.fire_shadow_size });
        let fire_faces = self.plan_fire(scene, &casters);
        let (nlights, view, vp, shadow_vp, world_globals) = self.write_globals(scene, w, h);
        self.write_post(scene, w, h);
        let shadows = l.shadow_size > 0 && l.sun_intensity > 0.0 && l.shadow_strength > 0.0;
        let items = scene.items();
        // what the camera can see, what can throw the moon's shadow into its view, and what stands by a casting
        // fire: three lists, one buffer
        let mut fr = scene.records_for(&items, &Cull { view_proj: vp, shadow_vp: shadows.then_some(shadow_vp), eye: scene.camera.eye, fires: casters.clone() });
        let runs = runs_of(&mut fr.main);
        let offset = fr.main.len() as u32;
        let shadow_runs: Vec<Run> = runs_of(&mut fr.shadow).into_iter().map(|r| Run { start: r.start + offset, ..r }).collect();
        let offset = offset + fr.shadow.len() as u32;
        let fire_runs: Vec<Run> = runs_of(&mut fr.fire).into_iter().map(|r| Run { start: r.start + offset, ..r }).collect();
        self.write_instances(&[&fr.main, &fr.shadow, &fr.fire], false);
        for (j, (slot, face)) in fire_faces.iter().enumerate() {
            let Some((pos, reach)) = self.fire.slots[*slot] else { continue };
            let mut gl = world_globals;
            gl.view_proj = fire_face(pos, reach, *face).to_cols_array_2d();
            gl.screen[2] = 0.0;
            self.queue.write_buffer(&self.globals[G_FIRE + j], 0, bytemuck::bytes_of(&gl));
        }
        self.ensure_materials(&runs);
        self.upload_palette(&scene.palette);
        // particles: the world's and the tracers, then those drawn on top
        let mut pdata: Vec<f32> = Vec::new();
        let n_parts = scene.particles.write(&l.kinds, &self.fx_cells, scene.camera.eye, &view, false, &mut pdata);
        let n_tracers = scene.write_tracers(&mut pdata);
        let n_world = n_parts + n_tracers;
        let n_top = scene.particles.write(&l.kinds, &self.fx_cells, scene.camera.eye, &view, true, &mut pdata);
        let np = (n_world + n_top) as u64;
        if np > self.part_cap {
            self.part_cap = np.next_power_of_two();
            self.part_buf = buffer(&self.device, "forge particles", PART_SIZE * self.part_cap, wgpu::BufferUsages::VERTEX);
        }
        if np > 0 {
            self.queue.write_buffer(&self.part_buf, 0, bytemuck::cast_slice(&pdata));
        }
        // (the 8-bit scene holds nothing brighter than white: no bloom there)
        let bloom = l.bloom_intensity > 0.0 && self.caps.hdr;
        let mut draws = 0u32;
        let mut passes = 0u32;
        let out_view = frame.texture.create_view(&wgpu::TextureViewDescriptor::default());
        let mut enc = self.device.create_command_encoder(&wgpu::CommandEncoderDescriptor { label: Some("forge frame") });
        // 1. the moon's shadow map
        if shadows {
            let mut pass = enc.begin_render_pass(&wgpu::RenderPassDescriptor {
                label: Some("forge shadow"),
                color_attachments: &[],
                depth_stencil_attachment: Some(wgpu::RenderPassDepthStencilAttachment { view: &self.shadow.view, depth_ops: Some(wgpu::Operations { load: wgpu::LoadOp::Clear(1.0), store: wgpu::StoreOp::Store }), stencil_ops: None }),
                ..Default::default()
            });
            pass.set_bind_group(0, self.fbg(G_SHADOW), &[]);
            draws += self.draw_runs(&mut pass, &shadow_runs, LAYER_WORLD, Mode::Shadow, &self.inst_buf);
            passes += 1;
        }
        // 1b. the fires' shadow faces drawn again this frame (one small depth pass each)
        for (j, (slot, face)) in fire_faces.iter().enumerate() {
            let mut pass = enc.begin_render_pass(&wgpu::RenderPassDescriptor {
                label: Some("forge fire shadow"),
                color_attachments: &[],
                depth_stencil_attachment: Some(wgpu::RenderPassDepthStencilAttachment { view: &self.fire.layers[slot * FIRE_FACES.len() + face], depth_ops: Some(wgpu::Operations { load: wgpu::LoadOp::Clear(1.0), store: wgpu::StoreOp::Store }), stencil_ops: None }),
                ..Default::default()
            });
            pass.set_bind_group(0, self.fbg(G_FIRE + j), &[]);
            draws += self.draw_runs(&mut pass, &fire_runs, LAYER_WORLD, Mode::Shadow, &self.inst_buf);
            passes += 1;
        }
        let t = self.targets.as_ref().unwrap();
        // 2. the world, the sky, the world's particles
        {
            let mut pass = enc.begin_render_pass(&wgpu::RenderPassDescriptor {
                label: Some("forge world"),
                color_attachments: &[Some(wgpu::RenderPassColorAttachment { view: &t.scene, depth_slice: None, resolve_target: None, ops: wgpu::Operations { load: wgpu::LoadOp::Clear(wgpu::Color::BLACK), store: wgpu::StoreOp::Store } })],
                depth_stencil_attachment: Some(wgpu::RenderPassDepthStencilAttachment { view: &t.depth, depth_ops: Some(wgpu::Operations { load: wgpu::LoadOp::Clear(1.0), store: wgpu::StoreOp::Discard }), stencil_ops: None }),
                ..Default::default()
            });
            pass.set_bind_group(0, self.fbg(G_WORLD), &[]);
            pass.set_bind_group(2, &self.light_bg, &[]);
            draws += self.draw_runs(&mut pass, &runs, LAYER_WORLD, Mode::Main, &self.inst_buf);
            pass.set_pipeline(&self.sky);
            pass.set_bind_group(0, self.fbg(G_WORLD), &[]);
            pass.draw(0..3, 0..1);
            draws += 1;
            if n_world > 0 {
                pass.set_pipeline(&self.parts);
                pass.set_bind_group(1, &self.fx_bg, &[]);
                pass.set_vertex_buffer(0, self.part_buf.slice(..));
                pass.draw(0..6, 0..n_world);
                draws += 1;
            }
            passes += 1;
        }
        // 3. the first-person layer on a cleared depth, then what is drawn on top
        let fp_runs = runs.iter().any(|r| r.layer == LAYER_FP);
        if fp_runs || n_top > 0 {
            let mut pass = enc.begin_render_pass(&wgpu::RenderPassDescriptor {
                label: Some("forge first person"),
                color_attachments: &[Some(wgpu::RenderPassColorAttachment { view: &t.scene, depth_slice: None, resolve_target: None, ops: wgpu::Operations { load: wgpu::LoadOp::Load, store: wgpu::StoreOp::Store } })],
                depth_stencil_attachment: Some(wgpu::RenderPassDepthStencilAttachment { view: &t.depth, depth_ops: Some(wgpu::Operations { load: wgpu::LoadOp::Clear(1.0), store: wgpu::StoreOp::Discard }), stencil_ops: None }),
                ..Default::default()
            });
            pass.set_bind_group(0, self.fbg(G_FP), &[]);
            pass.set_bind_group(2, &self.light_bg, &[]);
            draws += self.draw_runs(&mut pass, &runs, LAYER_FP, Mode::Main, &self.inst_buf);
            if n_top > 0 {
                pass.set_pipeline(&self.parts_top);
                pass.set_bind_group(0, self.fbg(G_WORLD), &[]);
                pass.set_bind_group(1, &self.fx_bg, &[]);
                pass.set_vertex_buffer(0, self.part_buf.slice(n_world as u64 * PART_SIZE..));
                pass.draw(0..6, 0..n_top);
                draws += 1;
            }
            passes += 1;
        }
        // 4. bloom at a quarter size
        let full_pass = |enc: &mut wgpu::CommandEncoder, label: &str, target: &wgpu::TextureView, pipe: &wgpu::RenderPipeline, bg: &wgpu::BindGroup, entry: u64| {
            let mut pass = enc.begin_render_pass(&wgpu::RenderPassDescriptor {
                label: Some(label),
                color_attachments: &[Some(wgpu::RenderPassColorAttachment { view: target, depth_slice: None, resolve_target: None, ops: wgpu::Operations { load: wgpu::LoadOp::Clear(wgpu::Color::BLACK), store: wgpu::StoreOp::Store } })],
                ..Default::default()
            });
            pass.set_pipeline(pipe);
            pass.set_bind_group(0, bg, &[(entry * POST_STRIDE) as u32]);
            pass.draw(0..3, 0..1);
        };
        if bloom {
            full_pass(&mut enc, "forge bloom extract", &t.bloom_a, &self.extract, &t.bg_extract, P_EXTRACT);
            full_pass(&mut enc, "forge bloom across", &t.bloom_b, &self.blur, &t.bg_blur_h, P_BLUR_H);
            full_pass(&mut enc, "forge bloom down", &t.bloom_a, &self.blur, &t.bg_blur_v, P_BLUR_V);
            draws += 3;
            passes += 3;
        }
        // 5. the eye's adaptation: this frame's meter texel from the scene and last frame's texel
        let metered = l.tone_auto > 0.0;
        let k = self.meter_next;
        if metered {
            full_pass(&mut enc, "forge meter", &self.meter_views[k], &self.meter, &t.bg_meter[k], P_METER);
            draws += 1;
            passes += 1;
        }
        // 6. the composite (and FXAA)
        match (&t.ldr, &t.bg_fxaa) {
            (Some(ldr), Some(fx)) => {
                full_pass(&mut enc, "forge composite", ldr, &self.composite_ldr, &t.bg_composite[k], P_COMPOSITE);
                full_pass(&mut enc, "forge fxaa", &out_view, &self.fxaa, fx, P_FXAA);
                draws += 2;
                passes += 2;
            }
            _ => {
                full_pass(&mut enc, "forge composite", &out_view, &self.composite_surface, &t.bg_composite[k], P_COMPOSITE);
                draws += 1;
                passes += 1;
            }
        }
        self.queue.submit([enc.finish()]);
        self.queue.present(frame);
        if metered {
            self.meter_next = 1 - k;
        }
        Ok(Some(Stats {
            draws,
            passes,
            instances: fr.main.len() as u32,
            actors: scene.actors.iter().filter(|a| a.visible).count() as u32,
            particles: n_world + n_top,
            lights: nlights,
            flashes: scene.flashes.iter().filter(|f| f.age < f.life).count() as u32,
            shadow: if shadows { self.shadow.size } else { 0 },
            bloom,
            width: w,
            height: h,
            palette: scene.palette.len() as u32,
            tracers: n_tracers,
            culled: fr.culled,
            casters: fr.shadow.len() as u32,
            fire_faces: fire_faces.len() as u32,
            fire_casters: self.fire.slots.iter().flatten().count() as u32,
        }))
    }

    /// The slot-ID passes (A: everything; B: only `slots`), copied into the staging buffer for the caller to map.
    pub fn sight(&mut self, scene: &Scene, slots: &[u32]) -> Result<(), String> {
        self.sync(scene);
        let (w, h) = (self.config.width, self.config.height);
        self.ensure_shadow(scene.look.shadow_size);
        self.write_globals(scene, w, h);
        self.upload_palette(&scene.palette);
        let items = scene.items();
        let mut all = scene.records(&items);
        let mut only: Vec<Rec> = all.iter().copied().filter(|r| slots.contains(&r.slot)).collect();
        let runs_a = runs_of(&mut all);
        let runs_b = runs_of(&mut only);
        let mut both = all.clone();
        both.extend_from_slice(&only);
        let offset = all.len() as u32;
        let runs_b: Vec<Run> = runs_b.into_iter().map(|r| Run { start: r.start + offset, ..r }).collect();
        self.write_instances(&[&both], true);
        let mut enc = self.device.create_command_encoder(&wgpu::CommandEncoderDescriptor { label: Some("forge sight") });
        for (view, runs) in [(&self.sight.a_view, &runs_a), (&self.sight.b_view, &runs_b)] {
            for (layer, clear) in [(LAYER_WORLD, true), (LAYER_FP, false)] {
                let mut pass = enc.begin_render_pass(&wgpu::RenderPassDescriptor {
                    label: Some("forge ids"),
                    color_attachments: &[Some(wgpu::RenderPassColorAttachment { view, depth_slice: None, resolve_target: None, ops: wgpu::Operations { load: if clear { wgpu::LoadOp::Clear(wgpu::Color::TRANSPARENT) } else { wgpu::LoadOp::Load }, store: wgpu::StoreOp::Store } })],
                    depth_stencil_attachment: Some(wgpu::RenderPassDepthStencilAttachment { view: &self.sight.depth, depth_ops: Some(wgpu::Operations { load: wgpu::LoadOp::Clear(1.0), store: wgpu::StoreOp::Discard }), stencil_ops: None }),
                    ..Default::default()
                });
                pass.set_bind_group(0, self.fbg(if layer == LAYER_FP { G_FP } else { G_WORLD }), &[]);
                self.draw_runs(&mut pass, runs, layer, Mode::Ids, &self.aux_buf);
            }
        }
        let bytes_per_row = SIGHT_W * 4;
        let one = (bytes_per_row * SIGHT_H) as u64;
        for (k, tex) in [&self.sight.a, &self.sight.b].into_iter().enumerate() {
            enc.copy_texture_to_buffer(
                wgpu::TexelCopyTextureInfo { texture: tex, mip_level: 0, origin: wgpu::Origin3d::ZERO, aspect: wgpu::TextureAspect::All },
                wgpu::TexelCopyBufferInfo { buffer: &self.sight.staging, layout: wgpu::TexelCopyBufferLayout { offset: one * k as u64, bytes_per_row: Some(bytes_per_row), rows_per_image: Some(SIGHT_H) } },
                wgpu::Extent3d { width: SIGHT_W, height: SIGHT_H, depth_or_array_layers: 1 },
            );
        }
        self.queue.submit([enc.finish()]);
        Ok(())
    }

    /// One actor's skinned vertices, one float pixel each, copied into the capture buffer. → the vertex count.
    pub fn capture(&mut self, scene: &Scene, actor_id: u32) -> Result<u32, String> {
        self.sync(scene);
        let a = scene.actors.iter().find(|a| a.id == actor_id).ok_or_else(|| format!("no actor {actor_id} this frame"))?;
        let m = scene.models.get(a.model).ok_or("no such model")?;
        if !m.bound {
            return Err("the actor's model is not bound to a skeleton".into());
        }
        self.upload_palette(&scene.palette);
        let mut recs = Vec::new();
        let mut first = 0u32;
        let mut parts = Vec::new();
        for p in m.prims.iter().filter(|p| p.skinned) {
            let n = scene.meshes[p.mesh].vertices.len() as u32;
            recs.push(Rec { layer: 0, variant: VARIANT_SKINNED, mesh: p.mesh, tex: None, etex: None, slot: a.slot, shadow: false, inst: InstData { m: a.transform.to_cols_array_2d(), tint: [1.0; 4], flash: [0.0; 4], emissive: [0.0; 4], extra: [0, 0, a.bones + p.bone_offset, first], surf: [0.0; 4] } });
            parts.push((p.mesh, first, n));
            first += n;
        }
        let total = first;
        if total == 0 {
            return Err("the actor has no skinned vertices".into());
        }
        if self.capture.is_none() {
            return Err("this device cannot draw into a float image: no vertex capture".into());
        }
        let rows = total.div_ceil(CAPTURE_W);
        if self.capture_tex.as_ref().is_none_or(|(_, _, r)| *r < rows) {
            let rr = rows.next_power_of_two().min(self.max_dim);
            if rr < rows {
                return Err(format!("{total} vertices are more than one capture holds"));
            }
            let tex = tex2d(&self.device, "forge capture", CAPTURE_W, rr, CAPTURE_FORMAT, wgpu::TextureUsages::RENDER_ATTACHMENT | wgpu::TextureUsages::COPY_SRC);
            let view = tex.create_view(&Default::default());
            self.capture_buf = Some(self.device.create_buffer(&wgpu::BufferDescriptor { label: Some("forge capture readback"), size: (rr * CAPTURE_W * 16) as u64, usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ, mapped_at_creation: false }));
            self.capture_tex = Some((tex, view, rr));
        }
        self.write_instances(&[&recs], true);
        let (tex, view, rr) = self.capture_tex.as_ref().unwrap();
        // the globals the capture reads: the image's row count
        let mut gl = GlobalsU::zeroed_like();
        gl.screen = [CAPTURE_W as f32, *rr as f32, 0.0, 0.0];
        self.queue.write_buffer(&self.globals[G_AUX], 0, bytemuck::bytes_of(&gl));
        let mut enc = self.device.create_command_encoder(&wgpu::CommandEncoderDescriptor { label: Some("forge capture") });
        {
            let mut pass = enc.begin_render_pass(&wgpu::RenderPassDescriptor {
                label: Some("forge capture"),
                color_attachments: &[Some(wgpu::RenderPassColorAttachment { view, depth_slice: None, resolve_target: None, ops: wgpu::Operations { load: wgpu::LoadOp::Clear(wgpu::Color::TRANSPARENT), store: wgpu::StoreOp::Store } })],
                ..Default::default()
            });
            pass.set_pipeline(self.capture.as_ref().unwrap());
            pass.set_bind_group(0, self.fbg(G_AUX), &[]);
            for (k, (mesh, _first, n)) in parts.iter().enumerate() {
                let gm = &self.meshes[*mesh];
                let Some(sk) = gm.skin.as_ref() else { continue };
                pass.set_vertex_buffer(0, gm.vbuf.slice(..));
                pass.set_vertex_buffer(1, sk.slice(..));
                pass.set_vertex_buffer(2, self.aux_buf.slice(k as u64 * INST_SIZE..));
                pass.draw(0..(*n).min(gm.vcount), 0..1);
            }
        }
        enc.copy_texture_to_buffer(
            wgpu::TexelCopyTextureInfo { texture: tex, mip_level: 0, origin: wgpu::Origin3d::ZERO, aspect: wgpu::TextureAspect::All },
            wgpu::TexelCopyBufferInfo { buffer: self.capture_buf.as_ref().unwrap(), layout: wgpu::TexelCopyBufferLayout { offset: 0, bytes_per_row: Some(CAPTURE_W * 16), rows_per_image: Some(*rr) } },
            wgpu::Extent3d { width: CAPTURE_W, height: *rr, depth_or_array_layers: 1 },
        );
        self.queue.submit([enc.finish()]);
        Ok(total)
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Mode {
    Main,
    Shadow,
    Ids,
}

impl GlobalsU {
    fn zeroed_like() -> Self {
        bytemuck::Zeroable::zeroed()
    }
}

/// The moon's shadow camera: an orthographic box around the ground ahead of the eye, its centre snapped to whole
/// texels (no shimmer as the eye moves). → (view-projection, a texel in metres, the reach in metres).
fn shadow_matrix(scene: &Scene, sun: Vec3) -> (Mat4, f32, f32) {
    let l = &scene.look;
    let size = l.shadow_size.max(1) as f32;
    let r = l.shadow_distance * 0.55;
    let eye = scene.camera.eye;
    let d = scene.camera.dir();
    let flat = Vec3::new(d.x, 0.0, d.z).normalize_or(Vec3::NEG_Z);
    let centre = eye + flat * (r * 0.6);
    let up = if sun.y.abs() > 0.99 { Vec3::Z } else { Vec3::Y };
    let view = glam::camera::rh::view::look_to_mat4(Vec3::ZERO, -sun, up);
    let texel = 2.0 * r / size;
    let c = view.transform_point3(centre);
    let (cx, cy) = ((c.x / texel).round() * texel, (c.y / texel).round() * texel);
    let depth = 160.0;
    let proj = glam::camera::rh::proj::directx::orthographic(cx - r, cx + r, cy - r, cy + r, -c.z - depth, -c.z + depth);
    (proj * view, texel, r * 1.6)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Every shader module parses and validates (naga, natively), and keeps within WebGL2's inter-stage limit.
    #[test]
    fn the_shaders_validate() {
        for name in ["mesh", "sky", "particles", "post"] {
            let src = shader_src(name);
            let module = naga::front::wgsl::parse_str(&src).unwrap_or_else(|e| panic!("{name}.wgsl: {}", e.emit_to_string(&src)));
            naga::valid::Validator::new(naga::valid::ValidationFlags::all(), naga::valid::Capabilities::default()).validate(&module).unwrap_or_else(|e| panic!("{name}.wgsl does not validate: {e:?}"));
            for ep in &module.entry_points {
                if ep.stage == naga::ShaderStage::Vertex
                    && let Some(r) = &ep.function.result
                    && let naga::TypeInner::Struct { members, .. } = &module.types[r.ty].inner
                {
                    let varyings = members.iter().filter(|m| matches!(m.binding, Some(naga::Binding::Location { .. }))).count();
                    assert!(varyings <= 15, "{name} {}: {varyings} inter-stage variables (WebGL2: 15)", ep.name);
                }
            }
        }
    }

    /// The WebGL2 build (wave 3, track W): every entry point of every shader module is translated to GLSL ES 3.00 by
    /// naga, as wgpu's GL backend does when a pipeline is made in the browser. What WGSL allows and WebGL2 does not
    /// fails here, natively, with its reason (the first one found this way: one picture read through two samplers).
    #[test]
    fn the_shaders_translate_to_webgl2() {
        use naga::back::glsl;
        for name in ["mesh", "sky", "particles", "post"] {
            let src = shader_src(name);
            let module = naga::front::wgsl::parse_str(&src).unwrap_or_else(|e| panic!("{name}.wgsl: {}", e.emit_to_string(&src)));
            let info = naga::valid::Validator::new(naga::valid::ValidationFlags::all(), naga::valid::Capabilities::default()).validate(&module).unwrap_or_else(|e| panic!("{name}.wgsl does not validate: {e:?}"));
            let options = glsl::Options { version: naga::back::glsl::Version::Embedded { version: 300, is_webgl: true }, ..Default::default() };
            for ep in &module.entry_points {
                let pipeline = glsl::PipelineOptions { shader_stage: ep.stage, entry_point: ep.name.clone(), multiview: None };
                let mut out = String::new();
                let mut writer = glsl::Writer::new(&mut out, &module, &info, &options, &pipeline, naga::proc::BoundsCheckPolicies::default()).unwrap_or_else(|e| panic!("{name}.wgsl {}: not WebGL2: {e}", ep.name));
                writer.write().unwrap_or_else(|e| panic!("{name}.wgsl {}: not WebGL2: {e}", ep.name));
                assert!(out.contains("#version 300 es"), "{name}.wgsl {}: {}", ep.name, out.lines().next().unwrap_or(""));
            }
        }
    }

    /// The WebGL2 build carries each module as naga's IR in bincode (build.rs writes it, `shader_source` reads it):
    /// the trip there and back gives a module that validates and writes the same GLSL as the parsed one.
    #[test]
    fn the_shader_ir_survives_the_trip() {
        use naga::back::glsl;
        let glsl_of = |module: &naga::Module, name: &str| -> Vec<String> {
            let info = naga::valid::Validator::new(naga::valid::ValidationFlags::all(), naga::valid::Capabilities::default()).validate(module).unwrap_or_else(|e| panic!("{name}: {e:?}"));
            let options = glsl::Options { version: glsl::Version::Embedded { version: 300, is_webgl: true }, ..Default::default() };
            module
                .entry_points
                .iter()
                .map(|ep| {
                    let pipeline = glsl::PipelineOptions { shader_stage: ep.stage, entry_point: ep.name.clone(), multiview: None };
                    let mut out = String::new();
                    glsl::Writer::new(&mut out, module, &info, &options, &pipeline, naga::proc::BoundsCheckPolicies::default()).unwrap().write().unwrap();
                    out
                })
                .collect()
        };
        for name in ["mesh", "sky", "particles", "post"] {
            let src = shader_src(name);
            let parsed = naga::front::wgsl::parse_str(&src).unwrap();
            let bytes = bincode::serialize(&parsed).unwrap();
            let back: naga::Module = bincode::deserialize(&bytes).unwrap_or_else(|e| panic!("{name}: the IR did not read back: {e}"));
            assert_eq!(glsl_of(&parsed, name), glsl_of(&back, name), "{name}: the GLSL changed across the trip");
            assert!(bytes.len() < 200_000, "{name}: {} bytes of IR", bytes.len());
        }
    }

    /// A fire shadow face's projection is the one mesh.wgsl `fire_shadow` undoes: the same faces in the same order,
    /// the same picture coordinates, the same depth.
    #[test]
    fn a_fire_face_is_what_the_shader_reads() {
        let (pos, reach) = (Vec3::new(2.0, 1.0, -3.0), 11.0);
        // points about the light, each strictly inside one drawn face
        for p in [Vec3::new(5.0, 0.5, -2.0), Vec3::new(-1.0, 1.8, -4.0), Vec3::new(2.5, -0.9, -3.4), Vec3::new(1.0, 0.2, 1.0), Vec3::new(3.0, 2.5, -9.0)] {
            // mesh.wgsl fire_shadow
            let v = p - pos;
            let a = v.abs();
            let m = a.max_element();
            let (face, f, u) = if a.x >= a.y && a.x >= a.z {
                (if v.x > 0.0 { 0 } else { 1 }, Vec3::new(v.x.signum(), 0.0, 0.0), Vec3::Y)
            } else if a.y >= a.z {
                assert!(v.y < 0.0, "the test's points are not above the fire");
                (2, Vec3::NEG_Y, Vec3::Z)
            } else {
                (if v.z > 0.0 { 3 } else { 4 }, Vec3::new(0.0, 0.0, v.z.signum()), Vec3::Y)
            };
            assert_eq!((f, u), FIRE_FACES[face], "face {face}");
            let r = f.cross(u);
            let ndc = glam::Vec2::new(v.dot(r), v.dot(u)) / m;
            let depth = reach / (reach - FIRE_NEAR) - reach * FIRE_NEAR / ((reach - FIRE_NEAR) * m);
            // the face as drawn
            let c = fire_face(pos, reach, face) * p.extend(1.0);
            let q = c.truncate() / c.w;
            assert!((q.x - ndc.x).abs() < 1e-4 && (q.y - ndc.y).abs() < 1e-4 && (q.z - depth).abs() < 1e-4, "face {face}: drawn {q:?}, read {ndc:?} {depth}");
            assert!(q.x.abs() <= 1.0 && q.y.abs() <= 1.0 && q.z > 0.0 && q.z < 1.0);
        }
    }

    #[test]
    fn records_sort_into_runs() {
        let r = |layer: u8, mesh: usize, tex: Option<usize>| Rec { layer, variant: 0, mesh, tex, etex: None, slot: 0, shadow: true, inst: bytemuck::Zeroable::zeroed() };
        let mut recs = vec![r(1, 0, None), r(0, 2, Some(1)), r(0, 2, Some(1)), r(0, 1, None), r(0, 2, Some(1))];
        let runs = runs_of(&mut recs);
        assert_eq!(runs.len(), 3);
        assert_eq!((runs[1].mesh, runs[1].count, runs[1].start), (2, 3, 1));
        assert_eq!(runs[2].layer, 1, "the first-person layer last");
    }
}
