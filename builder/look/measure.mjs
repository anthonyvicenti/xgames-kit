// The measured half of a style target: what the reference frames' pixels say, read with the look judge's own numbers
// (stats.mjs frameStats: OKLab palette clusters, 16-bin lightness and chroma histograms, edge and outline density), so
// a target and a score are measured alike. This file adds what a target needs beyond one frame: reading files (sharp,
// no browser), pooling many frames into one palette, and the regions a renderer has levers for (sky, ground,
// characters). Pure Node; no GPU.
//
//   const s = await measureSet(files);   // {frames, palette: [{hex, share, words}], value, chroma, edges, regions, mean}
//   const one = await measureImage(file);
//
// Regions: the top fifth of a frame is the sky and the bottom fifth the ground when the band is one colour family (its
// biggest cluster over half of it); characters are saturated clusters in the middle band that neither the sky nor the
// ground holds, when there are any. A region counts for a set when at least a third of the frames show it.
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { KIT_ROOT } from '../lib/paths.mjs';
import { frameStats, kmeans, toOklab, oklabToHex, hexToOklab, colourWords } from './stats.mjs';

export const STATS_WIDTH = 320;
let sharpP = null;
const sharpOf = () => (sharpP ??= import(pathToFileURL(path.join(KIT_ROOT, 'builder/tools/lib/char-deps.mjs')).href).then(m => m.sharp));
const r3 = v => Math.round(v * 1000) / 1000;
const dist = (p, q) => Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]);
const avg = xs => xs.reduce((a, b) => a + b, 0) / Math.max(1, xs.length);

/** A picture file → {width, height, data} RGBA at `width` wide (stats.mjs's input), decoded by sharp. */
export async function rgbaOf(file, width = STATS_WIDTH) {
  const sharp = await sharpOf();
  const { data, info } = await sharp(file).flatten({ background: '#000000' }).resize({ width }).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return { width: info.width, height: info.height, data: new Uint8Array(data.buffer, data.byteOffset, data.length) };
}

/** Clusters → swatches {hex, share, words} (shares renormalised to the clusters kept). */
const swatches = (cs, keep = 12) => {
  const top = cs.slice(0, keep), t = top.reduce((s, c) => s + c.share, 0) || 1;
  return top.map(c => ({ hex: oklabToHex(c.lab), share: r3(c.share / t), words: colourWords(c.lab) }));
};
/** Merge clusters closer than `near` (OKLab units) into their bigger twin. */
function mergeNear(cs, near = 0.045) {
  const out = [];
  for (const c of [...cs].sort((a, b) => b.share - a.share)) {
    const m = out.find(x => dist(x.lab, c.lab) < near);
    if (m) { const t = m.share + c.share; m.lab = m.lab.map((v, i) => (v * m.share + c.lab[i] * c.share) / t); m.share = t; } else out.push({ lab: [...c.lab], share: c.share });
  }
  return out.sort((a, b) => b.share - a.share);
}
/** The pixels of rows [y0, y1) as OKLab triples (every other pixel). */
function bandLab(img, y0, y1, keep = () => true) {
  const pts = [];
  for (let y = y0; y < y1; y++) for (let x = (y & 1); x < img.width; x += 2) {
    const o = (y * img.width + x) * 4, p = toOklab(img.data[o], img.data[o + 1], img.data[o + 2]);
    if (keep(p)) pts.push(...p);
  }
  return Float32Array.from(pts);
}
function regionOf(pts) {
  if (pts.length < 30) return null;
  const cs = mergeNear(kmeans(pts, 5));
  let L = 0, C = 0, hx = 0, hy = 0; const n = pts.length / 3;
  for (let i = 0; i < n; i++) { const a = pts[i * 3 + 1], b = pts[i * 3 + 2], c = Math.hypot(a, b); L += pts[i * 3]; C += c; hx += a; hy += b; }
  return { clusters: cs, colors: swatches(cs, 4).map(({ hex, share }) => ({ hex, share })), value: r3(L / n), chroma: r3(C / n), hue: Math.round((Math.atan2(hy, hx) * 180 / Math.PI + 360) % 360) };
}

/**
 * The lit pixels' lightness and chroma (OKLab L over LIT): what a frame's lit surfaces look like whatever share of it is
 * in shadow, so a dark cave and an open field are compared on their light, not on how much of them is dark.
 */
export const LIT = 0.45;
function litOf(img) {
  let n = 0, L = 0, C = 0;
  for (let i = 0; i < img.data.length; i += 4) {
    const [l, a, b] = toOklab(img.data[i], img.data[i + 1], img.data[i + 2]);
    if (l > LIT) { n++; L += l; C += Math.hypot(a, b); }
  }
  return { lit: r3(n / (img.data.length / 4)), litL: n ? r3(L / n) : null, litC: n ? r3(C / n) : null };
}

/** One frame: stats.mjs's frameStats plus regions and the lit pixels. */
export function measureFrame(img) {
  const s = frameStats(img);
  Object.assign(s.mean, litOf(img));
  const H = img.height, top = regionOf(bandLab(img, 0, Math.round(H * 0.2))), bottom = regionOf(bandLab(img, Math.round(H * 0.8), H));
  const regions = {};
  if (top && top.clusters[0].share > 0.5) regions.sky = top;
  if (bottom && bottom.clusters[0].share > 0.5) regions.ground = bottom;
  const mid = bandLab(img, Math.round(H * 0.2), Math.round(H * 0.8), p => Math.hypot(p[1], p[2]) > 0.09 && p[0] > 0.35);
  const midN = mid.length / 3, all = img.width * H / 2;
  if (midN > all * 0.02) {
    const held = [regions.sky?.clusters[0], regions.ground?.clusters[0]].filter(Boolean).map(c => c.lab);
    const own = mergeNear(kmeans(mid, 6)).filter(c => held.every(l => dist(l, c.lab) > 0.08) && c.share * midN > all * 0.01);
    if (own.length) {
      let L = 0, C = 0; for (let i = 0; i < midN; i++) { L += mid[i * 3]; C += Math.hypot(mid[i * 3 + 1], mid[i * 3 + 2]); }
      regions.characters = { clusters: own, colors: swatches(own, 4).map(({ hex, share }) => ({ hex, share })), value: r3(L / midN), chroma: r3(C / midN) };
    }
  }
  return { ...s, regions };
}

const publicRegions = regions => Object.fromEntries(Object.entries(regions).map(([k, { clusters, ...r }]) => [k, r]));

export async function measureImage(file) {
  const m = measureFrame(await rgbaOf(file));
  return { file, ...m, regions: publicRegions(m.regions) };
}

/** A histogram's mean and its 10th–90th percentile width, over [0, max]. */
function spreadOf(hist, max = 1) {
  const n = hist.length, w = max / n;
  let mean = 0, c = 0, p10 = null, p90 = null;
  hist.forEach((h, i) => { mean += h * (i + 0.5) * w; c += h; if (p10 == null && c >= 0.1) p10 = (i + 0.5) * w; if (p90 == null && c >= 0.9) p90 = (i + 0.5) * w; });
  return { mean: r3(mean), spread: r3((p90 ?? max) - (p10 ?? 0)), hist: hist.map(r3) };
}

// the lit pixels over a set: each frame weighed by how much of it is lit (a frame of near-black cave says little)
function litSet(per) {
  const have = per.filter(m => m.mean.litL != null), w = have.reduce((t, m) => t + m.mean.lit, 0);
  return w ? { litL: r3(have.reduce((t, m) => t + m.mean.litL * m.mean.lit, 0) / w), litC: r3(have.reduce((t, m) => t + m.mean.litC * m.mean.lit, 0) / w) } : {};
}

/**
 * Many frames → one set: the palette clustered over every frame's clusters together (each frame weighs the same),
 * histograms and edges averaged, each region pooled from the frames that show it. `frames` keeps each one's summary.
 * → {frames, palette, value: {mean, spread, hist[16]}, chroma: {mean, spread, hist[16]} (chroma over 0–0.3), edges,
 *    regions: {sky?, ground?, characters?}, mean: {L, C, contrast}, warmth}
 */
export async function measureSet(files) {
  if (!files.length) throw new Error('measureSet: no frames');
  const per = [];
  for (const f of files) per.push({ file: f, ...measureFrame(await rgbaOf(f)) });
  // one palette: every frame's clusters as weighted points (a frame's clusters sum to one), clustered again
  const weighted = (list, scale = 60) => Float32Array.from(list.flatMap(c => Array.from({ length: Math.max(1, Math.round(c.share * scale)) }, () => c.lab).flat()));
  const palette = swatches(mergeNear(kmeans(weighted(per.flatMap(m => m.palette)), 12)));
  const regions = {};
  for (const key of ['sky', 'ground', 'characters']) {
    const have = per.filter(m => m.regions[key]);
    if (have.length < Math.max(1, Math.ceil(per.length / 3))) continue;
    const cs = mergeNear(kmeans(weighted(have.flatMap(m => m.regions[key].clusters), 20), 4));
    regions[key] = { colors: swatches(cs, 4).map(({ hex, share }) => ({ hex, share })), value: r3(avg(have.map(m => m.regions[key].value))), chroma: r3(avg(have.map(m => m.regions[key].chroma))), ...(key !== 'characters' ? { hue: Math.round(avg(have.map(m => m.regions[key].hue))) } : {}) };
  }
  const mean16 = key => per[0][key].map((_, i) => avg(per.map(m => m[key][i])));
  // warmth: the b axis (yellow +, blue −) of the palette, weighed by chroma and share, scaled to about −1…1
  const warmth = r3(Math.max(-1, Math.min(1, palette.reduce((s, c) => { const [, a, b] = hexToOklab(c.hex); return s + c.share * (b + 0.3 * a); }, 0) / 0.08)));
  return {
    frames: per.map(m => ({ file: m.file, palette: m.palette.slice(0, 6).map(({ hex, share }) => ({ hex, share })), mean: m.mean, edges: m.edges, regions: Object.keys(m.regions) })),
    palette, value: spreadOf(mean16('value'), 1), chroma: spreadOf(mean16('chroma'), 0.3),
    edges: { density: r3(avg(per.map(m => m.edges.density))), dark: r3(avg(per.map(m => m.edges.dark))) },
    regions,
    mean: { L: r3(avg(per.map(m => m.mean.L))), C: r3(avg(per.map(m => m.mean.C))), contrast: r3(avg(per.map(m => m.mean.contrast))), ...litSet(per) },
    warmth,
  };
}
