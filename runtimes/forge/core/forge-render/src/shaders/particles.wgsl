// Particles (after common.wgsl): camera-facing quads, six vertices each, one instance a particle (4 vec4s: place and
// size; velocity and spin; colour × glow and alpha; atlas cell, added share, stretch, shape). Premultiplied alpha, so
// one draw holds both blended smoke and added sparks (an added particle writes alpha 0). Sparks stretch along their
// velocity. A kind without a picture in the fx atlas (cell < 0) is drawn as a shape here. Shape 5 is a beam: a
// tracer's strip between two points (the head in a.xyz, the tail b.xyz from it), drawn with the same draw.

@group(1) @binding(0) var atlas: texture_2d<f32>;
@group(1) @binding(1) var atlas_samp: sampler;

struct PIn {
  @location(0) a: vec4<f32>,   // xyz, size
  @location(1) b: vec4<f32>,   // velocity xyz, rotation
  @location(2) c: vec4<f32>,   // rgb × glow, alpha
  @location(3) d: vec4<f32>,   // atlas cell (−1: shape), added (0..1), stretch (s), shape
}

struct POut {
  @builtin(position) clip: vec4<f32>,
  @location(0) uv: vec2<f32>,
  @location(1) color: vec4<f32>,
  @location(2) @interpolate(flat) info: vec4<f32>,
  @location(3) world: vec3<f32>,
  @location(4) @interpolate(flat) expo: f32,   // the 8-bit scene's exposure (0: the HDR scene)
}

@vertex
fn vs_particle(@builtin(vertex_index) vi: u32, p: PIn) -> POut {
  var corners = array<vec2<f32>, 6>(vec2<f32>(-1.0, -1.0), vec2<f32>(1.0, -1.0), vec2<f32>(1.0, 1.0), vec2<f32>(-1.0, -1.0), vec2<f32>(1.0, 1.0), vec2<f32>(-1.0, 1.0));
  let c = corners[vi % 6u];
  let right = vec3<f32>(g.view[0].x, g.view[1].x, g.view[2].x);
  let up = vec3<f32>(g.view[0].y, g.view[1].y, g.view[2].y);
  let fwd = vec3<f32>(g.view[0].z, g.view[1].z, g.view[2].z);
  let size = p.a.w;
  var offset: vec3<f32>;
  let v = p.b.xyz;
  let lateral = v - dot(v, fwd) * fwd;
  if (u32(p.d.w + 0.5) == 5u) {
    // a beam (a tracer): a strip from its head (a.xyz) to its tail (the head + b.xyz), facing the eye, a.w half its
    // width and never under about a pixel and a half on screen (a thin streak far away would flicker)
    let end = p.a.xyz + select(vec3<f32>(0.0), v, c.y < 0.0);
    let to_eye = g.eye.xyz - end;
    var side = cross(v, to_eye);
    let sl = length(side);
    side = select(right, side / max(sl, 1e-6), sl > 1e-6);
    let fy = length(vec3<f32>(g.view_proj[0].y, g.view_proj[1].y, g.view_proj[2].y));
    let px = 2.0 * length(to_eye) / (max(fy, 1e-4) * max(g.screen.y, 1.0));
    offset = (end - p.a.xyz) + side * c.x * max(size, px * 0.75);
  } else if (p.d.z > 0.0 && length(lateral) > 1e-3) {
    // a streak: long along the velocity seen from the eye, thin across it
    let along = normalize(lateral);
    let across = normalize(cross(fwd, along));
    let len = size + length(v) * p.d.z;
    offset = along * c.y * len + across * c.x * size;
  } else {
    let cs = cos(p.b.w);
    let sn = sin(p.b.w);
    let r = vec2<f32>(c.x * cs - c.y * sn, c.x * sn + c.y * cs);
    offset = right * r.x * size + up * r.y * size;
  }
  let world = p.a.xyz + offset;
  var o: POut;
  o.clip = g.view_proj * vec4<f32>(world, 1.0);
  o.uv = c * 0.5 + 0.5;
  o.color = p.c;
  o.info = p.d;
  o.world = world;
  o.expo = ldr_exposure();
  return o;
}

fn shape(kind: f32, uv: vec2<f32>) -> f32 {
  let q = uv * 2.0 - 1.0;
  let r = length(q);
  let k = u32(kind + 0.5);
  if (k == 1u) {
    // a star: a hot core and six rays
    let a = atan2(q.y, q.x);
    let rays = pow(abs(cos(a * 3.0)), 24.0) * (1.0 - smoothstep(0.0, 1.0, r));
    return clamp(pow(max(1.0 - r * 1.6, 0.0), 1.5) + rays * 0.9, 0.0, 1.0);
  }
  if (k == 2u) {
    return pow(max(1.0 - r, 0.0), 1.2);
  }
  if (k == 3u) {
    return smoothstep(0.55, 0.75, r) * (1.0 - smoothstep(0.8, 1.0, r));
  }
  if (k == 4u) {
    // a chip: a hard-edged lump
    let e = max(abs(q.x * 0.9 + q.y * 0.3), abs(q.y * 1.1 - q.x * 0.2));
    return 1.0 - smoothstep(0.55, 0.7, e);
  }
  if (k == 5u) {
    // a beam: a hot line down its middle, brightest at the head (uv.y 1), thinning to its tail
    return pow(max(1.0 - abs(q.x), 0.0), 1.5) * mix(0.3, 1.0, uv.y) * smoothstep(0.0, 0.08, uv.y);
  }
  return pow(max(1.0 - r, 0.0), 1.6);
}

@fragment
fn fs_particle(i: POut) -> @location(0) vec4<f32> {
  var tex = vec3<f32>(1.0);
  var a: f32;
  let cell = i.info.x;
  if (cell >= 0.0) {
    let cx = floor(cell % 4.0);
    let cy = floor(cell / 4.0);
    let inset = clamp(i.uv, vec2<f32>(0.01), vec2<f32>(0.99));
    let t = textureSampleLevel(atlas, atlas_samp, (vec2<f32>(cx, cy) + vec2<f32>(inset.x, 1.0 - inset.y)) * 0.25, 0.0);
    tex = t.rgb;
    a = t.a;
  } else {
    a = shape(i.info.w, i.uv);
  }
  let added = clamp(i.info.y, 0.0, 1.0);
  let f = fog_amount(i.world);
  let alpha = a * i.color.a * (1.0 - f * added);
  var rgb = i.color.rgb * tex;
  rgb = mix(rgb, g.fog.rgb, f * (1.0 - added));
  return vec4<f32>(scene_out(rgb, i.expo) * alpha, alpha * (1.0 - added));
}
