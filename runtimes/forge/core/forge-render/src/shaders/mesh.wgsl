// gf-forge's meshes (after common.wgsl): every static model, skinned body and first-person piece, instanced. One
// instance is 9 vec4s (the model matrix, tint × base colour, hit flash, emissive (w 1: × a picture), slot / flags /
// bone base, and the surface: the retro texel grid and the world-space tile); a skinned vertex adds four joints and
// weights. Entry points:
//   vs_static / vs_skinned + fs_main         the lit forward pass into the HDR target (a moon with one shadow map,
//                                            ambient, up to 32 point lights, fog, emissive, the hit flash)
//   vs_static_id / vs_skinned_id + fs_id     the slot-ID pass (verify's sight(): slot + 1 per pixel)
//   vs_static_depth / vs_skinned_depth       the moon's shadow map and a fire's shadow faces (depth only)
//   vs_capture + fs_capture                  each skinned vertex's place as one float pixel (verify check 19)
// Within WebGL2's limits: no storage buffers, 14 vertex attributes (of 16), 8 inter-stage variables (of 15).
//
// Wave 7: an actor's rim of light (an elite's modifier, read at a glance) rides in `extra.w` (rim_of), so no attribute
// is added: brightest where the body turns from the eye, a little over all of it, half of it through the fog.
//
// The retro texel look (look.retro.texels with look.retro.density; fs_main `texels`): a picture is not sampled at
// the screen's pixels but on a grid of square texels, `surf.y` of them across one unit of the surface's UVs (the
// renderer works that out from the look's texels a metre). Each texel takes one colour (the picture averaged over it,
// from its mips), its edges are one screen pixel soft, and once a texel is smaller than a pixel the mips take over: it
// reads as nearest sampling up close and never shimmers in motion. With the option off the same grid is filtered
// smooth (a low-resolution picture, bilinear). A surface laid in world space (surf.z, a tile in metres) takes its UVs
// from where it is, so the grid lines up from floor to wall.

@group(1) @binding(0) var albedo_tex: texture_2d<f32>;
@group(1) @binding(1) var samp_linear: sampler;
@group(1) @binding(2) var emissive_tex: texture_2d<f32>;
@group(2) @binding(0) var shadow_map: texture_depth_2d;
@group(2) @binding(1) var shadow_samp: sampler_comparison;
@group(2) @binding(2) var fire_map: texture_depth_2d_array;

const FLAG_UNLIT: u32 = 1u;
const FLAG_MASK: u32 = 4u;
const FLAG_BACKDROP: u32 = 8u;
const FLAG_EMISSIVE_TEX: u32 = 16u;

struct VIn {
  @location(0) pos: vec3<f32>,
  @location(1) normal: vec3<f32>,
  @location(2) uv: vec2<f32>,
}

struct SkinIn {
  @location(11) joints: vec4<u32>,
  @location(12) weights: vec4<f32>,
}

struct Inst {
  @location(3) m0: vec4<f32>,
  @location(4) m1: vec4<f32>,
  @location(5) m2: vec4<f32>,
  @location(6) m3: vec4<f32>,
  @location(7) tint: vec4<f32>,
  @location(8) flash: vec4<f32>,
  @location(9) emissive: vec4<f32>,
  @location(10) extra: vec4<u32>,   // x slot + 1 (0 none), y flags, z bone base, w the capture's first pixel (vs_capture) or the rim (rim_of)
  @location(13) surf: vec4<f32>,    // x the texel grid (texels across one UV unit; 0: the picture's own), y the world tile (m; 0: the mesh's UVs)
}

struct VOut {
  @builtin(position) clip: vec4<f32>,
  @location(0) world: vec3<f32>,
  @location(1) normal: vec3<f32>,
  @location(2) uv: vec2<f32>,
  @location(3) tint: vec4<f32>,
  @location(4) flash: vec4<f32>,
  @location(5) emissive: vec4<f32>,
  @location(6) @interpolate(flat) surf: vec4<f32>,   // x flags, y the texel grid, z the world tile, w the 8-bit scene's exposure (0: the HDR scene)
  @location(7) @interpolate(flat) rim: vec4<f32>,    // wave 7: the rim's colour and strength (a 0: none)
}

/// The rim packed in `extra.w` (lib.rs pack_rim): r g b bytes of the colour over its largest part, the top byte its
/// strength at 32 a unit.
fn rim_of(w: u32) -> vec4<f32> {
  let c = vec3<f32>(f32(w & 255u), f32((w >> 8u) & 255u), f32((w >> 16u) & 255u)) / 255.0;
  return vec4<f32>(c, f32(w >> 24u) / 32.0);
}

fn model_of(i: Inst) -> mat4x4<f32> {
  return mat4x4<f32>(i.m0, i.m1, i.m2, i.m3);
}

/// Vertex snap (the retro option): clip positions snapped to a virtual screen of `lines` rows.
fn snap(c: vec4<f32>) -> vec4<f32> {
  let lines = g.screen.z;
  if (lines <= 0.0 || c.w <= 0.0) {
    return c;
  }
  let grid = vec2<f32>(lines * g.screen.x / max(g.screen.y, 1.0), lines) * 0.5;
  let ndc = c.xy / c.w;
  return vec4<f32>(round(ndc * grid) / grid * c.w, c.z, c.w);
}

fn finish(m: mat4x4<f32>, v: VIn, i: Inst) -> VOut {
  let w = m * vec4<f32>(v.pos, 1.0);
  var o: VOut;
  o.clip = snap(g.view_proj * w);
  o.world = w.xyz;
  o.normal = normal_of(m, v.normal);
  o.uv = v.uv;
  o.tint = i.tint;
  o.flash = i.flash;
  o.emissive = i.emissive;
  o.surf = vec4<f32>(f32(i.extra.y), i.surf.x, i.surf.y, ldr_exposure());
  o.rim = rim_of(i.extra.w);
  return o;
}

@vertex
fn vs_static(v: VIn, i: Inst) -> VOut {
  return finish(model_of(i), v, i);
}

@vertex
fn vs_skinned(v: VIn, s: SkinIn, i: Inst) -> VOut {
  return finish(model_of(i) * skin_matrix(i.extra.z, s.joints, s.weights), v, i);
}

/// The moon's light that reaches a point: 4 hardware-filtered taps of its shadow map, fading out at the reach.
fn shadow_at(world: vec3<f32>, n: vec3<f32>) -> f32 {
  if (g.sun_dir.w < 0.5) {
    return 1.0;
  }
  let p = g.shadow_vp * vec4<f32>(world + n * (g.shadow.z * g.shadow.x), 1.0);
  let uv = vec2<f32>(p.x * 0.5 + 0.5, 0.5 - p.y * 0.5);
  let d = p.z - 0.0005;
  let r = g.shadow.w * g.shadow_uv.x;
  var lit = 0.0;
  lit += textureSampleCompareLevel(shadow_map, shadow_samp, uv + vec2<f32>(-r, -r), d);
  lit += textureSampleCompareLevel(shadow_map, shadow_samp, uv + vec2<f32>(r, -r), d);
  lit += textureSampleCompareLevel(shadow_map, shadow_samp, uv + vec2<f32>(-r, r), d);
  lit += textureSampleCompareLevel(shadow_map, shadow_samp, uv + vec2<f32>(r, r), d);
  lit *= 0.25;
  let inside = uv.x > 0.0 && uv.x < 1.0 && uv.y > 0.0 && uv.y < 1.0 && d < 1.0;
  let fade = smoothstep(0.8, 1.0, distance(world.xz, g.eye.xz) / max(g.shadow_uv.y, 0.1));
  let s = select(1.0, mix(lit, 1.0, fade), inside);
  return mix(1.0, s, g.shadow.y);
}

/// A fire's light that reaches a point: its shadow cube's face toward the point (five layers a slot: +X, −X, −Y, +Z,
/// −Z as gpu.rs FIRE_FACES; nothing above a fire is shadowed), one hardware-filtered tap, the point pushed off its
/// surface by about a texel and a half at that distance.
fn fire_shadow(slot: u32, lpos: vec3<f32>, range: f32, world: vec3<f32>, n: vec3<f32>) -> f32 {
  let d0 = distance(world, lpos);
  let v = world + n * (d0 * g.fire_cfg.z * 3.0 + 0.02) - lpos;
  let a = abs(v);
  let m = max(a.x, max(a.y, a.z));
  var face = 0u;
  var f = vec3<f32>(1.0, 0.0, 0.0);
  var u = vec3<f32>(0.0, 1.0, 0.0);
  if (a.x >= a.y && a.x >= a.z) {
    face = select(1u, 0u, v.x > 0.0);
    f = vec3<f32>(sign(v.x), 0.0, 0.0);
  } else if (a.y >= a.z) {
    if (v.y > 0.0) {
      return 1.0;
    }
    face = 2u;
    f = vec3<f32>(0.0, -1.0, 0.0);
    u = vec3<f32>(0.0, 0.0, 1.0);
  } else {
    face = select(4u, 3u, v.z > 0.0);
    f = vec3<f32>(0.0, 0.0, sign(v.z));
  }
  let r = cross(f, u);
  let ndc = vec2<f32>(dot(v, r), dot(v, u)) / max(m, 0.0001);
  let near = g.fire_cfg.x;
  let far = max(range, near * 2.0);
  let depth = far / (far - near) - far * near / ((far - near) * max(m, near));
  let lit = textureSampleCompareLevel(fire_map, shadow_samp, vec2<f32>(ndc.x * 0.5 + 0.5, 0.5 - ndc.y * 0.5), i32(slot * 5u + face), depth - 0.0004);
  return mix(1.0, lit, g.fire_cfg.y);
}

/// A point light's brightness at `dist` of its `range`: a smooth window to nothing at the range over an inverse
/// square with a knee: 1 m (wave 1's lights), or `look.lights.falloff` of the range when that is more (a fire's wide
/// pool; a muzzle flash's short reach keeps its 1 m).
fn light_falloff(dist: f32, range: f32) -> f32 {
  let q = clamp(1.0 - pow(dist / range, 4.0), 0.0, 1.0);
  let knee = max(g.shadow_uv.z * range, 1.0);
  let x = dist / knee;
  return q * q / (1.0 + x * x);
}

@fragment
fn fs_main(i: VOut, @builtin(front_facing) front: bool) -> @location(0) vec4<f32> {
  let flags = u32(i.surf.x + 0.5);
  // ---- where on the picture: the mesh's own UVs, or the world's (a tiling ground or wall) ----
  // (every screen derivative is taken here, before anything branches on what this instance is)
  let face = abs(cross(dpdx(i.world), dpdy(i.world)));
  let flat_y = i.world.xz;
  let side_x = vec2<f32>(i.world.z, -i.world.y);
  let side_z = vec2<f32>(i.world.x, -i.world.y);
  var wuv = select(side_z, side_x, face.x >= face.z);
  wuv = select(wuv, flat_y, face.y >= face.x && face.y >= face.z);
  let tile = i.surf.z;
  let uv = select(i.uv, wuv / max(tile, 0.0001), tile > 0.0);
  let dims = vec2<f32>(textureDimensions(albedo_tex, 0));
  // the texel grid: never finer than the picture's own texels
  let grid = select(dims, min(vec2<f32>(i.surf.y), dims), i.surf.y > 0.0);
  let t = uv * grid;
  let fw = max(fwidth(t), vec2<f32>(0.00001));
  var tex: vec4<f32>;
  var etex = vec3<f32>(1.0);
  if (g.screen.w > 0.5) {
    // square texels: the two texels either side of the nearest texel edge on each axis, blended across one pixel
    let seam = floor(t + 0.5);
    let k = clamp((t - seam) / fw, vec2<f32>(-0.5), vec2<f32>(0.5)) + 0.5;
    let a = (seam - 0.5) / grid;
    let b = (seam + 0.5) / grid;
    // the mip a texel of the grid averages (the picture's texels in it; look.retro.crisp takes a finer one: grittier
    // texels), and the screen's beyond one texel a pixel
    let lod = log2(max(max(dims.x / grid.x, dims.y / grid.y), 1.0)) * (1.0 - g.moon2.z) + max(log2(max(fw.x, fw.y)), 0.0);
    let c00 = textureSampleLevel(albedo_tex, samp_linear, a, lod);
    let c10 = textureSampleLevel(albedo_tex, samp_linear, vec2<f32>(b.x, a.y), lod);
    let c01 = textureSampleLevel(albedo_tex, samp_linear, vec2<f32>(a.x, b.y), lod);
    let c11 = textureSampleLevel(albedo_tex, samp_linear, b, lod);
    tex = mix(mix(c00, c10, k.x), mix(c01, c11, k.x), k.y);
    if ((flags & FLAG_EMISSIVE_TEX) != 0u) {
      let e00 = textureSampleLevel(emissive_tex, samp_linear, a, lod).rgb;
      let e10 = textureSampleLevel(emissive_tex, samp_linear, vec2<f32>(b.x, a.y), lod).rgb;
      let e01 = textureSampleLevel(emissive_tex, samp_linear, vec2<f32>(a.x, b.y), lod).rgb;
      let e11 = textureSampleLevel(emissive_tex, samp_linear, b, lod).rgb;
      etex = mix(mix(e00, e10, k.x), mix(e01, e11, k.x), k.y);
    } else {
      etex = tex.rgb;
    }
  } else {
    // smooth (the retro option off): the same texels, filtered: the mip a texel of the grid averages, or the screen's
    // once a texel is under a pixel
    let lod = log2(max(max(dims.x / grid.x, dims.y / grid.y), 1.0)) + max(log2(max(fw.x, fw.y)), 0.0);
    tex = textureSampleLevel(albedo_tex, samp_linear, uv, lod);
    if ((flags & FLAG_EMISSIVE_TEX) != 0u) {
      etex = textureSampleLevel(emissive_tex, samp_linear, uv, lod).rgb;
    } else {
      etex = tex.rgb;
    }
  }
  let albedo = tex * i.tint;
  if ((flags & FLAG_MASK) != 0u && albedo.a < 0.5) {
    discard;
  }
  var n = normalize(i.normal);
  if (!front) {
    n = -n;
  }
  let backdrop = (flags & FLAG_BACKDROP) != 0u;
  var col = albedo.rgb;
  if ((flags & FLAG_UNLIT) == 0u) {
    var light = g.ambient.rgb * g.ambient.w;
    let sd = normalize(g.sun_dir.xyz);
    let ndl = dot(n, sd);
    if (backdrop) {
      // beyond the walls: the moon and the ambient light, no shadow lookup, no fire
      light += g.sun_color.rgb * g.sun_color.w * max(ndl, 0.0);
    } else {
      if (ndl > 0.0) {
        light += g.sun_color.rgb * g.sun_color.w * ndl * shadow_at(i.world, n);
      }
      let count = min(u32(g.fog_lin.w), MAX_LIGHTS);
      for (var k = 0u; k < MAX_LIGHTS; k = k + 1u) {
        if (k >= count) {
          break;
        }
        let l = g.lights[k];
        let to = l.pos.xyz - i.world;
        let dist = length(to);
        let range = max(l.pos.w, 0.01);
        if (dist >= range) {
          continue;
        }
        // a little wrap, so a fire also lights walls that face slightly away from it
        let wrap = clamp((dot(n, to / max(dist, 0.0001)) + 0.2) / 1.2, 0.0, 1.0);
        var lit = 1.0;
        if (g.fire_cfg.y > 0.0) {
          for (var s = 0u; s < 4u; s = s + 1u) {
            if (g.fire_slots[s] == f32(k)) {
              lit = fire_shadow(s, l.pos.xyz, range, i.world, n);
            }
          }
        }
        light += l.color.rgb * l.color.w * light_falloff(dist, range) * wrap * lit;
      }
    }
    col = albedo.rgb * light;
  }
  // emissive.a 1: × a picture (the material's own: a brazier's coals, a lantern's panes; or its emissive map)
  var em = i.emissive.rgb;
  if (i.emissive.a > 0.5) {
    em = em * etex;
  }
  col += em * g.fog_lin.z;
  col = mix(col, i.flash.rgb, clamp(i.flash.a, 0.0, 1.0));
  // wave 7: the rim of light (an elite's modifier): strongest at the body's edges as the eye sees it
  var rim = vec3<f32>(0.0);
  if (i.rim.a > 0.0) {
    let f = 1.0 - clamp(abs(dot(n, normalize(g.eye.xyz - i.world))), 0.0, 1.0);
    rim = i.rim.rgb * i.rim.a * (0.025 + 1.25 * pow(f, 2.5));
  }
  col += rim;
  // the backdrop's fog is thickened: its trees and ruins layer into silhouettes
  let fog = select(fog_amount(i.world), fog_amount_scaled(i.world, g.shadow_uv.w), backdrop);
  col = mix(col, g.fog.rgb, fog) + rim * fog * 0.5;
  return vec4<f32>(scene_out(col, i.surf.w), 1.0);
}

// ---- the slot-ID pass ----

struct IdOut {
  @builtin(position) clip: vec4<f32>,
  @location(0) @interpolate(flat) slot: u32,
}

@vertex
fn vs_static_id(v: VIn, i: Inst) -> IdOut {
  var o: IdOut;
  o.clip = g.view_proj * model_of(i) * vec4<f32>(v.pos, 1.0);
  o.slot = i.extra.x;
  return o;
}

@vertex
fn vs_skinned_id(v: VIn, s: SkinIn, i: Inst) -> IdOut {
  var o: IdOut;
  o.clip = g.view_proj * model_of(i) * skin_matrix(i.extra.z, s.joints, s.weights) * vec4<f32>(v.pos, 1.0);
  o.slot = i.extra.x;
  return o;
}

@fragment
fn fs_id(i: IdOut) -> @location(0) u32 {
  return i.slot;
}

// ---- the moon's shadow map ----

@vertex
fn vs_static_depth(v: VIn, i: Inst) -> @builtin(position) vec4<f32> {
  return g.view_proj * model_of(i) * vec4<f32>(v.pos, 1.0);
}

@vertex
fn vs_skinned_depth(v: VIn, s: SkinIn, i: Inst) -> @builtin(position) vec4<f32> {
  return g.view_proj * model_of(i) * skin_matrix(i.extra.z, s.joints, s.weights) * vec4<f32>(v.pos, 1.0);
}

// ---- the skinned vertices' places, one float pixel each (CAPTURE_W wide), as the GPU skins them ----

const CAPTURE_W: u32 = 256u;

struct CapOut {
  @builtin(position) clip: vec4<f32>,
  @location(0) p: vec4<f32>,
}

@vertex
fn vs_capture(@builtin(vertex_index) vi: u32, v: VIn, s: SkinIn, i: Inst) -> CapOut {
  let w = model_of(i) * skin_matrix(i.extra.z, s.joints, s.weights) * vec4<f32>(v.pos, 1.0);
  let rows = max(g.screen.y, 1.0);
  let k = vi + i.extra.w;
  let x = f32(k % CAPTURE_W);
  let y = f32(k / CAPTURE_W);
  var o: CapOut;
  o.clip = vec4<f32>((x + 0.5) / f32(CAPTURE_W) * 2.0 - 1.0, 1.0 - (y + 0.5) / rows * 2.0, 0.0, 1.0);
  o.p = vec4<f32>(w.xyz, 1.0);
  return o;
}

@fragment
fn fs_capture(i: CapOut) -> @location(0) vec4<f32> {
  return i.p;
}
