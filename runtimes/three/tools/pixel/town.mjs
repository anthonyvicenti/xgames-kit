#!/usr/bin/env node
// town.mjs: the pixel kind's ground, dressing, props and set pieces, for a cosy town seen from above (and the ground of
// a stage seen from the side). Everything is drawn here from code at 16 texels a metre with light from the top left, a
// one-texel outline in the deep shade of what it edges, hard alpha and at most 32 colours a picture: the tile kinds of
// a flat game (grass, path, water, wall, soil, cobble; ground, brick, ledge side-on), their edge sets (drawplan.js:
// "blend" borders, "connect" fences and walls), dressing strips (tufts, flowers, pebbles; crops), pickups, props
// (trees, bushes, rocks, barrels, a well, a lamp…) and set pieces (houses, a shop, a shed). Generated, no third-party
// art, CC0.
//
//   node runtimes/three/tools/pixel/town.mjs [--out <dir>, default .cache/pixel-town] [--only <id,id>] [--list]
//   node runtimes/three/tools/pixel/town.mjs --standins     the whole set as the flat runtime's pixel stand-ins
//                                                          (builder/tools/lib/standin-assets/flat/pixel/<id>.png)
//
// Every picture is judged by the flat runtime's own judge (tile, edges, dress, prop) before it is written; one that
// fails is not written and the tool exits 1. PICTURES below lists each with what it is and how it is judged.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { rgb, hex, mix, noise, rng, bayer, colourCount } from './paint.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '../../../..');
const { encodePng } = await import(pathToFileURL(join(REPO, 'builder/art/png.mjs')).href);
const { importLayer } = await import(pathToFileURL(join(REPO, 'builder/tools/lib/kit-import.mjs')).href);
const { repoFileOf } = await import(pathToFileURL(join(REPO, 'builder/tools/lib/paths.mjs')).href);
const { judge } = await importLayer(repoFileOf('gf/three/flat/judge.js'));

const T = 16;       // a tile, 1 m

// ------------------------------------------------------------------------------------------------ a picture
/** An RGBA picture painted in colours; null is see-through. */
export class Pic {
  constructor(w, h) { this.w = w; this.h = h; this.c = new Array(w * h).fill(null); }
  get(x, y) { return x < 0 || y < 0 || x >= this.w || y >= this.h ? null : this.c[y * this.w + x]; }
  set(x, y, col) { if (x >= 0 && y >= 0 && x < this.w && y < this.h && col !== undefined) this.c[y * this.w + x] = col; return this; }
  rect(x0, y0, w, h, col) { for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) this.set(x, y, typeof col === 'function' ? col(x, y) : col); return this; }
  each(f) { for (let y = 0; y < this.h; y++) for (let x = 0; x < this.w; x++) { const v = f(x, y, this.get(x, y)); if (v !== undefined) this.set(x, y, v); } return this; }
  over(o, dx = 0, dy = 0) { for (let y = 0; y < o.h; y++) for (let x = 0; x < o.w; x++) { const v = o.get(x, y); if (v) this.set(x + dx, y + dy, v); } return this; }
  /** The one-texel outline: a see-through texel beside a drawn one takes the deep shade of the colour it touches (the
   *  one below first, so a thing's own base edges it). only(x, y): where an outline may go (an edge that joins a
   *  neighbour has none). */
  outline({ deep = 0.62, only = null } = {}) {
    const out = [];
    for (let y = 0; y < this.h; y++) for (let x = 0; x < this.w; x++) {
      if (this.get(x, y) || (only && !only(x, y))) continue;
      const n = [this.get(x, y + 1), this.get(x, y - 1), this.get(x - 1, y), this.get(x + 1, y)].filter(Boolean);
      if (n.length) out.push([x, y, lineOf(n[0], deep)]);
    }
    for (const [x, y, c] of out) this.set(x, y, c);
    return this;
  }
  /** At most `max` colours: the two nearest (weighted by how much each is used) merge into the commoner until it fits. */
  limit(max = 32) {
    const count = new Map();
    for (const v of this.c) if (v) count.set(v, (count.get(v) ?? 0) + 1);
    const to = new Map([...count.keys()].map(k => [k, k]));
    const live = new Map(count), d = (a, b) => { const A = rgb(a), B = rgb(b); return (A[0] - B[0]) ** 2 * 0.3 + (A[1] - B[1]) ** 2 * 0.59 + (A[2] - B[2]) ** 2 * 0.11; };
    while (live.size > max) {
      let best = null;
      const ks = [...live.keys()];
      for (let i = 0; i < ks.length; i++) for (let j = i + 1; j < ks.length; j++) { const cost = d(ks[i], ks[j]) * Math.min(live.get(ks[i]), live.get(ks[j])); if (!best || cost < best[2]) best = [ks[i], ks[j], cost]; }
      const [a, b] = best, keep = live.get(a) >= live.get(b) ? a : b, drop = keep === a ? b : a;
      live.set(keep, live.get(a) + live.get(b)); live.delete(drop);
      for (const [k, v] of to) if (v === drop) to.set(k, keep);
    }
    this.c = this.c.map(v => (v ? to.get(v) : v));
    return this;
  }
  rgba() {
    const d = Buffer.alloc(this.w * this.h * 4);
    this.c.forEach((v, i) => { if (!v) return; const [r, g, b] = rgb(v); d[i * 4] = r; d[i * 4 + 1] = g; d[i * 4 + 2] = b; d[i * 4 + 3] = 255; });
    return { width: this.w, height: this.h, data: d };
  }
}
/** The line colour of a colour: much darker, toward a deep purple-brown. */
export const lineOf = (c, deep = 0.62) => mix(c, '#24162e', deep);

/** A ramp picker: v in [0, 1] → one of the colours, dithered (bayer) at the steps when `dither`. */
const pick = (cols, v, x = 0, y = 0, dither = 0) => { const k = Math.max(0, Math.min(cols.length - 1, v * cols.length + (dither ? (bayer(x, y) - 0.5) * dither : 0))); return cols[Math.floor(k)]; };

// ------------------------------------------------------------------------------------------------ palettes
const P = {
  grass: ['#3f7f3c', '#4f9443', '#5fa44a', '#78b956', '#94cc63'],
  path: ['#8a6038', '#a8784a', '#c2935e', '#d6ad78', '#e6c595'],
  soil: ['#4e2f1e', '#62402a', '#7a5134', '#93673f'],
  water: ['#2b5d9e', '#3474b8', '#3f8ccc', '#62acdf', '#a6d8f2', '#e4f6ff'],
  sand: ['#b89766', '#d4b884', '#e8d3a2'],
  stone: ['#5e5866', '#7a7484', '#968f9c', '#b3acb5', '#cfc9cd'],
  cobble: ['#6a6470', '#857e88', '#a19aa2', '#bbb3b6', '#d2cbc9'],
  wood: ['#5a3620', '#7a4a2a', '#9a6236', '#b97c45', '#d39a5c'],
  leaf: ['#26522f', '#336b34', '#468a3c', '#5ca546', '#7ec152', '#a6d867'],
  pine: ['#1d4035', '#25553f', '#2f6d48', '#3f8752', '#5aa45e'],
  bark: ['#4a2e22', '#64402c', '#7e5436', '#9a6b44'],
  rock: ['#565260', '#6f6a78', '#8c8794', '#a9a4ae', '#c8c4c8'],
  roofRed: ['#6e2a2a', '#8e3a32', '#b04c3c', '#cc6748', '#e08a5e'],
  roofBlue: ['#2c3768', '#3a4b86', '#4c62a2', '#6680bc', '#8ea4d4'],
  roofGreen: ['#24503e', '#2f6a4c', '#3c855a', '#57a26a', '#80c084'],
  plaster: ['#a48c78', '#c2ac94', '#dacab2', '#ece0c8'],
  plank: ['#6a4428', '#8a5a34', '#a8723f', '#c48c52'],
  brick: ['#6e3426', '#8c4430', '#a85a3e', '#c47652', '#d8b49a'],
  glass: ['#2c4a6e', '#4a78a4', '#7fb4d8', '#cfeaf6'],
  gold: ['#8a5a14', '#c08a1c', '#e8b828', '#ffe066', '#fff6c0'],
};

// ------------------------------------------------------------------------------------------------ ground tiles
const nGrass = noise(11, 16), nGrass2 = noise(12, 16), nPath = noise(21, 16), nPath2 = noise(22, 16), nWater = noise(31, 16), nStone = noise(41, 16);
/** Grass: a calm mid green with soft patches and a few blades, seamless. */
const grassAt = (x, y) => {
  const v = nGrass(x, y, 8) * 0.6 + nGrass2(x, y, 4) * 0.4;
  let c = P.grass[v > 0.62 ? 3 : v < 0.36 ? 1 : 2];
  // short blades: a light tip over a dark root, scattered so the tile never shows a grid
  const BLADES = [[2, 3], [9, 1], [13, 6], [5, 9], [11, 12], [1, 13], [7, 14], [14, 10], [4, 5]];
  for (const [bx, by] of BLADES) { if (x === bx && y === by) return P.grass[3]; if (x === bx && y === (by + 1) % 16) return P.grass[1]; }
  return c;
};
function grassTile() { return new Pic(T, T).each((x, y) => grassAt(x, y)); }
/** Dirt: a sandy brown with grit and the odd pebble. */
const pathAt = (x, y) => {
  const v = nPath(x, y, 8) * 0.55 + nPath2(x, y, 4) * 0.45;
  let c = P.path[v > 0.6 ? 3 : v < 0.38 ? 1 : 2];
  const g = (x * 5 + y * 11) % 23;
  if (g === 2) c = P.path[4]; else if (g === 9) c = P.path[1];
  if ((x === 4 && y === 11) || (x === 12 && y === 3)) c = P.path[0];
  if ((x === 5 && y === 11) || (x === 13 && y === 3)) c = P.path[4];
  return c;
};
function pathTile() { return new Pic(T, T).each((x, y) => pathAt(x, y)); }
/** Tilled soil: dark furrows across, a lighter ridge on each. */
const soilAt = (x, y) => { const k = y % 4; return k === 0 ? P.soil[3] : k === 1 ? P.soil[2] : k === 2 ? P.soil[1] : ((x + y) % 5 ? P.soil[0] : P.soil[1]); };
function soilTile() { return new Pic(T, T).each((x, y) => soilAt(x, y)); }
/** Water: a blue with short light ripples. */
const waterAt = (x, y) => {
  const v = nWater(x, y, 8);
  let c = P.water[v > 0.6 ? 3 : v < 0.35 ? 1 : 2];
  const r = (x + y * 5) % 16;
  if (y % 4 === 1 && r >= 2 && r <= 4) c = P.water[4];
  if (y % 4 === 2 && r >= 3 && r <= 4) c = P.water[3];
  return c;
};
function waterTile() { return new Pic(T, T).each((x, y) => waterAt(x, y)); }
/** Cobbles: rounded stones with dark joints. */
const cobbleAt = (x, y) => {
  const row = Math.floor(y / 4), ox = row % 2 ? 2 : 0, cx = ((x + ox) % 4 + 4) % 4, cy = y % 4;
  if (cy === 3 || cx === 3) return P.cobble[0];
  const v = nStone(Math.floor((x + ox) / 4), row, 1);
  const base = v > 0.55 ? 3 : v < 0.35 ? 1 : 2;
  return cy === 0 && cx === 0 ? P.cobble[Math.min(4, base + 1)] : cy === 2 && cx === 2 ? P.cobble[Math.max(1, base - 1)] : P.cobble[base];
};
function cobbleTile() { return new Pic(T, T).each((x, y) => cobbleAt(x, y)); }
/** A stone wall's top, seen from above. */
const stoneTopAt = (x, y) => { const row = Math.floor(y / 4), ox = row % 2 ? 3 : 0, cx = ((x + ox) % 6 + 6) % 6; if (y % 4 === 3 || cx === 5) return P.stone[1]; return y % 4 === 0 ? P.stone[4] : P.stone[3]; };

// side-on: grass on dirt, bricks, a wooden ledge
function groundSide() {
  const p = new Pic(T * 2, T);
  const dirt = (x, y) => { const v = nPath(x, y + 3, 8); let c = P.wood[v > 0.6 ? 2 : v < 0.35 ? 0 : 1]; const g = (x * 7 + y * 3) % 19; if (g === 4) c = P.rock[2]; if (g === 5) c = P.rock[3]; return mix(c, P.path[1], 0.35); };
  p.each((x, y) => dirt(x % T, y));
  // the cap: a thick grass lip with blades hanging over the dirt
  for (let x = 0; x < T; x++) {
    const hang = 4 + ((x * 5) % 3 === 0 ? 2 : (x * 3) % 4 === 1 ? 1 : 0);
    for (let y = 0; y < hang; y++) p.set(x, y, y === 0 ? P.grass[4] : y === 1 ? P.grass[3] : y < hang - 1 ? P.grass[2] : P.grass[0]);
    p.set(x, hang, mix(P.wood[0], '#24162e', 0.3));
  }
  return p;
}
function brickSide() {
  return new Pic(T, T).each((x, y) => {
    const row = Math.floor(y / 4), ox = row % 2 ? 4 : 0, cx = (x + ox) % 8;
    if (y % 4 === 3 || cx === 7) return P.brick[0];
    if (y % 4 === 0) return P.brick[3];
    return (cx + row) % 5 === 0 ? P.brick[1] : P.brick[2];
  });
}
function ledgeSide() {
  // a thick plank: a lit top edge, grain, a nail at each joint, a dark underside
  const p = new Pic(T, T), W = P.wood;
  p.rect(0, 0, T, 1, W[4]);
  p.rect(0, 1, T, 4, (x, y) => (x === 15 ? W[1] : (x * 3 + y * 5) % 11 === 0 ? W[1] : y === 1 ? W[3] : W[2]));
  p.set(2, 2, '#c8c4d0'); p.set(13, 3, '#c8c4d0');
  p.rect(0, 5, T, 1, W[0]);
  return p;
}
function wallFlat() { return new Pic(T * 2, T).each((x, y) => (x < T ? (y < 2 ? P.stone[4] : stoneTopAt(x, y)) : stoneTopAt(x - T, y))); }

// ------------------------------------------------------------------------------------------------ edge sets
// blend (drawplan.js): a 16 x 16 picture centred on a corner where four cells meet; bits top left 1, top right 2,
// bottom left 4, bottom right 8 say which are the kind. The border is where the bilinear mix of the four bits crosses
// one half, wobbled by a noise that repeats every tile, so neighbouring pictures meet texel for texel.
function blendSet({ inside, rim, rimTop = null, lip = null, lipWidth = 1, wobble = 0.32, seed = 5 }) {
  const P4 = new Pic(T * 4, T * 4), nz = noise(seed, 16);
  for (let m = 0; m < 16; m++) {
    const bit = [(m & 1) ? 1 : 0, (m & 2) ? 1 : 0, (m & 4) ? 1 : 0, (m & 8) ? 1 : 0];
    const field = (x, y) => {
      const tx = Math.max(0, Math.min(1, (x + 0.5 - 4) / 8)), ty = Math.max(0, Math.min(1, (y + 0.5 - 4) / 8));
      const v = (bit[0] * (1 - tx) + bit[1] * tx) * (1 - ty) + (bit[2] * (1 - tx) + bit[3] * tx) * ty;
      if (m === 15 || m === 0) return v;
      return v + (nz(((x % 16) + 16) % 16, ((y % 16) + 16) % 16, 4) - 0.5) * wobble;
    };
    const isIn = (x, y) => field(x, y) > 0.5;
    const ox = (m % 4) * T, oy = Math.floor(m / 4) * T;
    for (let y = 0; y < T; y++) for (let x = 0; x < T; x++) {
      let c = null;
      if (isIn(x, y)) {
        const edge = !isIn(x - 1, y) || !isIn(x + 1, y) || !isIn(x, y + 1) || !isIn(x, y - 1);
        const top = !isIn(x, y - 1) || !isIn(x, y - 2);
        c = edge ? rim(x, y) : rimTop && top ? rimTop(x, y) : inside(x, y);
      } else if (lip) {
        let near = false;
        for (let d = 1; d <= lipWidth && !near; d++) near = isIn(x - d, y) || isIn(x + d, y) || isIn(x, y + d) || isIn(x, y - d);
        if (near) c = lip(x, y);
      }
      if (c) P4.set(ox + x, oy + y, c);
    }
  }
  return P4;
}

// connect (drawplan.js): a cell's own 16, bits north 1, east 2, south 4, west 8 for the same kind beside it
function connectSet(draw) {
  const P4 = new Pic(T * 4, T * 4);
  for (let m = 0; m < 16; m++) { const c = draw({ n: !!(m & 1), e: !!(m & 2), s: !!(m & 4), w: !!(m & 8) }); P4.over(c, (m % 4) * T, Math.floor(m / 4) * T); }
  return P4;
}
/** A wooden fence seen from above and in front: a post in the middle, two rails to each joined side. */
function fenceCell({ n, e, s, w }) {
  const p = new Pic(T, T), W = P.wood;
  const rail = (x0, x1) => { p.rect(x0, 6, x1 - x0, 2, (x, y) => (y === 6 ? W[4] : W[2])); p.rect(x0, 10, x1 - x0, 2, (x, y) => (y === 10 ? W[3] : W[1])); };
  if (w) rail(0, 7); if (e) rail(9, 16);
  // north and south: a rail seen from above, running up the screen
  if (n) p.rect(7, 0, 2, 4, (x) => (x === 7 ? W[3] : W[1]));
  if (s) p.rect(7, 13, 2, 3, (x) => (x === 7 ? W[3] : W[1]));
  // the post: a cap on top, the grain down its face
  p.rect(6, 2, 4, 12, (x, y) => (y < 3 ? W[4] : x === 6 ? W[3] : x === 9 ? W[1] : W[2]));
  p.set(7, 6, W[1]); p.set(8, 9, W[1]);
  return p.outline({ only: (x, y) => !(n && x >= 6 && x <= 9 && y < 2) && !(s && x >= 6 && x <= 9 && y > 13) && !(w && x < 6 && y >= 5 && y <= 12) && !(e && x > 9 && y >= 5 && y <= 12) });
}
/** A low stone wall: a top you see from above, and a face where its south side is open. */
function wallCell({ n, e, s, w }) {
  const p = new Pic(T, T), S = P.stone;
  const x0 = w ? 0 : 1, x1 = e ? 16 : 15, top0 = n ? 0 : 2, face = s ? 16 : 10;
  p.rect(x0, top0, x1 - x0, face - top0, (x, y) => (y === top0 && !n ? S[4] : stoneTopAt(x, y)));
  if (!s) p.rect(x0, 10, x1 - x0, 6, (x, y) => { const row = Math.floor((y - 10) / 3), ox = row % 2 ? 4 : 0, cx = (x + ox) % 8; if (y === 10) return S[1]; if ((y - 10) % 3 === 0 || cx === 7) return S[0]; return (y - 10) % 3 === 1 ? S[2] : S[1]; });
  // moss on the top, here and there
  for (const [mx, my] of [[3, 4], [4, 4], [11, 7], [12, 6]]) if (p.get(mx, my) && (mx * my) % 3 === 0) p.set(mx, my, P.leaf[3]);
  return p.outline({ only: (x, y) => !(n && y < 2) && !(s && y > 13) && !(w && x < 1) && !(e && x > 14) });
}
/** A clipped hedge: like the wall, in leaves. */
function hedgeCell({ n, e, s, w }) {
  const p = new Pic(T, T), L = P.leaf, nz = noise(77, 16);
  const x0 = w ? 0 : 1, x1 = e ? 16 : 15, top0 = n ? 0 : 1, bottom = s ? 16 : 14;
  p.rect(x0, top0, x1 - x0, bottom - top0, (x, y) => {
    const v = nz(x, y, 3), front = !s && y >= 10;
    const k = front ? (v > 0.6 ? 2 : 1) : v > 0.7 ? 5 : v > 0.45 ? 4 : v > 0.25 ? 3 : 2;
    return L[y === top0 && !n ? 5 : k];
  });
  return p.outline({ only: (x, y) => !(n && y < 1) && !(s && y > 14) && !(w && x < 1) && !(e && x > 14) });
}

// ------------------------------------------------------------------------------------------------ dressing
function strip(cells) { const p = new Pic(T * cells.length, T); cells.forEach((c, i) => p.over(c, i * T, 0)); return p; }
function tuft(blades) {
  const p = new Pic(T, T);
  for (const [x, h] of blades) for (let y = 0; y < h; y++) p.set(x, 13 - y, y === h - 1 ? P.grass[4] : y > h / 2 ? P.grass[3] : P.grass[1]);
  for (const [x] of blades) p.set(x, 14, P.grass[0]);
  return p;
}
function flowers(spots, petal, centre) {
  const p = new Pic(T, T);
  for (const [x, y] of spots) {
    p.set(x, y + 2, P.grass[0]); p.set(x, y + 3, P.grass[1]);
    p.set(x - 1, y, petal[1]); p.set(x + 1, y, petal[1]); p.set(x, y - 1, petal[2]); p.set(x, y + 1, petal[0]); p.set(x, y, centre);
  }
  return p.outline({ deep: 0.45 });
}
function pebbles(spots) {
  const p = new Pic(T, T), R = P.rock;
  for (const [x, y, w] of spots) { p.rect(x, y, w, 2, (xx, yy) => (yy === y ? (xx === x ? R[4] : R[3]) : R[1])); }
  return p.outline({ deep: 0.5 });
}
function clover() {
  const p = new Pic(T, T), L = [P.grass[0], P.grass[1], P.grass[3], P.grass[4]];
  for (const [x, y] of [[5, 6], [9, 8], [6, 10]]) { p.set(x, y, L[3]); p.set(x + 1, y, L[2]); p.set(x, y + 1, L[2]); p.set(x + 1, y + 1, L[1]); p.set(x - 1, y + 1, L[2]); p.set(x, y + 2, L[1]); }
  return p;
}
function dressGrass() {
  return strip([
    tuft([[5, 4], [6, 6], [7, 5], [9, 3], [10, 5]]),
    tuft([[6, 3], [7, 5], [8, 4]]),
    tuft([[4, 3], [5, 4], [9, 5], [10, 3], [11, 4]]),
    flowers([[5, 6], [10, 9]], ['#e8a020', '#ffd23f', '#fff0a0'], '#c86418'),
    flowers([[6, 8], [10, 5], [9, 11]], ['#d8d0e0', '#ffffff', '#ffffff'], '#f0c030'),
    flowers([[7, 7], [11, 10]], ['#c04880', '#f070a8', '#ffb0d0'], '#ffe080'),
    flowers([[5, 9], [9, 6]], ['#3858b8', '#5888e8', '#a0c8ff'], '#fff0a0'),
    pebbles([[4, 8, 3], [9, 10, 2], [10, 5, 2]]),
    clover(),
  ]);
}
// crops in tilled soil
function crop(kind) {
  const p = new Pic(T, T), G = ['#2f6a2c', '#45903a', '#64b048', '#8ed060'];
  if (kind === 'sprout') { for (const [x, y] of [[5, 7], [10, 10]]) { p.set(x, y + 2, G[1]); p.set(x, y + 1, G[2]); p.set(x - 1, y, G[3]); p.set(x + 1, y, G[2]); } }
  if (kind === 'cabbage') { p.rect(4, 5, 8, 7, (x, y) => { const d = Math.hypot(x - 7.5, y - 8.3); return d > 4.1 ? null : d < 1.6 ? '#d8f0a0' : (x + y) % 3 === 0 ? G[1] : y < 7 ? '#a8dc78' : G[2]; }); }
  if (kind === 'carrot') { for (const x of [5, 8, 11]) { p.set(x, 9, '#e8782a'); p.set(x, 10, '#c85a1c'); for (let y = 5; y < 9; y++) p.set(x + (y % 2 ? 0 : (x % 2 ? 1 : -1)), y, y < 7 ? G[3] : G[2]); } }
  if (kind === 'wheat') { for (const x of [4, 7, 10, 12]) for (let y = 3; y < 13; y++) p.set(x + (y < 6 ? (y % 2) : 0), y, y < 7 ? (y % 2 ? '#e8c050' : '#f8dc78') : '#a8a040'); }
  if (kind === 'pumpkin') { p.rect(4, 7, 9, 6, (x, y) => { const d = Math.hypot((x - 8) / 4.6, (y - 9.8) / 3); return d > 1 ? null : x === 8 || x === 6 || x === 10 ? '#c85a18' : y < 9 ? '#ffa848' : '#e87c22'; }); p.set(8, 6, G[1]); p.set(9, 5, G[2]); p.set(10, 5, G[3]); }
  if (kind === 'flower') { for (let y = 6; y < 13; y++) p.set(8, y, G[1]); p.set(7, 9, G[2]); p.set(9, 10, G[2]); p.rect(6, 3, 5, 4, (x, y) => (x === 8 && (y === 4 || y === 5) ? '#7a4a1c' : (x === 6 || x === 10) && (y === 3 || y === 6) ? null : '#ffd030')); }
  return p.outline({ deep: 0.5 });
}
function dressSoil() { return strip(['sprout', 'cabbage', 'carrot', 'wheat', 'pumpkin', 'flower'].map(crop)); }
function dressPath() { return strip([pebbles([[5, 6, 2], [10, 10, 2]]), pebbles([[7, 8, 3]]), (() => { const p = new Pic(T, T); for (const [x, y] of [[6, 4], [7, 5], [7, 6], [8, 7], [8, 8], [9, 9]]) p.set(x, y, P.path[0]); return p; })()]); }

// ------------------------------------------------------------------------------------------------ shaded shapes
/** Shade a set of round clumps lit from the top left: each texel takes the front-most clump over it, its light from the
 *  clump's own normal, so leaves, bushes and boulders read as lumps, not flat discs. clumps: [{x, y, r}] (later = nearer). */
function clumps(p, list, ramp, { dither = 0.6, sheen = true, rim = 1 } = {}) {
  const L = [-0.62, -0.7], lz = 0.36;
  for (let y = 0; y < p.h; y++) for (let x = 0; x < p.w; x++) {
    let hit = null;
    for (const c of list) { const dx = (x + 0.5 - c.x) / c.r, dy = (y + 0.5 - c.y) / (c.ry ?? c.r); if (dx * dx + dy * dy <= 1) hit = { c, dx, dy }; }
    if (!hit) continue;
    const { dx, dy } = hit, dz = Math.sqrt(Math.max(0, 1 - dx * dx - dy * dy));
    let v = Math.max(0, (dx * L[0] + dy * L[1]) * 0.75 + dz * lz);
    v = Math.min(1, v * 0.95 + 0.08);
    if (rim && dx * dx + dy * dy > 0.78 && dy > 0) v *= 0.55;
    p.set(x, y, pick(ramp, v, x, y, dither));
  }
  if (sheen) for (const c of list) { const x = Math.round(c.x - c.r * 0.4), y = Math.round(c.y - (c.ry ?? c.r) * 0.45); if (p.get(x, y)) { p.set(x, y, ramp[ramp.length - 1]); p.set(x + 1, y, ramp[ramp.length - 1]); } }
  return p;
}

function oak({ fruit = null, seed = 3 } = {}) {
  const W = 48, H = 64, p = new Pic(W, H), R = rng(seed);
  // the trunk and its roots
  const B = P.bark;
  p.rect(20, 40, 8, 22, (x, y) => (y < 45 ? (x < 24 ? B[1] : B[0]) : x === 20 ? B[3] : x === 27 ? B[0] : (x * 3 + y) % 7 === 0 ? B[0] : x < 23 ? B[2] : B[1]));   // the crown's shade on its top
  for (const [x, y, c] of [[18, 61, 1], [19, 60, 2], [19, 61, 2], [28, 60, 1], [29, 61, 0], [17, 62, 1], [30, 62, 0], [24, 62, 1]]) p.set(x, y, B[c]);
  p.rect(18, 62, 12, 1, B[1]);
  // the crown: overlapping clumps, the lower ones nearer
  const cl = [{ x: 24, y: 14, r: 12 }, { x: 13, y: 22, r: 10 }, { x: 35, y: 22, r: 10 }, { x: 24, y: 24, r: 12 }, { x: 12, y: 32, r: 9 }, { x: 36, y: 32, r: 9 }, { x: 24, y: 35, r: 11 }];
  clumps(p, cl, P.leaf);
  // leaf texture: little bright and dark flecks
  for (let i = 0; i < 70; i++) { const x = Math.floor(R() * W), y = Math.floor(R() * 46); const c = p.get(x, y); if (!c || !P.leaf.includes(c)) continue; const k = P.leaf.indexOf(c); p.set(x, y, P.leaf[Math.max(1, Math.min(5, k + (R() < 0.5 ? 1 : -1)))]); }
  if (fruit) for (let i = 0; i < 14; i++) { const x = 6 + Math.floor(R() * 36), y = 8 + Math.floor(R() * 34); if (p.get(x, y) && p.get(x + 1, y + 1)) { p.set(x, y, fruit[1]); p.set(x + 1, y, fruit[0]); p.set(x, y + 1, fruit[0]); p.set(x + 1, y + 1, fruit[0]); } }
  return p.outline();
}
function pine() {
  const W = 32, H = 56, p = new Pic(W, H), B = P.bark;
  p.rect(14, 44, 4, 11, (x) => (x === 14 ? B[3] : x === 17 ? B[0] : B[2])); p.rect(13, 54, 6, 1, B[1]);
  // tiers of boughs, each a wide low clump, the lowest widest and nearest
  const tiers = [[16, 9, 6, 6], [16, 17, 9, 6], [16, 25, 11, 7], [16, 34, 13, 8], [16, 42, 14, 6]];
  clumps(p, tiers.map(([x, y, r, ry]) => ({ x, y, r, ry })), P.pine, { sheen: false });
  for (let t = 0; t < tiers.length; t++) { const [x, y, r, ry] = tiers[t]; for (let i = -r + 2; i < r - 1; i += 3) { const yy = Math.round(y + ry * 0.75); if (p.get(x + i, yy)) p.set(x + i, yy, P.pine[0]); } }
  return p.outline();
}
function bush({ berries = null, w = 24, h = 20 } = {}) {
  const p = new Pic(w, h), R = rng(9);
  clumps(p, [{ x: w * 0.32, y: h * 0.52, r: w * 0.28 }, { x: w * 0.66, y: h * 0.5, r: w * 0.28 }, { x: w * 0.5, y: h * 0.62, r: w * 0.33, ry: h * 0.36 }], P.leaf);
  if (berries) for (let i = 0; i < 8; i++) { const x = 3 + Math.floor(R() * (w - 6)), y = 3 + Math.floor(R() * (h - 6)); if (p.get(x, y)) { p.set(x, y, berries[1]); p.set(x, y + 1, berries[0]); } }
  return p.outline();
}
function rock({ w = 16, h = 13, big = false } = {}) {
  const p = new Pic(w, h);
  const cl = big ? [{ x: w * 0.38, y: h * 0.55, r: w * 0.32, ry: h * 0.42 }, { x: w * 0.62, y: h * 0.6, r: w * 0.32, ry: h * 0.38 }] : [{ x: w / 2, y: h * 0.56, r: w * 0.46, ry: h * 0.44 }];
  clumps(p, cl, P.rock, { dither: 0.4 });
  // a crack
  const cx = Math.round(w * 0.58); for (let k = 0; k < Math.round(h * 0.35); k++) if (p.get(cx + (k % 2), Math.round(h * 0.3) + k)) p.set(cx + (k % 2), Math.round(h * 0.3) + k, P.rock[0]);
  return p.outline();
}
function stump() {
  const p = new Pic(18, 15), B = P.bark;
  p.rect(2, 5, 14, 8, (x, y) => (x === 2 ? B[3] : x === 15 ? B[0] : (x * 5) % 4 === 0 ? B[1] : B[2]));
  p.rect(1, 12, 16, 2, B[1]); p.set(0, 13, B[0]); p.set(17, 13, B[0]);
  // the cut top: rings
  for (let y = 1; y < 7; y++) for (let x = 2; x < 16; x++) { const d = Math.hypot((x - 8.5) / 6.6, (y - 4) / 3); if (d <= 1) p.set(x, y, d > 0.85 ? B[1] : d > 0.55 ? '#c89a64' : d > 0.3 ? '#dcb27c' : '#c89a64'); }
  return p.outline();
}
function barrel() {
  const p = new Pic(14, 18), W = P.wood;
  p.rect(1, 2, 12, 15, (x, y) => { const k = x <= 2 ? 3 : x >= 11 ? 1 : x <= 5 ? 3 : 2; return y === 4 || y === 13 ? '#5a5866' : (x % 3 === 0 ? W[k - 1 >= 0 ? k - 1 : 0] : W[k]); });
  p.rect(2, 0, 10, 3, (x, y) => (y === 0 ? W[1] : x === 2 || x === 11 ? W[1] : '#c48c52'));
  p.set(4, 5, '#8a8896'); p.set(4, 14, '#8a8896');
  return p.outline();
}
function bigCrate() {
  const p = new Pic(18, 18), W = P.wood;
  p.rect(1, 4, 16, 13, (x, y) => (y === 4 || y === 16 || x === 1 || x === 16 ? W[1] : (x - y + 20) % 11 === 0 ? W[1] : y % 4 === 0 ? W[2] : W[3]));
  p.rect(1, 1, 16, 3, (x, y) => (y === 1 ? W[4] : x === 1 || x === 16 ? W[2] : W[3]));
  return p.outline();
}
function sign() {
  const p = new Pic(18, 18), W = P.wood;
  p.rect(8, 9, 2, 8, (x) => (x === 8 ? W[3] : W[1]));
  p.rect(1, 1, 16, 9, (x, y) => (y === 1 ? W[4] : y === 9 ? W[1] : x === 1 ? W[3] : x === 16 ? W[1] : W[2]));
  for (const [y, a, b] of [[4, 4, 13], [6, 4, 11]]) for (let x = a; x <= b; x++) if (x % 3) p.set(x, y, W[0]);
  return p.outline();
}
function mailbox() {
  const p = new Pic(12, 22), W = P.wood;
  p.rect(5, 10, 2, 11, (x) => (x === 5 ? W[3] : W[1]));
  p.rect(1, 2, 10, 8, (x, y) => (y <= 3 ? '#e8ecf4' : x === 1 ? '#c8ccd8' : x === 10 ? '#7a8094' : y === 9 ? '#7a8094' : '#a8aec0'));
  p.set(2, 1, '#c8ccd8'); for (let x = 3; x < 9; x++) p.set(x, 1, '#e8ecf4');
  p.rect(9, 3, 1, 3, '#d84a3a'); p.set(10, 3, '#d84a3a');
  return p.outline();
}
function lamp() {
  const p = new Pic(12, 40);
  p.rect(5, 12, 2, 26, (x) => (x === 5 ? '#6a6878' : '#3c3a48')); p.rect(3, 37, 6, 2, '#4a4858');
  p.rect(2, 2, 8, 9, (x, y) => (y === 2 || y === 10 ? '#3c3a48' : x === 2 || x === 9 ? '#3c3a48' : y < 6 ? '#fff4c0' : '#ffd860'));
  p.rect(3, 0, 6, 2, '#4a4858'); p.set(4, 4, '#ffffff');
  return p.outline();
}
function well() {
  const p = new Pic(32, 36), S = P.stone, W = P.wood;
  // the roof on two posts
  p.rect(5, 6, 2, 18, (x) => (x === 5 ? W[3] : W[1])); p.rect(25, 6, 2, 18, (x) => (x === 25 ? W[3] : W[1]));
  for (let y = 0; y < 8; y++) for (let x = 2 + Math.max(0, 7 - y * 2) - 7 + 7; x < 30 - Math.max(0, 7 - y * 2) + 0; x++) { if (x < 1 || x > 30) continue; p.set(x, y, y === 7 ? P.roofRed[0] : (x + y) % 4 === 0 ? P.roofRed[1] : y < 3 ? P.roofRed[4] : P.roofRed[3]); }
  p.rect(14, 8, 4, 2, W[1]); p.rect(15, 10, 1, 8, '#8a8070');
  p.rect(13, 17, 5, 3, (x, y) => (y === 17 ? W[3] : W[1]));
  // the stone ring: its far rim, the dark water inside, its near face
  p.rect(3, 20, 26, 5, (x, y) => (y === 20 ? S[4] : y > 22 && x > 5 && x < 26 ? '#1e3450' : S[3]));
  p.rect(3, 25, 26, 10, (x, y) => { const row = Math.floor((y - 25) / 3), ox = row % 2 ? 3 : 0, cx = (x + ox) % 6; if ((y - 25) % 3 === 2 || cx === 5) return S[0]; return (y - 25) % 3 === 0 ? S[3] : x < 8 ? S[3] : x > 24 ? S[1] : S[2]; });
  return p.outline();
}
function flowerPot(petal) {
  const p = new Pic(14, 16);
  p.rect(3, 9, 8, 6, (x, y) => (y === 9 ? '#d88a5a' : x === 3 ? '#c8704a' : x === 10 ? '#8a4428' : '#b05c3a'));
  p.rect(2, 8, 10, 2, (x, y) => (y === 8 ? '#e8a070' : '#b05c3a'));
  clumps(p, [{ x: 7, y: 6, r: 5, ry: 4 }], P.leaf, { sheen: false });
  for (const [x, y] of [[5, 4], [9, 5], [7, 3], [6, 7]]) { p.set(x, y, petal[1]); p.set(x + 1, y, petal[0]); }
  return p.outline();
}
function pumpkinBig() {
  const p = new Pic(18, 15);
  clumps(p, [{ x: 5.5, y: 9, r: 5, ry: 5 }, { x: 12.5, y: 9, r: 5, ry: 5 }, { x: 9, y: 9.5, r: 6, ry: 5.2 }], ['#9a4010', '#c85a18', '#e87c22', '#ffa040', '#ffc070'], { dither: 0.3 });
  p.rect(8, 1, 2, 4, (x) => (x === 8 ? '#5a8a3a' : '#3a6a2a')); p.set(10, 2, '#64b048'); p.set(11, 2, '#64b048');
  return p.outline();
}
function hay() {
  const p = new Pic(22, 18);
  p.rect(1, 3, 20, 14, (x, y) => (x === 6 || x === 15 ? '#8a6a20' : y === 3 ? '#fff0a0' : y < 7 ? '#f0d060' : (x + y * 2) % 5 === 0 ? '#c8a038' : y > 13 ? '#c8a038' : '#e0bc48'));
  for (let x = 2; x < 20; x++) if (x % 3 === 0) p.set(x, 2, '#f0d060');
  return p.outline();
}
function bench() {
  const p = new Pic(32, 18), W = P.wood;
  p.rect(1, 1, 30, 4, (x, y) => (y === 1 ? W[4] : y === 4 ? W[1] : x % 10 === 0 ? W[1] : W[3]));
  p.rect(1, 8, 30, 4, (x, y) => (y === 8 ? W[4] : y === 11 ? W[1] : x % 10 === 0 ? W[1] : W[2]));
  for (const x of [3, 27]) { p.rect(x, 5, 2, 3, W[1]); p.rect(x, 12, 2, 5, (xx) => (xx === x ? W[2] : W[0])); }
  return p.outline();
}
function logPile() {
  const p = new Pic(30, 18), B = P.bark;
  const logs = [[7, 12], [15, 12], [23, 12], [11, 6], [19, 6]];
  for (const [cx, cy] of logs) for (let y = cy - 5; y <= cy + 5; y++) for (let x = cx - 5; x <= cx + 5; x++) { const d = Math.hypot(x + 0.5 - cx, y + 0.5 - cy); if (d > 5) continue; p.set(x, y, d > 4.2 ? B[1] : d > 3 ? '#c89a64' : d > 1.6 ? '#dcb27c' : '#b98a54'); }
  return p.outline();
}

// ------------------------------------------------------------------------------------------------ set pieces
/** A house seen from above and in front: a pitched roof of shingles, the eaves' shadow, a front wall with a door and
 *  windows, a chimney. w: texels across (a whole number of metres); roof: a palette; wall: 'plaster' or 'plank'. */
function house({ w = 80, h = 96, roof = P.roofRed, wall = 'plaster', door = '#7a4428', chimney = true, awning = null, seed = 1 } = {}) {
  const p = new Pic(w, h), R = rng(seed);
  const wallTop = Math.round(h * 0.5), base = h - 3, eave = wallTop + 2;
  // the front wall
  const WL = wall === 'plank' ? P.plank : P.plaster;
  p.rect(3, wallTop, w - 6, base - wallTop, (x, y) => {
    if (wall === 'plank') return (y - wallTop) % 4 === 3 ? WL[0] : x === 3 ? WL[3] : x === w - 4 ? WL[1] : (x + y * 7) % 23 === 0 ? WL[1] : WL[2];
    // plaster with timber: posts at the corners and a beam
    if (x <= 4 || x >= w - 5 || y === wallTop + 1 || y === base - 1) return P.wood[1];
    return (x * 3 + y * 5) % 37 === 0 ? WL[1] : x < 8 ? WL[3] : WL[2];
  });
  // a stone footing
  p.rect(2, base, w - 4, 3, (x, y) => (y === base ? P.stone[3] : (x + (y % 2) * 3) % 6 === 0 ? P.stone[0] : P.stone[1]));
  // the door, in the middle, with a step
  const dw = 12, dh = 26, dx = Math.round(w / 2 - dw / 2), dTop = base - dh;
  p.rect(dx - 1, dTop - 1, dw + 2, dh + 1, P.wood[0]);
  p.rect(dx, dTop, dw, dh, (x, y) => (x === dx + dw / 2 ? mix(door, '#24162e', 0.4) : y < dTop + 2 ? mix(door, '#ffffff', 0.15) : x === dx ? mix(door, '#ffffff', 0.12) : door));
  p.set(dx + dw - 3, dTop + 14, P.gold[3]); p.set(dx + 2, dTop + 14, P.gold[3]);
  p.rect(dx - 2, base, dw + 4, 3, (x, y) => (y === base ? P.stone[4] : P.stone[2]));
  // windows either side: frame, panes, a sill with flowers
  const win = x0 => {
    const wy = dTop + 4, ww = 12, wh = 12;
    p.rect(x0 - 1, wy - 1, ww + 2, wh + 2, P.wood[0]);
    p.rect(x0, wy, ww, wh, (x, y) => (x === x0 + ww / 2 || y === wy + 5 ? P.wood[3] : (x - x0) + (y - wy) < 4 ? P.glass[3] : y > wy + 7 ? P.glass[0] : P.glass[1]));
    p.rect(x0 - 2, wy + wh, ww + 4, 2, (x, y) => (y === wy + wh ? P.wood[4] : P.wood[1]));
    for (let x = x0 - 1; x < x0 + ww + 1; x += 2) { p.set(x, wy + wh - 1, ['#f06a8a', '#ffd23f', '#ffffff', '#f06a8a'][Math.floor(R() * 4)]); p.set(x + 1, wy + wh - 1, P.leaf[3]); }
  };
  if (w >= 64) { win(Math.round(w * 0.12)); win(Math.round(w * 0.88) - 12); }
  // the roof: shingle rows from the ridge down to the eaves, lit at the top, darker toward the eaves
  const ridge = 8, rows = Math.floor((eave - ridge) / 4);
  p.rect(0, ridge, w, eave - ridge, (x, y) => {
    const row = Math.floor((y - ridge) / 4), ox = row % 2 ? 4 : 0, k = (y - ridge) % 4, cx = (x + ox) % 8;
    const shade = row / rows;
    const tone = shade < 0.25 ? 3 : shade < 0.6 ? 2 : 2;
    if (k === 3) return roof[Math.max(0, tone - 2)];
    if (cx === 7) return roof[Math.max(0, tone - 1)];
    if (k === 0) return roof[Math.min(4, tone + 1)];
    return x < 6 ? roof[Math.min(4, tone + 1)] : x > w - 7 ? roof[Math.max(0, tone - 1)] : roof[tone];
  });
  // the ridge cap and the gable edges
  p.rect(0, ridge - 3, w, 3, (x, y) => (y === ridge - 3 ? roof[4] : y === ridge - 2 ? roof[3] : roof[1]));
  for (let y = ridge - 3; y < eave; y++) { p.set(0, y, roof[0]); p.set(w - 1, y, roof[0]); }
  p.rect(0, eave, w, 1, roof[0]);
  // the eaves' shadow on the wall
  p.rect(3, eave + 1, w - 6, 2, (x, y) => mix(p.get(x, y) ?? '#888888', '#24162e', y === eave + 1 ? 0.45 : 0.25));
  if (chimney) { const cx = Math.round(w * 0.72); p.rect(cx, 0, 8, ridge + 6, (x, y) => (y < 2 ? P.brick[0] : y === 2 ? P.brick[4] : (y % 3 === 0 || (x + (Math.floor(y / 3) % 2) * 2) % 4 === 0) ? P.brick[1] : x === cx ? P.brick[3] : P.brick[2])); }
  if (awning) {
    const ay = dTop - 7;
    p.rect(4, ay, w - 8, 5, (x, y) => (y === ay + 4 ? (x % 6 < 3 ? awning[0] : '#e8e0d0') : Math.floor((x - 4) / 6) % 2 ? '#f4ecdc' : awning[1]));
    for (let x = 4; x < w - 4; x += 3) p.set(x, ay + 5, Math.floor((x - 4) / 6) % 2 ? '#d8d0c0' : awning[0]);
  }
  return p.outline();
}
function shed() { return house({ w: 48, h: 56, roof: P.roofGreen, wall: 'plank', chimney: false, door: '#5a3a24', seed: 7 }); }

// ------------------------------------------------------------------------------------------------ pickups (16 x 16)
function coin() {
  const p = new Pic(16, 16), G = P.gold;
  p.each((x, y) => { const d = Math.hypot((x + 0.5 - 8) / 6.2, (y + 0.5 - 8) / 7); if (d > 1) return null; if (d > 0.82) return x + y < 15 ? G[2] : G[1]; return (x === 7 || x === 8) && y > 4 && y < 11 ? G[1] : x + y < 13 ? G[3] : G[2]; });
  p.set(5, 4, G[4]); p.set(4, 5, G[4]); p.set(5, 5, G[4]);
  return p.outline();
}
function gem() {
  const p = new Pic(16, 16), C = ['#1a6a8a', '#2a9ac0', '#48c8e8', '#9aeefa', '#ffffff'];
  for (let y = 2; y < 14; y++) for (let x = 2; x < 14; x++) {
    const top = y < 6, wHalf = top ? 3 + (y - 2) * 1.2 : 6 - (y - 6) * 0.78;
    if (Math.abs(x + 0.5 - 8) > wHalf) continue;
    p.set(x, y, top ? (x < 8 ? C[3] : C[2]) : x < 6 ? C[2] : x < 10 ? C[1] : C[0]);
  }
  p.set(5, 3, C[4]); p.set(6, 3, C[4]); p.set(5, 4, C[4]);
  return p.outline();
}
function heart() {
  const p = new Pic(16, 16), C = ['#8a1a32', '#c02848', '#e84868', '#ff8aa0', '#ffffff'];
  p.each((x, y) => { const X = (x + 0.5 - 8) / 6, Y = -(y + 0.5 - 8.4) / 6; const v = Math.pow(X * X + Y * Y - 0.42, 3) - X * X * Y * Y * Y; if (v > 0) return null; return x + y < 11 ? C[3] : x > 9 && y > 7 ? C[1] : C[2]; });
  p.set(4, 5, C[4]); p.set(5, 4, C[4]);
  return p.outline();
}
function key() {
  const p = new Pic(16, 16), G = P.gold;
  for (let y = 2; y < 9; y++) for (let x = 2; x < 9; x++) { const d = Math.hypot(x + 0.5 - 5.5, y + 0.5 - 5.5); if (d <= 3.5 && d >= 1.6) p.set(x, y, x + y < 10 ? G[3] : G[2]); }
  p.rect(8, 7, 2, 7, (x) => (x === 8 ? G[3] : G[1])); p.rect(10, 11, 2, 1, G[2]); p.rect(10, 13, 3, 1, G[2]);
  return p.outline();
}
function star() {
  const p = new Pic(16, 16), G = P.gold;
  const pts = []; for (let i = 0; i < 10; i++) { const a = -Math.PI / 2 + i * Math.PI / 5, r = i % 2 ? 3 : 7.2; pts.push([8 + Math.cos(a) * r, 8.4 + Math.sin(a) * r]); }
  const inside = (x, y) => { let c = false; for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) { const [xi, yi] = pts[i], [xj, yj] = pts[j]; if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) c = !c; } return c; };
  p.each((x, y) => (inside(x + 0.5, y + 0.5) ? (x + y < 14 ? G[3] : x > 8 && y > 8 ? G[1] : G[2]) : null));
  p.set(7, 4, G[4]); p.set(7, 5, G[4]);
  return p.outline();
}
function crate16() {
  const p = new Pic(16, 16), W = P.wood;
  p.rect(1, 3, 14, 12, (x, y) => (y === 3 || y === 14 || x === 1 || x === 14 ? W[1] : x === y - 1 || x === 16 - y ? W[1] : y % 4 === 1 ? W[2] : W[3]));
  p.rect(1, 1, 14, 2, (x, y) => (y === 1 ? W[4] : W[3]));
  return p.outline();
}

// ------------------------------------------------------------------------------------------------ the list
// what: tile (judged as a tile; solid as the kind is), edges (mode), dress, prop. use: for the library manifest.
export const PICTURES = {
  // tiles (gf-flat-1 §4): 16 x 16, or 32 x 16 (cap, fill)
  'tile-grass': { what: 'tile', make: grassTile, describe: 'grass ground tile, a calm green with soft patches', tags: ['grass', 'ground', 'field'] },
  'tile-path': { what: 'tile', make: pathTile, describe: 'dirt path tile, sandy brown with grit', tags: ['path', 'dirt', 'road'] },
  'tile-soil': { what: 'tile', make: soilTile, describe: 'tilled soil tile, dark furrows', tags: ['soil', 'farm', 'field', 'crops'] },
  'tile-water': { what: 'tile', make: waterTile, solid: true, describe: 'water tile, blue with ripples', tags: ['water', 'pond', 'lake', 'river'] },
  'tile-cobble': { what: 'tile', make: cobbleTile, describe: 'cobblestone tile, rounded grey stones', tags: ['cobble', 'stone', 'street', 'plaza'] },
  'tile-wall': { what: 'tile', make: wallFlat, solid: true, describe: 'stone wall tile seen from above (cap, fill)', tags: ['wall', 'stone'] },
  'tile-ground': { what: 'tile', make: groundSide, solid: true, describe: 'side-on ground: a grass lip over dirt (cap, fill)', tags: ['ground', 'grass', 'dirt', 'side'] },
  'tile-brick': { what: 'tile', make: brickSide, solid: true, describe: 'red brick tile', tags: ['brick', 'wall', 'side'] },
  'tile-ledge': { what: 'tile', make: ledgeSide, solid: 'top', describe: 'a wooden ledge on brackets, side-on', tags: ['ledge', 'platform', 'wood', 'side'] },
  // edge sets (drawplan.js): 4 x 4 cells
  'edges-path': { what: 'edges', mode: 'blend', make: () => blendSet({ inside: pathAt, rim: () => P.path[0], rimTop: () => P.path[1], lip: () => P.grass[1], seed: 5 }), describe: 'dirt path edges over grass: soft, rounded borders (16, blend)', tags: ['path', 'dirt', 'edges'] },
  'edges-soil': { what: 'edges', mode: 'blend', make: () => blendSet({ inside: soilAt, rim: () => '#3c2416', rimTop: () => P.soil[0], lip: () => P.grass[1], wobble: 0.12, seed: 6 }), describe: 'tilled soil edges over grass (16, blend)', tags: ['soil', 'farm', 'edges'] },
  'edges-water': { what: 'edges', mode: 'blend', make: () => blendSet({ inside: waterAt, rim: () => P.water[5], rimTop: () => P.water[0], lip: (x, y) => ((x + y) % 3 ? P.sand[1] : P.sand[2]), lipWidth: 2, wobble: 0.28, seed: 7 }), describe: 'pond edges: foam and a sandy shore (16, blend)', tags: ['water', 'pond', 'shore', 'edges'] },
  'edges-cobble': { what: 'edges', mode: 'blend', make: () => blendSet({ inside: cobbleAt, rim: () => P.cobble[0], lip: () => P.grass[1], wobble: 0.1, seed: 8 }), describe: 'cobblestone edges over grass (16, blend)', tags: ['cobble', 'stone', 'edges'] },
  'edges-fence': { what: 'edges', mode: 'connect', make: () => connectSet(fenceCell), describe: 'a wooden fence that joins its neighbours (16, connect)', tags: ['fence', 'wood', 'edges'] },
  'edges-wall': { what: 'edges', mode: 'connect', make: () => connectSet(wallCell), describe: 'a low stone wall that joins its neighbours (16, connect)', tags: ['wall', 'stone', 'edges'] },
  'edges-hedge': { what: 'edges', mode: 'connect', make: () => connectSet(hedgeCell), describe: 'a clipped hedge that joins its neighbours (16, connect)', tags: ['hedge', 'bush', 'edges'] },
  // dressing strips
  'dress-grass': { what: 'dress', make: dressGrass, describe: 'things in the grass: tufts, flowers, pebbles, clover (9)', tags: ['grass', 'flowers', 'dressing'] },
  'dress-soil': { what: 'dress', make: dressSoil, describe: 'crops in tilled soil: sprouts, cabbage, carrots, wheat, a pumpkin, a sunflower (6)', tags: ['crops', 'farm', 'dressing'] },
  'dress-path': { what: 'dress', make: dressPath, describe: 'pebbles and a crack on a path (3)', tags: ['path', 'pebbles', 'dressing'] },
  // pickups
  coin: { what: 'prop', make: coin, describe: 'a gold coin', tags: ['coin', 'gold', 'pickup'] },
  gem: { what: 'prop', make: gem, describe: 'a cut blue gem', tags: ['gem', 'jewel', 'pickup'] },
  heart: { what: 'prop', make: heart, describe: 'a red heart', tags: ['heart', 'health', 'pickup'] },
  key: { what: 'prop', make: key, describe: 'a gold key', tags: ['key', 'pickup'] },
  star: { what: 'prop', make: star, describe: 'a gold star', tags: ['star', 'pickup'] },
  crate: { what: 'prop', make: crate16, describe: 'a small wooden crate', tags: ['crate', 'box', 'wood'] },
  // props
  'tree-oak': { what: 'prop', make: () => oak({ seed: 3 }), describe: 'a round leafy oak tree, 3 m across', tags: ['tree', 'oak', 'nature'], footprint: [1, 1] },
  'tree-apple': { what: 'prop', make: () => oak({ seed: 5, fruit: ['#b02828', '#ff5a4a'] }), describe: 'an apple tree with red fruit', tags: ['tree', 'apple', 'fruit', 'orchard'], footprint: [1, 1] },
  'tree-pine': { what: 'prop', make: pine, describe: 'a tall pine tree', tags: ['tree', 'pine', 'forest'], footprint: [1, 1] },
  bush: { what: 'prop', make: () => bush(), describe: 'a round green bush', tags: ['bush', 'shrub', 'nature'] },
  'bush-berry': { what: 'prop', make: () => bush({ berries: ['#5a1a4a', '#c04880'] }), describe: 'a bush with berries', tags: ['bush', 'berries', 'nature'] },
  rock: { what: 'prop', make: () => rock(), describe: 'a small grey rock', tags: ['rock', 'stone'] },
  boulder: { what: 'prop', make: () => rock({ w: 28, h: 22, big: true }), describe: 'a big boulder', tags: ['rock', 'boulder', 'stone'] },
  stump: { what: 'prop', make: stump, describe: 'a tree stump', tags: ['stump', 'tree', 'wood'] },
  'log-pile': { what: 'prop', make: logPile, describe: 'a pile of cut logs', tags: ['logs', 'wood', 'firewood'] },
  barrel: { what: 'prop', make: barrel, describe: 'a wooden barrel with iron hoops', tags: ['barrel', 'wood'] },
  'crate-big': { what: 'prop', make: bigCrate, describe: 'a big wooden crate', tags: ['crate', 'box', 'wood'] },
  sign: { what: 'prop', make: sign, describe: 'a wooden signpost', tags: ['sign', 'wood'] },
  mailbox: { what: 'prop', make: mailbox, describe: 'a mailbox on a post', tags: ['mailbox', 'post', 'letter'] },
  lamp: { what: 'prop', make: lamp, describe: 'a street lamp, lit', tags: ['lamp', 'light', 'street'] },
  well: { what: 'prop', make: well, describe: 'a stone well with a little roof', tags: ['well', 'stone', 'water', 'village'] },
  'flower-pot': { what: 'prop', make: () => flowerPot(['#c04880', '#f070a8']), describe: 'a clay pot of flowers', tags: ['flowers', 'pot', 'plant'] },
  pumpkin: { what: 'prop', make: pumpkinBig, describe: 'a big orange pumpkin', tags: ['pumpkin', 'crop', 'farm'] },
  hay: { what: 'prop', make: hay, describe: 'a bale of hay', tags: ['hay', 'farm', 'straw'] },
  bench: { what: 'prop', make: bench, describe: 'a wooden bench', tags: ['bench', 'seat', 'park'] },
  // set pieces (drawplan.js "piece": its footprint in cells)
  'house-red': { what: 'prop', make: () => house({ roof: P.roofRed, seed: 1 }), describe: 'a cottage with a red shingle roof, a door and two windows, 5 m across', tags: ['house', 'cottage', 'home', 'building'], footprint: [5, 3] },
  'house-blue': { what: 'prop', make: () => house({ roof: P.roofBlue, wall: 'plank', door: '#3a5a8a', seed: 2 }), describe: 'a plank house with a blue roof, 5 m across', tags: ['house', 'home', 'building'], footprint: [5, 3] },
  shop: { what: 'prop', make: () => house({ w: 96, h: 96, roof: P.roofGreen, awning: ['#c83a3a', '#e05a4a'], chimney: false, seed: 3 }), describe: 'a shop with a striped awning, 6 m across', tags: ['shop', 'store', 'market', 'building'], footprint: [6, 3] },
  shed: { what: 'prop', make: shed, describe: 'a small plank shed with a green roof, 3 m across', tags: ['shed', 'barn', 'building'], footprint: [3, 2] },
};

export function make(id) {
  const d = PICTURES[id];
  const pic = d.make().limit(32).rgba();
  const opts = d.what === 'tile' ? { style: 'pixel', solid: d.solid ?? false } : d.what === 'edges' ? { style: 'pixel', mode: d.mode } : { style: 'pixel' };
  const j = judge(d.what, { width: pic.width, height: pic.height, data: new Uint8Array(pic.data.buffer, pic.data.byteOffset, pic.data.length) }, opts);
  return { pic, judge: j, colours: colourCount(pic) };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const argv = process.argv.slice(2), opt = (k, d = null) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
  if (argv.includes('--list')) { for (const [id, d] of Object.entries(PICTURES)) console.log(`${id.padEnd(14)} ${d.what.padEnd(6)} ${d.describe}`); process.exit(0); }
  const out = argv.includes('--standins') ? join(REPO, 'builder/tools/lib/standin-assets/flat/pixel') : opt('--out', join(REPO, '.cache/pixel-town')), only = opt('--only')?.split(',') ?? Object.keys(PICTURES);
  mkdirSync(out, { recursive: true });
  let bad = 0;
  for (const id of only) {
    const { pic, judge: j, colours } = make(id);
    if (!j.ok) { bad++; console.error(`${id}: FAILS the flat judge: ${j.errors.map(e => `${e.rule} ${e.frame ?? ''} ${e.message}`).join('; ')}`); continue; }
    writeFileSync(join(out, `${id}.png`), encodePng(pic));
    console.log(`${id}.png  ${pic.width}x${pic.height}  ${colours} colours${colours > 32 ? ' (OVER 32)' : ''}${j.warnings.length ? `  warnings: ${j.warnings.map(w => w.rule).join(', ')}` : ''}`);
    if (colours > 32) bad++;
  }
  process.exit(bad ? 1 : 0);
}
