// The sky (after common.wgsl): drawn after the opaque scene at the far plane (depth 1, LessEqual), so it fills only
// what nothing covers. A horizon-to-zenith gradient (the horizon is the fog's colour, so far things and the sky meet),
// faint stars, and the moon: a disc where the moon light comes from, bright enough to bloom, with a soft glow.

struct SkyOut {
  @builtin(position) clip: vec4<f32>,
  @location(0) ndc: vec2<f32>,
  @location(1) @interpolate(flat) expo: f32,   // the 8-bit scene's exposure (0: the HDR scene)
}

@vertex
fn vs_sky(@builtin(vertex_index) i: u32) -> SkyOut {
  let x = f32((i << 1u) & 2u) * 2.0 - 1.0;
  let y = f32(i & 2u) * 2.0 - 1.0;
  var o: SkyOut;
  o.clip = vec4<f32>(x, y, 1.0, 1.0);
  o.ndc = vec2<f32>(x, y);
  o.expo = ldr_exposure();
  return o;
}

fn hash3(p: vec3<f32>) -> f32 {
  let q = fract(p * vec3<f32>(0.1031, 0.1030, 0.0973));
  let r = q + dot(q, q.yxz + 33.33);
  return fract((r.x + r.y) * r.z);
}

@fragment
fn fs_sky(i: SkyOut) -> @location(0) vec4<f32> {
  let p = g.inv_view_proj * vec4<f32>(i.ndc, 1.0, 1.0);
  let dir = normalize(p.xyz / p.w - g.eye.xyz);
  let up = clamp(dir.y, 0.0, 1.0);
  // the horizon's colour fades to the zenith's: at once (haze 0), or from a band of haze that reaches higher (haze 1:
  // nothing but the horizon's colour below about 12 degrees, the zenith's from about 50)
  let band = smoothstep(0.2 * g.sky_horizon.w, 0.2 * g.sky_horizon.w + 1.0 - 0.45 * g.sky_horizon.w, up);
  var col = mix(g.sky_horizon.rgb, g.sky_zenith.rgb, mix(pow(up, 0.45), band, clamp(g.sky_horizon.w * 4.0, 0.0, 1.0)));
  // stars: sparse points, fading toward the horizon
  if (g.sky_zenith.w > 0.0) {
    let cell = floor(dir * 420.0);
    let h = hash3(cell);
    col += vec3<f32>(0.75, 0.8, 1.0) * step(0.9975, h) * (h - 0.9975) * 400.0 * g.sky_zenith.w * 0.02 * smoothstep(0.05, 0.4, up);
  }
  // the moon
  let size = g.moon2.x;
  if (size > 0.0) {
    let md = normalize(g.sun_dir.xyz);
    let ang = acos(clamp(dot(dir, md), -1.0, 1.0));
    let disc = 1.0 - smoothstep(size * 0.93, size, ang);
    let limb = 1.0 - 0.22 * pow(clamp(ang / size, 0.0, 1.0), 2.0);
    // a few soft maria, fixed to the disc
    let side = normalize(cross(md, vec3<f32>(0.0, 1.0, 0.0001)));
    let upv = cross(side, md);
    let uv = vec2<f32>(dot(dir - md, side), dot(dir - md, upv)) / max(size, 1e-4);
    let maria = 0.12 * (smoothstep(0.55, 0.0, length(uv - vec2<f32>(-0.25, 0.2))) + smoothstep(0.4, 0.0, length(uv - vec2<f32>(0.3, -0.15))));
    col = mix(col, g.moon.rgb * g.moon.w * limb * (1.0 - maria), disc);
    col += g.moon.rgb * g.moon2.y * 0.12 * exp(-max(ang - size, 0.0) / (size * 1.2)) * (1.0 - disc);
  }
  return vec4<f32>(scene_out(col, i.expo), 1.0);
}
