// gf-forge's renderer from JS (track R; research/gf-forge/core/ARCHITECTURE.md "Rendering"), vendored into a game as
// gf/forge/render.js (never edited there). It works over a host (gf/forge/host.js createHost):
//
//   const r = createRender(host);
//   const { body, model } = await r.body(bytes, slotIndex);          // a skinned GLB: animated by the core, GPU-skinned
//   host.animate(net, body, clips) …                                  // the core's entities draw by themselves
//   const p = r.puppet(body, clips, { at, rot });  r.pose(p, 'walk')   // a body the renderer poses (lookdev, previews)
//   r.attach(p, (await host.model(axe)).id, slot, 'hand_r', grip)     // a held item on a socket (catalog grips)
//   r.glow(p, eyes.color, eyes.tell, 0.3); r.flash(net)               // the eyes' tell, a hit's white flash
//   r.fp.arms(arms.id, slot); r.fp.weapon(0, gun.id, slot, hold, true); r.fp.sockets()   // the first-person layer
//   r.burst('sparks', { at, dir }); r.light({ at, color, radius, intensity, frames })   // effects from JS
//   await r.fxPictures({ smoke: bytes, … })                           // the fx.* pictures (else shapes are drawn)
//   r.surface(ground.id, { texture, tile: 4, space: 'world' })        // a tiling picture on a model (wave 2, below)
//   r.backdrop(instance)                                              // an instance beyond the walls: cheap, fogged
//   r.tracer({ from, to, color })                                     // a streak (the core's shots draw their own)
//
// Surfaces (wave 2; what the world gives each ground, wall or prop model so the retro texel look can be drawn on it):
//   r.surface(model, {
//     texture,            a texture id (host.texture(bytes)) drawn in place of the model's own picture; omit: its own
//     tile,               metres one repeat of the picture covers (0 or omitted: unknown, the mesh's UVs are measured)
//     space: 'world',     the picture is laid in world space every `tile` metres (x/z on what faces up or down, the
//                         height on walls), so floor and wall texels line up whatever the meshes' UVs are;
//            'uv'         (the default) the mesh's own UVs, one unit of them `tile` metres wide
//     emissive,           a texture id: its glow (× emissiveColor, linear or hex, × emissiveStrength), drawn unlit
//     density,            texels a metre for the retro look on this model alone (0 or omitted: the look's
//                         retro.density for a tiling surface, retro.models for anything else)
//   })
// With look.retro.texels on, a surface shows square texels at that density whatever the picture's resolution (a finer
// picture is averaged into them, a coarser one shows its own); off, the picture is filtered smooth.
//
// In Rust the same things come from events (R_FLASH, R_GLOW, R_VIEWMODEL, R_TINT, R_CLOTH: kinds 56..60), and the core's
// own LIGHT, PARTICLES, HIT and KILL events light, burst, flash and put eyes out by themselves.
import { plainGlb } from './meshopt.js';
import { decodeImage, transform, linear } from './host.js';

export const PUPPET_BASE = 1000000;
/** Track R's event kinds (forge-core events: R owns 56..63). */
export const R_EVENT = { FLASH: 56, GLOW: 57, VIEWMODEL: 58, TINT: 59, CLOTH: 60 };
export const STATS = ['draws', 'passes', 'instances', 'actors', 'particles', 'lights', 'flashes', 'shadow', 'bloom', 'width', 'height', 'palette', 'unknownParticles', 'undrawn',
  'rigid', 'movingLights', 'fpShown', 'fpMuzzle', 'fpSwing', 'flashing', 'muzzleFlashes', 'hitFlashes', 'swings'];
/** Wave 2's stats after those (forge-web `render_stats_more`): streaks drawn, items left out of the main pass (off screen
 *  or past their layer's distance), instances in the moon's shadow pass, fire shadow faces drawn, fires casting, loose
 *  pieces given to the renderer, backdrop instances, and tracers begun since the page loaded. */
export const STATS_MORE = ['tracersDrawn', 'culled', 'casters', 'fireFaces', 'fireCasters', 'pieces', 'backdrop', 'tracers'];
/** The particle kinds (forge-render particles.rs KINDS) and the library's pictures for them (research/gf-forge/library/fx). */
export const FX_FILES = { smoke: 'fx/smoke.png', sparks: 'fx/spark.png', embers: 'fx/ember.png', dust: 'fx/dust.png', bone: 'fx/bone-chip.png', blood: 'fx/blood-mist.png', muzzle: 'fx/muzzle-flash.png', impact: 'fx/impact-ring.png', orb: 'fx/orb.png' };

/** Entity-model classes beside the entity kinds (forge-render actors.rs `CLASS_ORB`). */
export const ENTITY_CLASS = { ORB: 100 };
const IDENTITY = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);

/**
 * A 4x4 that fits a model's box ([x0, y0, z0, x1, y1, z1]) to a size: its centre (or its base, `feet`) at the origin,
 * its longest side `size` metres (or its height `height`), that side along Z with `alongZ` (a long bone), turned `turn`
 * radians about Y after.
 */
export function fitTo(bounds, { size = 0, height = 0, alongZ = false, feet = false, turn = 0 } = {}) {
  const [x0, y0, z0, x1, y1, z1] = bounds, ext = [x1 - x0, y1 - y0, z1 - z0], c = [(x0 + x1) / 2, feet ? y0 : (y0 + y1) / 2, (z0 + z1) / 2];
  const longest = Math.max(...ext, 1e-4), k = height ? height / Math.max(1e-4, ext[1]) : size ? size / longest : 1;
  const axis = ext.indexOf(longest);
  // the longest side onto Z: X → Z (a quarter turn about Y), or Y → Z (about X)
  let r = [1, 0, 0, 0, 1, 0, 0, 0, 1];
  if (alongZ && axis === 0) r = [0, 0, -1, 0, 1, 0, 1, 0, 0];
  if (alongZ && axis === 1) r = [1, 0, 0, 0, 0, 1, 0, -1, 0];
  const cs = Math.cos(turn), sn = Math.sin(turn), y = [cs, 0, -sn, 0, 1, 0, sn, 0, cs];
  const m3 = (a, b) => { const o = new Array(9); for (let col = 0; col < 3; col++) for (let row = 0; row < 3; row++) o[col * 3 + row] = a[row] * b[col * 3] + a[3 + row] * b[col * 3 + 1] + a[6 + row] * b[col * 3 + 2]; return o; };
  const R = m3(y, r).map(v => v * k);
  const t = [-(R[0] * c[0] + R[3] * c[1] + R[6] * c[2]), -(R[1] * c[0] + R[4] * c[1] + R[7] * c[2]), -(R[2] * c[0] + R[5] * c[1] + R[8] * c[2])];
  return new Float32Array([R[0], R[1], R[2], 0, R[3], R[4], R[5], 0, R[6], R[7], R[8], 0, t[0], t[1], t[2], 1]);
}

const toBuffer = buf => (buf instanceof ArrayBuffer ? buf : buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
const rgb = c => (Array.isArray(c) ? c.map(Number) : linear(c ?? '#ffffff'));
async function digest(bytes) {
  const d = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(d)].map(b => b.toString(16).padStart(2, '0')).join('');
}

/** A column-major 4x4 from {position: [x, y, z], quaternion: [x, y, z, w], scale} (the catalog's grips). */
export function trs({ position = [0, 0, 0], quaternion = [0, 0, 0, 1], scale = 1 } = {}) {
  const [x, y, z, w] = quaternion, s = Array.isArray(scale) ? scale : [scale, scale, scale];
  const xx = x * x, yy = y * y, zz = z * z, xy = x * y, xz = x * z, yz = y * z, wx = w * x, wy = w * y, wz = w * z;
  return new Float32Array([
    (1 - 2 * (yy + zz)) * s[0], 2 * (xy + wz) * s[0], 2 * (xz - wy) * s[0], 0,
    2 * (xy - wz) * s[1], (1 - 2 * (xx + zz)) * s[1], 2 * (yz + wx) * s[1], 0,
    2 * (xz + wy) * s[2], 2 * (yz - wx) * s[2], (1 - 2 * (xx + yy)) * s[2], 0,
    position[0], position[1], position[2], 1,
  ]);
}

export function createRender(host) {
  const forge = host.forge;
  const pics = new Map();     // picture digest → texture id (a body's pictures decoded once)
  const place = p => (p instanceof Float32Array ? p : transform(p ?? {}));
  async function pictures(model) {
    for (let i = 0; i < forge.model_image_count(model); i++) {
      const bytes = forge.model_image_bytes(model, i);
      if (!bytes.length) continue;
      const key = await digest(bytes);
      if (pics.has(key)) { forge.link_model_image(model, i, pics.get(key)); continue; }
      const img = await decodeImage(bytes, forge.model_image_mime(model, i));
      forge.set_model_image(model, i, img.w, img.h, img.rgba);
      pics.set(key, forge.model_image_texture(model, i));
    }
  }
  const r = {
    /** A skinned GLB's bytes (a body slot's file) and its slot index → {body, model}: animated by the core's library
     *  (host.animate(net, body, clips) draws it on that entity) and drawn GPU-skinned. */
    async body(buf, slot) {
      const plain = new Uint8Array(await plainGlb(toBuffer(buf)));
      const [body, model] = forge.add_body(plain, slot >>> 0);
      await pictures(model);
      return { body, model };
    },
    /** Draw a body already in the library (host.animBody) with this GLB: → the model id. */
    async bindBody(body, buf, slot) {
      const plain = new Uint8Array(await plainGlb(toBuffer(buf)));
      const model = forge.bind_body_model(body, plain, slot >>> 0);
      await pictures(model);
      return model;
    },
    /** A body the renderer poses: {at, rot (degrees about Y), scale} or a 4x4. → its actor id. */
    puppet: (body, clips, at) => forge.puppet(body, clips, place(at)),
    /** Play a clip on a puppet from {t} seconds; rate 0 holds that frame. */
    pose: (id, clip, { t = 0, rate = 1, loop = null, fade = 0 } = {}) => forge.puppet_play(id, clip, t, rate, loop === null ? -1 : loop ? 1 : 0, fade),
    rest: id => forge.puppet_rest(id),
    /** A clip's {duration, impact} (seconds), or null. */
    clipTimes: (clips, name) => { const v = forge.clip_times(clips, name); return v.length ? { duration: v[0], impact: v[1] } : null; },
    /** A catalog pose's time: a number of seconds, "end" or "impact". */
    poseTime(clips, name, at) { const c = r.clipTimes(clips, name); if (!c) return 0; return at === 'end' ? Math.max(0, c.duration - 1e-3) : at === 'impact' ? (c.impact || c.duration * 0.5) : Number(at) || 0; },
    move: (id, at) => forge.puppet_move(id, place(at)),
    show: (id, on) => forge.puppet_visible(id, !!on),
    remove: id => forge.puppet_remove(id),
    /** A rigid model on an actor's socket (hand_r, hand_l, head, back, or a bone): grip {position, quaternion, scale}. */
    attach: (owner, model, slot, socket, grip = {}) => forge.attach(owner, model, slot >>> 0, socket, grip instanceof Float32Array ? grip : trs(grip)),
    detach: owner => forge.detach_all(owner),
    /** A body's white flash (a HIT does this by itself): colour, how far, seconds. */
    flash: (id, color = '#ffffff', amount = 1, seconds = 0.05) => { const c = rgb(color); forge.actor_flash(id, c[0], c[1], c[2], amount, seconds); },
    /** Its `glow_eyes`: colour × intensity reached over `ramp` seconds (intensity < 0: the material's own). */
    glow: (id, color, intensity, ramp = 0) => { const c = rgb(color); forge.actor_glow(id, c[0], c[1], c[2], intensity, ramp); },
    tint: (id, color = null, a = 1) => { if (color == null) forge.actor_tint(id, 1, 1, 1, -1); else { const c = rgb(color); forge.actor_tint(id, c[0], c[1], c[2], a); } },
    cloth: (id, color = null) => { if (color == null) forge.actor_cloth(id, -1, 0, 0); else { const c = rgb(color); forge.actor_cloth(id, c[0], c[1], c[2]); } },
    actors: () => [...forge.actor_ids()],
    /** How an actor was drawn last frame: {flash: [r, g, b, amount], glow: [r, g, b] | null, tint}, or null. */
    look(id) { const v = forge.actor_look(id); return v.length ? { flash: [v[0], v[1], v[2], v[3]], glow: v[4] < 0 ? null : [v[4], v[5], v[6]], tint: [v[7], v[8], v[9], v[10]] } : null; },
    bones: id => forge.actor_bones(id),
    /** A named node of a model (socket_flame, socket_muzzle…) as a 4x4, or null. */
    node: (model, name) => { const m = forge.model_node(model, name); return m.length ? m : null; },

    fp: {
      arms: (model, slot) => forge.fp_arms(model, slot >>> 0),
      /** Register the weapon of table row `index` (its hold: the catalog's hold.arm_r, camera space). */
      weapon: (index, model, slot, hold = [0.13, -0.17, -0.34], twoHanded = false) => forge.fp_weapon(index, model, slot >>> 0, hold[0], hold[1], hold[2], !!twoHanded),
      use: index => forge.fp_use(index ?? 0xffffffff),
      /** The rig's camera-space offset: {at, rot: [pitch, yaw, roll] degrees} or a 4x4. */
      pose: p => forge.fp_pose(p instanceof Float32Array ? p : transform({ at: p?.at ?? [0, 0, 0], rot: p?.rot ?? [0, 0, 0] })),
      visible: on => forge.fp_visible(!!on),
      /** The layer follows the core's feel view by itself (the weapon in hand, kick, sway, bob, reload, swing); false:
       *  the page poses it (`pose`, `use`, `visible`: the lookdev). */
      auto: on => forge.fp_auto(!!on),
      /** The weapon a quick melee swings when the tables have no melee weapon. */
      blade: (model, slot) => forge.fp_blade(model, slot >>> 0),
      fov: deg => forge.fp_fov(deg ?? 0),
      sleeve: color => { if (color == null) forge.fp_sleeve(-1, 0, 0); else { const c = rgb(color); forge.fp_sleeve(c[0], c[1], c[2]); } },
      /** {muzzle, tip, grip}: each {cam: [x, y, z], world: [x, y, z]} (world: where it shows on screen), or null. */
      sockets() {
        const s = forge.fp_sockets(), f = s[0] | 0;
        return { muzzle: f & 1 ? { cam: [s[1], s[2], s[3]], world: [s[4], s[5], s[6]] } : null, tip: f & 2 ? { cam: [s[7], s[8], s[9]], world: [s[10], s[11], s[12]] } : null, grip: f & 4 ? { cam: [s[13], s[14], s[15]] } : null };
      },
    },

    /** The renderer draws every animated entity's body skinned itself (forge-web `draws_bodies`). */
    drawsBodies: () => typeof forge.draws_bodies === 'function' && !!forge.draws_bodies(),
    /**
     * Draw every rigid core entity of a class as a model (the wave 1b integration: a kill's debris pieces, coins, weapon
     * pickups, a caster's orb). `cls`: an entity kind (host.js KIND; 16 a coin), or ENTITY_CLASS.ORB; `type`: its type
     * (a debris piece type, a weapons row), or null for every type. {fit: a 4x4 applied first (fitTo), spin (rad/s), bob (m)}.
     */
    entityModel: (cls, type, model, slot, { fit = null, spin = 0, bob = 0 } = {}) => forge.entity_model(cls, type == null ? 0xffff : type, model, slot >>> 0, fit ?? IDENTITY, spin, bob),

    /**
     * How a model's picture lies on it (the file's header says what each field means): {texture, tile, space, emissive,
     * emissiveColor, emissiveStrength, density}. null takes the surface off again. → false when the core has no such model.
     */
    surface(model, sf = {}) {
      if (typeof forge.model_surface !== 'function') return false;
      if (sf === null) return forge.model_surface(model, -1, false, 0, -1, 0, 0, 0);
      if (sf.texture != null) forge.set_model_texture(model, sf.texture);
      const c = rgb(sf.emissiveColor ?? '#ffffff'), k = Number.isFinite(Number(sf.emissiveStrength)) ? Number(sf.emissiveStrength) : 1;
      return forge.model_surface(model, Math.max(0, Number(sf.tile) || 0), sf.space === 'world', Math.max(0, Number(sf.density) || 0), sf.emissive ?? -1, c[0] * k, c[1] * k, c[2] * k);
    },
    /** Put a static instance (host.instance's id) in the backdrop layer, or take it out: no shadow, the moon and the
     *  ambient light only, the look's backdrop.fog and backdrop.distance. For what stands beyond the walls. */
    backdrop: (instance, on = true) => (typeof forge.instance_backdrop === 'function' ? forge.instance_backdrop(instance, !!on) : false),
    /** A streak of light: {from, to, color (hex or linear), width (m), seconds (at least), beam (the whole line, fading)}.
     *  The core's own shots draw theirs (forge-feel's tracer event, and a streak behind every round in flight). */
    tracer: ({ from, to, color = '#ff9a3c', width = 0.02, seconds = 0.05, beam = false } = {}) => forge.fx_tracer?.(new Float32Array(from), new Float32Array(to), new Float32Array(rgb(color)), width, seconds, !!beam),
    /** QA: lay `count` loose debris pieces at rest round `at` ([x, z]) within `radius` metres, as kills leave them (0:
     *  take them away). They are drawn as the debris models `entityModel` registered. → how many lie there. */
    pieces: (count, { at = [0, 0], radius = 8 } = {}) => forge.debug_pieces?.(count, at[0], at[1], radius) ?? 0,

    /** A particle burst by kind (smoke, sparks, embers, dust, bone, blood, muzzle, impact, orb, ash); 0s take the kind's own. */
    burst: (name, { count = 0, at = [0, 0, 0], dir = [0, 0, 0], speed = 0, spread = 0 } = {}) => forge.fx_burst(name, count, new Float32Array(at), new Float32Array(dir), speed, spread),
    /** A short light: {at, color (hex or linear), radius (m), intensity, frames (at 60 a second)}. */
    light: ({ at, color = '#ff7a21', radius = 3.4, intensity = 1.5, frames = 3 } = {}) => forge.fx_flash(new Float32Array(at), new Float32Array(rgb(color)), radius, intensity, frames),
    /** A kind's picture (an fx.* image slot's bytes). */
    async fxPicture(kind, buf, mime = 'image/png') {
      const img = await decodeImage(new Uint8Array(toBuffer(buf)), mime, 256);
      return forge.fx_texture(kind, img.w, img.h, img.rgba);
    },
    /** Every kind's picture: {kind: bytes}. */
    async fxPictures(map) { for (const [k, v] of Object.entries(map ?? {})) if (v) await r.fxPicture(k, v); },
    clear: () => forge.fx_clear(),

    /** The last frame: {draws, passes, instances, actors, particles, lights, flashes, shadow, bloom, width, height, …},
     *  and (wave 3, track W) which build drew it and what that build's device could not do: `backend` ('webgpu' |
     *  'webgl2'), `hdr` (false: the 8-bit scene, a device without float render targets), `tier` (look.js backendTier). */
    stats() {
      const v = forge.render_stats(), more = typeof forge.render_stats_more === 'function' ? forge.render_stats_more() : [];
      return { ...Object.fromEntries(STATS.map((k, i) => [k, ['bloom', 'fpShown', 'fpMuzzle', 'fpSwing'].includes(k) ? v[i] > 0.5 : v[i]])), ...Object.fromEntries(STATS_MORE.map((k, i) => [k, more[i] ?? 0])), ...r.caps() };
    },
    /** What draws: {backend, hdr, floatCapture, maxTexture, tier}: the build, and what the device's renderer does without
     *  (forge-web `render_caps`; a core built before wave 3 has none: WebGPU, everything). */
    caps() {
      const c = typeof forge.render_caps === 'function' ? forge.render_caps() : [1, 1, 0];
      const hdr = c[0] > 0.5;
      return { backend: host.backend ?? 'webgpu', hdr, floatCapture: c[1] > 0.5, maxTexture: c[2] || null, tier: hdr ? 'full' : 'ldr' };
    },
    /**
     * An actor's skinned vertices as the GPU skinned them last frame and as the CPU does with the same bone matrices:
     * {count, gpu, cpu, maxError (m)}. Verify check 19 on forge holds the GPU to the CPU, the CPU (forge-anim) to rig.js.
     */
    async capture(id) {
      const n = forge.capture_request(id);
      const t0 = performance.now();
      while (forge.capture_state() === 1) { if (performance.now() - t0 > 4000) throw new Error('the vertex capture took over 4 s'); await new Promise(res => setTimeout(res, 8)); }
      const gpu = forge.capture_take();
      if (!gpu) throw new Error('the vertex capture failed');
      const cpu = forge.capture_cpu(id);
      let maxError = 0;
      for (let i = 0; i < Math.min(gpu.length, cpu.length); i++) maxError = Math.max(maxError, Math.abs(gpu[i] - cpu[i]));
      return { count: n, gpu, cpu, maxError: gpu.length === cpu.length ? maxError : Infinity };
    },
  };
  return r;
}
