// The look judge's measured parts (builder/look/README.md): what a frame's pixels say about its style, and how far two
// frames are apart on each, in plain numbers. Pure (no browser, no files): pixels.mjs turns pictures into RGBA first.
//
//   frameStats({ width, height, data })  → { palette, value, chroma, edges, regions, mean }
//   compareStats(ours, ref)              → { parts: { palette, value, saturation, edges }, distances, findings }
//
// Colour is measured in OKLab (Björn Ottosson, 2020; public domain), a perceptual space where a straight-line distance
// is close to how different two colours look. L is lightness 0–1, a and b the green–red and blue–yellow axes, chroma
// (saturation) is √(a² + b²), about 0–0.32 for screen colours. The look-target stream computes a target's numbers with
// this same code, so the target's palette and ours are alike by construction.

const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
const srgbToLinear = c => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const linearToSrgb = c => (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055);

/** sRGB bytes → OKLab [L, a, b]. */
export function toOklab(r, g, b) {
  const R = srgbToLinear(r / 255), G = srgbToLinear(g / 255), B = srgbToLinear(b / 255);
  const l = Math.cbrt(0.4122214708 * R + 0.5363325363 * G + 0.0514459929 * B);
  const m = Math.cbrt(0.2119034982 * R + 0.6806995451 * G + 0.1073969566 * B);
  const s = Math.cbrt(0.0883024619 * R + 0.2817188376 * G + 0.6299787005 * B);
  return [0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s, 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s, 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s];
}

/** OKLab → '#rrggbb' (clipped to the screen's gamut). */
export function oklabToHex([L, a, b]) {
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3, m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3, s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  const rgb = [4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s, -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s, -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s];
  return '#' + rgb.map(c => Math.round(clamp(linearToSrgb(clamp(c, 0, 1)), 0, 1) * 255).toString(16).padStart(2, '0')).join('');
}

/** '#rrggbb' → OKLab. */
export function hexToOklab(hex) {
  const n = parseInt(String(hex).replace('#', ''), 16);
  return toOklab((n >> 16) & 255, (n >> 8) & 255, n & 255);
}

const HUES = [[20, 'pink-red'], [50, 'red'], [75, 'orange'], [105, 'yellow'], [150, 'yellow-green'], [175, 'green'], [215, 'teal'], [245, 'cyan'], [275, 'blue'], [310, 'violet'], [350, 'magenta'], [380, 'pink-red']];
/** A colour in words: "dark saturated blue", "light grey". */
export function colourWords([L, a, b]) {
  const C = Math.hypot(a, b);
  const tone = L < 0.3 ? 'very dark ' : L < 0.5 ? 'dark ' : L > 0.85 ? 'very light ' : L > 0.7 ? 'light ' : '';
  if (C < 0.03) return `${tone}grey`.trim();
  let h = (Math.atan2(b, a) * 180) / Math.PI; if (h < 0) h += 360; if (h < 20) h += 360;
  const name = HUES.find(([lim]) => h < lim)?.[1] ?? 'pink-red';
  return `${tone}${C > 0.15 ? 'saturated ' : C < 0.07 ? 'muted ' : ''}${name}`;
}

/** A tiny seeded generator (mulberry32), so the same frame always clusters the same way. */
function rng(seed = 7) { let a = seed >>> 0; return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

/** k-means in OKLab (k-means++ start, seeded). points: Float32Array of L,a,b triples. → [{lab, share}] by share. */
export function kmeans(points, k = 8, { iters = 14, seed = 7 } = {}) {
  const n = points.length / 3;
  if (!n) return [];
  k = Math.min(k, n);
  const rand = rng(seed), C = [];
  const d2 = (i, c) => { const x = points[i * 3] - c[0], y = points[i * 3 + 1] - c[1], z = points[i * 3 + 2] - c[2]; return x * x + y * y + z * z; };
  const first = Math.floor(rand() * n);
  C.push([points[first * 3], points[first * 3 + 1], points[first * 3 + 2]]);
  const near = new Float64Array(n).fill(Infinity);
  while (C.length < k) {
    let sum = 0;
    for (let i = 0; i < n; i++) { near[i] = Math.min(near[i], d2(i, C[C.length - 1])); sum += near[i]; }
    if (sum <= 0) break;
    let r = rand() * sum, pick = n - 1;
    for (let i = 0; i < n; i++) { r -= near[i]; if (r <= 0) { pick = i; break; } }
    C.push([points[pick * 3], points[pick * 3 + 1], points[pick * 3 + 2]]);
  }
  const label = new Int32Array(n);
  for (let it = 0; it < iters; it++) {
    const acc = C.map(() => [0, 0, 0, 0]);
    for (let i = 0; i < n; i++) {
      let best = 0, bd = Infinity;
      for (let c = 0; c < C.length; c++) { const d = d2(i, C[c]); if (d < bd) { bd = d; best = c; } }
      label[i] = best; const A = acc[best]; A[0] += points[i * 3]; A[1] += points[i * 3 + 1]; A[2] += points[i * 3 + 2]; A[3]++;
    }
    for (let c = 0; c < C.length; c++) if (acc[c][3]) C[c] = [acc[c][0] / acc[c][3], acc[c][1] / acc[c][3], acc[c][2] / acc[c][3]];
  }
  const count = new Array(C.length).fill(0);
  for (let i = 0; i < n; i++) count[label[i]]++;
  return C.map((lab, i) => ({ lab, share: count[i] / n })).filter(c => c.share > 0).sort((a, b) => b.share - a.share);
}

const BINS = 16, CHROMA_MAX = 0.3;
const hist = (vals, max) => { const h = new Array(BINS).fill(0); for (const v of vals) h[clamp(Math.floor((v / max) * BINS), 0, BINS - 1)]++; const n = vals.length || 1; return h.map(x => x / n); };

/**
 * One frame's style numbers. img: { width, height, data } (RGBA bytes; downscale to about 320 px wide first).
 * opts.mask(x, y) → false leaves a pixel out (a HUD's box, a letterbox). → {
 *   palette: [{ lab, hex, share, words }] (k = 8, by share), value: 16-bin lightness histogram, chroma: 16-bin chroma
 *   histogram (0–0.3), edges: { density, dark } (shares of pixels on an edge, and on a thin dark line: an outline),
 *   regions: { top, rest } (mean L, chroma and OKLab colour of the upper third, where a sky usually is, and of the rest),
 *   tones: { shadow, highlight } (the mean colour of the darkest and lightest 15 %), mean }
 */
export function frameStats(img, { k = 8, mask = null } = {}) {
  const { width: W, height: H, data } = img;
  const L = new Float32Array(W * H), A = new Float32Array(W * H), B = new Float32Array(W * H), keep = new Uint8Array(W * H);
  const pts = [], Ls = [], Cs = [], pts3 = [];
  const reg = { top: [0, 0, 0, 0, 0], rest: [0, 0, 0, 0, 0] };   // sums of L, chroma, a, b and the count
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = y * W + x, o = i * 4;
    const [l, a, b] = toOklab(data[o], data[o + 1], data[o + 2]);
    L[i] = l; A[i] = a; B[i] = b;
    if (mask && !mask(x, y)) continue;
    keep[i] = 1;
    const c = Math.hypot(a, b);
    Ls.push(l); Cs.push(c); pts3.push(l, a, b);
    if ((x + y * 3) % 2 === 0) pts.push(l, a, b);     // half the pixels are plenty for clusters
    const r = y < H / 3 ? reg.top : reg.rest; r[0] += l; r[1] += c; r[2] += a; r[3] += b; r[4]++;
  }
  const palette = kmeans(Float32Array.from(pts), k).map(c => ({ lab: c.lab.map(v => Math.round(v * 1e4) / 1e4), hex: oklabToHex(c.lab), share: Math.round(c.share * 1e4) / 1e4, words: colourWords(c.lab) }));
  // edges: Sobel on lightness; an outline is a thin dark line, a pixel darker than both neighbours two pixels away
  // across the edge by OUTLINE_STEP
  let edge = 0, dark = 0, counted = 0;
  const EDGE = 0.25, OUTLINE_STEP = 0.07;
  const at = (x, y) => L[clamp(y, 0, H - 1) * W + clamp(x, 0, W - 1)];
  for (let y = 1; y < H - 1; y++) for (let x = 1; x < W - 1; x++) {
    if (!keep[y * W + x]) continue;
    counted++;
    const gx = at(x + 1, y - 1) + 2 * at(x + 1, y) + at(x + 1, y + 1) - at(x - 1, y - 1) - 2 * at(x - 1, y) - at(x - 1, y + 1);
    const gy = at(x - 1, y + 1) + 2 * at(x, y + 1) + at(x + 1, y + 1) - at(x - 1, y - 1) - 2 * at(x, y - 1) - at(x + 1, y - 1);
    if (Math.hypot(gx, gy) > EDGE) edge++;
    const c = at(x, y);
    if ((at(x - 2, y) - c > OUTLINE_STEP && at(x + 2, y) - c > OUTLINE_STEP) || (at(x, y - 2) - c > OUTLINE_STEP && at(x, y + 2) - c > OUTLINE_STEP)) dark++;
  }
  const mean = arr => arr.reduce((s, v) => s + v, 0) / (arr.length || 1);
  const r3 = v => Math.round(v * 1000) / 1000;
  const mL = mean(Ls);
  const regionOf = r => (r[4] ? { L: r3(r[0] / r[4]), C: r3(r[1] / r[4]), lab: [r3(r[0] / r[4]), r3(r[2] / r[4]), r3(r[3] / r[4])] } : null);
  // the shadow and highlight tones: the mean colour of the darkest and the lightest 15 % of the pixels
  const order = Ls.map((l, i) => i).sort((x, y) => Ls[x] - Ls[y]);
  const tone = idx => { if (!idx.length) return null; let l = 0, a = 0, b = 0; for (const i of idx) { l += pts3[i * 3]; a += pts3[i * 3 + 1]; b += pts3[i * 3 + 2]; } return [r3(l / idx.length), r3(a / idx.length), r3(b / idx.length)]; };
  const cut = Math.max(1, Math.floor(order.length * 0.15));
  return {
    size: [W, H], pixels: Ls.length,
    palette,
    value: hist(Ls, 1).map(r3),
    chroma: hist(Cs, CHROMA_MAX).map(r3),
    edges: { density: r3(edge / (counted || 1)), dark: r3(dark / (counted || 1)) },
    regions: { top: regionOf(reg.top), rest: regionOf(reg.rest) },
    tones: { shadow: tone(order.slice(0, cut)), highlight: tone(order.slice(-cut)) },
    mean: { L: r3(mL), C: r3(mean(Cs)), contrast: r3(Math.sqrt(mean(Ls.map(v => (v - mL) ** 2)))) },
  };
}

/**
 * A frame's surfaces, by the bands target.mjs reads (measure.mjs: the top fifth the sky, the bottom fifth the ground, the
 * saturated pixels of the middle the characters and props), each as its own colour clusters. Unlike a target's regions,
 * a band is kept whatever it holds (a painted or textured ground is many colours, and is still the ground): a judge
 * compares what is there, band with band. → { sky, ground, characters } (a band with too few pixels is left out)
 */
export function surfacesOf(img, { k = 5 } = {}) {
  const { width: W, height: H, data } = img;
  const band = (y0, y1, keep = () => true) => {
    const pts = [];
    for (let y = y0; y < y1; y++) for (let x = (y & 1); x < W; x += 2) { const o = (y * W + x) * 4, p = toOklab(data[o], data[o + 1], data[o + 2]); if (keep(p)) pts.push(...p); }
    return Float32Array.from(pts);
  };
  const of = pts => {
    if (pts.length < 90) return null;
    const n = pts.length / 3; let L = 0, C = 0;
    for (let i = 0; i < n; i++) { L += pts[i * 3]; C += Math.hypot(pts[i * 3 + 1], pts[i * 3 + 2]); }
    return { clusters: kmeans(pts, k), value: Math.round((L / n) * 1000) / 1000, chroma: Math.round((C / n) * 1000) / 1000 };
  };
  const out = { sky: of(band(0, Math.round(H * 0.2))), ground: of(band(Math.round(H * 0.8), H)), characters: of(band(Math.round(H * 0.2), Math.round(H * 0.8), p => Math.hypot(p[1], p[2]) > 0.09 && p[0] > 0.35)) };
  return Object.fromEntries(Object.entries(out).filter(([, v]) => v));
}

/** Black bars (a letterbox, a pillarbox) cut off: rows and columns at the edges whose every pixel is near black. */
export function trimBars(img, { level = 14, max = 0.2 } = {}) {
  const { width: W, height: H, data } = img;
  const dark = (x, y) => { const o = (y * W + x) * 4; return data[o] < level && data[o + 1] < level && data[o + 2] < level; };
  const rowDark = y => { for (let x = 0; x < W; x += 2) if (!dark(x, y)) return false; return true; };
  const colDark = x => { for (let y = 0; y < H; y += 2) if (!dark(x, y)) return false; return true; };
  let top = 0, bottom = H, left = 0, right = W;
  while (top < H * max && rowDark(top)) top++;
  while (bottom > H * (1 - max) && rowDark(bottom - 1)) bottom--;
  while (left < W * max && colDark(left)) left++;
  while (right > W * (1 - max) && colDark(right - 1)) right--;
  if (!top && bottom === H && !left && right === W) return img;
  const w = right - left, h = bottom - top, out = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) out.set(data.subarray(((y + top) * W + left) * 4, ((y + top) * W + right) * 4), y * w * 4);
  return { ...img, width: w, height: h, data: out, trimmed: [left, top, W - right, H - bottom] };
}

/** 1-D earth mover's distance between two histograms over [0, 1] (the area between their running sums). */
export function emd1d(p, q) {
  let cp = 0, cq = 0, d = 0;
  for (let i = 0; i < p.length; i++) { cp += p[i]; cq += q[i]; d += Math.abs(cp - cq); }
  return d / p.length;
}

/**
 * The cost of turning one weighted palette into the other (optimal transport, entropic, Sinkhorn), in OKLab units ×100
 * (about a just-noticeable step each). Lightness counts as much as hue. → the mean distance a pixel's colour moves.
 */
export function paletteDistance(P, Q, { eps = 2, iters = 300 } = {}) {
  if (!P.length || !Q.length) return 100;
  const a = P.map(c => c.share), b = Q.map(c => c.share);
  const sa = a.reduce((s, x) => s + x, 0), sb = b.reduce((s, x) => s + x, 0);
  for (let i = 0; i < a.length; i++) a[i] /= sa;
  for (let j = 0; j < b.length; j++) b[j] /= sb;
  const M = P.map(p => Q.map(q => Math.hypot(p.lab[0] - q.lab[0], p.lab[1] - q.lab[1], p.lab[2] - q.lab[2]) * 100));
  const K = M.map(r => r.map(m => Math.exp(-m / eps)));
  let u = a.map(() => 1), v = b.map(() => 1);
  for (let it = 0; it < iters; it++) {
    u = a.map((ai, i) => ai / Math.max(1e-300, K[i].reduce((s, k, j) => s + k * v[j], 0)));
    v = b.map((bj, j) => bj / Math.max(1e-300, K.reduce((s, row, i) => s + row[j] * u[i], 0)));
  }
  let cost = 0, mass = 0;
  for (let i = 0; i < a.length; i++) for (let j = 0; j < b.length; j++) { const t = u[i] * K[i][j] * v[j]; cost += t * M[i][j]; mass += t; }
  return mass > 0 && Number.isFinite(cost) ? cost / mass : greedyTransport(P, Q, M, a, b);
}
// when Sinkhorn underflows (palettes far apart): north-west corner on the cheapest pairs first
function greedyTransport(P, Q, M, a, b) {
  a = [...a]; b = [...b];
  const pairs = []; for (let i = 0; i < P.length; i++) for (let j = 0; j < Q.length; j++) pairs.push([M[i][j], i, j]);
  pairs.sort((x, y) => x[0] - y[0]);
  let cost = 0;
  for (const [m, i, j] of pairs) { const t = Math.min(a[i], b[j]); if (t > 0) { cost += t * m; a[i] -= t; b[j] -= t; } }
  return cost;
}

/** How a distance becomes a part's mark (0–100): 100·e^(−d / scale). The scales are calibrated (calibrate.mjs). */
// Calibrated on Hollow Reach (calibrate.mjs, 2026-10-14): a frame of the same game at another framing (the median
// distance between its own frames) marks about 60 on each part, a frame at the same framing about 80.
export const SCALES = { palette: 34, value: 0.25, saturation: 0.09, edges: 1.1, sky: 30, surface: 30 };
/** The surfaces a frame is split into (measure.mjs): what a renderer has levers for, and what a person compares. */
export const SURFACES = ['sky', 'ground', 'characters'];
const mark = (d, s) => Math.round(100 * Math.exp(-d / s));
const pct = x => `${Math.round(x * 100)}%`;

/**
 * Our frame against a reference frame. → { parts: { palette, value, saturation, edges } (0–100), distances, findings:
 * [plain lines, worst first] }.
 */
export function compareStats(ours, ref, { scales = SCALES } = {}) {
  // a reference made from a target's numbers alone (judge.mjs targetStats) may lack parts: those are not compared
  const has = k => ref[k] !== null && ref[k] !== undefined && ours[k] !== null && ours[k] !== undefined;
  const num = v => typeof v === 'number';
  const dPal = ref.palette?.length ? paletteDistance(ours.palette, ref.palette) : null;
  const dVal = has('value') ? emd1d(ours.value, ref.value) : null;
  const dSat = has('chroma') ? emd1d(ours.chroma, ref.chroma) : null;
  const logr = (x, y) => Math.abs(Math.log((x + 0.004) / (y + 0.004)));
  const dEdge = has('edges') ? (logr(ours.edges.density, ref.edges.density) + 2 * logr(ours.edges.dark, ref.edges.dark)) / 3 : null;
  // the upper third (where a sky usually is): its mean colour against the reference's, in OKLab units ×100
  const tl = ours.regions?.top?.lab, rl = ref.regions?.top?.lab;
  const dSky = tl && rl ? Math.hypot(tl[0] - rl[0], tl[1] - rl[1], tl[2] - rl[2]) * 100 : null;
  const parts = {};
  if (dPal !== null) parts.palette = mark(dPal, scales.palette);
  // surface to surface (surfacesOf: the bands target.mjs reads a reference by): sky with sky,
  // ground with ground, characters with characters, each its own palette transport; a surface only one frame shows is
  // not compared. Without surfaces, the upper third's mean colour stands in for the sky.
  const dSurf = {};
  for (const k of SURFACES) {
    const a = ours.surfaces?.[k]?.clusters, b = ref.surfaces?.[k]?.clusters;
    if (a?.length && b?.length) { dSurf[k] = paletteDistance(a, b); parts[k] = mark(dSurf[k], scales.surface); }
  }
  if (parts.sky === undefined && dSky !== null) parts.sky = mark(dSky, scales.sky);
  if (dVal !== null) parts.value = mark(dVal, scales.value);
  if (dSat !== null) parts.saturation = mark(dSat, scales.saturation);
  if (dEdge !== null) parts.edges = mark(dEdge, scales.edges);
  const findings = [];
  const add = (weight, line) => findings.push({ weight, line });
  const om = ours.mean ?? {}, rm = ref.mean ?? {};
  const dL = om.L - rm.L, dC = om.C - rm.C;
  if (num(rm.L) && Math.abs(dL) > 0.06) add(Math.abs(dL) * 3, `${dL < 0 ? 'darker' : 'brighter'} than the reference overall (mean lightness ${om.L} against ${rm.L})`);
  if (num(rm.C) && Math.abs(dC) > 0.015) add(Math.abs(dC) * 8, `${dC < 0 ? 'less' : 'more'} saturated than the reference overall (mean chroma ${om.C} against ${rm.C})`);
  const dK = om.contrast - rm.contrast;
  if (num(rm.contrast) && Math.abs(dK) > 0.04) add(Math.abs(dK) * 4, `${dK < 0 ? 'flatter (less contrast)' : 'more contrast'} than the reference (lightness spread ${om.contrast} against ${rm.contrast})`);
  const ot = ours.regions?.top, rt = ref.regions?.top;
  if (ot && rt) {
    if (rt.C - ot.C > 0.02) add((rt.C - ot.C) * 10, `upper frame (sky) too desaturated (chroma ${ot.C} against ${rt.C})`);
    else if (ot.C - rt.C > 0.03) add((ot.C - rt.C) * 8, `upper frame (sky) more saturated than the reference (chroma ${ot.C} against ${rt.C})`);
    if (Math.abs(ot.L - rt.L) > 0.1) add(Math.abs(ot.L - rt.L) * 2, `upper frame (sky) ${ot.L < rt.L ? 'darker' : 'lighter'} than the reference (lightness ${ot.L} against ${rt.L})`);
  }
  if (!has('edges')) {}
  else if (ref.edges.dark > 0.025 && ours.edges.dark < ref.edges.dark * 0.5) add(1 + ref.edges.dark * 10, `${ours.edges.dark < 0.01 ? 'no outlines' : 'thin or few outlines'}; the reference has dark lines around shapes (${pct(ref.edges.dark)} of pixels against ${pct(ours.edges.dark)})`);
  else if (ours.edges.dark > 0.025 && ref.edges.dark < ours.edges.dark * 0.5) add(0.8, `dark outlines the reference does not have (${pct(ours.edges.dark)} of pixels against ${pct(ref.edges.dark)})`);
  if (!has('edges')) {}
  else if (ours.edges.density > ref.edges.density * 1.8 && ours.edges.density > 0.08) add(0.6, `busier than the reference: more edges and texture detail (${pct(ours.edges.density)} of pixels on an edge against ${pct(ref.edges.density)})`);
  else if (ref.edges.density > ours.edges.density * 1.8 && ref.edges.density > 0.08) add(0.6, `plainer than the reference: fewer edges and less texture detail (${pct(ours.edges.density)} against ${pct(ref.edges.density)})`);
  // the reference's big colours we lack (a cluster with ≥ 8 % of the frame and nothing of ours within 12 units)
  for (const c of (ref.palette ?? []).filter(c => c.share >= 0.08)) {
    const near = Math.min(...ours.palette.map(o => Math.hypot(o.lab[0] - c.lab[0], o.lab[1] - c.lab[1], o.lab[2] - c.lab[2]) * 100));
    if (near > 12) add(c.share * near / 10, `the reference's ${c.words} (${c.hex}, ${pct(c.share)} of its frame) has no close colour in ours`);
  }
  for (const c of ref.palette?.length ? ours.palette.filter(c => c.share >= 0.12) : []) {
    const near = Math.min(...ref.palette.map(o => Math.hypot(o.lab[0] - c.lab[0], o.lab[1] - c.lab[1], o.lab[2] - c.lab[2]) * 100));
    if (near > 14) add(c.share * near / 12, `our ${c.words} (${c.hex}, ${pct(c.share)} of the frame) is not in the reference's palette`);
  }
  for (const [k, d] of Object.entries(dSurf)) {
    if (d < 12) continue;
    const o = ours.surfaces[k].clusters[0], r = ref.surfaces[k].clusters[0];
    add(d / 8, `${k}: ours is ${colourWords(o.lab)} (${oklabToHex(o.lab)}) where the reference's is ${colourWords(r.lab)} (${oklabToHex(r.lab)})`);
  }
  findings.sort((x, y) => y.weight - x.weight);
  const r2 = v => Math.round(v * 1000) / 1000;
  const r2n = v => (v === null ? null : r2(v));
  return { parts, distances: { palette: r2n(dPal), value: r2n(dVal), saturation: r2n(dSat), edges: r2n(dEdge), sky: r2n(dSurf.sky ?? dSky), ground: r2n(dSurf.ground ?? null), characters: r2n(dSurf.characters ?? null) }, findings: findings.map(f => f.line) };
}

/**
 * The measured mark of a frame pair: a weighted geometric mean of the parts present (proportion only when measured), so
 * one part that collapses pulls the mark down as a person would (a look turned to greys is not 70 % right because its
 * light and edges are unchanged: the look-greyed regression).
 */
export const MEASURED_WEIGHTS = { palette: 0.14, value: 0.1, saturation: 0.1, sky: 0.15, ground: 0.2, characters: 0.15, edges: 0.1, proportion: 0.06 };
export function measuredMark(parts, weights = MEASURED_WEIGHTS) {
  let s = 0, w = 0;
  for (const [k, wk] of Object.entries(weights)) if (typeof parts[k] === 'number') { s += Math.log(Math.max(1, parts[k])) * wk; w += wk; }
  return w ? Math.round(Math.exp(s / w)) : null;
}

/** The proportion part: our bodies' head share of height against the target's (headToBody = head height ÷ whole height). */
export function proportionMark(ours, target, scale = 0.08) {
  if (typeof ours !== 'number' || typeof target !== 'number') return null;
  return mark(Math.abs(ours - target), scale);
}

/** Several frames' stats as one (a game's look over its framings, to hold against a target's pooled numbers). */
export function poolStats(list) {
  list = list.filter(Boolean);
  if (!list.length) return null;
  const n = list.length, r3 = v => Math.round(v * 1000) / 1000;
  const avgArr = key => list[0][key].map((_, i) => r3(list.reduce((s, x) => s + x[key][i], 0) / n));
  const avgNum = get => { const v = list.map(get).filter(x => typeof x === 'number'); return v.length ? r3(v.reduce((s, x) => s + x, 0) / v.length) : null; };
  const tops = list.map(x => x.regions?.top).filter(Boolean);
  return {
    pooled: n,
    palette: list.flatMap(x => x.palette.map(c => ({ ...c, share: c.share / n }))).sort((a, b) => b.share - a.share),
    value: avgArr('value'), chroma: avgArr('chroma'),
    edges: { density: avgNum(x => x.edges.density), dark: avgNum(x => x.edges.dark) },
    regions: { top: tops.length ? { L: r3(tops.reduce((s, t) => s + t.L, 0) / tops.length), C: r3(tops.reduce((s, t) => s + t.C, 0) / tops.length),
      ...(tops.every(t => t.lab) ? { lab: [0, 1, 2].map(i => r3(tops.reduce((s, t) => s + t.lab[i], 0) / tops.length)) } : {}) } : null },
    mean: { L: avgNum(x => x.mean.L), C: avgNum(x => x.mean.C), contrast: avgNum(x => x.mean.contrast) },
    surfaces: Object.fromEntries(SURFACES.map(k => [k, list.filter(x => x.surfaces?.[k]?.clusters?.length)]).filter(([, have]) => have.length)
      .map(([k, have]) => [k, { clusters: have.flatMap(x => x.surfaces[k].clusters.map(c => ({ ...c, share: c.share / have.length }))) }])),
  };
}
