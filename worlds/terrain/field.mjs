// gf-three smooth terrain: the field. A signed distance over a bounded box of samples (negative inside the ground,
// positive in the air), sampled every `cell` metres. Edits are spheres cut out of it (carve) or added to it (add), applied
// in order; the same generator, seed and edit list give the same numbers on every machine (only + - * / and Math.sqrt,
// which IEEE 754 rounds the same everywhere, on Float32 storage).
//
//   const f = new TerrainField({ size: [nx, ny, nz], cell: 0.5, origin: [x0, y0, z0] })
//   f.sample(x, y, z)         the field at a point in metres (trilinear)
//   f.normal(x, y, z)         the outward surface direction there (the field's gradient, normalised)
//   f.apply(edit)             an edit [op, x, y, z, r] (EDIT below) → the changed sample box {min, max} or null
//   f.chunksOf(box)           the chunks whose mesh that box changes, as [cx, cy, cz]
//
// The outermost layer of samples is always air, so the ground closes inside the box and no edit can open it.

/** Chunks are 16 cells a side (8 m at the default 0.5 m cell). */
export const CHUNK = 16;
/** How far from the surface a sample keeps its distance (m); past it the field is clamped (an edit reaches no further). */
export const BAND = 4;
/**
 * An edit on the wire and in the log: [op, x, y, z, r], op 0 = carve (a crater), 1 = add (a lump of ground); x, y, z and
 * r in centimetres (integers), so every copy applies exactly the same numbers.
 */
export const EDIT = { carve: 0, add: 1 };
const MAX_R = 2000;   // 20 m: the largest edit taken

/** An edit from metres → the wire form (rounded to the centimetre), or null when it is not one. */
export function editOf(op, at, r) {
  const o = typeof op === 'string' ? EDIT[op] : op;
  const x = Math.round(at.x * 100), y = Math.round(at.y * 100), z = Math.round(at.z * 100), rr = Math.round(r * 100);
  if ((o !== 0 && o !== 1) || ![x, y, z, rr].every(Number.isFinite) || rr <= 0) return null;
  return [o, x, y, z, Math.min(MAX_R, rr)];
}
/** Is this a well-formed edit (from the net: never trusted)? */
export const isEdit = e => Array.isArray(e) && e.length === 5 && (e[0] === 0 || e[0] === 1) && e.slice(1).every(Number.isInteger) && e[4] > 0 && e[4] <= MAX_R && e.slice(1, 4).every(v => Math.abs(v) < 1e7);

export class TerrainField {
  constructor({ size, cell = 0.5, origin = [0, 0, 0], data = null }) {
    this.size = size.map(n => Math.max(3, n | 0));
    const [nx, ny, nz] = this.size;
    this.nx = nx; this.ny = ny; this.nz = nz;
    this.cell = cell; this.origin = origin.slice();
    this.d = data ?? new Float32Array(nx * ny * nz).fill(BAND);
    // chunk counts: chunk c owns the edges whose first sample is in [c·N, c·N + N)
    this.cx = Math.ceil((nx - 1) / CHUNK); this.cy = Math.ceil((ny - 1) / CHUNK); this.cz = Math.ceil((nz - 1) / CHUNK);
  }
  index(i, j, k) { return (j * this.nz + k) * this.nx + i; }
  at(i, j, k) {
    if (i < 0 || j < 0 || k < 0 || i >= this.nx || j >= this.ny || k >= this.nz) return BAND;
    return this.d[(j * this.nz + k) * this.nx + i];
  }
  /** The box in metres: {min: [x, y, z], max: [x, y, z]}. */
  get bounds() {
    const o = this.origin, h = this.cell;
    return { min: o.slice(), max: [o[0] + (this.nx - 1) * h, o[1] + (this.ny - 1) * h, o[2] + (this.nz - 1) * h] };
  }
  /** The field at a point (metres), trilinear; outside the box it is air. */
  sample(x, y, z) {
    const h = this.cell, fx = (x - this.origin[0]) / h, fy = (y - this.origin[1]) / h, fz = (z - this.origin[2]) / h;
    if (!(fx >= 0 && fy >= 0 && fz >= 0 && fx <= this.nx - 1 && fy <= this.ny - 1 && fz <= this.nz - 1)) return BAND;
    const i = Math.min(this.nx - 2, Math.floor(fx)), j = Math.min(this.ny - 2, Math.floor(fy)), k = Math.min(this.nz - 2, Math.floor(fz));
    const u = fx - i, v = fy - j, w = fz - k, nx = this.nx, row = nx * this.nz, d = this.d;
    const a = (j * this.nz + k) * nx + i;
    const c00 = d[a] + (d[a + 1] - d[a]) * u, c10 = d[a + nx] + (d[a + nx + 1] - d[a + nx]) * u;
    const c01 = d[a + row] + (d[a + row + 1] - d[a + row]) * u, c11 = d[a + row + nx] + (d[a + row + nx + 1] - d[a + row + nx]) * u;
    const c0 = c00 + (c10 - c00) * w, c1 = c01 + (c11 - c01) * w;
    return c0 + (c1 - c0) * v;
  }
  /** The outward surface direction at a point: the field's gradient by central differences a cell wide, normalised. */
  normal(x, y, z, out = [0, 1, 0]) {
    const e = this.cell;
    const gx = this.sample(x + e, y, z) - this.sample(x - e, y, z);
    const gy = this.sample(x, y + e, z) - this.sample(x, y - e, z);
    const gz = this.sample(x, y, z + e) - this.sample(x, y, z - e);
    const l = Math.sqrt(gx * gx + gy * gy + gz * gz);
    if (l < 1e-9) { out[0] = 0; out[1] = 1; out[2] = 0; return out; }
    out[0] = gx / l; out[1] = gy / l; out[2] = gz / l;
    return out;
  }
  /** Is the point inside the ground? */
  solid(x, y, z) { return this.sample(x, y, z) < 0; }
  /**
   * The ground's top under (x, z): the highest point where the field turns from air to ground, searching down from
   * `from` (the box's top). → y, or null over open water or outside the box.
   */
  heightAt(x, z, from = Infinity) {
    const h = this.cell, top = Math.min(from, this.origin[1] + (this.ny - 1) * h);
    let prev = this.sample(x, top, z);
    for (let yy = top - h; yy >= this.origin[1]; yy -= h) {
      const v = this.sample(x, yy, z);
      if (v < 0 && prev >= 0) return yy + h * (v / (v - prev));
      prev = v;
    }
    return null;
  }
  /**
   * A ray against the surface (metres): steps a third of a cell, then bisects the crossing. Agrees with the mesh to a
   * few centimetres (the mesh's vertices sit on the same crossings). → {distance, point: [x, y, z], normal} | null
   */
  raycast(from, dir, max = 200) {
    const l = Math.hypot(dir[0], dir[1], dir[2]) || 1, d = [dir[0] / l, dir[1] / l, dir[2] / l];
    const step = this.cell / 3;
    let t0 = 0;
    if (this.sample(from[0], from[1], from[2]) < 0) return { distance: 0, point: from.slice(), normal: this.normal(from[0], from[1], from[2]) };
    for (let t = step; t <= max + step; t += step) {
      const tt = Math.min(t, max), v = this.sample(from[0] + d[0] * tt, from[1] + d[1] * tt, from[2] + d[2] * tt);
      if (v < 0) {
        let a = t0, b = tt;
        for (let n = 0; n < 12; n++) {
          const m = (a + b) / 2;
          if (this.sample(from[0] + d[0] * m, from[1] + d[1] * m, from[2] + d[2] * m) < 0) b = m; else a = m;
        }
        const p = [from[0] + d[0] * b, from[1] + d[1] * b, from[2] + d[2] * b];
        return { distance: b, point: p, normal: this.normal(p[0], p[1], p[2]) };
      }
      // far from the surface: skip ahead by half the field's value (the generated field is near a distance, never far over it)
      t0 = tt;
      if (v > this.cell * 2 && v < BAND) t += (v - this.cell * 2) * 0.5;
      if (tt >= max) break;
    }
    return null;
  }

  /** Apply one edit ([op, x, y, z, r] in centimetres). → the changed samples {min: [i, j, k], max: [i, j, k]} or null. */
  apply(e) {
    if (!isEdit(e)) return null;
    const [op, X, Y, Z, R] = e, cx = X / 100, cy = Y / 100, cz = Z / 100, r = R / 100;
    const h = this.cell, o = this.origin, reach = r + h;
    const i0 = Math.max(1, Math.floor((cx - reach - o[0]) / h)), i1 = Math.min(this.nx - 2, Math.ceil((cx + reach - o[0]) / h));
    const j0 = Math.max(1, Math.floor((cy - reach - o[1]) / h)), j1 = Math.min(this.ny - 2, Math.ceil((cy + reach - o[1]) / h));
    const k0 = Math.max(1, Math.floor((cz - reach - o[2]) / h)), k1 = Math.min(this.nz - 2, Math.ceil((cz + reach - o[2]) / h));
    if (i0 > i1 || j0 > j1 || k0 > k1) return null;
    const d = this.d;
    let changed = false;
    for (let j = j0; j <= j1; j++) {
      const y = o[1] + j * h - cy;
      for (let k = k0; k <= k1; k++) {
        const z = o[2] + k * h - cz;
        let a = (j * this.nz + k) * this.nx + i0;
        for (let i = i0; i <= i1; i++, a++) {
          const x = o[0] + i * h - cx;
          const s = Math.sqrt(x * x + y * y + z * z) - r;       // the sphere's own distance (negative inside it)
          const was = d[a];
          // carve: what is inside the sphere becomes air; add: what is inside becomes ground (clamped to the band)
          const v = op === 0 ? Math.max(was, Math.min(BAND, -s)) : Math.min(was, Math.max(-BAND, s));
          const f = Math.fround(v);
          if (f !== was) { d[a] = f; changed = true; }
        }
      }
    }
    return changed ? { min: [i0, j0, k0], max: [i1, j1, k1] } : null;
  }
  /** Every chunk [cx, cy, cz] whose mesh reads a sample in the box (a chunk reads one sample past each side). */
  chunksOf(box) {
    if (!box) return [];
    const out = [], N = CHUNK;
    const lo = a => Math.max(0, Math.ceil((box.min[a] - N) / N)), hi = (a, n) => Math.min(n - 1, Math.floor((box.max[a] + 1) / N));
    for (let y = lo(1); y <= hi(1, this.cy); y++) for (let z = lo(2); z <= hi(2, this.cz); z++) for (let x = lo(0); x <= hi(0, this.cx); x++) out.push([x, y, z]);
    return out;
  }
  /** Air on the outermost layer of samples: the ground always closes inside the box. */
  sealEdges() {
    const { nx, ny, nz, d } = this;
    for (let j = 0; j < ny; j++) for (let k = 0; k < nz; k++) for (let i = 0; i < nx; i++) {
      if (i === 0 || j === 0 || k === 0 || i === nx - 1 || j === ny - 1 || k === nz - 1) d[(j * nz + k) * nx + i] = BAND;
    }
  }
}
