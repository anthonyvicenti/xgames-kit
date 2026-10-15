// gf-three smooth terrain: set pieces made ground (looks wave 4, 2026-10-14). A landmark (a castle, a fortress, a mesa)
// or a bridge the level composer places (worlds/terrain/compose.mjs) joins the terrain's own distance field, so it is
// ground like the rest: bodies stand on it and shots end on it (the chunks' trimesh colliders are its shape), the
// composer's sight lines and seats see it, and a blast carves it through the same edit log every copy replays (the
// carve mechanic: the host owns the edits, joiners and late joiners replay them). Its model is still what is drawn:
// the world clips the model where the field lost ground and draws the field's cut faces there (world.js, material.js).
//
//   trianglesOf(positions, index, matrix?)        → Float32Array, 9 numbers a triangle (a mesh's, in its own space)
//   placeTriangles(tris, {at, yaw, scale})        → the triangles where the piece stands (scale: a number or [x, y, z])
//   boundsOf(tris)                                → {min, max, size}
//   unionPiece(field, tris, {owner, own, shell})  → {box, samples}: the piece's distance joined into the field
//
// Deterministic: the same triangles give the same samples on every machine (only + - * / and Math.sqrt on Float32
// storage; a yaw's sine and cosine are rounded to a millionth, so the last bit of Math.sin never decides a sample).
//
// How a mesh becomes a distance: the exact distance to the nearest triangle for every sample within a narrow band of
// the surface (the band the mesher and the field's normals read), and inside or outside by ray parity along all three
// axes (two of three votes decide, so a mesh with a small gap still reads as solid). A part thinner than the field's
// cell (a plank deck, a flag) would fall between the samples; where no sample next to the surface is inside, the
// surface is thickened by `shell` metres, so a bridge's deck is always walkable ground.
import { BAND } from './field.mjs';

const DEG = Math.PI / 180;
const q6 = v => Math.round(v * 1e6) / 1e6;

/** A mesh's triangles (9 numbers each) from its positions (x, y, z …), an index (or null) and a 4×4 column-major matrix. */
export function trianglesOf(positions, index = null, m = null) {
  const n = index ? index.length : positions.length / 3, out = new Float32Array(n * 3);
  for (let t = 0; t < n; t++) {
    const v = index ? index[t] : t, x = positions[v * 3], y = positions[v * 3 + 1], z = positions[v * 3 + 2];
    if (m) {
      out[t * 3] = m[0] * x + m[4] * y + m[8] * z + m[12];
      out[t * 3 + 1] = m[1] * x + m[5] * y + m[9] * z + m[13];
      out[t * 3 + 2] = m[2] * x + m[6] * y + m[10] * z + m[14];
    } else { out[t * 3] = x; out[t * 3 + 1] = y; out[t * 3 + 2] = z; }
  }
  return out;
}

/** Join several triangle lists into one. */
export function joinTriangles(list) {
  const n = list.reduce((a, t) => a + t.length, 0), out = new Float32Array(n);
  let o = 0; for (const t of list) { out.set(t, o); o += t.length; }
  return out;
}

/** {min, max, size} of a triangle list. */
export function boundsOf(tris) {
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < tris.length; i += 3) for (let a = 0; a < 3; a++) { const v = tris[i + a]; if (v < min[a]) min[a] = v; if (v > max[a]) max[a] = v; }
  return { min, max, size: [max[0] - min[0], max[1] - min[1], max[2] - min[2]] };
}

/**
 * The yaw's sine and cosine as every copy computes them (rounded to a millionth): the composer, the field and the drawn
 * model all turn a piece by these.
 */
export function turn(yawDeg) { const a = (yawDeg ?? 0) * DEG; return { c: q6(Math.cos(a)), s: q6(Math.sin(a)) }; }

/**
 * Where a piece stands: scale (per axis, in its own frame), then turn by `yaw` degrees about +y (its +z toward
 * (sin yaw, 0, cos yaw)), then move to `at`. → Float32Array
 */
export function placeTriangles(tris, { at = [0, 0, 0], yaw = 0, scale = 1 } = {}) {
  const [sx, sy, sz] = typeof scale === 'number' ? [scale, scale, scale] : scale, { c, s } = turn(yaw);
  const out = new Float32Array(tris.length);
  for (let i = 0; i < tris.length; i += 3) {
    const x = tris[i] * sx, y = tris[i + 1] * sy, z = tris[i + 2] * sz;
    out[i] = x * c + z * s + at[0];
    out[i + 1] = y + at[1];
    out[i + 2] = -x * s + z * c + at[2];
  }
  return out;
}

/** The squared distance from p to the triangle (a, b, c) (Ericson, Real-Time Collision Detection 5.1.5). */
function triDist2(px, py, pz, T, o) {
  const ax = T[o], ay = T[o + 1], az = T[o + 2], bx = T[o + 3], by = T[o + 4], bz = T[o + 5], cx = T[o + 6], cy = T[o + 7], cz = T[o + 8];
  const abx = bx - ax, aby = by - ay, abz = bz - az, acx = cx - ax, acy = cy - ay, acz = cz - az;
  const apx = px - ax, apy = py - ay, apz = pz - az;
  const d1 = abx * apx + aby * apy + abz * apz, d2 = acx * apx + acy * apy + acz * apz;
  let qx, qy, qz;
  if (d1 <= 0 && d2 <= 0) { qx = ax; qy = ay; qz = az; }
  else {
    const bpx = px - bx, bpy = py - by, bpz = pz - bz;
    const d3 = abx * bpx + aby * bpy + abz * bpz, d4 = acx * bpx + acy * bpy + acz * bpz;
    if (d3 >= 0 && d4 <= d3) { qx = bx; qy = by; qz = bz; }
    else {
      const vc = d1 * d4 - d3 * d2;
      if (vc <= 0 && d1 >= 0 && d3 <= 0) { const v = d1 / (d1 - d3); qx = ax + abx * v; qy = ay + aby * v; qz = az + abz * v; }
      else {
        const cpx = px - cx, cpy = py - cy, cpz = pz - cz;
        const d5 = abx * cpx + aby * cpy + abz * cpz, d6 = acx * cpx + acy * cpy + acz * cpz;
        if (d6 >= 0 && d5 <= d6) { qx = cx; qy = cy; qz = cz; }
        else {
          const vb = d5 * d2 - d1 * d6;
          if (vb <= 0 && d2 >= 0 && d6 <= 0) { const w = d2 / (d2 - d6); qx = ax + acx * w; qy = ay + acy * w; qz = az + acz * w; }
          else {
            const va = d3 * d6 - d5 * d4;
            if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) { const w = (d4 - d3) / ((d4 - d3) + (d5 - d6)); qx = bx + (cx - bx) * w; qy = by + (cy - by) * w; qz = bz + (cz - bz) * w; }
            else { const den = 1 / (va + vb + vc), v = vb * den, w = vc * den; qx = ax + abx * v + acx * w; qy = ay + aby * v + acy * w; qz = az + abz * v + acz * w; }
          }
        }
      }
    }
  }
  const dx = px - qx, dy = py - qy, dz = pz - qz;
  return dx * dx + dy * dy + dz * dz;
}

// rays are nudged off the sample lines by these (fractions of a cell), so a ray never runs exactly through an edge or a
// vertex of a mesh made on a grid (which would count one crossing twice)
const NUDGE = [0.01234567, 0.02345678];

/**
 * Inside votes along one axis: for every line of samples along `axis` in the box, the triangles crossing it, the
 * crossings sorted, and each sample inside when an odd number lie below it. votes[local index] += 1 when inside.
 */
function parity(tris, axis, G, votes) {
  const { i0, j0, k0, ni, nj, nk, h, O } = G;
  // the two other axes (u, v) span the lines; lines are (u index, v index)
  const U = axis === 0 ? 1 : 0, V = axis === 2 ? 1 : 2;
  const nU = [ni, nj, nk][U], nV = [ni, nj, nk][V], nA = [ni, nj, nk][axis], s0 = [i0, j0, k0];
  const bins = Array.from({ length: nU * nV }, () => []);
  const lu = n => O[U] + (s0[U] + n + NUDGE[0]) * h, lv = n => O[V] + (s0[V] + n + NUDGE[1]) * h;
  for (let o = 0; o < tris.length; o += 9) {
    let umin = Infinity, umax = -Infinity, vmin = Infinity, vmax = -Infinity;
    for (let p = 0; p < 3; p++) { const u = tris[o + p * 3 + U], v = tris[o + p * 3 + V]; if (u < umin) umin = u; if (u > umax) umax = u; if (v < vmin) vmin = v; if (v > vmax) vmax = v; }
    const a0 = Math.max(0, Math.ceil((umin - O[U]) / h - s0[U] - NUDGE[0])), a1 = Math.min(nU - 1, Math.floor((umax - O[U]) / h - s0[U] - NUDGE[0]));
    const b0 = Math.max(0, Math.ceil((vmin - O[V]) / h - s0[V] - NUDGE[1])), b1 = Math.min(nV - 1, Math.floor((vmax - O[V]) / h - s0[V] - NUDGE[1]));
    for (let b = b0; b <= b1; b++) for (let a = a0; a <= a1; a++) bins[b * nU + a].push(o);
  }
  const hits = [];
  for (let b = 0; b < nV; b++) for (let a = 0; a < nU; a++) {
    const list = bins[b * nU + a];
    if (!list.length) continue;
    const pu = lu(a), pv = lv(b);
    hits.length = 0;
    for (const o of list) {
      const au = tris[o + U], av = tris[o + V], bu = tris[o + 3 + U], bv = tris[o + 3 + V], cu = tris[o + 6 + U], cv = tris[o + 6 + V];
      // edge functions of the line's point against the triangle's shadow on the (u, v) plane
      const e0 = (bu - au) * (pv - av) - (bv - av) * (pu - au);
      const e1 = (cu - bu) * (pv - bv) - (cv - bv) * (pu - bu);
      const e2 = (au - cu) * (pv - cv) - (av - cv) * (pu - cu);
      if (!((e0 >= 0 && e1 >= 0 && e2 >= 0) || (e0 <= 0 && e1 <= 0 && e2 <= 0))) continue;
      const area = e0 + e1 + e2;
      if (area === 0) continue;
      // barycentric weights: e1 belongs to a, e2 to b, e0 to c
      hits.push((e1 * tris[o + axis] + e2 * tris[o + 3 + axis] + e0 * tris[o + 6 + axis]) / area);
    }
    if (!hits.length) continue;
    hits.sort((x, y) => x - y);
    let n = 0;
    for (let c = 0; c < nA; c++) {
      const at = O[axis] + (s0[axis] + c) * h;
      while (n < hits.length && hits[n] < at) n++;
      if (n & 1) {
        const loc = [0, 0, 0]; loc[axis] = c; loc[U] = a; loc[V] = b;
        votes[(loc[1] * nk + loc[2]) * ni + loc[0]]++;
      }
    }
  }
}

/**
 * Join a placed piece's triangles into the field (union: the lower distance wins). Samples that were air in the land
 * and are the piece's ground are marked `owner` in `own` (a Uint8Array as long as the field), so the mesher and the
 * world can tell the piece's surface from the land's. shell: metres a surface too thin for the cell is thickened by.
 * → {box: {min: [i, j, k], max: [i, j, k]} (the samples it may have changed), samples: how many it made ground}
 */
export function unionPiece(field, tris, { owner = 1, own = null, shell = null } = {}) {
  const h = field.cell, O = field.origin, { nx, ny, nz, d } = field;
  const thick = shell ?? h * 0.55, reach = thick + h * 2;
  const B = boundsOf(tris);
  const i0 = Math.max(1, Math.floor((B.min[0] - reach - O[0]) / h)), i1 = Math.min(nx - 2, Math.ceil((B.max[0] + reach - O[0]) / h));
  const j0 = Math.max(1, Math.floor((B.min[1] - reach - O[1]) / h)), j1 = Math.min(ny - 2, Math.ceil((B.max[1] + reach - O[1]) / h));
  const k0 = Math.max(1, Math.floor((B.min[2] - reach - O[2]) / h)), k1 = Math.min(nz - 2, Math.ceil((B.max[2] + reach - O[2]) / h));
  if (i0 > i1 || j0 > j1 || k0 > k1) return { box: null, samples: 0 };
  const ni = i1 - i0 + 1, nj = j1 - j0 + 1, nk = k1 - k0 + 1, N = ni * nj * nk;
  const G = { i0, j0, k0, ni, nj, nk, h, O };
  // the exact distance to the surface, within `reach` of it
  const udf = new Float32Array(N).fill(Infinity);
  for (let o = 0; o < tris.length; o += 9) {
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity, z0 = Infinity, z1 = -Infinity;
    for (let p = 0; p < 9; p += 3) {
      const x = tris[o + p], y = tris[o + p + 1], z = tris[o + p + 2];
      if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; if (z < z0) z0 = z; if (z > z1) z1 = z;
    }
    const a0 = Math.max(i0, Math.ceil((x0 - reach - O[0]) / h)), a1 = Math.min(i1, Math.floor((x1 + reach - O[0]) / h));
    const b0 = Math.max(j0, Math.ceil((y0 - reach - O[1]) / h)), b1 = Math.min(j1, Math.floor((y1 + reach - O[1]) / h));
    const c0 = Math.max(k0, Math.ceil((z0 - reach - O[2]) / h)), c1 = Math.min(k1, Math.floor((z1 + reach - O[2]) / h));
    for (let j = b0; j <= b1; j++) {
      const py = O[1] + j * h;
      for (let k = c0; k <= c1; k++) {
        const pz = O[2] + k * h;
        let at = ((j - j0) * nk + (k - k0)) * ni + (a0 - i0);
        for (let i = a0; i <= a1; i++, at++) {
          const q = triDist2(O[0] + i * h, py, pz, tris, o);
          if (q < udf[at]) udf[at] = q;
        }
      }
    }
  }
  for (let a = 0; a < N; a++) if (udf[a] !== Infinity) udf[a] = Math.sqrt(udf[a]);
  // inside: two of the three axes' parity say so
  const votes = new Uint8Array(N);
  for (const axis of [0, 1, 2]) parity(tris, axis, G, votes);
  const inside = a => votes[a] >= 2;
  // a surface no inside sample touches (a plank, a flag, a thin wall between samples) is thickened by the shell
  const thin = new Uint8Array(N);
  for (let j = 0; j < nj; j++) for (let k = 0; k < nk; k++) for (let i = 0; i < ni; i++) {
    const a = (j * nk + k) * ni + i;
    if (inside(a) || !(udf[a] < h * 1.5)) continue;
    let near = false;
    for (let dj = -1; dj <= 1 && !near; dj++) for (let dk = -1; dk <= 1 && !near; dk++) for (let di = -1; di <= 1; di++) {
      const ii = i + di, jj = j + dj, kk = k + dk;
      if (ii < 0 || jj < 0 || kk < 0 || ii >= ni || jj >= nj || kk >= nk) continue;
      if (inside((jj * nk + kk) * ni + ii)) { near = true; break; }
    }
    if (!near) thin[a] = 1;
  }
  let samples = 0;
  for (let j = 0; j < nj; j++) for (let k = 0; k < nk; k++) {
    let a = (j * nk + k) * ni, g = ((j + j0) * nz + (k + k0)) * nx + i0;
    for (let i = 0; i < ni; i++, a++, g++) {
      const u = udf[a];
      let v;
      if (inside(a)) v = u === Infinity ? -BAND : -u;
      else if (u === Infinity) continue;                          // far outside: the land's value stands
      else v = thin[a] ? u - thick : u;
      const land = d[g];
      if (!(v < land)) continue;
      d[g] = Math.fround(v < -BAND ? -BAND : v > BAND ? BAND : v);
      if (v < 0 && land >= 0) { samples++; if (own) own[g] = owner; }
    }
  }
  return { box: { min: [i0, j0, k0], max: [i1, j1, k1] }, samples };
}
