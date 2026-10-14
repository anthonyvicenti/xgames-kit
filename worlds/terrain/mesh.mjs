// gf-three smooth terrain: the mesher. Surface nets (S. F. F. Gibson, "Constrained elastic surface nets", 1998; the
// naive form as M. Lysenko describes it, written here from that description): one vertex in every cell the surface
// crosses, at the mean of the crossings on its twelve edges, and one quad across every sample edge the surface crosses,
// joining the four cells round it. Normals are the field's own gradient at each vertex, so lighting is smooth and the
// same on both sides of a chunk seam (the two chunks compute the same vertex from the same samples).
//
//   meshChunk(field, cx, cy, cz, { top, orig }) → { position, normal, ter, index } typed arrays (empty: position.length 0)
//     ter (2 per vertex): [depth below the ground's original top (m), how far inside the original ground the vertex is
//     (m, 0 on an untouched surface)]: the material paints the top surface, the cut faces and the soil's layers by them.
import { CHUNK, BAND } from './field.mjs';
import { topAt } from './generate.mjs';

// the twelve edges of a cell, as pairs of corner numbers (corner bit 0 = +x, bit 1 = +y, bit 2 = +z)
const EDGES = [[0, 1], [2, 3], [4, 5], [6, 7], [0, 2], [1, 3], [4, 6], [5, 7], [0, 4], [1, 5], [2, 6], [3, 7]];
/** Original-ground sampling: an Int8 copy of the generated field (field values × ORIG_SCALE, clamped). */
export const ORIG_SCALE = 63.5 / 2;

/** An Int8 copy of a field's values (±2 m), kept to tell a cut face from the ground as it was made. */
export function origOf(field) {
  const o = new Int8Array(field.d.length), d = field.d;
  for (let i = 0; i < d.length; i++) o[i] = Math.max(-127, Math.min(127, Math.round(d[i] * ORIG_SCALE)));
  return o;
}
function sampleOrig(field, orig, x, y, z) {
  const h = field.cell, fx = (x - field.origin[0]) / h, fy = (y - field.origin[1]) / h, fz = (z - field.origin[2]) / h;
  const i = Math.max(0, Math.min(field.nx - 2, Math.floor(fx))), j = Math.max(0, Math.min(field.ny - 2, Math.floor(fy))), k = Math.max(0, Math.min(field.nz - 2, Math.floor(fz)));
  const u = fx - i, v = fy - j, w = fz - k, nx = field.nx, row = nx * field.nz;
  const a = (j * field.nz + k) * nx + i, o = orig;
  const c00 = o[a] + (o[a + 1] - o[a]) * u, c10 = o[a + nx] + (o[a + nx + 1] - o[a + nx]) * u;
  const c01 = o[a + row] + (o[a + row + 1] - o[a + row]) * u, c11 = o[a + row + nx] + (o[a + row + nx + 1] - o[a + row + nx]) * u;
  const c0 = c00 + (c10 - c00) * w, c1 = c01 + (c11 - c01) * w;
  return (c0 + (c1 - c0) * v) / ORIG_SCALE;
}

/** Mesh one chunk. The chunk owns the sample edges whose first sample is in [c·N, c·N + N) on each axis. */
export function meshChunk(field, cx, cy, cz, { top = null, orig = null } = {}) {
  const N = CHUNK, { nx, ny, nz, d, cell: h, origin: O } = field;
  const x0 = cx * N, y0 = cy * N, z0 = cz * N;
  // cells [c·N − 1, c·N + N − 1] on each axis: L a side (vertex slots), cell (i, j, k) at slot (i − x0 + 1, ...)
  const L = N + 1;
  const slot = new Int32Array(L * L * L).fill(-1);
  const pos = [], nor = [], ter = [], idx = [];
  const cv = new Float64Array(8), nrm = [0, 1, 0];
  const at = (i, j, k) => d[(j * nz + k) * nx + i];
  // vertices
  for (let j = y0 - 1; j <= y0 + N - 1; j++) {
    if (j < 0 || j > ny - 2) continue;
    for (let k = z0 - 1; k <= z0 + N - 1; k++) {
      if (k < 0 || k > nz - 2) continue;
      for (let i = x0 - 1; i <= x0 + N - 1; i++) {
        if (i < 0 || i > nx - 2) continue;
        let mask = 0;
        for (let c = 0; c < 8; c++) { const v = at(i + (c & 1), j + ((c >> 1) & 1), k + ((c >> 2) & 1)); cv[c] = v; if (v < 0) mask |= 1 << c; }
        if (mask === 0 || mask === 255) continue;
        let sx = 0, sy = 0, sz = 0, n = 0;
        for (const [a, b] of EDGES) {
          const va = cv[a], vb = cv[b];
          if ((va < 0) === (vb < 0)) continue;
          const t = va / (va - vb);
          sx += (a & 1) + ((b & 1) - (a & 1)) * t;
          sy += ((a >> 1) & 1) + (((b >> 1) & 1) - ((a >> 1) & 1)) * t;
          sz += ((a >> 2) & 1) + (((b >> 2) & 1) - ((a >> 2) & 1)) * t;
          n++;
        }
        const px = O[0] + (i + sx / n) * h, py = O[1] + (j + sy / n) * h, pz = O[2] + (k + sz / n) * h;
        slot[((j - y0 + 1) * L + (k - z0 + 1)) * L + (i - x0 + 1)] = pos.length / 3;
        pos.push(px, py, pz);
        field.normal(px, py, pz, nrm);
        nor.push(nrm[0], nrm[1], nrm[2]);
        const depth = top ? topAt(field, top, px, pz) - py : 0;
        const cut = orig ? Math.max(0, -sampleOrig(field, orig, px, py, pz)) : 0;
        ter.push(Math.max(-1, Math.min(60, depth)), Math.min(BAND, cut));
      }
    }
  }
  if (!pos.length) return empty();
  const S = (i, j, k) => (i < x0 - 1 || j < y0 - 1 || k < z0 - 1 || i > x0 + N - 1 || j > y0 + N - 1 || k > z0 + N - 1) ? -1 : slot[((j - y0 + 1) * L + (k - z0 + 1)) * L + (i - x0 + 1)];
  const quad = (a, b, c, e, flip) => {
    if (a < 0 || b < 0 || c < 0 || e < 0) return;
    // split along the shorter diagonal (fewer slivers on curved ground)
    const dac = dist2(pos, a, c), dbe = dist2(pos, b, e);
    if (dac <= dbe) { if (flip) idx.push(a, c, b, a, e, c); else idx.push(a, b, c, a, c, e); }
    else { if (flip) idx.push(a, e, b, b, e, c); else idx.push(a, b, e, b, c, e); }
  };
  // quads: every sample edge the chunk owns that the surface crosses
  for (let j = y0; j < y0 + N; j++) {
    if (j > ny - 1) break;
    for (let k = z0; k < z0 + N; k++) {
      if (k > nz - 1) break;
      for (let i = x0; i < x0 + N; i++) {
        if (i > nx - 1) break;
        const v = at(i, j, k), inside = v < 0;
        // along x: the cells (i, j−1..j, k−1..k)
        if (i < nx - 1 && j >= 1 && k >= 1 && j <= ny - 2 && k <= nz - 2 && inside !== (at(i + 1, j, k) < 0))
          quad(S(i, j - 1, k - 1), S(i, j, k - 1), S(i, j, k), S(i, j - 1, k), !inside);
        // along y: the cells (i−1..i, j, k−1..k)
        if (j < ny - 1 && i >= 1 && k >= 1 && i <= nx - 2 && k <= nz - 2 && inside !== (at(i, j + 1, k) < 0))
          quad(S(i - 1, j, k - 1), S(i - 1, j, k), S(i, j, k), S(i, j, k - 1), !inside);
        // along z: the cells (i−1..i, j−1..j, k)
        if (k < nz - 1 && i >= 1 && j >= 1 && i <= nx - 2 && j <= ny - 2 && inside !== (at(i, j, k + 1) < 0))
          quad(S(i - 1, j - 1, k), S(i, j - 1, k), S(i, j, k), S(i - 1, j, k), !inside);
      }
    }
  }
  if (!idx.length) return empty();
  // only the vertices the quads use (a chunk computes a ring of its neighbours' cells to join to them)
  const remap = new Int32Array(pos.length / 3).fill(-1);
  let n = 0;
  for (const v of idx) if (remap[v] < 0) remap[v] = n++;
  const position = new Float32Array(n * 3), normal = new Float32Array(n * 3), terOut = new Float32Array(n * 2);
  for (let v = 0; v < remap.length; v++) {
    const r = remap[v]; if (r < 0) continue;
    position[r * 3] = pos[v * 3]; position[r * 3 + 1] = pos[v * 3 + 1]; position[r * 3 + 2] = pos[v * 3 + 2];
    normal[r * 3] = nor[v * 3]; normal[r * 3 + 1] = nor[v * 3 + 1]; normal[r * 3 + 2] = nor[v * 3 + 2];
    terOut[r * 2] = ter[v * 2]; terOut[r * 2 + 1] = ter[v * 2 + 1];
  }
  const index = n > 65535 ? new Uint32Array(idx.length) : new Uint16Array(idx.length);
  for (let q = 0; q < idx.length; q++) index[q] = remap[idx[q]];
  return { position, normal, ter: terOut, index };
}

const dist2 = (p, a, b) => (p[a * 3] - p[b * 3]) ** 2 + (p[a * 3 + 1] - p[b * 3 + 1]) ** 2 + (p[a * 3 + 2] - p[b * 3 + 2]) ** 2;
const empty = () => ({ position: new Float32Array(0), normal: new Float32Array(0), ter: new Float32Array(0), index: new Uint16Array(0) });
/** The buffers of a mesh result, to transfer from a worker. */
export const transfers = r => [r.position.buffer, r.normal.buffer, r.ter.buffer, r.index.buffer];
