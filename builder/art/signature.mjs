// The style signature: what an asset looks like, measured (never declared). Palette size and hues, triangles per
// metre, texel density, outline, a body's proportions, a sound's length and loudness. The look judge compares these
// with a kind's contact sheet; the resolver and a pack's summary read them.
//
//   palette.size        colours (4 bits a channel) that cover 95% of what is seen (area for a model, pixels for a picture)
//   palette.exact       exact colours in a picture (pixel art keeps to 32 or fewer); null for a model
//   palette.families    the hue families (red … pink, brown, grey) with at least 3% of the weight, largest first
//   palette.lightness   mean lightness 0–1; palette.saturation mean saturation 0–1; palette.top: the main colours
//   trianglesPerMetre   sqrt(triangles / surface m²): edges a metre, so it reads like texelsPerMetre
//   texelsPerMetre      sqrt(texels / textured m²) for a model; for a picture the scale it is drawn at, when known
//   texturedShare       the share of a model's surface that carries a texture (flat colour kits read 0)
//   outline             { present, how: 'hull' | 'ink' | null, share }
//   body                { height, headsTall, hipShare, shoulderShare, widthShare } for a rigged body
export const SIGNATURE_VERSION = 1;

// The hue families the contract names (pack.schema $defs/signature palette.families).
const HUES = [['red', 0], ['orange', 28], ['yellow', 55], ['green', 120], ['cyan', 185], ['blue', 225], ['purple', 280], ['pink', 330]];

export function hsl(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b), l = (max + min) / 2, d = max - min;
  if (!d) return [0, 0, l];
  const s = d / (1 - Math.abs(2 * l - 1));
  let h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  h *= 60; if (h < 0) h += 360;
  return [h, s, l];
}

/** The family of a colour: grey for the unsaturated and the near-black or near-white, brown for dark warm hues. */
export function familyOf(h, s, l) {
  if (s < 0.2 || l < 0.08 || l > 0.92) return 'grey';
  if (h >= 10 && h < 50 && l < 0.42) return 'brown';
  let best = HUES[0], dist = 999;
  for (const x of HUES) { const d = Math.min(Math.abs(h - x[1]), 360 - Math.abs(h - x[1])); if (d < dist) { dist = d; best = x; } }
  return best[0];
}

const hex = k => `#${k.toString(16).padStart(6, '0')}`;

/** A palette from weighted colours. weights: [[0xRRGGBB, weight], …] → palette */
export function paletteOf(weights, { exact = null } = {}) {
  let total = 0;
  const q = new Map();
  for (const [k, w] of weights) {
    if (!(w > 0)) continue;
    total += w;
    const r = (k >> 16) & 255, g = (k >> 8) & 255, b = k & 255;
    const qk = ((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4);
    q.set(qk, (q.get(qk) ?? 0) + w);
  }
  if (!total) return { size: 0, exact, families: [], grey: null, lightness: null, saturation: null, top: [] };
  const sorted = [...q.values()].sort((a, b) => b - a);
  let acc = 0, size = 0;
  for (const w of sorted) { acc += w; size++; if (acc >= total * 0.95) break; }
  let L = 0, S = 0;
  const fam = new Map();
  for (const [k, w] of weights) {
    if (!(w > 0)) continue;
    const [h, s, l] = hsl((k >> 16) & 255, (k >> 8) & 255, k & 255);
    L += l * w; S += s * w;
    const f = familyOf(h, s, l);
    fam.set(f, (fam.get(f) ?? 0) + w);
  }
  const families = [...fam.entries()].map(([hue, w]) => ({ hue, share: +(w / total).toFixed(3) })).filter(x => x.share >= 0.03).sort((a, b) => b.share - a.share);
  const top = [...weights].filter(x => x[1] > 0).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([k, w]) => ({ colour: hex(k), share: +(w / total).toFixed(3) }));
  return { size, exact, families, grey: +((fam.get('grey') ?? 0) / total).toFixed(3), lightness: +(L / total).toFixed(3), saturation: +(S / total).toFixed(3), top };
}

/** A model's signature from the preview page's measures. */
export function modelSignature(m) {
  const tpm = m.area > 0 ? Math.sqrt(m.triangles / m.area) : null;
  const texels = m.texturedArea > 0 ? Math.sqrt(m.texels / m.texturedArea) : null;
  const seen = m.area - (m.outlineArea ?? 0);
  return {
    version: SIGNATURE_VERSION,
    palette: paletteOf(m.colours ?? []),
    trianglesPerMetre: tpm === null ? null : +tpm.toFixed(2),
    texelsPerMetre: texels === null ? null : Math.round(texels),
    texturedShare: seen > 0 ? +(m.texturedArea / seen).toFixed(3) : 0,
    outline: { present: (m.outlineArea ?? 0) > 0.02 * m.area, how: (m.outlineArea ?? 0) > 0.02 * m.area ? 'hull' : null, share: m.area > 0 ? +((m.outlineArea ?? 0) / m.area).toFixed(3) : 0 },
    body: m.body ?? null,
  };
}

/** A picture's signature from RGBA pixels. pic: { width, height, data }. texelsPerMetre when the use says it. */
export function pictureSignature(pic, { texelsPerMetre = null } = {}) {
  const { width: W, height: H, data } = pic;
  const counts = new Map();
  const alphaAt = (x, y) => (x < 0 || y < 0 || x >= W || y >= H ? 0 : data[(y * W + x) * 4 + 3]);
  let edge = 0, darkEdge = 0, see = 0;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = (y * W + x) * 4;
    if (data[i + 3] < 128) { see++; continue; }
    const k = (data[i] << 16) | (data[i + 1] << 8) | data[i + 2];
    counts.set(k, (counts.get(k) ?? 0) + 1);
    if (alphaAt(x - 1, y) < 128 || alphaAt(x + 1, y) < 128 || alphaAt(x, y - 1) < 128 || alphaAt(x, y + 1) < 128) {
      edge++;
      const luma = 0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2];
      if (luma < 64) darkEdge++;
    }
  }
  const share = edge ? darkEdge / edge : 0;
  const ink = see > 0 && edge >= 8 && share >= 0.6;
  return {
    version: SIGNATURE_VERSION,
    palette: paletteOf([...counts.entries()], { exact: counts.size }),
    trianglesPerMetre: null,
    texelsPerMetre,
    texturedShare: null,
    outline: { present: ink, how: ink ? 'ink' : null, share: +share.toFixed(3) },
    seeThrough: +(see / (W * H)).toFixed(3),
    size: [W, H],
    body: null,
  };
}

/** A sound's signature: length, loudness on its loudest 100 ms, peak. */
export function soundSignature({ seconds, sampleRate, channels, levels, peakDbfs }) {
  return { version: SIGNATURE_VERSION, sound: { seconds: +seconds.toFixed(3), sampleRate, channels: channels.length, peakDbfs, soundMaxLufs: levels.soundMaxLufs, activeLufs: levels.activeLufs } };
}

const median = xs => { const v = xs.filter(x => typeof x === 'number').sort((a, b) => a - b); return v.length ? v[Math.floor(v.length / 2)] : null; };

/** A pack's signature: the medians and the hue families across its assets. */
export function packSignature(assets) {
  const sig = assets.map(a => a.signature).filter(Boolean);
  const hueW = new Map();
  for (const s of sig) for (const h of s.palette?.families ?? []) hueW.set(h.hue, (hueW.get(h.hue) ?? 0) + h.share);
  const tot = [...hueW.values()].reduce((a, b) => a + b, 0) || 1;
  const bodies = sig.map(s => s.body).filter(Boolean);
  return {
    version: SIGNATURE_VERSION,
    assets: assets.length,
    paletteSize: median(sig.map(s => s.palette?.size)),
    families: [...hueW.entries()].map(([hue, w]) => ({ hue, share: +(w / tot).toFixed(3) })).filter(x => x.share >= 0.05).sort((a, b) => b.share - a.share),
    lightness: median(sig.map(s => s.palette?.lightness)),
    saturation: median(sig.map(s => s.palette?.saturation)),
    trianglesPerMetre: median(sig.map(s => s.trianglesPerMetre)),
    texelsPerMetre: median(sig.map(s => s.texelsPerMetre)),
    texturedShare: median(sig.map(s => s.texturedShare)),
    outlineShare: sig.length ? +(sig.filter(s => s.outline?.present).length / sig.length).toFixed(3) : null,
    headsTall: median(bodies.map(b => b.headsTall)),
    hipShare: median(bodies.map(b => b.hipShare)),
    grey: median(sig.map(s => s.palette?.grey)),
  };
}
