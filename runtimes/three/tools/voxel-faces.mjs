#!/usr/bin/env node
// The voxel world's own block faces (library pack xk-voxel-blocks, CC0): pixel art drawn by code, 32 × 32 texels each,
// written as 512 × 512 PNGs (every texel a 16 × 16 square, so the world lint's face size holds and nothing is
// resampled). Deterministic: the same file every run, so the pack's sha256s say whether the art changed.
//
//   node runtimes/three/tools/voxel-faces.mjs --out <dir> [--size 32] [--scale 16] [--sheet sheet.png] [--only stone,dirt]
//
// Conventions the world reads (worlds/voxel/world.js): a solid face's texels with alpha 128 take the biome's colour
// (the grass top, the grass lip on the side; drawn grey so the colour multiplies cleanly); a cutout or plant face is
// see-through where alpha is 0 and takes its block's tint over every other texel.
import { writeFileSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { deflateSync } from 'node:zlib';
import { mulberry32 } from '../../../worlds/voxel/noise.mjs';

// ---------- PNG ----------
const CRC = new Int32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c; });
const crc32 = b => { let c = -1; for (const x of b) c = CRC[(c ^ x) & 255] ^ (c >>> 8); return (c ^ -1) >>> 0; };
const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]); const c = Buffer.alloc(4); c.writeUInt32BE(crc32(td)); return Buffer.concat([len, td, c]); };
export function png(w, h, rgba) {
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) { raw[y * (w * 4 + 1)] = 1; for (let x = 0; x < w * 4; x++) raw[y * (w * 4 + 1) + 1 + x] = (rgba[y * w * 4 + x] - (x >= 4 ? rgba[y * w * 4 + x - 4] : 0)) & 255; }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}
const upscale = (S, k, px) => { const W = S * k, out = new Uint8Array(W * W * 4); for (let y = 0; y < W; y++) for (let x = 0; x < W; x++) { const s = (((y / k) | 0) * S + ((x / k) | 0)) * 4, d = (y * W + x) * 4; out[d] = px[s]; out[d + 1] = px[s + 1]; out[d + 2] = px[s + 2]; out[d + 3] = px[s + 3]; } return out; };

// ---------- drawing ----------
const hex = h => { const n = parseInt(h.replace('#', ''), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; };
const clamp = (v, a = 0, b = 1) => (v < a ? a : v > b ? b : v);
const shade = (c, k) => c.map(v => Math.max(0, Math.min(255, Math.round(v * k))));
const mix = (a, b, t) => a.map((v, i) => Math.round(v + (b[i] - v) * t));

class Face {
  constructor(S, seed) { this.S = S; this.px = new Uint8Array(S * S * 4); this.rnd = mulberry32(seed); this.seed = seed; }
  set(x, y, c, a = 255) { const S = this.S; x = ((x % S) + S) % S; y = ((y % S) + S) % S; const i = (y * S + x) * 4; this.px[i] = c[0]; this.px[i + 1] = c[1]; this.px[i + 2] = c[2]; this.px[i + 3] = a; }
  get(x, y) { const S = this.S; x = ((x % S) + S) % S; y = ((y % S) + S) % S; const i = (y * S + x) * 4; return [this.px[i], this.px[i + 1], this.px[i + 2], this.px[i + 3]]; }
  alpha(x, y) { return this.get(x, y)[3]; }
  each(fn) { for (let y = 0; y < this.S; y++) for (let x = 0; x < this.S; x++) fn(x, y); }
  // tileable value noise with period p (texels per lattice cell = S / p)
  noise(p, salt = 0) {
    const S = this.S, g = new Float32Array(p * p), r = mulberry32(this.seed * 131 + salt * 977 + p);
    for (let i = 0; i < g.length; i++) g[i] = r();
    const f = new Float32Array(S * S), cs = S / p, sm = t => t * t * (3 - 2 * t);
    for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
      const fx = x / cs, fy = y / cs, i = Math.floor(fx), j = Math.floor(fy), u = sm(fx - i), v = sm(fy - j);
      const at = (a, b) => g[((b % p) + p) % p * p + ((a % p) + p) % p];
      f[y * S + x] = at(i, j) * (1 - u) * (1 - v) + at(i + 1, j) * u * (1 - v) + at(i, j + 1) * (1 - u) * v + at(i + 1, j + 1) * u * v;
    }
    return f;
  }
  // noise fractal: sum of periods
  fbm(periods, salt = 0) { const S = this.S, out = new Float32Array(S * S); let sum = 0; periods.forEach((p, k) => { const n = this.noise(p, salt + k), w = 1 / (k + 1); for (let i = 0; i < out.length; i++) out[i] += n[i] * w; sum += w; }); for (let i = 0; i < out.length; i++) out[i] /= sum; return out; }
  // a value 0-1 → one colour of the ramp (pixel art: no blending), jittered a little so bands break up
  ramp(f, ramp, jitter = 0.18, a = 255) {
    const R = ramp.map(c => (typeof c === 'string' ? hex(c) : c));
    this.each((x, y) => { const v = clamp(f[y * this.S + x] + (this.rnd() - 0.5) * jitter); this.set(x, y, R[Math.min(R.length - 1, Math.floor(v * R.length))], a); });
  }
  // a tileable Voronoi: per texel {d1, d2, id}
  cells(n, jitter = 0.8, salt = 0) {
    const S = this.S, cs = S / n, r = mulberry32(this.seed * 7919 + salt), pts = [];
    for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) pts.push([(i + 0.5 + (r() - 0.5) * jitter) * cs, (j + 0.5 + (r() - 0.5) * jitter) * cs]);
    const out = [];
    for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
      let d1 = 1e9, d2 = 1e9, id = 0;
      for (let k = 0; k < pts.length; k++) for (const ox of [-S, 0, S]) for (const oy of [-S, 0, S]) {
        const d = Math.hypot(x + 0.5 - pts[k][0] - ox, y + 0.5 - pts[k][1] - oy);
        if (d < d1) { d2 = d1; d1 = d; id = k; } else if (d < d2) d2 = d;
      }
      out.push({ d1, d2, id });
    }
    return out;
  }
}

// ---------- the faces ----------
const STONE = ['#5f6063', '#6c6d70', '#7a7b7e', '#86878a', '#939497'];
const DIRT = ['#5a3c26', '#684630', '#765236', '#835d3e', '#906846'];
const GREY = ['#8c8c8c', '#a2a2a2', '#b6b6b6', '#c9c9c9', '#dcdcdc', '#eeeeee'];   // tinted by the biome (alpha 128)

function stone(F, ramp = STONE, salt = 0) {
  const f = F.fbm([4, 8, 16], salt);
  F.ramp(f, ramp, 0.22);
  // small pits and light flecks, scattered (no strokes: a stroke repeats on every block and reads as a glyph)
  for (let k = 0; k < 14; k++) { const x = Math.floor(F.rnd() * F.S), y = Math.floor(F.rnd() * F.S); F.set(x, y, shade(hex(ramp[0]), 0.9)); if (F.rnd() < 0.5) F.set(x + 1, y, shade(hex(ramp[0]), 0.95)); }
  for (let k = 0; k < 10; k++) F.set(Math.floor(F.rnd() * F.S), Math.floor(F.rnd() * F.S), hex(ramp[ramp.length - 1]));
}
function dirt(F) {
  const f = F.fbm([4, 8, 16], 3);
  F.ramp(f, DIRT, 0.3);
  for (let k = 0; k < 14; k++) { const x = Math.floor(F.rnd() * F.S), y = Math.floor(F.rnd() * F.S); F.set(x, y, F.rnd() < 0.5 ? hex('#4a3020') : hex('#9c7a58')); }
}
function grassTop(F) {
  const f = F.fbm([4, 16, 32], 5);
  F.ramp(f, GREY, 0.35, 128);
  // short blades: a light texel with a darker one under it
  for (let k = 0; k < 40; k++) { const x = Math.floor(F.rnd() * F.S), y = Math.floor(F.rnd() * F.S); F.set(x, y, hex(GREY[5]), 128); F.set(x, y + 1, hex(GREY[1]), 128); }
}
function lip(F, colourOf, a, salt = 0) {
  // a jagged band over the top: 3-7 texels deep, hanging in drips
  const S = F.S, n = F.noise(8, salt);
  for (let x = 0; x < S; x++) {
    const depth = 3 + Math.round(n[x] * 3) + (F.rnd() < 0.18 ? 2 : 0);
    for (let y = 0; y < depth; y++) F.set(x, y, colourOf(x, y, depth), a);
    F.set(x, depth, shade(F.get(x, depth).slice(0, 3), 0.8));   // a shadow line under it
  }
}
function wood(F, ramp, { vertical = true, salt = 0 } = {}) {
  const S = F.S, R = ramp.map(hex), n = F.noise(4, salt);
  F.each((x, y) => {
    const a = vertical ? x : y, b = vertical ? y : x;
    const stripe = Math.sin(a * 1.9 + n[(b * S + a) % (S * S)] * 6) * 0.5 + 0.5;
    const v = clamp(stripe * 0.7 + n[y * S + x] * 0.4 + (F.rnd() - 0.5) * 0.15);
    F.set(x, y, R[Math.min(R.length - 1, Math.floor(v * R.length))]);
  });
  // knots and dark grooves
  for (let k = 0; k < 4; k++) { const a = Math.floor(F.rnd() * S); for (let b = 0; b < S; b++) if (F.rnd() < 0.7) { const [x, y] = vertical ? [a, b] : [b, a]; F.set(x, y, shade(R[0], 0.8)); } }
}
function rings(F, bark, ramp) {
  const S = F.S, R = ramp.map(hex), B = hex(bark), c = (S - 1) / 2;
  F.each((x, y) => {
    const edge = Math.min(x, y, S - 1 - x, S - 1 - y);
    if (edge < 2) { F.set(x, y, shade(B, edge ? 1 : 0.8)); return; }
    const d = Math.hypot(x - c, y - c) + (F.rnd() - 0.5) * 0.8;
    F.set(x, y, R[Math.floor(d / 2.2) % 2 ? 0 : Math.min(R.length - 1, 1 + Math.floor(F.rnd() * (R.length - 1)))]);
  });
}
function leaves(F, ramp, holes = 0.22, a = 255) {
  // a dark leafy fill with clustered gaps, then clumps of lighter leaves, each lit from the upper left
  const S = F.S, R = ramp.map(hex), gap = F.fbm([8, 16], 9), tone = F.fbm([4, 8], 10);
  F.each((x, y) => {
    if (gap[y * S + x] < 0.28 + holes * 0.6 && F.rnd() < 0.85) { F.set(x, y, [0, 0, 0], 0); return; }
    F.set(x, y, R[Math.floor(F.rnd() * 2)], a);
  });
  for (let k = 0; k < 34; k++) {
    const cx = Math.floor(F.rnd() * S), cy = Math.floor(F.rnd() * S), r = 1 + Math.floor(F.rnd() * 2.2);
    const t = tone[cy * S + cx];
    for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
      if (Math.abs(dx) + Math.abs(dy) > r + 0.5) continue;
      const lit = -(dx + dy) / (2 * r);
      F.set(cx + dx, cy + dy, R[Math.max(1, Math.min(R.length - 1, Math.round(2 + t * 1.5 + lit * 1.6)))], a);
    }
    F.set(cx + r, cy + 1, R[0], a);
  }
}
function bricks(F, { brick, mortar, rows = 4, cols = 2, rough = 0.12, salt = 0 }) {
  const S = F.S, h = S / rows, w = S / cols, M = hex(mortar), n = F.fbm([8, 16], salt);
  F.each((x, y) => {
    const row = Math.floor(y / h), off = row % 2 ? w / 2 : 0, xx = (x + off) % S, col = Math.floor(xx / w);
    const ly = y % h, lx = xx % w;
    if (ly === h - 1 || lx === w - 1) { F.set(x, y, shade(M, 0.9 + F.rnd() * 0.15)); return; }
    const base = hex(brick[(row * 3 + col * 7 + salt) % brick.length]);
    let k = 0.9 + n[y * S + x] * 0.25 + (F.rnd() - 0.5) * rough;
    if (ly === 0 || lx === 0) k *= 1.12;            // light top-left edge
    if (ly === h - 2 || lx === w - 2) k *= 0.85;    // dark bottom-right edge
    F.set(x, y, shade(base, k));
  });
}
function cobble(F, ramp = STONE, mortar = '#3e3f42', n = 5) {
  const S = F.S, R = ramp.map(hex), cells = F.cells(n, 0.85, 3), noise = F.fbm([8, 16], 11);
  F.each((x, y) => {
    const c = cells[y * S + x], gap = c.d2 - c.d1;
    if (gap < 1.1) { F.set(x, y, shade(hex(mortar), 0.9 + F.rnd() * 0.2)); return; }
    const tone = ((c.id * 2654435761) >>> 0) / 4294967296;
    let v = clamp(tone * 0.6 + noise[y * S + x] * 0.5 - c.d1 / (S / n) * 0.35 + 0.15);
    // light from the upper left: the cell's upper-left rim is brighter
    const up = cells[((y - 1 + S) % S) * S + x], left = cells[y * S + (x - 1 + S) % S];
    if ((up.d2 - up.d1) < 1.1 || (left.d2 - left.d1) < 1.1) v = clamp(v + 0.3);
    const down = cells[((y + 1) % S) * S + x], right = cells[y * S + (x + 1) % S];
    if ((down.d2 - down.d1) < 1.1 || (right.d2 - right.d1) < 1.1) v = clamp(v - 0.3);
    F.set(x, y, R[Math.min(R.length - 1, Math.floor(v * R.length))]);
  });
}
function speckle(F, ramp, specks = [], count = 30, salt = 0) {
  F.ramp(F.fbm([4, 8, 32], salt), ramp, 0.4);
  for (let k = 0; k < count; k++) F.set(Math.floor(F.rnd() * F.S), Math.floor(F.rnd() * F.S), hex(specks[k % specks.length] ?? ramp[0]));
}
function ore(F, colours, blobs = 6, size = 4) {
  // stone with nuggets: each a small lump, light on its upper left, a shadow under it
  stone(F, STONE, 2);
  const C = colours.map(hex);
  for (let k = 0; k < blobs; k++) {
    const x0 = Math.floor(F.rnd() * F.S), y0 = Math.floor(F.rnd() * F.S);
    for (let s = 0; s < size; s++) {
      const x = x0 + Math.floor(F.rnd() * 4) - 1, y = y0 + Math.floor(F.rnd() * 4) - 1;
      F.set(x + 1, y + 2, shade(hex(STONE[0]), 0.7)); F.set(x + 2, y + 1, shade(hex(STONE[0]), 0.7));
      F.set(x, y, C[1]); F.set(x + 1, y, C[0]); F.set(x, y + 1, C[0]); F.set(x + 1, y + 1, C[2]);
    }
  }
}
function cloth(F, colour) {
  const S = F.S, c = hex(colour), n = F.fbm([8, 32], 21);
  F.each((x, y) => { const knit = ((x + (y >> 1)) % 4 < 2 ? 1.04 : 0.96) * ((y % 2) ? 0.98 : 1.02); F.set(x, y, shade(c, knit * (0.9 + n[y * S + x] * 0.2) + (F.rnd() - 0.5) * 0.05)); });
}
// plants: drawn on a clear face, bottom up
function blades(F, ramp, { count = 14, tall = [12, 26], a = 255, spread = 1 } = {}) {
  const S = F.S, R = ramp.map(hex);
  F.each((x, y) => F.set(x, y, [0, 0, 0], 0));
  for (let k = 0; k < count; k++) {
    let x = 3 + Math.floor(F.rnd() * (S - 6)), lean = (F.rnd() - 0.5) * 0.6 * spread;
    const h = tall[0] + Math.floor(F.rnd() * (tall[1] - tall[0])); let fx = x;
    for (let y = S - 1; y > S - 1 - h; y--) {
      const t = (S - 1 - y) / h; fx += lean;
      F.set(Math.round(fx), y, R[Math.min(R.length - 1, Math.floor(t * R.length * 0.9 + F.rnd() * 1.2))], a);
    }
  }
}
function flower(F, petal, centre, { stem = '#3f7a2c', leaf = '#5a9a3a', size = 4 } = {}) {
  const S = F.S, P = hex(petal), C = hex(centre), St = hex(stem), L = hex(leaf), cx = S / 2 | 0, top = 12;
  F.each((x, y) => F.set(x, y, [0, 0, 0], 0));
  for (let y = top; y < S; y++) { F.set(cx, y, St); F.set(cx + 1, y, shade(St, 0.8)); }
  for (let k = 0; k < 6; k++) { F.set(cx - 1 - k, S - 5 - (k >> 1), L); F.set(cx - 1 - k, S - 4 - (k >> 1), shade(L, 0.8)); F.set(cx + 2 + k, S - 10 - (k >> 1), L); F.set(cx + 2 + k, S - 9 - (k >> 1), shade(L, 0.8)); }
  for (let dy = -size; dy <= size; dy++) for (let dx = -size; dx <= size; dx++) {
    const d = Math.abs(dx) + Math.abs(dy);
    if (d <= size + 1 && d > 0 && !(Math.abs(dx) === size && Math.abs(dy) === size)) F.set(cx + dx, top - 2 + dy, shade(P, d > size - 1 ? 0.82 : 1.05));
  }
  for (const [dx, dy] of [[0, 0], [1, 0], [0, -1], [1, -1]]) F.set(cx + dx, top - 2 + dy, dy ? C : shade(C, 0.8));
}
function mushroom(F, cap, spots, stem = '#e8dcc6') {
  const S = F.S, Cp = hex(cap), Sp = spots ? hex(spots) : null, St = hex(stem), cx = S / 2;
  F.each((x, y) => F.set(x, y, [0, 0, 0], 0));
  for (let y = S - 12; y < S; y++) for (let x = cx - 2; x < cx + 2; x++) F.set(x, y, shade(St, x === cx - 2 ? 0.85 : 1));
  for (let y = S - 20; y < S - 11; y++) {
    const w = Math.round(Math.sqrt(Math.max(0, 1 - ((y - (S - 11)) / 9) ** 2)) * 9);
    for (let x = cx - w; x < cx + w; x++) F.set(x, y, shade(Cp, y === S - 12 ? 0.7 : 0.9 + (cx + w - x) / (4 * w)));
  }
  if (Sp) for (const [dx, dy] of [[-5, -16], [2, -18], [4, -14], [-2, -13], [6, -17]]) { F.set(cx + dx, S + dy, Sp); F.set(cx + dx + 1, S + dy, Sp); }
}

export const FACES = {
  'grass-top': grassTop,
  'grass-side': F => { dirt(F); lip(F, (x, y, d) => hex(GREY[Math.min(5, 3 + Math.floor(F.rnd() * 3) - (y > d - 2 ? 1 : 0))]), 128, 1); },
  'snow-grass-side': F => { dirt(F); lip(F, (x, y, d) => hex(['#c6d2e1', '#d1dbe8', '#dbe3ee', '#bac8d9'][Math.floor(F.rnd() * 4) - (y > d - 2 ? 0 : 0)]), 255, 2); },
  dirt,
  stone: F => stone(F),
  bedrock: F => { speckle(F, ['#2a2a2c', '#3a3a3d', '#4b4b4f', '#5c5c60'], ['#1a1a1c', '#6a6a70'], 50, 4); },
  cobble: F => cobble(F),
  'stone-brick': F => bricks(F, { brick: ['#7d7e82', '#86878b', '#77787c'], mortar: '#55565a', rows: 2, cols: 2, rough: 0.2, salt: 1 }),
  brick: F => bricks(F, { brick: ['#84463a', '#8d4c3f', '#7b4035', '#935244'], mortar: '#9e968c', rows: 4, cols: 2, salt: 2 }),
  sand: F => speckle(F, ['#d6c08a', '#dcc791', '#e2ce99', '#e8d5a2', '#eddcab'], ['#c6ad76', '#f4e6bb'], 40, 6),
  seabed: F => speckle(F, ['#7d7a74', '#878480', '#918e88', '#9b9892'], ['#6a6762', '#aaa7a0'], 50, 7),
  gravel: F => cobble(F, ['#6e6a66', '#7c7874', '#8a8682', '#98948f', '#a6a29c'], '#5a5652', 8),
  clay: F => speckle(F, ['#9097a6', '#979eac', '#9ea5b3', '#a5acba'], ['#868d9c'], 16, 8),
  'sandstone-side': F => {
    const S = F.S, R = ['#c9b07a', '#d3ba83', '#dcc48d', '#e3cc96'].map(hex), n = F.fbm([8, 16], 12);
    F.each((x, y) => { const band = y < 6 ? 3 : y > S - 8 ? 0 : Math.floor((y / 5 + n[y * S + x] * 1.5) % 3); F.set(x, y, shade(R[band], 0.94 + (F.rnd() * 0.1))); });
    for (let x = 0; x < S; x++) { F.set(x, 5, shade(R[0], 0.85)); F.set(x, S - 8, shade(R[0], 0.85)); }
  },
  'sandstone-top': F => { speckle(F, ['#d6bd86', '#ddc58f', '#e3cc97'], ['#c8ae78'], 20, 13); F.each((x, y) => { if (Math.min(x, y, F.S - 1 - x, F.S - 1 - y) === 0) F.set(x, y, hex('#c4aa74')); }); },
  log: null,
  'log-side': F => wood(F, ['#3f2c1a', '#4d3621', '#5b4129', '#6a4d31'], { salt: 1 }),
  'log-top': F => rings(F, '#4d3621', ['#8a6a3e', '#a07c4a', '#b08b56', '#bf9a63']),
  'birch-log-side': F => {
    const S = F.S, R = ['#cfc9bb', '#ddd8cc', '#e9e5da', '#f3f0e8'].map(hex), n = F.fbm([4, 16], 14);
    F.each((x, y) => F.set(x, y, R[Math.min(3, Math.floor(clamp(n[y * S + x] + (F.rnd() - 0.5) * 0.3) * 4))]));
    for (let k = 0; k < 9; k++) { const y = Math.floor(F.rnd() * S), x = Math.floor(F.rnd() * S), w = 2 + Math.floor(F.rnd() * 5); for (let i = 0; i < w; i++) F.set(x + i, y, hex(i === 0 || i === w - 1 ? '#5a5650' : '#2e2b28')); }
  },
  'birch-log-top': F => rings(F, '#d8d3c6', ['#b8a07a', '#c9b088', '#d6bf97', '#e0caa4']),
  'spruce-log-side': F => wood(F, ['#2b1e12', '#36261a', '#412f20', '#4b3727'], { salt: 3 }),
  'spruce-log-top': F => rings(F, '#36261a', ['#6e5232', '#7f603c', '#8d6c45', '#9a784e']),
  leaves: F => leaves(F, GREY.slice(0, 5)),
  'birch-leaves': F => leaves(F, ['#4f7a35', '#5f8c3f', '#6f9c49', '#80ab55', '#93bb63'], 0.2),
  'spruce-leaves': F => leaves(F, ['#3a5e40', '#44694a', '#4f7555', '#5b8261', '#68906d'], 0.18),
  planks: F => planks(F, ['#735a38', '#81653f', '#8e7047', '#9b7b50'], 1),
  'red-planks': F => planks(F, ['#7a3a2c', '#874232', '#944b39', '#a15541'], 2),
  glass: F => {
    const S = F.S;
    F.each((x, y) => {
      const e = Math.min(x, y, S - 1 - x, S - 1 - y);
      if (e === 0) F.set(x, y, hex('#e4f2f6'), 235);
      else if (e === 1) F.set(x, y, hex('#b7d3db'), 170);
      else F.set(x, y, hex('#d8eef4'), 40);
    });
    for (let k = 0; k < 7; k++) { F.set(6 + k, 5 + k, hex('#ffffff'), 200); F.set(7 + k, 5 + k, hex('#ffffff'), 140); }
    for (let k = 0; k < 4; k++) F.set(20 + k, 22 + k, hex('#ffffff'), 160);
  },
  water: F => {
    // a still surface: soft ripples in blues (the world draws water with the look's water material; this is its icon)
    F.ramp(F.fbm([2, 4, 8], 18), ['#2a5fb0', '#3169bd', '#3a74c8', '#4580d2', '#5590dc'], 0.08);
    for (let k = 0; k < 8; k++) { const x = Math.floor(F.rnd() * F.S), y = Math.floor(F.rnd() * F.S); for (let i = 0; i < 4; i++) F.set(x + i, y, hex('#7fb0ea')); }
  },
  ice: F => {
    F.ramp(F.fbm([4, 8], 15), ['#8fb8e6', '#9cc3ec', '#a9cdf1', '#b6d7f5', '#c4e0f8'], 0.1);
    for (let k = 0; k < 6; k++) { let x = Math.floor(F.rnd() * F.S), y = Math.floor(F.rnd() * F.S); for (let s = 0; s < 8; s++) { F.set(x, y, hex('#e6f3ff')); x++; y += F.rnd() < 0.4 ? 1 : 0; } }
  },
  snow: F => {
    // drifts: soft blue-grey hollows between white ridges, a few sparkles
    F.ramp(F.fbm([2, 4, 8], 16), ['#aebdd0', '#bac8d9', '#c6d2e1', '#d1dbe8', '#dbe3ee', '#e5ebf3'], 0.12);
    for (let k = 0; k < 10; k++) F.set(Math.floor(F.rnd() * F.S), Math.floor(F.rnd() * F.S), hex('#f2f5f9'));
  },
  'cloth-blue': F => cloth(F, '#3a63c8'),
  'cloth-green': F => cloth(F, '#3c9a46'),
  'cloth-red': F => cloth(F, '#c23a33'),
  'cloth-tan': F => cloth(F, '#c9ae80'),
  lamp: F => {
    const S = F.S;
    F.each((x, y) => {
      const e = Math.min(x, y, S - 1 - x, S - 1 - y), c = (S - 1) / 2, d = Math.hypot(x - c, y - c) / c;
      if (e < 2) F.set(x, y, hex(e ? '#7a5a2a' : '#5a3f1c'));
      else if ((x - 2) % 10 === 9 || (y - 2) % 10 === 9) F.set(x, y, hex('#8a6a34'));
      else F.set(x, y, mix(hex('#fff4c8'), hex('#f0a640'), clamp(d * 0.9 + (F.rnd() - 0.5) * 0.15)));
    });
  },
  lantern: F => {
    const S = F.S;
    F.each((x, y) => {
      const e = Math.min(x, y, S - 1 - x, S - 1 - y), bar = x % 8 === 0 || y % 8 === 0;
      if (e < 2 || bar) F.set(x, y, hex(e === 0 ? '#2a2a30' : '#45454d'));
      else F.set(x, y, mix(hex('#ffd890'), hex('#ff8a2a'), clamp(((x % 8) - 4) ** 2 / 20 + ((y % 8) - 4) ** 2 / 20 + (F.rnd() - 0.5) * 0.2)));
    });
  },
  'boom-side': F => {
    const S = F.S;
    F.each((x, y) => {
      if (y >= 11 && y <= 20) { F.set(x, y, shade(hex('#eae4d6'), 0.95 + F.rnd() * 0.08)); return; }
      F.set(x, y, shade(hex(x % 8 === 0 ? '#8e241e' : '#c4382e'), 0.92 + F.rnd() * 0.1));
    });
    // a dark burst mark on the band
    for (const [x, y] of [[13, 14], [14, 13], [15, 15], [16, 14], [17, 16], [18, 13], [15, 17], [17, 18], [14, 16], [16, 16]]) F.set(x, y, hex('#2e2a28'));
  },
  'boom-top': F => {
    const S = F.S;
    F.each((x, y) => F.set(x, y, shade(hex('#c4382e'), 0.9 + F.rnd() * 0.12)));
    for (let y = 11; y < 21; y++) for (let x = 11; x < 21; x++) F.set(x, y, hex(Math.hypot(x - 15.5, y - 15.5) < 3 ? '#2e2a28' : '#d8d0c0'));
    for (let k = 0; k < 4; k++) F.set(15 + (k % 2), 13 + k, hex('#6a5a40'));
  },
  'coal-ore': F => ore(F, ['#26262b', '#45454c', '#141417'], 6, 3),
  'iron-ore': F => ore(F, ['#d29a72', '#ecc4a0', '#a8714c'], 6, 3),
  'gold-ore': F => ore(F, ['#f2c832', '#fff0a0', '#c79318'], 5, 3),
  crystal: F => {
    const S = F.S, cells = F.cells(3, 0.9, 17);
    F.each((x, y) => {
      const c = cells[y * S + x], g = c.d2 - c.d1;
      if (g < 1.2) { F.set(x, y, hex('#4a2410')); return; }
      const facet = ((c.id * 2654435761) >>> 0) / 4294967296, lit = (x - y) / S;
      F.set(x, y, mix(hex('#e0761c'), hex('#ffe2a0'), clamp(facet * 0.6 + lit * 0.4 + 0.2 + (F.rnd() - 0.5) * 0.12)));
    });
  },
  'cactus-side': F => {
    const S = F.S, R = ['#2e6a2a', '#357833', '#3d863b', '#469444'].map(hex);
    F.each((x, y) => F.set(x, y, R[(x % 8 < 2 ? 0 : x % 8 < 4 ? 2 : x % 8 < 6 ? 3 : 1)]));
    for (let k = 0; k < 18; k++) { const x = 1 + 8 * Math.floor(F.rnd() * 4), y = Math.floor(F.rnd() * S); F.set(x, y, hex('#e6e0b8')); F.set(x - 1, y, hex('#1d4a1a')); }
  },
  'cactus-top': F => { const S = F.S; F.each((x, y) => { const e = Math.min(x, y, S - 1 - x, S - 1 - y); F.set(x, y, hex(e < 2 ? '#2e6a2a' : e % 4 === 0 ? '#3d863b' : '#57a352')); }); },
  'tuft-a': F => blades(F, GREY, { count: 30, tall: [8, 24], a: 255 }),
  'tuft-b': F => blades(F, GREY, { count: 10, tall: [6, 14], a: 255, spread: 3 }),
  'tuft-c': F => blades(F, ['#5c6e30', '#6f8238', '#839642', '#a6a85a'], { count: 8, tall: [20, 31], spread: 0.3 }),
  'tuft-d': F => { blades(F, ['#2f5a24', '#3b6c2c', '#477e34'], { count: 22, tall: [8, 16], spread: 2.5 }); for (const [x, y] of [[9, 22], [14, 19], [20, 21], [24, 24], [12, 25]]) { F.set(x, y, hex('#c0283a')); F.set(x + 1, y, hex('#e04a5a')); } },
  fern: F => {
    const S = F.S, R = GREY.slice(0, 5).map(hex);
    F.each((x, y) => F.set(x, y, [0, 0, 0], 0));
    for (const [x0, lean] of [[10, -0.35], [16, 0], [22, 0.35], [13, -0.15], [19, 0.18]]) {
      let x = x0;
      for (let y = S - 1; y > 6; y--) { x += lean * 0.5; F.set(Math.round(x), y, R[1]); if (y % 3 === 0) { F.set(Math.round(x) - 1, y, R[3]); F.set(Math.round(x) + 1, y - 1, R[4]); F.set(Math.round(x) - 2, y + 1, R[2]); F.set(Math.round(x) + 2, y, R[2]); } }
    }
  },
  'dead-bush': F => {
    const S = F.S, C = hex('#7a5a34'), D = hex('#5c4224');
    F.each((x, y) => F.set(x, y, [0, 0, 0], 0));
    const branch = (x, y, dx, n) => { for (let i = 0; i < n; i++) { F.set(Math.round(x), y, i % 3 ? C : D); x += dx; y--; if (i > 3 && F.rnd() < 0.18) branch(x, y, -dx * 0.8, n - i - 1); } };
    branch(16, S - 1, -0.6, 16); branch(16, S - 1, 0.5, 18); branch(16, S - 1, 0.05, 14);
  },
  'flower-red': F => flower(F, '#d8302e', '#f5c242'),
  'flower-yellow': F => flower(F, '#f4cf2c', '#e08a1a', { size: 3 }),
  'flower-blue': F => flower(F, '#4a7ce8', '#f8f0d0'),
  'flower-white': F => flower(F, '#f4f2ec', '#f2c43a'),
  'mushroom-red': F => mushroom(F, '#c8302a', '#f8f0e0'),
  'mushroom-brown': F => mushroom(F, '#8a5a38', null),
  'mushroom-tan': F => mushroom(F, '#d4b07a', '#f0e2c4'),
  'amber-shard': F => {
    // a cluster of crystal spikes, lit on one side: the shards that grow beside an amber vein
    const S = F.S;
    F.each((x, y) => F.set(x, y, [0, 0, 0], 0));
    for (const [cx, h, w, lean] of [[16, 26, 4, 0], [9, 17, 3, -0.25], [23, 19, 3, 0.3], [12, 11, 2, -0.5], [21, 12, 2, 0.45]]) {
      for (let k = 0; k < h; k++) {
        const y = S - 1 - k, half = Math.max(0, Math.round(w * (1 - k / h))), mid = cx + lean * k;
        for (let dx = -half; dx <= half; dx++) F.set(Math.round(mid + dx), y, mix(hex('#c85a10'), hex('#fff0c0'), clamp(0.35 + (dx / (w + 1)) * 0.5 + (k / h) * 0.35)));
      }
    }
  },
  glowcap: F => {
    const S = F.S;
    F.each((x, y) => F.set(x, y, [0, 0, 0], 0));
    for (const [cx, h, w] of [[10, 12, 4], [20, 17, 5], [15, 8, 3]]) {
      for (let y = S - h; y < S; y++) F.set(cx, y, hex('#b8e8f4'));
      for (let y = S - h - 3; y < S - h + 1; y++) for (let x = cx - w; x <= cx + w; x++) if (Math.abs(x - cx) <= w - (S - h + 1 - y) % 2) F.set(x, y, mix(hex('#4fd0ff'), hex('#e0faff'), clamp(1 - Math.abs(x - cx) / w)));
    }
  },
};
delete FACES.log;

function planks(F, ramp, salt) {
  const S = F.S, R = ramp.map(hex), rows = 4, h = S / rows, n = F.noise(8, salt);
  F.each((x, y) => {
    const row = Math.floor(y / h), ly = y % h, end = (x + row * 13) % S;
    if (ly === h - 1) { F.set(x, y, shade(R[0], 0.7)); return; }
    if (end === 0) { F.set(x, y, shade(R[0], 0.75)); return; }
    const grain = Math.sin((x + row * 7) * 0.45 + n[y * S + x] * 5 + ly * 0.3) * 0.5 + 0.5;
    let v = clamp(grain * 0.55 + n[y * S + x] * 0.35 + (row % 2) * 0.1 + (F.rnd() - 0.5) * 0.12);
    if (ly === 0) v = clamp(v + 0.25);
    F.set(x, y, R[Math.min(R.length - 1, Math.floor(v * R.length))]);
  });
  for (let r = 0; r < rows; r++) for (const x of [(r * 13 + 2) % S, (r * 13 + S - 3) % S]) F.set(x, r * h + 3, shade(R[0], 0.55));
}

/** Draw one face → { S, px (RGBA, S × S) }. */
export function drawFace(name, S = 32) {
  const fn = FACES[name];
  if (!fn) throw new Error(`no face "${name}"`);
  let seed = 7; for (const c of name) seed = Math.imul(seed ^ c.charCodeAt(0), 16777619) >>> 0;
  const F = new Face(S, seed);
  fn(F);
  return { S, px: F.px };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const argv = process.argv.slice(2), opt = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
  const out = resolve(opt('--out', 'faces')), S = Number(opt('--size', 32)), k = Number(opt('--scale', 16));
  const only = opt('--only', null)?.split(',') ?? Object.keys(FACES);
  mkdirSync(out, { recursive: true });
  for (const name of only) { const { px } = drawFace(name, S); writeFileSync(join(out, `${name}.png`), png(S * k, S * k, upscale(S, k, px))); }
  const sheet = opt('--sheet', null);
  if (sheet) {
    // every face at 4× on a checker (see-through texels show), 8 to a row
    const cols = 8, z = 4, cell = S * z + 8, rows = Math.ceil(only.length / cols), W = cols * cell, Hh = rows * cell, img = new Uint8Array(W * Hh * 4);
    for (let y = 0; y < Hh; y++) for (let x = 0; x < W; x++) { const c = ((x >> 3) + (y >> 3)) % 2 ? 60 : 80, i = (y * W + x) * 4; img[i] = img[i + 1] = img[i + 2] = c; img[i + 3] = 255; }
    only.forEach((name, n) => {
      const { px } = drawFace(name, S), ox = (n % cols) * cell + 4, oy = Math.floor(n / cols) * cell + 4;
      for (let y = 0; y < S * z; y++) for (let x = 0; x < S * z; x++) {
        const s = (((y / z) | 0) * S + ((x / z) | 0)) * 4, d = ((oy + y) * W + ox + x) * 4, a = px[s + 3] / 255;
        for (let c = 0; c < 3; c++) img[d + c] = Math.round(px[s + c] * a + img[d + c] * (1 - a));
      }
    });
    writeFileSync(resolve(sheet), png(W, Hh, img));
  }
  console.log(`${only.length} faces → ${out}`);
}
