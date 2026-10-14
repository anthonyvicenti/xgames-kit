// A look's style anchor as a yardstick: every piece a wave makes for a look is drawn from its anchor, so every piece is
// also judged against it (library/COVERAGE.md, "The Meshy plan"; looks wave 3).
//
//   anchorSignature(rgba)              → the anchor picture's style signature, its plain background left out
//   anchorTarget(sig, lookTarget)      → a style target (builder/art/coverage.mjs styleFit reads it) whose colours are the
//                                        anchor's and whose surfaces and shapes are the look's
//   judgePieces(pieces, { floor, drop }) → each piece's verdict: its validators, its fit to its look's anchor and to its
//                                        look's target, and whether it is an outlier among the look's pieces
//
// The measures are the kit's own (signature.mjs, coverage.mjs), so a piece is measured exactly as the library measures
// any asset. They are a guide: a grey stone tower under a violet anchor fits less by colour and can still be right, so a
// person (or the look judge on the rendered game) has the last word on a borderline piece.
import { familyOf, hsl, pictureSignature } from './signature.mjs';
import { styleFit } from './coverage.mjs';

/** A piece whose anchor fit is under this is regenerated (within the wave's cap). */
export const ANCHOR_FLOOR = 0.5;
/** A piece this far under its look's median fit is an outlier too: it reads as another set. */
export const OUTLIER_DROP = 0.15;

const hex = (r, g, b) => `#${[r, g, b].map(v => Math.round(v).toString(16).padStart(2, '0')).join('')}`;

/**
 * The anchor's signature. An anchor is a sheet of subjects on a plain light background: the background (the colour of
 * the picture's border, and anything near it) is left out, so the sheet's colours are its subjects'. rgba: {width,
 * height, data} (4 channels). → pictureSignature + colors [{hex, share}] (one mean colour a hue family, largest first)
 */
export function anchorSignature(rgba, { tolerance = 34 } = {}) {
  const { width: W, height: H, data } = rgba;
  // the border's median colour is the background
  const border = [];
  for (let x = 0; x < W; x += 2) border.push(x, (H - 1) * W + x);
  for (let y = 0; y < H; y += 2) border.push(y * W, y * W + W - 1);
  const med = k => { const v = border.map(i => data[i * 4 + k]).sort((a, b) => a - b); return v[v.length >> 1]; };
  const bg = [med(0), med(1), med(2)];
  const out = new Uint8ClampedArray(data.length);
  const fam = new Map();
  let kept = 0;
  for (let i = 0; i < W * H; i++) {
    const r = data[i * 4], g = data[i * 4 + 1], b = data[i * 4 + 2], a = data[i * 4 + 3];
    out[i * 4] = r; out[i * 4 + 1] = g; out[i * 4 + 2] = b;
    const isBg = a < 128 || Math.hypot(r - bg[0], g - bg[1], b - bg[2]) < tolerance;
    out[i * 4 + 3] = isBg ? 0 : 255;
    if (isBg) continue;
    kept++;
    const f = familyOf(...hsl(r, g, b));
    const m = fam.get(f) ?? [0, 0, 0, 0];
    m[0] += r; m[1] += g; m[2] += b; m[3]++;
    fam.set(f, m);
  }
  const sig = pictureSignature({ width: W, height: H, data: out });
  const colors = [...fam.values()].filter(m => m[3] / Math.max(1, kept) >= 0.03).sort((a, b) => b[3] - a[3])
    .map(m => ({ hex: hex(m[0] / m[3], m[1] / m[3], m[2] / m[3]), share: +(m[3] / kept).toFixed(3) }));
  return { ...sig, colors, background: hex(...bg), subjectShare: +(kept / (W * H)).toFixed(3) };
}

/**
 * A style target from an anchor's signature: its colours and tone (what the pieces drawn from it should carry), the
 * look target's surfaces, shapes and ink (what a picture cannot say about a 3D model). → a gf-look-target/1-shaped object
 */
export function anchorTarget(sig, lookTarget = null) {
  return {
    schema: 'gf-look-target/1', from: 'anchor', confidence: 0.6,
    palette: { colors: sig.colors ?? [] },
    tone: { saturation: sig.palette?.saturation ?? null, lightness: sig.palette?.lightness ?? null },
    ...(lookTarget?.materials ? { materials: lookTarget.materials } : {}),
    ...(lookTarget?.shapes ? { shapes: lookTarget.shapes } : {}),
    ...(lookTarget?.edges ? { edges: lookTarget.edges } : {}),
  };
}

const median = xs => { const v = xs.filter(x => typeof x === 'number').sort((a, b) => a - b); return v.length ? v[Math.floor(v.length / 2)] : null; };

/**
 * Judge a wave's pieces. pieces: [{id, look, asset (a library manifest: fits.signature, validated), anchor (anchorTarget),
 * target (the look's own target, optional)}]. Each look's pieces are held to that look's median, so a set drawn from a
 * darker anchor is not called off for being dark. → [{id, look, ok, fit, levelFit, validators: {ok, failed}, outlier,
 * why: [lines]}]
 */
export function judgePieces(pieces, { floor = ANCHOR_FLOOR, drop = OUTLIER_DROP } = {}) {
  const rows = pieces.map(p => {
    const f = styleFit(p.asset, p.anchor);
    const lvl = p.target ? styleFit(p.asset, p.target) : null;
    const failed = (p.asset?.validated ?? []).filter(v => v.ok === false).map(v => v.by);
    return { id: p.id, look: p.look ?? null, fit: f.fit, colour: f.colour, shape: f.shape, levelFit: lvl?.fit ?? null, validators: { ok: !failed.length, failed }, why: [...f.why] };
  });
  const byLook = new Map();
  for (const r of rows) { if (!byLook.has(r.look)) byLook.set(r.look, []); byLook.get(r.look).push(r.fit); }
  for (const r of rows) {
    const m = median(byLook.get(r.look));
    const low = r.fit != null && r.fit < floor, apart = r.fit != null && m != null && byLook.get(r.look).length >= 3 && r.fit < m - drop;
    r.median = m;
    r.outlier = low || apart;
    if (low) r.why.unshift(`fit ${r.fit} to its anchor is under ${floor}`);
    else if (apart) r.why.unshift(`fit ${r.fit} is ${(m - r.fit).toFixed(2)} under its look's median ${m}`);
    if (!r.validators.ok) r.why.unshift(`failed ${r.validators.failed.join(', ')}`);
    r.ok = r.validators.ok && !r.outlier;
  }
  return rows;
}
