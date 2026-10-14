// The look stack after the HDR scene, full-screen triangles:
//   fs_extract    bloom's bright part, at a quarter of the scene's size (16 texels averaged, a soft threshold)
//   fs_blur       a 9-tap Gaussian along `dir` (run twice: across, then down)
//   fs_composite  scene + bloom, exposure, the tone curve, saturation, vignette, sRGB, gamma, contrast, grain, the
//                 colour steps with an ordered dither (the retro pass), into the canvas (or the AA input)
//   fs_fxaa       edge anti-aliasing on the final 8-bit image
//   fs_meter      the eye's adaptation (look.tone.auto): the scene's mean display brightness at 96 points through the
//                 tone curve, and from it the factor on the exposure that brings that mean to look.tone.key, kept in
//                 one float texel from frame to frame (r the factor, g the mean it saw, a 1 once written)
// Every value is a look slot (look.bloom.*, look.tone.*, look.retro.*).

struct Post {
  bloom: vec4<f32>,  // threshold, knee, intensity, radius
  tone: vec4<f32>,   // exposure, curve (0 clamp, 1 ACES, 2 Reinhard), contrast, saturation
  retro: vec4<f32>,  // grain, dither, colour steps, time
  texel: vec4<f32>,  // the source's texel (x, y), the blur direction (z, w)
  out: vec4<f32>,    // x encode sRGB by hand (1) or the canvas does (0), y gamma, z vignette, w pixelated upscale
  adapt: vec4<f32>,   // the eye's adaptation: x how far (0 off), y the key (a mean display luma 0..1), z the least factor, w the most
  meter: vec4<f32>,  // x how much of the way the meter goes this frame toward a lower exposure, y a jitter seed, z toward a higher one, w 1: the 8-bit scene
}

@group(0) @binding(0) var<uniform> P: Post;
@group(0) @binding(1) var src: texture_2d<f32>;
@group(0) @binding(2) var bloom_tex: texture_2d<f32>;
@group(0) @binding(3) var samp: sampler;
@group(0) @binding(4) var samp_point: sampler;
@group(0) @binding(5) var meter_tex: texture_2d<f32>;

struct O {
  @builtin(position) p: vec4<f32>,
  @location(0) uv: vec2<f32>,
}

@vertex
fn vs_full(@builtin(vertex_index) i: u32) -> O {
  let x = f32((i << 1u) & 2u);
  let y = f32(i & 2u);
  var o: O;
  o.p = vec4<f32>(x * 2.0 - 1.0, 1.0 - y * 2.0, 0.0, 1.0);
  o.uv = vec2<f32>(x, y);
  return o;
}

@fragment
fn fs_extract(i: O) -> @location(0) vec4<f32> {
  let t = P.texel.xy;
  var c = textureSampleLevel(src, samp, i.uv + vec2<f32>(-t.x, -t.y), 0.0).rgb;
  c += textureSampleLevel(src, samp, i.uv + vec2<f32>(t.x, -t.y), 0.0).rgb;
  c += textureSampleLevel(src, samp, i.uv + vec2<f32>(-t.x, t.y), 0.0).rgb;
  c += textureSampleLevel(src, samp, i.uv + vec2<f32>(t.x, t.y), 0.0).rgb;
  c = min(c * 0.25, vec3<f32>(64.0));
  let br = max(c.r, max(c.g, c.b));
  let knee = max(P.bloom.y, 1e-4);
  var soft = clamp(br - P.bloom.x + knee, 0.0, 2.0 * knee);
  soft = soft * soft / (4.0 * knee);
  let w = max(soft, br - P.bloom.x) / max(br, 1e-4);
  return vec4<f32>(c * w, 1.0);
}

@fragment
fn fs_blur(i: O) -> @location(0) vec4<f32> {
  let d = P.texel.zw * P.texel.xy * P.bloom.w;
  var c = textureSampleLevel(src, samp, i.uv, 0.0).rgb * 0.2270270;
  c += (textureSampleLevel(src, samp, i.uv + d * 1.3846154, 0.0).rgb + textureSampleLevel(src, samp, i.uv - d * 1.3846154, 0.0).rgb) * 0.3162162;
  c += (textureSampleLevel(src, samp, i.uv + d * 3.2307692, 0.0).rgb + textureSampleLevel(src, samp, i.uv - d * 3.2307692, 0.0).rgb) * 0.0702703;
  return vec4<f32>(c, 1.0);
}

fn aces(x: vec3<f32>) -> vec3<f32> {
  return clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), vec3<f32>(0.0), vec3<f32>(1.0));
}

fn encode(c: vec3<f32>) -> vec3<f32> {
  let x = clamp(c, vec3<f32>(0.0), vec3<f32>(1.0));
  return select(1.055 * pow(x, vec3<f32>(1.0 / 2.4)) - 0.055, x * 12.92, x <= vec3<f32>(0.0031308));
}

fn decode(c: vec3<f32>) -> vec3<f32> {
  let x = clamp(c, vec3<f32>(0.0), vec3<f32>(1.0));
  return select(pow((x + 0.055) / 1.055, vec3<f32>(2.4)), x / 12.92, x <= vec3<f32>(0.04045));
}

fn hash2(p: vec2<f32>) -> f32 {
  var q = fract(p * vec2<f32>(123.34, 456.21));
  q += dot(q, q + 45.32);
  return fract(q.x * q.y);
}

fn bayer4(p: vec2<f32>) -> f32 {
  let x = u32(p.x) % 4u;
  let y = u32(p.y) % 4u;
  var m = array<f32, 16>(0.0, 8.0, 2.0, 10.0, 12.0, 4.0, 14.0, 6.0, 3.0, 11.0, 1.0, 9.0, 15.0, 7.0, 13.0, 5.0);
  return (m[y * 4u + x] + 0.5) / 16.0;
}

/// The tone curve on an exposed colour (look.tone.curve).
fn curve_of(x: vec3<f32>) -> vec3<f32> {
  let curve = u32(P.tone.y + 0.5);
  if (curve == 1u) {
    return aces(x);
  }
  if (curve == 2u) {
    return x / (1.0 + x);
  }
  return clamp(x, vec3<f32>(0.0), vec3<f32>(1.0));
}

/// Display space from a toned colour: sRGB, gamma, contrast.
fn display_of(c: vec3<f32>) -> vec3<f32> {
  var e = encode(c);
  e = pow(e, vec3<f32>(1.0 / max(P.out.y, 0.01)));
  return (e - 0.5) * P.tone.z + 0.5;
}

/// The eye's factor on the exposure: the meter texel's, as far as look.tone.auto says (1 until it is written).
fn adapted() -> f32 {
  let m = textureSampleLevel(meter_tex, samp_point, vec2<f32>(0.5), 0.0);
  return mix(1.0, select(1.0, m.r, m.a > 0.5), clamp(P.adapt.x, 0.0, 1.0));
}

@fragment
fn fs_meter(i: O) -> @location(0) vec4<f32> {
  let prev = textureSampleLevel(meter_tex, samp_point, vec2<f32>(0.5), 0.0);
  let had = prev.a > 0.5;
  // the 8-bit scene (common.wgsl; P.meter.w 1): the texel is 8 bits a channel, so the factor is kept as half of
  // itself in two bytes (r the high one, g the low), and the scene it reads is already exposed and toned
  let ldr = P.meter.w > 0.5;
  let k = select(1.0, select(prev.r, (prev.r * 65280.0 + prev.g * 255.0) / 65535.0 * 2.0, ldr), had);
  // the picture's mean display luma at the exposure it is drawn with now: 12 × 8 points, moved a little every frame
  var sum = 0.0;
  for (var y = 0u; y < 8u; y = y + 1u) {
    for (var x = 0u; x < 12u; x = x + 1u) {
      let cell = vec2<f32>(f32(x), f32(y));
      let j = vec2<f32>(hash2(cell + P.meter.y), hash2(cell.yx * 1.7 + P.meter.y + 3.1));
      let c = max(textureSampleLevel(src, samp, (cell + j) / vec2<f32>(12.0, 8.0), 0.0).rgb, vec3<f32>(0.0));
      var toned = c;
      if (!ldr) {
        toned = curve_of(c * P.tone.x * k);
      }
      let e = clamp(display_of(toned), vec3<f32>(0.0), vec3<f32>(1.0));
      sum += dot(e, vec3<f32>(0.2126, 0.7152, 0.0722));
    }
  }
  let mean = sum / 96.0;
  // display luma goes roughly as exposure to the 1 / 2.2: the factor that would bring the mean to the key, taken part
  // of the way (all of it on the first frame, then two more steps of the same to settle)
  let want = clamp(k * pow(P.adapt.y / max(mean, 0.002), 1.6), P.adapt.z, P.adapt.w);
  let rate = select(1.0, clamp(select(P.meter.z, P.meter.x, want < k), 0.0, 1.0), had);
  let next = mix(k, want, rate);
  if (ldr) {
    let v = floor(clamp(next * 0.5, 0.0, 1.0) * 65535.0 + 0.5);
    let hi = floor(v / 256.0);
    return vec4<f32>(hi / 255.0, (v - hi * 256.0) / 255.0, mean, 1.0);
  }
  return vec4<f32>(next, mean, 0.0, 1.0);
}

@fragment
fn fs_composite(i: O) -> @location(0) vec4<f32> {
  // One sampler a picture (WebGL2's samplers are a picture and its sampler together: the GLSL the WebGL2 build is
  // translated to cannot read `src` through two). The pixelated upscale reads the texel under the pixel at its centre,
  // where the filtering sampler gives that texel alone.
  var suv = i.uv;
  if (P.out.w > 0.5) {
    let size = vec2<f32>(textureDimensions(src, 0));
    suv = (floor(i.uv * size) + 0.5) / size;
  }
  var c = textureSampleLevel(src, samp, suv, 0.0).rgb;
  c += textureSampleLevel(bloom_tex, samp, i.uv, 0.0).rgb * P.bloom.z;
  c = curve_of(c * P.tone.x * adapted());
  let luma = dot(c, vec3<f32>(0.2126, 0.7152, 0.0722));
  c = max(mix(vec3<f32>(luma), c, P.tone.w), vec3<f32>(0.0));
  let v = length(i.uv - 0.5) * 1.41421;
  c *= 1.0 - P.out.z * smoothstep(0.45, 1.05, v) * 0.6;
  // display space from here: gamma, contrast, grain, the colour steps and their dither
  var e = display_of(c);
  let px = i.p.xy;
  if (P.retro.x > 0.0) {
    let n = hash2(px + vec2<f32>(fract(P.retro.w * 7.13) * 911.0, fract(P.retro.w * 3.71) * 577.0)) - 0.5;
    e += n * P.retro.x * (0.35 + 0.65 * (1.0 - luma));
  }
  let steps = P.retro.z;
  let b = bayer4(px) - 0.5;
  if (steps >= 2.0) {
    let lv = steps - 1.0;
    e = floor(e * lv + 0.5 + b * P.retro.y) / lv;
  } else {
    e += b * P.retro.y / 255.0;
  }
  e = clamp(e, vec3<f32>(0.0), vec3<f32>(1.0));
  if (P.out.x < 0.5) {
    e = decode(e);
  }
  return vec4<f32>(e, 1.0);
}

fn lum(c: vec3<f32>) -> f32 {
  return dot(c, vec3<f32>(0.299, 0.587, 0.114));
}

@fragment
fn fs_fxaa(i: O) -> @location(0) vec4<f32> {
  let t = P.texel.xy;
  let nw = textureSampleLevel(src, samp, i.uv + vec2<f32>(-t.x, -t.y), 0.0).rgb;
  let ne = textureSampleLevel(src, samp, i.uv + vec2<f32>(t.x, -t.y), 0.0).rgb;
  let sw = textureSampleLevel(src, samp, i.uv + vec2<f32>(-t.x, t.y), 0.0).rgb;
  let se = textureSampleLevel(src, samp, i.uv + vec2<f32>(t.x, t.y), 0.0).rgb;
  let m = textureSampleLevel(src, samp, i.uv, 0.0).rgb;
  let lnw = lum(nw);
  let lne = lum(ne);
  let lsw = lum(sw);
  let lse = lum(se);
  let lm = lum(m);
  let lmin = min(lm, min(min(lnw, lne), min(lsw, lse)));
  let lmax = max(lm, max(max(lnw, lne), max(lsw, lse)));
  var dir = vec2<f32>(-((lnw + lne) - (lsw + lse)), (lnw + lsw) - (lne + lse));
  let reduce = max((lnw + lne + lsw + lse) * 0.25 * (1.0 / 8.0), 1.0 / 128.0);
  let rcp = 1.0 / (min(abs(dir.x), abs(dir.y)) + reduce);
  dir = clamp(dir * rcp, vec2<f32>(-8.0), vec2<f32>(8.0)) * t;
  let a = 0.5 * (textureSampleLevel(src, samp, i.uv + dir * (1.0 / 3.0 - 0.5), 0.0).rgb + textureSampleLevel(src, samp, i.uv + dir * (2.0 / 3.0 - 0.5), 0.0).rgb);
  let b = a * 0.5 + 0.25 * (textureSampleLevel(src, samp, i.uv - dir * 0.5, 0.0).rgb + textureSampleLevel(src, samp, i.uv + dir * 0.5, 0.0).rgb);
  let lb = lum(b);
  var c = select(b, a, lb < lmin || lb > lmax);
  if (P.out.x < 0.5) {
    c = decode(c);
  }
  return vec4<f32>(c, 1.0);
}
