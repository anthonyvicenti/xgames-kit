// paint.mjs: the small pixel painter the pixel kind's own art is made with (folk.mjs: the villagers; town.mjs: the
// ground, the dressing, the props and the set pieces). Plain Node, no dependency: a picture is { width, height, data }
// of straight RGBA bytes (builder/art/png.mjs reads and writes it).
//
// A picture is painted in ROLES first, not colours: every texel holds a material and a shade ('skin:1', 'hair:3'), so
// one drawing is many people (a palette swap), and the outline is worked out from what it borders. Then `toRgba`
// turns the roles into colours through a palette of ramps: { skin: ['#light', '#base', '#shade', '#line'], … }.
//
// The rules of the kind (kinds/pixel.json, runtimes/three/profiles/flat-2d/ART-STANDARD.md): hard texels (alpha 0 or
// 255), at most 32 colours a picture, a dark one-texel outline around bodies and props, light from the top left.

/** A grid of roles, w × h; null is see-through. */
export class Roles {
  constructor(w, h) { this.w = w; this.h = h; this.r = new Array(w * h).fill(null); }
  get(x, y) { return x < 0 || y < 0 || x >= this.w || y >= this.h ? null : this.r[y * this.w + x]; }
  set(x, y, v) { if (x >= 0 && y >= 0 && x < this.w && y < this.h) this.r[y * this.w + x] = v; }
  clone() { const c = new Roles(this.w, this.h); c.r = this.r.slice(); return c; }
  /** Draw a grid of letters with its top-left at (x0, y0). key: letter → role (or a function (x, y) → role); '.' and
   *  space are left alone. */
  grid(rows, x0, y0, key) {
    rows.forEach((row, j) => [...row].forEach((ch, i) => {
      if (ch === '.' || ch === ' ') return;
      const v = typeof key === 'function' ? key(ch, x0 + i, y0 + j) : key[ch];
      if (v === undefined) throw new Error(`no role for "${ch}" (row ${j}: ${row})`);
      if (v !== null) this.set(x0 + i, y0 + j, v);
    }));
    return this;
  }
  /** Fill a rectangle; role may be a function (x, y, i, j) → role. */
  rect(x0, y0, w, h, role) { for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) this.set(x0 + i, y0 + j, typeof role === 'function' ? role(x0 + i, y0 + j, i, j) : role); return this; }
  /** Every drawn texel moved by (dx, dy). */
  shift(dx, dy) { const c = new Roles(this.w, this.h); for (let y = 0; y < this.h; y++) for (let x = 0; x < this.w; x++) { const v = this.get(x, y); if (v) c.set(x + dx, y + dy, v); } return c; }
  /** Another grid drawn over this one (its null texels leave this one's). */
  over(o, dx = 0, dy = 0) { for (let y = 0; y < o.h; y++) for (let x = 0; x < o.w; x++) { const v = o.get(x, y); if (v) this.set(x + dx, y + dy, v); } return this; }
  mirror() { const c = new Roles(this.w, this.h); for (let y = 0; y < this.h; y++) for (let x = 0; x < this.w; x++) c.set(this.w - 1 - x, y, this.get(x, y)); return c; }
  /** The drawn texels' bounds, or null. */
  bounds() {
    let x0 = this.w, y0 = this.h, x1 = -1, y1 = -1;
    for (let y = 0; y < this.h; y++) for (let x = 0; x < this.w; x++) if (this.get(x, y)) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
    return x1 < 0 ? null : { x0, y0, x1, y1, w: x1 - x0 + 1, h: y1 - y0 + 1 };
  }
  /** Turned a quarter: cw true is clockwise. A square grid stays its size. */
  turn(cw = true) { const c = new Roles(this.h, this.w); for (let y = 0; y < this.h; y++) for (let x = 0; x < this.w; x++) { const v = this.get(x, y); if (v) cw ? c.set(this.h - 1 - y, x, v) : c.set(y, this.w - 1 - x, v); } return c; }
  /** Replace roles: map(role, x, y) → role (or the same). */
  map(f) { for (let y = 0; y < this.h; y++) for (let x = 0; x < this.w; x++) { const v = this.get(x, y); if (v) this.set(x, y, f(v, x, y)); } return this; }
}

export const mat = role => role?.split(':')[0] ?? null;
export const shade = role => Number(role?.split(':')[1] ?? 2);

/**
 * The one-texel outline: every see-through texel that touches a drawn one (left, right, up, down) becomes the line of
 * the material it touches ('<mat>:4'), so a red shirt is edged in deep red and a face in deep brown, never one black.
 * `inner`: pairs of materials that get a line where they meet inside the figure (an arm against the body).
 * `prefer`: the order materials win a see-through texel touching several.
 */
export function outline(g, { prefer = [], line = 4 } = {}) {
  const out = g.clone(), rank = m => { const i = prefer.indexOf(m); return i < 0 ? prefer.length : i; };
  for (let y = 0; y < g.h; y++) for (let x = 0; x < g.w; x++) {
    if (g.get(x, y)) continue;
    const n = [g.get(x, y - 1), g.get(x, y + 1), g.get(x - 1, y), g.get(x + 1, y)].filter(Boolean);
    if (!n.length) continue;
    const pick = n.map(mat).sort((a, b) => rank(a) - rank(b))[0];
    out.set(x, y, `${pick}:${line}`);
  }
  return out;
}

/** '#rrggbb' → [r, g, b]. */
export const rgb = hex => { const n = parseInt(hex.slice(1), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; };
export const hex = ([r, g, b]) => `#${[r, g, b].map(v => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('')}`;
/** a toward b by t. */
export const mix = (a, b, t) => hex(rgb(a).map((v, i) => v + (rgb(b)[i] - v) * t));

/** A four-step ramp from one base colour: light (toward a warm white), base, shade (toward a cool deep), line. */
export function ramp(base, { light = 0.32, dark = 0.3, line = 0.62, warm = '#fff2c8', cool = '#2a1f3d' } = {}) {
  return [mix(base, warm, light), base, mix(base, cool, dark), mix(base, cool, line)];
}

/** Roles → RGBA, through palette { material: [c1, c2, c3, c4, …] } (shade n is entry n - 1). */
export function toRgba(g, palette) {
  const data = Buffer.alloc(g.w * g.h * 4);
  for (let i = 0; i < g.r.length; i++) {
    const v = g.r[i];
    if (!v) continue;
    const m = mat(v), s = shade(v), P = palette[m];
    if (!P) throw new Error(`no colours for material "${m}"`);
    const c = rgb(P[Math.min(P.length, s) - 1]);
    data[i * 4] = c[0]; data[i * 4 + 1] = c[1]; data[i * 4 + 2] = c[2]; data[i * 4 + 3] = 255;
  }
  return { width: g.w, height: g.h, data };
}

/** An RGBA picture drawn into another at (x, y) (opaque texels only). */
export function blit(dst, src, x0, y0) {
  for (let y = 0; y < src.height; y++) for (let x = 0; x < src.width; x++) {
    const X = x0 + x, Y = y0 + y;
    if (X < 0 || Y < 0 || X >= dst.width || Y >= dst.height) continue;
    const i = (y * src.width + x) * 4;
    if (src.data[i + 3] < 128) continue;
    src.data.copy(dst.data, (Y * dst.width + X) * 4, i, i + 4);
  }
  return dst;
}
export const picture = (w, h) => ({ width: w, height: h, data: Buffer.alloc(w * h * 4) });

/** How many colours a picture uses (opaque texels). */
export function colourCount(pic) {
  const s = new Set();
  for (let i = 0; i < pic.data.length; i += 4) if (pic.data[i + 3] >= 128) s.add(pic.data.readUInt32BE(i) >>> 8);
  return s.size;
}

/** A small seeded random: the same seed draws the same picture on every machine. */
export function rng(seed) {
  let s = (seed >>> 0) || 1;
  return () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; };
}
/** A value noise in [0, 1] that wraps every `period` texels (tiles stay seamless). */
export function noise(seed, period) {
  const R = rng(seed), g = Array.from({ length: period * period }, () => R());
  const at = (x, y) => g[(((y % period) + period) % period) * period + (((x % period) + period) % period)];
  const sm = t => t * t * (3 - 2 * t);
  return (x, y, scale = 4) => {
    const fx = x / scale, fy = y / scale, x0 = Math.floor(fx), y0 = Math.floor(fy), tx = sm(fx - x0), ty = sm(fy - y0);
    const p = Math.round(period / scale) || 1, w = v => ((v % p) + p) % p;
    const a = at(w(x0), w(y0)), b = at(w(x0 + 1), w(y0)), c = at(w(x0), w(y0 + 1)), d = at(w(x0 + 1), w(y0 + 1));
    return a + (b - a) * tx + (c - a) * ty + (a - b - c + d) * tx * ty;
  };
}
/** The 4x4 ordered dither threshold at a texel, in [0, 1). */
export const bayer = (x, y) => [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5][(y & 3) * 4 + (x & 3)] / 16;
