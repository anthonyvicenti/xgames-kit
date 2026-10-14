// gf-three voxel world: the mesher. One chunk (16³ cells) of a VoxelGrid → typed vertex buffers per block kind, with
// per-vertex ambient occlusion and smooth light (sun and coloured block light from light.mjs), the biome's grass and
// leaf colours, and paint. Pure (no three.js, no DOM): the main thread and the mesh workers (mesh-worker.js) run it, Node
// tests import it.
//
// Face culling, the face table and the AO rule with the quad-diagonal flip come from Blockhaven (grid.mjs's notes: the
// three.js r186 voxel example, BSD-3-Clause, LICENSE-three-voxel). Smooth light is Divine Voxel Engine's idea (DVE, MIT,
// LICENSE-dve; vlox src/Mesher/Voxels/Models/Common/Calc/FaceDataCalc.ts at eba6f696): each corner of a face reads the
// cell the face looks into and the three cells round that corner. DVE keeps the brightest of the four; here the open
// ones are averaged (Minecraft's smooth lighting), which gives the soft fall-off into corners and under ledges.
//
// meshChunk(grid, light, cx, cy, cz) → { solid, cutout, glass, glow, plant } each { count (vertices), position
// Float32Array, normal Int8Array, color Uint8Array (AO × block colour), uvl Uint8Array (u, v, texture layer), tint
// Uint8Array (paint; 0 = none), light Uint8Array (sun, r, g, b; 0-255 for 0-15), biome Uint8Array (the grass or leaf
// colour where the block takes one; white elsewhere), glow Uint8Array (255 where the block gives off light: lamps,
// crystals, glowcaps glow in the dark), index Uint16Array | Uint32Array } (kinds with no faces left out).
//
// The grid may carry: grid.origin [x, y, z] (a far grid drawn round the play grid: positions are offset by it),
// grid.outside(x, y, z) (the cell value just past the grid's edge, so the edge is culled against the land beyond, not
// drawn as a wall), grid.biome (Uint8Array sx*sz*6: the grass rgb then the leaf rgb of each column).
import { CHUNK, FACES } from './grid.mjs';

export const AO_CURVE = [0.5, 0.68, 0.85, 1];
export const BUCKETS = ['solid', 'cutout', 'glass', 'glow', 'plant', 'liquid'];
// a liquid's surface sits this far below the top of its cell (when no liquid is above it)
export const LIQUID_DROP = 0.12;
const WHITE = [255, 255, 255];

class Bucket {
  constructor() { this.count = 0; this.cap = 0; this.icount = 0; this.icap = 0; this.grow(256); this.igrow(384); }
  grow(n) {
    const cap = Math.max(n, this.cap * 2), c = this.count;
    const re = (A, k, old) => { const a = new A(cap * k); if (old) a.set(old.subarray(0, c * k)); return a; };
    this.position = re(Float32Array, 3, this.position); this.normal = re(Int8Array, 3, this.normal);
    this.color = re(Uint8Array, 3, this.color); this.uvl = re(Uint8Array, 3, this.uvl); this.tint = re(Uint8Array, 3, this.tint);
    this.light = re(Uint8Array, 4, this.light); this.biome = re(Uint8Array, 3, this.biome); this.glow = re(Uint8Array, 1, this.glow);
    this.cap = cap;
  }
  igrow(n) { const cap = Math.max(n, this.icap * 2), a = new Uint32Array(cap); if (this.index) a.set(this.index.subarray(0, this.icount)); this.index = a; this.icap = cap; }
  vertex(px, py, pz, n, r, g, b, u, v, layer, tint, l, bio, glow = 0) {
    if (this.count >= this.cap) this.grow(this.count + 1);
    const i = this.count++, i3 = i * 3, i4 = i * 4;
    this.position[i3] = px; this.position[i3 + 1] = py; this.position[i3 + 2] = pz;
    this.normal[i3] = n[0] * 127; this.normal[i3 + 1] = n[1] * 127; this.normal[i3 + 2] = n[2] * 127;
    this.color[i3] = r; this.color[i3 + 1] = g; this.color[i3 + 2] = b;
    this.uvl[i3] = u; this.uvl[i3 + 1] = v; this.uvl[i3 + 2] = layer;
    this.tint[i3] = tint[0]; this.tint[i3 + 1] = tint[1]; this.tint[i3 + 2] = tint[2];
    this.light[i4] = l[0]; this.light[i4 + 1] = l[1]; this.light[i4 + 2] = l[2]; this.light[i4 + 3] = l[3];
    this.biome[i3] = bio[0]; this.biome[i3 + 1] = bio[1]; this.biome[i3 + 2] = bio[2];
    this.glow[i] = glow;
    return i;
  }
  tri(a, b, c) { if (this.icount + 3 > this.icap) this.igrow(this.icount + 3); this.index[this.icount++] = a; this.index[this.icount++] = b; this.index[this.icount++] = c; }
  done() {
    const c = this.count, Index = c > 65535 ? Uint32Array : Uint16Array;
    return {
      count: c, position: this.position.slice(0, c * 3), normal: this.normal.slice(0, c * 3), color: this.color.slice(0, c * 3),
      uvl: this.uvl.slice(0, c * 3), tint: this.tint.slice(0, c * 3), light: this.light.slice(0, c * 4), biome: this.biome.slice(0, c * 3), glow: this.glow.slice(0, c),
      index: Index.from(this.index.subarray(0, this.icount)),
    };
  }
}

const to8 = x => Math.max(0, Math.min(255, Math.round(x * 255)));
// linear [r, g, b] 0-1 → bytes, cached per table entry
const bytesOf = c => (c ? c.map(to8) : null);

/** The buffers of one chunk (see the file's head). */
export function meshChunk(grid, light, cx, cy, cz) {
  const C = CHUNK, info = grid.info, { sx, sy, sz } = grid, data = grid.data, L = light?.data ?? null;
  const outside = grid.outside ?? null, origin = grid.origin ?? [0, 0, 0], biome = grid.biome ?? null;
  const tintBytes = grid.__tintBytes ??= (grid.tints ?? []).map(bytesOf);
  const colorBytes = grid.__colorBytes ??= info.map(I => (I?.color ? bytesOf(I.color) : null));
  const out = {};
  const bucket = k => (out[k] ??= new Bucket());
  const cell = (x, y, z) => {
    if (x >= 0 && y >= 0 && z >= 0 && x < sx && y < sy && z < sz) return data[(y * sz + z) * sx + x];
    return y < 0 ? 0 : outside ? outside(x, y, z) : 0;
  };
  const opq = v => { const b = v & 255; return b !== 0 && !!info[b]?.opaque; };
  // light of an open cell (sun, r, g, b 0-15); past the edge: sky over open cells
  const lightAt = (x, y, z) => {
    if (x >= 0 && y >= 0 && z >= 0 && x < sx && y < sy && z < sz) return L ? L[(y * sz + z) * sx + x] : 0xf000;
    return y >= 0 ? 0xf000 : 0;
  };
  const x0 = cx * C, y0 = cy * C, z0 = cz * C;
  const x1 = Math.min(sx, x0 + C), y1 = Math.min(sy, y0 + C), z1 = Math.min(sz, z0 + C);
  const ao = [0, 0, 0, 0], lt = [[0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]];
  const s1 = [0, 0, 0], s2 = [0, 0, 0], cc = [0, 0, 0];
  const ox = origin[0], oy = origin[1], oz = origin[2];
  const noTint = [0, 0, 0];
  for (let y = y0; y < y1; y++) for (let z = z0; z < z1; z++) for (let x = x0; x < x1; x++) {
    const v = data[(y * sz + z) * sx + x];
    if (!v) continue;
    const b = v & 255, I = info[b];
    if (!I || I.kind === 'none' || I.kind === 'sign') continue;
    const bc = colorBytes[b] ?? WHITE, tc = tintBytes[v >> 8] ?? noTint;
    const col = (z * sx + x) * 6;
    const bio = I.tint && biome ? (I.tint === 'foliage' ? [biome[col + 3], biome[col + 4], biome[col + 5]] : [biome[col], biome[col + 1], biome[col + 2]]) : WHITE;
    if (I.kind === 'plant') {
      const w = lightAt(x, y, z), l = [(w >> 12) * 17, ((w >> 8) & 15) * 17, ((w >> 4) & 15) * 17, (w & 15) * 17];
      plantQuads(bucket('plant'), x + ox, y + oy, z + oz, I.layers.side, bc, tc, l, bio, I.emit ? 255 : 0);
      continue;
    }
    const B = bucket(I.kind);
    const liquid = I.kind === 'liquid';
    // a liquid's surface is lowered a little unless more of it lies above
    const drop = liquid && (cell(x, y + 1, z) & 255) !== b ? LIQUID_DROP : 0;
    for (let f = 0; f < 6; f++) {
      const F = FACES[f];
      const nx = x + F.dir[0], ny = y + F.dir[1], nz = z + F.dir[2];
      if (ny < 0) continue;                       // the underside of the bottom layer is never seen
      const nv = cell(nx, ny, nz), nb = nv & 255;
      if (nb) {
        const N = info[nb];
        // a face is hidden by an opaque neighbour, or by the same see-through block (glass beside glass, leaves beside
        // leaves, water beside water); a liquid shows no face to anything solid in it (a plant, a leaf)
        if (N?.opaque || (nb === b && I.kind !== 'solid') || (liquid && N?.solid)) continue;
      }
      if (liquid && f === 2) continue;            // a liquid's underside is never drawn
      const [ta, tb] = F.tangents;
      const own = lightAt(nx, ny, nz);
      for (let k = 0; k < 4; k++) {
        const pos = F.corners[k].pos, sa = pos[ta] ? 1 : -1, sb = pos[tb] ? 1 : -1;
        s1[0] = nx; s1[1] = ny; s1[2] = nz; s1[ta] += sa;
        s2[0] = nx; s2[1] = ny; s2[2] = nz; s2[tb] += sb;
        cc[0] = nx; cc[1] = ny; cc[2] = nz; cc[ta] += sa; cc[tb] += sb;
        const o1 = opq(cell(s1[0], s1[1], s1[2])), o2 = opq(cell(s2[0], s2[1], s2[2]));
        const o3 = o1 && o2 ? true : opq(cell(cc[0], cc[1], cc[2]));   // a corner closed on both sides is never seen through
        const a = o1 ? 1 : 0, c2 = o2 ? 1 : 0, k3 = o3 ? 1 : 0;
        ao[k] = a && c2 ? 0 : 3 - (a + c2 + k3);
        // smooth light: the mean of the open cells among the face's own neighbour and the three round this corner
        let S = own >> 12, R = (own >> 8) & 15, G = (own >> 4) & 15, Bl = own & 15, n = 1;
        if (!o1) { const w = lightAt(s1[0], s1[1], s1[2]); S += w >> 12; R += (w >> 8) & 15; G += (w >> 4) & 15; Bl += w & 15; n++; }
        if (!o2) { const w = lightAt(s2[0], s2[1], s2[2]); S += w >> 12; R += (w >> 8) & 15; G += (w >> 4) & 15; Bl += w & 15; n++; }
        if (!o3) { const w = lightAt(cc[0], cc[1], cc[2]); S += w >> 12; R += (w >> 8) & 15; G += (w >> 4) & 15; Bl += w & 15; n++; }
        const m = 17 / n, t = lt[k];
        t[0] = Math.round(S * m); t[1] = Math.round(R * m); t[2] = Math.round(G * m); t[3] = Math.round(Bl * m);
      }
      const layer = I.layers[F.layer];
      const glow = I.kind === 'glow', shines = glow || I.emit ? 255 : 0;
      const base = B.count;
      for (let k = 0; k < 4; k++) {
        const { pos, uv } = F.corners[k];
        const shade = glow ? 1 : AO_CURVE[ao[k]];
        B.vertex(x + pos[0] + ox, y + pos[1] - (pos[1] ? drop : 0) + oy, z + pos[2] + oz, F.dir, bc[0] * shade, bc[1] * shade, bc[2] * shade, uv[0], uv[1], layer, tc, lt[k], bio, shines);
      }
      // flip the quad's diagonal so AO and light interpolate without the classic anisotropy artefact (Blockhaven)
      const d03 = ao[0] + ao[3] + (lt[0][0] + lt[3][0]) / 64, d12 = ao[1] + ao[2] + (lt[1][0] + lt[2][0]) / 64;
      if (d03 > d12) { B.tri(base, base + 1, base + 3); B.tri(base, base + 3, base + 2); }
      else { B.tri(base, base + 1, base + 2); B.tri(base + 2, base + 1, base + 3); }
    }
  }
  const res = {};
  for (const k of BUCKETS) if (out[k]?.count) res[k] = out[k].done();
  return res;
}

const UP = [0, 1, 0];
// a plant: two crossed quads through the cell, both sides drawn (the material is double-sided)
function plantQuads(B, x, y, z, layer, c, t, l, bio, glow = 0) {
  const quads = [[[0.15, 0, 0.15], [0.85, 0, 0.85]], [[0.85, 0, 0.15], [0.15, 0, 0.85]]];
  for (const [a, b] of quads) {
    const base = B.count;
    for (const [px, py, pz, u, vv] of [[a[0], 0, a[2], 0, 0], [b[0], 0, b[2], 1, 0], [a[0], 0.9, a[2], 0, 1], [b[0], 0.9, b[2], 1, 1]]) {
      B.vertex(x + px, y + py, z + pz, UP, c[0], c[1], c[2], u, vv, layer, t, l, bio, glow);   // lit like the ground it stands on
    }
    B.tri(base, base + 1, base + 2); B.tri(base + 2, base + 1, base + 3);
  }
}

/** Several meshChunk results as one (each kind's buffers end to end): fewer draw calls for what is never edited (the
 *  scenery) or is edited as one (a column of chunks). */
export function mergeMeshes(list) {
  const out = {};
  for (const k of BUCKETS) {
    const parts = list.map(r => r[k]).filter(b => b?.count);
    if (!parts.length) continue;
    if (parts.length === 1) { out[k] = parts[0]; continue; }
    const count = parts.reduce((n, b) => n + b.count, 0), icount = parts.reduce((n, b) => n + b.index.length, 0);
    const cat = (A, key, k1) => { const a = new A(count * k1); let o = 0; for (const b of parts) { a.set(b[key], o); o += b.count * k1; } return a; };
    const index = new (count > 65535 ? Uint32Array : Uint16Array)(icount);
    let io = 0, base = 0;
    for (const b of parts) { for (let i = 0; i < b.index.length; i++) index[io + i] = b.index[i] + base; io += b.index.length; base += b.count; }
    out[k] = { count, position: cat(Float32Array, 'position', 3), normal: cat(Int8Array, 'normal', 3), color: cat(Uint8Array, 'color', 3), uvl: cat(Uint8Array, 'uvl', 3),
      tint: cat(Uint8Array, 'tint', 3), light: cat(Uint8Array, 'light', 4), biome: cat(Uint8Array, 'biome', 3), glow: cat(Uint8Array, 'glow', 1), index };
  }
  return out;
}

/** Transferable buffers of a meshChunk result (for postMessage). */
export const transfers = res => Object.values(res).flatMap(b => [b.position, b.normal, b.color, b.uvl, b.tint, b.light, b.biome, b.glow, b.index].map(a => a.buffer));
