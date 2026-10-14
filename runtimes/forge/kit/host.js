// gf-forge's JS host (research/rust-engine/PLAN.md §2; core/ARCHITECTURE.md "The web boundary"), vendored into a game
// as gf/forge/host.js (never edited there). It picks the core's build for this device and boots it (a streaming
// compile from the game's file tree), loads the data tables (`spec.forge`, config/game.json →
// forge), turns the shared kit's input into the core's packed commands, makes one tick call a frame (the core runs its
// fixed 120 Hz steps inside it), reads the core's views and events back and routes the events (sounds to gf-audio by
// name, rule events to rules.js, the rest to whoever listens), loads every model and texture as a slot file's bytes
// (gf-assets: Studio's swaps and overrides apply), and gives the observation interface what Rust drew (coverage, slots,
// sight). The shared boot (gf/three/core/boot-forge.js) owns everything else: the menu, the HUD, the round, the net.
//
// One core, two builds (wave 3, track W; tools/build.mjs): a game ships both and a device downloads one.
//   a WebGPU adapter              → gf/forge/wasm/         (wgpu's WebGPU backend)
//   else WebGL2                   → gf/forge/wasm-webgl2/  (wgpu's GL backend on a WebGL2 context: the same renderer)
//   else                          → NoWebGPU: the boot shows the kit's own screen
//   ?gf-forge-backend=webgl|webgpu  forces one (QA): the other is never tried
// `host.backend` says which one draws ('webgpu' | 'webgl2'); `host.picked` why; `host.gl` what the WebGL2 context offers.
//
//   const host = await createHost(canvas);         // throws NoWebGPU when the browser has neither WebGPU nor WebGL2
//   host.loadTables(tables); host.cmd.spawn(1, {x, y, z}, yaw, true);
//   host.cmd.input(1, {mx, mz, dx, dy, held, pressed}); host.tick(dt); host.players(); host.route(ctx, rules)
//   host.on('hit', e => …)                          // any event kind: hit kill spawn despawn sound light particles camera ui rule motion
//   const model = await host.model(bytes); host.instance(model.id, slotIndex, {at, rot, scale}); host.render(t)
import BUILD from './BUILD.json' with { type: 'json' };
import { plainGlb } from './meshopt.js';

export const VERSION = '0.10.0';
/** The WebGPU build's hash (what gf/three/kit.js names as the forge wasm); `host.wasmSha256` is the loaded build's. */
export const BUILD_SHA256 = BUILD.wasm.sha256;
/** The page query that forces a build for QA: webgl (or webgl2) | webgpu. */
export const BACKEND_QUERY = 'gf-forge-backend';
/** The two builds: each one's wasm-bindgen glue (a literal import: tools that read imports see both) and its wasm. */
const BUILDS = {
  webgpu: { load: () => import('./wasm/forge_web.js'), wasm: './wasm/forge_web_bg.wasm' },
  webgl2: { load: () => import('./wasm-webgl2/forge_web.js'), wasm: './wasm-webgl2/forge_web_bg.wasm' },
};
export const BACKENDS = Object.keys(BUILDS);
/** The players view's fields (forge-core `views::player`): field f of player slot i is views[f * maxPlayers + i]. */
export const VIEW = { ID: 0, X: 1, Y: 2, Z: 3, YAW: 4, PITCH: 5, VX: 6, VY: 7, VZ: 8, GROUNDED: 9, LOCAL: 10, SPEED: 11, HP: 12, HP_MAX: 13, ARMOR: 14, ALIVE: 15 };
/** The entities view's fields (forge-core `views::entity`): field f of row i is entities[f * maxEntities + i]. */
export const ENTITY = { NET: 0, KIND: 1, TYPE: 2, X: 3, Y: 4, Z: 5, QX: 6, QY: 7, QZ: 8, QW: 9, SCALE: 10, HP: 11, FLAGS: 12, BONE_BASE: 13, BONE_COUNT: 14, SPEED: 15 };
export const ENTITY_FLAG = { DEAD: 1, REPLICA: 2, GROUNDED: 4, ANIMATED: 8 };
/** Entity kinds (forge-core `components::kind`). */
export const KIND = { PLAYER: 1, ENEMY: 2, PROJECTILE: 3, DEBRIS: 4, PICKUP: 5, PROP: 6 };
/** The camera view's fields (forge-core `views::camera`). */
export const CAMERA = { X: 0, Y: 1, Z: 2, YAW: 3, PITCH: 4, ALPHA: 5, FOV: 6, ROLL: 7, PLAYER: 8 };
/** Event kinds (forge-core `events`; 16 u32 words each: kind, 14 of payload, flags). */
export const EVENT = { HIT: 1, KILL: 2, SPAWN: 3, DESPAWN: 4, SOUND: 5, LIGHT: 6, PARTICLES: 7, CAMERA: 8, UI: 9, RULE: 10, MOTION: 11 };
export const EVENT_NAME = Object.fromEntries(Object.entries(EVENT).map(([k, v]) => [v, k.toLowerCase()]));
export const MOTION = { STEP: 1, JUMP: 2, LAND: 3, FELL: 4, BUMP: 5, EVADE: 6 };
export const UI = { DAMAGE: 1, COMBO: 2 };
export const FLAG_REMOTE = 1;
/** Command ops (forge-core `cmd`): 1..63 the core's; a plugin's in its range (feel 64..95, ai 96..127, system 128..159). */
export const OP = { INPUT: 1, TELEPORT: 2, SPAWN: 3, DESPAWN: 4, TUNING: 5, ADD_BOX: 6, CLEAR_BOXES: 7, POSE: 8, FLOOR_LIMIT: 9, SEED: 10, DAMAGE: 11, SET_HEALTH: 12, LOOK: 13 };
/** Buttons (INPUT's held and pressed words; forge-core `cmd::BTN_*`). SLOT1 << (n - 1) selects weapon n (1..4). */
export const BTN = { JUMP: 1, JUMP_PRESSED: 2, SPRINT: 4, FIRE: 8, ALT: 16, MELEE: 32, EVADE: 64, RELOAD: 128, INTERACT: 256, NEXT: 512, PREV: 1024, SLOT1: 2048, CROUCH: 32768 };
/** The core's yaw looks down −Z at 0 (a camera's); the kit's player yaw faces +Z at 0 (a character's). */
export const toCoreYaw = kitYaw => kitYaw + Math.PI;
export const toKitYaw = coreYaw => { let a = coreYaw - Math.PI; if (a < -Math.PI) a += Math.PI * 2; return a; };

export class NoWebGPU extends Error { constructor(m) { super(m); this.name = 'NoWebGPU'; } }

/** sRGB hex → linear [r, g, b]. */
export function linear(hex, fallback = '#000000') {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex ?? '')) ?? /^#?([0-9a-f]{6})$/i.exec(fallback);
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255].map(c => { const s = c / 255; return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; });
}

/** A column-major 4x4 transform from {at: [x, y, z], rot: degrees about Y (or [x, y, z] degrees, XYZ), scale}. */
export function transform({ at = [0, 0, 0], rot = 0, scale = 1 } = {}) {
  const [rx, ry, rz] = (Array.isArray(rot) ? rot : [0, rot, 0]).map(d => ((Number(d) || 0) * Math.PI) / 180);
  const [sx, sy, sz] = Array.isArray(scale) ? scale : [scale, scale, scale];
  const cx = Math.cos(rx), sxn = Math.sin(rx), cy = Math.cos(ry), syn = Math.sin(ry), cz = Math.cos(rz), szn = Math.sin(rz);
  // R = Rx · Ry · Rz (three.js 'XYZ' order)
  const m11 = cy * cz, m12 = -cy * szn, m13 = syn;
  const m21 = cx * szn + sxn * syn * cz, m22 = cx * cz - sxn * syn * szn, m23 = -sxn * cy;
  const m31 = sxn * szn - cx * syn * cz, m32 = sxn * cz + cx * syn * szn, m33 = cx * cy;
  return new Float32Array([m11 * sx, m21 * sx, m31 * sx, 0, m12 * sy, m22 * sy, m32 * sy, 0, m13 * sz, m23 * sz, m33 * sz, 0, at[0] ?? 0, at[1] ?? 0, at[2] ?? 0, 1]);
}

/** An image file's bytes → RGBA (the browser's own decoders), at most `max` px a side. */
export async function decodeImage(bytes, mime = 'image/png', max = 2048) {
  const blob = new Blob([bytes], { type: mime || 'image/png' });
  const opts = { colorSpaceConversion: 'none', premultiplyAlpha: 'none' };
  let bmp = await createImageBitmap(blob, opts);
  let w = bmp.width, h = bmp.height;
  const k = Math.min(1, max / Math.max(w, h));
  if (k < 1) { w = Math.max(1, Math.floor(w * k)); h = Math.max(1, Math.floor(h * k)); bmp.close?.(); bmp = await createImageBitmap(blob, { ...opts, resizeWidth: w, resizeHeight: h, resizeQuality: 'high' }); }
  const c = new OffscreenCanvas(w, h), g = c.getContext('2d', { willReadFrequently: true });
  g.drawImage(bmp, 0, 0); bmp.close?.();
  return { w, h, rgba: new Uint8Array(g.getImageData(0, 0, w, h).data.buffer) };
}

/**
 * One event's 16 words (a Uint32Array view `w` at word `k`) → an object: {kind: 'hit', remote, …its fields}. `name(i)`
 * turns a name number (a sound's, a particle kind's, a rule's) into its string.
 */
export function decodeEvent(w, k, name) {
  const f32 = new Float32Array(w.buffer, w.byteOffset + k * 4, 16);
  const u = i => w[k + i], f = i => f32[i], v = i => [f32[i], f32[i + 1], f32[i + 2]];
  const kind = u(0), remote = (u(15) & FLAG_REMOTE) !== 0;
  switch (kind) {
    case EVENT.HIT: return { kind: 'hit', remote, attacker: u(1), target: u(2), part: u(3), point: v(4), normal: v(7), damage: f(10), crit: u(11) !== 0, region: u(12) };
    case EVENT.KILL: return { kind: 'kill', remote, attacker: u(1), target: u(2), part: u(3), point: v(4), dir: v(7), damage: f(10) };
    case EVENT.SPAWN: return { kind: 'spawn', remote, id: u(1), entityKind: u(2), type: u(3), at: v(4), yaw: f(7) };
    case EVENT.DESPAWN: return { kind: 'despawn', remote, id: u(1), entityKind: u(2), type: u(3) };
    case EVENT.SOUND: return { kind: 'sound', remote, name: name(u(1)), source: u(2), at: v(3), gainDb: f(6), rate: f(7) };
    case EVENT.LIGHT: return { kind: 'light', remote, source: u(1), at: v(2), color: v(5), radius: f(8), intensity: f(9), frames: u(10) };
    case EVENT.PARTICLES: return { kind: 'particles', remote, name: name(u(1)), count: u(2), at: v(3), dir: v(6), speed: f(9), spread: f(10) };
    case EVENT.CAMERA: return { kind: 'camera', remote, player: u(1), kickPitch: f(2), kickYaw: f(3), fovPunch: f(4), fovTime: f(5), shake: f(6), shakeTime: f(7) };
    case EVENT.UI: return { kind: 'ui', remote, what: u(1) === UI.COMBO ? 'combo' : 'damage', player: u(2), at: v(3), value: f(6), crit: u(7) !== 0, count: u(8), multiplier: f(9), seconds: f(10) };
    case EVENT.RULE: return { kind: 'rule', remote, name: name(u(1)), entity: u(2), a: f(3), b: f(4), c: f(5), d: f(6) };
    case EVENT.MOTION: return { kind: 'motion', remote, what: ['', 'step', 'jump', 'land', 'fell', 'bump', 'evade'][u(1)] ?? String(u(1)), player: u(2), at: v(3), speed: f(6), air: f(7) };
    default: return { kind: `custom-${kind}`, remote, words: [...w.subarray(k + 1, k + 15)] };
  }
}

const b64 = bytes => { let s = ''; for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000)); return btoa(s); };
const unb64 = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));
const toBuffer = buf => (buf instanceof ArrayBuffer ? buf : buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));

async function digest(bytes) {
  const d = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(d)].map(b => b.toString(16).padStart(2, '0')).join('');
}

/**
 * What this browser's WebGL2 offers, asked of a scratch canvas that is let go at once (never the game's canvas: a
 * canvas that gave a WebGL2 context can no longer give a WebGPU one). → null without WebGL2, else the limits the
 * renderer depends on and the extensions that decide its tier:
 *   floatTargets      EXT_color_buffer_float or EXT_color_buffer_half_float: the HDR scene, bloom and the eye's
 *                     adaptation draw into Rgba16Float targets; without either the core draws its 8-bit scene
 *                     (look.js `backendTier`)
 *   maxTextureSize, maxUniformBlockSize, maxVertexTextureUnits, maxArrayLayers …   PLAN §5's limits, as this device has them
 */
export function webgl2Facts() {
  let gl = null;
  try {
    const c = globalThis.document?.createElement('canvas');
    if (!c) return null;
    c.width = c.height = 1;
    gl = c.getContext('webgl2', { alpha: false, antialias: false, depth: false, stencil: false, powerPreference: 'high-performance' });
  } catch { gl = null; }
  if (!gl) return null;
  const has = n => { try { return !!gl.getExtension(n); } catch { return false; } };
  const num = k => { try { return gl.getParameter(k); } catch { return null; } };
  let renderer = '';
  try { const d = gl.getExtension('WEBGL_debug_renderer_info'); renderer = String((d && gl.getParameter(d.UNMASKED_RENDERER_WEBGL)) || gl.getParameter(gl.RENDERER) || ''); } catch {}
  const float = has('EXT_color_buffer_float'), half = has('EXT_color_buffer_half_float');
  const facts = {
    renderer: renderer.slice(0, 160),
    software: /swiftshader|llvmpipe|software/i.test(renderer),
    maxTextureSize: num(gl.MAX_TEXTURE_SIZE), maxArrayLayers: num(gl.MAX_ARRAY_TEXTURE_LAYERS), maxRenderbufferSize: num(gl.MAX_RENDERBUFFER_SIZE),
    maxUniformBlockSize: num(gl.MAX_UNIFORM_BLOCK_SIZE), maxVertexUniformBlocks: num(gl.MAX_VERTEX_UNIFORM_BLOCKS), maxFragmentUniformBlocks: num(gl.MAX_FRAGMENT_UNIFORM_BLOCKS),
    maxVertexTextureUnits: num(gl.MAX_VERTEX_TEXTURE_IMAGE_UNITS), maxTextureUnits: num(gl.MAX_TEXTURE_IMAGE_UNITS), maxCombinedTextureUnits: num(gl.MAX_COMBINED_TEXTURE_IMAGE_UNITS),
    maxVertexAttribs: num(gl.MAX_VERTEX_ATTRIBS), maxVaryingComponents: num(gl.MAX_VARYING_COMPONENTS), maxDrawBuffers: num(gl.MAX_DRAW_BUFFERS),
    floatTargets: float || half, colorBufferFloat: float, colorBufferHalfFloat: half, floatBlend: has('EXT_float_blend'), floatLinear: has('OES_texture_float_linear'),
    shadowLod: has('EXT_texture_shadow_lod'), anisotropy: has('EXT_texture_filter_anisotropic'), loseContext: has('WEBGL_lose_context'),
  };
  try { gl.getExtension('WEBGL_lose_context')?.loseContext(); } catch {}
  return facts;
}

/** A WebGPU adapter worth drawing with: {ok, why, fallback}. A CPU fallback adapter is not one. Right after a browser
 *  starts the first request can come back empty while its GPU process comes up, so an empty answer is asked once more. */
async function webgpuAdapter() {
  const gpu = globalThis.navigator?.gpu;
  if (!gpu) return { ok: false, why: 'navigator.gpu is missing' };
  let a = null, why = 'requestAdapter() gave no adapter';
  for (let k = 0; k < 2 && !a; k++) {
    if (k) await new Promise(r => setTimeout(r, 150));
    try { a = await gpu.requestAdapter({ powerPreference: 'high-performance' }); } catch (e) { why = `requestAdapter() failed: ${e?.message ?? e}`; }
  }
  if (!a) return { ok: false, why };
  const fallback = !!(a.info?.isFallbackAdapter ?? a.isFallbackAdapter);
  return fallback ? { ok: false, fallback: true, why: 'only a CPU fallback adapter' } : { ok: true };
}

/**
 * Which build this device gets: {backend: 'webgpu' | 'webgl2' | null, forced, why, webgpu: {ok, why}, webgl2: facts | null}.
 * `force` ('webgpu' | 'webgl' | 'webgl2'; the page's ?gf-forge-backend= by default) names one for QA: then only that
 * one is looked for, and a browser without it gets `backend: null` (the kit's screen), never the other build.
 */
export async function pickBackend({ force = undefined } = {}) {
  if (force === undefined) { try { force = new URLSearchParams(globalThis.location?.search ?? '').get(BACKEND_QUERY); } catch { force = null; } }
  const want = force === 'webgl' ? 'webgl2' : BACKENDS.includes(force) ? force : null;
  const webgpu = want === 'webgl2' ? { ok: false, why: `not asked: ?${BACKEND_QUERY}=${force}` } : await webgpuAdapter();
  if (webgpu.ok) return { backend: 'webgpu', forced: !!want, why: want ? `forced by ?${BACKEND_QUERY}=${force}` : 'this browser has a WebGPU adapter', webgpu, webgl2: null };
  if (want === 'webgpu') return { backend: null, forced: true, why: `?${BACKEND_QUERY}=webgpu, and this browser has no WebGPU (${webgpu.why})`, webgpu, webgl2: null };
  const webgl2 = webgl2Facts();
  // WebGL2 drawn by the CPU (a browser with no graphics chip to use: SwiftShader, llvmpipe) is a few frames a second:
  // not a game. Such a device gets the kit's screen, unless QA asks for the build by name (the parent, wave 3 merge).
  if (webgl2?.software && !want) return { backend: null, forced: false, why: `no WebGPU (${webgpu.why}), and WebGL2 only in software (${webgl2.renderer || 'no graphics chip'})`, webgpu, webgl2 };
  if (webgl2) return { backend: 'webgl2', forced: !!want, why: want ? `forced by ?${BACKEND_QUERY}=${force}` : `no WebGPU (${webgpu.why}); WebGL2 on ${webgl2.renderer || 'this device'}`, webgpu, webgl2 };
  return { backend: null, forced: !!want, why: `this browser has neither WebGPU (${webgpu.why}) nor WebGL2`, webgpu, webgl2: null };
}

/** The page query that draws the 8-bit scene of a device without float render targets on any device (QA): 8bit. */
export const SCENE_QUERY = 'gf-forge-scene';

/** Load one build and start it on the canvas. → {mod, wasm, forge, compiledAt} */
async function start(backend, canvas, wasmUrl, scene8bit) {
  const b = BUILDS[backend];
  const mod = await b.load();
  const wasm = await mod.default({ module_or_path: wasmUrl ?? new URL(b.wasm, import.meta.url) });   // instantiateStreaming: compiles while it downloads
  const compiledAt = performance.now();
  const is = typeof mod.backend === 'function' ? mod.backend() : 'webgpu';
  if (is !== backend) throw new Error(`gf/forge/${b.wasm} is the ${is} build, not the ${backend} one`);
  const forge = await mod.create(canvas, !!scene8bit);
  return { mod, wasm, forge, compiledAt };
}

/**
 * The WebGL2 build's device loss. wgpu's GL backend does not notice a lost WebGL2 context, so the host listens on the
 * canvas: lost (a driver reset, a phone that took the context from a tab in the background) → the core is told, and
 * `lost()` is true; the browser restores the context by itself because the loss event's default is prevented;
 * `recover()` waits for that, then the core builds everything again on the restored context. `lose()` is QA's driver
 * reset: WEBGL_lose_context, restored 300 ms later.
 */
function watchContext(canvas, forge) {
  let lost = false, waiting = [];
  canvas.addEventListener('webglcontextlost', e => { e.preventDefault(); lost = true; try { forge.mark_lost(); } catch {} });
  canvas.addEventListener('webglcontextrestored', () => { lost = false; for (const f of waiting.splice(0)) f(); });
  return {
    restored: (ms = 15000) => (lost ? new Promise((ok, no) => { waiting.push(ok); setTimeout(() => no(new Error(`the WebGL2 context did not come back in ${ms / 1000} s`)), ms); }) : Promise.resolve()),
    lose() {
      const ext = canvas.getContext('webgl2')?.getExtension('WEBGL_lose_context');
      if (!ext) { forge.debug_lose_device(); return; }
      ext.loseContext();
      setTimeout(() => { try { ext.restoreContext(); } catch {} }, 300);
    },
  };
}

/**
 * Boot the core on `canvas` (its width and height are the drawing buffer's). → the host. The build is picked for this
 * device (`pickBackend`; `backend` or the page's ?gf-forge-backend= forces one). Throws NoWebGPU when the browser has
 * neither WebGPU nor WebGL2, or not the one that was forced (CONTRACT §8 forge: the boot then shows the kit's "open in
 * your browser" screen). `wasmUrl` (a dev build's wasm) is for the build picked.
 */
export async function createHost(canvas, { wasmUrl = null, early = null, backend: forceBackend = undefined } = {}) {
  // `early`: {backend, module}: a wasm the page began to compile with its first bytes (index.html), one build's
  const earlyFor = b => (early && early.module && early.backend === b ? early.module : null);
  const t0 = performance.now();
  const picked = await pickBackend({ force: forceBackend });
  if (!picked.backend) throw new NoWebGPU(picked.why);
  const tPicked = performance.now();
  let scene8bit = false;
  try { scene8bit = new URLSearchParams(globalThis.location?.search ?? '').get(SCENE_QUERY) === '8bit'; } catch {}
  let run = null;
  try { run = await start(picked.backend, canvas, wasmUrl ?? earlyFor(picked.backend), scene8bit); }
  catch (e) {
    const why = `${picked.backend === 'webgpu' ? 'WebGPU' : 'WebGL2'} did not start: ${e?.message ?? e}`;
    // the adapter came and the device did not: the WebGL2 build, unless WebGPU was asked for by name. (The WebGPU
    // build asks for its device before it touches the canvas, so the canvas can still give a WebGL2 context.)
    const gl = picked.backend === 'webgpu' && !picked.forced ? webgl2Facts() : null;
    if (!gl || gl.software) throw new NoWebGPU(why);
    console.warn(`gf-forge: ${why}; trying the WebGL2 build`);
    Object.assign(picked, { backend: 'webgl2', why: `${why}; WebGL2 on ${gl.renderer || 'this device'}`, webgl2: gl, fellBack: true });
    try { run = await start('webgl2', canvas, earlyFor('webgl2'), scene8bit); } catch (e2) { throw new NoWebGPU(`${why}; WebGL2 did not start either: ${e2?.message ?? e2}`); }
  }
  const { wasm, forge } = run, tCompiled = run.compiledAt;
  const tReady = performance.now();
  const backend = picked.backend, built = BUILD.builds?.[backend] ?? (backend === 'webgpu' ? { wasm: BUILD.wasm, glue: BUILD.glue } : null);
  const context = backend === 'webgl2' ? watchContext(canvas, forge) : null;
  const memory = wasm.memory;
  const cap = forge.cmd_capacity(), maxPlayers = forge.max_players(), fields = forge.view_fields();
  const maxEntities = forge.max_entities(), entityFields = forge.entity_fields(), cameraFields = forge.camera_fields();
  const scratch = new ArrayBuffer(cap * 4), U = new Uint32Array(scratch), F = new Float32Array(scratch);
  let words = 0;
  const textures = new Map();          // image digest → texture id (one copy of a picture several models share)
  const rec = (op, ints, floats = []) => {
    const n = ints.length + floats.length;
    if (words + 2 + n > cap) { console.warn('gf-forge: the command buffer is full this tick; a command was dropped'); return; }
    U[words++] = op; U[words++] = n;
    for (const v of ints) U[words++] = v >>> 0;
    for (const v of floats) F[words++] = Number.isFinite(v) ? v : 0;
  };
  // ints come first in every record, then floats (cmd.rs: SPAWN's `local` is the record's last word, an integer)
  const cmd = {
    /** A player's input this frame: the stick, the look (radians), the buttons held and those pressed since the last
     *  frame (BTN bits; `buttons` is wave 0's name for `held`). */
    input(id, { mx = 0, mz = 0, dx = 0, dy = 0, held = undefined, buttons = 0, pressed = 0, enabled = true } = {}) {
      if (words + 10 > cap) return;
      U[words++] = OP.INPUT; U[words++] = 8; U[words++] = id >>> 0; F[words++] = mx; F[words++] = mz; F[words++] = dx; F[words++] = dy;
      U[words++] = (held ?? buttons) >>> 0; U[words++] = enabled ? 1 : 0; U[words++] = pressed >>> 0;
    },
    teleport: (id, p, yaw = 0, pitch = 0) => rec(OP.TELEPORT, [id], [p.x, p.y, p.z, yaw, pitch]),
    spawn(id, p, yaw = 0, local = false) { if (words + 8 > cap) return; U[words++] = OP.SPAWN; U[words++] = 6; U[words++] = id >>> 0; F[words++] = p.x; F[words++] = p.y; F[words++] = p.z; F[words++] = yaw; U[words++] = local ? 1 : 0; },
    despawn: id => rec(OP.DESPAWN, [id]),
    /** Wave 0's tuning (walk, jump, gravity, footstep distance); the tables (`loadTables`) are the way now. */
    tuning: t => rec(OP.TUNING, [], [t.speed, t.sprint, t.jump, t.gravity, t.radius, t.height, t.eye, t.step].map(v => Number(v) || 0)),
    box: (min, max) => rec(OP.ADD_BOX, [], [...min, ...max]),
    clearBoxes: () => rec(OP.CLEAR_BOXES, []),
    pose: (id, p, yaw = 0, pitch = 0) => rec(OP.POSE, [id], [p.x, p.y, p.z, yaw, pitch]),
    floorLimit: y => rec(OP.FLOOR_LIMIT, [], [y]),
    seed: s => rec(OP.SEED, [s >>> 0, Math.floor(s / 4294967296) >>> 0]),
    setHealth: (id, hp, max, armor = 0) => rec(OP.SET_HEALTH, [id], [hp, max, armor]),
    look: (id, yaw, pitch = 0) => rec(OP.LOOK, [id], [yaw, pitch]),
    /** Any op (a plugin's): `ints` first, then `floats`. */
    raw: (op, ints = [], floats = []) => rec(op, ints, floats),
  };
  // DAMAGE: target, amount (f32), attacker, dir xyz (f32): mixed order, so written word by word
  cmd.damage = (target, amount, attacker = 0, dir = [0, 0, 0]) => {
    if (words + 8 > cap) return;
    U[words++] = OP.DAMAGE; U[words++] = 6; U[words++] = target >>> 0; F[words++] = amount; U[words++] = attacker >>> 0; F[words++] = dir[0] ?? 0; F[words++] = dir[1] ?? 0; F[words++] = dir[2] ?? 0;
  };
  let views = new Float32Array(0), camera = new Float32Array(16), events = new Uint32Array(0), steps = 0, decoded = null;
  const names = [''];
  const name = i => {
    if (i >= names.length) for (let k = names.length, n = forge.names_count(); k < n; k++) names.push(forge.name(k));
    return names[i] ?? '';
  };
  const listeners = new Map();         // kind → [fn]
  const host = {
    forge, memory, cmd, version: VERSION, build: BUILD,
    /** The build that draws on this device: 'webgpu' | 'webgl2'; why it was picked; the WebGL2 context's facts (null on
     *  WebGPU); the loaded wasm's hash (BUILD.json's for that build). */
    backend, picked: Object.freeze({ ...picked }), gl: picked.webgl2 ?? null, wasmSha256: built?.wasm?.sha256 ?? null,
    timing: { compileMs: Math.round(tCompiled - tPicked), deviceMs: Math.round(tReady - tCompiled), pickMs: Math.round(tPicked - t0), backend },
    info: () => forge.info(),
    hz: forge.step_hz(),
    plugins: () => forge.plugins().split(',').filter(Boolean),
    systems: () => forge.systems().split('\n').filter(Boolean),
    /** Load the data tables (config/game.json → forge, filled: gf/forge/tables `fill`). Again when Studio changes one. */
    loadTables: tables => forge.load_tables(typeof tables === 'string' ? tables : JSON.stringify(tables)),
    /** One frame: the commands written since the last tick, then the fixed 120 Hz steps dt owes (at most 100 ms). */
    tick(dt) {
      if (words) new Uint32Array(memory.buffer, forge.cmd_ptr(), cap).set(U.subarray(0, words));
      steps = forge.tick(dt, words); words = 0;
      // the views are re-read every tick: memory growth detaches old typed arrays (PLAN §2)
      views = new Float32Array(memory.buffer, forge.views_ptr(), forge.views_len()).slice();
      camera = new Float32Array(memory.buffer, forge.camera_ptr(), cameraFields).slice();
      const n = forge.events_count();
      events = n ? new Uint32Array(memory.buffer, forge.events_ptr(), n * 16).slice() : new Uint32Array(0);
      decoded = null;
      return steps;
    },
    get steps() { return steps; },
    /** The last tick's events, raw (16 u32 words each). */
    get events() { return events; },
    /** The last tick's events as objects (decodeEvent). */
    decodedEvents() {
      if (!decoded) { decoded = []; for (let k = 0; k < events.length; k += 16) decoded.push(decodeEvent(events, k, name)); }
      return decoded;
    },
    /** A name the core gave a number (a sound, a particle kind, a rule event). */
    name,
    /** Listen to an event kind ('hit', 'kill', 'light', …, or '*'): fn(event, ctx) after each tick's route. → off(). */
    on(kind, fn) { const l = listeners.get(kind) ?? []; l.push(fn); listeners.set(kind, l); return () => listeners.set(kind, (listeners.get(kind) ?? []).filter(x => x !== fn)); },
    /**
     * Route the last tick's events: SOUND to ctx.audio by name (sounds made by another player or an enemy at their
     * place, quieter with distance; the local player's own at full level), RULE to rules.event(ctx, name, data, 'forge'),
     * every event to its listeners (host.on). `local`: the local player's core id.
     */
    route(ctx, rules = null, { local = 0 } = {}) {
      for (const e of host.decodedEvents()) {
        if (e.kind === 'sound' && e.name) ctx.audio?.play(e.name, { optional: true, gainDb: e.gainDb, ...(e.source && e.source === local ? {} : { at: { x: e.at[0], y: e.at[1], z: e.at[2] } }) });
        else if (e.kind === 'rule' && e.name) { try { rules?.event?.(ctx, e.name, { entity: e.entity, a: e.a, b: e.b, c: e.c, d: e.d, remote: e.remote }, 'forge'); } catch (err) { console.error(err); } }
        for (const fn of [...(listeners.get(e.kind) ?? []), ...(listeners.get('*') ?? [])]) { try { fn(e, ctx); } catch (err) { console.error(err); } }
      }
    },
    /** The players the core holds: [{id, x, y, z, yaw (the core's), pitch, vx, vy, vz, grounded, local, speed, hp, hpMax, armor, alive}]. */
    players() {
      const out = [], n = forge.player_count(), at = (f, i) => views[f * maxPlayers + i];
      for (let i = 0; i < n; i++) out.push({ id: at(VIEW.ID, i), x: at(VIEW.X, i), y: at(VIEW.Y, i), z: at(VIEW.Z, i), yaw: at(VIEW.YAW, i), pitch: at(VIEW.PITCH, i), vx: at(VIEW.VX, i), vy: at(VIEW.VY, i), vz: at(VIEW.VZ, i), grounded: at(VIEW.GROUNDED, i) > 0.5, local: at(VIEW.LOCAL, i) > 0.5, speed: at(VIEW.SPEED, i), hp: at(VIEW.HP, i), hpMax: at(VIEW.HP_MAX, i), armor: at(VIEW.ARMOR, i), alive: at(VIEW.ALIVE, i) > 0.5 });
      return out;
    },
    /** Every entity with a net id (players too): [{net, kind, type, x, y, z, q: [x, y, z, w], scale, hp (share), flags, boneBase, boneCount, speed}], interpolated.
     *  With `kind`: only the entities of that kind (players: 1, enemies: 2), without an object made for every other one:
     *  a fight leaves hundreds of resting pieces (wave 2), and the per-frame readers want a handful of rows. */
    entities(kind = null) {
      const n = forge.entity_count(), v = new Float32Array(memory.buffer, forge.entities_ptr(), maxEntities * entityFields), at = (f, i) => v[f * maxEntities + i], out = [];
      const K = ENTITY.KIND * maxEntities;
      for (let i = 0; i < n; i++) {
        if (kind !== null && v[K + i] !== kind) continue;
        out.push({ net: at(ENTITY.NET, i), kind: at(ENTITY.KIND, i), type: at(ENTITY.TYPE, i), x: at(ENTITY.X, i), y: at(ENTITY.Y, i), z: at(ENTITY.Z, i), q: [at(ENTITY.QX, i), at(ENTITY.QY, i), at(ENTITY.QZ, i), at(ENTITY.QW, i)], scale: at(ENTITY.SCALE, i), hp: at(ENTITY.HP, i), flags: at(ENTITY.FLAGS, i), boneBase: at(ENTITY.BONE_BASE, i), boneCount: at(ENTITY.BONE_COUNT, i), speed: at(ENTITY.SPEED, i) });
      }
      return out;
    },
    /** How many entities of each kind the core holds: {players, enemies, debris, …, total} (the observation; cheap). */
    entityCounts() {
      const n = forge.entity_count(), v = new Float32Array(memory.buffer, forge.entities_ptr(), maxEntities * entityFields), K = ENTITY.KIND * maxEntities, by = {};
      for (let i = 0; i < n; i++) by[v[K + i]] = (by[v[K + i]] ?? 0) + 1;
      return { total: n, players: by[KIND.PLAYER] ?? 0, enemies: by[KIND.ENEMY] ?? 0, projectiles: by[KIND.PROJECTILE] ?? 0, debris: by[KIND.DEBRIS] ?? 0, pickups: by[KIND.PICKUP] ?? 0, coins: by[16] ?? 0 };
    },
    /** Every player's run state (wave 2; forge-web feel_players): Map of core id → {down, revive (0..1), reviver (a core
     *  id, 0 nobody), cards (how many held), alive}. Empty on a core without the feel's run. */
    runStates() {
      const out = new Map();
      if (typeof forge.feel_players !== 'function') return out;
      const v = forge.feel_players();
      for (let k = 0; k + 5 < v.length; k += 6) out.set(v[k], { down: v[k + 1] > 0.5, revive: v[k + 2], reviver: v[k + 3], cards: v[k + 4], alive: v[k + 5] > 0.5 });
      return out;
    },
    /** The bone palette (16 floats a bone, column-major): world (model space) or skin (world × inverse bind). A view
     *  into wasm memory: read it before the next tick. */
    bones: (skin = false) => new Float32Array(memory.buffer, skin ? forge.skins_ptr() : forge.bones_ptr(), forge.bones_len()),
    /** The local player's eye: {x, y, z, yaw, pitch, fov, roll, alpha, player} (the core's yaw; the feel's kick on top). */
    eye: () => ({ x: camera[CAMERA.X], y: camera[CAMERA.Y], z: camera[CAMERA.Z], yaw: camera[CAMERA.YAW], pitch: camera[CAMERA.PITCH], fov: camera[CAMERA.FOV], roll: camera[CAMERA.ROLL], alpha: camera[CAMERA.ALPHA], player: camera[CAMERA.PLAYER] }),
    fields, maxPlayers, maxEntities,
    /** Snapshot v1 bytes (at most 2600; forge-core `snapshot`), and the same as base64 for net.world. */
    snapshot: () => forge.snapshot(),
    snapshotB64: () => b64(forge.snapshot()),
    apply: bytes => forge.apply(bytes),
    applyB64: s => forge.apply(unb64(s)),
    /** The last snapshot's size in bytes (on the host). */
    snapshotBytes: () => forge.snapshot_bytes(),
    /**
     * Live co-op (forge-core net.rs; CONTRACT §8 forge "Live co-op"): the host's core owns the world and replays each
     * joiner's inputs; a joiner predicts its own player and reconciles against the host's snapshots.
     *   role(r, local, epoch)  r: 'solo' | 'host' | 'joiner'; local: this copy's own player's core id; epoch: a joiner's
     *                          page load (a reload is a new one)
     *   takeInputs()           a joiner: its inputs since the last call, base64 (null: none) → the host's pushInputs
     *   pushInputs(id, b64)    the host: a joiner's batch for its player `id` → inputs queued
     *   stats()                {role, checked, corrected, snapped, lastError, maxError, suppressed, queues, snapshots}
     * Wave 4, watch then play (CONTRACT §9b): a viewer's copy has no player of its own. Every player in the host's
     * snapshots is a replica there; it predicts, sends and reconciles nothing.
     *   role('viewer')         this copy only watches
     *   watch(id)              look through that player's eyes (a core id; 0: nobody): from then on the core's camera,
     *                          its feel view and `players()[i].local` are that player's
     */
    net: {
      role: (r, local = 0, epoch = 0) => forge.net_role(r === 'host' ? 1 : r === 'joiner' ? 2 : r === 'viewer' ? 3 : 0, local >>> 0, epoch >>> 0),
      watch: id => forge.net_watch?.(id >>> 0),
      takeInputs: () => { const b = forge.net_take_inputs(); return b.length ? b64(b) : null; },
      pushInputs: (id, s) => { try { return forge.net_push_inputs(id >>> 0, unb64(s)); } catch (e) { console.warn(`gf-forge: a bad input batch from ${id}: ${e?.message ?? e}`); return 0; } },
      stats: () => { try { return JSON.parse(forge.net_stats()); } catch { return null; } },
    },
    /** What player `net` wears (forge-core components::Wear): {color (sRGB hex), body (its slot index), hidden}. → false when it is not here. */
    wear: (net, { color = '#ffffff', body = 0xffffffff, hidden = false } = {}) => { const [r, g, b] = linear(color); return forge.set_wear(net >>> 0, r, g, b, body >>> 0, !!hidden); },
    /** What entity `net` wears: {tint (linear), color (sRGB hex), body (slot index or -1), held (row, 255 none), hidden}, or null. */
    wearOf(net) {
      const w = forge.wear(net >>> 0); if (!w.length) return null;
      const hex = '#' + Array.from(w.slice(0, 3), c => { const s = c <= 0.0031308 ? c * 12.92 : 1.055 * c ** (1 / 2.4) - 0.055; return Math.round(Math.max(0, Math.min(1, s)) * 255).toString(16).padStart(2, '0'); }).join('');
      return { tint: Array.from(w.slice(0, 3)), color: hex, body: w[3], held: w[4], hidden: w[5] > 0.5 };
    },
    /** Nothing of the world's static colliders between two points ({x, y, z} each). */
    clearLine: (a, b) => forge.clear_line(a.x, a.y, a.z, b.x, b.y, b.z),
    /** True once the renderer draws `Wear` bodies skinned itself (track R adds `draws_bodies` to forge-web). */
    drawsBodies: () => typeof forge.draws_bodies === 'function' && !!forge.draws_bodies(),
    /** A static triangle-mesh collider: vertices [x, y, z, …], indices [a, b, c, …]. */
    staticMesh: (vertices, indices) => forge.add_static_mesh(new Float32Array(vertices), new Uint32Array(indices)),

    // ---- animation (forge-anim): bodies and clips arrive as slot files' bytes ----
    /** A skinned body's GLB → its id (meshopt decoded first). */
    async animBody(buf) { return forge.add_anim_body(new Uint8Array(await plainGlb(toBuffer(buf)))); },
    /** A clip file's GLB (the gf-humanoid-1 clips, or a model's own) → its id. */
    async animClips(buf) { return forge.add_anim_clips(new Uint8Array(await plainGlb(toBuffer(buf)))); },
    /** Animate the entity `net`: `body` playing `clips`; {hurt: true} gives it the body's ragdoll-part hurtbox. */
    animate: (net, body, clips, { hurt = false } = {}) => forge.animate(net, body, clips, !!hurt),
    /** Play a clip on an animated entity: {fade (s), layer: 'base' | 'upper' | null (the clip's own), loop: true | false | null}. */
    animPlay: (net, clip, { fade = 0.2, layer = null, loop = null } = {}) => forge.anim_play(net, clip, fade, layer === 'base' ? 1 : layer === 'upper' ? 2 : 0, loop === null ? -1 : loop ? 1 : 0),
    animBones: body => Array.from({ length: forge.anim_bone_count(body) }, (_, j) => forge.anim_bone_name(body, j)),

    // ---- the scene: everything drawn arrives as a slot file's bytes ----
    /** A GLB's bytes → {id, triangles, bounds}. Meshopt is decoded first; each picture inside is decoded once. */
    async model(buf) {
      const plain = await plainGlb(buf instanceof ArrayBuffer ? buf : buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
      const id = forge.add_model(new Uint8Array(plain));
      for (let i = 0; i < forge.model_image_count(id); i++) {
        const bytes = forge.model_image_bytes(id, i), key = await digest(bytes);
        if (!textures.has(key)) {
          const img = await decodeImage(bytes, forge.model_image_mime(id, i));
          forge.set_model_image(id, i, img.w, img.h, img.rgba);
          textures.set(key, forge.model_image_texture(id, i));
        } else forge.link_model_image(id, i, textures.get(key));
      }
      return { id, triangles: forge.model_triangles(id), bounds: [...forge.model_bounds(id)] };
    },
    /** An image file's bytes → a texture id. */
    async texture(buf, mime = 'image/png') {
      const bytes = new Uint8Array(buf instanceof ArrayBuffer ? buf : buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
      const key = await digest(bytes);
      if (textures.has(key)) return textures.get(key);
      const img = await decodeImage(bytes, mime);
      const id = forge.add_texture(img.w, img.h, img.rgba);
      textures.set(key, id);
      return id;
    },
    /** Draw `tex` in place of every picture of `model` (−1: its own). */
    modelTexture: (model, tex) => forge.set_model_texture(model, tex),
    instance: (model, slot, place) => forge.add_instance(model, slot, transform(place)),
    move: (i, place) => forge.set_instance_transform(i, transform(place)),
    visible: (i, on) => forge.set_instance_visible(i, !!on),
    /** Multiply instance `i`'s colours toward `hex` by `mix` (0: its own, 1: the colour itself). */
    /** Instance `i`'s colours multiplied by a linear [r, g, b]. */
    tintLinear: (i, rgb) => forge.set_instance_tint(i, rgb[0], rgb[1], rgb[2], 1),
    tint: (i, hex, mix = 1) => { const [r, g, b] = linear(hex); const k = Math.max(0, Math.min(1, mix)); forge.set_instance_tint(i, 1 - k + k * r, 1 - k + k * g, 1 - k + k * b, 1); },
    clear: () => forge.clear_instances(),
    setLook: packed => forge.set_look(packed),
    setLights: list => forge.set_lights(new Float32Array(list.flatMap(l => [l.x, l.y, l.z, l.range, ...l.color, l.intensity]))),
    lens: (fov, near = 0.05, far = 200) => forge.set_lens(fov, near, far),
    /** Look from the local player's eyes (true) or from `pose` (show mode, the lobby). */
    eyes: on => forge.use_core_camera(!!on),
    pose: (x, y, z, yaw, pitch) => forge.set_camera_pose(x, y, z, yaw, pitch),
    drawnCamera: () => { const c = forge.camera(); return { x: c[0], y: c[1], z: c[2], yaw: c[3], pitch: c[4], fov: c[5] }; },

    // ---- the frame ----
    resize: (w, h) => forge.resize(w, h),
    maxDimension: () => forge.max_dimension(),
    render: time => forge.render(time),
    frames: () => forge.frames(),
    draws: () => forge.draws(),

    // ---- the observation interface's readbacks ----
    /** Per instance: {i, slot (index, −1 none), visible, area (px), onScreen, triangles, distance, min, max}. */
    report() {
      const r = forge.report(), out = [];
      for (let i = 0; i * 12 < r.length; i++) { const k = i * 12; out.push({ i, slot: r[k], visible: r[k + 1] > 0.5, area: r[k + 2], onScreen: r[k + 3] > 0.5, triangles: r[k + 4], distance: r[k + 5], min: [r[k + 6], r[k + 7], r[k + 8]], max: [r[k + 9], r[k + 10], r[k + 11]] }); }
      return out;
    },
    /** The slot-ID passes from the current camera: {w, h, all, only} (slot index + 1 per pixel, 0 for nothing). */
    async sight(slotIndices) {
      forge.request_sight(new Uint32Array(slotIndices));
      const t = performance.now();
      while (forge.sight_state() === 1) { if (performance.now() - t > 4000) throw new Error('the slot-ID readback took over 4 s'); await new Promise(r => setTimeout(r, 8)); }
      const data = forge.take_sight();
      if (!data) throw new Error('the slot-ID readback failed');
      const [w, h] = forge.sight_size();
      return { w, h, all: data.subarray(0, w * h), only: data.subarray(w * h) };
    },

    // ---- device loss (the WebGL2 build: a lost and restored context, `watchContext`) ----
    lost: () => forge.lost(),
    recover: async () => { if (context) await context.restored(); return forge.recover(); },
    recoveries: () => forge.recoveries(),
    loseDevice: () => (context ? context.lose() : forge.debug_lose_device()),
  };
  return host;
}
