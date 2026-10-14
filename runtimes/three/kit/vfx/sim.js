// gf-three vfx, the simulation half: pure arrays, no three.js, no DOM, so Node tests step it and both renderers share it.
// A "system" is one preset's fixed pool (structure of arrays). Emission reuses the oldest slot, so nothing allocates
// after construction. The parameter names follow the vocabulary of Three-VFX and GameFactory-3A's vfx-kit (size,
// speed, life, drag, gravity, stretch, blending, emitter shapes, ...); the code is written fresh (the idea and the
// names, not either library's source, are taken: see ATTRIBUTION.md beside this file).

/** Every number a preset may set. A preset's `shape` object overrides these one by one. */
export const DEFAULT_SHAPE = Object.freeze({
  count: 24,            // particles in one burst
  rate: 0,              // particles a second for a continuous emitter (follow); 0 = bursts only
  emitter: 'point',     // where a particle is born: point | sphere | disc | ring | box | line
  radius: 0,            // sphere, disc, ring and box radius (metres, times the effect's scale)
  height: 0,            // box height, line length
  outward: 0,           // 0..1: how much a particle leaves along the way it was born from the emitter's centre
  speed: 7, speedJitter: 0.5,
  life: 0.45, lifeJitter: 0.4,
  size: 0.12, sizeJitter: 0.5,
  gravity: 12,          // m/s², positive pulls down; negative rises (smoke, fire)
  drag: 1.5,
  spread: 0.9,          // 0 = a line along dir, 1 = a cone as wide as a sphere
  up: 0.35,             // extra upward velocity, in speeds
  stretch: 3,           // 0 = a round particle; > 0 stretches along its screen-space velocity
  spin: 0,              // radians a second at most (round particles only)
  fade: 1.2,            // additive: how fast the glow dies (1 - k)^fade
  shrink: 0.6,          // 0..1: how much of its size a particle loses by the end of its life
  grow: 1,              // size multiplier reached at the end of life (smoke grows)
  hueJitter: 0,         // 0..1: random hue shift per particle (confetti)
  intensity: 1.6,       // colour multiplier
  blending: 'additive', // additive | normal
});
export const EMITTERS = Object.freeze(['point', 'sphere', 'disc', 'ring', 'box', 'line']);
export const BLENDINGS = Object.freeze(['additive', 'normal']);
const FIELDS = ['px', 'py', 'pz', 'vx', 'vy', 'vz', 'age', 'life', 'size', 'rot', 'spin', 'hue'];

export function createSystem(cap) {
  const s = { cap, next: 0, alive: 0 };
  for (const f of FIELDS) s[f] = new Float32Array(cap);
  s.life.fill(1); s.age.fill(1);   // age >= life: dead
  return s;
}

/** A shape with every missing number filled and every wrong one replaced: a preset is data and may be hand-edited. */
export function normalizeShape(over = {}) {
  const out = { ...DEFAULT_SHAPE };
  for (const [k, d] of Object.entries(DEFAULT_SHAPE)) {
    const v = over?.[k];
    if (typeof d === 'number') out[k] = Number.isFinite(v) ? v : d;
    else if (k === 'emitter') out[k] = EMITTERS.includes(v) ? v : d;
    else if (k === 'blending') out[k] = BLENDINGS.includes(v) ? v : d;
  }
  return out;
}

const O = [0, 0, 0], U = [0, 0, 0];
function unitSphere(rnd, out) {
  for (;;) {
    const x = rnd() * 2 - 1, y = rnd() * 2 - 1, z = rnd() * 2 - 1, l = x * x + y * y + z * z;
    if (l > 0.0001 && l <= 1) { const k = 1 / Math.sqrt(l); out[0] = x * k; out[1] = y * k; out[2] = z * k; return; }
  }
}

/** Where in the emitter a particle starts: writes the offset into O (metres). */
function sampleEmitter(shape, scale, rnd) {
  const r = shape.radius * scale, h = shape.height * scale;
  switch (shape.emitter) {
    case 'sphere': { unitSphere(rnd, O); const m = r * Math.cbrt(rnd()); O[0] *= m; O[1] *= m; O[2] *= m; break; }
    case 'disc': { const a = rnd() * Math.PI * 2, m = r * Math.sqrt(rnd()); O[0] = Math.cos(a) * m; O[1] = 0; O[2] = Math.sin(a) * m; break; }
    case 'ring': { const a = rnd() * Math.PI * 2; O[0] = Math.cos(a) * r; O[1] = 0; O[2] = Math.sin(a) * r; break; }
    case 'box': O[0] = (rnd() * 2 - 1) * r; O[1] = rnd() * h; O[2] = (rnd() * 2 - 1) * r; break;
    case 'line': O[0] = 0; O[1] = (rnd() - 0.5) * h; O[2] = 0; break;
    default: O[0] = O[1] = O[2] = 0;
  }
}

/** Birth `count` particles at `at` ({x,y,z}); `dir` ({x,y,z}, optional) aims a cone (spread 0 = a line, 1 = wide), else a sphere. */
export function emit(s, shape, at, { dir = null, count = shape.count, scale = 1, rnd = Math.random } = {}) {
  const j = (a, k) => a * (1 + (rnd() * 2 - 1) * k);
  let dx = 0, dy = 1, dz = 0;
  if (dir) { const l = Math.hypot(dir.x, dir.y ?? 0, dir.z) || 1; dx = dir.x / l; dy = (dir.y ?? 0) / l; dz = dir.z / l; }
  const w = Math.min(1, shape.spread), out = Math.min(1, Math.max(0, shape.outward));
  for (let n = 0; n < count; n++) {
    const i = s.next; s.next = (i + 1) % s.cap;
    unitSphere(rnd, U);
    let ux = U[0], uy = U[1], uz = U[2];
    if (dir) { ux = dx + (ux - dx) * w; uy = dy + (uy - dy) * w; uz = dz + (uz - dz) * w; const k = 1 / (Math.hypot(ux, uy, uz) || 1); ux *= k; uy *= k; uz *= k; }
    sampleEmitter(shape, scale, rnd);
    if (out > 0) {
      const l = Math.hypot(O[0], O[1], O[2]);
      if (l > 1e-6) { ux += (O[0] / l - ux) * out; uy += (O[1] / l - uy) * out; uz += (O[2] / l - uz) * out; const k = 1 / (Math.hypot(ux, uy, uz) || 1); ux *= k; uy *= k; uz *= k; }
    }
    const sp = j(shape.speed, shape.speedJitter) * scale;
    s.px[i] = at.x + O[0]; s.py[i] = at.y + O[1]; s.pz[i] = at.z + O[2];
    s.vx[i] = ux * sp; s.vy[i] = (uy + shape.up) * sp; s.vz[i] = uz * sp;
    s.age[i] = 0; s.life[i] = Math.max(0.05, j(shape.life, shape.lifeJitter)); s.size[i] = j(shape.size, shape.sizeJitter) * scale;
    s.rot[i] = rnd() * Math.PI * 2; s.spin[i] = (rnd() * 2 - 1) * shape.spin; s.hue[i] = (rnd() * 2 - 1) * 0.5 * shape.hueJitter;
  }
  s.alive = Math.min(s.cap, s.alive + count);   // an upper bound until the next step counts them
}

/** Advance every live particle; returns how many are alive. */
export function step(s, shape, dt) {
  const drag = Math.exp(-shape.drag * dt), g = shape.gravity * dt;
  let alive = 0;
  for (let i = 0; i < s.cap; i++) {
    if (s.age[i] >= s.life[i]) continue;
    s.age[i] += dt;
    if (s.age[i] >= s.life[i]) continue;
    s.vx[i] *= drag; s.vz[i] *= drag; s.vy[i] = s.vy[i] * drag - g;
    s.px[i] += s.vx[i] * dt; s.py[i] += s.vy[i] * dt; s.pz[i] += s.vz[i] * dt;
    s.rot[i] += s.spin[i] * dt;
    alive++;
  }
  s.alive = alive;
  return alive;
}

/** A continuous emitter's accumulator: how many whole particles this frame owes (the remainder is carried). */
export function owed(em, rate, dt) { em.acc = (em.acc ?? 0) + rate * dt; const n = Math.floor(em.acc); em.acc -= n; return n; }
