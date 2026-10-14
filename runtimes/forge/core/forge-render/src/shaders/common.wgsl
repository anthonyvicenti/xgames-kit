// gf-forge's shared shader header: the frame's globals (one uniform binding, ~1.5 KiB of WebGL2's 16 KiB) and the
// bone palette (a float texture, 4 texels a bone: WebGL2 has no storage buffers), prepended to mesh.wgsl, sky.wgsl and
// particles.wgsl.

const MAX_LIGHTS: u32 = 32u;
const BONES_WIDTH: u32 = 1024u;

struct Light {
  pos: vec4<f32>,    // xyz position, w range (m)
  color: vec4<f32>,  // rgb linear colour, w intensity
}

struct Globals {
  view_proj: mat4x4<f32>,
  view: mat4x4<f32>,
  inv_view_proj: mat4x4<f32>,
  shadow_vp: mat4x4<f32>,
  eye: vec4<f32>,          // xyz the eye, w time (s)
  sun_dir: vec4<f32>,      // xyz towards the moon, w shadows on (0/1)
  sun_color: vec4<f32>,    // rgb, w intensity
  ambient: vec4<f32>,      // rgb, w intensity
  fog: vec4<f32>,          // rgb, w exponential density
  fog_lin: vec4<f32>,      // x near, y far (far <= near: no linear ramp), z emissive scale, w point light count
  sky_zenith: vec4<f32>,   // rgb, w stars
  sky_horizon: vec4<f32>,  // rgb, w haze (how high the horizon's colour reaches)
  moon: vec4<f32>,         // rgb disc colour, w brightness
  moon2: vec4<f32>,        // x angular radius (rad), y glow, z the retro texels' crispness (0 averaged, 1 one texel), w unused
  shadow: vec4<f32>,       // x texel (m), y strength, z normal offset (texels), w softness (texels)
  shadow_uv: vec4<f32>,    // x 1 / map size, y reach (m), z a point light's knee as a share of its range (0: 1 m), w the backdrop's fog scale
  screen: vec4<f32>,       // x target w, y target h, z vertex snap lines (0 off), w retro texels (0/1)
  fire_slots: vec4<f32>,   // per fire shadow slot: which of `lights` casts it (−1: none)
  fire_cfg: vec4<f32>,     // x the faces' near plane (m), y how dark (0: no fire casts), z 1 / a face's side, w unused
  ldr: vec4<f32>,          // the 8-bit scene (below): x the look's exposure (0: the HDR scene, nothing of this runs), y the tone curve, z how far the eye adapts (0..1), w unused
  lights: array<Light, 32>,
}

@group(0) @binding(0) var<uniform> g: Globals;
@group(0) @binding(1) var bones: texture_2d<f32>;
// the eye's adaptation as last frame's meter left it (post.wgsl fs_meter): read here only by the 8-bit scene
@group(0) @binding(2) var meter: texture_2d<f32>;

// ---- the 8-bit scene (wave 3, track W; kit/look.js BACKEND_TIERS "ldr") ----
// A device that cannot draw into a float target (WebGL2 without EXT_color_buffer_float and _half_float) has no HDR
// scene to tone afterwards: the scene target is 8 bits a channel (sRGB encoded), so what is brighter than white is gone
// once it is written. There the exposure and the tone curve are applied here, as each pixel of the scene is drawn, and
// the composite only adds what follows them (saturation, vignette, gamma, contrast, grain, the colour steps). The
// exposure still follows the picture: the meter keeps its factor in an 8-bit texel (two bytes of it, post.wgsl), read
// once a vertex. No bloom on this path.

/// This frame's exposure for the 8-bit scene (0: the HDR scene). Called in the vertex stage, carried flat.
fn ldr_exposure() -> f32 {
  if (g.ldr.x <= 0.0) {
    return 0.0;
  }
  let m = textureLoad(meter, vec2<i32>(0, 0), 0);
  let k = select(1.0, (m.r * 65280.0 + m.g * 255.0) / 65535.0 * 2.0, m.a > 0.5);
  return g.ldr.x * mix(1.0, k, clamp(g.ldr.z, 0.0, 1.0));
}

/// A scene colour as its target takes it: itself into the HDR scene (`e` 0), exposed and toned into the 8-bit one
/// (post.wgsl `curve_of`: 1 ACES, 2 Reinhard, else clamp).
fn scene_out(c: vec3<f32>, e: f32) -> vec3<f32> {
  let x = max(c, vec3<f32>(0.0));
  if (e <= 0.0) {
    return x;
  }
  let v = x * e;
  let curve = u32(g.ldr.y + 0.5);
  if (curve == 1u) {
    return clamp((v * (2.51 * v + 0.03)) / (v * (2.43 * v + 0.59) + 0.14), vec3<f32>(0.0), vec3<f32>(1.0));
  }
  if (curve == 2u) {
    return v / (1.0 + v);
  }
  return clamp(v, vec3<f32>(0.0), vec3<f32>(1.0));
}

fn bone(i: u32) -> mat4x4<f32> {
  let t = i * 4u;
  let x = i32(t % BONES_WIDTH);
  let y = i32(t / BONES_WIDTH);
  return mat4x4<f32>(
    textureLoad(bones, vec2<i32>(x, y), 0),
    textureLoad(bones, vec2<i32>(x + 1, y), 0),
    textureLoad(bones, vec2<i32>(x + 2, y), 0),
    textureLoad(bones, vec2<i32>(x + 3, y), 0));
}

/// The vertex's skin matrix: its four bones' (world × inverse bind) weighted.
fn skin_matrix(base: u32, j: vec4<u32>, w: vec4<f32>) -> mat4x4<f32> {
  return bone(base + j.x) * w.x + bone(base + j.y) * w.y + bone(base + j.z) * w.z + bone(base + j.w) * w.w;
}

/// A normal through a model matrix: its cofactor (the inverse transpose without the divide), sign kept for mirrors.
fn normal_of(m: mat4x4<f32>, n: vec3<f32>) -> vec3<f32> {
  let a = m[0].xyz;
  let b = m[1].xyz;
  let c = m[2].xyz;
  let cof = mat3x3<f32>(cross(b, c), cross(c, a), cross(a, b));
  let s = select(1.0, -1.0, dot(a, cross(b, c)) < 0.0);
  return normalize(cof * n) * s;
}

/// Exponential fog over the linear near/far ramp, `d` metres from the eye.
fn fog_at(d: f32) -> f32 {
  var lin = 0.0;
  if (g.fog_lin.y > g.fog_lin.x) {
    lin = clamp((d - g.fog_lin.x) / (g.fog_lin.y - g.fog_lin.x), 0.0, 1.0);
  }
  let ex = 1.0 - exp(-g.fog.w * d);
  return 1.0 - (1.0 - lin) * (1.0 - ex);
}

fn fog_amount(world: vec3<f32>) -> f32 {
  return fog_at(distance(g.eye.xyz, world));
}

/// The backdrop's fog: as if it stood `k` times as far (look.backdrop.fog), so what is beyond the walls layers into
/// silhouettes.
fn fog_amount_scaled(world: vec3<f32>, k: f32) -> f32 {
  return fog_at(distance(g.eye.xyz, world) * max(k, 0.0));
}
