// paint: the pure logic (no three.js, no DOM): an owner grid over the play area. Cheap by design (a few hundred cells,
// not a render target), so the host can own it and send it in a few hundred bytes (run-length encoded).
// Node tests: research/gf-three/tests/k2-paint.test.mjs.

/** Grid over [minX, maxX] × [minZ, maxZ]: cells of about `cell` metres, at most `maxCells` of them. */
export function createGrid(area, cell = 1, maxCells = 400) {
  const W = Math.max(1, area.maxX - area.minX), H = Math.max(1, area.maxZ - area.minZ);
  const c = Math.max(cell, Math.sqrt(W * H / maxCells));
  const w = Math.max(1, Math.round(W / c)), h = Math.max(1, Math.round(H / c));
  const owners = new Uint8Array(w * h);           // 0 unpainted, k = owner index + 1 (1..26)
  const cw = W / w, ch = H / h;
  const cellAt = (x, z) => { const i = Math.floor((x - area.minX) / cw), j = Math.floor((z - area.minZ) / ch); return i < 0 || j < 0 || i >= w || j >= h ? -1 : j * w + i; };
  return {
    w, h, cw, ch, owners, area,
    cellAt,
    centre: n => ({ x: area.minX + ((n % w) + 0.5) * cw, z: area.minZ + (Math.floor(n / w) + 0.5) * ch }),
    /** Paint every cell whose centre is within `radius` of (x, z) with owner `k` (0-based). → number of cells that changed owner */
    splat(x, z, radius, k, { repaint = true } = {}) {
      let changed = 0;
      const i0 = Math.max(0, Math.floor((x - radius - area.minX) / cw)), i1 = Math.min(w - 1, Math.floor((x + radius - area.minX) / cw));
      const j0 = Math.max(0, Math.floor((z - radius - area.minZ) / ch)), j1 = Math.min(h - 1, Math.floor((z + radius - area.minZ) / ch));
      for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
        const cx = area.minX + (i + 0.5) * cw, cz = area.minZ + (j + 0.5) * ch;
        if ((cx - x) ** 2 + (cz - z) ** 2 > radius * radius + 1e-9) continue;
        const n = j * w + i;
        if (owners[n] === k + 1 || (owners[n] !== 0 && !repaint)) continue;
        owners[n] = k + 1; changed++;
      }
      // a splat smaller than a cell still paints the cell it lands in
      if (!changed) { const n = cellAt(x, z); if (n >= 0 && owners[n] !== k + 1 && (owners[n] === 0 || repaint)) { owners[n] = k + 1; changed = 1; } }
      return changed;
    },
    /** Cells per owner index → { [k]: count }; `mask` (optional, cell → bool) restricts to some cells. */
    counts(mask = null) { const out = {}; for (let n = 0; n < owners.length; n++) if (owners[n] && (!mask || mask(n))) out[owners[n] - 1] = (out[owners[n] - 1] ?? 0) + 1; return out; },
    painted() { let c = 0; for (const o of owners) if (o) c++; return c; },
    clear() { owners.fill(0); },
    fill(k) { owners.fill(k + 1); },
    encode: () => encode(owners),
    decode(str) { return decode(str, owners); },
  };
}

const CH = '.abcdefghijklmnopqrstuvwxyz';
/** Run-length string: a letter per owner ('.' none, 'a' owner 0 …), then the run length when above 1 ("a12.40b"). */
export function encode(owners) {
  let out = '', i = 0;
  while (i < owners.length) {
    const o = owners[i]; let n = 1;
    while (i + n < owners.length && owners[i + n] === o) n++;
    out += CH[o] + (n > 1 ? n : ''); i += n;
  }
  return out;
}
/** Fill `owners` from an encoded string (cells beyond the string stay as they are). → true when the string was well formed */
export function decode(str, owners) {
  let i = 0, p = 0;
  owners.fill(0);
  while (p < str.length) {
    const o = CH.indexOf(str[p++]); if (o < 0) return false;
    let n = 0, digits = false;
    while (p < str.length && str[p] >= '0' && str[p] <= '9') { n = n * 10 + (str.charCodeAt(p++) - 48); digits = true; }
    if (!digits) n = 1;
    if (i + n > owners.length) return false;
    owners.fill(o, i, i + n); i += n;
  }
  return i === owners.length;
}

/** Who holds the most cells in a count map → {owner, share} (share of `total` cells), or null when empty. Ties go to the lower index. */
export function leaderOf(counts, total) {
  let best = null;
  for (const [k, c] of Object.entries(counts)) if (!best || c > best.cells || (c === best.cells && Number(k) < best.owner)) best = { owner: Number(k), cells: c };
  return best ? { owner: best.owner, share: total ? best.cells / total : 0, cells: best.cells } : null;
}

/** A soft 4× upsample for drawing: RGBA bytes (w*4 × h*4) where alpha is the bilinear presence of painted cells, thresholded. */
export function rasterize(owners, w, h, colorOf, { scale = 4, alpha = 0.85 } = {}) {
  const W = w * scale, H = h * scale, out = new Uint8Array(W * H * 4);
  const at = (i, j) => (i < 0 || j < 0 || i >= w || j >= h ? 0 : owners[j * w + i]);
  for (let ty = 0; ty < H; ty++) {
    const v = (ty + 0.5) / scale - 0.5, j0 = Math.floor(v), fy = v - j0;
    for (let tx = 0; tx < W; tx++) {
      const u = (tx + 0.5) / scale - 0.5, i0 = Math.floor(u), fx = u - i0;
      const c = [[at(i0, j0), (1 - fx) * (1 - fy)], [at(i0 + 1, j0), fx * (1 - fy)], [at(i0, j0 + 1), (1 - fx) * fy], [at(i0 + 1, j0 + 1), fx * fy]];
      let a = 0, best = 0, bw = -1;
      for (const [o, wt] of c) { if (o) { a += wt; if (wt > bw) { bw = wt; best = o; } } }
      const s = Math.max(0, Math.min(1, (a - 0.35) / 0.3));
      const k = (ty * W + tx) * 4;
      if (s > 0 && best) { const rgb = colorOf(best - 1); out[k] = rgb[0]; out[k + 1] = rgb[1]; out[k + 2] = rgb[2]; out[k + 3] = Math.round(255 * alpha * s); }
    }
  }
  return { data: out, width: W, height: H };
}
