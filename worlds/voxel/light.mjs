// gf-three voxel world: light. Sunlight that falls from the sky and spreads into caves and under trees, and coloured
// block light that spreads from lamps and glowing ores, both 0-15 per cell, as Minecraft and Divine Voxel Engine keep
// them. Pure (no three.js, no DOM): the mesher (mesh.mjs) reads it for smooth per-vertex lighting, Node tests import it.
//
// Technique from Divine Voxel Engine (DVE, MIT: DivineVoxelEngine at 5080a27d and its core divinevoxel-vlox at eba6f696, see
// LICENSE-dve beside this file): one 16-bit word per cell holding four 4-bit channels (sun, red, green, blue), sunlight
// that keeps its full level straight down through clear cells, and a breadth-first flood that lowers each channel by one
// a step. Written for this grid, not copied: DVE floods per sector with removal queues; here an edit relights a box round
// it (light reaches at most 15 cells, so nothing outside the box can change), and the chunks whose cells changed are
// marked for the mesher.
//
//   light.data          Uint16Array, one word per cell (grid.index order): sun << 12 | r << 8 | g << 4 | b
//   light.computeAll()  the whole grid (load, a reset)
//   light.touch(x, z)   an edit at column (x, z): relit on the next flush, with every other edit since
//   light.flush()       relight the pending box → the chunk keys whose light changed (also marked dirty on the grid)
//   light.at(x, y, z)   the packed word (outside the grid: full sun above the ground, dark below)
//
// A block's part (blocks.mjs info[]): opaque (stops light), filter (extra loss through it: leaves 1), emit (a packed
// r << 8 | g << 4 | b word, the light it gives off).
import { CHUNK, chunkKey } from './grid.mjs';

export const SUN = 0xf000;
export const sunOf = w => w >> 12;
export const rOf = w => (w >> 8) & 15;
export const gOf = w => (w >> 4) & 15;
export const bOf = w => w & 15;
export const pack = (s, r, g, b) => (s << 12) | (r << 8) | (g << 4) | b;
const REACH = 15;

export class VoxelLight {
  /** grid: a VoxelGrid; its info[] gives each block's opaque, filter and emit. */
  constructor(grid) {
    this.grid = grid;
    const n = grid.sx * grid.sy * grid.sz;
    this.data = new Uint16Array(n);
    this.opaque = new Uint8Array(256); this.filter = new Uint8Array(256); this.emit = new Uint16Array(256);
    for (let b = 1; b < 256; b++) {
      const I = grid.info[b]; if (!I) continue;
      this.opaque[b] = I.opaque ? 1 : 0; this.filter[b] = I.filter ?? 0; this.emit[b] = I.emit ?? 0;
    }
    this.queue = new Int32Array(1 << 16);
    this.pending = null;            // [x0, z0, x1, z1] (columns, inclusive) waiting for flush
    this.version = 0;
  }
  at(x, y, z) {
    const g = this.grid;
    if (x < 0 || z < 0 || x >= g.sx || z >= g.sz || y < 0) return 0;
    if (y >= g.sy) return SUN;
    return this.data[g.index(x, y, z)];
  }
  computeAll() { this.relight(0, 0, this.grid.sx - 1, this.grid.sz - 1, false); this.pending = null; }
  /** An edit in column (x, z): its light and that of everything within reach is redone on the next flush. */
  touch(x, z) {
    const p = this.pending, a = x - REACH - 1, b = z - REACH - 1, c = x + REACH + 1, d = z + REACH + 1;
    this.pending = p ? [Math.min(p[0], a), Math.min(p[1], b), Math.max(p[2], c), Math.max(p[3], d)] : [a, b, c, d];
  }
  /** Relight what edits touched since the last flush. → Set of chunk keys whose light changed (null: nothing pending). */
  flush() {
    if (!this.pending) return null;
    const [x0, z0, x1, z1] = this.pending; this.pending = null;
    return this.relight(Math.max(0, x0), Math.max(0, z0), Math.min(this.grid.sx - 1, x1), Math.min(this.grid.sz - 1, z1), true);
  }

  /** Clear and refill the light of columns x0..x1, z0..z1 (inclusive, every height), seeded from the sky, the emitters
   *  inside and the lit cells just outside. diff: return the chunk keys whose cells changed. */
  relight(x0, z0, x1, z1, diff = true) {
    const g = this.grid, { sx, sy, sz } = g, L = this.data, cells = g.data;
    const opaque = this.opaque, filter = this.filter, emit = this.emit;
    const W = x1 - x0 + 1, D = z1 - z0 + 1, plane = sx * sz;
    const old = diff ? new Uint16Array(W * D * sy) : null;
    if (old) for (let y = 0, k = 0; y < sy; y++) for (let z = z0; z <= z1; z++) { const row = (y * sz + z) * sx; for (let x = x0; x <= x1; x++) old[k++] = L[row + x]; }
    let q = this.queue, head = 0, tail = 0;
    const push = i => {
      if (tail >= q.length) {
        // compact what has been read, then grow if the queue is still full
        q.copyWithin(0, head, tail); tail -= head; head = 0;
        if (tail >= q.length - 1) { const n = new Int32Array(q.length * 2); n.set(q.subarray(0, tail)); q = this.queue = n; }
      }
      q[tail++] = i;
    };
    // ---- clear, then the sky straight down each column ----
    for (let z = z0; z <= z1; z++) for (let x = x0; x <= x1; x++) {
      let s = 15;
      for (let y = sy - 1; y >= 0; y--) {
        const i = y * plane + z * sx + x, b = cells[i] & 255;
        let w = 0;
        // the same step the flood takes downward: full sun stays full through clear cells, anything else loses 1 + filter
        if (b && opaque[b]) s = 0;
        else if (s > 0) { const f = 1 + (b ? filter[b] : 0); if (s < 15 || f > 1) s = Math.max(0, s - f); }
        if (!b || !opaque[b]) w = s << 12;
        const e = b ? emit[b] : 0;
        if (e) { w |= e; push(i); }
        L[i] = w;
      }
    }
    // ---- seeds: lit cells beside darker see-through cells inside the box, and the lit cells just outside it ----
    for (let z = z0; z <= z1; z++) for (let x = x0; x <= x1; x++) for (let y = 0; y < sy; y++) {
      const i = y * plane + z * sx + x, s = L[i] >> 12;
      if (s < 2) continue;
      if ((x > x0 && open(i - 1, s)) || (x < x1 && open(i + 1, s)) || (z > z0 && open(i - sx, s)) || (z < z1 && open(i + sx, s)) || (y > 0 && open(i - plane, s))) push(i);
    }
    function open(j, s) { const b = cells[j] & 255; return (!b || !opaque[b]) && (L[j] >> 12) < s - 1; }
    const edge = (x, z) => {
      if (x < 0 || z < 0 || x >= sx || z >= sz) return;
      for (let y = 0; y < sy; y++) { const i = y * plane + z * sx + x, w = L[i]; if (((w >> 12) > 1) || ((w >> 8) & 15) > 1 || ((w >> 4) & 15) > 1 || (w & 15) > 1) push(i); }
    };
    for (let x = x0; x <= x1; x++) { edge(x, z0 - 1); edge(x, z1 + 1); }
    for (let z = z0; z <= z1; z++) { edge(x0 - 1, z); edge(x1 + 1, z); }

    // ---- the flood: each channel one less a step (sun keeps 15 straight down through clear cells) ----
    while (head < tail) {
      const i = q[head++], w = L[i];
      const s = w >> 12, r = (w >> 8) & 15, gg = (w >> 4) & 15, bb = w & 15;
      const x = i % sx, rest = (i - x) / sx, z = rest % sz, y = (rest - z) / sz;
      for (let k = 0; k < 6; k++) {
        let nx = x, ny = y, nz = z;
        if (k === 0) nx--; else if (k === 1) nx++; else if (k === 2) ny--; else if (k === 3) ny++; else if (k === 4) nz--; else nz++;
        if (nx < x0 || nx > x1 || nz < z0 || nz > z1 || ny < 0 || ny >= sy) continue;
        const j = i + (k === 0 ? -1 : k === 1 ? 1 : k === 2 ? -plane : k === 3 ? plane : k === 4 ? -sx : sx);
        const b = cells[j] & 255;
        if (b && opaque[b]) continue;
        const f = 1 + (b ? filter[b] : 0), nw = L[j];
        const ns = k === 2 && s === 15 && f === 1 ? 15 : s - f;
        const os = nw >> 12, or = (nw >> 8) & 15, og = (nw >> 4) & 15, ob = nw & 15;
        const ts = ns > os ? ns : os, tr = r - f > or ? r - f : or, tg = gg - f > og ? gg - f : og, tb = bb - f > ob ? bb - f : ob;
        const out = (ts << 12) | (tr << 8) | (tg << 4) | tb;
        if (out !== nw) { L[j] = out; push(j); }
      }
    }
    this.version++;
    if (!old) { g.markAll?.(); return null; }
    // ---- which chunks changed: a changed cell's own chunk and those its light reaches in the mesher (one cell round) ----
    const keys = new Set();
    for (let y = 0, k = 0; y < sy; y++) for (let z = z0; z <= z1; z++) for (let x = x0; x <= x1; x++, k++) {
      if (old[k] === L[(y * sz + z) * sx + x]) continue;
      for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (let dz = -1; dz <= 1; dz++) {
        const X = x + dx, Y = y + dy, Z = z + dz;
        if (X < 0 || Y < 0 || Z < 0 || X >= sx || Y >= sy || Z >= sz) continue;
        keys.add(chunkKey(Math.floor(X / CHUNK), Math.floor(Y / CHUNK), Math.floor(Z / CHUNK)));
      }
    }
    for (const k of keys) g.dirty.add(k);
    return keys;
  }
}
