// Coverage: what the library already holds for a look, and what is missing (library/COVERAGE.md is its report).
//
//   inventory(lib, { policy })                     → { packs: [...], totals }       counts by pack, category, licence class
//   styleFit(asset, target)                        → { fit 0..1, shape 0..1, colour 0..1, parts, why }
//   coverage(lib, needs, { target, kindPreset, policy, paid }) → { needs: [{ ..., status, have, best, gap }], totals }
//
// A need is one thing a look asks for, by what it is and not by a file:
//   { id, category, dimension, archetype?, theme?, words (comma-separated alternatives), count?, code? }
// (library/needs/*.json hold need lists; `code` names a runtime part that draws it instead of an asset, a sky dome or
// a particle preset: such a need is "code" when no asset answers it.)
//
// The status of a need, against a look target (builder/spec/look-target.schema.json, a game's `look.target`) or a kind:
//   have        assets answer the words and fit the style (fit >= HAVE); `have` of `count` says whether there are
//               as many variants as the look wants
//   off-style   assets answer the words, their shapes fit, their colours or ink do not: a style pass (re-tint, outline,
//               material ramp at load) could bring them in
//   missing     nothing answers the words, or only assets whose shapes or surfaces are wrong for the look (a photo
//               texture for a toon look, a realistic body for a big-eyed cartoon): new art (the Meshy plan)
//   code        no asset, but a runtime part draws it (the need's `code`): its colours are look slots
// A body's archetype names its rig standard (gf-humanoid-1, or a creature's: worm, blob, quadruped, flyer; CREATURES.md):
// only bodies on that standard answer it.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { loadLibrary } from './library.mjs';
import { licenceClass, loadPolicy } from './policy.mjs';
import { loadKind, rank } from './resolve.mjs';
import { familyOf, hsl } from './signature.mjs';
import { targetOfLook } from '../look/looks.mjs';

export const HAVE = 0.6;          // a style fit at or over this is "in style"
export const SHAPE_OK = 0.5;      // under this, a style pass cannot help: the shapes or surfaces are wrong
export const WORDS_MIN = 0.5;     // a candidate must answer one of the need's words at least this well
// fonts and sounds carry no colour signature: their style is judged by eye or ear, so words alone decide
const UNMEASURED = new Set(['font', 'sound', 'clip']);

const CAT_LABEL = { body: 'body', prop: 'prop', tile: 'tile', texture: 'texture', 'sprite-sheet': 'sprite', sound: 'sound', sky: 'sky', effect: 'VFX', font: 'UI/font', card: 'UI/card', picture: 'picture', clip: 'clip', viewmodel: 'viewmodel' };
export const categoryLabel = c => CAT_LABEL[c] ?? c;

/** Counts by pack: category (2D and 3D apart), licence class, visibility, failed validators, the pack's signature. */
export function inventory(lib, { policy }) {
  const packs = lib.map(({ pack, assets }) => {
    const byCategory = {};
    let failed = 0;
    for (const a of assets) {
      const k = `${categoryLabel(a.category)}${a.dimension === '2d' && !['font', 'card', 'picture', 'texture', 'tile', 'sprite-sheet', 'effect'].includes(a.category) ? ' (2d)' : ''}`;
      byCategory[k] = (byCategory[k] ?? 0) + 1;
      if ((a.validated ?? []).some(v => v.ok === false)) failed++;
    }
    const s = pack.signature ?? {};
    return {
      id: pack.id, title: pack.title ?? pack.id, owner: pack.owner, visibility: pack.visibility, dimension: pack.dimension ?? null,
      licence: pack.licence?.spdx ?? null, licenceClass: licenceClass(policy, pack.licence?.spdx)?.name ?? 'outside-policy',
      assets: assets.length, failed, byCategory,
      style: signatureWords(s),
    };
  });
  const totals = { packs: packs.length, assets: 0, failed: 0, byCategory: {}, byLicenceClass: {}, byVisibility: {} };
  for (const p of packs) {
    totals.assets += p.assets; totals.failed += p.failed;
    for (const [k, n] of Object.entries(p.byCategory)) totals.byCategory[k] = (totals.byCategory[k] ?? 0) + n;
    totals.byLicenceClass[p.licenceClass] = (totals.byLicenceClass[p.licenceClass] ?? 0) + p.assets;
    totals.byVisibility[p.visibility] = (totals.byVisibility[p.visibility] ?? 0) + p.assets;
  }
  return { packs, totals };
}

/** A pack or asset signature in a few words: colour families, saturation, surfaces, detail, ink. */
export function signatureWords(s) {
  if (!s || !s.palette && !s.families) return s?.sound ? 'sound' : '';
  const pal = s.palette ?? s;
  const fam = (pal.families ?? []).slice(0, 3).map(f => f.hue).join('/');
  const sat = pal.saturation;
  const satW = sat == null ? '' : sat >= 0.65 ? 'saturated' : sat >= 0.35 ? 'mid-saturated' : 'muted';
  const tex = s.texturedShare == null ? '' : s.texturedShare >= 0.5 ? 'textured' : 'flat colour';
  const tpm = s.trianglesPerMetre;
  const det = tpm == null ? '' : tpm < 8 ? 'low-poly' : tpm < 30 ? 'mid-poly' : 'dense';
  const ink = s.outline?.present ? 'inked' : '';
  return [fam, satW, tex, det, ink].filter(Boolean).join(', ');
}

const clamp01 = x => Math.max(0, Math.min(1, x));
const near = (a, b, width) => (a == null || b == null ? null : clamp01(1 - Math.abs(a - b) / width));
const LEVEL = { none: 0, low: 1, mid: 2, high: 3 };

const hslOfHex = hex => { const n = parseInt(hex.slice(1), 16); return hsl((n >> 16) & 255, (n >> 8) & 255, n & 255); };
const hexFamily = hex => familyOf(...hslOfHex(hex));

/**
 * The target's saturation and lightness on the same scale as an asset's signature (HSL, share-weighted over its palette
 * swatches), so both sides are measured alike whatever the target's own histograms use (OKLab in gf-look-target/1).
 */
export function targetTone(target) {
  if (target?.tone) return target.tone;   // a kind's target carries its packs' own medians
  const cols = target?.palette?.colors ?? [];
  let s = 0, l = 0, w = 0;
  for (const c of cols) { const [, cs, cl] = hslOfHex(c.hex); s += cs * c.share; l += cl * c.share; w += c.share; }
  if (w) return { saturation: s / w, lightness: l / w };
  return { saturation: target?.palette?.saturation?.mean ?? null, lightness: target?.palette?.value?.mean ?? null };
}

/** The hue families a target's palette asks for, as shares. */
export function targetFamilies(target) {
  const m = new Map();
  let tot = 0;
  for (const c of target?.palette?.colors ?? []) { const f = hexFamily(c.hex); m.set(f, (m.get(f) ?? 0) + c.share); tot += c.share; }
  return tot ? [...m.entries()].map(([hue, w]) => ({ hue, share: w / tot })).sort((a, b) => b.share - a.share) : [];
}

/**
 * How well one asset's measured signature fits a look target. Colour parts (hue families, saturation, value) are what a
 * style pass could re-tint; shape parts (detail, surfaces) are not. → { fit, colour, shape, parts, why }
 */
export function styleFit(asset, target) {
  const s = asset.fits?.signature ?? asset.signature ?? null;
  if (!s || !target) return { fit: null, colour: null, shape: null, parts: {}, why: [s ? 'no target' : 'no measured signature'] };
  const pal = s.palette ?? {};
  const why = [], parts = {};
  const tone = targetTone(target);
  // hue families: the overlap of the two distributions (1 = the same mix). It weighs least: one object's own colour (a
  // grey gravestone, a red barrel) is often right whatever the scene's mix; saturation and lightness say more
  const want = targetFamilies(target);
  // white clouds, pale smoke: near-white things take the look's light, so any palette fits them (a dark grey does not)
  const achromatic = (pal.grey ?? 0) >= 0.8 && (pal.value ?? pal.lightness ?? 0) >= 0.75;
  if (achromatic) { parts.hue = 0.75; }
  else if (want.length && pal.families?.length) {
    const have = new Map(pal.families.map(f => [f.hue, f.share]));
    parts.hue = clamp01(want.reduce((a, f) => a + Math.min(f.share, have.get(f.hue) ?? 0), 0) / Math.max(0.5, pal.families.reduce((a, f) => a + f.share, 0)));
  }
  // saturation and value: the asset's mean against the target's (the target's is HSV, the asset's HSL: a loose width)
  parts.saturation = achromatic ? 0.75 : near(pal.saturation, tone.saturation, 0.45);
  parts.value = achromatic ? 0.75 : near(pal.value ?? pal.lightness, tone.lightness, 0.45);
  // surfaces: a flat-colour or painted look against a photo texture, and the reverse
  const surf = target.materials?.texture, tex = s.texturedShare;
  if (surf && tex != null) {
    parts.surface = surf === 'photo' ? (tex >= 0.5 ? 1 : 0.4) : surf === 'flat-colour' ? (tex < 0.3 ? 1 : 0.55) : surf === 'painted' ? (tex >= 0.5 ? 0.9 : 0.8) : surf === 'pixel' ? 0.3 : 0.7;
    // a grey, PBR-textured mesh (a photo look) under a saturated cartoon target reads as the wrong surface
    if (surf !== 'photo' && tex >= 0.5 && (pal.saturation ?? 1) < 0.25 && (tone.saturation ?? 0) > 0.5) parts.surface = Math.min(parts.surface, 0.3);
  }
  // detail: triangles a metre against the target's detail level (low-poly < 8, mid < 30, dense)
  const tpm = s.trianglesPerMetre, lvl = target.shapes?.detail;
  if (tpm != null && lvl) {
    const got = tpm < 8 ? 1 : tpm < 30 ? 2 : 3;
    parts.detail = clamp01(1 - Math.abs(got - Math.max(1, LEVEL[lvl])) / 2);
  }
  const mean = (keys, w) => { let a = 0, t = 0; for (const k of keys) if (parts[k] != null) { a += parts[k] * w[k]; t += w[k]; } return t ? a / t : null; };
  const colour = mean(['hue', 'saturation', 'value'], { hue: 0.25, saturation: 0.45, value: 0.3 });
  const shape = mean(['surface', 'detail'], { surface: 0.6, detail: 0.4 });
  const fit = colour == null ? shape : shape == null ? colour : 0.55 * colour + 0.45 * shape;
  if (parts.hue != null && parts.hue < 0.4) why.push(`colours ${(pal.families ?? []).slice(0, 2).map(f => f.hue).join('/')} against ${want.slice(0, 2).map(f => f.hue).join('/')}`);
  if (parts.saturation != null && parts.saturation < 0.5) why.push(`saturation ${pal.saturation} against ${tone.saturation.toFixed(2)}`);
  if (parts.value != null && parts.value < 0.5) why.push(`lightness ${pal.value ?? pal.lightness} against ${tone.lightness.toFixed(2)}`);
  if (parts.surface != null && parts.surface < 0.5) why.push(`surface ${tex >= 0.5 ? 'textured' : 'flat'} against ${surf}`);
  if (parts.detail != null && parts.detail < 0.5) why.push(`detail ${tpm} triangles a metre against ${lvl}`);
  if (target.edges?.outline && LEVEL[target.edges.outline] >= 2 && !s.outline?.present) why.push('no ink outline (a runtime outline pass draws one)');
  const r = x => (x == null ? null : +x.toFixed(3));
  return { fit: r(fit), colour: r(colour), shape: r(shape), parts: Object.fromEntries(Object.entries(parts).map(([k, v]) => [k, r(v)])), why };
}

/** A body's archetype → the rig standard a library body must be on to fill it (runtimes/three/kit/character/archetypes.js). */
export const RIGGED_ARCHETYPES = { humanoid: 'gf-humanoid-1', worm: 'gf-worm-1', blob: 'gf-blob-1', quadruped: 'gf-quadruped-1', flyer: 'gf-flyer-1' };

/**
 * The status of every need. opts: { target, kindPreset, policy, paid, devices } (a target wins over a kind for style).
 * → { needs: [{ id, category, archetype, theme, words, count, status, have, offStyle, best, gap }], totals }
 */
export function coverage(lib, needs, opts = {}) {
  const { target = null, kindPreset = null, policy, paid = { yes: true, keys: ['meshy'] }, devices = ['desktop'] } = opts;
  const out = [];
  for (const n of needs) {
    const count = n.count ?? 1;
    const rig = n.category === 'body' ? (RIGGED_ARCHETYPES[n.archetype ?? 'humanoid'] ?? null) : null;
    if (n.category === 'body' && !rig) {
      out.push({ ...pick(n), count, status: n.code ? 'code' : 'missing', have: 0, offStyle: 0, best: [], gap: `no rig standard for a ${n.archetype} body (the standards: ${Object.keys(RIGGED_ARCHETYPES).join(', ')})` });
      continue;
    }
    // the words are alternatives ("tree rock bush"): a candidate answers the need when it answers one of them well
    const base = { category: n.category, dimension: n.dimension, ...(rig ? { rig } : {}) };
    const alts = String(n.words ?? '').split(',').map(w => w.trim()).filter(Boolean);
    const best = new Map();
    for (const w of alts.length ? alts : ['']) {
      const { candidates } = rank(lib, w ? { ...base, words: w, head: w } : base, { kindPreset, policy, paid, devices });
      for (const c of candidates) if ((!w || c.words >= WORDS_MIN) && (best.get(c.ref)?.words ?? -1) < c.words) best.set(c.ref, c);
    }
    const matched = [...best.values()];
    const judged = matched.map(c => {
      const unmeasured = UNMEASURED.has(c.asset.category);
      const sf = target && !unmeasured ? styleFit(c.asset, target) : null;
      const inKind = kindPreset ? c.kindRank >= 1 : null;
      let fit = sf?.fit ?? null, shape = sf?.shape ?? null;
      if (inKind) { fit = Math.max(fit ?? HAVE, HAVE); shape = Math.max(shape ?? 1, SHAPE_OK); }
      const why = [...(sf?.why ?? []), ...(unmeasured ? ['style not measured (judged by eye or ear)'] : [])];
      return { ref: c.ref, words: +c.words.toFixed(2), fit, shape, colour: sf?.colour ?? null, inKind, why, licence: (c.asset.licence ?? c.asset._pack.licence)?.spdx, visibility: c.asset._pack.visibility };
    }).sort((a, b) => (b.fit ?? 0.5) - (a.fit ?? 0.5) || b.words - a.words);
    // in style: the whole fit and each half (colour, shape) hold; a kind's own packs are in style by definition
    const inStyle = judged.filter(j => j.inKind || j.fit == null || (j.fit >= HAVE && (j.colour ?? 1) >= SHAPE_OK && (j.shape ?? 1) >= SHAPE_OK));
    const fixable = judged.filter(j => !inStyle.includes(j) && (j.shape == null || j.shape >= SHAPE_OK));
    // the best that is there decides: some in style is "have" (the gap says how many more variants the look wants),
    // else some a style pass could bring in is "off-style", else a runtime part, else "missing"
    let status, gap = null;
    if (inStyle.length) {
      status = 'have';
      if (inStyle.length < count) gap = `${inStyle.length} of ${count} in style${fixable.length ? `, ${Math.min(fixable.length, count - inStyle.length)} more with a style pass` : ''}${inStyle.length + fixable.length < count ? `; ${count - inStyle.length - fixable.length} more is new art` : ''}`;
    } else if (fixable.length) {
      status = 'off-style';
      gap = `${fixable.length} answer the words but not the style: ${(fixable[0].why ?? []).join('; ') || 'colours'}`;
    } else if (n.code) { status = 'code'; gap = `drawn by ${n.code}`; }
    else {
      status = 'missing';
      gap = judged.length ? `only wrong-style matches (${judged.slice(0, 2).map(j => `${j.ref}: ${(j.why ?? []).join('; ')}`).join(' | ')})` : `nothing in the library answers "${n.words}"`;
    }
    out.push({ ...pick(n), count, status, have: inStyle.length, offStyle: fixable.length, best: judged.slice(0, 4), gap });
  }
  const totals = {};
  for (const x of out) totals[x.status] = (totals[x.status] ?? 0) + 1;
  return { needs: out, totals };
}

const pick = n => ({ id: n.id, category: n.category, dimension: n.dimension ?? null, archetype: n.archetype ?? null, theme: n.theme ?? null, words: n.words, ...(n.code ? { code: n.code } : {}), ...(n.look ? { look: n.look } : {}) });

// ---- a kind as a target ----------------------------------------------------------------------------------------------
const FAMILY_HEX = { red: '#d43c3c', orange: '#e8832e', yellow: '#e8c832', green: '#46b446', cyan: '#32c4c4', blue: '#3c64d2', purple: '#8a4ccc', pink: '#e464aa', brown: '#885533', grey: '#888888' };

/**
 * A kind's style as a look target, measured from its own packs (the medians of their signatures): what "in the kind"
 * means when a game has no reference. → a gf-look-target/1-shaped object (from: 'kind') or null when no pack is measured.
 */
export function kindTarget(kindPreset, lib) {
  const packs = lib.filter(p => (kindPreset?.packs ?? []).includes(p.pack.id) && p.pack.signature?.palette);
  if (!packs.length) return null;
  const fam = new Map();
  const sat = [], val = [], tex = [], tpm = [];
  for (const { pack, assets } of packs) {
    const s = pack.signature, w = assets.length;
    for (const f of s.palette.families ?? []) fam.set(f.hue, (fam.get(f.hue) ?? 0) + f.share * w);
    if (s.palette.saturation != null) sat.push(s.palette.saturation);
    if ((s.palette.value ?? s.palette.lightness) != null) val.push(s.palette.value ?? s.palette.lightness);
    if (s.texturedShare != null) tex.push(s.texturedShare);
    if (s.trianglesPerMetre != null) tpm.push(s.trianglesPerMetre);
  }
  const med = xs => (xs.length ? [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] : null);
  const tot = [...fam.values()].reduce((a, b) => a + b, 0) || 1;
  const t = med(tpm), tx = med(tex);
  return {
    schema: 'gf-look-target/1', from: 'kind', kind: kindPreset.id, confidence: 0.5, reads: [kindPreset.feel ?? kindPreset.id],
    palette: { colors: [...fam.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([hue, w]) => ({ hex: FAMILY_HEX[hue] ?? '#888888', share: +(w / tot).toFixed(3) })),
    },
    tone: { saturation: med(sat), lightness: med(val) },   // the packs' HSL medians, the scale an asset's signature uses
    materials: { texture: tx == null ? undefined : tx >= 0.5 ? 'painted' : 'flat-colour' },
    shapes: { detail: t == null ? undefined : t < 8 ? 'low' : t < 30 ? 'mid' : 'high' },
  };
}

/** A 3D need in its flat form, for a flat kind (pixel, drawn): a body becomes a sprite sheet, a prop a picture. */
export function flatNeed(n) {
  const map = { body: 'sprite-sheet', prop: 'picture', texture: 'tile', effect: 'effect', font: 'font', picture: 'picture', sound: 'sound', sky: 'picture' };
  const category = map[n.category] ?? n.category;
  return { ...n, category, dimension: category === 'sound' ? 'audio' : '2d', archetype: n.category === 'body' ? null : n.archetype, flatArchetype: n.category === 'body' ? n.archetype : undefined };
}

const isFlat = k => Object.values(k?.look ?? {}).some(l => /flat|2d/.test(l?.profile ?? ''));

/**
 * The whole report (library/COVERAGE.md and `art coverage`): the inventory, then a view per kind (or the one asked for)
 * and, with a case, the case's needs against its target. casePath: a library/coverage/cases/*.json file.
 */
export function coverageReport({ config, kind = null, casePath = null, lib = null }) {
  lib ??= loadLibrary(config);
  const policy = loadPolicy(config.policyFile);
  const common = JSON.parse(readFileSync(path.join(config.root, 'coverage', 'needs.json'), 'utf8'));
  const views = [];
  const kinds = kind ? [kind] : existsSync(config.kindsDir) ? readdirSync(config.kindsDir).filter(f => f.endsWith('.json')).map(f => f.replace(/\.json$/, '')).sort() : [];
  for (const k of kinds) {
    const preset = loadKind(k, config.kindsDir);
    if (preset?.missing) continue;
    const flat = isFlat(preset);
    const needs = common.needs.map(n => (flat ? flatNeed(n) : { ...n, dimension: n.category === 'sound' ? 'audio' : ['font', 'texture', 'effect', 'picture', 'sky'].includes(n.category) ? '2d' : '3d' }));
    const target = kindTarget(preset, lib);
    const r = coverage(lib, needs, { target, kindPreset: preset, policy });
    views.push({ id: `kind:${k}`, title: `kind ${k}${flat ? ' (flat)' : ''}`, target, ...r });
  }
  if (casePath) {
    const c = JSON.parse(readFileSync(casePath, 'utf8'));
    // a need may name one of the target's looks (a level): it is held to that look's own target
    const groups = new Map();
    for (const n of c.needs) { const k = c.target?.looks?.some(L => L.id === n.look) ? n.look : ''; if (!groups.has(k)) groups.set(k, []); groups.get(k).push(n); }
    const parts = [...groups].map(([look, needs]) => coverage(lib, needs, { target: look ? targetOfLook(c.target, look) : c.target, policy }));
    const order = new Map(c.needs.map((n, i) => [n.id, i]));
    const totals = {};
    for (const p of parts) for (const [k, v] of Object.entries(p.totals)) totals[k] = (totals[k] ?? 0) + v;
    views.push({ id: `case:${c.id}`, title: `case ${c.id}`, target: c.target, needs: parts.flatMap(p => p.needs).sort((a, b) => order.get(a.id) - order.get(b.id)), totals });
  }
  return { inventory: inventory(lib, { policy }), views };
}

