// The style pass's arithmetic (looks wave 3: harmonise mixed art toward one look). Pure: no three.js, no DOM, no files,
// so the runtime's glue (harmonize.js, at load time) and the library's bake (builder/art/harmonize.mjs) run the same
// numbers on a GLB's colours and textures and on a 2D picture's pixels.
//
// A game mixes packs (Kenney, KayKit, Quaternius, our drawn packs, generated models) and they do not look like one game:
// a teal low-poly tree beside painted grass. The pass moves every asset's colours toward the look's own colours and
// leaves its shapes alone:
//   - palette: the asset's own colours are grouped (a few clusters in OKLab, a perceptual space; stats.mjs), each
//     cluster turns toward the look's colour of things nearest it, as far as it is near (a teal canopy to the look's
//     grass green), and every colour of the asset moves with its cluster (its texture's detail stays). Lightness moves
//     once for the whole asset, so it keeps its own value contrast (a crate's light and dark planks stay apart);
//   - pixel looks snap to a ramp of the look's colours (pixel art keeps few exact colours) and a picture gets a one-texel
//     ink edge inside its silhouette (its alpha never changes: a sprite's shape and hit area stay its own);
//   - texel density: a picture or texture much finer than the look's texels a metre is resampled down to it.
// Geometry is never touched. What the pass cannot reach (a realistic shape in a cartoon look) is the art ladder's.
//
// Settings: config/look.json `harmonize` (builder/look/harmonize.mjs harmonizeValues writes them from the look target;
// spec look.harmonize wins), a level's own under levels.<id>.harmonize:
//   strength 0–1 (0 = off), palette [hex] + weights [share] + roles [words] (the look's colours of things), reach (OKLab distance:
//   a cluster this far from every look colour moves about half as much as a near one), chroma (how much of the chroma
//   gap a cluster closes, 0–1), value (how much of the lightness gap the asset closes, 0–1), roughness, metalness, emissiveMax, toon, outline ('none' | 'post' | 'hull' |
//   'ink'), outlineColor (hex | 'own'), outlineWidth, quantize, texelsPerMetre, skip [slot patterns: 'ui.*',
//   'prop.logo'], only [slot patterns]
export const HARMONIZE_VERSION = 2;

const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
const srgbToLinear = c => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const linearToSrgb = c => (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055);

// sRGB byte → linear, once
const LIN = new Float32Array(256);
for (let i = 0; i < 256; i++) LIN[i] = srgbToLinear(i / 255);

/** sRGB bytes → OKLab [L, a, b] (Björn Ottosson, 2020; the same numbers as builder/look/stats.mjs). */
export function toLab(r, g, b) {
  const R = LIN[r | 0], G = LIN[g | 0], B = LIN[b | 0];
  const l = Math.cbrt(0.4122214708 * R + 0.5363325363 * G + 0.0514459929 * B);
  const m = Math.cbrt(0.2119034982 * R + 0.6806995451 * G + 0.1073969566 * B);
  const s = Math.cbrt(0.0883024619 * R + 0.2817188376 * G + 0.6299787005 * B);
  return [0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s, 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s, 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s];
}
function labToLinear(L, a, b) {
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3, m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3, s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s, -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s, -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s];
}
const inGamut = c => c[0] >= -1e-4 && c[0] <= 1.0001 && c[1] >= -1e-4 && c[1] <= 1.0001 && c[2] >= -1e-4 && c[2] <= 1.0001;
/** OKLab → sRGB bytes; out of gamut, the chroma comes down (hue and lightness kept) until it fits. */
export function fromLab(L, a, b) {
  L = clamp(L, 0, 1);
  let c = labToLinear(L, a, b);
  if (!inGamut(c)) {
    let lo = 0, hi = 1;
    for (let i = 0; i < 12; i++) { const k = (lo + hi) / 2; if (inGamut(labToLinear(L, a * k, b * k))) lo = k; else hi = k; }
    c = labToLinear(L, a * lo, b * lo);
  }
  return [Math.round(clamp(linearToSrgb(clamp(c[0], 0, 1)), 0, 1) * 255), Math.round(clamp(linearToSrgb(clamp(c[1], 0, 1)), 0, 1) * 255), Math.round(clamp(linearToSrgb(clamp(c[2], 0, 1)), 0, 1) * 255)];
}
/** A linear channel 0–1 → an sRGB byte, and back (three.js colours are linear; pictures are sRGB bytes). */
export const fromLinear = c => Math.round(clamp(linearToSrgb(clamp(c, 0, 1)), 0, 1) * 255);
export const toLinearByte = v => LIN[clamp(Math.round(v), 0, 255)];
export function hexToRgb(hex) { const n = parseInt(String(hex).replace('#', '').slice(0, 6), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; }
export const rgbToHex = ([r, g, b]) => '#' + [r, g, b].map(x => clamp(Math.round(x), 0, 255).toString(16).padStart(2, '0')).join('');

/** The defaults a look's harmonize block is read over. */
export const DEFAULTS = { strength: 0.85, value: 0.35, reach: 0.2, chroma: 0.15, roughness: null, metalness: null, emissiveMax: null, toon: false, outline: 'none', outlineColor: '#1a1a24', outlineWidth: 1, quantize: null, texelsPerMetre: null, skip: [], only: null };   // quantize null: a pixel-style game's pictures snap, others do not
/** Slots the pass never touches unless a look names them in `only`: what has to stay as it is drawn (UI, fonts, the
 *  look's own data pictures such as its noise). A look adds its own (a logo) to `skip`. */
export const SKIP_ALWAYS = ['ui.*', 'hud.*', 'menu.*', 'font.*', 'look.*', 'card.*', '*.logo', '*.icon', '*.icon.*', '*.flag'];

/** Does a slot id match a pattern list ('ui.*', '*.logo', 'prop.tree-pine')? */
export function matches(id, patterns = []) {
  for (const p of patterns ?? []) {
    if (p === id) return true;
    if (p.includes('*') && new RegExp('^' + p.split('*').map(s => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$').test(id)) return true;
  }
  return false;
}

/**
 * The harmonize settings in force for a look (config/look.json): its `harmonize` block, a level's own over it
 * (levels.<level>.harmonize, the level the look starts in unless one is named). null when there is none or its strength
 * is 0.
 */
export function settingsOfLook(look, level = look?.level ?? null) {
  if (!look || look.harmonize === false) return null;
  const own = look.harmonize && typeof look.harmonize === 'object' ? look.harmonize : null;
  const lv = level ? look.levels?.[level]?.harmonize : null;
  if (lv === false) return null;
  const s = own || lv ? { ...DEFAULTS, ...(own ?? {}), ...(lv && typeof lv === 'object' ? lv : {}) } : null;
  return s && s.strength > 0 && (s.palette?.length || s.roughness != null || s.metalness != null || s.toon || s.outline !== 'none' || s.texelsPerMetre) ? s : null;
}

/** May the pass touch this slot? A slot's own `harmonize: false` (assets.json), the look's skip and only lists. */
export function slotTaken(settings, id, slot = null) {
  if (!settings || !id) return false;
  if (slot?.harmonize === false || slot?.constraints?.harmonize === false) return false;
  if (settings.only?.length) return matches(id, settings.only);
  return !matches(id, SKIP_ALWAYS) && !matches(id, settings.skip);
}

/** A stable key for a settings object (what a cache of recoloured textures is keyed by). */
export const keyOf = s => (s ? JSON.stringify([HARMONIZE_VERSION, s.strength, s.palette, s.weights, s.roles, s.value, s.reach, s.chroma, s.quantize, s.outline, s.outlineColor, s.outlineWidth, s.texelsPerMetre]) : 'off');

// What a thing is made of, in plain words. A look colour's role (the reader's "pine foliage / shaded grass") and an
// asset's own words (its slot, its materials' names, its tags) meet in these groups, so a teal canopy looks for the
// look's foliage before its sea-blue, which colour alone cannot tell apart.
export const MATTER = {
  foliage: ['leaf', 'leaves', 'foliage', 'tree', 'bush', 'canopy', 'pine', 'oak', 'palm', 'grass', 'hedge', 'plant', 'shrub', 'moss', 'vine', 'fern', 'green'],
  wood: ['wood', 'bark', 'trunk', 'plank', 'crate', 'barrel', 'log', 'timber', 'stump', 'fence', 'branch', 'chest'],
  rock: ['rock', 'stone', 'boulder', 'cliff', 'cobble', 'pebble', 'brick', 'masonry', 'castle', 'ruin', 'wall'],
  sand: ['sand', 'dune', 'beach', 'desert', 'sandstone'],
  soil: ['soil', 'dirt', 'mud', 'earth', 'ground', 'clay'],
  metal: ['metal', 'iron', 'steel', 'gold', 'silver', 'copper', 'brass', 'bomb', 'cannon', 'gun', 'launcher'],
  water: ['water', 'sea', 'ocean', 'lake', 'river', 'wave', 'ice'],
  skin: ['skin', 'body', 'face', 'creature', 'worm', 'critter', 'character', 'hand'],
  fire: ['fire', 'flame', 'lava', 'ember', 'explosion', 'dynamite', 'fuse', 'torch'],
};
/** The matter groups plain words name (camelCase and snake_case split: "leafsGreen" → leafs, green). */
export function matterOf(text) {
  const words = String(text ?? '').replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase().split(/[^a-z]+/).filter(w => w.length >= 3);
  const out = new Set();
  for (const [g, keys] of Object.entries(MATTER)) if (words.some(w => keys.some(k => w === k || (k.length >= 4 && w.startsWith(k))))) out.add(g);
  return out;
}

/** Settings → what the mapper needs: the look's colours of things in OKLab (L, a, b, chroma, weight). */
export function prepare(s) {
  if (!s || !(s.strength > 0)) return null;
  const anchors = (s.palette ?? []).map((hex, i) => {
    const [L, a, b] = toLab(...hexToRgb(hex));
    return { hex, L, a, b, C: Math.hypot(a, b), w: Number(s.weights?.[i] ?? 1) || 0, matter: matterOf(s.roles?.[i]) };
  }).filter(x => x.w > 0);
  return { s: clamp(s.strength, 0, 1), anchors, value: s.value ?? DEFAULTS.value, reach: s.reach ?? DEFAULTS.reach, chroma: s.chroma ?? DEFAULTS.chroma, settings: s };
}

/** An asset's own colour numbers from weighted samples [[r, g, b, weight], …]: mean lightness and chroma, spread. */
export function statsOf(samples) {
  let W = 0, L = 0, Wc = 0, C = 0, L2 = 0;
  for (const [r, g, b, w = 1] of samples) {
    if (!(w > 0)) continue;
    const [l, a, bb] = toLab(r, g, b), c = Math.hypot(a, bb);
    W += w; L += l * w; L2 += l * l * w;
    if (c > 0.03) { Wc += w; C += c * w; }
  }
  if (!W) return { L: null, C: null, spread: null, n: 0 };
  const mL = L / W;
  return { L: mL, C: Wc ? C / Wc : null, spread: Math.sqrt(Math.max(0, L2 / W - mL * mL)), chromaticShare: Wc / W, n: W };
}

// how far a colour is from another for the pass (a ΔE-like distance in OKLab): the hue gap counts in full, the chroma
// gap nearly so (a saturated orange is not "near" a beige of the same hue), the lightness gap less (light, shade and
// haze change it in any look)
const far = (x, y) => {
  const cx = Math.hypot(x.a, x.b), cy = Math.hypot(y.a, y.b);
  const dab2 = (x.a - y.a) ** 2 + (x.b - y.b) ** 2, dH2 = Math.max(0, dab2 - (cx - cy) ** 2);
  return Math.sqrt((0.3 * (x.L - y.L)) ** 2 + (0.8 * (cx - cy)) ** 2 + dH2);
};
const angle = (to, from) => { let d = to - from; while (d > Math.PI) d -= 2 * Math.PI; while (d < -Math.PI) d += 2 * Math.PI; return d; };

/**
 * An asset's colour groups: weighted k-means in OKLab over its samples [[r, g, b, weight], …] (its surface by area, or
 * its pixels), at most k, groups closer than 0.035 merged. Settings-free: a level's restyle reuses them.
 * → [{L, a, b, w}] by weight
 */
export function clustersOf(samples, k = 6) {
  const pts = [];
  const seen = new Map();
  for (const [r, g, b, w = 1] of samples) {
    if (!(w > 0)) continue;
    const key = ((r >> 2) << 12) | ((g >> 2) << 6) | (b >> 2);
    const at = seen.get(key);
    if (at !== undefined) { pts[at].w += w; continue; }
    const [L, a, bb] = toLab(r, g, b);
    seen.set(key, pts.length); pts.push({ L, a, b: bb, w });
  }
  if (!pts.length) return [];
  pts.sort((x, y) => y.w - x.w);
  // start: the heaviest colour, then each next the one farthest (by weight) from those taken
  const C = [{ ...pts[0] }];
  while (C.length < Math.min(k, pts.length)) {
    let best = null, bd = 0;
    for (const p of pts.slice(0, 2000)) { const d = Math.min(...C.map(c => far(p, c))) * Math.sqrt(p.w); if (d > bd) { bd = d; best = p; } }
    if (!best || bd < 1e-4) break;
    C.push({ ...best });
  }
  for (let it = 0; it < 12; it++) {
    const acc = C.map(() => ({ L: 0, a: 0, b: 0, w: 0 }));
    for (const p of pts) {
      let j = 0, d = Infinity;
      for (let i = 0; i < C.length; i++) { const e = far(p, C[i]); if (e < d) { d = e; j = i; } }
      const t = acc[j]; t.L += p.L * p.w; t.a += p.a * p.w; t.b += p.b * p.w; t.w += p.w;
    }
    for (let i = 0; i < C.length; i++) if (acc[i].w) C[i] = { L: acc[i].L / acc[i].w, a: acc[i].a / acc[i].w, b: acc[i].b / acc[i].w, w: acc[i].w };
  }
  const out = [];
  for (const c of C.filter(c => c.w > 0).sort((x, y) => y.w - x.w)) {
    const near = out.find(o => far(o, c) < 0.035);
    if (near) { const w = near.w + c.w; near.L = (near.L * near.w + c.L * c.w) / w; near.a = (near.a * near.w + c.a * c.w) / w; near.b = (near.b * near.w + c.b * c.w) / w; near.w = w; }
    else out.push({ ...c });
  }
  const tot = out.reduce((t, c) => t + c.w, 0) || 1;
  return out.map(c => ({ L: c.L, a: c.a, b: c.b, w: c.w / tot }));
}

/**
 * Where one asset's colours go for a look: each cluster toward its nearest look colour, as far as it is near
 * (pull = s / (1 + (d / reach)⁴): a plateau, so a near cluster goes most of the way and a far one hardly moves). A
 * cluster turns its hue toward the look colour's and moves part of the way to its chroma (chroma 0–1: the look's
 * colours are measured from finished frames, under light and haze, so their chroma is not a surface's); a grey
 * cluster takes some of the look colour's tint. The lightness gap is closed once for the whole asset (value · the
 * clusters' mean gap), so it keeps its own contrast. opts.words: the asset's own words (its slot, materials, tags), which
 * prefer the look colours whose role names the same matter (MATTER). → { clusters: [{L, a, b, w, dh, k, ta, tb, anchor, pull}], dL }
 */
export function planOf(P, clusters, { words = '' } = {}) {
  if (!P || !P.anchors.length || !clusters?.length) return { clusters: clusters ?? [], dL: 0 };
  let gap = 0, gw = 0;
  // the asset's own words: a look colour whose role names the same matter is nearer (its distance counts 0.6)
  const want = matterOf(words);
  const near = x => (want.size && [...x.matter].some(g => want.has(g)) ? 0.6 : 1);
  const out = clusters.map(c => {
    let A = P.anchors[0], d = Infinity;
    for (const x of P.anchors) { const e = far(c, x) * near(x); if (e < d) { d = e; A = x; } }
    const pull = P.s / (1 + (d / P.reach) ** 4);
    gap += (A.L - c.L) * pull * c.w; gw += c.w;
    const C = Math.hypot(c.a, c.b), grey = C < 0.025;
    const dh = grey || A.C < 0.025 ? 0 : angle(Math.atan2(A.b, A.a), Math.atan2(c.b, c.a)) * pull;
    const k = grey ? 1 : Math.max(0.5, Math.min(2, (C + (A.C - C) * pull * P.chroma) / C));
    // a grey takes a little of the look colour's tint (a translation in a and b)
    const ta = grey ? (A.a - c.a) * pull * 0.5 : 0, tb = grey ? (A.b - c.b) * pull * 0.5 : 0;
    return { ...c, dh, k, ta, tb, anchor: A.hex, pull: +pull.toFixed(3) };
  });
  return { clusters: out, dL: gw ? (P.value * gap) / gw : 0 };
}

/**
 * One colour through the pass. P: prepare(settings); plan: planOf(P, the asset's clusters). → [r, g, b]
 * The colour moves with the clusters it belongs to (soft: by its distance to each): its hue turned, its chroma scaled,
 * a grey tinted; and by the asset's one lightness shift.
 */
export function mapColor(P, plan, r, g, b) {
  if (!P || !plan?.clusters?.length) return [r, g, b];
  const [L, a, bb] = toLab(r, g, b), x = { L, a, b: bb };
  let W = 0, dh = 0, lk = 0, ta = 0, tb = 0, near = null, nd = Infinity;
  for (const c of plan.clusters) {
    const d = far(x, c), w = Math.exp(-((d / 0.07) ** 2));
    W += w; dh += c.dh * w; lk += Math.log(c.k) * w; ta += c.ta * w; tb += c.tb * w;
    if (d < nd) { nd = d; near = c; }
  }
  if (W < 1e-6) { dh = near.dh; lk = Math.log(near.k); ta = near.ta; tb = near.tb; } else { dh /= W; lk /= W; ta /= W; tb /= W; }
  const C = Math.hypot(a, bb) * Math.exp(lk), h = Math.atan2(bb, a) + dh;
  return fromLab(clamp(L + plan.dL, 0.02, 0.985), Math.cos(h) * C + ta, Math.sin(h) * C + tb);
}

/** A colour lookup table for one asset: n³ entries (n = 17: 4913 mapped colours), read with applyLut. */
export function makeLut(P, plan, n = 17) {
  const lut = new Uint8Array(n * n * n * 3);
  for (let r = 0; r < n; r++) for (let g = 0; g < n; g++) for (let b = 0; b < n; b++) {
    const k = ((r * n + g) * n + b) * 3, q = 255 / (n - 1);
    const c = mapColor(P, plan, Math.round(r * q), Math.round(g * q), Math.round(b * q));
    lut[k] = c[0]; lut[k + 1] = c[1]; lut[k + 2] = c[2];
  }
  return { lut, n };
}
/** RGBA bytes through a lookup table (trilinear), in place; fully transparent pixels are left as they are. */
export function applyLut(data, { lut, n }) {
  const q = (n - 1) / 255, cache = new Map();
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] === 0) continue;
    const key = (data[i] << 16) | (data[i + 1] << 8) | data[i + 2];
    let v = cache.get(key);
    if (v === undefined) {
      const fr = data[i] * q, fg = data[i + 1] * q, fb = data[i + 2] * q;
      const r0 = Math.min(n - 2, fr | 0), g0 = Math.min(n - 2, fg | 0), b0 = Math.min(n - 2, fb | 0);
      const dr = fr - r0, dg = fg - g0, db = fb - b0, out = [0, 0, 0];
      for (let c = 0; c < 3; c++) {
        const at = (r, g, b) => lut[(((r0 + r) * n + (g0 + g)) * n + (b0 + b)) * 3 + c];
        const x00 = at(0, 0, 0) * (1 - db) + at(0, 0, 1) * db, x01 = at(0, 1, 0) * (1 - db) + at(0, 1, 1) * db;
        const x10 = at(1, 0, 0) * (1 - db) + at(1, 0, 1) * db, x11 = at(1, 1, 0) * (1 - db) + at(1, 1, 1) * db;
        out[c] = Math.round((x00 * (1 - dg) + x01 * dg) * (1 - dr) + (x10 * (1 - dg) + x11 * dg) * dr);
      }
      v = (out[0] << 16) | (out[1] << 8) | out[2];
      if (cache.size < 65536) cache.set(key, v);
    }
    data[i] = (v >> 16) & 255; data[i + 1] = (v >> 8) & 255; data[i + 2] = v & 255;
  }
  return data;
}

/** A picture's colours as samples (every `step`th opaque pixel), for clustersOf. */
export function pixelSamples(data, step = 1) {
  const samples = [];
  for (let i = 0; i < data.length; i += 4 * step) if (data[i + 3] >= 128) samples.push([data[i], data[i + 1], data[i + 2], 1]);
  return samples;
}

/**
 * The pixel look's ramp: each look colour at a few lightness steps (its shadow, itself, its light), plus the ink. A
 * quantised picture keeps to these, so pictures from different packs share one palette as pixel art does.
 */
export function rampOf(P, steps = [-0.16, 0, 0.13]) {
  const out = [];
  for (const x of P.anchors) for (const d of steps) out.push(fromLab(clamp(x.L + d, 0.05, 0.97), x.a * (d > 0 ? 0.85 : 1), x.b * (d > 0 ? 0.85 : 1)));
  out.push([20, 20, 28], [245, 245, 240]);
  const seen = new Set();
  return out.filter(c => { const k = c.join(','); if (seen.has(k)) return false; seen.add(k); return true; });
}
/** Each opaque pixel to its nearest colour of a palette (OKLab distance), in place. */
export function snapTo(data, palette) {
  const labs = palette.map(c => toLab(...c)), cache = new Map();
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] === 0) continue;
    const key = (data[i] << 16) | (data[i + 1] << 8) | data[i + 2];
    let j = cache.get(key);
    if (j === undefined) {
      const [L, a, b] = toLab(data[i], data[i + 1], data[i + 2]);
      let best = Infinity; j = 0;
      for (let k = 0; k < labs.length; k++) { const d = (L - labs[k][0]) ** 2 * 1.5 + (a - labs[k][1]) ** 2 + (b - labs[k][2]) ** 2; if (d < best) { best = d; j = k; } }
      cache.set(key, j);
    }
    data[i] = palette[j][0]; data[i + 1] = palette[j][1]; data[i + 2] = palette[j][2];
  }
  return data;
}

/** Does a picture already carry an ink outline (most of its silhouette's edge pixels dark)? */
export function hasInk(data, w, h) {
  let edge = 0, dark = 0;
  const A = (x, y) => (x < 0 || y < 0 || x >= w || y >= h ? 0 : data[(y * w + x) * 4 + 3]);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = (y * w + x) * 4;
    if (data[i + 3] < 128) continue;
    if (A(x - 1, y) < 128 || A(x + 1, y) < 128 || A(x, y - 1) < 128 || A(x, y + 1) < 128) {
      edge++;
      if (0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2] < 64) dark++;
    }
  }
  return edge >= 8 && dark / edge >= 0.6;
}

/**
 * An ink line inside a picture's silhouette: the opaque pixels within `width` of a transparent one take the ink (a hex
 * colour, or 'own': each pixel's own colour, deep). Alpha never changes, so the sprite's shape and hit area stay its own.
 * A picture with no transparent pixels (a ground tile) gets none. In place.
 */
export function inkEdges(data, w, h, { color = 'own', width = 1 } = {}) {
  const A = (x, y) => (x < 0 || y < 0 || x >= w || y >= h ? 0 : data[(y * w + x) * 4 + 3]);
  const ink = color === 'own' ? null : hexToRgb(color);
  const mark = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    if (A(x, y) < 128) continue;
    let edge = false;
    for (let dy = -width; dy <= width && !edge; dy++) for (let dx = -width; dx <= width && !edge; dx++) if (Math.abs(dx) + Math.abs(dy) <= width && A(x + dx, y + dy) < 128) edge = true;
    if (edge) mark[y * w + x] = 1;
  }
  for (let p = 0; p < w * h; p++) {
    if (!mark[p]) continue;
    const i = p * 4;
    if (ink) { data[i] = ink[0]; data[i + 1] = ink[1]; data[i + 2] = ink[2]; continue; }
    const [L, a, b] = toLab(data[i], data[i + 1], data[i + 2]);
    const c = fromLab(Math.min(L, 0.3) * 0.75, a * 0.8, b * 0.8);
    data[i] = c[0]; data[i + 1] = c[1]; data[i + 2] = c[2];
  }
  return data;
}

/**
 * A picture's own ink line in each thing's own deep shade (a pixel look's outline): the dark pixels on the silhouette's
 * edge take the deep shade of the nearest lit pixel inside them, in place. A uniform black or brown outline (one pack's
 * house ink) becomes the look's kind of outline; alpha never changes.
 */
export function retintInk(data, w, h) {
  const A = (x, y) => (x < 0 || y < 0 || x >= w || y >= h ? 0 : data[(y * w + x) * 4 + 3]);
  const Lof = i => toLab(data[i], data[i + 1], data[i + 2])[0];
  const src = new Uint8ClampedArray(data);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = (y * w + x) * 4;
    if (data[i + 3] < 128 || !(A(x - 1, y) < 128 || A(x + 1, y) < 128 || A(x, y - 1) < 128 || A(x, y + 1) < 128) || Lof(i) >= 0.32) continue;
    // the nearest lit pixel inside (rings out to 3 texels)
    let found = null;
    for (let r = 1; r <= 3 && !found; r++) for (let dy = -r; dy <= r && !found; dy++) for (let dx = -r; dx <= r && !found; dx++) {
      if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
      const xx = x + dx, yy = y + dy;
      if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
      const j = (yy * w + xx) * 4;
      if (src[j + 3] >= 128 && toLab(src[j], src[j + 1], src[j + 2])[0] >= 0.32) found = j;
    }
    if (found === null) continue;
    const [L, a, b] = toLab(src[found], src[found + 1], src[found + 2]);
    const c = fromLab(Math.min(L, 0.42) * 0.62, a * 0.9, b * 0.9);
    data[i] = c[0]; data[i + 1] = c[1]; data[i + 2] = c[2];
  }
  return data;
}

/** A picture box-sampled down by an integer factor k (RGBA bytes → new RGBA bytes, alpha-weighted colour). hard: each
 *  texel wholly opaque or wholly clear (pixel art has no soft fringe). */
export function downsample({ width: w, height: h, data }, k, { hard = false } = {}) {
  k = Math.max(1, Math.floor(k));
  if (k === 1) return { width: w, height: h, data };
  const W = Math.max(1, Math.floor(w / k)), H = Math.max(1, Math.floor(h / k)), out = new Uint8ClampedArray(W * H * 4);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    let r = 0, g = 0, b = 0, a = 0, n = 0;
    for (let yy = y * k; yy < y * k + k; yy++) for (let xx = x * k; xx < x * k + k; xx++) {
      const i = (yy * w + xx) * 4, al = data[i + 3];
      r += data[i] * al; g += data[i + 1] * al; b += data[i + 2] * al; a += al; n++;
    }
    const o = (y * W + x) * 4;
    if (a) { out[o] = r / a; out[o + 1] = g / a; out[o + 2] = b / a; }
    const al = Math.round(a / n);
    out[o + 3] = al >= 128 ? 255 : hard ? 0 : al;
  }
  return { width: W, height: H, data: out };
}

/** A picture scaled up by k with whole texels (nearest), cropped or padded to w × h: a pixel look's texels, same size. */
export function upsample({ width: sw, height: sh, data }, k, w = sw * k, h = sh * k) {
  const out = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = (Math.min(sh - 1, (y / k) | 0) * sw + Math.min(sw - 1, (x / k) | 0)) * 4, o = (y * w + x) * 4;
    out[o] = data[i]; out[o + 1] = data[i + 1]; out[o + 2] = data[i + 2]; out[o + 3] = data[i + 3];
  }
  return { width: w, height: h, data: out };
}

/**
 * A picture's whole pass, in place: recolour (a lookup table from the picture's own clusters, or the asset's when the
 * picture is part of a bigger one: a GLB's texture, opts.clusters), the pixel look's ramp (quantize), the ink edge
 * (outline 'ink', unless the picture has its own ink already; opts.edges false for a texture wrapped on a model).
 * pic: { width, height, data }. → { pic, clusters, plan, did: [what it did] }
 */
export function harmonizePicture(pic, settings, { clusters = null, edges = true, P = prepare(settings), words = '' } = {}) {
  const did = [];
  if (!P) return { pic, clusters, plan: null, did };
  const cl = clusters ?? clustersOf(pixelSamples(pic.data, Math.max(1, Math.floor(pic.width * pic.height / 65536))));
  const plan = planOf(P, cl, { words });
  if (P.anchors.length && cl.length) { applyLut(pic.data, makeLut(P, plan)); did.push('palette'); }
  // the pixel look's ramp, beside the picture's own few colours: a colour near the look's ramp takes it, one far from
  // it (a blue gem in a look with no blue) keeps its own (one of the picture's six), so pixel art keeps few colours
  if (settings.quantize && P.anchors.length) {
    const own = clustersOf(pixelSamples(pic.data, Math.max(1, Math.floor(pic.width * pic.height / 16384))), 6).map(c => fromLab(c.L, c.a, c.b));
    snapTo(pic.data, [...rampOf(P), ...own]); did.push('ramp');
  }
  if (edges && settings.outline === 'ink') {
    if (!hasInk(pic.data, pic.width, pic.height)) { inkEdges(pic.data, pic.width, pic.height, { color: settings.outlineColor ?? 'own', width: Math.max(1, settings.outlineWidth | 0) }); did.push('ink'); }
    else if ((settings.outlineColor ?? 'own') === 'own') { retintInk(pic.data, pic.width, pic.height); did.push('ink in its own shades'); }
  }
  return { pic, clusters: cl, plan, did };
}
