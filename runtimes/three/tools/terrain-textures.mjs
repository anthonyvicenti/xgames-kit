#!/usr/bin/env node
// The terrain world's own ground pictures (library pack xk-terrain, CC0): painted cartoon textures drawn by code, every
// one seamless by construction (all noise and every shape wraps at the tile's edge), so the ground never shows a seam.
// Deterministic: the same files every run (the pack's sha256s say whether the art changed).
//
//   node runtimes/three/tools/terrain-textures.mjs --out <dir> [--size 1024] [--only grass-top,soil-layers] [--sheet sheet.png]
//
//   grass-top     painted turf seen from above: soft patches of light and shade, tufts of blades, a few flowers
//   sand-top      a beach seen from above: ripples, specks and shell bits
//   soil-layers   the ground cut open: level layers of brown with wavy, inked boundaries, pebbles and stones in them
//   rock-layers   a cliff's cross-section: pale sandstone strata with cracks and ledges
import { writeFileSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { mulberry32 } from '../../../worlds/voxel/noise.mjs';
import { png } from './voxel-faces.mjs';

const hex = h => { const n = parseInt(h.replace('#', ''), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; };
const clamp = (v, a = 0, b = 1) => (v < a ? a : v > b ? b : v);
const smooth = (a, b, x) => { const t = clamp((x - a) / (b - a)); return t * t * (3 - 2 * t); };
const mix = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];

/** Tileable value noise: period p lattice cells across the tile, smooth (quintic), seeded. f(u, v) with u, v in [0, 1). */
function tileNoise(seed, p) {
  const rnd = mulberry32(seed), g = Float32Array.from({ length: p * p }, () => rnd());
  const fade = t => t * t * t * (t * (t * 6 - 15) + 10);
  return (u, v) => {
    const x = ((u % 1) + 1) % 1 * p, y = ((v % 1) + 1) % 1 * p, i = Math.floor(x), j = Math.floor(y), fx = fade(x - i), fy = fade(y - j);
    const a = g[(j % p) * p + (i % p)], b = g[(j % p) * p + ((i + 1) % p)], c = g[((j + 1) % p) * p + (i % p)], d = g[((j + 1) % p) * p + ((i + 1) % p)];
    return a + (b - a) * fx + (c - a) * fy + (a - b - c + d) * fx * fy;
  };
}
function fbm(seed, base, oct = 4) {
  const ns = Array.from({ length: oct }, (_, k) => tileNoise(seed + k * 101, base << k));
  return (u, v) => { let s = 0, a = 1, n = 0; for (const f of ns) { s += f(u, v) * a; n += a; a *= 0.5; } return s / n; };
}

class Canvas {
  constructor(S) { this.S = S; this.c = new Float32Array(S * S * 3); }
  fill(fn) { const S = this.S; for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) { const c = fn(x / S, y / S, x, y); const i = (y * S + x) * 3; this.c[i] = c[0]; this.c[i + 1] = c[1]; this.c[i + 2] = c[2]; } }
  /** Paint a shape over the tile, wrapping: cover(dx, dy) (pixels from its centre) → 0..1, colour(dx, dy) → rgb. */
  stamp(cx, cy, r, cover, colour) {
    const S = this.S, R = Math.ceil(r) + 2;
    for (let dy = -R; dy <= R; dy++) for (let dx = -R; dx <= R; dx++) {
      const a = cover(dx, dy); if (a <= 0) continue;
      const x = (((Math.round(cx) + dx) % S) + S) % S, y = (((Math.round(cy) + dy) % S) + S) % S, i = (y * S + x) * 3;
      const col = colour(dx, dy), k = clamp(a);
      this.c[i] += (col[0] - this.c[i]) * k; this.c[i + 1] += (col[1] - this.c[i + 1]) * k; this.c[i + 2] += (col[2] - this.c[i + 2]) * k;
    }
  }
  get(x, y) { const S = this.S; x = ((x % S) + S) % S; y = ((y % S) + S) % S; const i = (y * S + x) * 3; return [this.c[i], this.c[i + 1], this.c[i + 2]]; }
  rgba() { const out = new Uint8Array(this.S * this.S * 4); for (let i = 0, j = 0; i < this.c.length; i += 3, j += 4) { out[j] = clamp(this.c[i] / 255) * 255; out[j + 1] = clamp(this.c[i + 1] / 255) * 255; out[j + 2] = clamp(this.c[i + 2] / 255) * 255; out[j + 3] = 255; } return out; }
}
/** A soft-edged ellipse with an ink outline: → {cover, inner} for a point (dx, dy) (pixels). */
const ellipse = (rx, ry, rot = 0) => (dx, dy) => { const c = Math.cos(rot), s = Math.sin(rot), x = (dx * c + dy * s) / rx, y = (-dx * s + dy * c) / ry; return Math.sqrt(x * x + y * y); };

const MAKERS = {
  'grass-top'(S) {
    const cv = new Canvas(S), rnd = mulberry32(11);
    const big = fbm(21, 3, 3), mid = fbm(37, 8, 3), fine = fbm(53, 32, 2);
    const base = hex('#69bf3a'), dark = hex('#4e9e2c'), light = hex('#8fd64c'), deep = hex('#3f8a26');
    cv.fill((u, v) => {
      const b = big(u, v), m = mid(u, v), f = fine(u, v);
      let c = mix(dark, base, smooth(0.3, 0.55, b));
      c = mix(c, light, smooth(0.55, 0.75, b) * 0.8);
      c = mix(c, deep, smooth(0.62, 0.8, m) * 0.35);
      return c.map(x => x * (0.94 + 0.12 * f));
    });
    // tufts: fans of blades, dark at the root and light at the tip
    for (let t = 0; t < S * S / 900; t++) {
      const cx = rnd() * S, cy = rnd() * S, n = 3 + Math.floor(rnd() * 4), len = S * (0.012 + rnd() * 0.012), sh = big(cx / S, cy / S);
      for (let k = 0; k < n; k++) {
        const ang = -Math.PI / 2 + (k - (n - 1) / 2) * 0.38 + (rnd() - 0.5) * 0.3, w = len * 0.22;
        const E = ellipse(len * 0.55, w, ang);
        const ox = Math.cos(ang) * len * 0.45, oy = Math.sin(ang) * len * 0.45;
        const tipC = mix(light, hex('#b4ec6a'), 0.4 + 0.4 * sh), rootC = mix(deep, dark, 0.5);
        cv.stamp(cx + ox, cy + oy, len, (dx, dy) => 1 - smooth(0.85, 1.05, E(dx, dy)), (dx, dy) => mix(rootC, tipC, clamp(0.5 + (dx * Math.cos(ang) + dy * Math.sin(ang)) / (len * 1.1))));
      }
    }
    // a few flowers: five soft petals round a dot
    for (let t = 0; t < S * S / 60000; t++) {
      const cx = rnd() * S, cy = rnd() * S, r = S * (0.0045 + rnd() * 0.003), col = rnd() < 0.7 ? hex('#ffe066') : hex('#ffffff');
      for (let k = 0; k < 5; k++) { const a = k * Math.PI * 2 / 5, E = ellipse(r * 0.7, r * 0.45, a); cv.stamp(cx + Math.cos(a) * r * 0.7, cy + Math.sin(a) * r * 0.7, r, (dx, dy) => 1 - smooth(0.85, 1.1, E(dx, dy)), () => col); }
      const C = ellipse(r * 0.4, r * 0.4); cv.stamp(cx, cy, r, (dx, dy) => 1 - smooth(0.8, 1.1, C(dx, dy)), () => hex('#f08a24'));
    }
    return cv;
  },
  'sand-top'(S) {
    const cv = new Canvas(S), rnd = mulberry32(17);
    const big = fbm(71, 4, 3), rip = fbm(83, 6, 2), fine = fbm(97, 64, 2);
    const base = hex('#ecd193'), dark = hex('#d4b06c'), light = hex('#f8e6b4');
    cv.fill((u, v) => {
      const r = Math.sin((v * 14 + rip(u, v) * 3.2) * Math.PI * 2) * 0.5 + 0.5;
      let c = mix(dark, base, smooth(0.25, 0.6, big(u, v)));
      c = mix(c, light, smooth(0.65, 0.95, r) * 0.45);
      return c.map(x => x * (0.95 + 0.1 * fine(u, v)));
    });
    for (let t = 0; t < S * S / 3000; t++) { const cx = rnd() * S, cy = rnd() * S, r = 1 + rnd() * 2.2, col = rnd() < 0.5 ? hex('#b8945a') : hex('#fff4d6'); const E = ellipse(r, r * 0.8, rnd() * 3); cv.stamp(cx, cy, r, (dx, dy) => 1 - smooth(0.8, 1.1, E(dx, dy)), () => col); }
    return cv;
  },
  'soil-layers'(S) {
    // level layers (a whole number of them per tile, so the tile repeats up and down), their boundaries wavy and inked
    const cv = new Canvas(S), rnd = mulberry32(29);
    const wave = fbm(131, 4, 3), grain = fbm(151, 48, 2), blot = fbm(167, 10, 3);
    const layers = ['#8b5732', '#74452a', '#9a643a', '#6a3d24', '#83502f'].map(hex);
    const nL = layers.length, ink = hex('#3a2212');
    cv.fill((u, v) => {
      const w = v * nL + (wave(u, v) - 0.5) * 0.9;            // the layer coordinate, wavy
      const k = ((Math.floor(w) % nL) + nL) % nL, f = w - Math.floor(w);
      let c = layers[k];
      c = mix(c, c.map(x => x * 1.18), smooth(0.05, 0.4, f) * (1 - smooth(0.4, 0.9, f)) * 0.6);    // a lit band under each line
      c = mix(c, c.map(x => x * 0.78), smooth(0.7, 1, f) * 0.6);                                       // shade above the next
      c = mix(c, c.map(x => x * 0.82), smooth(0.55, 0.75, blot(u, v)) * 0.5);
      const line = 1 - smooth(0.0, 0.035, Math.min(f, 1 - f));
      c = mix(c, ink, line * 0.85);
      return c.map(x => x * (0.93 + 0.14 * grain(u, v)));
    });
    // pebbles and stones: rounded, outlined, lit from above
    const stones = ['#b48a62', '#9c958c', '#c4a07a', '#7f7a74', '#d1b38c'].map(hex);
    for (let t = 0; t < S * S / 7000; t++) {
      const cx = rnd() * S, cy = rnd() * S, r = S * (0.006 + rnd() * rnd() * 0.03), col = stones[Math.floor(rnd() * stones.length)];
      const E = ellipse(r, r * (0.6 + rnd() * 0.35), (rnd() - 0.5) * 0.8);
      cv.stamp(cx, cy, r * 1.2, (dx, dy) => 1 - smooth(1.0, 1.12, E(dx, dy)), (dx, dy) => {
        const e = E(dx, dy);
        if (e > 0.86) return ink;
        const lit = clamp(0.5 - dy / (r * 1.6) - dx / (r * 4));
        return mix(col.map(x => x * 0.78), col.map(x => Math.min(255, x * 1.18)), lit);
      });
    }
    // little specks
    for (let t = 0; t < S * S / 1500; t++) { const cx = rnd() * S, cy = rnd() * S, r = 1 + rnd() * 1.6, col = rnd() < 0.5 ? hex('#4d2c18') : hex('#b07a4c'); const E = ellipse(r, r * 0.8); cv.stamp(cx, cy, r, (dx, dy) => 1 - smooth(0.8, 1.1, E(dx, dy)), () => col); }
    return cv;
  },
  'rock-layers'(S) {
    const cv = new Canvas(S), rnd = mulberry32(41);
    const wave = fbm(211, 3, 3), grain = fbm(223, 40, 2), crack = fbm(239, 6, 4);
    const layers = ['#d9b98a', '#c9a473', '#e3c79c', '#bf966a', '#d1ae7e', '#b88d62'].map(hex);
    const nL = layers.length, ink = hex('#5a3a22');
    cv.fill((u, v) => {
      const w = v * nL + (wave(u, v) - 0.5) * 0.5;
      const k = ((Math.floor(w) % nL) + nL) % nL, f = w - Math.floor(w);
      let c = layers[k];
      c = mix(c, c.map(x => Math.min(255, x * 1.12)), (1 - smooth(0.0, 0.3, f)) * 0.7);   // the ledge's lit lip
      c = mix(c, c.map(x => x * 0.8), smooth(0.75, 1, f) * 0.5);
      const cr = Math.abs(crack(u, v) - 0.5);
      c = mix(c, ink, (1 - smooth(0.006, 0.02, cr)) * 0.55 * smooth(0.2, 0.8, f));
      c = mix(c, ink, (1 - smooth(0.0, 0.03, Math.min(f, 1 - f))) * 0.7);
      return c.map(x => x * (0.93 + 0.14 * grain(u, v)));
    });
    for (let t = 0; t < S * S / 2500; t++) { const cx = rnd() * S, cy = rnd() * S, r = 1 + rnd() * 2, col = hex('#8f6a46'); const E = ellipse(r, r * 0.7); cv.stamp(cx, cy, r, (dx, dy) => 1 - smooth(0.8, 1.1, E(dx, dy)), () => col); }
    return cv;
  },
};
export const NAMES = Object.keys(MAKERS);

/** Draw one texture → {width, height, rgba}. */
export function draw(name, size = 1024) {
  const cv = MAKERS[name](size);
  return { width: size, height: size, rgba: cv.rgba() };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const a = process.argv.slice(2), arg = k => { const i = a.indexOf(k); return i >= 0 ? a[i + 1] : null; };
  const out = resolve(arg('--out') ?? 'terrain-textures'), size = Number(arg('--size') ?? 1024);
  const only = arg('--only')?.split(',') ?? NAMES;
  mkdirSync(out, { recursive: true });
  const made = [];
  for (const n of only) { const t = draw(n, size); writeFileSync(join(out, `${n}.png`), png(t.width, t.height, t.rgba)); made.push({ n, t }); console.log(`${n}.png ${size}×${size}`); }
  const sheet = arg('--sheet');
  if (sheet) {
    // each texture 2 × 2 at half size, side by side: the seams would show where the copies meet
    const h = size / 2, W = h * 2 * made.length, H = h * 2, px = new Uint8Array(W * H * 4);
    made.forEach(({ t }, m) => { for (let y = 0; y < H; y++) for (let x = 0; x < h * 2; x++) { const sx = ((x * 2) % size), sy = ((y * 2) % size), s = (sy * size + sx) * 4, d = (y * W + m * h * 2 + x) * 4; px.set(t.rgba.subarray(s, s + 4), d); } });
    writeFileSync(resolve(sheet), png(W, H, px));
    console.log(`sheet ${sheet}`);
  }
}
